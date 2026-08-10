/**
 * Withdrawal consent: the single source of truth for the EU and UK
 * 14 day right to withdraw.
 *
 * WHY THIS FILE EXISTS
 * The checkbox renders WITHDRAWAL_CONSENT_LABEL, and when the user ticks it,
 * the string that was actually on screen is captured and stored verbatim as
 * the consent record. One exported constant means the rendered text and the
 * stored evidence cannot drift apart. A consent record that does not match
 * what the customer read proves nothing.
 *
 * DO NOT REWORD THE LABEL WITHOUT A LEGAL REVIEW.
 * It has to carry two separate elements, both intact:
 *   1. an express request for the service to start immediately, and
 *   2. an explicit acknowledgment that the 14 day withdrawal right is lost.
 * Any change to the wording is a new TERMS_VERSION, because old records must
 * keep pointing at the exact text those customers agreed to.
 */

/**
 * Version stamp for the label text above. Bump this (never edit in place)
 * whenever WITHDRAWAL_CONSENT_LABEL changes, so a stored record always
 * identifies which wording the customer saw.
 */
export const TERMS_VERSION = '2026-07-13';

/**
 * The checkbox label. THIS IS THE STRING WE STORE. Legally reviewed as is.
 */
export const WITHDRAWAL_CONSENT_LABEL =
  'Start my Orange Way Books subscription now. I understand that by asking it to start now, I give up the 14 day right to withdraw (cancel) that EU and UK consumer law gives consumers.';

/**
 * Reassurance shown under the box. NOT part of the consent and NEVER stored:
 * it sits outside the consent record so it cannot dilute the acknowledgment.
 * Safe to reword without bumping TERMS_VERSION.
 */
export const WITHDRAWAL_CONSENT_HELPER =
  'We ask everyone this, wherever you live. If you are outside the EU or UK, that 14 day right never applied to you and nothing changes. Your refund policy is unchanged either way.';

/**
 * Microcopy for the unticked path. Leaving the box unticked is allowed: the
 * subscription still starts now and the customer keeps the full 14 day right
 * to cancel, so we carry the refund exposure (bounded at one billing period).
 * We never condition service delivery on the waiver.
 */
export const WITHDRAWAL_CONSENT_UNTICKED_HINT =
  'Leave it unticked and we will still start you now. You just keep the 14 day right to cancel.';

/**
 * Feature flag. Off by default: the checkbox stays dark until the consent
 * table exists on dev and the server side insert path is wired. Rendering a
 * tick we cannot record is worse than not asking, because the customer
 * believes they consented and we hold no evidence.
 */
export function isWithdrawalConsentEnabled(): boolean {
  return import.meta.env.VITE_WITHDRAWAL_CONSENT_ENABLED === 'true';
}
