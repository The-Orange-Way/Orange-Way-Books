/**
 * Attachments service (P2 v1).
 *
 * Helpers for attaching files to transactions, payment requests, and journal
 * entries, including a bulk linker that resolves journal entries by their
 * ZKA-safe HMAC import external id (the column added by P5 migration
 * 20260522000000).
 *
 * Why a service module, not just call sites:
 *   1. File encryption needs to be uniform. We pad and encrypt the file
 *      bytes via the vault MEK before writing them to Supabase Storage.
 *      Doing this in N call sites would invite divergence.
 *   2. The bulk linker is reused by the OR import wizard and by any future
 *      "drag a folder of receipts onto the books" workflow. It needs a
 *      pure-service shape.
 *   3. ZKA invariant: file bytes must NEVER hit Supabase Storage as
 *      plaintext. Centralising the put+get path is how we ensure that.
 *
 * Out of scope for v1 (future iterations):
 *   - Single-attachment UI on the JE / transaction edit views (just calls
 *     uploadAttachment from this module).
 *   - Bulk linker UI page (folder picker + CSV mapping).
 *   - Server-side virus scan / content sniffing.
 *   - Inline preview of decrypted receipts (download + decrypt + render).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { encryptAttachment } from './crypto-fields';
import { makeSupabaseAttachmentStorage, type AttachmentStorage } from './storage';

// ── Types ────────────────────────────────────────────────────────────────────

export type AttachmentEntityType = 'transaction' | 'payment_request' | 'journal_entry';

export interface AttachmentRow {
  id: string;
  org_id: string;
  entity_type: AttachmentEntityType;
  entity_id: string;
  file_size: number;
  storage_path: string;
  created_at: string;
}

export interface UploadAttachmentParams {
  /** Plaintext target. */
  file: File | Blob;
  /** Original filename, encrypted before insert. */
  fileName: string;
  /** Mime type, encrypted before insert. */
  mimeType: string | null;
  /** Which entity this attachment belongs to. */
  entityType: AttachmentEntityType;
  entityId: string;
}

// ── Binary encryption helpers ────────────────────────────────────────────────

/**
 * Encrypt a Blob/ArrayBuffer using the vault's AES-GCM helper.
 *
 * Strategy: read bytes → base64 → encryptText → ciphertext string. The
 * ciphertext is then written to Storage as bytes again (utf-8 of the
 * base64 ciphertext). This adds about 33% to the stored size (base64
 * inflation) plus AES-GCM IV + tag overhead, but it lets us reuse the
 * existing vetted encryptText path without a new binary AES-GCM helper.
 *
 * Future optimization (deferred): switch to raw AES-GCM over ArrayBuffer
 * once a vault binary helper exists. ~25% storage savings. Same MEK.
 */
async function encryptBytes(
  blob: Blob,
  encryptText: (plaintext: string) => Promise<string>,
): Promise<Uint8Array> {
  const arr = new Uint8Array(await blob.arrayBuffer());
  const b64 = btoa(String.fromCharCode(...arr));
  const ciphertext = await encryptText(b64);
  return new TextEncoder().encode(ciphertext);
}

async function decryptBytes(
  storedBytes: ArrayBuffer,
  decryptText: (ciphertext: string) => Promise<string>,
): Promise<Uint8Array> {
  const ciphertext = new TextDecoder().decode(storedBytes);
  const b64 = await decryptText(ciphertext);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

// ── Upload ───────────────────────────────────────────────────────────────────

/**
 * Upload an attachment for a given entity. Encrypts the file bytes via
 * vault encryptText, writes to Supabase Storage under a UUID path, and
 * inserts the attachments metadata row.
 *
 * Throws on storage or insert failure. On insert failure, the uploaded
 * blob is removed best-effort to avoid orphans.
 */
export async function uploadAttachment(
  supabase: SupabaseClient,
  encryptText: (plaintext: string) => Promise<string>,
  orgId: string,
  params: UploadAttachmentParams,
): Promise<AttachmentRow> {
  if (!orgId) throw new Error('uploadAttachment: orgId required');
  if (!params.entityId) throw new Error('uploadAttachment: entityId required');
  if (!params.fileName) throw new Error('uploadAttachment: fileName required');

  const fileSize = params.file.size ?? 0;
  const storagePath = `${orgId}/${params.entityType}/${crypto.randomUUID()}`;

  // 1. Encrypt + upload bytes
  const encryptedBytes = await encryptBytes(params.file, encryptText);
  const storage = makeSupabaseAttachmentStorage(supabase);
  await storage.put(storagePath, encryptedBytes);

  // 2. Encrypt + insert metadata row
  let row: AttachmentRow;
  try {
    const encMeta = await encryptAttachment(
      { file_name: params.fileName, mime_type: params.mimeType },
      encryptText,
    );

    const { data, error } = await supabase
      .from('attachments')
      .insert({
        org_id: orgId,
        entity_type: params.entityType,
        entity_id: params.entityId,
        file_name: encMeta.file_name,
        mime_type: encMeta.mime_type,
        file_size: fileSize,
        storage_path: storagePath,
        key_version: encMeta.key_version,
      } as any)
      .select('id, org_id, entity_type, entity_id, file_size, storage_path, created_at')
      .single();

    if (error) throw error;
    row = data as AttachmentRow;
  } catch (err) {
    // Best-effort cleanup of orphaned bytes
    void storage.delete([storagePath]).catch(() => undefined);
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`uploadAttachment: metadata insert failed (${msg}); storage object removed`);
  }

  return row;
}

