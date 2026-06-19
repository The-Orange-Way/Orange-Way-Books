/**
 * Attachment validation policy for OWB receipt + payment uploads.
 *
 * Three knobs:
 *   - MAX_ATTACHMENTS_PER_ROW — soft cap on how many files a single
 *     transaction or payment_request row can carry. UI rejects the
 *     `n+1`-th upload with a clear message.
 *   - MAX_FILE_SIZE_BYTES — hard cap, mirrored on the storage policy.
 *   - ACCEPTED_EXTENSIONS — closed set. Anything else gets rejected
 *     client-side before the encrypt + upload happens.
 *
 * Pure helpers; no React, no Supabase. Safe to import from anywhere.
 *
 * Implemented in-house for OWB.
 */

// ── Limits ──────────────────────────────────────────────────────────────

const BYTES_PER_KB = 1024;
const BYTES_PER_MB = BYTES_PER_KB * BYTES_PER_KB;

export const MAX_FILES_PER_ENTITY = 5;
export const MAX_FILE_SIZE_MB = 20;
export const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * BYTES_PER_MB;

// ── Accepted MIME-by-extension set ──────────────────────────────────────

/** Documents the front-end will pass through the encrypt + upload flow.
 *  Includes the common office / spreadsheet formats plus the dominant
 *  receipt-photo image types (iOS HEIC is on the list because phones
 *  capture HEIC by default). */
export const ALLOWED_EXTENSIONS = [
  'pdf',
  'doc', 'docx',
  'xls', 'xlsx',
  'csv',
  'jpg', 'jpeg', 'png', 'gif', 'bmp', 'tiff', 'webp', 'heic',
] as const;

export type AllowedExtension = (typeof ALLOWED_EXTENSIONS)[number];

const ALLOWED_SET: ReadonlySet<string> = new Set<string>(ALLOWED_EXTENSIONS);

// ── Filename check ──────────────────────────────────────────────────────

/** Pull the final dotted segment from a filename and lowercase it. Returns
 *  empty string if the name has no dot (e.g. `Makefile`) — used by the
 *  caller to distinguish "no extension" from "wrong extension". */
function extractExtension(fileName: string): string {
  const dotIdx = fileName.lastIndexOf('.');
  if (dotIdx <= 0 || dotIdx === fileName.length - 1) return '';
  return fileName.slice(dotIdx + 1).toLowerCase();
}

/**
 * Returns null when the filename's extension is on the allowlist, or a
 * human-readable rejection reason otherwise. The reason string is what
 * the UI surfaces in a toast — it lists every accepted extension so the
 * user can pick one without guessing.
 */
export function validateAttachmentName(fileName: string): string | null {
  const ext = extractExtension(fileName);

  if (ext === '') {
    return 'Files must include an extension.';
  }

  if (!ALLOWED_SET.has(ext)) {
    return `File type .${ext} is not allowed. Accepted: ${ALLOWED_EXTENSIONS.join(', ')}`;
  }

  return null;
}

// ── Size check ──────────────────────────────────────────────────────────

/**
 * Returns null when the file size is within the cap, or a human-readable
 * rejection reason. The message includes the actual size for context so
 * the user can see how far over they are.
 */
export function validateAttachmentSize(fileSize: number): string | null {
  if (fileSize <= MAX_FILE_SIZE_BYTES) return null;
  return `File is too large (${formatFileSize(fileSize)}). Maximum size is ${MAX_FILE_SIZE_MB}MB.`;
}

// ── Human-readable byte counts ──────────────────────────────────────────

/**
 * Format a byte count in the unit that makes the resulting number short
 * (B for under 1 KB, KB for under 1 MB, MB otherwise). One-decimal
 * precision on MB so 1.5 MB doesn't read as "1 MB".
 */
export function formatFileSize(bytes: number): string {
  if (bytes < BYTES_PER_KB) {
    return `${bytes} B`;
  }
  if (bytes < BYTES_PER_MB) {
    return `${Math.round(bytes / BYTES_PER_KB)} KB`;
  }
  return `${(bytes / BYTES_PER_MB).toFixed(1)} MB`;
}
