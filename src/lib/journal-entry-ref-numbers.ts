/**
 * Journal entry ref_number + import-idempotency helpers (P5, ZKA-aware).
 *
 * Why this exists:
 *   - OWB stores journal_entries.ref_number as AES-GCM ciphertext at L2
 *     (see crypto-fields.ts:319-321). A UNIQUE INDEX on ref_number cannot
 *     enforce idempotency because the same plaintext encrypts to different
 *     ciphertext each call.
 *   - The fix is an HMAC blind index column (hmac_import_external_id),
 *     following the precedent set by contacts.hmac_name and
 *     transactions.hmac_type/hmac_asset (migration 20260421120000).
 *
 * Two kinds of ref_number values:
 *
 *   1. Internal, minted: 'JE-2025-0042'
 *        produced by mintInternalJeRefNumber() via the next_je_ref_number
 *        SECURITY DEFINER RPC. The returned plaintext is then encrypted
 *        into journal_entries.ref_number by the caller.
 *
 *   2. Externally-sourced: 'WAVE-1402433495770403519' / 'QB-abc-123' /
 *      'OR-x7k2m9' / 'OPEN-BAL-2024-01-01'
 *        produced by buildImportRefNumber() (or buildOpeningBalanceRefNumber
 *        for the P4 opening-balance JE). The HUMAN-READABLE label is
 *        encrypted into journal_entries.ref_number. Separately,
 *        computeImportExternalIdHmac() produces a deterministic HMAC that
 *        is stored plaintext in hmac_import_external_id; the unique index
 *        on (org_id, hmac_import_external_id) does the dedup.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

// ── Source taxonomy ──────────────────────────────────────────────────────────

/** Sources that produce externally-identified journal entries. */
export type ImportSource = 'wave' | 'quickbooks' | 'orange_rails';

const SOURCE_PREFIX: Record<ImportSource, string> = {
  wave: 'WAVE',
  quickbooks: 'QB',
  orange_rails: 'OR',
};

// ── Human-readable ref_number labels (these get encrypted into the DB) ───────

/**
 * Build the ref_number label for a source-imported JE.
 *
 * The returned string is the human-readable identifier. The caller must
 * still encrypt it via encryptJournalEntry() before insert.
 *
 * @example
 *   buildImportRefNumber('wave', '1402433495770403519') === 'WAVE-1402433495770403519'
 */
export function buildImportRefNumber(source: ImportSource, externalId: string): string {
  if (!externalId || externalId.length === 0) {
    throw new Error('buildImportRefNumber: externalId required');
  }
  return `${SOURCE_PREFIX[source]}-${externalId}`;
}

/**
 * Build the ref_number label for an opening-balance JE on a given date.
 *
 * The returned string is the human-readable identifier. The caller must
 * still encrypt it via encryptJournalEntry() before insert.
 *
 * @example
 *   buildOpeningBalanceRefNumber('2024-01-01') === 'OPEN-BAL-2024-01-01'
 */
export function buildOpeningBalanceRefNumber(date: string): string {
  // Trim time component if a full timestamp was passed.
  const d = date.slice(0, 10);
  return `OPEN-BAL-${d}`;
}

/**
 * Parse a decrypted ref_number string back into (source, externalId).
 * Returns null for internal/manual refs that don't match the import shape.
 */
export function parseImportRefNumber(
  refNumber: string,
): { source: ImportSource; externalId: string } | null {
  for (const [source, prefix] of Object.entries(SOURCE_PREFIX) as [ImportSource, string][]) {
    if (refNumber.startsWith(`${prefix}-`)) {
      return { source, externalId: refNumber.slice(prefix.length + 1) };
    }
  }
  return null;
}

// ── HMAC blind-index input (this is what gets HMAC'd) ────────────────────────

/**
 * Build the canonical INPUT STRING for the hmac_import_external_id column.
 *
 * This string is fed into VaultContext.blindIndex() to produce the actual
 * HMAC value stored in the DB. The HMAC helper normalizes (trim + lowercase)
 * before signing, so the casing here doesn't matter, but we use a consistent
 * lowercase format for clarity.
 *
 * Same input → same HMAC → the unique index catches duplicates regardless of
 * how many times an import runs.
 *
 * @example
 *   buildImportHmacInput('wave', '1402433495770403519') === 'wave-1402433495770403519'
 *   buildOpeningBalanceHmacInput('2024-01-01') === 'open-bal-2024-01-01'
 */
export function buildImportHmacInput(source: ImportSource, externalId: string): string {
  if (!externalId || externalId.length === 0) {
    throw new Error('buildImportHmacInput: externalId required');
  }
  return `${source}-${externalId}`.toLowerCase();
}

export function buildOpeningBalanceHmacInput(date: string): string {
  return `open-bal-${date.slice(0, 10)}`.toLowerCase();
}

/**
 * Convenience: compute the HMAC blind index for an import.
 *
 * `blindIndex` is the function exposed by VaultContext (see
 * VaultContext.tsx:791). It returns a base64-encoded HMAC-SHA256 string
 * using the org's blind-index key (derived from MEK via HKDF, stable
 * across password changes).
 */
export async function computeImportExternalIdHmac(
  blindIndex: (value: string | null | undefined) => Promise<string | null>,
  source: ImportSource,
  externalId: string,
): Promise<string | null> {
  return blindIndex(buildImportHmacInput(source, externalId));
}

export async function computeOpeningBalanceHmac(
  blindIndex: (value: string | null | undefined) => Promise<string | null>,
  date: string,
): Promise<string | null> {
  return blindIndex(buildOpeningBalanceHmacInput(date));
}

// ── Server-side RPC wrappers ─────────────────────────────────────────────────

/**
 * Atomically mint the next internal JE ref_number for an org-year.
 *
 * Returns the PLAINTEXT label (e.g. 'JE-2025-0042'). The caller must
 * encrypt it via encryptJournalEntry() before insert into
 * journal_entries.ref_number.
 */
export async function mintInternalJeRefNumber(
  supabase: SupabaseClient,
  orgId: string,
  year: number,
): Promise<string> {
  if (year < 1900 || year > 2999) {
    throw new Error(`mintInternalJeRefNumber: year out of range (${year})`);
  }
  const { data, error } = await supabase.rpc('next_je_ref_number', {
    p_org_id: orgId,
    p_year: year,
  });
  if (error) {
    throw new Error(`next_je_ref_number RPC failed: ${error.message}`);
  }
  if (typeof data !== 'string' || data.length === 0) {
    throw new Error('next_je_ref_number returned empty value');
  }
  return data;
}

/**
 * Delete all journal_entries created by a given import_job.
 * Journal_entry_lines cascade via FK. Audit logging is the caller's
 * responsibility (ZKA: summary must be encrypted browser-side).
 */
export async function purgeImportJobArtifacts(
  supabase: SupabaseClient,
  importJobId: string,
): Promise<{ import_job_id: string; org_id: string; journal_entries_deleted: number }> {
  const { data, error } = await supabase.rpc('purge_import_job_artifacts', {
    p_import_job_id: importJobId,
  });
  if (error) {
    throw new Error(`purge_import_job_artifacts RPC failed: ${error.message}`);
  }
  if (!data || typeof data !== 'object') {
    throw new Error('purge_import_job_artifacts returned no data');
  }
  return data as { import_job_id: string; org_id: string; journal_entries_deleted: number };
}
