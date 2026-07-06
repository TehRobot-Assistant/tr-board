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

export { MIN };
