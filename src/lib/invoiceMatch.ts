/**
 * Invoice match ranking — the Wave-style "is this deposit for invoice X?"
 * suggestion engine.
 *
 * Inputs are fully decrypted in the browser. The ranker is pure: it sees
 * plaintext amounts + customer names + dates and returns a sorted list
 * of candidates with a 0..1 score. The server never runs this.
 *
 * Weights (sum to 1.0):
 *   amount-distance     0.60   — exact match wins by a wide margin
 *   customer fuzzy      0.25   — substring + word overlap
 *   date proximity      0.15   — recent issue/due dates beat old ones
 *
 * Currency must match (a USD deposit cannot match a EUR invoice). This
 * is a hard filter, not a score component.
 */

export interface InvoiceCandidate {
  id: string;
  invoice_number: string;
  amount: number;
  currency: string;
  customer_name: string;
  /** ISO date or null. Used for proximity scoring. */
  issue_date: string | null;
  due_date: string | null;
}

export interface DepositInput {
  amount: number; // positive deposit amount in tx currency
  currency: string;
  date: string; // ISO date
  /** Optional counterparty/payor name from the bank import (encrypted_metadata.counterparty). */
  counterparty: string | null;
}

export interface RankedMatch {
  candidate: InvoiceCandidate;
  score: number; // 0..1, higher = better
  reasons: {
    amount: number;
    customer: number;
    date: number;
  };
}

const W_AMOUNT = 0.6;
const W_CUSTOMER = 0.25;
const W_DATE = 0.15;

function amountScore(deposit: number, invoice: number): number {
  if (invoice <= 0) return 0;
  const diff = Math.abs(deposit - invoice);
  if (diff < 0.005) return 1; // exact within rounding
  const ratio = diff / invoice;
  if (ratio >= 1) return 0; // >100% off
  return Math.max(0, 1 - ratio); // linear falloff
}

function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .replace(/\b(inc|llc|ltd|corp|co|company)\b/g, '')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function customerScore(counterparty: string | null, customer: string): number {
  if (!counterparty || !customer) return 0;
  const a = normalizeName(counterparty);
  const b = normalizeName(customer);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.85;
  const aw = new Set(a.split(' '));
  const bw = new Set(b.split(' '));
  let overlap = 0;
  for (const w of aw) if (bw.has(w) && w.length >= 3) overlap++;
  const denom = Math.max(aw.size, bw.size);
  return denom === 0 ? 0 : overlap / denom;
}

function dateScore(depositDate: string, candidate: InvoiceCandidate): number {
  const ref = candidate.due_date | candidate.issue_date;
  if (!ref) return 0.3; // unknown — small bias
  const a = Date.parse(depositDate);
  const b = Date.parse(ref);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0.3;
  const days = Math.abs(a - b) / (1000 * 60 * 60 * 24);
  if (days <= 1) return 1;
  if (days <= 7) return 0.85;
  if (days <= 30) return 0.55;
  if (days <= 90) return 0.25;
  return 0.05;
}

export function rankInvoiceMatches(
  deposit: DepositInput,
  candidates: InvoiceCandidate[],
): RankedMatch[] {
  const ranked: RankedMatch[] = [];
  for (const c of candidates) {
    if (c.currency.toUpperCase() !== deposit.currency.toUpperCase()) continue;
    const a = amountScore(deposit.amount, c.amount);
    const cu = customerScore(deposit.counterparty, c.customer_name);
    const d = dateScore(deposit.date, c);
    const score = a * W_AMOUNT + cu * W_CUSTOMER + d * W_DATE;
    ranked.push({ candidate: c, score, reasons: { amount: a, customer: cu, date: d } });
  }
  ranked.sort((x, y) => y.score - x.score);
  return ranked;
}
