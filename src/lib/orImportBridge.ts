/**
 * orImportBridge, Phase 5 client-side bridge between OrangeRails-synced
 * transactions and the OWB ledger.
 *
 * After or-sync writes encrypted normalized transactions on the OR side, this
 * module fans them out to:
 *   1. The OWB `transactions` table (so the Wallet Statement modal sees them).
 *   2. A balanced journal entry pair (so the ledger / P&L / Reports see them).
 *
 * Routing is read from `connection_account_map`, the user picked a destination
 * OWB wallet for each OR source_wallet during the Phase 3 destination picker.
 * Transactions whose source_wallet has no mapping are skipped (they remain
 * visible in the OR-side Connections card, awaiting a mapping).
 *
 * Idempotency: each row stores a plaintext routing tag inside `encrypted_metadata`
 * `{ source: "orangerails", or_external_id, or_connection_id }`. Before insert
 * we query `transactions WHERE account_id = X AND encrypted_metadata @>
 * { source: "orangerails", or_external_id: Y }`, first-write-wins. Storing
 * the OR external_id plaintext on OWB leaks no business data: it is already
 * server-visible on OR's side (OWB just sees an opaque token here too).
 *
 * Account categorization is intentionally minimal in Phase 5: every inflow
 * goes to "Uncategorized Revenue", every outflow to "Uncategorized Expense".
 * The user re-categorizes manually for now.
 *
 * Account routing rule: ONLY accept an existing account whose name is
 * "Uncategorized Revenue/Income" or "Uncategorized Expense/Expenses". If none
 * exists, lazy-create one (one-time per org). We deliberately do NOT fall back
 * to "Other Income/Expenses" or to the first account of the matching type
 * those are real categories users may have configured, and silently routing
 * imports into them buries the "needs review" signal. Better to always land
 * on "Uncategorized" so the user sees a clear bucket to triage.
 */

import { supabase } from '@/lib/supabase';
import {
  encryptTransaction,
  encryptJournalEntry,
  encryptChartOfAccount,
  decryptChartOfAccount,
  type EncryptFn,
  type DecryptFn,
} from '@/lib/crypto-fields';
import { buildJournalEntryLineInsert } from '@/lib/exchange/build-je-line-insert';
import { lookupRouting, type DecryptedConnectionAccountMapping } from '@/lib/connectionAccountMap';

/**
 * Shape of an OR-decrypted transaction (must match what TransactionList parses
 * out of the encrypted_payload after decryptOrTxnCipher).
 */
export interface DecryptedOrTx {
  id: string;
  adapter: string;
  direction: 'in' | 'out';
  type: 'lightning' | 'onchain' | 'trade' | 'deposit' | 'withdrawal' | 'fee';
  amount_sats?: number;
  amount?: number;
  currency?: string;
  description?: string | null;
  counterparty?: string | null;
  status?: string;
  timestamp: string;
  source_wallet_id?: string | null;
}

/**
 * Decrypted OWB wallet, the subset the bridge needs to compose a transaction
 * + JE pair. The caller (Connections page) already decrypts wallets for the
 * routing UI, so we accept a small projection rather than re-fetching.
 */
export interface DestinationWallet {
  id: string;
  /** Decrypted asset/currency (e.g. "BTC", "SATS", "USD"). */
  asset: string;
  /** Decrypted human-readable name (e.g. "Blink Lightning"). */
  name: string;
}

export interface ImportOrTransactionsParams {
  orgId: string;
  /** OR connection id (used for mapping lookup + audit tagging). */
  orConnectionId: string;
  /** OR transactions, already decrypted from encrypted_payload by the caller. */
  orTxs: DecryptedOrTx[];
  /** Decrypted destination mappings for this org (filtered or all, the
   *  bridge filters by orConnectionId internally). */
  mappings: DecryptedConnectionAccountMapping[];
  /** Lookup destination wallets by their OWB wallets.id. The caller already
   *  has these decrypted in memory (the Connections page builds an
   *  accountLookup for the routing badge). */
  walletsById: Map<string, DestinationWallet>;
  /** Org's primary currency for dual-currency JE bookkeeping. */
  primaryCurrency: string;
  encryptText: EncryptFn;
  decryptText: DecryptFn;
}

