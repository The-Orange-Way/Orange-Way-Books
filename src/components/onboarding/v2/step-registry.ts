import type { OnboardingStep } from './onboarding-flow';
import type { RecoveryVerifyMode } from './step-helpers';
import { RECOVERY_VERIFY_MODE } from './step-helpers';
import {
  StepBiometric,
  StepEducation,
  StepEmail,
  StepName,
  StepRecovery,
  StepSuccess,
  StepVaultPassword,
  StepVerify,
  StepVerifyOtpBridge,
} from './steps';

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
 * decision is not yet load-bearing, but it blocks the flag ever going on.
 */
export function buildOnboardingSteps(mode: RecoveryVerifyMode): OnboardingStep[] {
  return [
    { id: 'name', title: 'Name', Component: StepName },
    { id: 'email', title: 'Email', Component: StepEmail },
    { id: 'otp', title: 'Enter your code', Component: StepVerifyOtpBridge },
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
