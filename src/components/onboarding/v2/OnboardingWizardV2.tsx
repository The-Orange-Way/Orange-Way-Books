import { useState } from 'react';
import { OnboardingFlow } from './onboarding-flow';
import { ONBOARDING_STEPS } from './step-registry';
import OrgSetupSurface from './OrgSetupSurface';

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
  // Two phases: the shared 7-step wizard, then the organization setup surface.
  // The surface renders AFTER success rather than as an extra wizard step so
  // the step count stays identical to the sibling app (step-registry option 1).
  const [phase, setPhase] = useState<'wizard' | 'org-setup'>('wizard');

  if (phase === 'wizard') {
    return <OnboardingFlow steps={ONBOARDING_STEPS} onComplete={() => setPhase('org-setup')} />;
  }

  // TODO(DL-0414 / later slices): this surface collects the organization name
  // only. The real work v1 does on finish, creating the org with an encrypted
  // name, upserting the org_members OWNER row, writing org_settings and seeding
  // the chart of accounts via initChartOfAccounts, lands in later slices gated
  // on the vault-precondition work. Until then onComplete only marks onboarding
  // done and this flag cannot go on.
  return <OrgSetupSurface onComplete={onComplete} />;
}
