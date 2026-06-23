/**
 * Settings → Security → Recovery code
 *
 * Lets the user rotate their vault recovery code. The crypto design
 * intentionally throws the original code away after onboarding, only
 * the MEK wrapped under the code's derived KEK is persisted. So there
 * is no "view existing code" affordance; the only operation available
 * is "generate a new one" (which invalidates the old one).
 *
 * Flow:
 *   1. Acknowledge that rotating invalidates the previous code.
 *   2. Click "Generate new recovery code" → calls rotateRecoveryCode
 *      against the in-memory MEK + PERSISTs the new recovery_ciphertext
 *      to org_settings.
 *   3. Display the new 12-word code with copy-to-clipboard.
 *   4. Type-back verification: retype 3 random positions to prove save
 *      (same pattern as onboarding S3) before the page lets the user
 *      navigate away.
 *
 * Surfaced by 2026-05-16 security review (combined S4 + S9, viewing
 * the existing code is impossible by design, so this is the only
 * meaningful settings affordance).
 */

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, Check, Copy, KeyRound, Loader2, Printer, ShieldCheck } from 'lucide-react';
import { openRecoveryBackup } from '@/lib/recoveryBackup';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { supabase } from '@/lib/supabase';
import { useVault } from '@/context/VaultContext';
import { writeAuditLog } from '@/lib/audit-logger';
import { toast } from 'sonner';

type Stage = 'intro' | 'display' | 'verify' | 'done';

