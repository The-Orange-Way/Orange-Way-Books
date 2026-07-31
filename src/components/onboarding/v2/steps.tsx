import { useEffect, useState } from 'react';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { StepShell } from './onboarding-flow';
import type { OnboardingStep, OnboardingStepProps } from './onboarding-flow';

/**
 * Screen copy below is VERBATIM from the locked specification:
 *
 *   "7-step onboarding flow specification" (covers both apps, design twins)
 *   Copy locked 2026-07-30. Spec locked 2026-07-31.
 *   Wiki doc id 13aecb24-1275-4f87-a986-a3cd6b299bdb
 *
 * CX owns this text. Do not reword it here. If a string has to change, change
 * the wiki first and port it down, so the two apps stay design twins.
 *
 * Hoisted into one object on purpose: it can be diffed against the wiki in a
 * single block, and against the sibling app's identically-shaped object.
 *
 * This file is presentation only. Argon2id derivation, BIP-39 generation and
 * WebAuthn PRF wrapping are DL-0414's lane. Note that unlike the sibling app,
 * most of that already exists here in src/lib/vault.ts and in the v1 wizard —
 * this flow does not re-implement it, it will call it. Every seam is marked
 * TODO(DL-0414).
 */
export const ONBOARDING_COPY = {
  name: {
    headline: 'What should we call you?',
    body: 'Optional. Skip it if you like, just a friendly touch.',
    cta: 'Continue',
    secondary: 'Skip',
  },
  email: {
    headline: "What's your email address?",
    body: "We'll send a one-time link to confirm it's you. No password yet.",
    cta: 'Send my link',
  },
  education: {
    headline: 'Your money stays yours.',
    body: 'Orange Way is built so we can never see your balance, your keys, or your transactions. Not us. Not anyone. It lives on your device.',
    cta: 'Got it',
  },
  vaultPassword: {
    headline: 'Create your vault password.',
    body: 'This unlocks everything in Orange Way. We can never reset it for you. That is what the next step is for.',
    cta: 'Set my password',
  },
  recovery: {
    headline: 'Save your recovery code.',
    body: 'Write this somewhere safe, away from this device.',
    instruction: 'This is the only way to add another phone or tablet. We do not store a copy.',
    cta: "I've written it down",
  },
  biometric: {
    headline: 'Enable Face ID / fingerprint on this device.',
    body: 'This replaces your vault password for everyday unlocking, faster and just as secure.',
    cta: 'Enable',
    secondary: "I'll do this later",
  },
  biometricFallback: {
    headline: "Your device doesn't support this yet.",
    body: 'You can still use your vault password to open Orange Way.',
    cta: 'Continue',
  },
} as const;

/**
 * COPY NOT LOCKED — and unlike the rest of this file, it cannot be, because the
 * locked success copy is written for the sibling app: "Connect your Bitcoin
 * wallet to see your balance." There is no wallet to connect here.
 *
 * DL-0414 is explicit that this step differs between the two products. Its
 * Step 8 row reads "OWB welcome + first journal entry" against the sibling's
 * "Connect wallet / import data", and its rules section says to replace
 * wallet-connect with a welcome and first data entry. So this is the one screen
 * where the twins are supposed to diverge, and the divergence is specified.
 *
 * What is NOT specified is the wording. CX has not written it. The strings
 * below are mine, written to the shape DL-0414 describes, and they need CX
 * sign-off before this ships to anyone.
 */
const SUCCESS_COPY = {
  headline: "You're all set.",
  body: 'Your books are encrypted and ready. Make your first journal entry to see them come alive.',
  cta: 'Make my first entry',
  secondary: "I'll do this later",
};

/**
 * COPY NOT LOCKED, and this one is on the default path, so it is the shortest
 * open item in the whole flow. CX has never written copy for the recovery
 * verification screen; it appears in DL-0414 only as a mechanism.
 *
 * Unlike the sibling app, this repo already ships wording for exactly this
 * screen — see StepVaultPassword, "Prove you saved it" over "Type the words at
 * the positions below from your saved copy. This protects you from a future
 * lockout." That text has been in front of real users. It is reproduced here so
 * v2 does not quietly regress copy that v1 already got right, and so CX is
 * reviewing a diff against something real rather than approving from scratch.
 */
