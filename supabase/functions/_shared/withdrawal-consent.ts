/**
 * Withdrawal consent, server side. THIS is the text that gets stored.
 *
 * WHY THIS FILE EXISTS (and why it duplicates src/lib/withdrawal-consent.ts)
 * The consent row is evidence, so the string in it has to be one the server
 * chose, never one the browser posted. A client is not a trustworthy source
 * for the sentence we later show a regulator.
 *
 * Edge functions run in Deno and are bundled from supabase/functions, so they
 * cannot import from src/lib. The duplication is deliberate and it is fenced:
 * src/lib/__tests__/withdrawal-consent.test.ts reads this file and fails CI if
 * either constant stops matching the client one. The customer therefore cannot
 * read one sentence and have another stored.
 *
 * DO NOT REWORD THE LABEL WITHOUT A LEGAL REVIEW. Any change is a new
 * TERMS_VERSION, in both files, in the same commit.
 */

/** Version stamp for the label text below. Bump, never edit in place. */
export const TERMS_VERSION = '2026-07-13';

/** The reviewed label. This exact string is what lands in consent_text. */
export const WITHDRAWAL_CONSENT_LABEL =
  'Start my Orange Way Books subscription now. I understand that by asking it to start now, I give up the 14 day right to withdraw (cancel) that EU and UK consumer law gives consumers.';
