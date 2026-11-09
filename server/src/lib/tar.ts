/**
 * Minimal POSIX tar (ustar + pax long names/sizes) for backup archives.
 * Hand-written rather than the `tar` package: the writer only needs regular
 * files, and the reader deliberately accepts ONLY regular files and
 * directories (no links, devices or GNU extensions), which is the safe subset
 * for restoring an uploaded archive. Output is standard: `tar -xzf` reads it
 * (checked in test/units.test.ts).
 */
import crypto from "node:crypto";
import { once } from "node:events";
import type { Readable, Writable } from "node:stream";

const BLOCK = 512;
const MAX_USTAR_SIZE = 0o77777777777; // 11 octal digits

function octal(n: number, width: number): string {
  return n.toString(8).padStart(width - 1, "0") + "\0";
}

function header(name: string, size: number, type: "0" | "x", mtime: number): Buffer {
  const h = Buffer.alloc(BLOCK);
  h.write(name, 0, 100, "utf8");
  h.write(octal(type === "x" ? 0o644 : 0o600, 8), 100);
  h.write(octal(0, 8), 108);
  h.write(octal(0, 8), 116);
  h.write(octal(Math.min(size, MAX_USTAR_SIZE), 12), 124);
  h.write(octal(Math.floor(mtime / 1000), 12), 136);
  h.write("        ", 148); // checksum placeholder (spaces)
  h.write(type, 156);
  h.write("ustar\0", 257);
  h.write("00", 263);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(octal(sum, 7) + " ", 148);
  return h;
}

function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  let len = Buffer.byteLength(body) + 1;
  while (String(len).length + Buffer.byteLength(body) !== len) len = String(len).length + Buffer.byteLength(body);
  return `${len}${body}`;
}

const pad = (size: number) => (BLOCK - (size % BLOCK)) % BLOCK;

async function write(out: Writable, chunk: Buffer): Promise<void> {
  if (!out.write(chunk)) await once(out, "drain");
}

/** Streams entries into `out` (usually a gzip stream). Returns each entry's sha256. */
export class TarWriter {
  constructor(private out: Writable) {}

  /** `source` must yield exactly `size` bytes */
  async add(name: string, size: number, source: Readable | Buffer, mtime = Date.now()): Promise<string> {
    const nameBytes = Buffer.byteLength(name);
    if (nameBytes > 100 || size > MAX_USTAR_SIZE) {
      const rec =
        (nameBytes > 100 ? paxRecord("path", name) : "") + (size > MAX_USTAR_SIZE ? paxRecord("size", String(size)) : "");
      const data = Buffer.from(rec, "utf8");
      await write(this.out, header("PaxHeader", data.length, "x", mtime));
      await write(this.out, Buffer.concat([data, Buffer.alloc(pad(data.length))]));
    }
    // a long name's ustar field holds a truncated copy; pax readers use the record
    await write(this.out, header(Buffer.from(name).subarray(0, 100).toString("utf8").replace(/�$/, ""), size, "0", mtime));
    const hash = crypto.createHash("sha256");
    let seen = 0;
    if (Buffer.isBuffer(source)) {
      hash.update(source);
      seen = source.length;
      await write(this.out, source);
    } else {
      for await (const chunk of source) {
        const b = chunk as Buffer;
        hash.update(b);
        seen += b.length;
        await write(this.out, b);
      }
    }
    if (seen !== size) throw new Error(`${name} changed size while being archived (${size} -> ${seen})`);
    if (pad(size)) await write(this.out, Buffer.alloc(pad(size)));
    return hash.digest("hex");
  }

  async finish(): Promise<void> {
    await write(this.out, Buffer.alloc(BLOCK * 2));
    this.out.end();
    await once(this.out, "finish");
  }
}

/** pulls exact byte counts out of a stream */
class ByteReader {
  private buf: Buffer = Buffer.alloc(0);
  private it: AsyncIterator<Buffer>;
  private done = false;
  constructor(src: Readable) {
    this.it = src[Symbol.asyncIterator]();
  }
  private async fill(n: number): Promise<boolean> {
    while (this.buf.length < n && !this.done) {
      const r = await this.it.next();
      if (r.done) this.done = true;
      else this.buf = this.buf.length ? Buffer.concat([this.buf, r.value]) : r.value;
    }
    return this.buf.length >= n;
  }
  async read(n: number): Promise<Buffer> {
    if (!(await this.fill(n))) throw new Error("archive is truncated");
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return out;
  }
  /** up to n bytes (at least 1), for streaming file bodies */
  async readSome(n: number): Promise<Buffer> {
    if (!this.buf.length && !(await this.fill(1))) throw new Error("archive is truncated");
    const k = Math.min(n, this.buf.length);
    const out = this.buf.subarray(0, k);
    this.buf = this.buf.subarray(k);
    return out;
  }
}

function parseOctal(b: Buffer): number {
  const s = b.toString("latin1").replace(/\0.*$/s, "").trim();
  if (!/^[0-7]*$/.test(s)) throw new Error("bad tar header");
  return s ? parseInt(s, 8) : 0;
}

export type TarEntry = { name: string; size: number };

/**
 * Read entries one by one. `onEntry` gets the name/size and must consume the
 * body through the provided `chunks()` iterator (or skip it). Throws on
 * anything that isn't a plain file or directory.
 */
export async function readTar(
  src: Readable,
  onEntry: (e: TarEntry, chunks: () => AsyncGenerator<Buffer>) => Promise<void>,
): Promise<void> {
  const r = new ByteReader(src);
  let pax: Record<string, string> = {};
  for (;;) {
    const h = await r.read(BLOCK);
    if (h.every((b) => b === 0)) return; // end-of-archive marker
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : h[i];
    if (sum !== parseOctal(h.subarray(148, 156))) throw new Error("tar header checksum mismatch");
    const type = String.fromCharCode(h[156] || 48);
    let size = parseOctal(h.subarray(124, 136));
    const prefix = h.subarray(345, 500).toString("utf8").replace(/\0.*$/s, "");
    let name = h.subarray(0, 100).toString("utf8").replace(/\0.*$/s, "");
    if (prefix) name = `${prefix}/${name}`;

    if (type === "x") {
      if (size > 64 * 1024) throw new Error("pax header too large");
      const body = (await r.read(size + pad(size))).subarray(0, size).toString("utf8");
      pax = {};
      for (const line of body.split("\n")) {
        const m = /^\d+ ([^=]+)=(.*)$/s.exec(line);
        if (m) pax[m[1]] = m[2];
      }
      continue;
    }
    if (pax.path) name = pax.path;
    if (pax.size) size = Number(pax.size);
    pax = {};
    if (type === "5") {
      if (size) throw new Error("directory entry with data");
      continue;
    }
    if (type !== "0") throw new Error(`unsupported tar entry type '${type}' for ${name}`);

    let left = size;
    async function* chunks(): AsyncGenerator<Buffer> {
      while (left > 0) {
        const c = await r.readSome(Math.min(left, 1 << 20));
        left -= c.length;
        yield c;
      }
    }
    await onEntry({ name, size }, chunks);
    while (left > 0) left -= (await r.readSome(Math.min(left, 1 << 20))).length; // unconsumed body
    if (pad(size)) await r.read(pad(size));
  }
}
