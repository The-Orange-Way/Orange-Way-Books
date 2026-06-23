import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Provider-agnostic interface for attachment blob storage.
 * The default implementation targets Supabase Storage; swap the
 * factory for a self-hosted Supabase or S3/R2 implementation without
 * touching any call site.
 */
export interface AttachmentStorage {
  /** Upload encrypted bytes to `path`. Overwrites if it already exists. */
  put(path: string, data: Blob | Uint8Array): Promise<void>;
  /** Download encrypted bytes from `path`. Returns the raw ArrayBuffer. */
  get(path: string): Promise<ArrayBuffer>;
  /** Remove one or more objects. Best-effort, does not throw if an object is missing. */
  delete(paths: string[]): Promise<void>;
}

const BUCKET = 'attachments';

export function makeSupabaseAttachmentStorage(supabase: SupabaseClient): AttachmentStorage {
  return {
    async put(path, data) {
      const { error } = await supabase.storage
        .from(BUCKET)
        .upload(path, data, { contentType: 'application/octet-stream', upsert: true });
      if (error) throw new Error(`AttachmentStorage.put(${path}): ${error.message}`);
    },

    async get(path) {
      const { data, error } = await supabase.storage.from(BUCKET).download(path);
      if (error) throw new Error(`AttachmentStorage.get(${path}): ${error.message}`);
      if (!data) throw new Error(`AttachmentStorage.get(${path}): empty response`);
      return data.arrayBuffer();
    },

    async delete(paths) {
      if (paths.length === 0) return;
      // Supabase Storage `remove` treats missing objects as success, so this
      // is safe to call for best-effort cleanup after a failed upgrade.
      const { error } = await supabase.storage.from(BUCKET).remove(paths);
      if (error) throw new Error(`AttachmentStorage.delete: ${error.message}`);
    },
  };
}
