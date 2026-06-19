import { useState, useCallback } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { KeyRound, ShieldCheck, AlertTriangle, Copy, Check } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { useVault } from '@/context/VaultContext';
import { useToast } from '@/hooks/use-toast';

type Step = 'enter-code' | 'new-password' | 'save-new-code';

interface RecoveryResult {
  newRecoveryCode: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
}

const MIN_PASSWORD_LEN = 14;

type CodeKind = 'per-org' | 'master';

export default function VaultRecoveryDialog({ open, onClose }: Props) {
  const { recoverWithCode, recoverOrgWithMasterCode } = useVault();
  const { toast } = useToast();
  const [step, setStep] = useState<Step>('enter-code');
  const [codeKind, setCodeKind] = useState<CodeKind>('per-org');
  const [recoveryCode, setRecoveryCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [result, setResult] = useState<RecoveryResult | null>(null);
  const [savedCheckbox, setSavedCheckbox] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  const resetAll = useCallback(() => {
    setStep('enter-code');
    setRecoveryCode('');
    setNewPassword('');
    setConfirmPassword('');
    setResult(null);
    setSavedCheckbox(false);
    setSubmitting(false);
    setError('');
    setCopied(false);
  }, []);

  const handleClose = useCallback(() => {
    // If user is in the middle of saving their new code, warn them.
    if (step === 'save-new-code' && !savedCheckbox) {
      const ok = window.confirm(
        'You have not confirmed that you saved your new recovery code. ' +
        'If you close now, you will lose it and could be permanently locked out ' +
        'next time you forget your password. Close anyway?'
      );
      if (!ok) return;
    }
    resetAll();
    onClose();
  }, [step, savedCheckbox, onClose, resetAll]);

  const normalizedCode = recoveryCode.trim().toLowerCase().split(/\s+/).join(' ');
  const codeLooksValid = normalizedCode.split(' ').length === 12;
  const passwordOk = newPassword.length >= MIN_PASSWORD_LEN && newPassword === confirmPassword;

  const handleSubmitCode = useCallback(async () => {
    if (!codeLooksValid) {
      setError('Recovery code must be 12 words.');
      return;
    }
    setError('');
    setStep('new-password');
  }, [codeLooksValid]);

  const handleSubmitNewPassword = useCallback(async () => {
    if (newPassword.length < MIN_PASSWORD_LEN) {
      setError(`New password must be at least ${MIN_PASSWORD_LEN} characters.`);
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }
    setError('');
    setSubmitting(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not signed in.');

      // Resolve active org (same logic as VaultContext.unlock)
      const stored = localStorage.getItem('orangewaybooks.active_org');
      const { data: memberships } = await supabase
        .from('org_members')
        .select('org_id, joined_at')
        .eq('user_id', user.id)
        .order('joined_at', { ascending: true });
      const orgIds = (memberships ?? []).map((m: any) => m.org_id as string);
      if (orgIds.length === 0) throw new Error('No organization found.');
      const activeOrgId = stored && orgIds.includes(stored) ? stored : orgIds[0];

      const { data: settings } = await (supabase as any)
        .from('org_settings')
        .select('recovery_ciphertext, enc_mek_ciphertext, vault_salt, vault_key_version')
        .eq('org_id', activeOrgId)
        .maybeSingle();

      const recoveryCiphertext = (settings as any)?.recovery_ciphertext;
      const encMekCiphertext = (settings as any)?.enc_mek_ciphertext;
      const orgSalt = (settings as any)?.vault_salt;
      const vaultKeyVersion = (settings as any)?.vault_key_version ?? 1;

      if (!orgSalt || vaultKeyVersion < 4) {
        throw new Error('Recovery is not available for this vault (legacy version). Contact support.');
      }

      let out: { newEncMekCiphertext: string; newRecoveryCode: string; newRecoveryCiphertext: string; newVerifier: string };

      if (codeKind === 'master') {
        // S14 master-code path: look up the user's master record + the
        // wrap for THIS org. If either is missing, surface a clear error.
        const { data: master } = await (supabase as any)
          .from('user_master_recovery')
          .select('master_salt, master_verifier_ciphertext')
          .eq('user_id', user.id)
          .maybeSingle();
        const { data: wrapRow } = await (supabase as any)
          .from('org_master_wraps')
          .select('master_wrapped_mek')
          .eq('user_id', user.id)
          .eq('org_id', activeOrgId)
          .maybeSingle();
        if (!master || !wrapRow) {
          throw new Error(
            'No master recovery code is set up for this organization. ' +
            'Use your per-org recovery code instead, or contact support.'
          );
        }
        out = await recoverOrgWithMasterCode({
          masterCode: normalizedCode,
          masterSaltB64: (master as any).master_salt,
          verifierCiphertext: (master as any).master_verifier_ciphertext,
          masterWrappedMek: (wrapRow as any).master_wrapped_mek,
          orgSaltB64: orgSalt,
          userId: user.id,
          newPassword,
        });
      } else {
        // Per-org recovery code path.
        if (!recoveryCiphertext) {
          throw new Error('Recovery code is not available for this vault. Contact support.');
        }
        out = await recoverWithCode({
          recoveryCode: normalizedCode,
          encMekCiphertext,
          recoveryCiphertext,
          orgSaltB64: orgSalt,
          userId: user.id,
          newPassword,
        });
      }

      // Persist the new ciphertexts + verifier.
      const { error: updErr } = await (supabase as any)
        .from('org_settings')
        .update({
          vault_verifier: out.newVerifier,
          enc_mek_ciphertext: out.newEncMekCiphertext,
          recovery_ciphertext: out.newRecoveryCiphertext,
          vault_key_version: 4,
        })
        .eq('org_id', activeOrgId);
      if (updErr) throw new Error(`Could not save recovery: ${updErr.message}`);

      setResult({ newRecoveryCode: out.newRecoveryCode });
      setStep('save-new-code');
      toast({ title: 'Vault recovered', description: 'Your new password is set.' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Recovery failed.';
      setError(msg);
      // If the code was wrong, stay on the new-password step so they can try again
      // (recoveryCode is preserved in state). For unknown errors also stay so they can read.
    } finally {
      setSubmitting(false);
    }
  }, [newPassword, confirmPassword, normalizedCode, recoverWithCode, toast]);

  const handleCopyCode = useCallback(async () => {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.newRecoveryCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore — user can still hand-copy
    }
  }, [result]);

  const handleFinish = useCallback(() => {
    if (!savedCheckbox) return;
    resetAll();
    onClose();
    // Vault is already unlocked (recoverWithCode set keyRef in memory).
    // Parent unlock screen will detect isUnlocked and route the user in.
  }, [savedCheckbox, onClose, resetAll]);

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) handleClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="w-5 h-5 text-primary" />
            {step === 'enter-code' && 'Recover with your recovery code'}
            {step === 'new-password' && 'Set a new vault password'}
            {step === 'save-new-code' && 'Save your new recovery code'}
          </DialogTitle>
          <DialogDescription>
            {step === 'enter-code' && 'Enter the 12 words you saved when you first set up your vault.'}
            {step === 'new-password' && 'Your data will be re-wrapped under this password.'}
            {step === 'save-new-code' && 'This new code replaces the old one. Save it somewhere safe before closing.'}
          </DialogDescription>
        </DialogHeader>

        {step === 'enter-code' && (
          <div className="space-y-3">
            <div className="flex gap-2 text-xs" data-testid="code-kind-toggle">
              <button
                type="button"
                onClick={() => setCodeKind('per-org')}
                className={`flex-1 px-3 py-2 rounded-md border transition-colors ${codeKind === 'per-org' ? 'border-primary bg-primary/10 text-primary font-medium' : 'border-border text-muted-foreground hover:border-primary/40'}`}
              >
                This organization's code
              </button>
              <button
                type="button"
                onClick={() => setCodeKind('master')}
                className={`flex-1 px-3 py-2 rounded-md border transition-colors ${codeKind === 'master' ? 'border-primary bg-primary/10 text-primary font-medium' : 'border-border text-muted-foreground hover:border-primary/40'}`}
              >
                Master code (all orgs)
              </button>
            </div>
            <Label htmlFor="recovery-code">Recovery code (12 words)</Label>
            <Textarea
              id="recovery-code"
              rows={3}
              autoFocus
              value={recoveryCode}
              onChange={(e) => setRecoveryCode(e.target.value)}
              placeholder="abandon ability able about above absent absorb abstract absurd abuse access accident"
              className="font-mono text-sm"
            />
            <p className="text-xs text-muted-foreground">
              {codeKind === 'master'
                ? 'Your master code unlocks any organization you have enrolled.'
                : 'The 12-word code shown when you set up this organization.'}
            </p>
            {error && <p className="text-sm text-destructive flex items-start gap-1"><AlertTriangle className="w-4 h-4 mt-0.5" />{error}</p>}
          </div>
        )}

        {step === 'new-password' && (
          <div className="space-y-3">
            <div>
              <Label htmlFor="new-pw">New vault password</Label>
              <Input
                id="new-pw"
                type="password"
                autoFocus
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder={`At least ${MIN_PASSWORD_LEN} characters`}
              />
            </div>
            <div>
              <Label htmlFor="confirm-pw">Confirm new password</Label>
              <Input
                id="confirm-pw"
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
              />
            </div>
            <p className="text-xs text-muted-foreground flex items-start gap-1">
              <ShieldCheck className="w-3.5 h-3.5 mt-0.5 text-primary" />
              Your existing encrypted data stays valid. Only the wrap is replaced.
            </p>
            {error && <p className="text-sm text-destructive flex items-start gap-1"><AlertTriangle className="w-4 h-4 mt-0.5" />{error}</p>}
          </div>
        )}

        {step === 'save-new-code' && result && (
          <div className="space-y-3">
            <div className="rounded-md border border-primary/40 bg-primary/5 p-3 font-mono text-sm leading-7 break-words" data-testid="new-recovery-code">
              {result.newRecoveryCode}
            </div>
            <div className="flex gap-2">
              <Button type="button" variant="outline" size="sm" onClick={handleCopyCode}>
                {copied ? <Check className="w-4 h-4 mr-1" /> : <Copy className="w-4 h-4 mr-1" />}
                {copied ? 'Copied' : 'Copy to clipboard'}
              </Button>
            </div>
            <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-xs text-amber-900 dark:text-amber-200 flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
              <div>
                <p className="font-medium mb-1">Save this somewhere offline.</p>
                <p>If you forget your password again and lose this code, your data is unrecoverable. We cannot reset it for you.</p>
              </div>
            </div>
            <div className="flex items-start gap-2">
              <Checkbox id="saved" checked={savedCheckbox} onCheckedChange={(v) => setSavedCheckbox(Boolean(v))} />
              <Label htmlFor="saved" className="text-sm leading-tight cursor-pointer">
                I have saved my new recovery code in a safe place (password manager, paper backup, etc.)
              </Label>
            </div>
          </div>
        )}

        <DialogFooter>
          {step === 'enter-code' && (
            <>
              <Button type="button" variant="ghost" onClick={handleClose}>Cancel</Button>
              <Button type="button" onClick={handleSubmitCode} disabled={!codeLooksValid}>
                Continue
              </Button>
            </>
          )}
          {step === 'new-password' && (
            <>
              <Button type="button" variant="ghost" onClick={() => setStep('enter-code')} disabled={submitting}>Back</Button>
              <Button type="button" onClick={handleSubmitNewPassword} disabled={!passwordOk || submitting}>
                {submitting ? 'Recovering…' : 'Recover vault'}
              </Button>
            </>
          )}
          {step === 'save-new-code' && (
            <Button type="button" onClick={handleFinish} disabled={!savedCheckbox}>
              Done — enter vault
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
