/**
 * AttachmentList — reusable list + upload widget for any attachable entity.
 *
 * Drops into transaction edit views, journal entry edit views, or
 * payment request views. Pure React component; all encryption + Supabase
 * Storage I/O goes through src/lib/attachments.ts.
 *
 * MVP scope:
 *   - Fetch + decrypt filename / mime on mount
 *   - Upload a single file at a time via file picker
 *   - Download by opening the decrypted blob in a new tab
 *   - Optional delete (capability-gated)
 *
 * Out of scope (future):
 *   - Multi-file drag-and-drop
 *   - Inline preview pane (decrypt + render PDF/image without download)
 *   - Replace existing attachment in place
 */

import { useEffect, useRef, useState } from 'react';
import { Loader2, Paperclip, Trash2, Upload } from 'lucide-react';
import { format, parseISO } from 'date-fns';
import { toast } from 'sonner';

import { supabase } from '@/lib/supabase';
import { useVault } from '@/context/VaultContext';
import { decryptAttachment } from '@/lib/crypto-fields';
import {
  uploadAttachment,
  downloadAttachment,
  type AttachmentEntityType,
} from '@/lib/attachments';

import { Button } from '@/components/ui/button';

interface AttachmentDisplay {
  id: string;
  file_name: string;
  mime_type: string | null;
  file_size: number;
  storage_path: string;
  created_at: string;
}

interface Props {
  orgId: string;
  entityType: AttachmentEntityType;
  entityId: string;
  /** Optional: disable upload (e.g. for read-only roles). */
  canUpload?: boolean;
  /** Optional: disable delete (default false). */
  canDelete?: boolean;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function AttachmentList({
  orgId,
  entityType,
  entityId,
  canUpload = true,
  canDelete = false,
}: Props) {
  const { encryptText, decryptText } = useVault();
  const [items, setItems] = useState<AttachmentDisplay[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [downloading, setDownloading] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const reload = async () => {
    if (!orgId | !entityId) return;
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('attachments')
        .select('id, file_name, mime_type, file_size, storage_path, created_at, key_version')
        .eq('org_id', orgId)
        .eq('entity_type', entityType)
        .eq('entity_id', entityId)
        .order('created_at', { ascending: false });
      if (error) throw error;

      const decrypted: AttachmentDisplay[] = await Promise.all(
        (data ?? []).map(async (row: any) => {
          let display: AttachmentDisplay = {
            id: row.id,
            file_name: row.file_name ?? '(unnamed)',
            mime_type: row.mime_type ?? null,
            file_size: row.file_size ?? 0,
            storage_path: row.storage_path,
            created_at: row.created_at,
          };
          if (row.key_version) {
            try {
              const dec = await decryptAttachment(row, decryptText);
              display = { ...display, file_name: dec.file_name, mime_type: dec.mime_type };
            } catch {
              display.file_name = '(decryption failed)';
            }
          }
          return display;
        }),
      );
      setItems(decrypted);
    } catch (err) {
      console.error('AttachmentList load failed', err);
      toast.error('Failed to load attachments');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId, entityType, entityId]);

  const handleUpload = async (file: File) => {
    setUploading(true);
    try {
      await uploadAttachment(supabase, encryptText, orgId, {
        file,
        fileName: file.name,
        mimeType: file.type | null,
        entityType,
        entityId,
      });
      toast.success(`Uploaded ${file.name}`);
      await reload();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Upload failed: ${msg}`);
      console.error('AttachmentList upload failed', err);
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleDownload = async (item: AttachmentDisplay) => {
    setDownloading(item.id);
    try {
      const bytes = await downloadAttachment(supabase, decryptText, item.storage_path);
      const blob = new Blob([bytes.buffer as ArrayBuffer], { type: item.mime_type | 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      // Open in a new tab. Browser uses the mime type to decide preview vs download.
      const a = document.createElement('a');
      a.href = url;
      a.download = item.file_name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Revoke after a moment to let the browser pick it up.
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Download failed: ${msg}`);
      console.error('AttachmentList download failed', err);
    } finally {
      setDownloading(null);
    }
  };

  const handleDelete = async (item: AttachmentDisplay) => {
    if (!confirm(`Delete ${item.file_name}? This cannot be undone.`)) return;
    try {
      // Delete the storage blob first (best effort), then the metadata row.
      await supabase.storage.from('attachments').remove([item.storage_path]);
      const { error } = await supabase.from('attachments').delete().eq('id', item.id);
      if (error) throw error;
      toast.success(`Deleted ${item.file_name}`);
      await reload();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Delete failed: ${msg}`);
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium flex items-center gap-2">
          <Paperclip className="w-4 h-4" />
          Attachments
          {!loading && items.length > 0 && (
            <span className="text-xs text-muted-foreground font-normal">({items.length})</span>
          )}
        </h3>
        {canUpload && (
          <>
            <input
              ref={fileInputRef}
              type="file"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void handleUpload(f);
              }}
            />
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={uploading}
              onClick={() => fileInputRef.current?.click()}
            >
              {uploading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Upload className="w-4 h-4 mr-2" />}
              Upload
            </Button>
          </>
        )}
      </div>

      {loading ? (
        <div className="text-sm text-muted-foreground py-2">Loading…</div>
      ) : items.length === 0 ? (
        <div className="text-sm text-muted-foreground py-2">No attachments yet.</div>
      ) : (
        <ul className="space-y-1">
          {items.map((item) => (
            <li
              key={item.id}
              className="flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm bg-card"
            >
              <button
                type="button"
                onClick={() => handleDownload(item)}
                className="text-left flex-1 hover:underline truncate"
                disabled={downloading === item.id}
                title={item.file_name}
              >
                {downloading === item.id && (
                  <Loader2 className="w-3 h-3 mr-1 animate-spin inline-block" />
                )}
                {item.file_name}
              </button>
              <span className="text-xs text-muted-foreground whitespace-nowrap">
                {formatBytes(item.file_size)} · {format(parseISO(item.created_at), 'MMM d, yyyy')}
              </span>
              {canDelete && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  onClick={() => handleDelete(item)}
                  aria-label={`Delete ${item.file_name}`}
                >
                  <Trash2 className="w-4 h-4" />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
