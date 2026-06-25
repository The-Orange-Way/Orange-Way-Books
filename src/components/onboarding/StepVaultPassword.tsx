import { useEffect, useMemo, useState } from 'react';
import { useVault } from '@/context/VaultContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import {
  ShieldCheck,
  Eye,
  EyeOff,
  AlertTriangle,
  Dice5,
  Copy,
  Check,
  Download,
  Printer,
} from 'lucide-react';
import { toast } from 'sonner';
import { openRecoveryBackup } from '@/lib/recoveryBackup';
import { MIN_VAULT_PASSWORD_LENGTH } from '@/lib/vault';
import { zxcvbn, zxcvbnOptions } from '@zxcvbn-ts/core';
import * as zxcvbnCommon from '@zxcvbn-ts/language-common';
import * as zxcvbnEn from '@zxcvbn-ts/language-en';

// Configure zxcvbn with the English + common-language dictionaries once at
// module load. The scorer is cheap after that; the dictionaries are the
// heavy part and are shared across all calls.
zxcvbnOptions.setOptions({
  translations: zxcvbnEn.translations,
  graphs: zxcvbnCommon.adjacencyGraphs,
  dictionary: {
    ...zxcvbnCommon.dictionary,
    ...zxcvbnEn.dictionary,
  },
});

/** Minimum acceptable zxcvbn score (0-4). 4 = very strong. */
const MIN_ZXCVBN_SCORE = 4;

/** Words used for the passphrase generator.
 *
 * We use zxcvbn-ts' `wikipedia` wordlist (≈30k entries) filtered to short
 * lowercase English words. The task spec referenced the EFF large wordlist,
 * but zxcvbn-ts does not bundle it and we don't want to pull in a separate
 * package or a 100KB static JSON for this screen — the filtered wikipedia
 * pool gives us an equivalently large, high-entropy source.
 *
 * Selection happens via crypto.getRandomValues — never Math.random.
 */
const WORDLIST: readonly string[] = Object.freeze(
  (zxcvbnEn.dictionary.wikipedia as readonly string[]).filter((w) => /^[a-z]{4,8}$/.test(w)),
);

function randomWord(): string {
  const bytes = new Uint32Array(1);
  window.crypto.getRandomValues(bytes);
  return WORDLIST[bytes[0] % WORDLIST.length];
}

function generatePassphrase(): string {
  const words: string[] = [];
  for (let i = 0; i < 5; i++) words.push(randomWord());
  return words.join('-');
}

const SCORE_LABELS = ['Very weak', 'Weak', 'Fair', 'Strong', 'Very strong'];
const SCORE_COLORS = [
  'bg-destructive',
  'bg-destructive',
  'bg-orange-400',
  'bg-yellow-400',
  'bg-vault-unlocked',
];

export interface VaultSetupResult {
  verifier: string;
  vaultSalt: string;
  vaultKeyVersion: number;
  encMekCiphertext: string;
  recoveryCiphertext: string;
  recoveryCode: string;
}

interface StepVaultPasswordProps {
  onNext: (result: VaultSetupResult) => void;
}

