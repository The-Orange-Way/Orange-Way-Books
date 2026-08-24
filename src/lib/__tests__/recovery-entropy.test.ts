/**
 * Entropy guards for the 12-word recovery code.
 *
 * The recovery code is the only thing standing between a user who forgot
 * their vault password and permanent loss of their books, and it is also
 * the only thing standing between an attacker with the ciphertext and the
 * plaintext. deriveRecoveryKek deliberately does no password stretching,
 * on the stated grounds that the code carries 132 bits on its own. That
 * makes the generator's output distribution load-bearing rather than
 * merely nice: if it ever narrows, there is no work factor behind it to
 * take up the slack.
 *
 * The sibling app shipped exactly that failure and had to fix it: an
 * earlier generator there could only ever emit 251 of its wordlist's
 * entries, cutting a nominal 155-bit code to about 96 bits. Nothing in a
 * "returns 12 words" test notices that, because the output still looks
 * like a recovery code. These tests fail on it.
 *
 * Statistical bounds below are chosen so a correct generator fails less
 * than about once in ten million runs. They are not tight enough to catch
 * a subtle bias, only a structural one, which is the failure that has
 * actually happened.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { generateRecoveryCode } from '../vault';
import { BIP39_WORDS } from '../bip39-words';

const CODES = 4000;
const WORDS_PER_CODE = 12;
const DRAWS = CODES * WORDS_PER_CODE;
const N = 2048;

const INDEX_OF = new Map(BIP39_WORDS.map((w, i) => [w, i]));

function drawIndices(): number[] {
  const out: number[] = [];
  for (let i = 0; i < CODES; i++) {
    for (const w of generateRecoveryCode().split(' ')) {
      const idx = INDEX_OF.get(w);
      expect(idx, `generated word "${w}" is not in the wordlist`).toBeDefined();
      out.push(idx as number);
    }
  }
  return out;
}

describe('recovery code wordlist', () => {
  it('is the full 2048-entry BIP-39 English list with no repeats', () => {
    expect(BIP39_WORDS).toHaveLength(N);
    expect(new Set(BIP39_WORDS).size).toBe(N);
  });

  it('has a length that is an exact power of two, so 11-bit masking cannot bias', () => {
    expect(Math.log2(N) % 1).toBe(0);
  });
});

describe('recovery code entropy', () => {
  it('emits 12 words per code, every time', () => {
    for (let i = 0; i < 50; i++) {
      expect(generateRecoveryCode().split(' ')).toHaveLength(WORDS_PER_CODE);
    }
  });

  it('reaches the whole wordlist, not a low-index prefix', () => {
    const idx = drawIndices();
    const distinct = new Set(idx).size;

    // A byte-indexed or truncated list caps the maximum index. With 48,000
    // uniform draws over 2,048 buckets the chance of never seeing the top
    // or bottom 64 is indistinguishable from zero.
    expect(Math.max(...idx)).toBeGreaterThan(N - 64);
    expect(Math.min(...idx)).toBeLessThan(64);

    // Coupon-collector: 48,000 draws should reveal essentially all 2,048.
    expect(distinct).toBeGreaterThan(2040);
  });

  it('is uniform across the wordlist (chi-square, 2047 df)', () => {
    const counts = new Array<number>(N).fill(0);
    for (const i of drawIndices()) counts[i]++;

    const expected = DRAWS / N;
    let chi = 0;
    for (const c of counts) chi += ((c - expected) ** 2) / expected;

    // df = 2047, sd = sqrt(2*df) ~= 64. Six sigma either side. The lower
    // bound matters too: a chi-square far below df means the output is too
    // evenly spread to be random, which is what a counter or a shuffled
    // deck looks like.
    const df = N - 1;
    const sd = Math.sqrt(2 * df);
    expect(chi).toBeGreaterThan(df - 6 * sd);
    expect(chi).toBeLessThan(df + 6 * sd);
  });

  it('does not repeat a code, and does not favour any single word', () => {
    const codes = new Set<string>();
    const counts = new Array<number>(N).fill(0);
    for (let i = 0; i < CODES; i++) {
      const code = generateRecoveryCode();
      codes.add(code);
      for (const w of code.split(' ')) counts[INDEX_OF.get(w) as number]++;
    }
    expect(codes.size).toBe(CODES);

    // Expected 23.4 per word. A structural collapse shows up as one word
    // taking a large share of all draws.
    expect(Math.max(...counts)).toBeLessThan(DRAWS / 100);
  });

  it('positions are independent: no position is stuck on one word', () => {
    const perPosition: Array<Set<number>> = Array.from(
      { length: WORDS_PER_CODE },
      () => new Set<number>(),
    );
    for (let i = 0; i < 500; i++) {
      const words = generateRecoveryCode().split(' ');
      words.forEach((w, p) => perPosition[p].add(INDEX_OF.get(w) as number));
    }
    // 500 draws into 2,048 buckets: expect ~440 distinct at every position.
    for (const seen of perPosition) expect(seen.size).toBeGreaterThan(300);
  });
});

/**
 * The tests above measure the output distribution. That is necessary and it
 * is not sufficient, and the gap matters more here than it looks.
 *
 * Math.random is uniform. Swapping crypto.getRandomValues for it leaves
 * every statistic above perfectly healthy while making the recovery code
 * predictable from a handful of observed outputs, because the underlying
 * generator is seeded, not random. Weak-RNG incidents in hardware wallets
 * have this exact shape: the distribution looked fine and the source did
 * not. So pin the source, not just the histogram.
 */
