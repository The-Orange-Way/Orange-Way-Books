import { formatNumericForCsvCell } from '@/lib/exports/format-numeric-csv';

/**
 * Generic CSV download (UTF-8 BOM + Excel-friendly number cells), aligned with the Orange Way Books reporting layer.
 *
 * **ZKA:** Runs entirely in the browser. The CSV string is never uploaded to Supabase
 * or legacy ledger backend; the user gets a local file after data was decrypted in-tab (vault unlock).
 */
export function exportToCsv(
  filename: string,
  headers: string[],
  rows: (string | number | null | undefined)[][],
): void {
  const escapeCell = (val: string | number | null | undefined): string => {
    if (val == null) {
      return '';
    }
    const str = typeof val === 'number' ? formatNumericForCsvCell(val) : String(val);
    if (str.includes(',') | str.includes('"') | str.includes('\n')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  const csvContent = [
    headers.map(escapeCell).join(','),
    ...rows.map((row) => row.map(escapeCell).join(',')),
  ].join('\n');

  const blob = new Blob(['\uFEFF', csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename.endsWith('.csv') ? filename : `${filename}.csv`;
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
