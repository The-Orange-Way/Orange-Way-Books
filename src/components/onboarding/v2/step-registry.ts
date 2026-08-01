import type { OnboardingStep } from './onboarding-flow';
import { StepEmail, StepVerifyOtp, StepEducation } from './steps';

/**
 * v2 account-creation steps for DL-0429.
 *
 * v2 owns three steps: collect email, verify the 6-digit OTP, and the
 * trust-moment education screen. After education, OnboardingWizardV2 hands
 * off to v1 OnboardingWizard for the vault password, recovery code,
 * biometric, and success screens.
 *
 * The step ids are the integration contract between the two apps. They are
 * identical to the sibling app's, deliberately and to the character. Renaming
 * one here without renaming it there is how design twins stop being twins.
 *
 * OPEN (load-bearing blocker for VITE_ONBOARDING_V2 going on):
 *
 *   v2 is rendered inside AuthGate, which requires a pre-existing Supabase
 *   session. But the email + OTP steps CREATE the session. The flag cannot
 *   go on until one of these is resolved:
 *
 *     A. A new route outside AuthGate renders OnboardingWizardV2 for
 *        unauthenticated users, and /signup redirects to it when
 *        VITE_ONBOARDING_V2 is on.
 *     B. AuthGate is modified to render the v2 wizard without a session
 *        when the flag is on, trusting that OTP verification will produce
 *        one before the v1 hand-off.
 *
 *   Option A is cleaner (Auth gate stays unchanged) and is the default
 *   recommendation. Not choosing here; leaving it for the routing PR that
 *   turns the flag on.
 */
export const ONBOARDING_STEPS: OnboardingStep[] = [
  { id: 'email', title: 'Email', Component: StepEmail },
  { id: 'otp', title: 'Verify email', Component: StepVerifyOtp },
  { id: 'education', title: 'How Orange Way works', Component: StepEducation },
];
