/** The shortest decimal form of |n| (what `String(n)` prints) as its digits and decimal point. */
function decimalDigits(n: number): { digits: string; point: number } {
  const [mantissa, exponent] = String(Math.abs(n)).split('e');
  const [whole, fraction = ''] = mantissa.split('.');
  let digits = whole + fraction;
  let point = whole.length + Number(exponent ?? 0);
  if (point < 0) {
    digits = '0'.repeat(-point) + digits;
    point = 0;
  }
  return { digits, point };
}

/** Number of fraction digits in the shortest decimal form of `n`. */
function fractionLength(n: number): number {
  const { digits, point } = decimalDigits(n);
  return Math.max(0, digits.length - point);
}

/** `n` exactly, as an integer count of 10^-scale; `scale` must be at least its fraction length. */
function toScaled(n: number, scale: number): bigint {
  const { digits, point } = decimalDigits(n);
  const v = BigInt(digits.padEnd(point + scale, '0') || '0');
  return n < 0 ? -v : v;
}

/** `v`, a count of 10^-drop units, rounded half away from zero to whole units. */
function roundScaled(v: bigint, drop: number): bigint {
  if (drop === 0) return v;
  const f = 10n ** BigInt(drop);
  const a = v < 0n ? -v : v;
  const q = a / f + ((a % f) * 2n >= f ? 1n : 0n);
  return v < 0n ? -q : q;
}

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
  const { digits, point } = decimalDigits(n);
  const padded = digits.padEnd(point + decimals + 1, '0');
  const kept = Number(padded.slice(0, point + decimals) || '0');
  const units = padded[point + decimals] >= '5' ? kept + 1 : kept;
  return n < 0 ? -units || 0 : units;
}

/**
 * Rounds a group of amounts to whole minor units so they sum to their exact total rounded once.
 * Each amount is rounded half away from zero; the units the group is then off by go one each to
 * the amounts rounded furthest the other way, in `order(rest)` order. The arithmetic is exact
 * decimal (on the shortest form of each amount), so a balanced group stays balanced at any size.
 *
 * `tieOrder(a, b)` breaks ties between two amounts whose remainders are equal; it must not depend
 * on input order if mirror-image groups should round as mirror images.
 */
export function roundGroupToMinorUnits(
  amounts: readonly number[],
  decimals: number,
  tieOrder: (a: number, b: number) => number,
): number[] {
  const scale = Math.max(decimals, ...amounts.map(fractionLength));
  const drop = scale - decimals;
  const unit = 10n ** BigInt(drop);
  const exact = amounts.map((a) => toScaled(a, scale));
  const units = exact.map((v) => roundScaled(v, drop));
  const total = roundScaled(
    exact.reduce((s, v) => s + v, 0n),
    drop,
  );
  let leftover = total - units.reduce((s, u) => s + u, 0n);
  if (leftover !== 0n) {
    const dir = leftover > 0n ? 1n : -1n;
    // How far each amount was rounded the other way from the leftover's direction.
    const rest = exact.map((v, i) => (v - units[i] * unit) * dir);
    const order = amounts
      .map((_, i) => i)
      .sort((a, b) => (rest[b] > rest[a] ? 1 : rest[b] < rest[a] ? -1 : tieOrder(a, b)));
    for (let n = 0; leftover !== 0n && n < order.length; n++) {
      units[order[n]] += dir;
      leftover -= dir;
    }
  }
  return units.map((u) => Number(u));
}

/**
 * `n` rounded half away from zero to `decimals` places, as a plain decimal string with no trailing
 * zeros and no exponent. Works on the digits, so a whole number of satoshis is never scaled by
 * 10^decimals and back.
 */
export function toDecimalString(n: number, decimals: number): string {
  if (!Number.isFinite(n)) return '';
  const scale = Math.max(decimals, fractionLength(n));
  const v = roundScaled(toScaled(n, scale), scale - decimals);
  const neg = v < 0n;
  const s = (neg ? -v : v).toString().padStart(decimals + 1, '0');
  const whole = s.slice(0, s.length - decimals);
  const fraction = s.slice(s.length - decimals).replace(/0+$/, '');
  const out = fraction ? `${whole}.${fraction}` : whole;
  return neg && out !== '0' ? `-${out}` : out;
}
