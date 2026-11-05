/**
 * Edit a POSTED journal entry in place (OWB-T0238).
 *
 * The database function owb_edit_posted_entry does the work in one
 * transaction: it copies the old header and lines into the history tables,
 * replaces the lines and updates the header, keeping the entry's id and ref
 * number. It refuses closed months (unless the owner has unlocked them),
 * reversals, reversed entries and callers without permission.
 *
 * Line amounts are encrypted, so the server cannot check that debits equal
 * credits. This helper checks it on the plaintext amounts before anything is
 * sent, and refuses a missing reason.
 *
 * When expectedUpdatedAt is given, the database refuses the edit if the entry
 * changed after it was read, checked under its row lock, so an edit is never
 * saved over a newer one.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  decryptJournalEntry,
  decryptJournalEntryLine,
  type JournalEntryLineEncrypted,
} from '@/lib/crypto-fields';

type DecryptFn = (ciphertext: string) => Promise<string>;

/** Line columns owb_edit_posted_entry reads. Anything else is dropped. */
export const EDIT_LINE_KEYS = [
  'account_id',
  'account_code',
  'account_name',
  'description',
  'encrypted_debit',
  'encrypted_credit',
  'encrypted_amount_native',
  'encrypted_amount_primary',
  'encrypted_book_value',
  'encrypted_manual_rate_reason',
  'encrypted_manual_rate_source',
  'encrypted_metadata',
  'encrypted_posted_rate',
  'encrypted_primary_currency_at_posting',
  'encrypted_wallet_currency',
  'pinned_rate_id',
  'rate_asof',
  'rate_pending',
] as const;

export type EditLine = JournalEntryLineEncrypted & { account_id: string };

export interface EditPostedEntryInput {
  entryId: string;
  /** journal_entries.key_version of the entry being edited. */
  entryKeyVersion: number;
  /** yyyy-MM-dd */
  date: string;
  header: { encrypted_memo: string | null; encrypted_currency: string };
  lines: EditLine[];
  /** Plaintext amounts of the same lines, used only for the balance check. */
  amounts: Array<{ debit: number; credit: number }>;
  encryptedReason: string;
  reasonText: string;
  /** journal_entries.updated_at as read before the edit. */
  expectedUpdatedAt?: string | null;
  /** Linked transactions to change in the same call. Left out by the Journal screen. */
  txs?: PostedTxUpdate[];
}

/** One linked transaction changed with the entry. owb_edit_posted_entry refuses other keys. */
export interface PostedTxUpdate {
  id: string;
  date: string;
  encrypted_amount: string;
  signature_b64: string | null;
  signature_key_version: number | null;
}

export interface EditPostedEntryArgs {
  p_je_id: string;
  p_date: string;
  p_header: Record<string, string | null>;
  p_lines: Array<Record<string, unknown>>;
  p_txs: unknown[];
  p_encrypted_reason: string;
  p_key_version: number;
  p_expected_updated_at: string | null;
}

/** Builds the RPC arguments, or throws with a message the user can act on. */
export function buildEditPostedEntryArgs(input: EditPostedEntryInput): EditPostedEntryArgs {
  if (!input.reasonText.trim()) {
    throw new Error('Say why this posted entry is being changed.');
  }
  if (input.lines.length < 2 || input.amounts.length !== input.lines.length) {
    throw new Error('A journal entry needs at least two lines.');
  }
  const debits = input.amounts.reduce((s, a) => s + a.debit, 0);
  const credits = input.amounts.reduce((s, a) => s + a.credit, 0);
  if (!(debits > 0) || Math.abs(debits - credits) >= 0.001) {
    throw new Error('Debits and credits must be equal before the entry can be saved.');
  }
  for (const line of input.lines) {
    if (line.key_version !== input.entryKeyVersion) {
      throw new Error(
        'This entry was saved with an older encryption key. Re-encrypt the books before editing it.',
      );
    }
    if (!line.account_id) throw new Error('Every line needs an account.');
  }
  const p_lines = input.lines.map((line) => {
    const out: Record<string, unknown> = {};
    for (const k of EDIT_LINE_KEYS) {
      const v = (line as unknown as Record<string, unknown>)[k];
      if (v !== undefined) out[k] = v;
    }
    return out;
  });
  return {
    p_je_id: input.entryId,
    p_date: input.date,
    p_header: {
      encrypted_memo: input.header.encrypted_memo,
      encrypted_currency: input.header.encrypted_currency,
    },
    p_lines,
    // The Journal screen only edits manual entries, which have no linked
    // transactions. The transaction screen sends the ones it changes.
    p_txs: (input.txs ?? []).map((t) => ({
      id: t.id,
      date: t.date,
      encrypted_amount: t.encrypted_amount,
      signature_b64: t.signature_b64,
      signature_key_version: t.signature_key_version,
    })),
    p_encrypted_reason: input.encryptedReason,
    p_key_version: input.entryKeyVersion,
    p_expected_updated_at: input.expectedUpdatedAt ?? null,
  };
}

