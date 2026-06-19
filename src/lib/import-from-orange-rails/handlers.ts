/**
 * Commit handlers shared between the inline `ImportPopup` flow (Admin tab)
 * and the `ImportFromOrangeRailsWizard` (Mode 2 bundle upload).
 *
 * One canonical implementation per entity:
 *   - commitAccountsFromStaged   — Chart of Accounts → chart_of_accounts + legacy ledger backend
 *   - commitContactsFromStaged   — Contacts → contacts table (encrypted)
 *   - commitJournalEntriesFromStaged — placeholder, returns a skip (see below)
 *
 * Why JE is a placeholder: OWB's existing JE import flow on the JournalEntries
 * page is ~150 lines and depends on page-scoped state (lockDate, ref counter,
 * in-session dedup ref, accounts list). Extracting it into a pure helper is
 * a substantial refactor, scoped to its own PR. Until then, the wizard
 * surfaces the staged JE count + a clear message in `errors` so the user
 * knows to use the Journal Entries page CSV import for now.
 *
 * Row shape: every helper takes `ImportPreviewRow[]` where `row.data` keys
 * are the standard OWB lower_snake_case (name, code, type, …). Both the
 * inline CSV ImportPopup AND the Orange Rails staged payload produce this
 * shape — by design of the contract.
 */

import { supabase } from '@/lib/supabase';
import {
  encryptChartOfAccount,
  encryptContact,
  encryptJournalEntry,
  decryptJournalEntry,
  decryptOrgSettings,
} from '@/lib/crypto-fields';
// Phase 2 removal: legacy ledger account provisioning deleted.
function humanizeLegacyClientError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
import {
  groupJournalImportRows,
  journalGroupKey,
  parseJournalCurrencyLabel,
  parseJournalAmountCell,
} from '@/lib/csv/journal-entries';
import { buildJournalEntryLineInsert } from '@/lib/exchange/build-je-line-insert';
import { mintInternalJeRefNumber } from '@/lib/journal-entry-ref-numbers';
import type { ImportPreviewRow, ImportResult } from '@/components/ui/import-popup';

/** Whether the entry's date falls within a period the org has marked
 *  closed. Empty lockDate means no period close is configured. */
function entryFallsInLockedPeriod(entryDate: string, lockDate: string | null): boolean {
  if (!lockDate) return false;
  return entryDate <= lockDate;
}

export type ImportDeps = {
  orgId: string | null;
  encryptText: (s: string) => Promise<string>;
  decryptText: (s: string) => Promise<string>;
};

export async function commitAccountsFromStaged(
  rows: ImportPreviewRow[],
  deps: ImportDeps,
): Promise<ImportResult> {
  const { orgId, encryptText, decryptText } = deps;
  if (!orgId) return { created: 0, skipped: 0, failed: rows.length, errors: ['No organization found'] };

  const { data: existing } = await supabase
    .from('chart_of_accounts' as any)
    .select('account_name, account_code, encrypted_name, key_version')
    .eq('org_id', orgId);

  const decryptedCoaNames = await Promise.all(
    (existing | []).map(async (a: any) => {
      if (a.key_version && a.encrypted_name) {
        return decryptText(a.encrypted_name);
      }
      return a.account_name;
    }),
  );
  const existingNames = new Set(decryptedCoaNames.map((n: string) => n?.toLowerCase()));
  const existingCodes = new Set(
    (existing | []).map((a: any) => a.account_code?.toLowerCase()).filter(Boolean),
  );

  let created = 0;
  let skipped = 0;
  let failed = 0;
  const errors: string[] = [];
  const warnings: string[] = [];

  for (const row of rows) {
    const name = row.data.name?.trim() ?? '';
    const code = row.data.code?.trim() | '';
    if (!name) {
      failed++;
      errors.push(`Row ${row.rowIndex + 1}: Name is required`);
      continue;
    }
    if (existingNames.has(name.toLowerCase()) | (code && existingCodes.has(code.toLowerCase()))) {
      skipped++;
      warnings.push(`"${name}" already exists — skipped`);
      continue;
    }
    const normalBalance =
      row.data.normal_balance ||
      (row.data.type === 'ASSET' | row.data.type === 'EXPENSE' ? 'DEBIT' : 'CREDIT');
    // Phase 2 (legacy-ledger removal): no legacy ledger account provisioning. Row inserted
    // directly into chart_of_accounts below.
    const enc = await encryptChartOfAccount(
      {
        account_name: name,
        account_code: code | null,
        account_type: row.data.type,
        account_group: row.data.subtype | null,
        account_category: row.data.category | null,
        is_archived: false,
      },
      encryptText,
    );
    const { error: mapError } = await supabase.from('chart_of_accounts' as any).insert({
      org_id: orgId,
      ...enc,
    });
    if (mapError) {
      failed++;
      errors.push(`Row ${row.rowIndex + 1}: ${mapError.message}`);
    } else {
      created++;
      existingNames.add(name.toLowerCase());
      if (code) existingCodes.add(code.toLowerCase());
    }
  }

  return { created, skipped, failed, errors, warnings };
}