export interface ImportOrTransactionsResult {
  /** Total transactions inspected. */
  inspected: number;
  /** Transactions successfully written to OWB (and JE posted). */
  imported: number;
  /** Transactions skipped because no mapping exists for their source_wallet. */
  unrouted: number;
  /** Transactions skipped because they were already imported (idempotent). */
  duplicates: number;
  /** Per-transaction errors (logged, non-fatal). */
  errors: Array<{ orTxId: string; error: string }>;
}

/** Plaintext routing tag stored inside transactions.encrypted_metadata. */
const SOURCE_TAG = 'orangerails';

/**
 * Build the encrypted_metadata JSONB blob for a row imported from OR.
 *
 * The values stored here are intentionally NOT business-sensitive:
 *   - `source: "orangerails"` is just a routing tag.
 *   - `or_external_id` is OR's opaque transaction id (already server-visible
 *     on OR's side). It enables server-queryable dedup via JSONB containment.
 *   - `or_connection_id` is OR's opaque connection id (already known to OWB
 *     via connection_account_map.or_connection_id).
 *
 * No amounts, memos, counterparties, or wallet identifiers go in here
 * those remain in the encrypted columns (`encrypted_amount`, `memo`, etc.).
 */
function buildOrSourceMetadata(orConnectionId: string, orTxId: string): Record<string, string> {
  return {
    source: SOURCE_TAG,
    or_connection_id: orConnectionId,
    or_external_id: orTxId,
  };
}

/**
 * Resolve the destination wallet for an OR tx. Returns null if no mapping
 * exists for the tx's source_wallet_id (caller treats as "unrouted").
 */
function resolveDestinationWalletId(
  tx: DecryptedOrTx,
  orConnectionId: string,
  mappingIndex: Map<string, string[]>,
): string | null {
  const ids = lookupRouting(mappingIndex, orConnectionId, tx.source_wallet_id);
  return ids[0] ?? null;
}

/**
 * Pick the user-facing amount in the wallet's units. Two cases:
 *   - amount_sats present (Bitcoin-native txs from OR adapters): use sats
 *     directly when the destination wallet's asset is SATS. For BTC, divide
 *     by 1e8 to express in whole BTC.
 *   - amount + currency (fiat / USD stable): use the fiat amount as-is.
 *
 * When the OR-side currency disagrees with the OWB wallet's asset (e.g. user
 * mapped a BTC wallet to a SATS OWB wallet, or vice versa) we still convert
 * within the BTC ladder. For other mismatches we fall back to OR's amount
 * the user can re-categorize later.
 */
function computeAmount(tx: DecryptedOrTx, walletAsset: string): { amount: number; asset: string } {
  const sats = typeof tx.amount_sats === 'number' ? tx.amount_sats : null;
  const fiat = typeof tx.amount === 'number' ? tx.amount : null;
  const upperWalletAsset = walletAsset.toUpperCase();

  if (sats != null) {
    if (upperWalletAsset === 'SATS') return { amount: sats, asset: 'SATS' };
    if (upperWalletAsset === 'BTC') return { amount: sats / 1e8, asset: 'BTC' };
    // Mismatched units, fall back to sats expressed in the wallet's asset
    // string. This is unusual but non-fatal; the user can re-map.
    return { amount: sats, asset: upperWalletAsset };
  }
  if (fiat != null) {
    return { amount: fiat, asset: upperWalletAsset };
  }
  return { amount: 0, asset: upperWalletAsset };
}

