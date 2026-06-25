import { parseCsvText } from './parse-csv-row';
import type { ImportPreviewRow } from '@/components/ui/import-popup';

/** Same column order as journal CSV export (`JournalEntries` / `buildJournalExportRows`). */
export const JOURNAL_CSV_HEADERS = [
  'JE date',
  'JE ref #',
  'JE memo',
  'JE status',
  'Account code',
  'Account name',
  'Line description',
  'Wallet Currency',
  'Debit',
  'Credit',
] as const;

export type JournalAccountLookup = { account_name: string; account_code: string | null };

/** Map export-style currency labels back to a ledger currency code. */
export function parseJournalCurrencyLabel(label: string): string {
  const s = label.trim();
  const u = s.toUpperCase();
  if (u.startsWith('SAT')) return 'SATS';
  if (u.includes('BTC') || u === 'BTC') return 'BTC';
  const first = s.split(/\s+/)[0]?.toUpperCase() ?? '';
  if (/^[A-Z]{3,4}$/.test(first)) return first === 'SAT' ? 'SATS' : first;
  return 'USD';
}

function recordToRowData(record: Record<string, string>): Record<string, string> {
  const data: Record<string, string> = {};
  for (const col of JOURNAL_CSV_HEADERS) {
    const fromFile = col.toLowerCase();
    const uiKey = fromFile.replace(/ /g, '_');
    data[uiKey] = (record[fromFile] ?? '').trim();
  }
  return data;
}

export function journalGroupKey(data: Record<string, string>): string {
  return [
    (data.je_date || '').trim(),
    (data['je_ref_#'] ?? '').trim(),
    (data.je_memo || '').trim(),
    (data.je_status || 'DRAFT').trim().toUpperCase(),
    parseJournalCurrencyLabel(data.wallet_currency || ''),
  ].join('\x1f');
}

/** Consecutive CSV rows that share the same journal header fields belong to one entry. */
export function groupJournalImportRows(rows: ImportPreviewRow[]): ImportPreviewRow[][] {
  const groups: ImportPreviewRow[][] = [];
  let buf: ImportPreviewRow[] = [];
  let bufKey = '';
  for (const r of rows) {
    const k = journalGroupKey(r.data);
    if (buf.length === 0) {
      buf = [r];
      bufKey = k;
      continue;
    }
    if (k === bufKey) buf.push(r);
    else {
      groups.push(buf);
      buf = [r];
      bufKey = k;
    }
  }
  if (buf.length) groups.push(buf);
  return groups;
}

/** Plain numeric parse for building inserts (commas allowed). */
export function parseJournalAmountCell(raw: string): number {
  const t = raw.replace(/,/g, '').trim();
  if (!t) return 0;
  const n = Number.parseFloat(t);
  return Number.isFinite(n) ? n : 0;
}

function parseAmountCell(raw: string): { ok: boolean; value: number; error?: string } {
  const t = raw.replace(/,/g, '').trim();
  if (!t) return { ok: true, value: 0 };
  const n = Number.parseFloat(t);
  if (!Number.isFinite(n)) return { ok: false, value: 0, error: `Invalid number: "${raw}"` };
  return { ok: true, value: n };
}

/**
 * Parse journal CSV (same shape as export). Consecutive rows sharing
 * date / ref / memo / status / currency form one journal entry.
 */
export function parseCsvJournalEntries(
  csvText: string,
  accounts: JournalAccountLookup[],
): { rows: ImportPreviewRow[]; errors: string[] } {
  const errors: string[] = [];
  const { headers, rows: parsed } = parseCsvText(csvText);
  if (parsed.length === 0) {
    errors.push('CSV file is empty or has no data rows.');
    return { rows: [], errors };
  }

  const headerLower = new Set(headers.map((h) => h.toLowerCase()));
  if (!headerLower.has('je date') || !headerLower.has('wallet currency')) {
    errors.push(
      'CSV must include "JE date" and "Wallet Currency" columns. Download the sample file to match the format.',
    );
    return { rows: [], errors };
  }

  const accountNames = new Set(accounts.map((a) => a.account_name.toLowerCase()));

  const rows: ImportPreviewRow[] = parsed.map((record, i) => {
    const data = recordToRowData(record);
    const rowErrors: string[] = [];

    if (!data.je_date) rowErrors.push('JE date is required');
    if (!data.wallet_currency) rowErrors.push('Wallet Currency is required');

    const debitP = parseAmountCell(data.debit);
    const creditP = parseAmountCell(data.credit);
    if (!debitP.ok) rowErrors.push(debitP.error!);
    if (!creditP.ok) rowErrors.push(creditP.error!);

    const hasDebit = debitP.ok && debitP.value > 0;
    const hasCredit = creditP.ok && creditP.value > 0;
    if (hasDebit && hasCredit) {
      rowErrors.push('Put amount in either Debit or Credit, not both on the same line');
    }
    if ((hasDebit || hasCredit) && !data.account_name?.trim()) {
      rowErrors.push('Account name is required when there is a Debit or Credit amount');
    }
    if ((data.account_name?.trim() && hasDebit) || hasCredit) {
      if (!accountNames.has(data.account_name.trim().toLowerCase())) {
        rowErrors.push(
          `Account "${data.account_name.trim()}" not found. Use Admin > Chart of Accounts names.`,
        );
      }
    }

    return {
      rowIndex: i + 1,
      data,
      error: rowErrors.length ? rowErrors.join(' ') : undefined,
    };
  });

  const groups = groupJournalImportRows(rows);

  for (const g of groups) {
    if (g.some((r) => r.error)) continue;
    let sumD = 0;
    let sumC = 0;
    let linesWithAmount = 0;
    for (const r of g) {
      const d = parseAmountCell(r.data.debit).value;
      const c = parseAmountCell(r.data.credit).value;
      if (d > 0 || c > 0) linesWithAmount++;
      sumD += d;
      sumC += c;
    }
    const balanced = Math.abs(sumD - sumC) < 0.000001 && sumD > 0;
    if (linesWithAmount === 0) {
      const msg = 'This journal block has no lines with a Debit or Credit amount.';
      for (const r of g) {
        if (!r.error) r.error = msg;
      }
      continue;
    }
    if (!balanced) {
      const msg = `This journal entry does not balance (debits ${sumD.toFixed(2)} vs credits ${sumC.toFixed(2)}). Fix the amounts for rows with the same date, ref #, memo, status, and currency.`;
      for (const r of g) {
        if (!r.error) r.error = msg;
      }
    }
  }

  return { rows, errors };
}

/** Same shape as export; uses account names from the chart-of-accounts sample so a fresh org can round-trip after COA import. */
export const JOURNAL_SAMPLE_CSV = `JE date,JE ref #,JE memo,JE status,Account code,Account name,Line description,Wallet Currency,Debit,Credit
2026-01-15,JE-SAMPLE-01,Opening balance import sample,DRAFT,,Cash on Hand,Seed row,USD,1000.00,
2026-01-15,JE-SAMPLE-01,Opening balance import sample,DRAFT,,Sales Revenue,Offset,USD,,1000.00`;
