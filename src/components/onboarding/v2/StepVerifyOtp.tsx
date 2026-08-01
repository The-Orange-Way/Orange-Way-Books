/**
 * StepVerifyOtp -- OTP confirmation screen for v2 onboarding (DL-0429).
 *
 * The magic-link template has been replaced: the Supabase "Confirm signup"
 * and magic-link templates both carry {{ .Token }} only; {{ .ConfirmationURL }}
 * has been removed. A link-click would consume the OTP, leaving the code path
 * broken, so this is the only completion path.
 *
 * Flow:
 *   StepEmail: signInWithOtp({ shouldCreateUser: true })
 *   StepVerifyOtp (this file): verifyOtp({ email, token, type: "email" })
 *
 * Props: OnboardingStepProps plus `email`, which the step registry must
 * thread through from StepEmail's captured value. The seam is marked
 * TODO(DL-0414) matching the rest of the v2 skeleton; registry wiring
 * follows in a separate commit.
 */
import { useState } from 'react';
import { supabase } from '@/lib/supabase';
import { Input } from '@/components/ui/input';
import { StepShell } from './onboarding-flow';
import type { OnboardingStepProps } from './onboarding-flow';

// TODO(DL-0414): email is captured in StepEmail and must be threaded into this
// step via the flow state that the step registry builds. Until that wiring
// lands, nothing can reach this component with a real email.
export interface StepVerifyOtpProps extends OnboardingStepProps {
  email: string;
}

export function StepVerifyOtp({ email, ...props }: StepVerifyOtpProps) {
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirmCode = async () => {
    setBusy(true);
    setError(null);
    // type "email" is the code-in-the-body variant. "magiclink" is the
    // clickable-URL variant that the template no longer sends.
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
    props.onNext();
  };

  return (
    <StepShell
      {...props}
      onNext={() => void confirmCode()}
      // TODO(DL-0414): copy not locked for this screen. Flag to SP 1 before
      // this step goes on the default path; do not ship placeholder strings
      // to users.
      title="Enter the code we sent you."
      nextLabel={busy ? 'Checking...' : 'Confirm'}
      nextDisabled={busy || token.trim().length < 6}
      // Going back takes the user to StepEmail so they can re-enter or
      // correct their address. onBack is the standard registry callback.
      secondaryLabel="Use a different address"
      onSecondary={props.onBack}
      hideBack
    >
      {/* TODO(DL-0414): interpolate the masked email once email is in flow state */}
      <p>We sent a 6-digit code to your email address. It expires in a few minutes.</p>
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
      {error ? (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </StepShell>
  );
}