// ── Download ─────────────────────────────────────────────────────────────────

/**
 * Download + decrypt an attachment by its storage path. Returns the raw
 * file bytes ready to hand to a Blob constructor or save-as helper.
 */
export async function downloadAttachment(
  supabase: SupabaseClient,
  decryptText: (ciphertext: string) => Promise<string>,
  storagePath: string,
): Promise<Uint8Array> {
  const storage = makeSupabaseAttachmentStorage(supabase);
  const buf = await storage.get(storagePath);
  return decryptBytes(buf, decryptText);
}

// ── Bulk linker (P5 hmac integration) ────────────────────────────────────────

export interface BulkLinkInput {
  /** Source identifier (e.g. 'wave', 'quickbooks'). */
  source: 'wave' | 'quickbooks' | 'orange_rails';
  /** The source's external id for the JE this file belongs to (e.g. Wave Transaction ID). */
  externalId: string;
  /** File to attach. */
  file: File | Blob;
  fileName: string;
  mimeType: string | null;
}

export interface BulkLinkResult {
  source: string;
  externalId: string;
  status: 'attached' | 'no_match' | 'error';
  attachmentId?: string;
  journalEntryId?: string;
  error?: string;
}

/**
 * Bulk-attach a batch of files to journal entries by source + external id.
 *
 * For each input:
 *   1. Compute HMAC of "<source>-<externalId>" via the blindIndex callback.
 *   2. Query journal_entries WHERE org_id = ? AND hmac_import_external_id = ?
 *   3. If found, call uploadAttachment.
 *   4. If not found, mark 'no_match' and continue.
 *
 * Returns one result row per input. Caller renders the summary to the user
 * and offers a queue for unmatched items.
 *
 * Designed to be called by the OR import wizard's receipt-matching step or
 * by a "drag a folder of receipts" UI. Both feed the same shape.
 */
export async function bulkLinkAttachmentsByImportExternalId(
  supabase: SupabaseClient,
  encryptText: (plaintext: string) => Promise<string>,
  blindIndex: (value: string | null | undefined) => Promise<string | null>,
  orgId: string,
  inputs: BulkLinkInput[],
): Promise<BulkLinkResult[]> {
  if (!orgId) throw new Error('bulkLinkAttachmentsByImportExternalId: orgId required');

  const results: BulkLinkResult[] = [];

  for (const input of inputs) {
    const hmacInput = `${input.source}-${input.externalId}`.toLowerCase();
    const hmac = await blindIndex(hmacInput);
    if (!hmac) {
      results.push({
        source: input.source,
        externalId: input.externalId,
        status: 'error',
        error: 'Vault locked or blind-index key unavailable',
      });
      continue;
    }

    try {
      const { data: jeRows, error: lookupErr } = await supabase
        .from('journal_entries')
        .select('id')
        .eq('org_id', orgId)
        .eq('hmac_import_external_id', hmac)
        .limit(1);

      if (lookupErr) {
        results.push({
          source: input.source,
          externalId: input.externalId,
          status: 'error',
          error: `JE lookup failed: ${lookupErr.message}`,
        });
        continue;
      }

      const je = (jeRows ?? [])[0];
      if (!je) {
        results.push({
          source: input.source,
          externalId: input.externalId,
          status: 'no_match',
        });
        continue;
      }

      const row = await uploadAttachment(supabase, encryptText, orgId, {
        file: input.file,
        fileName: input.fileName,
        mimeType: input.mimeType,
        entityType: 'journal_entry',
        entityId: (je as any).id as string,
      });

      results.push({
        source: input.source,
        externalId: input.externalId,
        status: 'attached',
        attachmentId: row.id,
        journalEntryId: (je as any).id as string,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({
        source: input.source,
        externalId: input.externalId,
        status: 'error',
        error: msg,
      });
    }
  }

  return results;
}
