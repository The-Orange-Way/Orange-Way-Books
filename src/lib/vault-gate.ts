/**
 * Which submit condition is currently blocking a vault-password screen.
 *
 * A submit gate is a conjunction of several conditions. A conjunction tells
 * the button what to do and tells the person nothing. A beta user hit exactly
 * that on the sibling app in production during signup: a password the meter
 * called "Strong", a greyed-out button, and no message on screen. Her words:
 * the button was not active and it did not give a reason why.
 *
 * The first fix over there explained the strength case only, and review caught
 * that the other conditions were still silent. That is the real lesson: the
 * defect is not any one missing string, it is that the disabled state and the
 * explanation were two separate pieces of logic that could disagree without
 * anything noticing.
 *
 * So this module owns the decision and nothing else. It answers "which one",
 * not "what do we say about it": the wording and the placement stay in the
 * component, next to the field each one is about, where a copywriter can
 * change them without touching logic.
 *
 * Ported from the sibling app's src/lib/vault-gate.ts unchanged, so the two
 * apps cannot drift on which condition wins. A change here is a change there.
 */

export interface VaultGateState {
  password: string;
  confirm: string;
  /** The same strength test the submit gate uses. */
  strongEnough: boolean;
  /** The acknowledgement checkbox. */
  understood: boolean;
  minLength: number;
}

export type VaultGateBlocker = 'length' | 'strength' | 'mismatch' | 'acknowledgement';

/**
 * The first unmet submit condition, or null when the form is ready.
 *
 * Order matters and is the order a person naturally satisfies them. There is
 * no point objecting to the strength of a five-character password, which is
 * the confusion the length case was added to end.
 *
 * Two states report nothing on purpose:
 *  - an empty password, because nagging someone before they have typed
 *    anything is not help;
 *  - an empty confirm field, because it is not a mismatch yet, it is just
 *    not filled in.
 *
 * A busy flag is not an input. A button reading "Creating your vault..."
 * already explains itself.
 */
export function vaultGateBlocker(state: VaultGateState): VaultGateBlocker | null {
  if (state.password.length === 0) return null;
  if (state.password.length < state.minLength) return 'length';
  if (!state.strongEnough) return 'strength';
  if (state.confirm.length > 0 && state.password !== state.confirm) return 'mismatch';
  if (state.password === state.confirm && !state.understood) return 'acknowledgement';
  return null;
}
