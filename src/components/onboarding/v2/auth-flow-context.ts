/**
 * Auth-flow shared state for the v2 onboarding three-step entry (DL-0429).
 *
 * The steps [email, otp, education] need to pass two pieces of state that
 * OnboardingFlow has no built-in channel for:
 *
 *   email         StepEmail collects and owns it; StepVerifyOtp reads it
 *                 so it can show the user which address received the code.
 *
 *   onOtpVerified StepVerifyOtp calls this after verifyOtp resolves with a
 *                 real user. OnboardingWizardV2 stores the userId and uses
 *                 it for the v1 handoff (OnboardingWizard expects userId).
 *
 * Mounted only inside OnboardingWizardV2. If the step interface gains a typed
 * data channel in a later DL, this file goes away and nothing else changes.
 */
import { createContext, useContext } from 'react';

export interface AuthFlowState {
  email: string;
  setEmail: (email: string) => void;
  onOtpVerified: (userId: string) => void;
}

export const AuthFlowContext = createContext<AuthFlowState | null>(null);

export function useAuthFlow(): AuthFlowState {
  const ctx = useContext(AuthFlowContext);
  if (!ctx) {
    throw new Error(
      'useAuthFlow must be called inside AuthFlowContext.Provider (OnboardingWizardV2)',
    );
  }
  return ctx;
}
