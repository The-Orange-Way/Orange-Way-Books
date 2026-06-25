import { parseCsvText } from './parse-csv-row';
import type { ImportPreviewRow } from '@/components/ui/import-popup';

export const TRANSACTION_COLUMNS = [
  'Date',
  'Wallet',
  'Direction',
  'Amount',
  'Account',
  'Contact',
  'Memo',
];

export const TRANSACTION_SAMPLE_CSV = `Date,Wallet,Direction,Amount,Account,Contact,Memo
2026-01-15,Petty Cash,INFLOW,500.00,Sales Revenue,Acme Corp,Payment received
2026-01-20,Trezor Vault,OUTFLOW,0.01000000,Cost of Sales,Lightning Labs,Service fee`;

const DIRECTION_MAP: Record<string, string> = {
  inflow: 'INFLOW',
  in: 'INFLOW',
  income: 'INFLOW',
  outflow: 'OUTFLOW',
  out: 'OUTFLOW',
  expense: 'OUTFLOW',
};

export function parseCsvTransactions(csvText: string): {
  rows: ImportPreviewRow[];
  errors: string[];
} {
  const { rows: parsed } = parseCsvText(csvText);
  const errors: string[] = [];
  if (parsed.length === 0) {
    errors.push('CSV file is empty or has no data rows.');
    return { rows: [], errors };
  }

  const rows: ImportPreviewRow[] = parsed.map((data, i) => {
    const rowErrors: string[] = [];
    if (!data.date?.trim()) rowErrors.push('Date is required');
    if (!data.wallet?.trim()) rowErrors.push('Wallet is required');
    const rawDir = (data.direction || '').toLowerCase().trim();
    const direction = DIRECTION_MAP[rawDir];
    if (!rawDir) rowErrors.push('Direction is required');
    else if (!direction) rowErrors.push(`Invalid direction: ${data.direction}`);
    if (!data.amount?.trim()) rowErrors.push('Amount is required');
    else if (isNaN(Number(data.amount))) rowErrors.push('Amount must be a number');

    return {
      rowIndex: i + 1,
      data: {
        date: data.date || '',
        wallet: data.wallet || '',
        direction: direction || rawDir.toUpperCase(),
        amount: data.amount || '',
        account: data.account || '',
        contact: data.contact || '',
        memo: data.memo || '',
      },
      error: rowErrors.length ? rowErrors.join('; ') : undefined,
    };
  });

  return { rows, errors };
}
