/**
 * Import Jobs admin viewer.
 *
 * Surfaces the import_jobs table (added by 20260515000000_import_jobs.sql
 * and gated by 20260516010000_import_jobs_capability_gate.sql) as a list
 * page. Lets the user inspect status, error messages, summary counts, and
 * purge artifacts for safe re-import.
 *
 * Page at /app/settings/import-jobs.
 *
 * Why this exists:
 *   - P8 writes import_jobs rows when committing OR payloads. Users need a
 *     way to see what was committed, what failed, and to retry.
 *   - purge_import_job_artifacts deletes all JEs created by a job;
 *     this UI exposes that as a button.
 *   - encrypted_manifest / encrypted_parse_summary / encrypted_error all
 *     decrypt browser-side via vault decryptText.
 *
 * Out of scope (future):
 *   - Re-upload directly from this page (today: purge, then go to wizard)
 *   - Filter by status / source_type / date range
 *   - Pagination (today: 100 most recent jobs)
 */

import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, Loader2, FileJson, AlertTriangle, Trash2, RefreshCw } from 'lucide-react';
import { format, parseISO } from 'date-fns';
import { toast } from 'sonner';

import { supabase } from '@/lib/supabase';
import { useUserOrg } from '@/hooks/useUserOrg';
import { useVault } from '@/context/VaultContext';
import { purgeImportJobArtifacts } from '@/lib/journal-entry-ref-numbers';

import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';

interface ImportJobRow {
  id: string;
  source_type: string;
  status: 'parsing' | 'ready' | 'committing' | 'committed' | 'failed';
  file_name: string | null;
  file_hash: string | null;
  row_count: number | null;
  created_at: string;
  committed_at: string | null;
  // Decrypted summaries (best-effort)
  summary?: {
    accounts?: number;
    contacts?: number;
    journalEntries?: number;
    journalLines?: number;
    warnings?: string[];
    errors?: string[];
  } | null;
  manifest_summary?: string | null;
  error_text?: string | null;
}

