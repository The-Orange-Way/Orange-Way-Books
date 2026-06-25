/**
 * Settings → Security page — Phase 4.5.
 *
 * Owner/Admin-only. Three sections:
 *
 *   1. Refresh team security — last refreshed + button to open the wizard.
 *   2. Download a backup — format picker + one-click export.
 *   3. Refresh history — list of jobs, with "Undo the last refresh" when
 *      a job is within its 30-day window.
 *
 * Gated on users.invite capability. The existing settings/security
 * route (vault password change) is renamed — password change lives at
 * settings/change-password going forward.
 */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { useUserOrg } from '@/hooks/useUserOrg';
import { useVault } from '@/context/VaultContext';
import { useCapability } from '@/hooks/useCapability';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Shield, Download, History, RotateCcw, Loader2, KeyRound } from 'lucide-react';
import { toast } from 'sonner';
import RekeyWizard from '@/components/rekey/RekeyWizard';
import { exportOrgBackup, rollbackRekey, type OrgBackupFormat } from '@/lib/rekey';

interface RotationJobSummary {
  id: string;
  status: string;
  trigger_type: string;
  started_at: string;
  completed_at: string | null;
  rollback_expires_at: string | null;
  rows_total: number;
  started_by: string;
  refresh_mode: 'quick' | 'deep' | null;
}

