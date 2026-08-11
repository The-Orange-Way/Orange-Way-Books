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
 * userId is threaded into OrgSetupSurface, which uses it to create the
 * organization and the org_members OWNER row on finish (v1 parity). No key
 * material crosses this boundary: only userId is passed down; encryption stays
 * inside OrgSetupSurface via encryptText from VaultContext.
 */
interface OnboardingWizardV2Props {
  userId: string;
  onComplete: () => void;
}

export default function OnboardingWizardV2({ userId, onComplete }: OnboardingWizardV2Props) {
  // Two phases: the shared 7-step wizard, then the organization setup surface.
  // The surface renders AFTER success rather than as an extra wizard step so
  // the step count stays identical to the sibling app (step-registry option 1).
  const [phase, setPhase] = useState<'wizard' | 'org-setup'>('wizard');

  if (phase === 'wizard') {
    return <OnboardingFlow steps={ONBOARDING_STEPS} onComplete={() => setPhase('org-setup')} />;
  }

  // Slice 3 (DL-0718): OrgSetupSurface now creates the org with an encrypted
  // name, upserts the org_members OWNER row, writes client-encrypted
  // org_settings and seeds the chart of accounts via initChartOfAccounts, all
  // mirroring v1's finish path. Vault verifier persistence (v1 step 4) and the
  // calendar/reporting screens are later slices. VITE_ONBOARDING_V2 stays off
  // until the recovery-code display gap is closed and verified.
  return <OrgSetupSurface userId={userId} onComplete={onComplete} />;
}