const VERIFY_COPY = {
  headline: 'Prove you saved it',
  body: 'Type the words at the positions below from your saved copy. This protects you from a future lockout.',
  hint: 'Recovery code hidden during verification. Use the link below if you need to see it again.',
  cta: 'Confirm and continue',
  back: 'Back to code',
};

/**
 * 7 steps or 8 has been treated as a blocker for every screen numbered 5 and
 * above. It does not have to be one.
 *
 * The locked spec asks only this of Step 5: "Verification requires
 * confirmation via checkbox or re-entry pattern before CTA activates. No
 * bypass path." Both live readings satisfy that lock:
 *
 *   checkbox  The CX 7-step spec. "I've written it down" gates on a checkbox.
 *             Chosen to hold down dropout at the recovery-code screen.
 *   reentry   DL-0414. The parent types back 3 highlighted words on a screen
 *             of its own, which makes the flow 8 steps.
 *   staged    Both, as two stages of Step 5. Checkbox first, then type back
 *             3 words, with a way back to the code. Still 7 steps.
 *
 * "staged" is the default, and in this repo that is not a design choice at all
 * — it is what StepVaultPassword has been doing in production. v2 is copying
 * v1. The sibling app adopted the same pattern from here.
 *
 * The other two modes stay because they cost nothing to keep. Flipping this
 * constant is the whole change: no id changes, no copy rewrites, no
 * renumbering above step 4.
 */
export type RecoveryVerifyMode = 'staged' | 'checkbox' | 'reentry';

export const RECOVERY_VERIFY_MODE: RecoveryVerifyMode = 'staged';

const RECOVERY_GRID_CLASS =
  'mt-6 grid grid-cols-3 gap-x-4 gap-y-2 rounded-md border border-dashed border-input p-4 font-mono text-sm';

// MIN_VAULT_PASSWORD_LENGTH in src/lib/vault.ts, which enforces it in the
// crypto layer rather than only in the UI. Imported rather than restated once
// the wiring lands (TODO(DL-0414)); stated here so the skeleton cannot gate
// looser than the crypto will accept. Do not lower this.
const PASSWORD_MIN_LENGTH = 14;

const RECOVERY_WORD_COUNT = 12;

const VERIFY_WORD_COUNT = 3;

const STRENGTH_LABELS = ['Too short', 'Weak', 'Fair', 'Good', 'Strong', 'Strong'] as const;

function passwordScore(value: string) {
  let score = 0;
  if (value.length >= PASSWORD_MIN_LENGTH) score += 1;
  if (value.length >= 16) score += 1;
  if (/[a-z]/.test(value) && /[A-Z]/.test(value)) score += 1;
  if (/\d/.test(value)) score += 1;
  if (/[^\w\s]/.test(value)) score += 1;
  return score;
}

/**
 * Pick which words the parent has to type back.
 *
 * Random and CSPRNG-drawn, matching v1's StepVaultPassword rather than the
 * sibling app's fixed [3, 7, 11]. Fixed positions are predictable across every
 * account, which turns "prove you saved it" into "memorise three slots" for
 * anyone who has seen the flow once. Cheap to do right, so do it right.
 */
function pickVerifyPositions() {
  const positions: number[] = [];
  while (positions.length < VERIFY_WORD_COUNT) {
    const buf = new Uint32Array(1);
    window.crypto.getRandomValues(buf);
    const pos = buf[0] % RECOVERY_WORD_COUNT;
    if (!positions.includes(pos)) positions.push(pos);
  }
  return positions.sort((a, b) => a - b);
}

/**
 * Capability probe for Step 6. The user never chooses between biometric and
 * password mode; the device decides which screen renders.
 *
 * TODO(DL-0414): a platform authenticator is necessary but not sufficient for
 * PRF. The real probe creates a credential and reads the prf extension
 * result. Until that exists this is the documented proxy, and it can only
 * over-offer, never dead-end, because the fallback stays reachable.
 */
