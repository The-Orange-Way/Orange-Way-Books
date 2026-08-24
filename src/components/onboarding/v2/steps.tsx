/**
 * The v2 onboarding screens, and only the screens. Copy lives in
 * onboarding-copy.ts, flow constants and probes in step-helpers.ts, and the
 * ordered registry in step-registry.ts, so that this module exports components
 * and nothing else.
 *
 * This file is presentation only. Argon2id derivation, BIP-39 generation and
 * WebAuthn PRF wrapping are DL-0414's lane. Note that unlike the sibling app,
 * most of that already exists here in src/lib/vault.ts and in the v1 wizard, so
 * this flow does not re-implement it, it will call it. Every seam is marked
 * TODO(DL-0414).
 */
import { useEffect, useMemo, useState } from 'react';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { StepShell } from './onboarding-flow';
import type { OnboardingStepProps } from './onboarding-flow';
import { useOnboardingState, verifyRecoveryWords } from './onboarding-state';
import { ONBOARDING_COPY, SUCCESS_COPY, VAULT_GATE_COPY, VERIFY_COPY } from './onboarding-copy';
import { supabase } from '@/lib/supabase';
import { useVault } from '@/context/VaultContext';
import {
  PASSWORD_MIN_LENGTH,
  RECOVERY_GRID_CLASS,
  RECOVERY_VERIFY_MODE,
  RECOVERY_WORD_COUNT,
  VERIFY_WORD_COUNT,
  pickVerifyPositions,
} from './step-helpers';
import { vaultGateBlocker } from '@/lib/vault-gate';
import { MIN_ZXCVBN_SCORE, STRENGTH_LABELS, scorePassword } from '@/lib/password-strength';

export function StepName(props: OnboardingStepProps) {
  // TODO(DL-0414): lift to flow state. The name is written to the profile row
  // after the OTP round trip, not from here.
  const [name, setName] = useState('');
  const copy = ONBOARDING_COPY.name;

  return (
    <StepShell
      {...props}
      title={copy.headline}
      nextLabel={copy.cta}
      secondaryLabel={copy.secondary}
    >
      <p>{copy.body}</p>
      <Input
        type="text"
        value={name}
        onChange={(event) => setName(event.target.value)}
        autoComplete="given-name"
        placeholder="First name"
        aria-label="First name"
        className="mt-6"
      />
    </StepShell>
  );
}

/**
 * Step 2, in two stages: send a one-time code, then verify it.
 *
 * A 6-digit code rather than a clickable link, because clicking it opens a new
 * tab, this component tree is torn down, and the name from step 1 and
 * everything after it goes with it. A code is typed in place, so the wizard
 * survives. Copy correction ("one-time link" in ONBOARDING_COPY) is with CX.
 *
 * Mirrors the sibling app's StepEmail exactly. No captcha here: Books v2 does
 * not yet wire CaptchaWidget. When it does, follow the Turnstile reset dance
 * in the sibling app on send error (setCaptchaToken(null) + captchaRef.current?.reset()).
 */
