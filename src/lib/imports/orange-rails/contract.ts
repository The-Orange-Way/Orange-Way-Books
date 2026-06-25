/**
 * StagedImportPayload contract — mirror of Orange Rails OR → OWB push contract v1.
 *
 * Wire format is defined in this file.
 * Source-of-truth lives in MorningRevolution/orangerails on dev
 * (src/connectors/contract.ts). This file is the OWB-side consumer
 * declaration plus a runtime validator that mirrors assertStagedImportPayload.
 *
 * Why duplicate it here: OWB must not import from the OR package at runtime
 * (different repo, different build, ZKA boundary). Keep the type + validator
 * lock-step with OR via the spec doc — every contract version bump is a
 * documented change in both repos.
 */

export type V3StagedRow = Record<string, string>;

export interface StagedImportSource {
  /** Connector name: 'wave' | 'quickbooks' | 'plaid' | ... */
  name: string;
  /** OR connector semver. */
  version: string;
  /** ISO-8601 timestamp. */
  exportedAt: string;
}

export interface StagedImportManifestFile {
  name: string;
  sizeBytes: number;
  /** Optional SHA-256 hex digest of the raw file. */
  sha256?: string;
}

export interface StagedImportPayload {
  contractVersion: 1;
  source: StagedImportSource;
  orgHint?: { name?: string; currency?: string };
  manifest: {
    files: StagedImportManifestFile[];
  };
  summary: {
    accounts: number;
    contacts: number;
    journalEntries: number;
    journalLines: number;
    warnings: string[];
    errors: string[];
  };
  staged: {
    accounts?: V3StagedRow[];
    contacts?: V3StagedRow[];
    journalEntries?: V3StagedRow[];
  };
  reconciliation?: Record<string, unknown>;
}

export class StagedImportValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StagedImportValidationError';
  }
}

/**
 * Validate a parsed JSON object as a StagedImportPayload contract v1.
 * Throws StagedImportValidationError with a precise message on failure.
 * Returns the value cast to the contract type on success.
 */
export function assertStagedImportPayload(value: unknown): StagedImportPayload {
  if (!value || typeof value !== 'object') {
    throw new StagedImportValidationError('Payload is not an object');
  }
  const v = value as Record<string, unknown>;

  if (v.contractVersion !== 1) {
    throw new StagedImportValidationError(
      `Unsupported contractVersion: ${String(v.contractVersion)}. OWB only accepts version 1.`,
    );
  }

  // source
  const source = v.source as Record<string, unknown> | undefined;
  if (!source || typeof source !== 'object') {
    throw new StagedImportValidationError('source is required');
  }
  for (const k of ['name', 'version', 'exportedAt'] as const) {
    if (typeof source[k] !== 'string' || (source[k] as string).length === 0) {
      throw new StagedImportValidationError(`source.${k} must be a non-empty string`);
    }
  }

  // manifest
  const manifest = v.manifest as Record<string, unknown> | undefined;
  if (!manifest || !Array.isArray(manifest.files)) {
    throw new StagedImportValidationError('manifest.files must be an array');
  }
  for (let i = 0; i < manifest.files.length; i++) {
    const f = manifest.files[i] as Record<string, unknown>;
    if (!f || typeof f.name !== 'string' || typeof f.sizeBytes !== 'number') {
      throw new StagedImportValidationError(
        `manifest.files[${i}] must have name (string) + sizeBytes (number)`,
      );
    }
  }

  // summary
  const summary = v.summary as Record<string, unknown> | undefined;
  if (!summary || typeof summary !== 'object') {
    throw new StagedImportValidationError('summary is required');
  }
  for (const k of ['accounts', 'contacts', 'journalEntries', 'journalLines'] as const) {
    if (typeof summary[k] !== 'number') {
      throw new StagedImportValidationError(`summary.${k} must be a number`);
    }
  }
  if (!Array.isArray(summary.warnings) || !Array.isArray(summary.errors)) {
    throw new StagedImportValidationError('summary.warnings and summary.errors must be arrays');
  }

  // staged (all sub-arrays optional, but if present must be arrays of objects)
  const staged = v.staged as Record<string, unknown> | undefined;
  if (!staged || typeof staged !== 'object') {
    throw new StagedImportValidationError('staged is required');
  }
  for (const k of ['accounts', 'contacts', 'journalEntries'] as const) {
    if (staged[k] === undefined) continue;
    if (!Array.isArray(staged[k])) {
      throw new StagedImportValidationError(`staged.${k} must be an array (or omitted)`);
    }
    for (let i = 0; i < (staged[k] as unknown[]).length; i++) {
      const row = (staged[k] as unknown[])[i];
      if (!row || typeof row !== 'object' || Array.isArray(row)) {
        throw new StagedImportValidationError(`staged.${k}[${i}] must be an object`);
      }
    }
  }

  return v as unknown as StagedImportPayload;
}

/** Map the connector name from the contract source to OWB's source-type enum. */
export function mapSourceToType(name: string): 'wave' | 'quickbooks' | 'orange_rails' | null {
  const lower = name.toLowerCase();
  if (lower === 'wave') return 'wave';
  if (lower === 'quickbooks' || lower === 'qb' || lower === 'qbo') return 'quickbooks';
  if (lower === 'orange_rails' || lower === 'or') return 'orange_rails';
  return null;
}