/**
 * Lookup-or-lazy-create the org's "Uncategorized Revenue" + "Uncategorized
 * Expense" accounts. Returns the account_name strings (which is what
 * buildJournalEntryLineInsert wants, JE lines reference accounts by name).
 *
 * Strategy:
 *   1. Decrypt all chart_of_accounts rows once.
 *   2. Match by name only: "Uncategorized Revenue" / "Uncategorized Income"
 *      for inflows and "Uncategorized Expense" / "Uncategorized Expenses"
 *      for outflows.
 *   3. If neither variant exists, lazy-create one (a one-time cost per org
 *      never via migration so existing orgs are not touched).
 *
 * NOT considered as fallbacks:
 *   - "Other Income" / "Other Expenses", those are real user-configurable
 *     buckets. Silently routing imports into them hides the "needs review"
 *     signal that the whole point of Uncategorized is to surface.
 *   - First-of-type, same reasoning. If the org has, say, only "Sales
 *     Revenue", we still create Uncategorized rather than dump imports there.
 *
 * Caching: results are returned per call, the bridge calls this once per
 * import batch, so per-call cost is bounded.
 */
async function ensureUncategorizedAccounts(
  orgId: string,
  encryptText: EncryptFn,
  decryptText: DecryptFn,
): Promise<{
  revenueName: string;
  expenseName: string;
  /** chart_of_accounts.id (PK) for the Uncategorized Revenue row. */
  revenueRowId: string;
  /** chart_of_accounts.id (PK) for the Uncategorized Expense row. */
  expenseRowId: string;
}> {
  const { data: rows, error } = await supabase
    .from('chart_of_accounts')
    .select('*')
    .eq('org_id', orgId);
  if (error) throw error;

  type Decoded = {
    id: string;
    account_code: string | null;
    account_type: string;
    account_name: string;
    is_archived: boolean;
  };

  const decoded: Decoded[] = [];
  for (const row of (rows as any[]) ?? []) {
    try {
      const fields = await decryptChartOfAccount(row, decryptText);
      decoded.push({
        id: row.id as string,
        account_code: fields.account_code ?? null,
        account_type: (fields.account_type | '').toUpperCase(),
        account_name: fields.account_name | '',
        is_archived: !!fields.is_archived,
      });
    } catch {
      // Undecryptable rows (key mismatch / pre-migration) are ignored, we
      // never want to silently route into a row we cannot read.
    }
  }

  const active = decoded.filter((a) => !a.is_archived);

  function pickByName(targets: string[]): Decoded | null {
    const lowered = targets.map((t) => t.toLowerCase());
    return active.find((a) => lowered.includes(a.account_name.trim().toLowerCase())) ?? null;
  }

  let revenue = pickByName(['Uncategorized Revenue', 'Uncategorized Income']);
  let expense = pickByName(['Uncategorized Expense', 'Uncategorized Expenses']);

  if (!revenue) {
    const newName = 'Uncategorized Revenue';
    const newId = await createAccountRow(orgId, newName, 'INCOME', '4999', encryptText);
    revenue = {
      id: newId,
      account_code: '4999',
      account_type: 'INCOME',
      account_name: newName,
      is_archived: false,
    };
  }
  if (!expense) {
    const newName = 'Uncategorized Expense';
    const newId = await createAccountRow(orgId, newName, 'EXPENSE', '5999', encryptText);
    expense = {
      id: newId,
      account_code: '5999',
      account_type: 'EXPENSE',
      account_name: newName,
      is_archived: false,
    };
  }

  return {
    revenueName: revenue.account_name,
    expenseName: expense.account_name,
    revenueRowId: revenue.id,
    expenseRowId: expense.id,
  };
}

/**
 * Insert a fresh chart_of_accounts row. Mirrors the Admin "Add Account"
 * pattern (see Admin.tsx handleAdd), we do NOT call the ledger's createAccount
 * here because the manual-add flow doesn't either; the legacy ledger account id is a
 * random UUID stored alongside the encrypted metadata, and the ledger
 * functions in OWB read from chart_of_accounts directly.
 */
