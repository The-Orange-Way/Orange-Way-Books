import { useState, useRef, useCallback } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Upload, Download, CheckCircle2, AlertTriangle, FileText, Info } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface ImportPreviewRow {
  rowIndex: number;
  data: Record<string, string>;
  error?: string;
}

export interface ImportResult {
  created: number;
  skipped: number;
  failed: number;
  errors: string[];
  warnings?: string[];
}

export interface ImportPopupProps {
  open: boolean;
  onClose: () => void;
  entityName: string;
  sampleCsvContent: string;
  sampleFileName: string;
  columns: string[];
  tips?: string[];
  parseCsv: (csvText: string) => { rows: ImportPreviewRow[]; errors: string[] };
  onImportRows: (rows: ImportPreviewRow[]) => Promise<ImportResult>;
}

type Step = 'upload' | 'preview' | 'importing' | 'results';

/** Avoid showing raw browser/crypto errors to end users (friendly tone). */
function friendlyImportCatchMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const lower = raw.toLowerCase();
  if (
    lower.includes('atob')
    | lower.includes('decode')
    | lower.includes('base64')
    | lower.includes('invalidcharactererror')
    | lower.includes('incorrectly encoded')
  ) {
    return 'Could not read your saved wallets in the browser. Refresh the page, unlock your vault again, then try importing. If this keeps happening, contact support.';
  }
  if (lower.includes('failed to fetch') | lower.includes('networkerror') | lower.includes('load failed')) {
    return 'Could not reach the server. Check your internet connection and try again.';
  }
  if (raw.length > 280) {
    return `${raw.slice(0, 280)}…`;
  }
  return raw;
}

