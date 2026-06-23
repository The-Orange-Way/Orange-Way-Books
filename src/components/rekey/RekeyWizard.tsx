/**
 * RekeyWizard, Phase 4.5 seven-step safety dialog.
 *
 * Walks the Owner through a security refresh with plain-English copy
 * at every step. No technical terms leak to the UI (no DEK/KEM/
 * wrap/cipher). The actual refresh is driven by `src/lib/rekey.ts`.
 *
 * Customer phrase: customers "refresh" security, not "rotate"
 * keys. Banks rotate keys; customers refresh.
 *
 * Screens (as spec'd in the Phase 4.5 task):
 *   1. Intro
 *   2. What happens, Quick vs Deep refresh choice
 *   3. Backup recommendation (optional download)
 *   4. Timing recommendation
 *   5. Team impact
 *   6. Final review + confirmation checkbox
 *   7. Running (progress bar + stage label)
 *
 * The wizard stays open through completion so the user can see it
 * finish. On success: green checkmark + Close. On abort: error banner
 * + "No data was lost" reassurance + Close.
 */
import React, { useCallback, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Progress } from '@/components/ui/progress';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { CheckCircle2, Download, AlertTriangle, Loader2, Shield } from 'lucide-react';
import { toast } from 'sonner';
import { useVault } from '@/context/VaultContext';
import {
  startRekeyJob,
  runRekeyJob,
  abortRekey,
  exportOrgBackup,
  type RekeyStage,
  type RekeyTriggerType,
  type RefreshMode,
} from '@/lib/rekey';

type WizardStep = 1 | 2 | 3 | 4 | 5 | 6 | 7;
type RunState = 'idle' | 'running' | 'succeeded' | 'aborted';

export interface RekeyWizardProps {
  orgId: string;
  open: boolean;
  /** Skip to step 2 when opened from the post-revoke prompt (the user
   *  already confirmed the removal, the intro is redundant). */
  startAtWhatHappens?: boolean;
  triggerType?: RekeyTriggerType;
  onClose: () => void;
  onCompleted?: () => void;
}