async function createAccountRow(
  orgId: string,
  name: string,
  type: 'INCOME' | 'EXPENSE',
  code: string,
  encryptText: EncryptFn,
): Promise<string> {
  const enc = await encryptChartOfAccount(
    {
      account_name: name,
      account_code: code,
      account_type: type,
      account_group: type === 'INCOME' ? 'Uncategorized Income' : 'Uncategorized Expenses',
      account_category: null,
      is_archived: false,
    },
    encryptText,
  );
  const { data, error } = await supabase
    .from('chart_of_accounts')
    .insert({
      org_id: orgId,
      ...enc,
    } as any)
    .select('id')
    .single();
  if (error) throw error;
  if (!data) throw new Error('createAccountRow returned no row');
  return (data as { id: string }).id;
}

/**
 * Check whether a (account_id, or_external_id) pair has already been imported.
 *
 * We use JSONB containment (`@>`) on encrypted_metadata to filter server-side.
 * The metadata contains the OR-side opaque tx id plus the source tag; the
 * combination is unique because OR's external_id is itself unique within a
 * connection. Returns true when an existing row matches.
 */
async function hasExistingImport(
  walletId: string,
  orConnectionId: string,
  orTxId: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from('transactions')
    .select('id')
    .eq('account_id', walletId)
    .contains('encrypted_metadata', {
      source: SOURCE_TAG,
      or_connection_id: orConnectionId,
      or_external_id: orTxId,
    } as any)
    .limit(1)
    .maybeSingle();
  if (error) {
    // PGRST116 (no rows) is reported as error by some Supabase clients; treat
    // it as "no match". Other errors propagate so the bridge can surface them.
    if ((error as any).code === 'PGRST116') return false;
    throw error;
  }
  return !!data;
}

/**
 * Persist a single OR transaction as (1) an OWB transactions row + (2) a
 * balanced journal entry pair. Idempotency-checked per call.
 */
