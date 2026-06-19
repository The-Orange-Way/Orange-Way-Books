/**
 * Import from Orange Rails (P8 v1).
 *
 * Page at /app/settings/import-from-or. Accepts a single staged-import.json
 * produced by an OR connector (Wave, future QB) and commits its journalEntries
 * into OWB via commitStagedImportPayload.
 *
 * MVP scope:
 *   - File picker for the JSON payload
 *   - Validate via assertStagedImportPayload (shows source name, version, counts)
 *   - Commit button — writes import_jobs row, applies JEs in order
 *   - Result panel with counts + errors
 *
 * Out of scope for v1:
 *   - Accounts + Contacts commit (still goes via the inline CSV widgets)
 *   - Review-and-edit screen (the OR side already lets the user review)
 *   - Resumable / restartable commit for very large payloads
 */

import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, Upload, FileJson, Loader2, CheckCircle2, AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';

import { supabase } from '@/lib/supabase';
import { useUserOrg } from '@/hooks/useUserOrg';
import { useVault } from '@/context/VaultContext';
import {
  assertStagedImportPayload,
  StagedImportValidationError,
  type StagedImportPayload,
} from '@/lib/imports/orange-rails/contract';
import {
  commitStagedImportPayload,
  type CommitResult,
} from '@/lib/imports/orange-rails/commit-orange-rails';

import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