export default function Security() {
  const navigate = useNavigate();
  const { orgId } = useUserOrg();
  const vault = useVault();
  const canManage = useCapability('users.invite', orgId);

  const [loading, setLoading] = useState(true);
  const [lastRotatedAt, setLastRotatedAt] = useState<string | null>(null);
  const [history, setHistory] = useState<RotationJobSummary[]>([]);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [backupOpen, setBackupOpen] = useState(false);
  const [backupFormat, setBackupFormat] = useState<OrgBackupFormat>('csv');
  const [backupWorking, setBackupWorking] = useState(false);
  const [rollbackJobId, setRollbackJobId] = useState<string | null>(null);
  const [rollbackWorking, setRollbackWorking] = useState(false);

  const refresh = useCallback(async () => {
    if (!orgId) return;
    setLoading(true);

    const { data: active } = await supabase
      .from('active_key_versions')
      .select('last_rotated_at')
      .eq('org_id', orgId)
      .maybeSingle();
    setLastRotatedAt(
      (active as { last_rotated_at?: string | null } | null)?.last_rotated_at ?? null,
    );

    const { data: jobs } = await supabase
      .from('key_rotation_jobs')
      .select(
        'id, status, trigger_type, started_at, completed_at, rollback_expires_at, rows_total, started_by, refresh_mode',
      )
      .eq('org_id', orgId)
      .order('started_at', { ascending: false })
      .limit(20);
    setHistory((jobs as RotationJobSummary[] | null) ?? []);

    setLoading(false);
  }, [orgId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleBackup = useCallback(async () => {
    if (!orgId) return;
    setBackupWorking(true);
    try {
      const blob = await exportOrgBackup(orgId, backupFormat, vault.decryptText);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const ext = backupFormat === 'json' ? 'json' : 'csv';
      a.download = `orangewaybooks-backup-${new Date().toISOString().slice(0, 10)}.${ext}`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success('Backup downloaded. Keep it somewhere safe.');
      setBackupOpen(false);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Could not build the backup.';
      toast.error(msg);
    } finally {
      setBackupWorking(false);
    }
  }, [orgId, backupFormat, vault.decryptText]);

  const handleRollback = useCallback(
    async (jobId: string) => {
      setRollbackWorking(true);
      try {
        await rollbackRekey(jobId);
        toast.success('Previous security restored. Please reload to continue.');
        setRollbackJobId(null);
        await refresh();
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Could not undo the last refresh.';
        toast.error(msg);
      } finally {
        setRollbackWorking(false);
      }
    },
    [refresh],
  );

  if (!canManage) {
    return (
      <div className="max-w-2xl rounded-lg border border-border bg-card p-5">
        <p className="text-sm text-muted-foreground">
          Only Owners and Admins can manage security settings.
        </p>
      </div>
    );
  }

  if (loading || !orgId) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground text-sm">
        <Loader2 className="w-4 h-4 animate-spin" />
        Loading security settings…
      </div>
    );
  }

  const now = Date.now();
  const rollbackable = history.filter(
    (j) =>
      j.status === 'complete' &&
      j.rollback_expires_at &&
      new Date(j.rollback_expires_at).getTime() > now,
  );

  return (
    <div className="max-w-2xl space-y-6">
      {/* Refresh team security section */}
      <section className="rounded-lg border border-border bg-card p-5 space-y-4">
        <div className="flex items-center gap-2">
          <Shield className="w-5 h-5 text-[var(--color-brand-orange)]" />
          <h3 className="text-base font-semibold text-card-foreground">Refresh team security</h3>
        </div>
        <p className="text-sm text-muted-foreground">
          {lastRotatedAt
            ? `Security last refreshed: ${new Date(lastRotatedAt).toLocaleString()}`
            : "Security hasn't been refreshed yet."}
        </p>
        <p className="text-sm text-muted-foreground">
          Refreshing your team's security issues fresh security codes and shares them with current
          team members. Anyone you've removed loses access to data they cached on their device.
        </p>
        <Button onClick={() => setWizardOpen(true)}>Refresh security now</Button>
      </section>

      {/* Recovery code section */}
      <section className="rounded-lg border border-border bg-card p-5 space-y-4">
        <div className="flex items-center gap-2">
          <KeyRound className="w-5 h-5 text-[var(--color-brand-orange)]" />
          <h3 className="text-base font-semibold text-card-foreground">Recovery code</h3>
        </div>
        <p className="text-sm text-muted-foreground">
          Your recovery code unlocks your vault if you ever forget your vault password. If you've
          lost track of yours, generate a new one — this invalidates the old one.
        </p>
        <Button variant="outline" onClick={() => navigate('/app/settings/recovery-code')}>
          Manage recovery code
        </Button>
      </section>

      {/* Master recovery section (S14) */}
      <section className="rounded-lg border border-border bg-card p-5 space-y-4">
        <div className="flex items-center gap-2">
          <KeyRound className="w-5 h-5 text-[var(--color-brand-orange)]" />
          <h3 className="text-base font-semibold text-card-foreground">Master recovery code</h3>
        </div>
        <p className="text-sm text-muted-foreground">
          One 12-word phrase that unlocks every organization you belong to. Optional — per-org
          recovery codes still work independently.
        </p>
        <Button variant="outline" onClick={() => navigate('/app/settings/master-recovery')}>
          Manage master recovery
        </Button>
      </section>

      {/* Backup section */}
      <section className="rounded-lg border border-border bg-card p-5 space-y-4">
        <div className="flex items-center gap-2">
          <Download className="w-5 h-5 text-[var(--color-brand-orange)]" />
          <h3 className="text-base font-semibold text-card-foreground">Download a backup</h3>
        </div>
        <p className="text-sm text-muted-foreground">
          Your backup is decrypted and stored locally. Keep it somewhere safe.
        </p>
        <Button variant="outline" onClick={() => setBackupOpen(true)}>
          Download organization backup
        </Button>
      </section>

      {/* Refresh history section */}
      <section className="rounded-lg border border-border bg-card p-5 space-y-4">
        <div className="flex items-center gap-2">
          <History className="w-5 h-5 text-muted-foreground" />
          <h3 className="text-base font-semibold text-card-foreground">Refresh history</h3>
        </div>
        {history.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No security refreshes have been started for this organization yet.
          </p>
        ) : (
          <div className="space-y-2">
            {history.map((j) => (
              <div
                key={j.id}
                className="flex items-center justify-between gap-3 text-sm border border-border rounded-md p-3"
              >
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs text-muted-foreground">
                      {new Date(j.started_at).toLocaleString()}
                    </span>
                    <StatusBadge status={j.status} />
                    <RefreshModeBadge mode={j.refresh_mode} />
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {friendlyTrigger(j.trigger_type)} · {j.rows_total.toLocaleString()} rows
                    {j.rollback_expires_at &&
                      j.status === 'complete' &&
                      new Date(j.rollback_expires_at).getTime() > now && (
                        <>
                          {' '}
                          · undo available until{' '}
                          {new Date(j.rollback_expires_at).toLocaleDateString()}
                        </>
                      )}
                  </p>
                </div>
                {j.status === 'complete' &&
                  j.rollback_expires_at &&
                  new Date(j.rollback_expires_at).getTime() > now && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setRollbackJobId(j.id)}
                      disabled={rollbackWorking}
                    >
                      <RotateCcw className="w-4 h-4 mr-1" />
                      Undo the last refresh
                    </Button>
                  )}
              </div>
            ))}
          </div>
        )}
        {rollbackable.length > 0 && (
          <p className="text-xs text-muted-foreground pt-2 border-t border-border">
            Undoing restores the previous security. Only use this if something is wrong after the
            refresh.
          </p>
        )}
      </section>

      {/* Backup format picker */}
      <Dialog
        open={backupOpen}
        onOpenChange={(o) => {
          if (!o && !backupWorking) setBackupOpen(false);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Download organization backup</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <p>Choose a format for your backup. Both contain the same data.</p>
            <Select
              value={backupFormat}
              onValueChange={(v) => setBackupFormat(v as OrgBackupFormat)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="csv">CSV — best for spreadsheets (recommended)</SelectItem>
                <SelectItem value="json">JSON — machine-readable</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBackupOpen(false)} disabled={backupWorking}>
              Cancel
            </Button>
            <Button onClick={() => void handleBackup()} disabled={backupWorking}>
              {backupWorking && <Loader2 className="w-4 h-4 animate-spin mr-2" />}
              Download
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Undo last refresh confirm */}
      <Dialog
        open={!!rollbackJobId}
        onOpenChange={(o) => {
          if (!o && !rollbackWorking) setRollbackJobId(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Undo the last refresh?</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <p className="font-semibold">This restores your previous security.</p>
            <p className="text-muted-foreground">
              Only use this if something is wrong after the latest refresh. Your team will need to
              reload after this finishes.
            </p>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setRollbackJobId(null)}
              disabled={rollbackWorking}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={rollbackWorking}
              onClick={() => {
                if (rollbackJobId) void handleRollback(rollbackJobId);
              }}
            >
              {rollbackWorking && <Loader2 className="w-4 h-4 animate-spin mr-2" />}
              Undo now
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Rekey wizard */}
      {wizardOpen && orgId && (
        <RekeyWizard
          orgId={orgId}
          open={wizardOpen}
          onClose={() => setWizardOpen(false)}
          onCompleted={() => {
            void refresh();
          }}
        />
      )}
    </div>
  );
}

