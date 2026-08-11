import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { StepShell } from './onboarding-flow';

/**
 * Post-onboarding organization setup surface (DL-0718, DEC-0280/0281/0282).
 *
 * Renders after the shared 7-step wizard reaches success, and deliberately NOT
 * as an extra step inside buildOnboardingSteps. step-registry.ts names three
 * places the organization work could land; this is option 1, chosen so the 7
 * steps stay identical to the sibling app and the aha moment stays early.
 *
 * This first slice is screen 1 only: the organization name. The validation rule
 * and the copy are lifted from v1's StepOrganization so both flows ask the same
 * question the same way, and it reuses the v2 StepShell frame rather than a
 * second one.
 *
 * No currency screen, no vault or org creation, no schema change, and no v1
 * path is touched. The real org + chart-of-accounts creation that v1 does on
 * finish is a later slice, gated on the vault-precondition work, so this stays
 * dark behind VITE_ONBOARDING_V2 with the rest of v2.
 */
interface OrgSetupSurfaceProps {
  onComplete: () => void;
}

export default function OrgSetupSurface({ onComplete }: OrgSetupSurfaceProps) {
  const [name, setName] = useState('');

  // Same rule as v1 StepOrganization: a name is present once it is non-blank.
  const isValid = name.trim().length > 0;

  return (
    <div className="min-h-screen bg-background">
      <StepShell
        title="Your organization"
        onNext={onComplete}
        onBack={() => {}}
        isFirst
        isLast
        hideBack
        nextLabel="Finish setup"
        nextDisabled={!isValid}
      >
        <p className="mb-6">
          Name your company or entity. You can change this later in Admin settings.
        </p>
        <div className="space-y-2">
          <Label htmlFor="org-name">Organization Name</Label>
          <Input
            id="org-name"
            placeholder="e.g. Satoshi Holdings Ltd"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
        </div>
      </StepShell>
    </div>
  );
}