async function importSingleTx(
  orTx: DecryptedOrTx,
  destWallet: DestinationWallet,
  uncategorized: {
    revenueName: string;
    expenseName: string;
    revenueRowId: string;
    expenseRowId: string;
  },
  params: ImportOrTransactionsParams,
): Promise<'imported' | 'duplicate'> {
  const { orgId, orConnectionId, primaryCurrency, encryptText } = params;

  if (await hasExistingImport(destWallet.id, orConnectionId, orTx.id)) {
    return 'duplicate';
  }

  const txDate = (orTx.timestamp | new Date().toISOString()).split('T')[0];
  const { amount: rawAmount, asset } = computeAmount(orTx, destWallet.asset);
  // Statement popup uses signed amounts: + inflow, − outflow. Mirror that
  // sign convention so the wallet ledger reads correctly.
  const signedAmount = orTx.direction === 'in' ? Math.abs(rawAmount) : -Math.abs(rawAmount);
  const memo = orTx.description | orTx.counterparty | orTx.type | '';
  const orSourceMeta = buildOrSourceMetadata(orConnectionId, orTx.id);

  // ── 1. transactions row ─────────────────────────────────────────────────
  const encTx = await encryptTransaction(
    {
      memo,
      amount: signedAmount,
      usd_value: null,
      exchange_rate: null,
      asset,
      type: orTx.type || 'transfer',
      status: orTx.status || 'complete',
      cleared_status: 'CLEARED',
    },
    encryptText,
  );
  // Pre-pick the chart-of-accounts row matching the direction so the Edit
  // Transaction modal can restore the dropdown value on later edit.
  const isInflowForAcct = orTx.direction === 'in';
  const accountRowId = isInflowForAcct ? uncategorized.revenueRowId : uncategorized.expenseRowId;
  const { error: txErr } = await supabase.from('transactions').insert({
    org_id: orgId,
    account_id: destWallet.id,
    account_id: accountRowId,
    date: txDate,
    encrypted_metadata: orSourceMeta as any,
    ...encTx,
  } as any);
  if (txErr) throw txErr;

  // ── 2. journal entry + balanced lines ───────────────────────────────────
  // DR/CR convention:
  //   inflow   → DR <wallet> / CR <Uncategorized Revenue>
  //   outflow  → DR <Uncategorized Expense> / CR <wallet>
  const isInflow = orTx.direction === 'in';
  const absAmount = Math.abs(rawAmount);

  const encJe = await encryptJournalEntry(
    {
      memo: `${isInflow ? 'Inflow' : 'Outflow'}, ${destWallet.name}${memo ? `, ${memo}` : ''}`,
      ref_number: null,
      currency: asset,
      exchange_rate: null,
      status: 'POSTED',
      source_type: 'orangerails',
      period_locked: false,
    },
    encryptText,
  );
  const { data: je, error: jeErr } = await supabase
    .from('journal_entries')
    .insert({
      org_id: orgId,
      date: txDate,
      // Mirror the dedup tag on the JE so a future reconciliation tool can
      // walk back from JE → OR transaction without inspecting line metadata.
      encrypted_metadata: orSourceMeta as any,
      ...encJe,
    } as any)
    .select('id')
    .single();
  if (jeErr) throw jeErr;
  if (!je) throw new Error('Journal entry insert returned no row');

  const walletLineDebit = isInflow ? absAmount : 0;
  const walletLineCredit = isInflow ? 0 : absAmount;
  const counterLineDebit = isInflow ? 0 : absAmount;
  const counterLineCredit = isInflow ? absAmount : 0;
  const counterAccountName = isInflow ? uncategorized.revenueName : uncategorized.expenseName;

  const walletLine = await buildJournalEntryLineInsert({
    wallet_currency: asset,
    primary_currency: primaryCurrency,
    date: txDate,
    debit: walletLineDebit,
    credit: walletLineCredit,
    account_name: destWallet.name,
    description: memo | null,
    encrypt: encryptText,
  });
  const counterLine = await buildJournalEntryLineInsert({
    wallet_currency: asset,
    primary_currency: primaryCurrency,
    date: txDate,
    debit: counterLineDebit,
    credit: counterLineCredit,
    account_name: counterAccountName,
    description: memo | null,
    encrypt: encryptText,
  });

  const { error: lineErr } = await supabase.from('journal_entry_lines').insert([
    { journal_entry_id: (je as any).id, ...walletLine.insert },
    { journal_entry_id: (je as any).id, ...counterLine.insert },
  ] as any);
  if (lineErr) throw lineErr;

  return 'imported';
}

/**
 * Bridge entry point, call after or-sync completes. Walks the decrypted OR
 * transactions, routes each to its destination wallet via mappings, and
 * idempotently writes the OWB transactions + JE pair.
 *
 * Per-transaction errors are collected and reported in the result; one bad
 * row never aborts the whole batch.
 */