function friendlyTrigger(trigger: string): string {
  switch (trigger) {
    case 'first_time_setup':
      return 'First-time setup';
    case 'manual':
      return 'Manual refresh';
    case 'post_revoke':
      return 'After member removal';
    default:
      return trigger;
  }
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    pending: { label: 'Pending', cls: 'bg-gray-100 text-gray-700' },
    generating_keys: { label: 'Creating codes', cls: 'bg-amber-100 text-amber-800' },
    wrapping_members: { label: 'Sharing codes', cls: 'bg-amber-100 text-amber-800' },
    rekeying_rows: { label: 'Updating data', cls: 'bg-amber-100 text-amber-800' },
    finalizing: { label: 'Finishing', cls: 'bg-amber-100 text-amber-800' },
    complete: { label: 'Complete', cls: 'bg-green-100 text-green-800' },
    aborted: { label: 'Stopped', cls: 'bg-red-100 text-red-800' },
    rolled_back: { label: 'Undone', cls: 'bg-red-100 text-red-800' },
  };
  const v = map[status] ?? { label: status, cls: 'bg-gray-100 text-gray-700' };
  return (
    <span className={`text-[10px] font-semibold px-2 py-0.5 rounded ${v.cls}`}>{v.label}</span>
  );
}

function RefreshModeBadge({ mode }: { mode: 'quick' | 'deep' | null }) {
  if (!mode) return null;
  const label = mode === 'deep' ? 'Deep refresh' : 'Quick refresh';
  const cls = mode === 'deep' ? 'bg-purple-100 text-purple-800' : 'bg-blue-100 text-blue-800';
  return <span className={`text-[10px] font-semibold px-2 py-0.5 rounded ${cls}`}>{label}</span>;
}
