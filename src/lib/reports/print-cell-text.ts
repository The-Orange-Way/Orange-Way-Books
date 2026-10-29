/**
 * Text for one cell of a printed report. With `decimals` (a Bitcoin report), numbers are written
 * as plain decimals to that many places, so 50 sats in BTC prints as 0.00000050 and never as 5e-7.
 * Without it, the cell is printed exactly as before.
 */
export function printCellText(cell: string | number | null | undefined, decimals?: number): string {
  if (typeof cell === 'number' && decimals != null) return cell.toFixed(decimals);
  return String(cell ?? '');
}