export function StepEmail(props: OnboardingStepProps) {
  const { email, setEmail, setEmailVerified, setUserId } = useOnboardingState();
  const [stage, setStage] = useState<'address' | 'code'>('address');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Non-null when a live Supabase session exists on mount. OWB mounts this
  // wizard post-auth (VaultGate requires a session), so the OTP round trip
  // is a re-verification of an email the user already authenticated with.
  // When this is set we skip OTP entirely and show a Continue button instead.
  const [sessionEmail, setSessionEmail] = useState<string | null>(null);
  const copy = ONBOARDING_COPY.email;
  const looksLikeEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());

  useEffect(() => {
    void supabase.auth.getSession().then(({ data }) => {
      const session = data.session;
      // Only auto-advance on a session that is present AND still live. A stale
      // token left in storage is truthy, and must not skip verification for
      // someone who is no longer signed in. expires_at is unix seconds.
      const live =
        !!session &&
        typeof session.expires_at === 'number' &&
        session.expires_at * 1000 > Date.now();
      const se = live ? (session.user?.email ?? null) : null;
      if (se) {
        setSessionEmail(se);
        setEmail(se);
        setEmailVerified(true);
      }
    });
  }, [setEmail, setEmailVerified]);

  const sendCode = async () => {
    setBusy(true);
    setError(null);
    const { error: sendError } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: { shouldCreateUser: true },
    });
    setBusy(false);
    if (sendError) {
      setError(sendError.message);
      return;
    }
    setStage('code');
  };

  const confirmCode = async () => {
    setBusy(true);
    setError(null);
    // type 'email' is the code-in-the-body variant. 'magiclink' is the one
    // that only ever arrives as a clickable URL, which is what we are avoiding.
    const { data, error: verifyError } = await supabase.auth.verifyOtp({
      email: email.trim(),
      token: token.trim(),
      type: 'email',
    });
    setBusy(false);
    if (verifyError || !data.session) {
      setError(verifyError?.message ?? 'That code did not work. Check it and try again.');
      return;
    }
    setUserId(data.session.user.id);
    setEmailVerified(true);
    props.onNext();
  };

  if (sessionEmail) {
    return (
      <StepShell {...props} title="Email">
        <p>
          Signed in as <strong>{sessionEmail}</strong>
        </p>
      </StepShell>
    );
  }

  if (stage === 'code') {
    return (
      <StepShell
        {...props}
        onNext={() => void confirmCode()}
        title="Enter the code from your email"
        nextLabel="Confirm"
        nextDisabled={token.trim().length < 6}
        busy={busy}
        busyLabel="Checking..."
        error={error}
        secondaryLabel="Use a different address"
        onSecondary={() => {
          setStage('address');
          setToken('');
          setError(null);
        }}
        hideBack
      >
        <p>We sent a 6-digit code to {email.trim()}. Enter it below.</p>
        <Input
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          value={token}
          onChange={(event) => setToken(event.target.value.replace(/\D/g, '').slice(0, 6))}
          placeholder="000000"
          aria-label="One-time code"
          className="mt-6 tracking-[0.4em]"
        />
      </StepShell>
    );
  }

  return (
    <StepShell
      {...props}
      onNext={() => void sendCode()}
      title={copy.headline}
      nextLabel={copy.cta}
      nextDisabled={!looksLikeEmail}
      busy={busy}
      busyLabel="Sending..."
      error={error}
    >
      <p>{copy.body}</p>
      <Input
        type="email"
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        autoComplete="email"
        placeholder="you@example.com"
        aria-label="Email address"
        className="mt-6"
      />
    </StepShell>
  );
}

// Non-skippable by construction: one CTA, no secondary link, nothing to
// dismiss. This is the trust moment, so the user has to read past it.
export function StepEducation(props: OnboardingStepProps) {
  const copy = ONBOARDING_COPY.education;

  return (
    <StepShell {...props} title={copy.headline} nextLabel={copy.cta}>
      <p>{copy.body}</p>
    </StepShell>
  );
}

