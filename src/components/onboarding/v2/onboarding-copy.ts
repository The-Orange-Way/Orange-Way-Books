/**
 * Every user-facing string in the v2 flow, and nothing else. This is the file
 * to hand CX: three objects, no JSX, no logic wrapped around them.
 *
 * ONBOARDING_COPY is locked and must not be edited here. SUCCESS_COPY and
 * VERIFY_COPY are not locked and are waiting on CX; each carries its own note
 * saying why.
 *
 * Screen copy below is VERBATIM from the locked specification:
 *
 *   "7-step onboarding flow specification" (covers both apps, design twins)
 *   Copy locked 2026-07-30. Spec locked 2026-07-31.
 *   Wiki doc id 13aecb24-1275-4f87-a986-a3cd6b299bdb
 *
 * CX owns this text. Do not reword it here. If a string has to change, change
 * the wiki first and port it down, so the two apps stay design twins.
 *
 * Hoisted into one object on purpose: it can be diffed against the wiki in a
 * single block, and against the sibling app's identically-shaped object.
 *
 * This file is presentation only. Argon2id derivation, BIP-39 generation and
 * WebAuthn PRF wrapping are DL-0414's lane. Note that unlike the sibling app,
 * most of that already exists here in src/lib/vault.ts and in the v1 wizard, so
 * this flow does not re-implement it, it will call it. Every seam is marked
 * TODO(DL-0414).
 */
export const ONBOARDING_COPY = {
  name: {
    headline: 'What should we call you?',
    body: 'Optional. Skip it if you like, just a friendly touch.',
    cta: 'Continue',
    secondary: 'Skip',
  },
  email: {
    headline: "What's your email address?",
    body: "We'll send a one-time link to confirm it's you. No password yet.",
    cta: 'Send my code',
  },
  education: {
    headline: 'Your money stays yours.',
    body: 'Orange Way is built so we can never see your balance, your keys, or your transactions. Not us. Not anyone. It lives on your device.',
    cta: 'Got it',
  },
  vaultPassword: {
    headline: 'Create your vault password.',
    body: 'This unlocks everything in Orange Way. We can never reset it for you. That is what the next step is for.',
    cta: 'Set my password',
  },
  recovery: {
    headline: 'Save your recovery kit.',
    body: 'Write this somewhere safe, away from this device.',
    instruction: 'This is the only way to add another phone or tablet. We do not store a copy.',
    cta: "I've written it down",
  },
  biometric: {
    headline: 'Enable Face ID / fingerprint on this device.',
    body: 'This replaces your vault password for everyday unlocking, faster and just as secure.',
    cta: 'Enable',
    secondary: "I'll do this later",
  },
  biometricFallback: {
    headline: "Your device doesn't support this yet.",
    body: 'You can still use your vault password to open Orange Way.',
    cta: 'Continue',
  },
} as const;

/**
 * COPY NOT LOCKED, and unlike the rest of this file, it cannot be, because the
 * locked success copy is written for the sibling app: "Connect your Bitcoin
 * wallet to see your balance." There is no wallet to connect here.
 *
 * DL-0414 is explicit that this step differs between the two products. Its
 * Step 8 row reads "OWB welcome + first journal entry" against the sibling's
 * "Connect wallet / import data", and its rules section says to replace
 * wallet-connect with a welcome and first data entry. So this is the one screen
 * where the twins are supposed to diverge, and the divergence is specified.
 *
 * What is NOT specified is the wording. CX has not written it. The strings
 * below are mine, written to the shape DL-0414 describes, and they need CX
 * sign-off before this ships to anyone.
 */
export const SUCCESS_COPY = {
  headline: "You're all set.",
  body: 'Your books are encrypted and ready. Make your first journal entry to see them come alive.',
  cta: 'Make my first entry',
  secondary: "I'll do this later",
};

/**
 * COPY NOT LOCKED, and this one is on the default path, so it is the shortest
 * open item in the whole flow. CX has never written copy for the recovery
 * verification screen; it appears in DL-0414 only as a mechanism.
 *
 * Unlike the sibling app, this repo already ships wording for exactly this
 * screen: see StepVaultPassword, "Prove you saved it" over "Type the words at
 * the positions below from your saved copy. This protects you from a future
 * lockout." That text has been in front of real users. It is reproduced here so
 * v2 does not quietly regress copy that v1 already got right, and so CX is
 * reviewing a diff against something real rather than approving from scratch.
 */
export const VERIFY_COPY = {
  headline: 'Prove you saved it',
  body: 'Type the words at the positions below from your saved copy. This protects you from a future lockout.',
  hint: 'Recovery kit hidden during verification. Use the link below if you need to see it again.',
  cta: 'Confirm and continue',
  back: 'Back to my recovery kit',
};

/**
 * What the vault password step says when the Continue button is disabled, one
 * string per blocking condition, plus the acknowledgement label.
 *
 * NOT locked and not from the 2026-07-30 spec: the spec predates the fix this
 * wording comes from, which was written after a beta user met a greyed-out
 * button with no message and could not tell what to change. Ported from the
 * sibling app's shipped version so both say the same thing, and it is CX's to
 * reword. If CX changes it, change the sibling app in the same breath.
 *
 * Which of these shows is decided in src/lib/vault-gate.ts, never here, and
 * never by a guard expression assembled next to the string. That separation is
 * the whole point: it is what stopped the disabled state and the explanation
 * from drifting apart again.
 */
export const VAULT_GATE_COPY = {
  length: 'Passphrase is too short. Keep adding characters.',
  strength:
    'Your passphrase needs to be stronger to protect your vault. Keep adding characters, or use several unrelated words.',
  mismatch: "Passwords don't match. Re-type to confirm.",
  acknowledgement:
    'Confirm you understand that losing your password means losing access to your books.',
  acknowledgementLabel: 'I understand this password cannot be recovered without my recovery kit.',
  emptyMeter: 'Enter a password',
};
