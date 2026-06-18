/**
 * Import from Orange Rails — Wizard for the Mode 2 single-bundle path.
 *
 * Reads a .or-import.json file emitted by any Orange Rails plugin (Wave,
 * QuickBooks, ShakePay later), validates it against the contract, surfaces
 * the connector's summary + warnings + errors, then applies each staged
 * section through the existing commit handlers.
 *
 * Why this is the minimum viable wizard:
 *   - Staged row keys match the local ImportPreviewRow.data exactly (by design
 *     of the contract), so the existing per-entity commit handlers in
 *     Admin.tsx + JournalEntries.tsx accept these rows unchanged.
 *   - The parent page passes its commit handlers in as props; no commit
 *     logic is duplicated here.
 *   - Application order (accounts → contacts → JEs) is enforced.
 *
 * ZKA boundary unchanged: the bundle arrives plaintext on the user's
 * machine; OWB encrypts each row in the browser before write, same as the
 * inline ImportPopup path.
 */

import { useCallback, useRef, useState } from 'react';
import { Upload, FileText, CheckCircle2, AlertTriangle, Loader2, X } from 'lucide-react';

import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { ImportPreviewRow, ImportResult } from '@/components/ui/import-popup';

import {
  assertStagedImportPayload,
  stagedRowsToPreview,
  type StagedImportPayload,
} from '@/lib/import-from-orange-rails/contract';
import {
  applyDefaultMappings,
  payloadHasEmptyAccountRows,
  payloadHasEmptyContactRows,
  type DefaultMappingOption,
  type DefaultMappingSelections,
} from '@/lib/import-from-orange-rails/apply-defaults';
import { DefaultMappingPanel } from '@/components/imports/DefaultMappingPanel';

type Step = 'upload' | 'review' | 'applying' | 'done';

export interface ImportFromOrangeRailsWizardProps {
  open: boolean;
  onClose: () => void;
  /** Commit handler for the `accounts` section. Same shape as ImportPopup's onImportRows. */
  onApplyAccounts: (rows: ImportPreviewRow[]) => Promise<ImportResult>;
  /** Commit handler for the `contacts` section. */
  onApplyContacts: (rows: ImportPreviewRow[]) => Promise<ImportResult>;
  /** Commit handler for the `journalEntries` section. */
  onApplyJournalEntries: (rows: ImportPreviewRow[]) => Promise<ImportResult>;
  /**
   * Resolves the current org's Chart of Accounts as picker options. Optional;
   * if absent the default-mapping panel hides the account dropdown.
   * Caller owns Supabase access — keeps the wizard data-source-agnostic.
   */
  loadAccountOptions?: () => Promise<DefaultMappingOption[]>;
  /** Same shape for contacts. */
  loadContactOptions?: () => Promise<DefaultMappingOption[]>;
}

type SectionKey = 'accounts' | 'contacts' | 'journalEntries';

type SectionResult = {
  section: SectionKey;
  result: ImportResult | null;
  error?: string;
};

const SECTION_LABEL: Record<SectionKey, string> = {
  accounts: 'Chart of accounts',
  contacts: 'Contacts',
  journalEntries: 'Journal entries',
};

function readJsonFile(file: File): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        resolve(JSON.parse(String(reader.result ?? '')));
      } catch (err) {
        reject(new Error(`Could not parse as JSON: ${err instanceof Error ? err.message : String(err)}`));
      }
    };
    reader.onerror = () => reject(new Error('Could not read file.'));
    reader.readAsText(file);
  });
}

