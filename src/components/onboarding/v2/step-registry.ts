import type { OnboardingStep } from './onboarding-flow';
import type { RecoveryVerifyMode } from './step-helpers';
import { RECOVERY_VERIFY_MODE } from './step-helpers';
import {
  StepEducation,
  StepEmail,
  StepName,
  StepRecovery,
  StepSuccess,
  StepVaultPassword,
  StepVerify,
} from './steps';

/**
 * The step ids are the integration contract between the two apps. They are
 * identical to the sibling app's, deliberately and to the character. Renaming
 * one here without renaming it there is how design twins stop being twins.
 *
 * v1 also collects the organization, reporting preferences and fiscal calendar
 * (StepOrganization, StepReporting, StepCalendar), and creates the org and
 * chart of accounts on finish. None of that appears in the locked 7 steps,
 * which were written for a consumer app that has no organization. It has to
 * land somewhere before v2 can replace v1 for real.
 *
 * DEC-0280 chose where: after success, as a separate post-onboarding setup
 * surface, so the 7 steps stay identical across both apps and the aha moment
 * stays early. That surface is built: OrgSetupSurface.tsx (DL-0718), dark
 * behind VITE_ONBOARDING_V2. The org + chart-of-accounts creation that v1 does
 * on finish is a later slice, gated on the vault-precondition work (DL-0414).
 */
export function buildOnboardingSteps(mode: RecoveryVerifyMode): OnboardingStep[] {
  return [
    { id: 'name', title: 'Name', Component: StepName },
    { id: 'email', title: 'Email', Component: StepEmail },
    { id: 'education', title: 'How Orange Way works', Component: StepEducation },
    { id: 'vault-password', title: 'Vault password', Component: StepVaultPassword },
    { id: 'recovery-code', title: 'Recovery kit', Component: StepRecovery },
    ...(mode === 'reentry'
      ? [{ id: 'verify-recovery-code', title: 'Confirm recovery kit', Component: StepVerify }]
      : []),
    { id: 'success', title: 'You are all set', Component: StepSuccess },
  ];
}

export const ONBOARDING_STEPS: OnboardingStep[] = buildOnboardingSteps(RECOVERY_VERIFY_MODE);
