import { OnboardingFlow } from './onboarding-flow';
import { ONBOARDING_STEPS } from './step-registry';

/**
 * v2 entry point (DL-0429), behind VITE_ONBOARDING_V2.
 *
 * Props are deliberately identical to v1's OnboardingWizard so the switch in
 * App.tsx is a single expression and either wizard can be dropped in without
 * touching the caller.
 *
 * userId is accepted and currently unused. It is what v1 needs to create the
 * organization and the org_members row on finish; v2 will need it for the same
 * reason once DL-0414 wires the real vault creation, and taking it now keeps
 * the two signatures interchangeable rather than making the switch site
 * conditional.
 */
interface OnboardingWizardV2Props {
  userId: string;
  onComplete: () => void;
}

export default function OnboardingWizardV2({ onComplete }: OnboardingWizardV2Props) {
  // TODO(DL-0414): onComplete currently just marks onboarding done. v1 does the
  // real work here: creates the org with an encrypted name, upserts the
  // org_members OWNER row, writes org_settings and seeds the chart of accounts
  // via initChartOfAccounts. None of that has a home in v2 yet; see the note on
  // buildOnboardingSteps in step-registry.ts. This flag cannot go on until it does.
  return <OnboardingFlow steps={ONBOARDING_STEPS} onComplete={onComplete} />;
}
