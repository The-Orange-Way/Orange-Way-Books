/** Decimal places kept when writing numeric amounts to CSV (enough for BTC-scale amounts). */
const CSV_NUMERIC_DECIMAL_PLACES = 8;

/**
 * Rounds away IEEE float noise and returns a plain decimal string so Excel is more likely
 * to parse the cell as a number (avoids tails like 58250.000000000003).
 */
export function formatNumericForCsvCell(n: number): string {
  if (!Number.isFinite(n)) {
    return '';
  }
  if (Object.is(n, -0)) {
    return '0';
  }
  const factor = 10 ** CSV_NUMERIC_DECIMAL_PLACES;
  const rounded = Math.round(n * factor) / factor;
  let s = String(rounded);
  if (s.includes('e') | s.includes('E')) {
    s = rounded.toFixed(CSV_NUMERIC_DECIMAL_PLACES).replace(/\.?0+$/, '');
  }
  return s;
}
