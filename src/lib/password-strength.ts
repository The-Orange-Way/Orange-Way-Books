/**
 * One zxcvbn setup and one score, shared by every screen that gates on
 * password strength.
 *
 * Before this existed, v1's onboarding step configured zxcvbn at its own
 * module load and the v2 flow used a hand-rolled character-class heuristic
 * that scored 0-5 on a different scale entirely. Two scales meant two
 * thresholds, and the v2 one gated looser than the ruling allows.
 *
 * The dictionaries are the expensive part and are configured once here at
 * module load; scoring itself is well under 10 ms, so callers can run it on
 * every keystroke without a debounce.
 */
import { zxcvbn, zxcvbnOptions } from '@zxcvbn-ts/core';
import * as zxcvbnCommon from '@zxcvbn-ts/language-common';
import * as zxcvbnEn from '@zxcvbn-ts/language-en';

zxcvbnOptions.setOptions({
  translations: zxcvbnEn.translations,
  graphs: zxcvbnCommon.adjacencyGraphs,
  dictionary: {
    ...zxcvbnCommon.dictionary,
    ...zxcvbnEn.dictionary,
  },
});

export type ZxcvbnScore = 0 | 1 | 2 | 3 | 4;

/**
 * Minimum acceptable zxcvbn score. 4 is "very strong".
 *
 * Ruled by the CTO and concurred by Security on the sibling app's PR #322 and
 * deliberately not lowered for convenience: vaults derive with Argon2id, and
 * against a memory-hard KDF a score-3 passphrase is still a real weakness on a
 * self-custody surface. v1's onboarding step already gates at 4. Do not lower
 * this to make a screen easier to pass.
 */
export const MIN_ZXCVBN_SCORE: ZxcvbnScore = 4;

export const STRENGTH_LABELS = ['Very weak', 'Weak', 'Fair', 'Strong', 'Very strong'] as const;

export interface PasswordStrength {
  score: ZxcvbnScore;
  warning: string;
  suggestions: string[];
}

/** Null for an empty password, because there is nothing to say about it yet. */
export function scorePassword(value: string): PasswordStrength | null {
  if (!value) return null;
  const result = zxcvbn(value);
  return {
    score: result.score as ZxcvbnScore,
    warning: result.feedback?.warning ?? '',
    suggestions: result.feedback?.suggestions ?? [],
  };
}
