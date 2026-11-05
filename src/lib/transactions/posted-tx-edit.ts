/**
 * Edit a POSTED split or transfer from the transaction screen (OWB-T0228).
 *
 * A posted entry's lines cannot be deleted or inserted directly, so the old
 * save (update the header to DRAFT, delete the lines, insert new ones) fails
 * part way on a posted entry. This sends the whole change through
 * owb_edit_posted_entry instead, in one call: the entry keeps its id and
 * number, the earlier version goes to its history with the reason, and the
 * linked transactions get their new date and amount in the same transaction,
 * so a refusal leaves lines and transactions as they were.
 *
 * The edit function cannot change a transaction's wallet, direction or memo,
 * so those changes are refused here before anything is sent. Lines are
 * planned one currency at a time with planPostedEditLines, so a line whose
 * value did not change keeps its stored rate.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { decryptJournalEntryLine, decryptTransaction } from '@/lib/crypto-fields';
import { buildJournalEntryLineInsert } from '@/lib/exchange/build-je-line-insert';
import {
  editPostedEntry,
  loadStoredEditLines,
  planPostedEditLines,
  type BuildLineParams,
  type EditLine,
  type EditedLine,
  type PostedTxUpdate,
} from '@/lib/journal-entry-edit-posted';

type EncryptFn = (plaintext: string) => Promise<string>;
type DecryptFn = (ciphertext: string) => Promise<string>;

const blank = (v: string | null | undefined) => (v ?? '').trim();

/** The posted entry as read when the edit was opened. */
export interface PostedEntry {
  id: string;
  date: string;
  updatedAt: string;
  keyVersion: number;
  encryptedMemo: string | null;
  encryptedCurrency: string;
  sourceType: string | null;
}

