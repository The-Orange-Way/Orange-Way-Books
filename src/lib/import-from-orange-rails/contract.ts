/**
 * Orange Rails → OWB push contract — OWB-side copy.
 *
 * Mirrors `orangerails/src/connectors/contract.ts`. Kept in sync manually
 * until OR is published as an npm package consumable by OWB (then this file
 * gets deleted and we import from the package).
 *
 * Every OR connector (Wave, QuickBooks, future ShakePay / Wallet of Satoshi
 * / BlinkWallet) emits this JSON shape. OWB's "Import from Orange Rails"
 * wizard reads it, validates with `assertStagedImportPayload`, applies the
 * rows section-by-section through OWB's existing CSV ingestion code paths.
 *
 * The staged row keys match OWB's `ImportPreviewRow.data` exactly so OWB's
 * `src/lib/csv/*` validators and Admin/JournalEntries page commit handlers
 * accept these rows with zero translation.
 */

export const STAGED_IMPORT_CONTRACT_VERSION = 1;

/** Flat string map keyed by OWB CSV importer's lower_snake_case column key. */
export type V3StagedRow = Record<string, string>;

export type StagedImportPayload = {
  contractVersion: typeof STAGED_IMPORT_CONTRACT_VERSION;
  source: {
    /** Stable connector identifier, e.g. 'wave', 'quickbooks'. */
    name: string;
    /** OR connector version (semver) for diagnosing compatibility. */
    version: string;
    /** ISO-8601 timestamp the connector emitted the payload. */
    exportedAt: string;
  };
  orgHint?: {
    name?: string;
    currency?: string;
  };
  manifest: {
    files: Array<{
      name: string;
      sizeBytes: number;
      sha256?: string;
    }>;
  };
  summary: {
    accounts: number;
    contacts: number;
    journalEntries: number;
    journalLines: number;
    warnings: string[];
    errors: string[];
  };
  /**
   * Application order on commit:
   *   1. accounts  — must succeed (JE rows reference account codes)
   *   2. contacts  — independent
   *   3. journalEntries — depends on accounts existing
   */
  staged: {
    accounts?: V3StagedRow[];
    contacts?: V3StagedRow[];
    journalEntries?: V3StagedRow[];
  };
  reconciliation?: {
    accountClassifications?: Record<
      string,
      {
        type: string;
        subtype?: string;
        confidence: number;
      }
    >;
  };
};

export function assertStagedImportPayload(value: unknown): asserts value is StagedImportPayload {
  if (!value || typeof value !== 'object') {
    throw new Error('Staged import: payload is not an object.');
  }
  const v = value as Record<string, unknown>;
  if (v.contractVersion !== STAGED_IMPORT_CONTRACT_VERSION) {
    throw new Error(
      `Staged import: contractVersion ${String(v.contractVersion)} is not supported (expected ${STAGED_IMPORT_CONTRACT_VERSION}).`,
    );
  }
  const source = v.source as Record<string, unknown> | undefined;
  if (!source || typeof source.name !== 'string' || typeof source.version !== 'string') {
    throw new Error('Staged import: source.name / source.version are required strings.');
  }
  const summary = v.summary as Record<string, unknown> | undefined;
  if (!summary || typeof summary !== 'object') {
    throw new Error('Staged import: summary section is required.');
  }
  const staged = v.staged as Record<string, unknown> | undefined;
  if (!staged || typeof staged !== 'object') {
    throw new Error('Staged import: staged section is required (may have empty arrays).');
  }
  for (const key of ['accounts', 'contacts', 'journalEntries'] as const) {
    const arr = staged[key];
    if (arr !== undefined && !Array.isArray(arr)) {
      throw new Error(`Staged import: staged.${key} must be an array if present.`);
    }
  }
}

/**
 * Convert a staged section into the ImportPreviewRow[] shape that OWB's
 * existing commit handlers consume. The mapping is the identity on `data`
 * because the contract was designed to match `ImportPreviewRow.data` keys
 * exactly — this helper just adds the `rowIndex` field.
 */
export function stagedRowsToPreview(
  rows: V3StagedRow[],
): Array<{ rowIndex: number; data: V3StagedRow }> {
  return rows.map((data, i) => ({ rowIndex: i, data }));
}
