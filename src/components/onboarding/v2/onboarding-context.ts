import { createContext, useContext } from 'react';

/**
 * Shared mutable state for the v2 onboarding account-creation steps (DL-0429).
 *
 * OnboardingWizardV2 provides this context so two steps can share state
 * without importing each other:
 *
 *   StepEmail  writes email (consumed by StepVerifyOtp to call verifyOtp)
 *   StepVerifyOtp  writes userId (consumed by the wizard on v1 hand-off)
 *
 * Lives in its own module to keep the dependency graph acyclic: both
 * OnboardingWizardV2.tsx and steps.tsx import from here, and neither
 * imports the other.
 */
export interface OnboardingV2State {
  /** Email typed on the email step, passed to verifyOtp on the OTP step. */
  email: string;
  setEmail: (email: string) => void;
  /**
   * Supabase user id returned by verifyOtp. Empty string until the OTP step
   * succeeds. The wizard reads this when handing off to v1 OnboardingWizard.
   */
  userId: string;
  setUserId: (id: string) => void;
}

export const OnboardingV2Context = createContext<OnboardingV2State>({
  email: '',
  setEmail: () => {},
  userId: '',
  setUserId: () => {},
});

export function useOnboardingV2(): OnboardingV2State {
  return useContext(OnboardingV2Context);
}