/** A line as stored, with the values the edit compares against. */
export interface StoredEditLine {
  row: EditLine;
  accountId: string;
  accountName: string | null;
  accountCode: string | null;
  description: string | null;
  debit: number;
  credit: number;
  walletCurrency: string | null;
  primaryAtPosting: string | null;
  bookValue: number | null;
  ratePending: boolean;
}

/** A line as the user left it in the edit form. */
export interface EditedLine {
  accountId: string;
  accountName: string | null;
  accountCode: string | null;
  description: string | null;
  debit: number;
  credit: number;
}

export interface BuildLineParams {
  wallet_currency: string;
  primary_currency: string;
  date: string;
  debit: number;
  credit: number;
  account_id: string;
  account_name: string | null;
  account_code: string | null;
  description: string | null;
  book_value: number | null;
}

const blank = (v: string | null | undefined) => (v ?? '').trim();

/** The later of two yyyy-MM-dd dates, either of which may be missing. */
export function laterDate(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

/** The day after the lock date, yyyy-MM-dd: the first day an entry can be posted. */
export function firstOpenDay(lockDate: string): string {
  const d = new Date(`${lockDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Chooses the lines to send for a posted edit.
 *
 * A line whose account, amounts, currency and date did not change is sent
 * back as stored, so its rate, value in the primary currency, book value and
 * any rate entered by hand stay as they were. If only its account name, code
 * or description changed, just that text is replaced. Only a line whose
 * value changed, or a new line, is rebuilt, under the primary currency the
 * entry was posted in. If a rebuilt line has no rate and the stored line had
 * one, the edit is refused, because saving it would remove a value the books
 * already have.
 */
export async function planPostedEditLines(opts: {
  stored: StoredEditLine[];
  edited: EditedLine[];
  storedDate: string;
  /** The entry's currency as stored, for older lines that do not carry their own. */
  storedCurrency: string;
  date: string;
  currency: string;
  primaryCurrency: string;
  encrypt: (plaintext: string) => Promise<string>;
  build: (p: BuildLineParams) => Promise<{ insert: EditLine; pending: boolean }>;
}): Promise<EditLine[]> {
  const { stored, edited, storedDate, date, currency, build, encrypt } = opts;
  const entryPrimary = stored.find((s) => s.primaryAtPosting)?.primaryAtPosting;
  const primary = entryPrimary ?? opts.primaryCurrency;
  const sameValue = (s: StoredEditLine, e: EditedLine) =>
    s.accountId === e.accountId &&
    s.debit === e.debit &&
    s.credit === e.credit &&
    (s.walletCurrency ?? opts.storedCurrency) === currency &&
    storedDate === date;
  const sameText = (s: StoredEditLine, e: EditedLine) =>
    blank(s.accountName) === blank(e.accountName) &&
    blank(s.accountCode) === blank(e.accountCode) &&
    blank(s.description) === blank(e.description);

  // Exact matches first, so a line that only moved is never taken by a
  // line whose text changed.
  const used = new Set<number>();
  const pick = (test: (s: StoredEditLine) => boolean) => {
    const j = stored.findIndex((s, k) => !used.has(k) && test(s));
    if (j >= 0) used.add(j);
    return j;
  };
  const exact = edited.map((e) => pick((s) => sameValue(s, e) && sameText(s, e)));
  const byValue = edited.map((e, i) => (exact[i] >= 0 ? -1 : pick((s) => sameValue(s, e))));
  // A line whose value changed replaces the stored line left over on the same
  // account. A line with none is new, or moved to another account.
  const replaces = edited.map((e, i) =>
    exact[i] >= 0 || byValue[i] >= 0 ? -1 : pick((s) => s.accountId === e.accountId),
  );
  const entryHasValues = stored.some((s) => !s.ratePending);

  const enc = async (v: string | null) => (v && v.trim() ? encrypt(v) : null);
  const out: EditLine[] = [];
  for (const [i, e] of edited.entries()) {
    if (exact[i] >= 0) {
      out.push(stored[exact[i]].row);
      continue;
    }
    if (byValue[i] >= 0) {
      out.push({
        ...stored[byValue[i]].row,
        account_name: await enc(e.accountName),
        account_code: await enc(e.accountCode),
        description: await enc(e.description),
      });
      continue;
    }
    const built = await build({
      wallet_currency: currency,
      primary_currency: primary,
      date,
      debit: e.debit,
      credit: e.credit,
      account_id: e.accountId,
      account_name: e.accountName,
      account_code: e.accountCode,
      description: e.description,
      book_value: null,
    });
    // Compare with the line it replaces, never the one at the same position:
    // removing a line shifts the positions. A line deleted on purpose is not
    // compared with anything. A new line without a rate is only accepted on
    // an entry that had no values to begin with.
    const before = replaces[i] >= 0 ? stored[replaces[i]] : null;
    const dropsAValue = before ? !before.ratePending : entryHasValues;
    if (built.pending && dropsAValue) {
      throw new Error(
        `No exchange rate was found for ${currency} on ${date}, so this change would remove a value the books already have. Nothing was saved. Try again later.`,
      );
    }
    out.push(built.insert);
  }
  return out;
}

/** Loads the stored lines of one entry, in the order the Journal page shows them. */
export async function loadStoredEditLines(
  rows: Array<EditLine & { id: string }>,
  decrypt: DecryptFn,
): Promise<StoredEditLine[]> {
  return Promise.all(
    rows.map(async (row) => {
      const d = await decryptJournalEntryLine(row, decrypt);
      return {
        row,
        accountId: row.account_id,
        accountName: d.account_name,
        accountCode: d.account_code,
        description: d.description,
        debit: d.debit ?? 0,
        credit: d.credit ?? 0,
        walletCurrency: d.wallet_currency ?? null,
        primaryAtPosting: d.primary_currency_at_posting ?? null,
        bookValue: d.book_value ?? null,
        ratePending: !!row.rate_pending,
      };
    }),
  );
}

/** Sends the edit. Returns the new version number. */
export async function editPostedEntry(
  client: SupabaseClient,
  input: EditPostedEntryInput,
): Promise<number> {
  const args = buildEditPostedEntryArgs(input);
  const { data, error } = await client.rpc('owb_edit_posted_entry' as never, args as never);
  if (error) throw new Error(error.message);
  return data as unknown as number;
}

export interface EntryVersionLine {
  accountName: string | null;
  debit: number;
  credit: number;
  description: string | null;
}

export interface EntryVersion {
  versionNo: number;
  editedAt: string;
  editedBy: string;
  periodOverride: boolean;
  reason: string | null;
  /** The entry as it was before this edit. */
  date: string;
  memo: string | null;
  currency: string;
  lines: EntryVersionLine[];
}

/** Earlier versions of one entry, newest first, decrypted. */
export async function fetchEntryHistory(
  client: SupabaseClient,
  entryId: string,
  decrypt: DecryptFn,
): Promise<EntryVersion[]> {
  const [vRes, lRes] = await Promise.all([
    client
      .from('journal_entry_versions' as never)
      .select('*')
      .eq('journal_entry_id', entryId)
      .order('version_no', { ascending: false }),
    client
      .from('journal_entry_line_versions' as never)
      .select('*')
      .eq('journal_entry_id', entryId)
      .order('line_created_at', { ascending: true }),
  ]);
  if (vRes.error) throw new Error(vRes.error.message);
  if (lRes.error) throw new Error(lRes.error.message);
  const versions = (vRes.data ?? []) as Array<Record<string, unknown>>;
  const lineRows = (lRes.data ?? []) as Array<Record<string, unknown>>;
  return Promise.all(
    versions.map(async (v) => {
      const header = await decryptJournalEntry(v, decrypt);
      const lines = await Promise.all(
        lineRows
          .filter((l) => l.version_id === v.id)
          .map(async (l) => {
            const d = await decryptJournalEntryLine(l, decrypt);
            return {
              accountName: d.account_name,
              debit: d.debit ?? 0,
              credit: d.credit ?? 0,
              description: d.description,
            };
          }),
      );
      return {
        versionNo: v.version_no as number,
        editedAt: v.edited_at as string,
        editedBy: v.edited_by as string,
        periodOverride: v.period_override as boolean,
        reason: v.encrypted_reason ? await decrypt(v.encrypted_reason as string) : null,
        date: v.date as string,
        memo: header.memo,
        currency: header.currency,
        lines,
      };
    }),
  );
}
