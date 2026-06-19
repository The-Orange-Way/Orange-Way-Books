/**
 * Bulk Receipt Linker (P2 v2 UI).
 *
 * Page at /app/settings/bulk-receipt-linker. Lets the user attach many
 * receipts to imported journal entries in one pass by matching on the
 * source's external id.
 *
 * Workflow:
 *   1. User uploads a mapping CSV with three columns:
 *        filename,source,external_id
 *      The OR import converter can emit this automatically; users can
 *      also write one by hand.
 *   2. User selects one or more receipt files. Files whose names appear
 *      in the mapping are queued for linking.
 *   3. Click "Link". For each queued file the linker:
 *        - Computes HMAC of "<source>-<external_id>" via vault
 *        - Looks up journal_entries.hmac_import_external_id
 *        - Attaches the file (encrypted) when found
 *   4. Per-file results: attached / no_match / error.
 *
 * Out of scope:
 *   - Filename-only inference (no mapping CSV) — receipts don't carry the
 *     source id in their names; mapping is required.
 *   - Resumable retry queue for very large batches.
 */

import { useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, Loader2, Upload, FileText } from 'lucide-react';
import { toast } from 'sonner';

import { supabase } from '@/lib/supabase';
import { useUserOrg } from '@/hooks/useUserOrg';
import { useVault } from '@/context/VaultContext';
import {
  bulkLinkAttachmentsByImportExternalId,
  type BulkLinkInput,
  type BulkLinkResult,
} from '@/lib/attachments';

import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Table, TableHeader, TableBody, TableHead, TableRow, TableCell,
} from '@/components/ui/table';

interface MappingRow {
  filename: string;
  source: 'wave' | 'quickbooks' | 'orange_rails';
  externalId: string;
}

function parseMappingCsv(text: string): { rows: MappingRow[]; errors: string[] } {
  const errors: string[] = [];
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) {
    return { rows: [], errors: ['Mapping CSV is empty'] };
  }
  // Header check
  const header = lines[0].split(',').map((s) => s.trim().toLowerCase());
  const fIdx = header.indexOf('filename');
  const sIdx = header.indexOf('source');
  const eIdx = header.indexOf('external_id');
  if (fIdx < 0 || sIdx < 0 || eIdx < 0) {
    errors.push('CSV header must include: filename, source, external_id');
    return { rows: [], errors };
  }

  const rows: MappingRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',').map((s) => s.trim());
    const filename = cols[fIdx] | '';
    const sourceRaw = (cols[sIdx] | '').toLowerCase();
    const externalId = cols[eIdx] | '';
    if (!filename || !sourceRaw || !externalId) {
      errors.push(`Row ${i + 1}: filename, source, external_id all required`);
      continue;
    }
    if (sourceRaw !== 'wave' && sourceRaw !== 'quickbooks' && sourceRaw !== 'orange_rails') {
      errors.push(`Row ${i + 1}: source "${sourceRaw}" not one of wave / quickbooks / orange_rails`);
      continue;
    }
    rows.push({ filename, source: sourceRaw, externalId });
  }
  return { rows, errors };
}

