import { toDecimalString } from '@/lib/minor-units';

/** Decimal places kept when writing numeric amounts to CSV (enough for BTC-scale amounts). */
const CSV_NUMERIC_DECIMAL_PLACES = 8;

/**
 * Rounds away IEEE float noise and returns a plain decimal string so Excel is more likely
 * to parse the cell as a number (avoids tails like 58250.000000000003). The rounding works on the
 * digits, so a large whole number such as a satoshi count is written exactly.
 */
export function formatNumericForCsvCell(n: number): string {
  if (!Number.isFinite(n)) {
    return '';
  }
  return toDecimalString(n, CSV_NUMERIC_DECIMAL_PLACES);
}
