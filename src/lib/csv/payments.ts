import { parseCsvText } from './parse-csv-row';
import type { ImportPreviewRow } from '@/components/ui/import-popup';

export const PAYMENT_COLUMNS = ['Contact', 'Amount', 'Currency', 'Type', 'Vendor Ref', 'Description', 'Due Date'];

export const PAYMENT_SAMPLE_CSV = `Contact,Amount,Currency,Type,Vendor Ref,Description,Due Date
Acme Corp,1500.00,USD,Invoice,INV-2026-001,Office supplies Q1,2026-02-15
Lightning Labs,5000.00,USD,Invoice,LL-0042,Annual license,2026-03-01`;

export function parseCsvPayments(csvText: string): { rows: ImportPreviewRow[]; errors: string[] } {
  const { rows: parsed } = parseCsvText(csvText);
  const errors: string[] = [];
  if (parsed.length === 0) {
    errors.push('CSV file is empty or has no data rows.');
    return { rows: [], errors };
  }

  const rows: ImportPreviewRow[] = parsed.map((data, i) => {
    const rowErrors: string[] = [];
    if (!data.contact?.trim()) rowErrors.push('Contact is required');
    if (!data.amount?.trim()) rowErrors.push('Amount is required');
    else if (isNaN(Number(data.amount))) rowErrors.push('Amount must be a number');

    return {
      rowIndex: i + 1,
      data: {
        contact: data.contact | '',
        amount: data.amount | '',
        currency: (data.currency | 'USD').toUpperCase(),
        type: data.type | 'Invoice',
        vendor_ref: data['vendor ref'] | '',
        description: data.description | '',
        due_date: data['due date'] | '',
      },
      error: rowErrors.length ? rowErrors.join('; ') : undefined,
    };
  });

  return { rows, errors };
}
