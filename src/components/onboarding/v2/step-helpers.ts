/**
 * The non-visual half of the v2 flow: the shape constants the screens are built
 * to, and the two probes they need. Nothing here renders anything.
 *
 * It lives apart from steps.tsx for a mechanical reason worth writing down,
 * because it is the only reason: a module that exports both components and
 * non-components cannot fast-refresh, and this repo lints for that
 * (react-refresh/only-export-components) against a warning budget that does not
 * move. Splitting is the honest fix; raising the budget would have been the
 * other one. The sibling app keeps all of this in one file and should follow
 * this split rather than the reverse.
 */
import { useEffect, useState } from 'react';

/**
 * 7 steps or 8 has been treated as a blocker for every screen numbered 5 and
 * above. It does not have to be one.
 *
 * The locked spec asks only this of Step 5: "Verification requires
 * confirmation via checkbox or re-entry pattern before CTA activates. No
 * bypass path." Both live readings satisfy that lock:
 *
 *   checkbox  The CX 7-step spec. "I've written it down" gates on a checkbox.
 *             Chosen to hold down dropout at the recovery-code screen.
 *   reentry   DL-0414. The parent types back 3 highlighted words on a screen
 *             of its own, which makes the flow 8 steps.
 *   staged    Both, as two stages of Step 5. Checkbox first, then type back
 *             3 words, with a way back to the code. Still 7 steps.
 *
 * "staged" is the default, and in this repo that is not a design choice at all:
 * it is what StepVaultPassword has been doing in production. v2 is copying
 * v1. The sibling app adopted the same pattern from here.
 *
 * The other two modes stay because they cost nothing to keep. Flipping this
 * constant is the whole change: no id changes, no copy rewrites, no
 * renumbering above step 4.
 */
import { MIN_VAULT_PASSWORD_LENGTH } from '@/lib/vault';

export type RecoveryVerifyMode = 'staged' | 'checkbox' | 'reentry';

export const RECOVERY_VERIFY_MODE: RecoveryVerifyMode = 'staged';

export const RECOVERY_GRID_CLASS =
  'mt-6 grid grid-cols-3 gap-x-4 gap-y-2 rounded-md border border-dashed border-input p-4 font-mono text-sm';

// Re-exported from src/lib/vault.ts, which enforces it in the crypto layer
// rather than only in the UI. It used to be restated here as a literal 14 with
// a TODO to import it once the wiring landed; the wiring has landed, and two
// copies of a security constant is exactly how a UI ends up gating looser than
// the crypto accepts. Do not lower this.
export const PASSWORD_MIN_LENGTH = MIN_VAULT_PASSWORD_LENGTH;

export const RECOVERY_WORD_COUNT = 12;

export const VERIFY_WORD_COUNT = 3;

// STRENGTH_LABELS and passwordScore used to live here: a six-point
// character-class heuristic (has an uppercase, has a digit, has a symbol) that
// the vault password step gated on at >= 3.
//
// Both are gone. The heuristic rewarded shape rather than entropy, so
// "Password123!" cleared it while a six-word diceware passphrase, which is
// orders of magnitude harder to guess, did not. It also scored on a different
// scale from v1's screen, which already used zxcvbn, so the two onboarding
// paths in this one app disagreed about what a strong password is and the v2
// path was the looser of the two.
//
// Scoring now lives in src/lib/password-strength.ts, shared and on one scale.

/**
 * Pick which words the parent has to type back.
 *
 * Random and CSPRNG-drawn, matching v1's StepVaultPassword rather than the
 * sibling app's fixed [3, 7, 11]. Fixed positions are predictable across every
 * account, which turns "prove you saved it" into "memorise three slots" for
 * anyone who has seen the flow once. Cheap to do right, so do it right.
 */
export function pickVerifyPositions() {
  const positions: number[] = [];
  while (positions.length < VERIFY_WORD_COUNT) {
    const buf = new Uint32Array(1);
    window.crypto.getRandomValues(buf);
    const pos = buf[0] % RECOVERY_WORD_COUNT;
    if (!positions.includes(pos)) positions.push(pos);
  }
  return positions.sort((a, b) => a - b);
}

/**
 * Capability probe for Step 6. The user never chooses between biometric and
 * password mode; the device decides which screen renders.
 *
 * TODO(DL-0414): a platform authenticator is necessary but not sufficient for
 * PRF. The real probe creates a credential and reads the prf extension
 * result. Until that exists this is the documented proxy, and it can only
 * over-offer, never dead-end, because the fallback stays reachable.
 */
export function useHasPlatformAuthenticator() {
  // Resolved before the first render rather than inside the effect. A device
  // with no WebAuthn at all is knowable synchronously, so answering it with a
  // setState in the effect body would mean rendering the "checking" state once
  // for nothing and then cascading a re-render, which is what
  // react-hooks/set-state-in-effect is there to catch.
  const supported = typeof window !== 'undefined' && Boolean(window.PublicKeyCredential);
  const [available, setAvailable] = useState<boolean | null>(supported ? null : false);

  useEffect(() => {
    if (!supported) return;

    let cancelled = false;

    window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()
      .then((result) => {
        if (!cancelled) setAvailable(result);
      })
      .catch(() => {
        if (!cancelled) setAvailable(false);
      });

    return () => {
      cancelled = true;
    };
  }, [supported]);

  return available;
}
