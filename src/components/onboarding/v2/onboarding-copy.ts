/**
 * Every user-facing string in the v2 flow, and nothing else. This is the file
 * to hand CX: three objects, no JSX, no logic wrapped around them.
 *
 * ONBOARDING_COPY and VERIFY_COPY are now locked and must not be edited here.
 * SUCCESS_COPY is not locked and carries its own note saying why.
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
    headline: "What's your email?",
    body: "We'll send a one-time code. No password needed.",
    cta: 'Send my link',
  },
  emailCode: {
    headline: 'Check your inbox.',
    body: 'We sent a 6-digit code to {email}. It expires in a few minutes.',
  },
  education: {
    headline: 'Your data stays yours.',
    body: 'Orange Way is built so we can never read your balances, your keys, or your history. Not us. Not anyone. It lives on your device.',
    cta: 'Got it',
  },
  vaultPassword: {
    headline: 'Create your vault password.',
    body: 'This unlocks everything in Orange Way. We can never reset it for you. That is what the next step is for.',
    cta: 'Set my password',
  },
  recovery: {
    headline: 'Save your recovery code.',
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
 * COPY NOW LOCKED. CX finalized 2026-07-31 (same sign-off as ONBOARDING_COPY).
 * Do not reword here; change the wiki first and port it down.
 */
export const VERIFY_COPY = {
  headline: 'Confirm your recovery phrase.',
  body: 'Type the words at the positions below from your saved copy.',
  hint: 'Recovery code hidden during verification. Use the link below if you need to see it again.',
  cta: 'Confirm and continue',
  back: 'Back to code',
};