export function ImportFromOrangeRailsWizard({
  open,
  onClose,
  onApplyAccounts,
  onApplyContacts,
  onApplyJournalEntries,
  loadAccountOptions,
  loadContactOptions,
}: ImportFromOrangeRailsWizardProps) {
  const [step, setStep] = useState<Step>('upload');
  const [payload, setPayload] = useState<StagedImportPayload | null>(null);
  const [fileName, setFileName] = useState<string>('');
  const [parseError, setParseError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [progress, setProgress] = useState(0);
  const [currentSection, setCurrentSection] = useState<SectionKey | null>(null);
  const [results, setResults] = useState<SectionResult[]>([]);
  const [accountOptions, setAccountOptions] = useState<DefaultMappingOption[]>([]);
  const [contactOptions, setContactOptions] = useState<DefaultMappingOption[]>([]);
  const [defaults, setDefaults] = useState<DefaultMappingSelections>({});
  const fileRef = useRef<HTMLInputElement>(null);

  const reset = useCallback(() => {
    setStep('upload');
    setPayload(null);
    setFileName('');
    setParseError(null);
    setProgress(0);
    setCurrentSection(null);
    setResults([]);
    setDefaults({});
  }, []);

  const handleClose = useCallback(() => {
    reset();
    onClose();
  }, [reset, onClose]);

  const handleFile = useCallback(async (file: File) => {
    setFileName(file.name);
    setParseError(null);
    try {
      const json = await readJsonFile(file);
      assertStagedImportPayload(json);
      setPayload(json);
      setStep('review');
      // Lazy-load picker options after the payload parses; failure is
      // non-fatal — the panel just degrades to "no options available".
      const needAccounts = payloadHasEmptyAccountRows(json);
      const needContacts = payloadHasEmptyContactRows(json);
      if (needAccounts && loadAccountOptions) {
        loadAccountOptions().then(setAccountOptions).catch(() => setAccountOptions([]));
      }
      if (needContacts && loadContactOptions) {
        loadContactOptions().then(setContactOptions).catch(() => setContactOptions([]));
      }
    } catch (err) {
      setParseError(err instanceof Error ? err.message : String(err));
    }
  }, [loadAccountOptions, loadContactOptions]);

  const applySection = useCallback(
    async (
      activePayload: StagedImportPayload,
      section: SectionKey,
      handler: (rows: ImportPreviewRow[]) => Promise<ImportResult>,
    ): Promise<SectionResult> => {
      const rows = activePayload.staged[section] ?? [];
      if (rows.length === 0) return { section, result: { created: 0, skipped: 0, failed: 0, errors: [] } };
      try {
        const result = await handler(stagedRowsToPreview(rows));
        return { section, result };
      } catch (err) {
        return {
          section,
          result: null,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
    [],
  );

  const apply = useCallback(async () => {
    if (!payload) return;
    // Apply user-picked defaults in-memory; original payload is never mutated.
    const effective = applyDefaultMappings(payload, defaults);
    setStep('applying');
    setResults([]);
    const collected: SectionResult[] = [];
    const sections: Array<[SectionKey, (rows: ImportPreviewRow[]) => Promise<ImportResult>]> = [
      ['accounts', onApplyAccounts],
      ['contacts', onApplyContacts],
      ['journalEntries', onApplyJournalEntries],
    ];
    for (let i = 0; i < sections.length; i++) {
      const [section, handler] = sections[i];
      setCurrentSection(section);
      const res = await applySection(effective, section, handler);
      collected.push(res);
      setResults([...collected]);
      setProgress(Math.round(((i + 1) / sections.length) * 100));
      if (res.error && section === 'accounts') {
        // Accounts must succeed — JEs reference codes. Stop here.
        break;
      }
    }
    setCurrentSection(null);
    setStep('done');
  }, [payload, defaults, onApplyAccounts, onApplyContacts, onApplyJournalEntries, applySection]);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && handleClose()}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Import from Orange Rails</DialogTitle>
        </DialogHeader>

        {step === 'upload' && (
          <div
            className={cn(
              'border-2 border-dashed rounded-lg p-10 text-center cursor-pointer transition-colors',
              dragOver ? 'border-primary bg-primary/5' : 'border-muted-foreground/25',
            )}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              const f = e.dataTransfer.files[0];
              if (f) handleFile(f);
            }}
            onClick={() => fileRef.current?.click()}
          >
            <Upload className="mx-auto h-10 w-10 text-muted-foreground mb-3" />
            <p className="text-sm font-medium mb-1">Drop your <code>.or-import.json</code> here</p>
            <p className="text-xs text-muted-foreground">
              or click to choose a file. Produced by an Orange Rails connector (Wave, QuickBooks, ...).
            </p>
            <input
              ref={fileRef}
              type="file"
              accept=".json,application/json"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleFile(f);
              }}
            />
            {parseError && (
              <div className="mt-4 text-sm text-destructive flex items-center justify-center gap-2">
                <AlertTriangle className="h-4 w-4" />
                <span>{parseError}</span>
              </div>
            )}
            {fileName && !parseError && (
              <div className="mt-4 text-xs text-muted-foreground flex items-center justify-center gap-2">
                <FileText className="h-4 w-4" />
                <span>{fileName}</span>
              </div>
            )}
          </div>
        )}

        {step === 'review' && payload && (
          <div className="space-y-4">
            <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3 text-xs text-emerald-900">
              <p className="font-medium">Re-imports are safe.</p>
              <p className="mt-0.5 text-emerald-800">
                Rows already imported are skipped automatically — only what's new gets written.
                You can run this again with the same file without doubling up.
              </p>
            </div>
            <div className="rounded border bg-muted/40 p-4 text-sm space-y-1">
              <div>
                <span className="text-muted-foreground">Source: </span>
                <Badge variant="secondary">{payload.source.name}</Badge>
                <span className="text-muted-foreground ml-2">version {payload.source.version}</span>
              </div>
              <div className="text-xs text-muted-foreground">
                Exported {new Date(payload.source.exportedAt).toLocaleString()}
              </div>
              {payload.orgHint?.name && (
                <div className="text-xs">
                  <span className="text-muted-foreground">Org hint: </span>
                  {payload.orgHint.name}
                  {payload.orgHint.currency ? ` (${payload.orgHint.currency})` : ''}
                </div>
              )}
            </div>

            <div className="grid grid-cols-3 gap-3 text-center">
              <div className="rounded border p-3">
                <div className="text-2xl font-bold">{payload.summary.accounts}</div>
                <div className="text-xs text-muted-foreground">accounts</div>
              </div>
              <div className="rounded border p-3">
                <div className="text-2xl font-bold">{payload.summary.contacts}</div>
                <div className="text-xs text-muted-foreground">contacts</div>
              </div>
              <div className="rounded border p-3">
                <div className="text-2xl font-bold">{payload.summary.journalEntries}</div>
                <div className="text-xs text-muted-foreground">journal entries</div>
                <div className="text-xs text-muted-foreground">({payload.summary.journalLines} lines)</div>
              </div>
            </div>

            {payload.summary.warnings.length > 0 && (
              <div className="rounded border border-yellow-500/40 bg-yellow-500/10 p-3 text-sm">
                <div className="flex items-center gap-2 font-medium mb-1">
                  <AlertTriangle className="h-4 w-4" />
                  {payload.summary.warnings.length} warning{payload.summary.warnings.length === 1 ? '' : 's'}
                </div>
                <ul className="text-xs space-y-0.5 max-h-32 overflow-y-auto">
                  {payload.summary.warnings.slice(0, 20).map((w, i) => (
                    <li key={i} className="font-mono">{w}</li>
                  ))}
                  {payload.summary.warnings.length > 20 && (
                    <li className="italic text-muted-foreground">
                      …and {payload.summary.warnings.length - 20} more
                    </li>
                  )}
                </ul>
              </div>
            )}

            {payload.summary.errors.length > 0 && (
              <div className="rounded border border-destructive/40 bg-destructive/10 p-3 text-sm">
                <div className="flex items-center gap-2 font-medium mb-1 text-destructive">
                  <X className="h-4 w-4" />
                  {payload.summary.errors.length} error{payload.summary.errors.length === 1 ? '' : 's'}
                </div>
                <ul className="text-xs space-y-0.5 max-h-32 overflow-y-auto">
                  {payload.summary.errors.slice(0, 20).map((e, i) => (
                    <li key={i} className="font-mono">{e}</li>
                  ))}
                  {payload.summary.errors.length > 20 && (
                    <li className="italic text-muted-foreground">
                      …and {payload.summary.errors.length - 20} more
                    </li>
                  )}
                </ul>
              </div>
            )}

            <div className="rounded border p-3 text-xs space-y-1">
              <div className="font-medium mb-1">Source files</div>
              {payload.manifest.files.map((f) => (
                <div key={f.name} className="flex justify-between font-mono text-muted-foreground">
                  <span>{f.name}</span>
                  <span>{(f.sizeBytes / 1024).toFixed(1)} KB</span>
                </div>
              ))}
            </div>

            {(payloadHasEmptyAccountRows(payload) | payloadHasEmptyContactRows(payload)) && (
              <DefaultMappingPanel
                accountOptions={accountOptions}
                contactOptions={contactOptions}
                selections={defaults}
                onChange={setDefaults}
                hasEmptyAccounts={payloadHasEmptyAccountRows(payload)}
                hasEmptyContacts={payloadHasEmptyContactRows(payload)}
              />
            )}

            <div className="flex justify-between gap-2 pt-2">
              <Button variant="outline" onClick={reset}>
                Choose different file
              </Button>
              <Button onClick={apply}>Import everything</Button>
            </div>
          </div>
        )}

        {step === 'applying' && (
          <div className="space-y-3 py-6">
            <div className="flex items-center gap-2 text-sm">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span>
                Importing {currentSection ? SECTION_LABEL[currentSection].toLowerCase() : '...'}
              </span>
            </div>
            <Progress value={progress} />
          </div>
        )}

        {step === 'done' && (
          <div className="space-y-3">
            {results.map((r) => (
              <div key={r.section} className="rounded border p-3 text-sm">
                <div className="flex items-center gap-2 font-medium mb-1">
                  {r.error | (r.result && r.result.failed > 0) ? (
                    <AlertTriangle className="h-4 w-4 text-destructive" />
                  ) : (
                    <CheckCircle2 className="h-4 w-4 text-green-600" />
                  )}
                  {SECTION_LABEL[r.section]}
                </div>
                {r.error ? (
                  <div className="text-xs text-destructive">{r.error}</div>
                ) : r.result ? (
                  <div className="text-xs text-muted-foreground">
                    {r.result.created} created · {r.result.skipped} skipped · {r.result.failed} failed
                  </div>
                ) : null}
                {r.result?.errors?.length ? (
                  <ul className="text-xs text-destructive mt-1 max-h-20 overflow-y-auto">
                    {r.result.errors.slice(0, 5).map((e, i) => (
                      <li key={i} className="font-mono">{e}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ))}
            <div className="flex justify-end pt-2">
              <Button onClick={handleClose}>Done</Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