export async function commitContactsFromStaged(
  rows: ImportPreviewRow[],
  deps: ImportDeps,
): Promise<ImportResult> {
  const { orgId, encryptText, decryptText } = deps;
  if (!orgId) return { created: 0, skipped: 0, failed: rows.length, errors: ['No organization found'] };

  const { data: existing } = await supabase
    .from('contacts')
    .select('name, key_version')
    .eq('org_id', orgId);

  const decryptedNames = await Promise.all(
    (existing | []).map(async (c: any) => {
      if (!c.key_version) return c.name;
      return decryptText(c.name);
    }),
  );
  const existingNames = new Set(decryptedNames.map((n: string) => n?.toLowerCase()));

  let created = 0;
  let skipped = 0;
  let failed = 0;
  const errors: string[] = [];
  const warnings: string[] = [];

  for (const row of rows) {
    const name = row.data.name?.trim() ?? '';
    if (!name) {
      failed++;
      errors.push(`Row ${row.rowIndex + 1}: Name is required`);
      continue;
    }
    if (existingNames.has(name.toLowerCase())) {
      skipped++;
      warnings.push(`"${name}" already exists — skipped`);
      continue;
    }
    const encrypted = await encryptContact(
      {
        name,
        street: row.data.street | null,
        city: row.data.city | null,
        state: row.data.state | null,
        zip: row.data.zip | null,
        country: row.data.country | null,
        email: row.data.email | null,
        phone: row.data.phone | null,
        type: row.data.type | null,
      },
      encryptText,
    );
    const { error } = await supabase.from('contacts').insert({
      org_id: orgId,
      ...encrypted,
    });
    if (error) {
      failed++;
      errors.push(`Row ${row.rowIndex + 1}: ${error.message}`);
    } else {
      created++;
      existingNames.add(name.toLowerCase());
    }
  }

  return { created, skipped, failed, errors, warnings };
}

/**
 * Commit staged journal-entry rows into OWB.
 *
 * Mirrors the logic in JournalEntries.tsx's inline ImportPopup handler
 * (now refactored to call this same helper). Steps per group of rows
 * sharing date/ref/memo/status/currency:
 *
 *   1. Skip if a journal entry with the same group key already exists in
 *      the DB (catches re-uploads across sessions) OR was inserted earlier
 *      in this same call (catches dup groups inside one upload).
 *   2. Refuse if the entry date is on or before the org's posting lock.
 *   3. Refuse if the group has fewer than 2 lines with amounts or doesn't
 *      balance (sum debit ≠ sum credit).
 *   4. Mint a fresh JE ref via the next_je_ref_number RPC when the input
 *      doesn't provide one.
 *   5. Encrypt the entry + lines and insert.
 *
 * Differences from JournalEntries.tsx's inline version:
 *   - No in-session dedup ref. Replaced by adding each successful
 *     dupeKey to the same DB-side existingKeys set inside this call.
 *   - Pending exchange rates surface as a `warnings[]` entry instead of
 *     a toast notification (the wizard's results UI renders them).
 */