export async function importOrTransactionsToV3(
  params: ImportOrTransactionsParams,
): Promise<ImportOrTransactionsResult> {
  const { orgId, orConnectionId, orTxs, mappings, walletsById, encryptText, decryptText } = params;
  const result: ImportOrTransactionsResult = {
    inspected: orTxs.length,
    imported: 0,
    unrouted: 0,
    duplicates: 0,
    errors: [],
  };
  if (orTxs.length === 0) return result;

  // Build a small (or_connection_id::or_external_wallet_id) → OWB wallet id
  // index from the mappings filtered to this connection.
  const mappingIndex = new Map<string, string[]>();
  for (const m of mappings) {
    if (!m.is_active) continue;
    if (m.or_connection_id !== orConnectionId) continue;
    const key = `${m.or_connection_id}::${m.or_external_wallet_id}`;
    const arr = mappingIndex.get(key);
    if (arr) arr.push(m.external_account_id);
    else mappingIndex.set(key, [m.external_account_id]);
  }

  // Resolve uncategorized accounts ONCE per batch (avoids re-decrypting the
  // chart of accounts for every transaction). Failure propagates because
  // without these we can't post any JE pair.
  const uncategorized = await ensureUncategorizedAccounts(orgId, encryptText, decryptText);

  // Pre-batch the duplicate check. Previously importSingleTx ran an
  // N-query hasExistingImport per tx (3-4ms each on warm cache); on a
  // few-hundred-tx connection that dominated the runtime. findImportedOrTxIds
  // does the same lookup as one query across all mapped wallets and returns
  // the set of OR external ids already in the ledger, so importSingleTx can
  // short-circuit without touching the network.
  const mappedWalletIds = Array.from(new Set(Array.from(mappingIndex.values()).flat()));
  let alreadyImported: Set<string>;
  try {
    alreadyImported = await findImportedOrTxIds(
      mappedWalletIds,
      orConnectionId,
      orTxs.map((t) => t.id),
    );
  } catch (err) {
    // Falling back to the per-tx check is safe, slower but correct.
    console.warn('[orImportBridge] pre-batch dedup query failed, falling back per-tx:', err);
    alreadyImported = new Set();
  }

  for (const orTx of orTxs) {
    try {
      const destWalletId = resolveDestinationWalletId(orTx, orConnectionId, mappingIndex);
      if (!destWalletId) {
        result.unrouted++;
        continue;
      }
      const destWallet = walletsById.get(destWalletId);
      if (!destWallet) {
        // Mapping points at a wallet we don't have decrypted (perhaps deleted
        // or undecryptable). Report as error so the user investigates.
        result.errors.push({
          orTxId: orTx.id,
          error: `Mapped wallet ${destWalletId} not found or unreadable in OWB`,
        });
        continue;
      }
      // Pre-batched skip, avoids the per-tx hasExistingImport network call
      // for txs we already know are in the ledger. Per-tx check still runs
      // inside importSingleTx as a belt-and-braces guard against races.
      if (alreadyImported.has(orTx.id)) {
        result.duplicates++;
        continue;
      }
      const outcome = await importSingleTx(orTx, destWallet, uncategorized, params);
      if (outcome === 'imported') result.imported++;
      else result.duplicates++;
    } catch (err) {
      result.errors.push({
        orTxId: orTx.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}

/**
 * Helper used by TransactionList to render a "in ledger" badge, given a set
 * of OR external_ids, returns the subset that already has a corresponding
 * OWB transactions row imported by this bridge.
 *
 * Implemented as a single batched query (one per call) so the badge column
 * doesn't N+1 the database when a connection has many transactions.
 */
export async function findImportedOrTxIds(
  walletIds: string[],
  orConnectionId: string,
  orExternalIds: string[],
): Promise<Set<string>> {
  const found = new Set<string>();
  if (walletIds.length === 0 || orExternalIds.length === 0) return found;

  // Two-stage server filter: first narrow by wallet_ids (cheap index), then
  // pull encrypted_metadata client-side and match the OR external ids. We
  // can't push the IN-list inside JSONB containment, so this is the simplest
  // correct approach for the small batches the Connections card displays
  // (TransactionList caps at 50 rows).
  const { data, error } = await supabase
    .from('transactions')
    .select('encrypted_metadata')
    .in('account_id', walletIds)
    .contains('encrypted_metadata', {
      source: SOURCE_TAG,
      or_connection_id: orConnectionId,
    } as any);
  if (error) {
    console.warn('[orImportBridge] findImportedOrTxIds query failed:', error);
    return found;
  }
  const wanted = new Set(orExternalIds);
  for (const row of (data as Array<{ encrypted_metadata: Record<string, string> | null }> | null) ??
    []) {
    const meta = row.encrypted_metadata;
    if (!meta) continue;
    const ext = typeof meta.or_external_id === 'string' ? meta.or_external_id : null;
    if (ext && wanted.has(ext)) found.add(ext);
  }
  return found;
}