describe('recovery code randomness source', () => {
  afterEach(() => vi.restoreAllMocks());

  it('draws from crypto.getRandomValues, once per code', () => {
    const spy = vi.spyOn(window.crypto, 'getRandomValues');
    generateRecoveryCode();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.results[0].value).toBeInstanceOf(Uint16Array);
    expect((spy.mock.results[0].value as Uint16Array).length).toBe(WORDS_PER_CODE);
  });

  it('never consults Math.random', () => {
    const spy = vi.spyOn(Math, 'random');
    for (let i = 0; i < 20; i++) generateRecoveryCode();
    expect(spy).not.toHaveBeenCalled();
  });

  it('maps CSPRNG bytes to words and nothing else (known answer)', () => {
    // Feeding a known buffer must produce a known code. If any part of the
    // output came from somewhere other than this buffer, this diverges.
    vi.spyOn(window.crypto, 'getRandomValues').mockImplementation(((buf: Uint16Array) => {
      for (let i = 0; i < buf.length; i++) buf[i] = i;
      return buf;
    }) as typeof window.crypto.getRandomValues);
    expect(generateRecoveryCode().split(' ')).toEqual(BIP39_WORDS.slice(0, WORDS_PER_CODE));
  });

  it('uses all 11 low bits, discarding the high 5 of each sample', () => {
    // 0xF800 is the five bits the mask throws away. If they leaked into the
    // index, these would not all be the wordlist's first entry.
    vi.spyOn(window.crypto, 'getRandomValues').mockImplementation(((buf: Uint16Array) => {
      buf.fill(0xf800);
      return buf;
    }) as typeof window.crypto.getRandomValues);
    const words = generateRecoveryCode().split(' ');
    expect(new Set(words).size).toBe(1);
    expect(words[0]).toBe(BIP39_WORDS[0]);

    vi.restoreAllMocks();
    vi.spyOn(window.crypto, 'getRandomValues').mockImplementation(((buf: Uint16Array) => {
      buf.fill(0xffff);
      return buf;
    }) as typeof window.crypto.getRandomValues);
    expect(generateRecoveryCode().split(' ')[0]).toBe(BIP39_WORDS[2047]);
  });
});