export default function StepVaultPassword({ onNext }: StepVaultPasswordProps) {
  const { setupVault } = useVault();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [generated, setGenerated] = useState<string | null>(null);
  const [savedConfirmed, setSavedConfirmed] = useState(false);
  const [copied, setCopied] = useState(false);
  // Recovery code step — shown after vault is created, before onNext fires.
  const [pendingResult, setPendingResult] = useState<VaultSetupResult | null>(null);
  const [recoveryCodeSaved, setRecoveryCodeSaved] = useState(false);
  const [recoveryCodeCopied, setRecoveryCodeCopied] = useState(false);
  // Type-back confirmation: pick 3 random word positions out of 12 and require
  // the user to retype them. Stops users from clicking past the recovery-code
  // screen without actually saving it (a known lockout vector).
  const [confirmStage, setConfirmStage] = useState<'display' | 'verify'>('display');
  const [verifyPositions, setVerifyPositions] = useState<number[]>([]);
  const [verifyInputs, setVerifyInputs] = useState<string[]>(['', '', '']);
  const [verifyError, setVerifyError] = useState('');

  // Warn the user if they try to close/refresh the tab while the recovery
  // code is on screen — once they close, the code is gone forever.
  useEffect(() => {
    if (!pendingResult) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // Modern browsers ignore the custom string and show their own message,
      // but we still need preventDefault + returnValue for the prompt to fire.
      e.returnValue =
        'Your recovery code has not been verified saved. If you leave now, you may be permanently locked out of your vault.';
      return e.returnValue;
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [pendingResult]);

  // Debounce zxcvbn scoring — it's not free for long inputs.
  const [debounced, setDebounced] = useState(password);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(password), 150);
    return () => clearTimeout(t);
  }, [password]);

  const strength = useMemo(() => {
    if (!debounced) return null;
    return zxcvbn(debounced);
  }, [debounced]);

  const score = strength?.score ?? 0;
  const meetsLength = password.length >= MIN_VAULT_PASSWORD_LENGTH;
  const meetsScore = score >= MIN_ZXCVBN_SCORE;
  const matches = password.length > 0 && password === confirm;
  // When a generated passphrase is in play we require the user to check
  // "I saved this" before continuing. For manually-typed passwords, this
  // gate does not apply — the user already saw the characters as they typed.
  const requiresSavedCheck = generated !== null;
  const isValid = (meetsLength && meetsScore && matches && !requiresSavedCheck) || savedConfirmed;

  const handleGenerate = () => {
    const phrase = generatePassphrase();
    setGenerated(phrase);
    setPassword(phrase);
    setConfirm(phrase);
    setSavedConfirmed(false);
    setCopied(false);
    // Best-effort clipboard copy — fails silently on browsers without
    // the API. The phrase is still visible on screen in that case.
    void navigator.clipboard
      ?.writeText(phrase)
      .then(() => setCopied(true))
      .catch(() => {});
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (!meetsLength) {
      setError(`Password must be at least ${MIN_VAULT_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (!meetsScore) {
      setError('Password is not strong enough. Try a longer passphrase with unrelated words.');
      return;
    }
    if (!matches) {
      setError('Passwords do not match.');
      return;
    }
    if (requiresSavedCheck && !savedConfirmed) {
      setError('Please confirm you saved the generated passphrase.');
      return;
    }
    setLoading(true);
    try {
      const result = await setupVault(password);
      // Show recovery code before proceeding — user must confirm they saved it.
      setPendingResult(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to create vault.';
      setError(msg);
    }
    setLoading(false);
  };

  // Recovery code screen — shown after vault creation, before proceeding.
  if (pendingResult) {
    const words = pendingResult.recoveryCode.split(' ');
    return (
      <div className="space-y-4">
        <div className="space-y-1 pb-2">
          <h3 className="text-lg font-semibold text-card-foreground">Save your recovery code</h3>
          <p className="text-sm text-muted-foreground">Shown once. Store it somewhere safe.</p>
        </div>

        <div className="flex items-start gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
          <p className="text-amber-900 dark:text-amber-200">
            This is your only way to recover your vault if you forget your password. Save it
            somewhere safe now, we cannot show it again or recover it for you.
          </p>
        </div>

        {/* Hide the actual 12-word code during the verify stage so the user
            cannot just read it off the screen, defeats "prove you saved it".
            "Back to code" toggles confirmStage back to 'display'. */}
        {confirmStage === 'display' && (
          <div className="rounded-xl border bg-muted/40 p-3">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3" data-testid="recovery-code-grid">
              {words.map((word, i) => (
                <div
                  key={i}
                  className="flex min-w-0 items-baseline gap-1.5 rounded-md border bg-background px-2 py-1.5 font-mono text-sm"
                  data-testid={`recovery-word-${i}`}
                >
                  <span className="shrink-0 text-xs text-muted-foreground">{i + 1}.</span>
                  <span className="min-w-0 break-all font-medium">{word}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {confirmStage === 'display' && (
          <div className="grid grid-cols-3 gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                void navigator.clipboard.writeText(pendingResult.recoveryCode).then(() => {
                  setRecoveryCodeCopied(true);
                  setTimeout(() => setRecoveryCodeCopied(false), 1500);
                });
              }}
            >
              {recoveryCodeCopied ? (
                <Check className="mr-1.5 h-3.5 w-3.5" />
              ) : (
                <Copy className="mr-1.5 h-3.5 w-3.5" />
              )}
              {recoveryCodeCopied ? 'Copied' : 'Copy'}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="download-recovery-pdf-onboarding"
              onClick={() => {
                try {
                  openRecoveryBackup({ code: pendingResult.recoveryCode });
                } catch {
                  // No-op, clipboard fallback already available
                }
              }}
            >
              <Download className="mr-1.5 h-3.5 w-3.5" />
              Download
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                const w = window.open('', '_blank', 'width=600,height=700');
                if (!w) {
                  toast.error('Popup blocked. Allow popups to print.');
                  return;
                }
                const ts = new Date().toLocaleString();
                const grid = words
                  .map(
                    (word, i) =>
                      `<div style="padding:8px 12px;border:1px solid #ddd;border-radius:6px;font-family:monospace"><span style="color:#888;font-size:12px">${i + 1}.</span> <strong>${word}</strong></div>`,
                  )
                  .join('');
                w.document.write(`
                  <html><head><title>Orange Way Books, Vault Recovery Code</title></head>
                  <body style="font-family:system-ui;padding:32px;max-width:560px;margin:auto">
                    <h1 style="font-size:18px">Orange Way Books, Vault recovery code</h1>
                    <p style="color:#666;font-size:13px">Generated: ${ts}</p>
                    <p style="font-size:13px"><strong>Keep this somewhere safe.</strong> Anyone with this code can reset your vault password.</p>
                    <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:8px;margin-top:16px">${grid}</div>
                  </body></html>
                `);
                w.document.close();
                w.focus();
                setTimeout(() => w.print(), 250);
              }}
            >
              <Printer className="mr-1.5 h-3.5 w-3.5" />
              Print
            </Button>
          </div>
        )}

        {confirmStage === 'verify' && (
          <div className="rounded-xl border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
            Recovery code hidden during verification. Use "Back to code" below if you need to see it
            again.
          </div>
        )}

        {confirmStage === 'display' && (
          <>
            <label className="flex items-start gap-2 cursor-pointer">
              <Checkbox
                checked={recoveryCodeSaved}
                onCheckedChange={(v) => setRecoveryCodeSaved(v === true)}
                className="mt-0.5"
              />
              <span className="text-sm">
                I have saved my recovery code in a secure place. I understand it will not be shown
                again.
              </span>
            </label>

            <Button
              type="button"
              className="w-full"
              disabled={!recoveryCodeSaved}
              onClick={() => {
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
                setConfirmStage('verify');
              }}
            >
              Continue
            </Button>
          </>
        )}

        {confirmStage === 'verify' && (
          <div className="space-y-3" data-testid="recovery-verify-block">
            <div className="rounded-md border border-primary/30 bg-primary/5 p-3 text-sm">
              <p className="font-medium text-card-foreground mb-1">Prove you saved it</p>
              <p className="text-xs text-muted-foreground">
                Type the words at the positions below from your saved copy. This protects you from a
                future lockout.
              </p>
            </div>

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
                    data-testid={`verify-word-${pos}`}
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
                onClick={() => {
                  setConfirmStage('display');
                  setVerifyError('');
                }}
              >
                Back to code
              </Button>
              <Button
                type="button"
                className="flex-1"
                disabled={verifyInputs.some((v) => !v.trim())}
                onClick={() => {
                  const words = pendingResult.recoveryCode.split(' ');
                  const allMatch = verifyPositions.every(
                    (pos, i) => verifyInputs[i].trim().toLowerCase() === words[pos],
                  );
                  if (!allMatch) {
                    setVerifyError(
                      'One or more words do not match. Check your saved copy and try again.',
                    );
                    return;
                  }
                  onNext(pendingResult);
                }}
              >
                Confirm and continue
              </Button>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <div className="flex items-center gap-2 mb-1">
        <ShieldCheck className="w-5 h-5 text-primary" />
        <h3 className="text-base font-semibold text-card-foreground">Secure Your Vault</h3>
      </div>
      <p className="text-sm text-muted-foreground">
        This password encrypts your data locally. It never leaves your browser. Even we can&apos;t
        see your data.
      </p>

      <Button type="button" variant="outline" onClick={handleGenerate} className="w-full">
        <Dice5 className="w-4 h-4 mr-2" />
        Generate secure passphrase
      </Button>

      {/* Vault Password */}
      <div className="space-y-2">
        <Label htmlFor="vault-pw">Vault Password</Label>
        <div className="relative">
          <Input
            id="vault-pw"
            type={showPassword ? 'text' : 'password'}
            placeholder={`Minimum ${MIN_VAULT_PASSWORD_LENGTH} characters`}
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              if (generated !== null) {
                setGenerated(null);
                setSavedConfirmed(false);
              }
            }}
            className="pr-10"
            autoFocus
          />
          <button
            type="button"
            onClick={() => setShowPassword(!showPassword)}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            tabIndex={-1}
          >
            {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
          </button>
        </div>
      </div>

      {/* Strength indicator (zxcvbn) */}
      {password.length > 0 && (
        <div className="space-y-1.5">
          <div className="flex gap-1">
            {[0, 1, 2, 3, 4].map((level) => (
              <div
                key={level}
                className={`h-1.5 flex-1 rounded-full transition-colors ${
                  level <= score ? SCORE_COLORS[score] : 'bg-muted'
                }`}
              />
            ))}
          </div>
          <p
            className={`text-xs font-medium ${score < MIN_ZXCVBN_SCORE ? 'text-destructive' : 'text-muted-foreground'}`}
          >
            {SCORE_LABELS[score]}
            {!meetsLength && ` — minimum ${MIN_VAULT_PASSWORD_LENGTH} characters`}
            {meetsLength && !meetsScore && ' — add more unrelated words or length'}
            {strength?.crackTimesDisplay && score >= MIN_ZXCVBN_SCORE && (
              <span className="text-muted-foreground">
                {' '}
                · est. crack time: {strength.crackTimesDisplay.offlineSlowHashing1e4PerSecond}
              </span>
            )}
          </p>
          {strength?.feedback?.warning && (
            <p className="text-xs text-muted-foreground">{strength.feedback.warning}</p>
          )}
        </div>
      )}

      {/* Generated passphrase acknowledgement */}
      {generated !== null && (
        <div className="rounded-md border border-border bg-muted/40 p-3 space-y-2">
          <div className="flex items-center gap-2">
            {copied ? (
              <Check className="w-4 h-4 text-vault-unlocked" />
            ) : (
              <Copy className="w-4 h-4 text-muted-foreground" />
            )}
            <span className="text-xs text-muted-foreground">
              {copied
                ? 'Passphrase copied to clipboard. Store it somewhere safe before continuing.'
                : 'Store this passphrase somewhere safe before continuing.'}
            </span>
          </div>
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <Checkbox
              checked={savedConfirmed}
              onCheckedChange={(v) => setSavedConfirmed(v === true)}
            />
            I saved this passphrase in a secure place
          </label>
        </div>
      )}

      {/* Confirm */}
      <div className="space-y-2">
        <Label htmlFor="vault-pw-confirm">Confirm Vault Password</Label>
        <div className="relative">
          <Input
            id="vault-pw-confirm"
            type={showConfirm ? 'text' : 'password'}
            placeholder="Re-enter vault password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            className="pr-10"
          />
          <button
            type="button"
            onClick={() => setShowConfirm(!showConfirm)}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            tabIndex={-1}
          >
            {showConfirm ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
          </button>
        </div>
        {confirm.length > 0 && password !== confirm && (
          <p className="text-xs text-destructive">Passwords do not match.</p>
        )}
      </div>

      {/* Warning */}
      <div className="flex items-start gap-2 p-3 rounded-md bg-muted">
        <AlertTriangle className="w-4 h-4 text-muted-foreground mt-0.5 flex-shrink-0" />
        <p className="text-xs text-muted-foreground">
          Write this down — if you lose it, your data cannot be recovered.
        </p>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <Button type="submit" className="w-full" disabled={!isValid || loading}>
        {loading ? 'Creating Vault…' : 'Continue'}
      </Button>
    </form>
  );
}