export function StepVaultPassword(props: OnboardingStepProps) {
  // This password never leaves the device. It is the input to setupVault (an
  // Argon2id-derived KEK wrapping a random MEK), which already lives in
  // VaultContext and is the exact call v1 makes. We do not re-derive anything
  // here: we call setupVault, keep the recovery code and the persistable
  // material in flow state for the recovery step and the org-setup phase, and
  // only then advance. Nothing is persisted from this component.
  const { setupVault } = useVault();
  const { setRecoveryCode, setVaultSetup } = useOnboardingState();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [understood, setUnderstood] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const copy = ONBOARDING_COPY.vaultPassword;

  // zxcvbn, the same scorer and the same threshold v1 already gates on. It is
  // fast enough to run per keystroke without a debounce.
  const strength = useMemo(() => scorePassword(password), [password]);
  const strongEnough = strength !== null && strength.score >= MIN_ZXCVBN_SCORE;
  const longEnough = password.length >= PASSWORD_MIN_LENGTH;
  const canContinue = longEnough && strongEnough && password === confirm && understood;

  // Which of those conditions to say out loud, decided in one place.
  //
  // The button used to be disabled by a bare conjunction with a single
  // "Strength: Good" line beside it and nothing else. Someone who typed a
  // fourteen-character password that scored 3 got a dead button and no way to
  // learn what to change; someone who typed five characters was told to make
  // it stronger rather than longer. Keeping the choice in a tested function
  // means the disabled state and the explanation cannot drift apart, which is
  // the failure the sibling app shipped a fix for. See src/lib/vault-gate.ts.
  const blocker = vaultGateBlocker({
    password,
    confirm,
    strongEnough,
    understood,
    minLength: PASSWORD_MIN_LENGTH,
  });

  const createVault = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await setupVault(password);
      setRecoveryCode(result.recoveryCode);
      setVaultSetup({
        verifier: result.verifier,
        vaultSalt: result.vaultSalt,
        vaultKeyVersion: result.vaultKeyVersion,
        encMekCiphertext: result.encMekCiphertext,
        recoveryCiphertext: result.recoveryCiphertext,
      });
      // Leave busy set: the container unmounts this step on advance, so there is
      // no state to reset, and keeping the button disabled until then stops a
      // double tap from creating a second vault.
      props.onNext();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create your vault. Try again.');
      setBusy(false);
    }
  };

  return (
    <StepShell
      {...props}
      onNext={() => void createVault()}
      title={copy.headline}
      nextLabel={copy.cta}
      nextDisabled={!canContinue}
      busy={busy}
      busyLabel="Creating your vault..."
      error={error}
    >
      <p>{copy.body}</p>
      <Input
        type="password"
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        autoComplete="new-password"
        placeholder="Vault password"
        aria-label="Vault password"
        className="mt-6"
      />
      <div className="mt-2 flex justify-between text-xs">
        <span
          className={longEnough ? 'text-muted-foreground' : 'text-destructive'}
          data-testid="vault-password-length"
        >
          {password.length}/{PASSWORD_MIN_LENGTH} characters
        </span>
        <span
          className={
            strength === null
              ? 'text-muted-foreground'
              : strength.score >= MIN_ZXCVBN_SCORE
                ? 'text-green-600 dark:text-green-400'
                : strength.score >= 2
                  ? 'text-yellow-600 dark:text-yellow-400'
                  : 'text-destructive'
          }
          aria-live="polite"
          data-testid="vault-password-strength"
        >
          {strength === null ? VAULT_GATE_COPY.emptyMeter : STRENGTH_LABELS[strength.score]}
        </span>
      </div>
      {blocker === 'length' ? (
        <p className="mt-2 text-xs text-destructive" data-testid="vault-gate-length">
          {VAULT_GATE_COPY.length}
        </p>
      ) : null}
      {blocker === 'strength' ? (
        <div
          className="mt-2 rounded-md border border-yellow-500/30 bg-yellow-500/10 p-2 text-xs text-yellow-900 dark:text-yellow-200"
          data-testid="vault-gate-strength"
        >
          <p className="font-medium">{VAULT_GATE_COPY.strength}</p>
          {strength?.warning ? <p>{strength.warning}</p> : null}
          {strength?.suggestions.map((suggestion) => (
            <p key={suggestion}>{suggestion}</p>
          ))}
        </div>
      ) : null}
      <Input
        type="password"
        value={confirm}
        onChange={(event) => setConfirm(event.target.value)}
        autoComplete="new-password"
        placeholder="Confirm vault password"
        aria-label="Confirm vault password"
        className="mt-3"
      />
      {blocker === 'mismatch' ? (
        <p className="mt-2 text-xs text-destructive" data-testid="vault-gate-mismatch">
          {VAULT_GATE_COPY.mismatch}
        </p>
      ) : null}
      <label className="mt-4 flex cursor-pointer items-start gap-2 text-sm">
        <Checkbox
          checked={understood}
          onCheckedChange={(value) => setUnderstood(value === true)}
          className="mt-0.5"
        />
        <span>{VAULT_GATE_COPY.acknowledgementLabel}</span>
      </label>
      {blocker === 'acknowledgement' ? (
        <p className="mt-2 text-xs text-muted-foreground" data-testid="vault-gate-acknowledgement">
          {VAULT_GATE_COPY.acknowledgement}
        </p>
      ) : null}
    </StepShell>
  );
}