export default function BulkReceiptLinker() {
  const { orgId } = useUserOrg();
  const { encryptText, blindIndex } = useVault();

  const mappingInputRef = useRef<HTMLInputElement | null>(null);
  const filesInputRef = useRef<HTMLInputElement | null>(null);

  const [mapping, setMapping] = useState<MappingRow[]>([]);
  const [mappingErrors, setMappingErrors] = useState<string[]>([]);
  const [mappingFileName, setMappingFileName] = useState<string | null>(null);

  const [files, setFiles] = useState<File[]>([]);
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<BulkLinkResult[]>([]);

  const mappingByFilename = useMemo(() => {
    const m = new Map<string, MappingRow>();
    for (const row of mapping) m.set(row.filename, row);
    return m;
  }, [mapping]);

  const matchedFiles = useMemo(() => files.filter((f) => mappingByFilename.has(f.name)), [files, mappingByFilename]);
  const unmappedFiles = useMemo(() => files.filter((f) => !mappingByFilename.has(f.name)), [files, mappingByFilename]);

  const handleMappingPick = async (file: File) => {
    const text = await file.text();
    const parsed = parseMappingCsv(text);
    setMapping(parsed.rows);
    setMappingErrors(parsed.errors);
    setMappingFileName(file.name);
    if (parsed.errors.length > 0) {
      toast.error(`Mapping CSV had ${parsed.errors.length} issue(s); see warnings.`);
    } else {
      toast.success(`Loaded ${parsed.rows.length} mapping row(s) from ${file.name}.`);
    }
  };

  const handleFilesPick = (picked: FileList | null) => {
    if (!picked) return;
    setFiles(Array.from(picked));
    setResults([]);
  };

  const handleRun = async () => {
    if (!orgId) return;
    if (matchedFiles.length === 0) {
      toast.error('No files match the mapping. Check filenames and try again.');
      return;
    }

    setRunning(true);
    setResults([]);
    try {
      const inputs: BulkLinkInput[] = matchedFiles.map((f) => {
        const m = mappingByFilename.get(f.name)!;
        return {
          source: m.source,
          externalId: m.externalId,
          file: f,
          fileName: f.name,
          mimeType: f.type | null,
        };
      });

      const out = await bulkLinkAttachmentsByImportExternalId(
        supabase, encryptText, blindIndex, orgId, inputs,
      );
      setResults(out);

      const attached = out.filter((r) => r.status === 'attached').length;
      const noMatch = out.filter((r) => r.status === 'no_match').length;
      const errCount = out.filter((r) => r.status === 'error').length;

      toast.success(`Linked ${attached}; no match ${noMatch}; errors ${errCount}.`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Bulk link failed: ${msg}`);
      console.error('BulkReceiptLinker run failed', err);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="container max-w-4xl py-8">
      <Link to="/app/admin" className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground mb-4">
        <ArrowLeft className="w-4 h-4 mr-1" /> Back to Admin
      </Link>

      <header className="mb-6">
        <h1 className="text-2xl font-semibold mb-1 flex items-center gap-2">
          <FileText className="w-5 h-5" />
          Bulk Receipt Linker
        </h1>
        <p className="text-sm text-muted-foreground">
          Attach many receipts to imported journal entries at once. Upload a mapping CSV
          (filename, source, external_id) and the receipt files. Each file whose name appears
          in the mapping is attached to the matching journal entry.
        </p>
      </header>

      <section className="rounded-md border p-5 mb-6 bg-card">
        <h2 className="text-sm uppercase tracking-wide text-muted-foreground mb-3">
          1. Mapping CSV
        </h2>
        <p className="text-sm text-muted-foreground mb-3">
          Columns required: <code className="text-xs">filename,source,external_id</code>. Source must be one of
          {' '}<code className="text-xs">wave</code>, <code className="text-xs">quickbooks</code>, or <code className="text-xs">orange_rails</code>.
        </p>
        <input
          ref={mappingInputRef}
          type="file"
          accept=".csv,text/csv"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void handleMappingPick(f);
          }}
        />
        <div className="flex items-center gap-3">
          <Button
            type="button"
            variant="outline"
            onClick={() => mappingInputRef.current?.click()}
          >
            <Upload className="w-4 h-4 mr-2" />
            Select mapping CSV
          </Button>
          {mappingFileName && (
            <span className="text-sm text-muted-foreground">
              {mappingFileName} — {mapping.length} row(s)
            </span>
          )}
        </div>
        {mappingErrors.length > 0 && (
          <div className="mt-3 text-xs text-destructive space-y-1">
            {mappingErrors.slice(0, 10).map((e, i) => (
              <div key={i}>{e}</div>
            ))}
            {mappingErrors.length > 10 && (
              <div>(+{mappingErrors.length - 10} more)</div>
            )}
          </div>
        )}
      </section>

      <section className="rounded-md border p-5 mb-6 bg-card">
        <h2 className="text-sm uppercase tracking-wide text-muted-foreground mb-3">
          2. Receipt files
        </h2>
        <input
          ref={filesInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => handleFilesPick(e.target.files)}
        />
        <div className="flex items-center gap-3 mb-3">
          <Button
            type="button"
            variant="outline"
            onClick={() => filesInputRef.current?.click()}
            disabled={mapping.length === 0}
          >
            <Upload className="w-4 h-4 mr-2" />
            Select files
          </Button>
          {files.length > 0 && (
            <span className="text-sm text-muted-foreground">
              {files.length} file(s) selected
            </span>
          )}
        </div>

        {files.length > 0 && (
          <div className="text-xs text-muted-foreground space-y-1">
            <div>
              <Badge variant="default" className="mr-2">{matchedFiles.length}</Badge>
              match the mapping and will be linked
            </div>
            {unmappedFiles.length > 0 && (
              <div>
                <Badge variant="secondary" className="mr-2">{unmappedFiles.length}</Badge>
                have no mapping row and will be skipped
              </div>
            )}
          </div>
        )}
      </section>

      <div className="flex justify-end mb-8">
        <Button
          type="button"
          onClick={handleRun}
          disabled={running || matchedFiles.length === 0}
        >
          {running && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
          Link {matchedFiles.length} receipt(s)
        </Button>
      </div>

      {results.length > 0 && (
        <section className="rounded-md border bg-card">
          <h2 className="text-sm uppercase tracking-wide text-muted-foreground px-5 pt-5 mb-3">
            Results
          </h2>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Source</TableHead>
                <TableHead>External ID</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Note</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {results.map((r, i) => (
                <TableRow key={i}>
                  <TableCell>{r.source}</TableCell>
                  <TableCell className="font-mono text-xs">{r.externalId}</TableCell>
                  <TableCell>
                    {r.status === 'attached' && <Badge variant="default">Attached</Badge>}
                    {r.status === 'no_match' && <Badge variant="secondary">No match</Badge>}
                    {r.status === 'error' && <Badge variant="destructive">Error</Badge>}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {r.error || (r.attachmentId ? `attached as ${r.attachmentId.slice(0, 8)}…` : '—')}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </section>
      )}
    </div>
  );
}
