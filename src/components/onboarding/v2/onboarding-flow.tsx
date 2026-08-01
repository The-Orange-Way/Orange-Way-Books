import { useMemo, useState } from 'react';
import type { ComponentType, ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { OnboardingStateContext } from './onboarding-state';
import type { OnboardingStateValue } from './onboarding-state';

/**
 * Feature flag for the v2 typeform-style onboarding (DL-0429).
 *
 * Off by default. Enable per environment with VITE_ONBOARDING_V2="true".
 *
 * This flag matters more here than it does in the sibling app. There, v2 is a
 * dark route nobody reaches. Here it stands in front of OnboardingWizard, which
 * is live and carries real crypto: it creates the org, encrypts the org name,
 * sets up the vault and seeds the chart of accounts. Anything other than the
 * exact string "true" leaves every user on v1.
 */
export const ONBOARDING_V2_ENABLED = import.meta.env.VITE_ONBOARDING_V2 === 'true';

export interface OnboardingStepProps {
  onNext: () => void;
  onBack: () => void;
  isFirst: boolean;
  isLast: boolean;
}

export interface OnboardingStep {
  id: string;
  title: string;
  Component: ComponentType<OnboardingStepProps>;
}

/**
 * StepShell gives every step the same typeform frame: one question centered on
 * the viewport, a progress bar, and Back/Next controls. Steps render their own
 * body and never own navigation, so the container stays the single source of
 * truth for where the user is in the flow.
 *
 * Deliberately the same shape as the sibling app's StepShell (same props, same
 * gate semantics), so a change to the flow contract is one diff read twice, not
 * two designs that drift. The internals use this app's own primitives rather
 * than raw elements, because design twins means the same design, not the same
 * DOM.
 */
export function StepShell({
  title,
  children,
  onNext,
  onBack,
  isFirst,
  isLast,
  nextLabel,
  nextDisabled = false,
  secondaryLabel,
  onSecondary,
  hideBack = false,
  busy = false,
  busyLabel,
  error,
}: OnboardingStepProps & {
  title: string;
  children?: ReactNode;
  nextLabel?: string;
  nextDisabled?: boolean;
  secondaryLabel?: string;
  onSecondary?: () => void;
  hideBack?: boolean;
  /**
   * Set while a step is waiting on the network or on key derivation. Argon2id
   * at 64 MiB is not instant on a phone, so the button has to say something
   * during it, and it has to be un-pressable or a double tap creates two
   * vaults.
   */
  busy?: boolean;
  busyLabel?: string;
  /**
   * A failure the person can act on, shown in place of silence. Steps that
   * talk to Supabase or to the crypto layer must surface what went wrong here
   * rather than swallowing it, because a dead button with no message is the
   * one outcome nobody can debug from a screenshot.
   */
  error?: string | null;
}) {
  return (
    <div className="mx-auto flex min-h-[60vh] w-full max-w-xl flex-col justify-center px-6">
      <h1 className="text-3xl font-semibold tracking-tight md:text-4xl">{title}</h1>
      <div className="mt-6 min-h-[8rem] text-muted-foreground">{children}</div>
      {error ? (
        <p className="mt-4 text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      <div className="mt-10 flex items-center justify-between">
        {hideBack ? (
          <span aria-hidden="true" />
        ) : (
          <Button type="button" variant="ghost" onClick={onBack} disabled={isFirst || busy}>
            Back
          </Button>
        )}
        <Button
          type="button"
          onClick={onNext}
          disabled={nextDisabled || busy}
          aria-busy={busy}
        >
          {busy ? (busyLabel ?? 'Working...') : (nextLabel ?? (isLast ? 'Finish' : 'Continue'))}
        </Button>
      </div>
      {secondaryLabel ? (
        <div className="mt-4 flex justify-end">
          <Button
            type="button"
            variant="link"
            className="text-muted-foreground"
            onClick={onSecondary ?? onNext}
            disabled={busy}
          >
            {secondaryLabel}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * OnboardingFlow is the container/router for the whole flow. It walks the
 * ordered step registry, tracks the active index, and hands each step its
 * navigation callbacks. onComplete fires once the last step calls onNext.
 */
export function OnboardingFlow({
  steps,
  onComplete,
}: {
  steps: OnboardingStep[];
  onComplete: () => void;
}) {
  const [index, setIndex] = useState(0);

  // Lifted above steps so each step can read what was typed in a prior step,
  // and so the values survive the unmount that happens on every advance.
  // The container swaps the active Component out on each step change: anything
  // owned locally by the previous step is gone the moment the next one mounts.
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [emailVerified, setEmailVerified] = useState(false);
  const [vaultPassword, setVaultPassword] = useState('');
  const [recoveryCode, setRecoveryCode] = useState<string | null>(null);

  const state = useMemo<OnboardingStateValue>(
    () => ({
      name,
      email,
      emailVerified,
      vaultPassword,
      recoveryCode,
      setName,
      setEmail,
      setEmailVerified,
      setVaultPassword,
      setRecoveryCode,
    }),
    [name, email, emailVerified, vaultPassword, recoveryCode],
  );

  const total = steps.length;
  const active = steps[index];

  if (!active) {
    return null;
  }

  const isFirst = index === 0;
  const isLast = index === total - 1;

  const onNext = () => {
    if (isLast) {
      onComplete();
      return;
    }
    setIndex((current) => Math.min(current + 1, total - 1));
  };

  const onBack = () => {
    setIndex((current) => Math.max(current - 1, 0));
  };

  const percent = total > 0 ? Math.round(((index + 1) / total) * 100) : 0;
  const StepComponent = active.Component;

  return (
    <OnboardingStateContext.Provider value={state}>
      <div className="min-h-screen bg-background">
        <div className="h-1 w-full bg-muted">
          <div
            className="h-1 bg-primary transition-all"
            style={{ width: `${percent}%` }}
            role="progressbar"
            aria-valuenow={percent}
            aria-valuemin={0}
            aria-valuemax={100}
          />
        </div>
        <StepComponent onNext={onNext} onBack={onBack} isFirst={isFirst} isLast={isLast} />
      </div>
    </OnboardingStateContext.Provider>
  );
}