// Shared by the staged verify stage and by the standalone StepVerify, so the
// two modes cannot drift apart.
function RecoveryWordInputs({
  positions,
  answers,
  onChange,
}: {
  positions: number[];
  answers: string[];
  onChange: (next: string[]) => void;
}) {
  return (
    <div className="mt-6 space-y-2">
      {positions.map((position, index) => (
        <div key={position} className="flex items-center gap-2">
          <span className="w-16 text-xs text-muted-foreground">Word {position + 1}</span>
          <Input
            value={answers[index] ?? ''}
            onChange={(event) => {
              const value = event.target.value;
              onChange(answers.map((answer, i) => (i === index ? value : answer)));
            }}
            autoComplete="off"
            spellCheck={false}
            className="font-mono"
            aria-label={`Word ${position + 1}`}
            data-testid={`verify-word-${position}`}
          />
        </div>
      ))}
    </div>
  );
}

/**
 * The real recovery words, read from flow state.
 *
 * These are generated on this device by generateRecoveryCode() in
 * src/lib/vault.ts, reach flow state when the vault step calls setRecoveryCode,
 * and are never transmitted. This component previously rendered twelve blank
 * bars with a TODO saying the words did not exist yet. They did: the vault step
 * runs first and stores them. The screen telling the customer to write down
 * their only way back into their books was showing them nothing to write.
 *
 * Still renders blanks when there is no code, rather than placeholder words. A
 * plausible-looking fake is worse than an obvious gap, because someone might
 * write it down. In the real flow that branch is unreachable.
 */
function RecoveryCodeSlots({ recoveryCode }: { recoveryCode: string | null }) {
  const words = recoveryCode ? recoveryCode.trim().split(/\s+/) : [];

  return (
    <ol className={RECOVERY_GRID_CLASS} data-testid="recovery-words">
      {Array.from({ length: RECOVERY_WORD_COUNT }, (_, index) => (
        <li key={index} className="flex items-center gap-2">
          <span className="w-4 text-right text-muted-foreground">{index + 1}</span>
          {words[index] ? (
            <span className="flex-1 font-mono text-sm">{words[index]}</span>
          ) : (
            <span className="h-4 flex-1 rounded bg-muted" />
          )}
        </li>
      ))}
    </ol>
  );
}

