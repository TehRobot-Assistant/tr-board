/**
 * TOTP (RFC 6238: HMAC-SHA1, 6 digits, 30 s steps), the variant every
 * authenticator app supports. Written here instead of pulling in a package:
 * it is ~40 lines over node:crypto and is checked against the RFC's own test
 * vectors (test/units.test.ts). Pure, no DB.
 */
import crypto from "node:crypto";

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export const STEP_SECONDS = 30;

export function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error("invalid base32");
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** 160-bit secret, the size RFC 4226 recommends for SHA1 */
export const newSecret = () => base32Encode(crypto.randomBytes(20));

export function hotp(key: Buffer, counter: number, digits = 6, algo = "sha1"): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = crypto.createHmac(algo, key).update(msg).digest();
  const off = mac[mac.length - 1] & 0xf;
  const bin = (mac.readUInt32BE(off) & 0x7fffffff) % 10 ** digits;
  return String(bin).padStart(digits, "0");
}

export const stepAt = (ms: number) => Math.floor(ms / 1000 / STEP_SECONDS);

/**
 * The step a code matches, or null. One step either side is accepted for
 * phone clock drift (the usual tolerance); callers then refuse any step at or
 * below the last accepted one, so a code is single-use.
 */
export function matchStep(secretB32: string, code: string, nowMs = Date.now(), window = 1): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const key = base32Decode(secretB32);
  const now = stepAt(nowMs);
  for (let d = -window; d <= window; d++) {
    const cand = hotp(key, now + d);
    if (crypto.timingSafeEqual(Buffer.from(cand), Buffer.from(code))) return now + d;
  }
  return null;
}

export function otpauthUrl(secretB32: string, account: string, issuer = "TR Board"): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const q = new URLSearchParams({ secret: secretB32, issuer, algorithm: "SHA1", digits: "6", period: String(STEP_SECONDS) });
  return `otpauth://totp/${label}?${q}`;
}

/** recovery code: 16 base32 chars (80 bits), shown as xxxx-xxxx-xxxx-xxxx */
export function newRecoveryCode(): string {
  const raw = base32Encode(crypto.randomBytes(10)).toLowerCase();
  return raw.match(/.{4}/g)!.join("-");
}

/** normalise what a user typed (case, dashes, spaces) before hashing */
export const normaliseRecoveryCode = (s: string) => s.toLowerCase().replace(/[^a-z2-7]/g, "");
