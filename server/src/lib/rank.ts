/**
 * Lexical rank keys — fractional ordering in base-36 strings so a drag-reorder
 * is one UPDATE, never a renumber. `between(a, b)` returns a string strictly
 * between its arguments; pass null for the open end.
 *
 *   between(null, null) = "n"
 *   between("a", "b")   = "an"
 *   between("a", "an")  = "ag"  (midpoint digit-wise)
 */
const DIGITS = "0123456789abcdefghijklmnopqrstuvwxyz";
const BASE = DIGITS.length;
const MIN = DIGITS[0]; // "0"

function digit(s: string, i: number): number {
  return i < s.length ? DIGITS.indexOf(s[i]) : 0;
}

export function between(a: string | null, b: string | null): string {
  const lo = a ?? "";
  const hi = b ?? "";
  if (hi && lo >= hi) throw new Error(`rank: ${lo} >= ${hi}`);

  let out = "";
  for (let i = 0; ; i++) {
    const dLo = digit(lo, i);
    const dHi = hi ? (i < hi.length ? DIGITS.indexOf(hi[i]) : BASE) : BASE;
    if (dHi - dLo > 1) {
      // room for a midpoint digit here
      out += DIGITS[Math.floor((dLo + dHi) / 2)];
      return out;
    }
    // digits equal or adjacent — copy the low digit and keep walking
    out += DIGITS[dLo];
    if (dHi - dLo === 1) {
      // adjacent: everything after this position is bounded only below
      // by the rest of `lo`; find space past its end
      for (let j = i + 1; ; j++) {
        const d = digit(lo, j);
        if (d < BASE - 1) {
          // pick a digit above lo's digit (midpoint to base top)
          out += DIGITS[Math.min(d + Math.ceil((BASE - d) / 2), BASE - 1)];
          return out;
        }
        out += DIGITS[d];
      }
    }
  }
}

/** rank for appending at the end of a sequence */
export function after(last: string | null): string {
  return between(last, null);
}

/** rank for inserting at the head */
export function before(first: string | null): string {
  return between(null, first);
}

/** evenly-spaced initial ranks for n items */
export function spread(n: number): string[] {
  const out: string[] = [];
  let prev: string | null = null;
  for (let i = 0; i < n; i++) {
    prev = between(prev, null);
    out.push(prev);
  }
  return out;
}

/**
 * n strictly increasing, fixed-width ranks spread evenly over the key space,
 * for rebalancing a list whose ranks collided (M9). spread() above appends one
 * after another, which grows the keys by a character every few items; this
 * keeps them at 2-3 chars for any realistic list. No rank ends in "0": a key
 * with a trailing minimum digit breaks between() when used as the upper bound
 * (between("a", "a0") would return "a0i", which sorts after "a0").
 */
export function evenRanks(n: number): string[] {
  let width = 1;
  while (BASE ** width <= 2 * (n + 1)) width++;
  const space = BASE ** width;
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    let v = Math.floor(((i + 1) * space) / (n + 1));
    if (v % BASE === 0) v += 1; // spacing is >= 2, so this stays below the next key
    let str = "";
    for (let j = 0; j < width; j++) {
      str = DIGITS[v % BASE] + str;
      v = Math.floor(v / BASE);
    }
    out.push(str);
  }
  return out;
}

export { MIN };
