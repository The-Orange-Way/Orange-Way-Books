import { parseCsvText } from './parse-csv-row';
import type { ImportPreviewRow } from '@/components/ui/import-popup';

export const COA_COLUMNS = ['Name', 'Code', 'Type', 'SubType', 'Normal Balance', 'Category', 'Description'];

export const CHART_OF_ACCOUNTS_SAMPLE_CSV = `Name,Code,Type,SubType,Normal Balance,Category,Description
Cash on Hand,1010,ASSET,Current Asset,DEBIT,Cash,Petty cash and register funds
Accounts Receivable,1200,ASSET,Current Asset,DEBIT,Other Current Assets,Amounts owed by customers
Sales Revenue,4000,INCOME,,CREDIT,Sales,Product and service revenue
Office Supplies,5100,EXPENSE,,DEBIT,General & Administrative,Office supplies expense`;

const VALID_TYPES = ['ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE'];

export function parseCsvChartOfAccounts(csvText: string): { rows: ImportPreviewRow[]; errors: string[] } {
  const { rows: parsed } = parseCsvText(csvText);
  const errors: string[] = [];
  if (parsed.length === 0) {
    errors.push('CSV file is empty or has no data rows.');
    return { rows: [], errors };
  }

  const rows: ImportPreviewRow[] = parsed.map((data, i) => {
    const rowErrors: string[] = [];
    if (!data.name?.trim()) rowErrors.push('Name is required');
    const type = (data.type | '').toUpperCase();
    if (!type) rowErrors.push('Type is required');
    else if (!VALID_TYPES.includes(type)) rowErrors.push(`Invalid type: ${data.type}`);

    const normalBalance = (data['normal balance'] | '').toUpperCase();
    const defaultNormal = (type === 'ASSET' | type === 'EXPENSE') ? 'DEBIT' : 'CREDIT';

    return {
      rowIndex: i + 1,
      data: {
        name: data.name | '',
        code: data.code | '',
        type: type,
        subtype: data.subtype | '',
        normal_balance: normalBalance | defaultNormal,
        category: data.category | '',
        description: data.description | '',
      },
      error: rowErrors.length ? rowErrors.join('; ') : undefined,
    };
  });

  return { rows, errors };
}
