import { useState } from 'react';
import OnboardingWizard from '@/components/onboarding/OnboardingWizard';
import { OnboardingFlow } from './onboarding-flow';
import { ONBOARDING_STEPS } from './step-registry';
import { OnboardingV2Context } from './onboarding-context';

/**
 * v2 entry point (DL-0429), behind VITE_ONBOARDING_V2.
 *
 * Props are deliberately identical to v1's OnboardingWizard so the switch in
 * App.tsx is a single expression and either wizard can be dropped in without
 * touching the caller.
 *
 * v2 owns account creation: email collection, OTP verification, and the
 * trust-moment education screen. After education completes, it hands off to
 * v1 OnboardingWizard, which owns the vault password, recovery code,
 * biometric, and success screens unchanged.
 *
 * The _inheritedUserId prop is passed by App.tsx from the already-loaded
 * Supabase session. v2 ignores it: the email + OTP steps create the session
 * themselves and the userId they produce is what v1 needs. The prop is kept
 * in the interface for drop-in interchangeability; App.tsx passes it without
 * knowing which wizard is active.
 *
 * VITE_ONBOARDING_V2 stays off until the remaining architectural gap is
 * closed: v2 currently runs inside AuthGate (which requires a pre-existing
 * session), but account creation via OTP happens before a session exists.
 * The routing change that resolves this is tracked in step-registry.ts.
 */
interface OnboardingWizardV2Props {
  userId: string;
  onComplete: () => void;
}

export default function OnboardingWizardV2({
  userId: _inheritedUserId,
  onComplete,
}: OnboardingWizardV2Props) {
  const [email, setEmail] = useState('');
  const [verifiedUserId, setVerifiedUserId] = useState('');
  const [v1Ready, setV1Ready] = useState(false);

  if (v1Ready) {
    // Hand off: v1 creates the org, encrypts the org name, upserts the
    // org_members OWNER row, writes org_settings, and seeds the chart of
    // accounts. All of that stays in v1's handleFinish unchanged.
    return <OnboardingWizard userId={verifiedUserId} onComplete={onComplete} />;
  }

  return (
    <OnboardingV2Context.Provider
      value={{ email, setEmail, userId: verifiedUserId, setUserId: setVerifiedUserId }}
    >
      <OnboardingFlow steps={ONBOARDING_STEPS} onComplete={() => setV1Ready(true)} />
    </OnboardingV2Context.Provider>
  );
}