async function sha256Hex(text: string): Promise<string> {
  const buf = new TextEncoder().encode(text);
  const digest = await window.crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export default function ImportFromOr() {
  const { orgId } = useUserOrg();
  const { encryptText, blindIndex } = useVault();

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [parsedPayload, setParsedPayload] = useState<StagedImportPayload | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [fileHash, setFileHash] = useState<string | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [committing, setCommitting] = useState(false);
  const [result, setResult] = useState<CommitResult | null>(null);

  const handleFilePick = async (file: File) => {
    setParsedPayload(null);
    setValidationError(null);
    setResult(null);
    setFileName(file.name);
    try {
      const text = await file.text();
      const json = JSON.parse(text);
      const payload = assertStagedImportPayload(json);
      const hash = await sha256Hex(text);
      setParsedPayload(payload);
      setFileHash(hash);
      toast.success(`Parsed ${file.name}: ${payload.source.name} v${payload.source.version}`);
    } catch (err) {
      if (err instanceof StagedImportValidationError) {
        setValidationError(`Contract validation failed: ${err.message}`);
      } else if (err instanceof SyntaxError) {
        setValidationError(`JSON parse failed: ${err.message}`);
      } else {
        setValidationError(`Unexpected: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  };

  const handleCommit = async () => {
    if (!orgId || !parsedPayload) return;
    setCommitting(true);
    setResult(null);
    try {
      const r = await commitStagedImportPayload(
        supabase, encryptText, blindIndex, orgId, parsedPayload,
        { fileHash },
      );
      setResult(r);
      if (r.status === 'committed') {
        toast.success(
          `Imported ${r.journalEntriesCreated} JEs (${r.journalLinesCreated} lines)`,
        );
      } else {
        toast.error(`Import failed with ${r.errors.length} error(s). See details below.`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Commit threw: ${msg}`);
      console.error('ImportFromOr commit failed', err);
    } finally {
      setCommitting(false);
    }
  };

  return (
    <div className="container max-w-4xl py-8">
      <Link to="/app/admin" className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground mb-4">
        <ArrowLeft className="w-4 h-4 mr-1" /> Back to Admin
      </Link>

      <header className="mb-6">
        <h1 className="text-2xl font-semibold mb-1 flex items-center gap-2">
          <FileJson className="w-5 h-5" />
          Import from Orange Rails
        </h1>
        <p className="text-sm text-muted-foreground">
          Upload a <code className="text-xs">staged-import.json</code> emitted by an
          Orange Rails connector (Wave, QuickBooks, future Plaid). OWB validates the
          contract, writes one import job, and commits its journal entries.
        </p>
        <p className="text-xs text-muted-foreground mt-2">
          v1 commits journalEntries only. Accounts + contacts are still uploaded
          through the existing inline CSV widgets on Admin and Contacts pages.
        </p>
      </header>

      <section className="rounded-md border p-5 mb-6 bg-card">
        <h2 className="text-sm uppercase tracking-wide text-muted-foreground mb-3">
          1. Upload payload
        </h2>
        <input
          ref={fileInputRef}
          type="file"
          accept=".json,application/json"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void handleFilePick(f);
          }}
        />
        <Button
          type="button"
          variant="outline"
          onClick={() => fileInputRef.current?.click()}
        >
          <Upload className="w-4 h-4 mr-2" />
          Select staged-import.json
        </Button>
        {fileName && (
          <span className="ml-3 text-sm text-muted-foreground">{fileName}</span>
        )}
      </section>

      {validationError && (
        <div className="rounded-md border border-destructive/40 p-4 mb-6 bg-destructive/10">
          <div className="text-sm font-medium text-destructive flex items-center gap-2">
            <AlertTriangle className="w-4 h-4" /> Validation failed
          </div>
          <div className="text-xs text-destructive mt-1">{validationError}</div>
        </div>
      )}

      {parsedPayload && (
        <section className="rounded-md border p-5 mb-6 bg-card">
          <h2 className="text-sm uppercase tracking-wide text-muted-foreground mb-3">
            2. Review summary
          </h2>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
            <dt className="text-muted-foreground">Source</dt>
            <dd className="font-mono">{parsedPayload.source.name} v{parsedPayload.source.version}</dd>
            <dt className="text-muted-foreground">Exported at</dt>
            <dd className="font-mono">{parsedPayload.source.exportedAt}</dd>
            <dt className="text-muted-foreground">Accounts</dt>
            <dd>
              {parsedPayload.summary.accounts}
              {parsedPayload.summary.accounts > 0 && (
                <span className="text-xs text-muted-foreground ml-2">(skipped in v1 — use Admin CSV import)</span>
              )}
            </dd>
            <dt className="text-muted-foreground">Contacts</dt>
            <dd>
              {parsedPayload.summary.contacts}
              {parsedPayload.summary.contacts > 0 && (
                <span className="text-xs text-muted-foreground ml-2">(skipped in v1 — use Contacts CSV import)</span>
              )}
            </dd>
            <dt className="text-muted-foreground">Journal entries</dt>
            <dd className="font-mono">{parsedPayload.summary.journalEntries}</dd>
            <dt className="text-muted-foreground">Journal lines</dt>
            <dd className="font-mono">{parsedPayload.summary.journalLines}</dd>
            <dt className="text-muted-foreground">Manifest files</dt>
            <dd className="text-xs">
              {parsedPayload.manifest.files.map((f, i) => (
                <div key={i}>{f.name} <span className="text-muted-foreground">({f.sizeBytes.toLocaleString()} bytes)</span></div>
              ))}
            </dd>
          </dl>

          {parsedPayload.summary.warnings.length > 0 && (
            <div className="mt-4 text-xs">
              <div className="text-amber-600 font-medium mb-1">{parsedPayload.summary.warnings.length} warning(s):</div>
              <ul className="list-disc list-inside text-muted-foreground space-y-0.5">
                {parsedPayload.summary.warnings.slice(0, 10).map((w, i) => <li key={i}>{w}</li>)}
                {parsedPayload.summary.warnings.length > 10 && (
                  <li>… +{parsedPayload.summary.warnings.length - 10} more</li>
                )}
              </ul>
            </div>
          )}

          {parsedPayload.summary.errors.length > 0 && (
            <div className="mt-4 text-xs">
              <div className="text-destructive font-medium mb-1">{parsedPayload.summary.errors.length} error(s) in source:</div>
              <ul className="list-disc list-inside text-destructive space-y-0.5">
                {parsedPayload.summary.errors.slice(0, 10).map((e, i) => <li key={i}>{e}</li>)}
              </ul>
            </div>
          )}

          <div className="mt-5 flex justify-end">
            <Button
              type="button"
              onClick={handleCommit}
              disabled={committing || parsedPayload.summary.journalEntries === 0}
            >
              {committing && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              Commit {parsedPayload.summary.journalEntries} journal entries
            </Button>
          </div>
        </section>
      )}

      {result && (
        <section
          className={`rounded-md border p-5 mb-6 ${
            result.status === 'committed' ? 'border-green-500/40 bg-green-500/5' : 'border-destructive/40 bg-destructive/10'
          }`}
        >
          <h2 className="text-sm uppercase tracking-wide text-muted-foreground mb-3 flex items-center gap-2">
            {result.status === 'committed' ? (
              <><CheckCircle2 className="w-4 h-4 text-green-600" /> Committed</>
            ) : (
              <><AlertTriangle className="w-4 h-4 text-destructive" /> Failed</>
            )}
          </h2>
          <div className="text-sm space-y-1">
            <div>
              <Badge variant="default" className="mr-2">{result.journalEntriesCreated}</Badge>
              journal entries created
            </div>
            <div>
              <Badge variant="secondary" className="mr-2">{result.journalLinesCreated}</Badge>
              journal lines created
            </div>
            <div className="text-xs text-muted-foreground mt-2 font-mono">
              import_job_id: {result.importJobId}
            </div>
          </div>
          {result.errors.length > 0 && (
            <div className="mt-4 text-xs">
              <div className="font-medium text-destructive mb-1">{result.errors.length} error(s):</div>
              <ul className="list-disc list-inside text-destructive space-y-0.5 max-h-40 overflow-y-auto">
                {result.errors.map((e, i) => <li key={i}>{e}</li>)}
              </ul>
              <p className="text-muted-foreground mt-2">
                To retry after a mapping fix: call <code>purge_import_job_artifacts({result.importJobId})</code>
                {' '}then re-upload the payload.
              </p>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