export function RekeyWizard({
  orgId,
  open,
  startAtWhatHappens = false,
  triggerType = 'manual',
  onClose,
  onCompleted,
}: RekeyWizardProps) {
  const vault = useVault();
  const [step, setStep] = useState<WizardStep>(startAtWhatHappens ? 2 : 1);
  const [acknowledged, setAcknowledged] = useState(false);
  const [backupDownloaded, setBackupDownloaded] = useState(false);

  const [jobId, setJobId] = useState<string | null>(null);
  const [rowsTotal, setRowsTotal] = useState<number>(0);
  const [estimatedSeconds, setEstimatedSeconds] = useState<number>(180);
  const [refreshMode, setRefreshMode] = useState<RefreshMode>('quick');
  const [runState, setRunState] = useState<RunState>('idle');
  const [stageLabel, setStageLabel] = useState<string>('Preparing');
  const [rowsProcessed, setRowsProcessed] = useState<number>(0);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const stageCopy = (stage: RekeyStage): string => {
    switch (stage) {
      case 'generating_keys':
        return 'Creating new security codes for your team';
      case 'wrapping_members':
        return 'Sharing the new security codes with your team members';
      case 'rekeying_rows':
        return 'Updating your data with the new security codes';
      case 'finalizing':
        return 'Finishing up';
    }
  };

  const handleDownloadBackup = useCallback(async () => {
    try {
      const blob = await exportOrgBackup(orgId, 'csv', vault.decryptText);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `orangewaybooks-backup-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      setBackupDownloaded(true);
      toast.success('Backup downloaded. Keep it somewhere safe.');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Could not download the backup.';
      toast.error(msg);
    }
  }, [orgId, vault.decryptText]);

  const kickOff = useCallback(async () => {
    setStep(7);
    setRunState('running');
    setStageLabel('Preparing');
    setErrorMsg(null);
    try {
      const start = await startRekeyJob(orgId, triggerType, refreshMode);
      setJobId(start.jobId);
      setRowsTotal(start.rowsTotal);
      setEstimatedSeconds(start.estimatedSeconds);
      await runRekeyJob(start.jobId, {
        onStageChange: (s) => setStageLabel(stageCopy(s)),
        onRowProgress: (p) => setRowsProcessed(p),
        onComplete: () => {
          setRunState('succeeded');
          onCompleted?.();
        },
        onAborted: (reason) => {
          setRunState('aborted');
          setErrorMsg(reason);
        },
        onError: (err) => {
          setErrorMsg(err.message);
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'The security refresh failed.';
      setErrorMsg(msg);
      setRunState('aborted');
      if (jobId) {
        try {
          await abortRekey(jobId, msg);
        } catch {
          /* swallow */
        }
      }
    }
  }, [orgId, triggerType, refreshMode, onCompleted, jobId]);

  const close = useCallback(() => {
    if (runState === 'running') return; // prevent closing mid-run
    onClose();
    // Reset after close so re-opening starts clean.
    setTimeout(() => {
      setStep(startAtWhatHappens ? 2 : 1);
      setAcknowledged(false);
      setBackupDownloaded(false);
      setRefreshMode('quick');
      setJobId(null);
      setRowsTotal(0);
      setEstimatedSeconds(180);
      setRunState('idle');
      setStageLabel('Preparing');
      setRowsProcessed(0);
      setErrorMsg(null);
    }, 200);
  }, [runState, onClose, startAtWhatHappens]);

  // Deep refresh re-encrypts every row; rough multiplier vs. Quick's
  // version-bump-only path. Used ONLY for the UI time estimate.
  const DEEP_TIME_MULTIPLIER = 8;
  const effectiveEstimateSeconds =
    refreshMode === 'deep' ? estimatedSeconds * DEEP_TIME_MULTIPLIER : estimatedSeconds;
  const estimatedMinutes = Math.max(1, Math.ceil(effectiveEstimateSeconds / 60));
  const rowsPercent =
    rowsTotal > 0 ? Math.min(100, Math.round((rowsProcessed / rowsTotal) * 100)) : 0;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) close();
      }}
    >
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Shield className="w-5 h-5 text-[var(--color-brand-orange)]" />
            {step < 7 && "Refresh your team's security"}
            {step === 7 && runState === 'running' && "Refreshing your team's security"}
            {step === 7 && runState === 'succeeded' && 'Security refreshed successfully'}
            {step === 7 && runState === 'aborted' && 'Security refresh could not finish'}
          </DialogTitle>
        </DialogHeader>

        {/* Step 1, Intro */}
        {step === 1 && (
          <div className="space-y-3 text-sm">
            <p className="text-base font-semibold">You're about to refresh your team's security.</p>
            <p className="text-muted-foreground">
              This is a safety operation. Please read each step carefully before proceeding.
            </p>
          </div>
        )}

        {/* Step 2, What happens + Quick vs Deep choice */}
        {step === 2 && (
          <div className="space-y-4 text-sm">
            <p className="font-semibold">Choose how you'd like to refresh your team's security:</p>
            <RadioGroup
              value={refreshMode}
              onValueChange={(v) => setRefreshMode(v as RefreshMode)}
              className="gap-3"
            >
              <label
                htmlFor="refresh-quick"
                className={`flex items-start gap-3 rounded-md border p-3 cursor-pointer transition-colors ${
                  refreshMode === 'quick'
                    ? 'border-[var(--color-brand-orange)] bg-[var(--color-brand-orange)]/5'
                    : 'border-border hover:bg-muted/40'
                }`}
              >
                <RadioGroupItem value="quick" id="refresh-quick" className="mt-0.5" />
                <div className="flex-1">
                  <p className="font-semibold">
                    Quick refresh{' '}
                    <span className="text-muted-foreground font-normal">(recommended)</span>
                  </p>
                  <p className="text-muted-foreground text-xs mt-1">
                    Takes a few minutes. Updates your team's security codes and makes sure removed
                    people can't read new data.
                  </p>
                </div>
              </label>
              <label
                htmlFor="refresh-deep"
                className={`flex items-start gap-3 rounded-md border p-3 cursor-pointer transition-colors ${
                  refreshMode === 'deep'
                    ? 'border-[var(--color-brand-orange)] bg-[var(--color-brand-orange)]/5'
                    : 'border-border hover:bg-muted/40'
                }`}
              >
                <RadioGroupItem value="deep" id="refresh-deep" className="mt-0.5" />
                <div className="flex-1">
                  <p className="font-semibold">Deep refresh</p>
                  <p className="text-muted-foreground text-xs mt-1">
                    Takes longer, minutes to hours depending on data size. Updates security AND
                    re-scrambles all your existing data under the new codes. Recommended if you
                    suspect a security problem or need this for an audit.
                  </p>
                </div>
              </label>
            </RadioGroup>
          </div>
        )}

        {/* Step 3, Backup recommendation */}
        {step === 3 && (
          <div className="space-y-3 text-sm">
            <p className="font-semibold">Recommended: download a backup before refreshing.</p>
            <p className="text-muted-foreground">
              Your backup is decrypted and stored locally. Keep it somewhere safe. You can skip this
              step, but we strongly recommend it.
            </p>
            <Button
              variant={backupDownloaded ? 'outline' : 'default'}
              onClick={handleDownloadBackup}
              disabled={backupDownloaded}
            >
              {backupDownloaded ? (
                <>
                  <CheckCircle2 className="w-4 h-4 mr-2" />
                  Backup downloaded
                </>
              ) : (
                <>
                  <Download className="w-4 h-4 mr-2" />
                  Download backup
                </>
              )}
            </Button>
          </div>
        )}

        {/* Step 4, Timing */}
        {step === 4 && (
          <div className="space-y-3 text-sm">
            <p className="font-semibold">Recommended: run this during low-activity hours.</p>
            <p className="text-muted-foreground">
              Nights or weekends minimize disruption for your team. Estimated time: about{' '}
              {estimatedMinutes} {estimatedMinutes === 1 ? 'minute' : 'minutes'}
              {refreshMode === 'deep' ? ' for the Deep refresh' : ''}. While this runs, team members
              can still view data but cannot make changes.
            </p>
          </div>
        )}

        {/* Step 5, Team impact */}
        {step === 5 && (
          <div className="space-y-3 text-sm">
            <p className="font-semibold">
              Your team will see a short maintenance message while this runs.
            </p>
            <p className="text-muted-foreground">
              After the refresh finishes, other team members must reload their browser to continue
              working.
            </p>
          </div>
        )}

        {/* Step 6, Final review */}
        {step === 6 && (
          <div className="space-y-3 text-sm">
            <p className="font-semibold">Ready to refresh?</p>
            <ul className="list-disc pl-5 space-y-1 text-muted-foreground">
              <li>
                {refreshMode === 'deep' ? 'Deep refresh selected, ' : 'Quick refresh selected, '}
                {refreshMode === 'deep'
                  ? 'new security codes will be issued AND your existing data will be re-scrambled under them.'
                  : 'new security codes will be issued and shared with your team.'}
              </li>
              {refreshMode === 'deep' && rowsTotal > 0 && (
                <li>Your data will be re-scrambled ({rowsTotal.toLocaleString()} rows).</li>
              )}
              <li>Your team will receive the new security codes.</li>
              <li>You have a 30-day window to undo the last refresh if anything goes wrong.</li>
            </ul>
            <div className="flex items-start gap-2 pt-1">
              <Checkbox
                id="rekey-confirm"
                checked={acknowledged}
                onCheckedChange={(v) => setAcknowledged(v === true)}
              />
              <Label htmlFor="rekey-confirm" className="text-sm font-normal leading-tight">
                I understand what this does and have downloaded a backup if I need one.
              </Label>
            </div>
          </div>
        )}

        {/* Step 7, Running / Done / Failed */}
        {step === 7 && (
          <div className="space-y-3 text-sm">
            {runState === 'running' && (
              <>
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>{stageLabel}</span>
                </div>
                {rowsTotal > 0 && (
                  <div className="space-y-1">
                    <Progress value={rowsPercent} className="h-2" />
                    <p className="text-xs text-muted-foreground">
                      {rowsProcessed.toLocaleString()} of {rowsTotal.toLocaleString()} rows
                    </p>
                  </div>
                )}
                <p className="text-xs text-muted-foreground">
                  Do not close this tab until this finishes. Progress is saved, you can resume later
                  if needed.
                </p>
              </>
            )}
            {runState === 'succeeded' && (
              <div className="flex items-start gap-2 rounded-md border border-vault-unlocked/40 bg-vault-unlocked/10 p-3">
                <CheckCircle2 className="w-5 h-5 text-vault-unlocked mt-0.5" />
                <span>Security refreshed successfully. Your team will be prompted to reload.</span>
              </div>
            )}
            {runState === 'aborted' && (
              <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3">
                <AlertTriangle className="w-5 h-5 text-destructive mt-0.5" />
                <div>
                  <p className="font-semibold">{errorMsg ?? 'The security refresh was stopped.'}</p>
                  <p className="text-muted-foreground text-xs mt-1">
                    No data was lost. Your previous security is still active.
                  </p>
                </div>
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          {step === 1 && (
            <>
              <Button variant="outline" onClick={close}>
                Cancel
              </Button>
              <Button onClick={() => setStep(2)}>Continue</Button>
            </>
          )}
          {step === 2 && (
            <>
              {!startAtWhatHappens && (
                <Button variant="outline" onClick={() => setStep(1)}>
                  Back
                </Button>
              )}
              {startAtWhatHappens && (
                <Button variant="outline" onClick={close}>
                  Cancel
                </Button>
              )}
              <Button onClick={() => setStep(3)}>Continue</Button>
            </>
          )}
          {step === 3 && (
            <>
              <Button variant="outline" onClick={() => setStep(2)}>
                Back
              </Button>
              <Button onClick={() => setStep(4)}>
                {backupDownloaded ? 'Continue' : 'Continue without backup'}
              </Button>
            </>
          )}
          {step === 4 && (
            <>
              <Button variant="outline" onClick={() => setStep(3)}>
                Back
              </Button>
              <Button onClick={() => setStep(5)}>Continue</Button>
            </>
          )}
          {step === 5 && (
            <>
              <Button variant="outline" onClick={() => setStep(4)}>
                Back
              </Button>
              <Button onClick={() => setStep(6)}>Continue</Button>
            </>
          )}
          {step === 6 && (
            <>
              <Button variant="outline" onClick={() => setStep(5)}>
                Back
              </Button>
              <Button disabled={!acknowledged} onClick={() => void kickOff()}>
                Refresh security now
              </Button>
            </>
          )}
          {step === 7 && runState !== 'running' && <Button onClick={close}>Close</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default RekeyWizard;
