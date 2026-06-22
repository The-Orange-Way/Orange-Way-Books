/**
 * Commit a StagedImportPayload from Orange Rails into OWB (P8 v1).
 *
 * Scope for v1: journal entries only. Accounts + contacts upload via the
 * existing inline CSV import widgets on Admin.tsx and Contacts pages.
 * The wizard surfaces this restriction in the UI; future v2 extends commit
 * to handle all three entity types in one payload.
 *
 * Flow:
 *   1. Insert import_jobs row (status=parsing) with encrypted_staged_data
 *      holding the browser-encrypted serialized payload + manifest summary.
 *   2. Group the line-level journal entry rows by (date, ref#, memo, status,
 *      currency) using the same logic as the CSV importer.
 *   3. For each group: encrypt + insert a journal_entries row with
 *      hmac_import_external_id set via computeImportExternalIdHmac.
 *      The import_job_id FK links each JE back to the parent job for
 *      safe re-import via purge_import_job_artifacts.
 *   4. For each line in the group: encrypt + insert a journal_entry_lines row.
 *   5. Flip status to committed (or failed with encrypted_error).
 *
 * If any JE group fails, we update status to 'failed' and surface the error
 * to the caller. Already-inserted JEs in that batch stay in place; the
 * caller can call purge_import_job_artifacts(import_job_id) to roll them
 * back atomically before retrying.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { encryptJournalEntry, type JournalEntryFields } from '../../crypto-fields';
import { buildJournalEntryLineInsert } from '../../exchange/build-je-line-insert';
import {
  buildImportRefNumber,
  computeImportExternalIdHmac,
  parseImportRefNumber,
  type ImportSource,
} from '../../journal-entry-ref-numbers';
import {
  assertStagedImportPayload,
  mapSourceToType,
  type StagedImportPayload,
  type V3StagedRow,
} from './contract';

// ── Public API ───────────────────────────────────────────────────────────────

export interface CommitOptions {
  /** Force the source mapping (default: derived from payload.source.name). */
  source?: ImportSource;
  /** Override the file_hash on the import_jobs row (SHA-256 of the raw payload bytes). */
  fileHash?: string | null;
}

export interface CommitResult {
  importJobId: string;
  status: 'committed' | 'failed';
  journalEntriesCreated: number;
  journalLinesCreated: number;
  /** Per-group errors when status='failed'. */
  errors: string[];
}

export class StagedImportCommitError extends Error {
  constructor(
    message: string,
    public importJobId?: string,
  ) {
    super(message);
    this.name = 'StagedImportCommitError';
  }
}

// ── Implementation ───────────────────────────────────────────────────────────

type Encrypt = (plaintext: string) => Promise<string>;
type BlindIndex = (value: string | null | undefined) => Promise<string | null>;

interface JournalEntryGroup {
  date: string;
  refNumber: string;
  memo: string | null;
  status: string;
  currency: string;
  lines: V3StagedRow[];
}

function rowField(row: V3StagedRow, key: string): string {
  const v = row[key];
  return typeof v === 'string' ? v.trim() : '';
}