export default function RecoveryCode() {
  const navigate = useNavigate();
  const { rotateRecoveryCode, encryptText, isUnlocked } = useVault();

  const [orgId, setOrgId] = useState<string | null>(null);
  const [hasRecoveryCipher, setHasRecoveryCipher] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const [stage, setStage] = useState<Stage>('intro');
  const [confirmAck, setConfirmAck] = useState(false);
  const [newCode, setNewCode] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [verifyPositions, setVerifyPositions] = useState<number[]>([]);
  const [verifyInputs, setVerifyInputs] = useState<string[]>(['', '', '']);
  const [verifyError, setVerifyError] = useState('');

  useEffect(() => {
    (async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) {
        navigate('/app');
        return;
      }
      const stored = localStorage.getItem('orangewaybooks.active_org');
      const { data: memberships } = await supabase
        .from('org_members')
        .select('org_id, joined_at')
        .eq('user_id', user.id)
        .order('joined_at', { ascending: true });
      const orgIds = (memberships ?? []).map((m: any) => m.org_id as string);
      if (orgIds.length === 0) {
        navigate('/app');
        return;
      }
      const active = stored && orgIds.includes(stored) ? stored : orgIds[0];
      const { data: settings } = await (supabase as any)
        .from('org_settings')
        .select('recovery_ciphertext')
        .eq('org_id', active)
        .maybeSingle();
      setOrgId(active);
      setHasRecoveryCipher(!!(settings as any)?.recovery_ciphertext);
      setLoading(false);
    })();
  }, [navigate]);

  // Warn on navigation while the new code is unverified.
  useEffect(() => {
    if (stage !== 'display' && stage !== 'verify') return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue =
        'Your new recovery code has not been verified saved. Closing this page now will lock you out next time you forget your password.';
      return e.returnValue;
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [stage]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground text-sm p-6">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading recovery code status…
      </div>
    );
  }

  if (!isUnlocked) {
    return (
      <div className="max-w-2xl p-6">
        <div className="rounded-lg border border-border bg-card p-5">
          <p className="text-sm text-muted-foreground">
            Unlock your vault to manage your recovery code.
          </p>
        </div>
      </div>
    );
  }

  const handleGenerate = async () => {
    if (!orgId) return;
    setError('');
    setSubmitting(true);
    try {
      const out = await rotateRecoveryCode();
      const { error: updErr } = await (supabase as any)
        .from('org_settings')
        .update({ recovery_ciphertext: out.newRecoveryCiphertext })
        .eq('org_id', orgId);
      if (updErr) throw new Error(`Could not save: ${updErr.message}`);
      await writeAuditLog({
        orgId,
        action: 'UPDATE',
        entityType: 'org_settings',
        entityId: orgId,
        summary: 'Rotated vault recovery code',
        encrypt: encryptText,
      });
      setNewCode(out.newRecoveryCode);
      setHasRecoveryCipher(true);
      setStage('display');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Recovery code rotation failed.';
      setError(msg);
      toast.error(msg);
    } finally {
      setSubmitting(false);
    }
  };

  const handleStartVerify = () => {
    // Pick 3 distinct random positions out of 12.
    const positions: number[] = [];
    while (positions.length < 3) {
      const buf = new Uint32Array(1);
      window.crypto.getRandomValues(buf);
      const pos = buf[0] % 12;
      if (!positions.includes(pos)) positions.push(pos);
    }
    positions.sort((a, b) => a - b);
    setVerifyPositions(positions);
    setVerifyInputs(['', '', '']);
    setVerifyError('');
    setStage('verify');
  };

  const handleConfirmVerify = () => {
    if (!newCode) return;
    const words = newCode.split(' ');
    const allMatch = verifyPositions.every(
      (pos, i) => verifyInputs[i].trim().toLowerCase() === words[pos],
    );
    if (!allMatch) {
      setVerifyError('One or more words do not match. Check your saved copy and try again.');
      return;
    }
    setStage('done');
    toast.success('Recovery code rotated and verified saved.');
  };

  const handleCopy = async () => {
    if (!newCode) return;
    try {
      await navigator.clipboard.writeText(newCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore
    }
  };

  // ── Render ────────────────────────────────────────────────────────────
  return (
    <div className="max-w-2xl p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground mb-1 flex items-center gap-2">
          <KeyRound className="w-6 h-6 text-primary" />
          Recovery code
        </h1>
        <p className="text-sm text-muted-foreground">
          Your recovery code unlocks your vault if you ever forget your vault password. It is the
          only backup that works without your password, keep it somewhere safe.
        </p>
      </div>

      {stage === 'intro' && (
        <section className="rounded-lg border border-border bg-card p-5 space-y-4">
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-5 h-5 text-primary" />
            <h2 className="text-base font-semibold text-card-foreground">Status</h2>
          </div>
          <p className="text-sm text-muted-foreground">
            {hasRecoveryCipher
              ? '✅ A recovery code is set for this organization.'
              : '⚠️ No recovery code is set yet. Generate one now.'}
          </p>

          <div className="rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground space-y-1">
            <p className="font-medium text-foreground">Why you cannot view the existing code</p>
            <p>
              By design, only an encrypted form of your code is stored on the server. The original
              code was shown once during setup and never persisted. If you have lost track of it,
              generate a new one below.
            </p>
          </div>

          <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-xs text-amber-900 dark:text-amber-200 flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
            <div>
              <p className="font-medium mb-1">Generating a new code invalidates the old one.</p>
              <p>
                Any copy of your old recovery code (in a password manager, on paper, etc.) stops
                working the moment you click below. Make sure you can save the new one safely before
                continuing.
              </p>
            </div>
          </div>

          <div className="flex items-start gap-2">
            <Checkbox
              id="ack"
              checked={confirmAck}
              onCheckedChange={(v) => setConfirmAck(Boolean(v))}
            />
            <Label htmlFor="ack" className="text-sm leading-tight cursor-pointer">
              I understand the old code stops working and I am ready to save the new one
              immediately.
            </Label>
          </div>

          {error && (
            <p className="text-sm text-destructive flex items-start gap-1">
              <AlertTriangle className="w-4 h-4 mt-0.5" />
              {error}
            </p>
          )}

          <Button
            onClick={handleGenerate}
            disabled={!confirmAck || submitting}
            data-testid="generate-recovery-code"
          >
            {submitting
              ? 'Generating…'
              : hasRecoveryCipher
                ? 'Generate a new recovery code'
                : 'Generate recovery code'}
          </Button>
        </section>
      )}

      {stage === 'display' && newCode && (
        <section className="rounded-lg border-2 border-primary/40 bg-primary/5 p-5 space-y-4">
          <div className="flex items-center gap-2">
            <KeyRound className="w-5 h-5 text-primary" />
            <h2 className="text-base font-semibold text-card-foreground">Your new recovery code</h2>
          </div>
          <p className="text-xs text-muted-foreground">Shown once. Copy or write it down now.</p>

          <div
            className="rounded-md border border-primary/40 bg-background p-4 grid grid-cols-3 gap-2"
            data-testid="new-recovery-code-grid"
          >
            {newCode.split(' ').map((word, i) => (
              <div
                key={i}
                className="flex items-center gap-1.5 text-sm"
                data-testid={`new-recovery-word-${i}`}
              >
                <span className="w-5 text-right text-xs text-muted-foreground shrink-0">
                  {i + 1}.
                </span>
                <span className="font-mono font-medium">{word}</span>
              </div>
            ))}
          </div>

          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" size="sm" onClick={handleCopy}>
              {copied ? (
                <>
                  <Check className="w-4 h-4 mr-1" /> Copied
                </>
              ) : (
                <>
                  <Copy className="w-4 h-4 mr-1" /> Copy all 12 words
                </>
              )}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="download-recovery-pdf"
              onClick={() => {
                try {
                  openRecoveryBackup({ code: newCode });
                } catch (err) {
                  toast.error(err instanceof Error ? err.message : 'Could not open print window.');
                }
              }}
            >
              <Printer className="w-4 h-4 mr-1" /> Download printable backup
            </Button>
          </div>

          <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-xs text-amber-900 dark:text-amber-200 flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
            <div>
              <p className="font-medium mb-1">This is your only backup.</p>
              <p>
                Save it offline (password manager, paper, hardware token). It will not be shown
                again.
              </p>
            </div>
          </div>

          <Button type="button" onClick={handleStartVerify} className="w-full">
            I have saved it, verify
          </Button>
        </section>
      )}

      {stage === 'verify' && newCode && (
        <section
          className="rounded-lg border border-border bg-card p-5 space-y-4"
          data-testid="settings-recovery-verify-block"
        >
          <h2 className="text-base font-semibold text-card-foreground">Prove you saved it</h2>
          <p className="text-sm text-muted-foreground">
            Type the words at the positions below from your saved copy.
          </p>
          <div className="space-y-2">
            {verifyPositions.map((pos, i) => (
              <div key={pos} className="flex items-center gap-2">
                <span className="w-16 text-xs text-muted-foreground">Word {pos + 1}</span>
                <Input
                  value={verifyInputs[i]}
                  onChange={(e) => {
                    const next = [...verifyInputs];
                    next[i] = e.target.value;
                    setVerifyInputs(next);
                    setVerifyError('');
                  }}
                  autoComplete="off"
                  spellCheck={false}
                  className="font-mono"
                  data-testid={`settings-verify-word-${pos}`}
                  autoFocus={i === 0}
                />
              </div>
            ))}
          </div>
          {verifyError && (
            <p className="text-sm text-destructive flex items-start gap-1">
              <AlertTriangle className="w-4 h-4 mt-0.5" />
              {verifyError}
            </p>
          )}
          <div className="flex gap-2">
            <Button
              type="button"
              variant="ghost"
              className="flex-1"
              onClick={() => setStage('display')}
            >
              Back to code
            </Button>
            <Button
              type="button"
              className="flex-1"
              disabled={verifyInputs.some((v) => !v.trim())}
              onClick={handleConfirmVerify}
            >
              Confirm
            </Button>
          </div>
        </section>
      )}

      {stage === 'done' && (
        <section className="rounded-lg border border-emerald-500/40 bg-emerald-500/5 p-5 space-y-3">
          <div className="flex items-center gap-2">
            <Check className="w-5 h-5 text-emerald-600" />
            <h2 className="text-base font-semibold text-card-foreground">Recovery code rotated</h2>
          </div>
          <p className="text-sm text-muted-foreground">
            Your previous recovery code no longer works. Use the new one if you ever need to recover
            your vault.
          </p>
          <Button variant="outline" onClick={() => navigate('/app/settings/security')}>
            Back to security settings
          </Button>
        </section>
      )}
    </div>
  );
}