function statusBadge(status: ImportJobRow['status']) {
  switch (status) {
    case 'committed':
      return <Badge variant="default">Committed</Badge>;
    case 'failed':
      return <Badge variant="destructive">Failed</Badge>;
    case 'committing':
      return <Badge variant="secondary">Committing…</Badge>;
    case 'ready':
      return <Badge variant="outline">Ready</Badge>;
    case 'parsing':
      return <Badge variant="outline">Parsing…</Badge>;
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
}

export default function ImportJobs() {
  const { orgId } = useUserOrg();
  const { decryptText } = useVault();
  const [rows, setRows] = useState<ImportJobRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [purgingId, setPurgingId] = useState<string | null>(null);
  const [detailRow, setDetailRow] = useState<ImportJobRow | null>(null);

  const load = async () => {
    if (!orgId) return;
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('import_jobs')
        .select(
          'id, source_type, status, file_name, file_hash, row_count, created_at, committed_at, encrypted_parse_summary, encrypted_manifest, encrypted_error, key_version',
        )
        .eq('org_id', orgId)
        .order('created_at', { ascending: false })
        .limit(100);
      if (error) throw error;

      const decrypted: ImportJobRow[] = await Promise.all(
        (data ?? []).map(async (r: any) => {
          let summary: ImportJobRow['summary'] = null;
          let manifest_summary: string | null = null;
          let error_text: string | null = null;
          if (r.encrypted_parse_summary && r.key_version) {
            try {
              const json = await decryptText(r.encrypted_parse_summary);
              summary = JSON.parse(json);
            } catch {
              summary = null;
            }
          }
          if (r.encrypted_manifest && r.key_version) {
            try {
              const json = await decryptText(r.encrypted_manifest);
              const m = JSON.parse(json);
              const files = (m.files || []) as Array<{ name: string }>;
              manifest_summary = files.map((f) => f.name).join(', ');
            } catch {
              manifest_summary = null;
            }
          }
          if (r.encrypted_error && r.key_version) {
            try {
              error_text = await decryptText(r.encrypted_error);
            } catch {
              error_text = '(error blob could not be decrypted)';
            }
          }
          return {
            id: r.id,
            source_type: r.source_type,
            status: r.status,
            file_name: r.file_name,
            file_hash: r.file_hash,
            row_count: r.row_count,
            created_at: r.created_at,
            committed_at: r.committed_at,
            summary,
            manifest_summary,
            error_text,
          };
        }),
      );
      setRows(decrypted);
    } catch (err) {
      console.error('ImportJobs load failed', err);
      toast.error('Failed to load import jobs');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [orgId]);

  const handlePurge = async (jobId: string) => {
    if (
      !confirm(
        'Delete all journal entries created by this import job? This cannot be undone. ' +
          'After purging you can re-upload the same payload through the Import wizard.',
      )
    )
      return;
    setPurgingId(jobId);
    try {
      const result = await purgeImportJobArtifacts(supabase, jobId);
      toast.success(
        `Purged ${result.journal_entries_deleted} journal entr${result.journal_entries_deleted === 1 ? 'y' : 'ies'} from this job.`,
      );
      await load();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Purge failed: ${msg}`);
    } finally {
      setPurgingId(null);
    }
  };

  const stats = useMemo(() => {
    const s = { total: rows.length, committed: 0, failed: 0, in_flight: 0 };
    for (const r of rows) {
      if (r.status === 'committed') s.committed++;
      else if (r.status === 'failed') s.failed++;
      else s.in_flight++;
    }
    return s;
  }, [rows]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="container max-w-5xl py-8">
      <Link
        to="/app/admin"
        className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground mb-4"
      >
        <ArrowLeft className="w-4 h-4 mr-1" /> Back to Admin
      </Link>

      <header className="mb-6">
        <h1 className="text-2xl font-semibold mb-1 flex items-center gap-2">
          <FileJson className="w-5 h-5" /> Import Jobs
        </h1>
        <p className="text-sm text-muted-foreground">
          Every import that ran through the Orange Rails wizard appears here. Committed jobs have a
          "Purge" button — use it to delete the journal entries they created when you want to
          re-import after a mapping fix.
        </p>
      </header>

      <section className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <div className="rounded-md border p-4 bg-card">
          <div className="text-xs uppercase text-muted-foreground">Total</div>
          <div className="text-2xl font-semibold">{stats.total}</div>
        </div>
        <div className="rounded-md border p-4 bg-card">
          <div className="text-xs uppercase text-muted-foreground">Committed</div>
          <div className="text-2xl font-semibold text-green-600">{stats.committed}</div>
        </div>
        <div className="rounded-md border p-4 bg-card">
          <div className="text-xs uppercase text-muted-foreground">Failed</div>
          <div className="text-2xl font-semibold text-destructive">{stats.failed}</div>
        </div>
        <div className="rounded-md border p-4 bg-card">
          <div className="text-xs uppercase text-muted-foreground">In flight</div>
          <div className="text-2xl font-semibold">{stats.in_flight}</div>
        </div>
      </section>

      <section className="rounded-md border bg-card">
        {rows.length === 0 ? (
          <div className="p-8 text-center">
            <p className="text-sm text-muted-foreground">
              No import jobs yet. Upload a staged-import.json via{' '}
              <Link to="/app/settings/import-from-or" className="underline">
                Import from Orange Rails
              </Link>
              .
            </p>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>File</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Rows</TableHead>
                <TableHead className="w-44">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                    {format(parseISO(r.created_at), 'PPP p')}
                  </TableCell>
                  <TableCell>
                    <span className="text-xs font-mono">{r.source_type}</span>
                  </TableCell>
                  <TableCell className="max-w-xs truncate" title={r.file_name || ''}>
                    {r.file_name || <span className="text-muted-foreground">—</span>}
                  </TableCell>
                  <TableCell>{statusBadge(r.status)}</TableCell>
                  <TableCell className="text-right text-sm">{r.row_count ?? '—'}</TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => setDetailRow(r)}
                      >
                        Details
                      </Button>
                      {r.status === 'committed' ||
                        (r.status === 'failed' && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => handlePurge(r.id)}
                            disabled={purgingId === r.id}
                            title="Delete JEs created by this job"
                          >
                            {purgingId === r.id ? (
                              <Loader2 className="w-4 h-4 animate-spin" />
                            ) : (
                              <Trash2 className="w-4 h-4" />
                            )}
                          </Button>
                        ))}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {rows.length > 0 && (
          <div className="p-3 border-t flex justify-end">
            <Button type="button" variant="outline" size="sm" onClick={() => void load()}>
              <RefreshCw className="w-3 h-3 mr-1" /> Refresh
            </Button>
          </div>
        )}
      </section>

      <Dialog
        open={!!detailRow}
        onOpenChange={(o) => {
          if (!o) setDetailRow(null);
        }}
      >
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Import job detail</DialogTitle>
          </DialogHeader>
          {detailRow && (
            <div className="space-y-4 text-sm">
              <dl className="grid grid-cols-3 gap-x-4 gap-y-1">
                <dt className="text-muted-foreground">ID</dt>
                <dd className="col-span-2 font-mono text-xs">{detailRow.id}</dd>
                <dt className="text-muted-foreground">Source</dt>
                <dd className="col-span-2">{detailRow.source_type}</dd>
                <dt className="text-muted-foreground">File</dt>
                <dd className="col-span-2">{detailRow.file_name || '—'}</dd>
                <dt className="text-muted-foreground">File hash</dt>
                <dd className="col-span-2 font-mono text-xs break-all">
                  {detailRow.file_hash || '—'}
                </dd>
                <dt className="text-muted-foreground">Manifest</dt>
                <dd className="col-span-2 text-xs">{detailRow.manifest_summary || '—'}</dd>
                <dt className="text-muted-foreground">Created</dt>
                <dd className="col-span-2">{format(parseISO(detailRow.created_at), 'PPP p')}</dd>
                <dt className="text-muted-foreground">Committed</dt>
                <dd className="col-span-2">
                  {detailRow.committed_at ? format(parseISO(detailRow.committed_at), 'PPP p') : '—'}
                </dd>
                <dt className="text-muted-foreground">Status</dt>
                <dd className="col-span-2">{statusBadge(detailRow.status)}</dd>
              </dl>

              {detailRow.summary && (
                <div>
                  <div className="text-xs uppercase text-muted-foreground mb-1">Summary</div>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                    <div>
                      Accounts: <span className="font-mono">{detailRow.summary.accounts ?? 0}</span>
                    </div>
                    <div>
                      Contacts: <span className="font-mono">{detailRow.summary.contacts ?? 0}</span>
                    </div>
                    <div>
                      Journal entries:{' '}
                      <span className="font-mono">{detailRow.summary.journalEntries ?? 0}</span>
                    </div>
                    <div>
                      Journal lines:{' '}
                      <span className="font-mono">{detailRow.summary.journalLines ?? 0}</span>
                    </div>
                  </div>
                  {(detailRow.summary.warnings?.length ?? 0) > 0 && (
                    <div className="mt-3 text-xs">
                      <div className="text-amber-600 font-medium mb-1">
                        Warnings ({detailRow.summary.warnings!.length})
                      </div>
                      <ul className="list-disc list-inside text-muted-foreground space-y-0.5 max-h-32 overflow-y-auto">
                        {detailRow.summary.warnings!.slice(0, 20).map((w, i) => (
                          <li key={i}>{w}</li>
                        ))}
                        {detailRow.summary.warnings!.length > 20 && (
                          <li>+{detailRow.summary.warnings!.length - 20} more</li>
                        )}
                      </ul>
                    </div>
                  )}
                </div>
              )}

              {detailRow.error_text && (
                <div className="rounded-md border border-destructive/40 p-3 bg-destructive/10 text-xs">
                  <div className="font-medium text-destructive flex items-center gap-2 mb-1">
                    <AlertTriangle className="w-3 h-3" /> Error
                  </div>
                  <pre className="whitespace-pre-wrap text-destructive text-[11px] max-h-60 overflow-y-auto">
                    {detailRow.error_text}
                  </pre>
                </div>
              )}
            </div>
          )}
          <DialogFooter>
            {(detailRow && detailRow.status === 'committed') ||
              (detailRow.status === 'failed' && (
                <Button
                  type="button"
                  variant="destructive"
                  onClick={() => {
                    if (detailRow) {
                      void handlePurge(detailRow.id);
                      setDetailRow(null);
                    }
                  }}
                  disabled={purgingId === detailRow.id}
                >
                  <Trash2 className="w-4 h-4 mr-1" /> Purge artifacts
                </Button>
              ))}
            <Button type="button" variant="outline" onClick={() => setDetailRow(null)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