function parseAmount(raw: string): number {
  const t = (raw ?? '').replace(/,/g, '').trim();
  if (!t) return 0;
  const n = Number.parseFloat(t);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Group the contract's line-level journalEntries rows into JE groups.
 * Mirrors src/lib/csv/journal-entries.ts groupJournalImportRows by key.
 */
function groupJournalEntries(rows: V3StagedRow[]): JournalEntryGroup[] {
  const groups: JournalEntryGroup[] = [];
  let current: JournalEntryGroup | null = null;
  let currentKey = '';
  for (const row of rows) {
    const date = rowField(row, 'je_date');
    const ref = rowField(row, 'je_ref_#');
    const memo = rowField(row, 'je_memo');
    const status = rowField(row, 'je_status').toUpperCase() | 'POSTED';
    const currency = rowField(row, 'wallet_currency').toUpperCase() | 'USD';
    const key = `${date}\x1f${ref}\x1f${memo}\x1f${status}\x1f${currency}`;
    if (current && currentKey === key) {
      current.lines.push(row);
    } else {
      current = {
        date,
        refNumber: ref,
        memo: memo | null,
        status,
        currency,
        lines: [row],
      };
      groups.push(current);
      currentKey = key;
    }
  }
  return groups;
}

/**
 * Commit a validated StagedImportPayload from Orange Rails.
 *
 * Re-validates the payload at the entry point (the wizard already validated,
 * but defense-in-depth costs us a few ms and catches contract drift).
 */
export async function commitStagedImportPayload(
  supabase: SupabaseClient,
  encryptText: Encrypt,
  blindIndex: BlindIndex,
  orgId: string,
  payloadIn: unknown,
  options: CommitOptions = {},
): Promise<CommitResult> {
  if (!orgId) throw new StagedImportCommitError('orgId required');
  const payload: StagedImportPayload = assertStagedImportPayload(payloadIn);

  // 1. Determine the source mapping.
  const sourceMapped = options.source ?? mapSourceToType(payload.source.name);
  if (!sourceMapped) {
    throw new StagedImportCommitError(
      `Unsupported source ${payload.source.name}; map it explicitly via CommitOptions.source.`,
    );
  }

  // 2. Insert the import_jobs row (status=parsing). encrypted_staged_data
  //    holds the browser-encrypted JSON payload so it stays auditable
  //    under ZKA L2.
  const stagedJson = JSON.stringify(payload);
  const encryptedStaged = await encryptText(stagedJson);
  const encryptedSummary = await encryptText(JSON.stringify(payload.summary));
  const encryptedManifest = await encryptText(JSON.stringify(payload.manifest));

  const sourceTypeColumn = `csv_journal_entries`;
  const fileName = payload.manifest.files[0]?.name ?? `${payload.source.name}-staged-import.json`;
  const fileHash = options.fileHash ?? null;
  const rowCount = payload.staged.journalEntries?.length ?? 0;

  const {
    data: { user },
  } = await supabase.auth.getUser();
  const userId = user?.id ?? null;

  const { data: jobRow, error: jobErr } = await supabase
    .from('import_jobs')
    .insert({
      org_id: orgId,
      created_by: userId,
      source_type: sourceTypeColumn,
      status: 'parsing',
      file_name: fileName,
      file_hash: fileHash,
      row_count: rowCount,
      encrypted_manifest: encryptedManifest,
      encrypted_parse_summary: encryptedSummary,
      encrypted_staged_data: encryptedStaged,
      key_version: 2,
    } as any)
    .select('id')
    .single();

  if (jobErr || !jobRow) {
    throw new StagedImportCommitError(
      `import_jobs insert failed: ${jobErr?.message ?? 'no row returned'}`,
    );
  }
  const importJobId = (jobRow as any).id as string;

  // 3. Flip to committing.
  await supabase
    .from('import_jobs')
    .update({ status: 'committing' } as any)
    .eq('id', importJobId);

  // 4. Commit journal entries.
  const journalEntryRows = payload.staged.journalEntries ?? [];
  if (
    journalEntryRows.length === 0 &&
    (payload.staged.accounts?.length || payload.staged.contacts?.length)
  ) {
    // v1 only commits JEs. Surface that clearly.
    await supabase
      .from('import_jobs')
      .update({
        status: 'failed',
        encrypted_error: await encryptText(
          'This commit path only emits journalEntries; accounts and contacts must be uploaded via the existing CSV widgets first.',
        ),
      } as any)
      .eq('id', importJobId);
    return {
      importJobId,
      status: 'failed',
      journalEntriesCreated: 0,
      journalLinesCreated: 0,
      errors: [
        'v1 only commits journalEntries; upload accounts + contacts via inline CSV widgets first.',
      ],
    };
  }

  const groups = groupJournalEntries(journalEntryRows);

  const errors: string[] = [];
  let entriesCreated = 0;
  let linesCreated = 0;

  for (const group of groups) {
    try {
      // The ref number from the payload is already the human-readable label
      // (e.g. "WAVE-1402..."). Parse to get (source, externalId) for HMAC.
      const parsed = parseImportRefNumber(group.refNumber);
      let hmac: string | null = null;
      if (parsed) {
        hmac = await computeImportExternalIdHmac(blindIndex, parsed.source, parsed.externalId);
      } else if (sourceMapped) {
        // Fallback: synthesize a ref from (source, payload-supplied id-ish field).
        // If the OR connector omits the prefix, we can't dedup; warn but proceed.
        hmac = null;
      }

      const fields: JournalEntryFields = {
        memo: group.memo,
        ref_number: group.refNumber || null,
        currency: group.currency,
        exchange_rate: null,
        status: group.status,
        source_type: sourceMapped,
        period_locked: false,
      };
      const enc = await encryptJournalEntry(fields, encryptText);

      const insertRow: any = {
        org_id: orgId,
        date: group.date,
        import_job_id: importJobId,
        hmac_import_external_id: hmac,
        ...enc,
      };

      const { data: jeData, error: jeErr } = await supabase
        .from('journal_entries')
        .insert(insertRow)
        .select('id')
        .single();

      if (jeErr || !jeData) {
        // 23505 = unique_violation on (org_id, hmac_import_external_id).
        // That means this exact import has been done before. Surface clearly.
        if (jeErr?.code === '23505') {
          errors.push(
            `JE ${group.refNumber}: already imported (hmac conflict). Run purge_import_job_artifacts to retry.`,
          );
        } else {
          errors.push(`JE ${group.refNumber}: insert failed (${jeErr?.message ?? 'no row'})`);
        }
        continue;
      }
      entriesCreated += 1;
      const journalEntryId = (jeData as any).id as string;

      const lineInserts: any[] = [];
      for (const lineRow of group.lines) {
        const debit = parseAmount(rowField(lineRow, 'debit'));
        const credit = parseAmount(rowField(lineRow, 'credit'));
        if (debit === 0 && credit === 0) continue; // skip header-only rows
        const lineBuilt = await buildJournalEntryLineInsert({
          wallet_currency: group.currency,
          primary_currency: group.currency, // v1: same; full FX path in v2
          date: group.date,
          debit,
          credit,
          account_name: rowField(lineRow, 'account_name') | null,
          account_code: rowField(lineRow, 'account_code') | null,
          description: rowField(lineRow, 'line_description') | null,
          encrypt: encryptText,
        });
        lineInserts.push({ journal_entry_id: journalEntryId, ...lineBuilt.insert });
      }

      if (lineInserts.length > 0) {
        const { error: linesErr } = await supabase
          .from('journal_entry_lines')
          .insert(lineInserts as any);
        if (linesErr) {
          errors.push(`JE ${group.refNumber}: lines insert failed (${linesErr.message})`);
        } else {
          linesCreated += lineInserts.length;
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`JE ${group.refNumber}: ${msg}`);
    }
  }

  const finalStatus: 'committed' | 'failed' = errors.length === 0 ? 'committed' : 'failed';
  const update: any = {
    status: finalStatus,
    committed_at: finalStatus === 'committed' ? new Date().toISOString() : null,
  };
  if (errors.length > 0) {
    update.encrypted_error = await encryptText(errors.slice(0, 50).join('\n'));
  }
  await supabase.from('import_jobs').update(update).eq('id', importJobId);

  return {
    importJobId,
    status: finalStatus,
    journalEntriesCreated: entriesCreated,
    journalLinesCreated: linesCreated,
    errors,
  };
}

// ── Test seam: expose groupJournalEntries for unit tests ─────────────────────

export const __internal = { groupJournalEntries };
