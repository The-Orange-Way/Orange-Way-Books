import { parseCsvText } from './parse-csv-row';
import type { ImportPreviewRow } from '@/components/ui/import-popup';

export const ACCOUNT_COLUMNS = ['Name', 'Currency', 'Type', 'Institution', 'Balance', 'Date'];

export const ACCOUNT_SAMPLE_CSV = `Name,Currency,Type,Institution,Balance,Date
Petty Cash,USD,BANK,Local Credit Union,500.00,2026-01-01
Trezor Vault,BTC,HARDWARE,Trezor,0.25000000,2026-01-01
Kraken Trading,BTC,EXCHANGE,Kraken,0.75000000,2026-01-01
Business Savings,USD,BANK,Wells Fargo,25000.00,2026-01-01`;

const VALID_TYPES = ['EXCHANGE', 'HARDWARE', 'SOFTWARE', 'BANK', 'CUSTODIAL'];

export function parseCsvAccounts(csvText: string): { rows: ImportPreviewRow[]; errors: string[] } {
  const { rows: parsed } = parseCsvText(csvText);
  const errors: string[] = [];
  if (parsed.length === 0) {
    errors.push('CSV file is empty or has no data rows.');
    return { rows: [], errors };
  }

  const rows: ImportPreviewRow[] = parsed.map((data, i) => {
    const rowErrors: string[] = [];
    if (!data.name?.trim()) rowErrors.push('Name is required');
    if (!data.currency?.trim()) rowErrors.push('Currency is required');
    const type = (data.type | '').toUpperCase();
    if (type && !VALID_TYPES.includes(type)) rowErrors.push(`Invalid type: ${data.type}`);
    if (data.balance && isNaN(Number(data.balance))) rowErrors.push('Balance must be a number');

    return {
      rowIndex: i + 1,
      data: {
        name: data.name | '',
        currency: (data.currency | '').toUpperCase(),
        type: type | 'EXCHANGE',
        institution: data.institution | '',
        balance: data.balance | '0',
        date: data.date | '',
      },
      error: rowErrors.length ? rowErrors.join('; ') : undefined,
    };
  });

  return { rows, errors };
}