/** Reads the entry behind a transaction. Returns null unless it is POSTED. */
export async function loadPostedEntry(
  client: SupabaseClient,
  entryId: string,
): Promise<PostedEntry | null> {
  const { data, error } = await client
    .from('journal_entries')
    .select(
      'id, status, date, updated_at, key_version, encrypted_memo, encrypted_currency, source_type',
    )
    .eq('id', entryId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  const je = data as {
    id: string;
    status: string;
    date: string;
    updated_at: string;
    key_version: number | null;
    encrypted_memo: string | null;
    encrypted_currency: string;
    source_type: string | null;
  } | null;
  if (!je || je.status !== 'POSTED') return null;
  return {
    id: je.id,
    date: je.date,
    updatedAt: je.updated_at,
    keyVersion: je.key_version ?? 0,
    encryptedMemo: je.encrypted_memo,
    encryptedCurrency: je.encrypted_currency,
    sourceType: je.source_type,
  };
}

/** The transaction as the form shows it, from the list it was opened from. */
export interface ShownTx {
  id: string;
  amount: number;
  /** yyyy-MM-dd */
  date: string;
  memo: string | null;
}

/**
 * Reads the posted entry, then the transaction the form was opened from. The
 * version is read first, so the transaction and anything the form reads after
 * this is at least as new as it, and a later change is refused by the
 * database. If the transaction differs from what the list showed, the list was
 * out of date and stale is true: saving it would put back the old values.
 */
export async function loadPostedEditSnapshot(
  client: SupabaseClient,
  entryId: string,
  shown: ShownTx,
  decrypt: DecryptFn,
): Promise<{ entry: PostedEntry | null; stale: boolean }> {
  const entry = await loadPostedEntry(client, entryId);
  if (!entry) return { entry: null, stale: false };
  const { data, error } = await client
    .from('transactions')
    .select('*')
    .eq('id', shown.id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return { entry, stale: true };
  const tx = await decryptTransaction(data, decrypt);
  const stale =
    (data as { date: string }).date !== shown.date ||
    Number(tx.amount) !== Number(shown.amount) ||
    blank(tx.memo) !== blank(shown.memo);
  return { entry, stale };
}

/** The accounts a posted entry's lines already use. */
export interface PostedLineAccounts {
  /** wallet id -> its chart account, as the stored lines use it. */
  wallet: Map<string, string>;
  /** Every other account on the stored lines, with its name as stored. */
  other: Array<{ id: string; name: string | null }>;
}

/**
 * Reads, without writing, the accounts a posted entry's lines already use.
 * A posted edit cannot change wallets, so these are the accounts to send
 * back. Nothing is created here, so a refused edit leaves nothing behind. A
 * wallet whose account is not on the stored lines is refused rather than
 * linked to a new one.
 */
export async function postedLineAccounts(
  client: SupabaseClient,
  entryId: string,
  walletIds: string[],
  decrypt: DecryptFn,
): Promise<PostedLineAccounts> {
  const [wRes, lRes] = await Promise.all([
    client.from('wallets').select('id, external_account_id').in('id', walletIds),
    client.from('journal_entry_lines').select('*').eq('journal_entry_id', entryId),
  ]);
  if (wRes.error) throw new Error(wRes.error.message);
  if (lRes.error) throw new Error(lRes.error.message);
  const lines = (lRes.data ?? []) as Array<{ account_id: string }>;
  const onLines = new Set(lines.map((l) => l.account_id));
  const wallet = new Map<string, string>();
  for (const w of (wRes.data ?? []) as Array<{ id: string; external_account_id: string | null }>) {
    if (w.external_account_id && onLines.has(w.external_account_id)) {
      wallet.set(w.id, w.external_account_id);
    }
  }
  if (walletIds.some((id) => !wallet.has(id))) {
    throw new Error(
      "A wallet's account is not the one this posted entry uses, so it cannot be edited here. Reverse the entry and enter it again instead.",
    );
  }
  const walletAccounts = new Set(wallet.values());
  const other: PostedLineAccounts['other'] = [];
  for (const l of lines) {
    if (walletAccounts.has(l.account_id) || other.some((o) => o.id === l.account_id)) continue;
    const { account_name } = await decryptJournalEntryLine(l, decrypt);
    other.push({ id: l.account_id, name: account_name });
  }
  return { wallet, other };
}

export const RECONCILED_REFUSAL =
  'Part of this entry is reconciled, so it cannot be changed. Unreconcile it on the wallet statement first.';

/** What the transaction looked like when opened, and what the form holds now. */
export interface PostedTxShape {
  mode: 'standard' | 'split' | 'transfer';
  walletId: string;
  counterpartyWalletId: string | null;
  direction: 'IN' | 'OUT';
  memo: string | null;
}

/** The mode a posted entry was saved in, from its source type. */
export function postedEntryMode(entry: PostedEntry): 'split' | 'transfer' | null {
  if (entry.sourceType === 'TRANSACTION_SPLIT') return 'split';
  if (entry.sourceType === 'TRANSACTION_TRANSFER') return 'transfer';
  return null;
}

/**
 * Returns why this change cannot be saved on a posted entry, or null when it
 * can. Each of these needs the entry reversed and entered again.
 */
export function postedEditRefusal(was: PostedTxShape, now: PostedTxShape): string | null {
  const redo = 'Reverse the entry and enter it again instead.';
  if (was.mode !== now.mode) {
    return `A posted ${was.mode} cannot be changed into a ${now.mode}. ${redo}`;
  }
  if (was.walletId !== now.walletId) {
    return `A posted entry cannot be moved to another wallet. ${redo}`;
  }
  if ((was.counterpartyWalletId ?? null) !== (now.counterpartyWalletId ?? null)) {
    return `A posted transfer cannot be moved to another wallet. ${redo}`;
  }
  if (was.direction !== now.direction) {
    return `The direction of a posted entry cannot be changed. ${redo}`;
  }
  if (blank(was.memo) !== blank(now.memo)) {
    return 'The memo of a posted transaction cannot be changed here yet. Put the memo back and save, or reverse the entry and enter it again.';
  }
  return null;
}

/** A line as the form now has it, with the currency it is in. */
export type PostedEditedLine = EditedLine & { currency: string };

export interface PostedTxEditInput {
  entry: PostedEntry;
  /** yyyy-MM-dd */
  date: string;
  lines: PostedEditedLine[];
  /** The org's primary currency, used only for lines with no stored one. */
  primaryCurrency: string;
  txs: PostedTxUpdate[];
  reason: string;
  encrypt: EncryptFn;
  decrypt: DecryptFn;
  /** Injected in tests. Defaults to the shared line builder. */
  build?: (p: BuildLineParams) => Promise<{ insert: EditLine; pending: boolean }>;
}

/** Sends the edit in one owb_edit_posted_entry call. Returns the new version number. */
export async function savePostedTxEdit(
  client: SupabaseClient,
  input: PostedTxEditInput,
): Promise<number> {
  if (!input.reason.trim()) throw new Error('Say why this posted entry is being changed.');
  const { entry, encrypt, decrypt } = input;

  // A reconciled entry is locked, and the database cannot see that: the
  // reconciled status is encrypted. Read every transaction on the entry now,
  // so a reconciled other side of a transfer is caught too.
  const { data: txRows, error: txErr } = await client
    .from('transactions')
    .select('*')
    .eq('journal_entry_id', entry.id);
  if (txErr) throw new Error(txErr.message);
  for (const row of txRows ?? []) {
    const tx = await decryptTransaction(row, decrypt);
    if (tx.cleared_status === 'RECONCILED') throw new Error(RECONCILED_REFUSAL);
  }
  const build =
    input.build ??
    ((params: BuildLineParams) =>
      buildJournalEntryLineInsert({ ...params, encrypt }) as Promise<{
        insert: EditLine;
        pending: boolean;
      }>);

  const { data: rows, error } = await client
    .from('journal_entry_lines')
    .select('*')
    .eq('journal_entry_id', entry.id)
    .order('created_at', { ascending: true });
  if (error) throw new Error(error.message);
  const stored = await loadStoredEditLines(
    (rows ?? []) as Array<EditLine & { id: string }>,
    decrypt,
  );
  const storedCurrency = await decrypt(entry.encryptedCurrency);

  // Plan each currency on its own: a transfer has lines in two currencies, and
  // a line is only matched against stored lines in the same currency.
  const planned = new Map<string, EditLine[]>();
  for (const currency of new Set(input.lines.map((l) => l.currency))) {
    planned.set(
      currency,
      await planPostedEditLines({
        stored: stored.filter((s) => (s.walletCurrency ?? storedCurrency) === currency),
        edited: input.lines.filter((l) => l.currency === currency),
        storedDate: entry.date,
        storedCurrency,
        date: input.date,
        currency,
        primaryCurrency: input.primaryCurrency,
        encrypt,
        build,
      }),
    );
  }
  const lines = input.lines.map((l) => planned.get(l.currency)!.shift()!);

  return editPostedEntry(client, {
    entryId: entry.id,
    entryKeyVersion: entry.keyVersion,
    date: input.date,
    // The memo and currency cannot change on a posted entry (see postedEditRefusal).
    header: { encrypted_memo: entry.encryptedMemo, encrypted_currency: entry.encryptedCurrency },
    lines,
    amounts: input.lines.map((l) => ({ debit: l.debit, credit: l.credit })),
    encryptedReason: await encrypt(input.reason.trim()),
    reasonText: input.reason,
    expectedUpdatedAt: entry.updatedAt,
    txs: input.txs,
  });
}