export function StepRecovery(props: OnboardingStepProps) {
  // hideBack throughout, because going back to the vault password step would
  // re-derive the key and invalidate the code the user was just told to write
  // down. That is exactly the dead end CX called out.
  const [stage, setStage] = useState<'display' | 'verify'>('display');
  const [confirmed, setConfirmed] = useState(false);
  const [positions, setPositions] = useState<number[]>([]);
  const [answers, setAnswers] = useState<string[]>([]);
  const { recoveryCode } = useOnboardingState();
  const copy = ONBOARDING_COPY.recovery;
  const staged = RECOVERY_VERIFY_MODE === 'staged';

  const enterVerify = () => {
    setPositions(pickVerifyPositions());
    setAnswers(Array.from({ length: VERIFY_WORD_COUNT }, () => ''));
    setStage('verify');
  };

  // Stage 2. Advancing from here is the container's ordinary onNext, so a pass
  // moves to step 6 like any other step completion. The way out is the
  // secondary link back to the code, never a Back button that would unwind the
  // vault password.
  //
  // The code itself is hidden while verifying, matching v1: leaving it on
  // screen turns typing it back into copying it off, which proves nothing.
  if (staged && stage === 'verify') {
    // The words have to be RIGHT, not merely present. This gated on
    // "every box is non-empty", so twelve letter As passed a screen whose
    // entire purpose is proving the customer holds their own written copy.
    // verifyRecoveryWords compares case-insensitively and ignores surrounding
    // whitespace, because people retype from paper and a trailing space is not
    // a failed recovery. It returns false when there is no code, so the button
    // stays disabled rather than passing vacuously.
    const allFilled = answers.every((answer) => answer.trim().length > 0);
    const correct = verifyRecoveryWords(recoveryCode, positions, answers);
    return (
      <StepShell
        {...props}
        title={VERIFY_COPY.headline}
        nextLabel={VERIFY_COPY.cta}
        nextDisabled={!correct}
        secondaryLabel={VERIFY_COPY.back}
        onSecondary={() => setStage('display')}
        hideBack
      >
        <p>{VERIFY_COPY.body}</p>
        <div
          className="mt-4 rounded-xl border border-border bg-muted/40 p-3 text-xs"
          data-testid="recovery-verify-block"
        >
          {VERIFY_COPY.hint}
        </div>
        <RecoveryWordInputs positions={positions} answers={answers} onChange={setAnswers} />
        {/* Say why the button is dead, for the same reason the vault password
            step does: a disabled control with no explanation reads as broken. */}
        {allFilled && !correct ? (
          <p className="mt-3 text-xs text-destructive" data-testid="recovery-verify-error">
            {recoveryCode ? VERIFY_COPY.mismatch : VERIFY_COPY.missing}
          </p>
        ) : null}
      </StepShell>
    );
  }

  return (
    <StepShell
      {...props}
      onNext={staged ? enterVerify : props.onNext}
      title={copy.headline}
      nextLabel={copy.cta}
      nextDisabled={!confirmed}
      hideBack
    >
      <p>{copy.body}</p>
      <RecoveryCodeSlots recoveryCode={recoveryCode} />
      <p className="mt-4 text-sm">{copy.instruction}</p>
      <label className="mt-4 flex cursor-pointer items-start gap-2 text-sm">
        <Checkbox
          checked={confirmed}
          onCheckedChange={(value) => setConfirmed(value === true)}
          className="mt-0.5"
        />
        <span>I have written down all {RECOVERY_WORD_COUNT} words.</span>
      </label>
    </StepShell>
  );
}

// Only mounted when RECOVERY_VERIFY_MODE is "reentry", the reading that makes
// the flow 8 steps.
export function StepVerify(props: OnboardingStepProps) {
  // Same check as the staged stage above, via the same shared function, so the
  // two readings of the flow cannot diverge on what counts as a pass.
  //
  // Still open and deliberately NOT decided here: the spec adds a loop back to
  // the recovery screen with a regenerated code after a failure, plus a 5
  // second cooldown after three. v1 does not regenerate, and regenerating after
  // someone has written 12 words on paper is the more hostile of the two
  // behaviours. That needs settling before this branch is ever the default; it
  // is a question about what happens after a failure, not about whether a
  // failure is detected, which is what this change fixes.
  const { recoveryCode } = useOnboardingState();
  const [positions] = useState(pickVerifyPositions);
  const [answers, setAnswers] = useState<string[]>(() =>
    Array.from({ length: VERIFY_WORD_COUNT }, () => ''),
  );
  const allFilled = answers.every((answer) => answer.trim().length > 0);
  const correct = verifyRecoveryWords(recoveryCode, positions, answers);

  return (
    <StepShell
      {...props}
      title={VERIFY_COPY.headline}
      nextLabel={VERIFY_COPY.cta}
      nextDisabled={!correct}
      hideBack
    >
      <p>{VERIFY_COPY.body}</p>
      <RecoveryWordInputs positions={positions} answers={answers} onChange={setAnswers} />
      {allFilled && !correct ? (
        <p className="mt-3 text-xs text-destructive" data-testid="recovery-verify-error">
          {recoveryCode ? VERIFY_COPY.mismatch : VERIFY_COPY.missing}
        </p>
      ) : null}
    </StepShell>
  );
}

export function StepSuccess(props: OnboardingStepProps) {
  // "I'll do this later" opens an empty dashboard. onSecondary defaults to
  // onNext, and this is the last step, so it completes the wizard either way.
  // Per spec: acceptable, the aha moment was offered. Do not block on it.
  return (
    <StepShell
      {...props}
      title={SUCCESS_COPY.headline}
      nextLabel={SUCCESS_COPY.cta}
      secondaryLabel={SUCCESS_COPY.secondary}
      hideBack
    >
      <p>{SUCCESS_COPY.body}</p>
    </StepShell>
  );
}
