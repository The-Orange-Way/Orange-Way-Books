import { useState } from 'react';
import { OnboardingFlow } from './onboarding-flow';
import type { OnboardingResult } from './onboarding-flow';
import type { OnboardingVaultSetup } from './onboarding-state';
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
 * organization and the org_members OWNER row on finish (v1 parity). It is
 * optional because this wizard now has two callers with two different moments
 * at which that id exists:
 *
 * - Mounted after sign in, the caller already holds a session and passes the
 *   id down, exactly as v1 does.
 * - Mounted as the signup front door, nobody is signed in yet, so there is no
 *   id to pass. The email step creates the account and records the id in the
 *   flow's own state as soon as the code is confirmed, and it arrives here on
 *   the completion result. That happens at step two of seven, well before the
 *   only consumer needs it.
 *
 * The prop wins when it is present, so the post-auth path is unchanged: it
 * keeps using the id from its session rather than one derived mid-flow.
 *
 * vaultSetup is threaded the same way, and it is worth being precise about
 * what that does and does not expose. It is the five persistable fields the
 * vault returns: a verifier, a public salt, a key version, and two wrapped-MEK
 * ciphertexts. It is not the MEK, not the password, and not the recovery code.
 * All five are written to org_settings verbatim in v1 and are useless without
 * the password or the recovery code, so passing them down a prop does not
 * widen what any code here can read. Encryption of the org's own fields still
 * happens inside OrgSetupSurface via encryptText from VaultContext, and no key
 * material crosses this boundary.
 */
interface OnboardingWizardV2Props {
  userId?: string;
  onComplete: () => void;
}

export default function OnboardingWizardV2({ userId, onComplete }: OnboardingWizardV2Props) {
  // Two phases: the shared 7-step wizard, then the organization setup surface.
  // The surface renders AFTER success rather than as an extra wizard step so
  // the step count stays identical to the sibling app (step-registry option 1).
  const [phase, setPhase] = useState<'wizard' | 'org-setup'>('wizard');

  // The wizard creates the vault; the org row it belongs to does not exist
  // until the next phase. So the material has to be carried across the
  // boundary, and this state is that carry. Held in memory only, for the few
  // seconds between the two phases, and dropped when the component unmounts.
  const [vaultSetup, setVaultSetup] = useState<OnboardingVaultSetup | null>(null);

  // Whose account this is. Seeded from the prop when the caller already knew,
  // and otherwise filled in from the wizard's own result.
  const [resolvedUserId, setResolvedUserId] = useState<string | null>(userId ?? null);

  const handleWizardComplete = (result: OnboardingResult) => {
    setVaultSetup(result.vaultSetup);
    setResolvedUserId(userId ?? result.userId);
    setPhase('org-setup');
  };

  if (phase === 'wizard') {
    return <OnboardingFlow steps={ONBOARDING_STEPS} onComplete={handleWizardComplete} />;
  }

  if (!resolvedUserId) {
    // Unreachable on either mount: the caller passes an id, or the email step
    // records one before the flow can reach its last step. It is a visible
    // refusal rather than a cast because the alternative is handing a surface
    // that writes an org and an OWNER row an id it cannot trust. Refusing here
    // costs a retry; guessing there writes rows against the wrong account.
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-6">
        <p className="text-sm text-destructive text-center max-w-sm">
          We could not confirm which account this setup belongs to. Please sign in and try again.
        </p>
      </div>
    );
  }

  return (
    <OrgSetupSurface userId={resolvedUserId} vaultSetup={vaultSetup} onComplete={onComplete} />
  );
}
