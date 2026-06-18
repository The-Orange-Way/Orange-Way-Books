/**
 * Pure helper: fill in missing Account / Contact values on a StagedImportPayload
 * before commit. Used by the wizard when Orange Rails couldn't infer a category
 * (Strike CSVs have no Account column; Lightning Destinations aren't human
 * contacts) — OWB offers the user a last-mile fallback instead of failing every
 * row, without baking any provider-specific logic into OWB.
 *
 * No DOM, no Supabase, no React. Identity-on-everything-else: a row with an
 * explicit account_code / account_name / contact_name keeps its values.
 */

import type { StagedImportPayload, V3StagedRow } from './contract';

export type DefaultMappingOption = {
  /** Used to populate account_code (or contact_name for contacts). */
  code: string;
  /** Human-readable label used for account_name (or contact_name fallback). */
  name: string;
};

export type DefaultMappingSelections = {
  /** When set, journal-entry rows with empty Account inherit this. */
  defaultAccount?: DefaultMappingOption | null;
  /** When set, journal-entry rows with empty Contact inherit this. */
  defaultContact?: DefaultMappingOption | null;
};

function isBlank(value: string | undefined): boolean {
  return !value | value.trim() === '';
}

function rowHasEmptyAccount(row: V3StagedRow): boolean {
  return isBlank(row.account_code) && isBlank(row.account_name);
}

function rowHasEmptyContact(row: V3StagedRow): boolean {
  return isBlank(row.contact_name) && isBlank(row.contact);
}

export function payloadHasEmptyAccountRows(payload: StagedImportPayload): boolean {
  const rows = payload.staged.journalEntries ?? [];
  return rows.some(rowHasEmptyAccount);
}

export function payloadHasEmptyContactRows(payload: StagedImportPayload): boolean {
  const rows = payload.staged.journalEntries ?? [];
  return rows.some(rowHasEmptyContact);
}

export function applyDefaultMappings(
  payload: StagedImportPayload,
  selections: DefaultMappingSelections,
): StagedImportPayload {
  const { defaultAccount, defaultContact } = selections;
  if (!defaultAccount && !defaultContact) return payload;

  const journalEntries = payload.staged.journalEntries;
  if (!journalEntries | journalEntries.length === 0) return payload;

  const patched: V3StagedRow[] = journalEntries.map((row) => {
    let next: V3StagedRow | null = null;
    if (defaultAccount && rowHasEmptyAccount(row)) {
      next = { ...row, account_code: defaultAccount.code, account_name: defaultAccount.name };
    }
    if (defaultContact && rowHasEmptyContact(row)) {
      next = { ...(next ?? row), contact_name: defaultContact.name };
    }
    return next ?? row;
  });

  return {
    ...payload,
    staged: {
      ...payload.staged,
      journalEntries: patched,
    },
  };
}