export function ImportPopup({
  open, onClose, entityName, sampleCsvContent, sampleFileName,
  columns, tips, parseCsv, onImportRows,
}: ImportPopupProps) {
  const [step, setStep] = useState<Step>('upload');
  const [rows, setRows] = useState<ImportPreviewRow[]>([]);
  const [parseErrors, setParseErrors] = useState<string[]>([]);
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const reset = useCallback(() => {
    setStep('upload');
    setRows([]);
    setParseErrors([]);
    setProgress(0);
    setResult(null);
  }, []);

  const handleClose = () => {
    reset();
    onClose();
  };

  const handleFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target?.result as string;
      const { rows: parsed, errors } = parseCsv(text);
      setRows(parsed);
      setParseErrors(errors);
      if (parsed.length > 0) setStep('preview');
      else if (errors.length > 0) setParseErrors(errors);
    };
    reader.readAsText(file);
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  };

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
  };

  const downloadSample = () => {
    const blob = new Blob([sampleCsvContent], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = sampleFileName;
    a.click();
    URL.revokeObjectURL(url);
  };

  const validRows = rows.filter(r => !r.error);
  const errorRows = rows.filter(r => !!r.error);

  const handleImport = async () => {
    setStep('importing');
    setProgress(10);
    const interval = setInterval(() => {
      setProgress(p => Math.min(p + 5, 90));
    }, 200);
    try {
      const res = await onImportRows(validRows);
      setResult(res);
      setProgress(100);
      setTimeout(() => setStep('results'), 300);
    } catch (err: unknown) {
      setResult({
        created: 0,
        skipped: 0,
        failed: validRows.length,
        errors: [friendlyImportCatchMessage(err)],
      });
      setStep('results');
    } finally {
      clearInterval(interval);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) handleClose(); }}>
      <DialogContent className="sm:max-w-[720px] max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Import {entityName}</DialogTitle>
        </DialogHeader>

        {/* UPLOAD */}
        {step === 'upload' && (
          <div className="space-y-4">
            {tips && tips.length > 0 && (
              <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 text-sm text-blue-800">
                <div className="flex items-start gap-2">
                  <Info className="w-4 h-4 mt-0.5 shrink-0" />
                  <div>
                    <p className="font-medium mb-1">Tips</p>
                    <ul className="list-disc pl-4 space-y-0.5">
                      {tips.map((t, i) => <li key={i}>{t}</li>)}
                    </ul>
                  </div>
                </div>
              </div>
            )}

            <Button variant="outline" size="sm" onClick={downloadSample}>
              <Download className="w-4 h-4 mr-1" />Download Sample CSV
            </Button>

            <div
              className={cn(
                'border-2 border-dashed rounded-lg p-10 text-center cursor-pointer transition-colors',
                dragOver ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/50'
              )}
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={onDrop}
              onClick={() => fileRef.current?.click()}
            >
              <Upload className="w-8 h-8 mx-auto mb-2 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">Drag & drop a CSV file here, or click to browse</p>
              <p className="text-xs text-muted-foreground mt-1">Expected columns: {columns.join(', ')}</p>
              <input ref={fileRef} type="file" accept=".csv,text/csv" className="hidden" onChange={onFileChange} />
            </div>

            {parseErrors.length > 0 && (
              <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">
                {parseErrors.map((e, i) => <p key={i}>{e}</p>)}
              </div>
            )}
          </div>
        )}

        {/* PREVIEW */}
        {step === 'preview' && (
          <div className="space-y-4 flex-1 min-h-0 flex flex-col">
            <div className="flex items-center justify-between">
              <p className="text-sm text-muted-foreground">
                {validRows.length} ready · {errorRows.length} with errors · {rows.length} total
              </p>
              <Button variant="ghost" size="sm" onClick={reset}>← Back</Button>
            </div>

            {/* Plain scroll container with overflow:auto so horizontal + vertical scroll work (Radix ScrollArea was vertical-only and w-full table never overflowed). */}
            <div className="flex-1 min-h-0 max-h-[280px] overflow-auto border border-border rounded-lg">
              <table className="min-w-full w-max border-collapse text-xs">
                <thead>
                  <tr className="border-b border-border">
                    <th className="sticky top-0 z-10 bg-muted/95 backdrop-blur supports-[backdrop-filter]:bg-muted/80 text-left px-2.5 py-2 font-semibold text-muted-foreground uppercase text-[10px] tracking-wide">
                      #
                    </th>
                    {columns.map(c => (
                      <th
                        key={c}
                        className="sticky top-0 z-10 bg-muted/95 backdrop-blur supports-[backdrop-filter]:bg-muted/80 text-left px-2.5 py-2 font-semibold text-muted-foreground uppercase text-[10px] tracking-wide"
                      >
                        {c}
                      </th>
                    ))}
                    <th className="sticky top-0 z-10 bg-muted/95 backdrop-blur supports-[backdrop-filter]:bg-muted/80 text-left px-2.5 py-2 font-semibold text-muted-foreground uppercase text-[10px] tracking-wide">
                      Status
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr
                      key={row.rowIndex}
                      className={cn(
                        'border-b border-border last:border-0',
                        row.error && 'bg-red-50/80'
                      )}
                    >
                      <td className="px-2.5 py-1.5 text-muted-foreground whitespace-nowrap">{row.rowIndex}</td>
                      {columns.map(c => {
                        const key = c.toLowerCase().replace(/ /g, '_');
                        const val = row.data[key] | row.data[c.toLowerCase().replace(/ /g, ' ')] | row.data[c.toLowerCase()] | row.data[c] | '—';
                        return (
                          <td
                            key={c}
                            className="px-2.5 py-1.5 max-w-[180px] whitespace-nowrap overflow-hidden text-ellipsis text-foreground"
                            title={String(val)}
                          >
                            {val}
                          </td>
                        );
                      })}
                      <td className="px-2.5 py-1.5 min-w-[220px] max-w-[320px] whitespace-normal align-top text-[11px] leading-snug">
                        {row.error ? (
                          <span className="text-red-600">{row.error}</span>
                        ) : (
                          <span className="text-green-600 font-medium">Ready</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={handleClose}>Cancel</Button>
              <Button
                onClick={handleImport}
                disabled={validRows.length === 0}
                className="bg-[var(--color-brand-orange)] hover:bg-[var(--color-brand-orange-hover)] text-white"
              >
                <FileText className="w-4 h-4 mr-1" />
                Import {validRows.length} {entityName}
              </Button>
            </div>
          </div>
        )}

        {/* IMPORTING */}
        {step === 'importing' && (
          <div className="py-8 space-y-4">
            <p className="text-sm text-center text-muted-foreground">Importing {entityName}...</p>
            <Progress value={progress} className="h-2" />
            <p className="text-xs text-center text-muted-foreground">{progress}%</p>
          </div>
        )}

        {/* RESULTS */}
        {step === 'results' && result && (
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              {result.failed === 0 ? (
                <CheckCircle2 className="w-8 h-8 text-green-500" />
              ) : (
                <AlertTriangle className="w-8 h-8 text-amber-500" />
              )}
              <div>
                <p className="font-medium">
                  {result.failed === 0 ? 'Import Complete' : 'Import Completed with Issues'}
                </p>
                <p className="text-sm text-muted-foreground">
                  {result.created} created · {result.skipped} skipped · {result.failed} failed
                </p>
              </div>
            </div>

            {result.warnings && result.warnings.length > 0 && (
              <div className="bg-muted rounded-lg p-3 text-sm space-y-1 max-h-[120px] overflow-y-auto">
                <p className="font-medium text-muted-foreground text-xs uppercase">Skipped</p>
                {result.warnings.map((w, i) => <p key={i} className="text-muted-foreground text-xs">{w}</p>)}
              </div>
            )}

            {result.errors.length > 0 && (
              <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm space-y-1 max-h-[120px] overflow-y-auto">
                <p className="font-medium text-red-700 text-xs uppercase">Errors</p>
                {result.errors.map((e, i) => <p key={i} className="text-red-600 text-xs">{e}</p>)}
              </div>
            )}

            <div className="flex justify-end">
              <Button onClick={handleClose}>Done</Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
