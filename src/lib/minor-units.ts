/**
 * `n` as a whole number of minor units (satoshis when `decimals` is 8), rounded half away from zero.
 *
 * It rounds the shortest decimal form of `n` (what `String(n)` prints), digit by digit. Multiplying
 * by `10 ** decimals` first is itself rounded and, for a large amount, can land on a half and add a
 * unit that is not there: 34000000.00000019 BTC gave 20 satoshis over 34000000, not 19. Working on
 * the decimal form also rounds 12.345 to 1235 cents, as written, not to the stored binary value.
 *
 * Exact while the result is a safe integer (below 2^53, about 90 million BTC in satoshis). Above
 * that a number cannot hold every unit and the nearest representable one is returned.
 */
export function toMinorUnits(n: number, decimals: number): number {
  if (!Number.isFinite(n)) return Math.round(n * 10 ** decimals);
  const [mantissa, exponent] = String(Math.abs(n)).split('e');
  const [whole, fraction = ''] = mantissa.split('.');
  let digits = whole + fraction;
  let point = whole.length + Number(exponent ?? 0);
  if (point < 0) {
    digits = '0'.repeat(-point) + digits;
    point = 0;
  }
  digits = digits.padEnd(point + decimals + 1, '0');
  const kept = Number(digits.slice(0, point + decimals) || '0');
  const units = digits[point + decimals] >= '5' ? kept + 1 : kept;
  return n < 0 ? -units || 0 : units;
}