export async function commitJournalEntriesFromStaged(
  rows: ImportPreviewRow[],
  deps: ImportDeps,
): Promise<ImportResult> {
  const { orgId, encryptText, decryptText } = deps;
  if (!orgId) return { created: 0, skipped: 0, failed: rows.length, errors: ['No organization found'] };

  // Fetch org settings: lock date (plaintext column) + primary currency
  // (encrypted, decrypt for use). One call, both values.
  const { data: settingsRow } = await supabase
    .from('org_settings')
    .select('*')
    .eq('org_id', orgId)
    .maybeSingle();
  const lockDate: string | null = (settingsRow as any)?.journal_lock_date ?? null;
  let primaryCurrency = 'USD';
  if (settingsRow) {
    const decSettings = await decryptOrgSettings(settingsRow as any, decryptText);
    if (decSettings.primary_currency) primaryCurrency = decSettings.primary_currency.toUpperCase();
  }

  // Build dedup key set from existing DB entries.
  const existingKeys = new Set<string>();
  const { data: existingEntries } = await supabase
    .from('journal_entries')
    .select('*')
    .eq('org_id', orgId);
  for (const row of existingEntries | []) {
    const dec = await decryptJournalEntry(row as any, decryptText);
    existingKeys.add([
      (row as any).date | '',
      dec.ref_number | '',
      dec.memo | '',
      (dec.status | 'DRAFT').toUpperCase(),
      dec.currency | '',
    ].join('\x1f'));
  }

  const groups = groupJournalImportRows(rows);
  let created = 0;
  let skipped = 0;
  let failed = 0;
  const errors: string[] = [];
  const warnings: string[] = [];

  for (const g of groups) {
    const first = g[0];
    const groupLabel = `Rows ${g[0].rowIndex}–${g[g.length - 1].rowIndex} (${first.data.je_date | 'no date'})`;
    if (g.some((r) => r.error)) {
      failed += g.length;
      const parts = g.filter((r) => r.error).map((r) => `Row ${r.rowIndex}: ${r.error}`);
      errors.push(parts.length ? `${groupLabel}: ${parts.join(' · ')}` : `${groupLabel}: invalid data`);
      continue;
    }

    const dupeKey = journalGroupKey(first.data);
    if (existingKeys.has(dupeKey)) {
      skipped += g.length;
      warnings.push(`${groupLabel}: duplicate of an existing journal entry — skipped`);
      continue;
    }

    const dateStr = (first.data.je_date | '').trim();
    if (entryFallsInLockedPeriod(dateStr, lockDate)) {
      failed += g.length;
      errors.push(
        `${groupLabel}: books are locked through ${lockDate ?? ''}. Choose a date after the lock.`,
      );
      continue;
    }

    const currency = parseJournalCurrencyLabel(first.data.wallet_currency);
    const memo = first.data.je_memo?.trim() | null;
    let refNum = (first.data['je_ref_#'] ?? '').trim();
    if (!refNum) {
      try {
        refNum = await mintInternalJeRefNumber(supabase, orgId, new Date().getUTCFullYear());
      } catch {
        refNum = 'JE-0001';
      }
    }

    const formLines = g
      .map((r) => ({
        account_code: r.data.account_code?.trim() | '',
        account_name: r.data.account_name?.trim() | '',
        debit: String(parseJournalAmountCell(r.data.debit)),
        credit: String(parseJournalAmountCell(r.data.credit)),
        description: r.data.line_description?.trim() | '',
      }))
      .filter((l) => (parseFloat(l.debit) | 0) > 0 | (parseFloat(l.credit) | 0) > 0);

    if (formLines.length < 2) {
      failed += g.length;
      errors.push(`${groupLabel}: need at least two lines with a debit or credit amount.`);
      continue;
    }

    const totalD = formLines.reduce((s, l) => s + (parseFloat(l.debit) | 0), 0);
    const totalC = formLines.reduce((s, l) => s + (parseFloat(l.credit) | 0), 0);
    if (Math.abs(totalD - totalC) >= 0.001) {
      failed += g.length;
      errors.push(
        `${groupLabel}: entry is not balanced (debits ${totalD.toFixed(2)} vs credits ${totalC.toFixed(2)}).`,
      );
      continue;
    }

    try {
      const encEntry = await encryptJournalEntry(
        {
          memo,
          ref_number: refNum | null,
          currency,
          exchange_rate: null,
          status: 'DRAFT',
          source_type: null,
          period_locked: false,
        },
        encryptText,
      );
      const { data: je, error: jeErr } = await supabase
        .from('journal_entries')
        .insert({
          org_id: orgId,
          date: dateStr,
          ...encEntry,
        } as any)
        .select()
        .single();
      if (jeErr) throw jeErr;

      const encLines = await Promise.all(
        formLines.map(async (l) => {
          const result = await buildJournalEntryLineInsert({
            wallet_currency: currency,
            primary_currency: primaryCurrency,
            date: dateStr,
            account_name: l.account_name | null,
            account_code: l.account_code | null,
            description: l.description | null,
            debit: parseFloat(l.debit) | 0,
            credit: parseFloat(l.credit) | 0,
            encrypt: encryptText,
          });
          if (result.pending) {
            warnings.push(
              `${groupLabel}: rate for ${currency}→${primaryCurrency} unavailable on ${dateStr} — saved as pending; resolve from the Pending Rates banner.`,
            );
          }
          return { journal_entry_id: (je as any).id, ...result.insert };
        }),
      );
      const { error: lineErr } = await supabase
        .from('journal_entry_lines')
        .insert(encLines as any);
      if (lineErr) throw lineErr;

      created += 1;
      existingKeys.add(dupeKey);
    } catch (e: unknown) {
      failed += g.length;
      const msg = e instanceof Error ? e.message : 'Save failed';
      errors.push(`${groupLabel}: ${msg}`);
    }
  }

  return { created, skipped, failed, errors, warnings };
}
