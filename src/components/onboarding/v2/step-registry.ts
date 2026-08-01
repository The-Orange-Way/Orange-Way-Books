import type { OnboardingStep } from './onboarding-flow';
import { StepEmail, StepEducation, StepVerifyOtp } from './steps';

/**
 * §4.1 (DL-0429): v2 owns account creation only.
 *
 * Three steps take the user from "no account" to "verified email and
 * introduced to the product". After StepEducation fires onNext,
 * OnboardingWizardV2 hands off to v1's OnboardingWizard with the
 * verified userId + onComplete. createVault stays in v1's handleFinish.
 *
 * The full 8-step flow (name, email, education, vault-password, recovery,
 * biometric, success) is deferred, not removed. Every step still exists as
 * a TODO in steps.tsx. It moves here once the org-setup question is
 * settled: where do StepOrganization, StepReporting, and StepCalendar live
 * in v2? Three candidates, in the order I would argue for them:
 *
 *   1. Post-onboarding setup surface after success (keeps 7 steps identical
 *      across both apps, aha moment arrives early).
 *   2. Folded into the success step (DL-0414 says this step diverges per
 *      product, so it has a home here anyway).
 *   3. Extra steps inside the wizard (breaks the shared step count, not
 *      worth taking without a decision).
 *
 * Not choosing here. This PR is dark-shipped (VITE_ONBOARDING_V2 off) and
 * does not remove v1, so the decision is not yet load-bearing.
 */
export const ONBOARDING_STEPS: OnboardingStep[] = [
  { id: 'email', title: 'Email', Component: StepEmail },
  { id: 'otp', title: 'Verify email', Component: StepVerifyOtp },
  { id: 'education', title: 'How Orange Way works', Component: StepEducation },
];