function useHasPlatformAuthenticator() {
  const [available, setAvailable] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;

    if (typeof window === 'undefined' || !window.PublicKeyCredential) {
      setAvailable(false);
      return;
    }

    window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()
      .then((result) => {
        if (!cancelled) setAvailable(result);
      })
      .catch(() => {
        if (!cancelled) setAvailable(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return available;
}

function StepName(props: OnboardingStepProps) {
  // TODO(DL-0414): lift to flow state. The name is written to the profile row
  // after the OTP round trip, not from here.
  const [name, setName] = useState('');
  const copy = ONBOARDING_COPY.name;

  return (
    <StepShell {...props} title={copy.headline} nextLabel={copy.cta} secondaryLabel={copy.secondary}>
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

function StepEmail(props: OnboardingStepProps) {
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
function StepEducation(props: OnboardingStepProps) {
  const copy = ONBOARDING_COPY.education;

  return (
    <StepShell {...props} title={copy.headline} nextLabel={copy.cta}>
      <p>{copy.body}</p>
    </StepShell>
  );
}

function StepVaultPassword(props: OnboardingStepProps) {
  // TODO(DL-0414): this password never leaves the device. It is the input to
  // Argon2id (64 MiB, 3 iterations, parallelism 4, client-generated CSPRNG
  // salt) and the derived KEK wraps the MEK. All of that already exists in
  // src/lib/vault.ts — wire this to createVault rather than re-deriving here.
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

function StepRecovery(props: OnboardingStepProps) {
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
function StepVerify(props: OnboardingStepProps) {
  // TODO(DL-0414): compare against the code generated in StepRecovery. v1
  // already does exactly this in StepVaultPassword, matching the words case
  // insensitively against the real code; reuse that check rather than writing
  // a second one. The spec adds a loop back to the recovery screen with a
  // regenerated code on failure and a 5 second cooldown after 3 failures —
  // note that v1 does NOT regenerate, and regenerating after someone has
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

function StepBiometric(props: OnboardingStepProps) {
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
    <StepShell {...props} title={copy.headline} nextLabel={copy.cta} secondaryLabel={copy.secondary}>
      <p>{copy.body}</p>
    </StepShell>
  );
}

function StepSuccess(props: OnboardingStepProps) {
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

/**
 * The step ids are the integration contract between the two apps. They are
 * identical to the sibling app's, deliberately and to the character. Renaming
 * one here without renaming it there is how design twins stop being twins.
 *
 * OPEN, and it is this repo's only real gap in the contract: v1 also collects
 * the organization, reporting preferences and fiscal calendar (StepOrganization,
 * StepReporting, StepCalendar), and creates the org and chart of accounts on
 * finish. None of that appears in the locked 7 steps, which were written for a
 * consumer app that has no organization. It has to land somewhere before v2 can
 * replace v1 for real. Three candidates, in the order I would argue for them:
 *
 *   1. After success, as a separate post-onboarding setup surface. Keeps the 7
 *      steps identical across both apps and keeps the aha moment early.
 *   2. Folded into the success step, since DL-0414 already says this step
 *      differs per product.
 *   3. As extra steps inside the wizard, which breaks the shared step count
 *      and is the one option I would not take without a decision.
 *
 * Not choosing here. This PR is dark-shipped and does not remove v1, so the
 * decision is not yet load-bearing — but it blocks the flag ever going on.
 */
export function buildOnboardingSteps(mode: RecoveryVerifyMode): OnboardingStep[] {
  return [
    { id: 'name', title: 'Name', Component: StepName },
    { id: 'email', title: 'Email', Component: StepEmail },
    { id: 'education', title: 'How Orange Way works', Component: StepEducation },
    { id: 'vault-password', title: 'Vault password', Component: StepVaultPassword },
    { id: 'recovery-code', title: 'Recovery code', Component: StepRecovery },
    ...(mode === 'reentry'
      ? [{ id: 'verify-recovery-code', title: 'Confirm recovery code', Component: StepVerify }]
      : []),
    { id: 'biometric', title: 'Biometric unlock', Component: StepBiometric },
    { id: 'success', title: 'You are all set', Component: StepSuccess },
  ];
}

export const ONBOARDING_STEPS: OnboardingStep[] = buildOnboardingSteps(RECOVERY_VERIFY_MODE);
