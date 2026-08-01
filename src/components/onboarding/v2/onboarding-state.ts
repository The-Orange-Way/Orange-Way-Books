import { createContext, useContext } from 'react';

/**
 * The values the flow collects, held in one place above the steps.
 *
 * Before this existed, every step kept its answer in a useState inside its own
 * component. The container swaps the component out on each advance, so React
 * unmounted the step and discarded the value: the name typed on step 1 was
 * gone by step 2, and pressing Back showed an empty field. Nothing downstream
 * could use any of it, which is why the flow had no personalization and could
 * not create anything on finish.
 *
 * Deliberately not persisted anywhere. vaultPassword and recoveryCode are the
 * two most sensitive strings the app ever holds, so they live in memory for
 * the duration of the wizard and go away with the tab. Do not move this into
 * localStorage, sessionStorage or a URL param to survive a reload.
 *
 * Mirrors the sibling app's onboarding-state.ts exactly.
 * A divergence here is a divergence in the design-twin contract.
 */
export interface OnboardingData {
  /** Optional, step 1. Encrypted and written to user_profiles on finish. */
  name: string;
  /** Step 2. Also the address the one-time code was sent to. */
  email: string;
  /** True once verifyOtp has returned a session. Steps 4+ depend on it. */
  emailVerified: boolean;
  /**
   * Step 4. Input to Argon2id in createVault. Never transmitted, never
   * logged, and not the same thing as an account password: there is no
   * account password in this flow.
   */
  vaultPassword: string;
  /**
   * Step 5. The real 12 words returned by createVault, which is also the
   * moment the vault row is written. Null until then. The verify stage
   * compares against this rather than merely checking the boxes are non-empty.
   */
  recoveryCode: string | null;
}

export interface OnboardingStateValue extends OnboardingData {
  setName: (value: string) => void;
  setEmail: (value: string) => void;
  setEmailVerified: (value: boolean) => void;
  setVaultPassword: (value: string) => void;
  setRecoveryCode: (value: string) => void;
}

export const OnboardingStateContext = createContext<OnboardingStateValue | null>(null);

export function useOnboardingState(): OnboardingStateValue {
  const value = useContext(OnboardingStateContext);
  if (!value) {
    throw new Error('useOnboardingState must be used inside OnboardingFlow');
  }
  return value;
}

/**
 * The words the verify stage asks for, compared case-insensitively and with
 * surrounding whitespace ignored, because people retype from paper and a
 * trailing space is not a failed recovery.
 *
 * Returns false when there is no code yet rather than passing vacuously. A
 * verify screen that accepts anything because generation failed upstream is
 * worse than one that refuses to advance.
 */
export function verifyRecoveryWords(
  recoveryCode: string | null,
  positions: number[],
  answers: string[],
): boolean {
  if (!recoveryCode) return false;
  const words = recoveryCode.trim().split(/\s+/);
  if (positions.length === 0 || positions.length !== answers.length) return false;
  return positions.every((position, index) => {
    const expected = words[position];
    const given = answers[index];
    if (!expected || given === undefined) return false;
    return given.trim().toLowerCase() === expected.toLowerCase();
  });
}
