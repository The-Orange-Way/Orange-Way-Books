import { parseCsvText } from './parse-csv-row';
import type { ImportPreviewRow } from '@/components/ui/import-popup';

export const CONTACT_COLUMNS = [
  'Name',
  'Type',
  'Email',
  'Phone',
  'Street',
  'City',
  'State',
  'Country',
  'Zip',
];

export const CONTACT_SAMPLE_CSV = `Name,Type,Email,Phone,Street,City,State,Country,Zip
Acme Corp,Vendor,billing@acme.com,555-0100,123 Main St,Austin,TX,US,78701
Lightning Labs,Vendor,info@ll.com,,,,,
John Smith,Customer,john@example.com,555-0300,789 Elm St,Portland,OR,US,97201`;

const VALID_TYPES = ['Vendor', 'Customer', 'Employee', 'Other'];

export function parseCsvContacts(csvText: string): { rows: ImportPreviewRow[]; errors: string[] } {
  const { rows: parsed } = parseCsvText(csvText);
  const errors: string[] = [];
  if (parsed.length === 0) {
    errors.push('CSV file is empty or has no data rows.');
    return { rows: [], errors };
  }

  const rows: ImportPreviewRow[] = parsed.map((data, i) => {
    const rowErrors: string[] = [];
    if (!data.name?.trim()) rowErrors.push('Name is required');
    const rawType = data.type?.trim() | '';
    const type =
      VALID_TYPES.find((t) => t.toLowerCase() === rawType.toLowerCase()) |
      (rawType ? null : 'Other');
    if (type === null) rowErrors.push(`Invalid type: ${rawType}`);

    return {
      rowIndex: i + 1,
      data: {
        name: data.name | '',
        type: type | 'Other',
        email: data.email | '',
        phone: data.phone | '',
        street: data.street | '',
        city: data.city | '',
        state: data.state | '',
        country: data.country | '',
        zip: data.zip | '',
      },
      error: rowErrors.length ? rowErrors.join('; ') : undefined,
    };
  });

  return { rows, errors };
}
