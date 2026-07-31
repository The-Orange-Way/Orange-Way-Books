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
import { useState } from 'react';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { StepShell } from './onboarding-flow';
import type { OnboardingStepProps } from './onboarding-flow';
import { ONBOARDING_COPY, SUCCESS_COPY, VERIFY_COPY } from './onboarding-copy';
import {
  PASSWORD_MIN_LENGTH,
  RECOVERY_GRID_CLASS,
  RECOVERY_VERIFY_MODE,
  RECOVERY_WORD_COUNT,
  VERIFY_WORD_COUNT,
  STRENGTH_LABELS,
  passwordScore,
  pickVerifyPositions,
  useHasPlatformAuthenticator,
} from './step-helpers';

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

export function StepEmail(props: OnboardingStepProps) {
  // TODO(DL-0414): the CTA sends the one-time link. Advancing is gated on that
  // round trip, not on the field merely looking well formed.
  const [email, setEmail] = useState('');
  const copy = ONBOARDING_COPY.email;
  const looksLikeEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());

  return (
    <StepShell {...props} title={copy.headline} nextLabel={copy.cta} nextDisabled={!looksLikeEmail}>
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
  // TODO(DL-0414): this password never leaves the device. It is the input to
  // Argon2id (64 MiB, 3 iterations, parallelism 4, client-generated CSPRNG
  // salt) and the derived KEK wraps the MEK. All of that already exists in
  // src/lib/vault.ts: wire this to createVault rather than re-deriving here.
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const copy = ONBOARDING_COPY.vaultPassword;
  const score = passwordScore(password);
  const matches = password.length > 0 && password === confirm;
  const strongEnough = password.length >= PASSWORD_MIN_LENGTH && score >= 3;

  return (
    <StepShell
      {...props}
      title={copy.headline}
      nextLabel={copy.cta}
      nextDisabled={!strongEnough || !matches}
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
      <Input
        type="password"
        value={confirm}
        onChange={(event) => setConfirm(event.target.value)}
        autoComplete="new-password"
        placeholder="Confirm vault password"
        aria-label="Confirm vault password"
        className="mt-3"
      />
      <p className="mt-3 text-sm" aria-live="polite">
        Strength: {STRENGTH_LABELS[score]}
        {password.length > 0 && !matches ? ' (passwords do not match yet)' : ''}
      </p>
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

// TODO(DL-0414): the 12 words come from generateRecoveryCode() in
// src/lib/vault.ts, on this device. Rendering blank slots is deliberate.
// Faking plausible words would invite someone to treat a placeholder as a real
// code.
function RecoveryCodeSlots() {
  return (
    <ol className={RECOVERY_GRID_CLASS}>
      {Array.from({ length: RECOVERY_WORD_COUNT }, (_, index) => (
        <li key={index} className="flex items-center gap-2">
          <span className="w-4 text-right text-muted-foreground">{index + 1}</span>
          <span className="h-4 flex-1 rounded bg-muted" />
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
    const allFilled = answers.every((answer) => answer.trim().length > 0);
    return (
      <StepShell
        {...props}
        title={VERIFY_COPY.headline}
        nextLabel={VERIFY_COPY.cta}
        nextDisabled={!allFilled}
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
      <RecoveryCodeSlots />
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
  // TODO(DL-0414): compare against the code generated in StepRecovery. v1
  // already does exactly this in StepVaultPassword, matching the words case
  // insensitively against the real code; reuse that check rather than writing
  // a second one. The spec adds a loop back to the recovery screen with a
  // regenerated code on failure and a 5 second cooldown after 3 failures.
  // Note that v1 does NOT regenerate, and regenerating after someone has
  // written 12 words on paper is the more hostile of the two behaviours. Worth
  // settling before this branch is ever the default.
  const [positions] = useState(pickVerifyPositions);
  const [answers, setAnswers] = useState<string[]>(() =>
    Array.from({ length: VERIFY_WORD_COUNT }, () => ''),
  );
  const allFilled = answers.every((answer) => answer.trim().length > 0);

  return (
    <StepShell
      {...props}
      title={VERIFY_COPY.headline}
      nextLabel={VERIFY_COPY.cta}
      nextDisabled={!allFilled}
      hideBack
    >
      <p>{VERIFY_COPY.body}</p>
      <RecoveryWordInputs positions={positions} answers={answers} onChange={setAnswers} />
    </StepShell>
  );
}

export function StepBiometric(props: OnboardingStepProps) {
  const available = useHasPlatformAuthenticator();

  // Probe still running. Show the headline with the CTA held shut rather than
  // flashing the fallback copy at a device that does support this.
  if (available === null) {
    return <StepShell {...props} title={ONBOARDING_COPY.biometric.headline} nextDisabled />;
  }

  if (!available) {
    const fallback = ONBOARDING_COPY.biometricFallback;
    return (
      <StepShell {...props} title={fallback.headline} nextLabel={fallback.cta}>
        <p>{fallback.body}</p>
      </StepShell>
    );
  }

  const copy = ONBOARDING_COPY.biometric;
  return (
    <StepShell
      {...props}
      title={copy.headline}
      nextLabel={copy.cta}
      secondaryLabel={copy.secondary}
    >
      <p>{copy.body}</p>
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
