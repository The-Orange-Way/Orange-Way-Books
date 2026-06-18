-- Limit what MIME types / file sizes Supabase Storage will accept in the
-- `attachments` bucket. The client-side ALLOWED_EXTENSIONS check in
-- src/lib/attachment-rules.ts is UX; this is the authoritative gate.
--
-- Note: blobs are encrypted client-side with the vault MEK before upload,
-- so in practice the stored Content-Type is always 'application/octet-stream'.
-- We still list the intended plaintext MIME types as a defense-in-depth
-- hint, plus we enforce a 25 MB per-object cap (20 MB plaintext + AES-GCM
-- IV/tag overhead + base64/binary framing).
--
-- If the app later adds an unencrypted-upload path, this list keeps the
-- bucket from silently accepting executables.

update storage.buckets
   set file_size_limit = 25 * 1024 * 1024,
       allowed_mime_types = array[
         'application/octet-stream',
         'application/pdf',
         'application/msword',
         'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
         'application/vnd.ms-excel',
         'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
         'text/csv',
         'image/jpeg',
         'image/png',
         'image/gif',
         'image/bmp',
         'image/tiff',
         'image/webp',
         'image/heic'
       ]
 where id = 'attachments';
