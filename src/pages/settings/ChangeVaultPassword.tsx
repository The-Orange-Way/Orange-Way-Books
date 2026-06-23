/**
 * ChangeVaultPassword, two-step settings page for rotating the vault password.
 *
 * Step 1: current + new + confirm password form. Submits to
 *   VaultContext.changeVaultPassword which unwraps the MEK with the current
 *   password, re-wraps it with the new password, and rotates the recovery
 *   code. The MEK itself is unchanged so no data re-encryption happens.
 *
 * Step 2: reveal the new recovery code. User must acknowledge saving it
 *   before leaving the page.
 */

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, Check, Copy, KeyRound, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { supabase } from '@/lib/supabase';
import { useVault } from '@/context/VaultContext';
import { MIN_VAULT_PASSWORD_LENGTH } from '@/lib/vault';
import { toast } from 'sonner';

export default function ChangeVaultPassword() {
  const navigate = useNavigate();
  const { changeVaultPassword, isUnlocked } = useVault();

  const [userId, setUserId] = useState<string | null>(null);
  const [orgId, setOrgId] = useState<string | null>(null);
  const [orgSalt, setOrgSalt] = useState<string | null>(null);
  const [encMekCiphertext, setEncMekCiphertext] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const [newRecoveryCode, setNewRecoveryCode] = useState<string | null>(null);
  const [recoveryAcked, setRecoveryAcked] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    (async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) {
        navigate('/app');
        return;
      }
      setUserId(user.id);

      const storedOrg = localStorage.getItem('orangewaybooks.active_org');
      if (!storedOrg) {
        setError('No active organization selected.');
        setLoading(false);
        return;
      }
      setOrgId(storedOrg);

      const { data: settings } = await (supabase as any)
        .from('org_settings')
        .select('vault_salt, enc_mek_ciphertext, vault_key_version')
        .eq('org_id', storedOrg)
        .maybeSingle();

      if (!settings || !(settings as any).vault_salt || !(settings as any).enc_mek_ciphertext) {
        setError('Vault is not set up; password change unavailable.');
        setLoading(false);
        return;
      }

      setOrgSalt((settings as any).vault_salt);
      setEncMekCiphertext((settings as any).enc_mek_ciphertext);
      setLoading(false);
    })();
  }, [navigate]);

  const matches = newPassword.length > 0 && newPassword === confirm;
  const longEnough = newPassword.length >= MIN_VAULT_PASSWORD_LENGTH;
  const differentFromCurrent = (newPassword !== currentPassword) | (newPassword.length === 0);
  const canSubmit =
    !submitting &&
    !!currentPassword &&
    matches &&
    longEnough &&
    differentFromCurrent &&
    !!orgSalt &&
    !!encMekCiphertext &&
    !!userId;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (!orgSalt || !encMekCiphertext || !userId || !orgId) {
      setError('Vault metadata missing. Refresh the page.');
      return;
    }
    if (!matches) {
      setError('New passwords do not match.');
      return;
    }
    if (!longEnough) {
      setError(`New password must be at least ${MIN_VAULT_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (!differentFromCurrent) {
      setError('New password must be different from the current one.');
      return;
    }

    setSubmitting(true);
    try {
      const {
        newEncMekCiphertext,
        newRecoveryCode: fresh,
        newRecoveryCiphertext,
        newVerifier,
      } = await changeVaultPassword({
        currentPassword,
        newPassword,
        orgSaltB64: orgSalt,
        encMekCiphertext,
        userId,
      });

      const { error: updateErr } = await (supabase as any)
        .from('org_settings')
        .update({
          enc_mek_ciphertext: newEncMekCiphertext,
          recovery_ciphertext: newRecoveryCiphertext,
          vault_verifier: newVerifier,
        })
        .eq('org_id', orgId);
      if (updateErr) throw updateErr;

      setEncMekCiphertext(newEncMekCiphertext);
      setNewRecoveryCode(fresh);
      toast.success('Vault password changed.');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to change vault password.';
      setError(msg);
    }
    setSubmitting(false);
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!isUnlocked) {
    return (
      <div className="max-w-md mx-auto p-6">
        <p className="text-sm text-muted-foreground">Unlock your vault first.</p>
      </div>
    );
  }

  // Step 2, new recovery code reveal.
  if (newRecoveryCode) {
    const words = newRecoveryCode.split(' ');
    return (
      <div className="max-w-md mx-auto p-6 space-y-5">
        <div className="flex items-center gap-2">
          <KeyRound className="w-5 h-5 text-primary" />
          <h1 className="text-lg font-semibold">Save Your New Recovery Code</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          Your old recovery code has been invalidated. Save this new one, it will
          <strong> not </strong> be shown again.
        </p>

        <div className="rounded-md border-2 border-orange-500/40 bg-orange-500/5 p-4 space-y-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-orange-600">
            New recovery code
          </p>
          <div className="grid grid-cols-3 gap-2">
            {words.map((word, i) => (
              <div key={i} className="flex items-center gap-1.5 text-sm">
                <span className="w-5 text-right text-xs text-muted-foreground shrink-0">
                  {i + 1}.
                </span>
                <span className="font-mono font-medium">{word}</span>
              </div>
            ))}
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-full"
            onClick={() => {
              void navigator.clipboard.writeText(newRecoveryCode).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              });
            }}
          >
            {copied ? (
              <>
                <Check className="w-3 h-3 mr-1" /> Copied
              </>
            ) : (
              <>
                <Copy className="w-3 h-3 mr-1" /> Copy all 12 words
              </>
            )}
          </Button>
        </div>

        <div className="rounded-md border border-border bg-muted p-3 text-xs text-muted-foreground space-y-1">
          <p className="font-medium text-foreground">Where to store it:</p>
          <p>✓ Password manager (1Password, Bitwarden, KeePass)</p>
          <p>✓ Printed and stored offline</p>
          <p>✗ Not screenshots, email, or cloud notes</p>
        </div>

        <label className="flex items-start gap-2 cursor-pointer">
          <Checkbox
            checked={recoveryAcked}
            onCheckedChange={(v) => setRecoveryAcked(v === true)}
            className="mt-0.5"
          />
          <span className="text-sm">
            I have saved my new recovery code. I understand the old code no longer works.
          </span>
        </label>

        <Button
          type="button"
          className="w-full"
          disabled={!recoveryAcked}
          onClick={() => navigate('/app/admin')}
        >
          Done
        </Button>
      </div>
    );
  }

  // Step 1, change password form.
  return (
    <div className="max-w-md mx-auto p-6 space-y-5">
      <div className="flex items-center gap-2">
        <ShieldCheck className="w-5 h-5 text-primary" />
        <h1 className="text-lg font-semibold">Change Vault Password</h1>
      </div>

      <p className="text-sm text-muted-foreground">
        Changing your vault password does not re-encrypt your data. Only the key wrapping is
        rotated, and a fresh recovery code is generated.
      </p>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="current">Current password</Label>
          <Input
            id="current"
            type="password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            autoComplete="current-password"
            autoFocus
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="new">New password</Label>
          <Input
            id="new"
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            placeholder={`At least ${MIN_VAULT_PASSWORD_LENGTH} characters`}
            autoComplete="new-password"
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="confirm">Confirm new password</Label>
          <Input
            id="confirm"
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
          />
          {confirm.length > 0 && newPassword !== confirm && (
            <p className="text-xs text-destructive">Passwords do not match.</p>
          )}
        </div>

        <div className="flex items-start gap-2 p-3 rounded-md bg-muted">
          <AlertTriangle className="w-4 h-4 text-muted-foreground mt-0.5 flex-shrink-0" />
          <p className="text-xs text-muted-foreground">
            A new 12-word recovery code will be generated after the change. Your old recovery code
            will stop working.
          </p>
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}

        <Button type="submit" className="w-full" disabled={!canSubmit}>
          {submitting ? 'Changing…' : 'Change vault password'}
        </Button>
      </form>
    </div>
  );
}
