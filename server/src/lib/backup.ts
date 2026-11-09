/**
 * Whole-instance backup and restore: one .tar.gz holding every table as
 * NDJSON plus the uploads folder.
 *
 *   manifest.json            format, app version, applied migrations, per-file sha256
 *   db/<table>.ndjson        one row_to_json() per line
 *   uploads/<cardId>/<file>  attachment files
 *
 * Why not pg_dump: the app image has no Postgres client, and pg_dump must
 * match the server's major version. Rows go out as row_to_json and come back
 * through json_populate_recordset, so Postgres does every type conversion
 * (timestamps with microseconds, jsonb, bigint, enums) both ways and nothing
 * is re-typed in JavaScript.
 *
 * Restore is two steps: prepare (unpack to a staging dir, verify checksums,
 * check the migration list matches) and confirm (one transaction: truncate
 * everything, insert everything; then swap the uploads folder). A backup is
 * only restored onto the exact same set of migrations: an older backup's
 * rows may not fit newer tables, and data migrations (like 0003 moving stars)
 * wouldn't be re-applied. To restore an old backup, run the TR Board version
 * that made it, restore, then upgrade (migrations run on boot).
 *
 * Sessions are never backed up: after a restore everyone signs in again.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { once } from "node:events";
import { createGunzip, createGzip } from "node:zlib";
import { sql as pg } from "../db/client.js";
import { env } from "./env.js";
import { readTar, TarWriter } from "./tar.js";

export const FORMAT = "trboard-backup";
export const FORMAT_VERSION = 1;
/** never in a backup; truncated on restore */
const EXCLUDED = new Set(["sessions"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TABLE_RE = /^[a-z_][a-z0-9_]{0,62}$/;
export const BACKUP_NAME_RE = /^trboard-backup-\d{8}-\d{6}\.tar\.gz$/;

export class RestoreError extends Error {}

export type Manifest = {
  format: typeof FORMAT;
  formatVersion: number;
  appVersion: string;
  createdAt: string;
  migrations: Array<{ hash: string; createdAt: string }>;
  tables: Record<string, { rows: number; sha256: string }>;
  uploads: Array<{ path: string; size: number; sha256: string }>;
};

/** scratch space on the same volume as the uploads, so the final swap is a rename (and nothing fills docker.img) */
export const tmpRoot = () => path.join(env.uploadsDir, ".trboard-tmp");

const q = (ident: string) => {
  if (!TABLE_RE.test(ident)) throw new Error(`bad identifier ${ident}`);
  return `"${ident}"`;
};

let appVersionCache: string | null = null;
export function appVersion(): string {
  if (!appVersionCache) {
    try {
      const pkg = JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
      appVersionCache = String(pkg.version ?? "unknown");
    } catch {
      appVersionCache = "unknown";
    }
  }
  return appVersionCache;
}

/**
 * One backup or restore at a time. A backup during a restore would capture a
 * half-swapped uploads folder, and two restores would interleave truncates.
 */
let busy: string | null = null;
export async function exclusive<T>(what: string, fn: () => Promise<T>): Promise<T> {
  if (busy) throw new RestoreError(`a ${busy} is already running, try again when it finishes`);
  busy = what;
  try {
    return await fn();
  } finally {
    busy = null;
  }
}

type Executor = typeof pg;

async function appTables(x: Executor = pg): Promise<string[]> {
  const rows = await x<{ t: string }[]>`select tablename as t from pg_tables where schemaname = 'public' order by tablename`;
  return rows.map((r) => r.t);
}

async function migrations(x: Executor = pg): Promise<Manifest["migrations"]> {
  const rows = await x<{ hash: string; created_at: string }[]>`
    select hash, created_at::text as created_at from drizzle.__drizzle_migrations order by created_at, id`;
  return rows.map((r) => ({ hash: r.hash, createdAt: r.created_at }));
}

/**
 * Insert order from the FK graph (parents first), plus the self-referencing
 * FK columns (cards.mirror_of_card_id), which are inserted as NULL and filled
 * in afterwards, so row order inside a table never matters.
 */
async function fkPlan(tables: string[]): Promise<{ order: string[]; selfRefs: Map<string, string[]> }> {
  const rows = await pg<{ child: string; parent: string; col: string }[]>`
    select c.conrelid::regclass::text as child, c.confrelid::regclass::text as parent, a.attname as col
    from pg_constraint c
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
    where c.contype = 'f' and c.connamespace = 'public'::regnamespace`;
  const strip = (s: string) => s.replace(/^public\./, "").replace(/"/g, "");
  const deps = new Map(tables.map((t) => [t, new Set<string>()]));
  const selfRefs = new Map<string, string[]>();
  for (const r of rows) {
    const child = strip(r.child), parent = strip(r.parent);
    if (!deps.has(child)) continue;
    if (child === parent) selfRefs.set(child, [...(selfRefs.get(child) ?? []), r.col]);
    else deps.get(child)!.add(parent);
  }
  const order: string[] = [];
  const done = new Set<string>();
  const visit = (t: string, stack: Set<string>) => {
    if (done.has(t)) return;
    if (stack.has(t)) throw new Error(`FK cycle at ${t}`);
    stack.add(t);
    for (const p of deps.get(t) ?? []) if (deps.has(p)) visit(p, stack);
    stack.delete(t);
    done.add(t);
    order.push(t);
  };
  for (const t of tables) visit(t, new Set());
  return { order, selfRefs };
}

async function writeLine(out: fs.WriteStream, s: string) {
  if (!out.write(s)) await once(out, "drain");
}

async function* walkUploads(): AsyncGenerator<{ rel: string; abs: string; size: number; mtime: number }> {
  let dirs: fs.Dirent[];
  try {
    dirs = await fsp.readdir(env.uploadsDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const d of dirs) {
    // card folders only: skips .trboard-tmp and anything else that isn't ours
    if (!d.isDirectory() || !UUID_RE.test(d.name)) continue;
    for (const f of await fsp.readdir(path.join(env.uploadsDir, d.name), { withFileTypes: true })) {
      if (!f.isFile() || f.name.startsWith(".") || f.name.endsWith(".part")) continue;
      const abs = path.join(env.uploadsDir, d.name, f.name);
      const st = await fsp.stat(abs);
      yield { rel: `${d.name}/${f.name}`, abs, size: st.size, mtime: st.mtimeMs };
    }
  }
}

/** Write a full backup to `outFile`. Caller holds `exclusive`. */
export async function createBackup(outFile: string): Promise<Manifest> {
  const work = path.join(tmpRoot(), `backup-${crypto.randomBytes(6).toString("hex")}`);
  await fsp.mkdir(work, { recursive: true });
  try {
    const tables = (await appTables()).filter((t) => !EXCLUDED.has(t));
    const rowCounts: Record<string, number> = {};
    let migs: Manifest["migrations"] = [];
    // One REPEATABLE READ snapshot, so every table is from the same instant
    // (no card without its list). Uploads are copied after and aren't part of
    // the snapshot: a file uploaded meanwhile may be in or out, harmlessly.
    await pg.begin("isolation level repeatable read read only", async (tx) => {
      migs = await migrations(tx as unknown as Executor);
      for (const t of tables) {
        const out = fs.createWriteStream(path.join(work, `${t}.ndjson`));
        let n = 0;
        await tx.unsafe(`select row_to_json(t)::text as j from ${q(t)} t`).cursor(1000, async (rows) => {
          for (const r of rows) await writeLine(out, (r as unknown as { j: string }).j + "\n");
          n += rows.length;
        });
        out.end();
        await once(out, "close");
        rowCounts[t] = n;
      }
    });

    const gz = createGzip({ level: 6 });
    const file = fs.createWriteStream(outFile, { mode: 0o600 }); // holds password hashes and TOTP secrets
    gz.pipe(file);
    const tar = new TarWriter(gz);
    const manifest: Manifest = {
      format: FORMAT, formatVersion: FORMAT_VERSION, appVersion: appVersion(),
      createdAt: new Date().toISOString(), migrations: migs, tables: {}, uploads: [],
    };
    for (const t of tables) {
      const p = path.join(work, `${t}.ndjson`);
      const { size } = await fsp.stat(p);
      const sha256 = await tar.add(`db/${t}.ndjson`, size, fs.createReadStream(p));
      manifest.tables[t] = { rows: rowCounts[t], sha256 };
    }
    for await (const f of walkUploads()) {
      try {
        const sha256 = await tar.add(`uploads/${f.rel}`, f.size, fs.createReadStream(f.abs), f.mtime);
        manifest.uploads.push({ path: f.rel, size: f.size, sha256 });
      } catch (err) {
        // deleted mid-backup (its card went): skip it, the DB snapshot may still
        // name it, which a restore tolerates like any missing attachment file.
        // A file that changed size can't be skipped once its header is out.
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    }
    const m = Buffer.from(JSON.stringify(manifest, null, 2));
    await tar.add("manifest.json", m.length, m);
    await tar.finish();
    await once(file, "close");
    return manifest;
  } finally {
    await fsp.rm(work, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------ restore */

export type RestoreSummary = {
  id: string;
  createdAt: string;
  appVersion: string;
  counts: Record<string, number>;
  current: Record<string, number>;
  uploads: { files: number; bytes: number };
  expiresAt: string;
};

type Prepared = { dir: string; manifest: Manifest; expires: number; timer: NodeJS.Timeout };
const prepared = new Map<string, Prepared>();
const PREPARED_MS = 30 * 60_000;

const COUNTED = ["users", "workspaces", "boards", "lists", "cards", "attachments"];

async function discard(id: string) {
  const p = prepared.get(id);
  if (!p) return;
  prepared.delete(id);
  clearTimeout(p.timer);
  await fsp.rm(p.dir, { recursive: true, force: true }).catch(() => {});
}
export const cancelRestore = discard;

/**
 * Unpack and verify an archive without touching live data. Anything that
 * isn't exactly what createBackup writes is refused: unknown entry names,
 * paths outside uploads/<uuid>/, links, checksum mismatches, files missing
 * from or extra to the manifest, a different migration list.
 */
export async function prepareRestore(archive: string): Promise<RestoreSummary> {
  const id = crypto.randomBytes(12).toString("hex");
  const dir = path.join(tmpRoot(), `restore-${id}`);
  await fsp.mkdir(path.join(dir, "db"), { recursive: true });
  await fsp.mkdir(path.join(dir, "uploads"), { recursive: true });
  try {
    const seen = new Map<string, { sha256: string; size: number }>();
    let manifestText = "";
    await readTar(fs.createReadStream(archive).pipe(createGunzip()), async (entry, chunks) => {
      // `tar -C dir -czf x .` (a hand-repacked backup) prefixes every name with ./
      const e = { ...entry, name: entry.name.replace(/^\.\//, "") };
      if (seen.has(e.name)) throw new RestoreError(`duplicate entry ${e.name}`);
      let dest: string | null = null;
      if (e.name === "manifest.json") {
        if (e.size > 256 * 1024 * 1024) throw new RestoreError("manifest too large");
        const parts: Buffer[] = [];
        for await (const c of chunks()) parts.push(c);
        manifestText = Buffer.concat(parts).toString("utf8");
        seen.set(e.name, { sha256: "", size: e.size });
        return;
      }
      const dbm = /^db\/([a-z_][a-z0-9_]{0,62})\.ndjson$/.exec(e.name);
      const upm = /^uploads\/([0-9a-f-]{36})\/([^/\\\0]{1,255})$/.exec(e.name);
      if (dbm) dest = path.join(dir, "db", `${dbm[1]}.ndjson`);
      else if (upm && UUID_RE.test(upm[1]) && !upm[2].startsWith(".")) {
        await fsp.mkdir(path.join(dir, "uploads", upm[1]), { recursive: true });
        dest = path.join(dir, "uploads", upm[1], upm[2]);
      } else throw new RestoreError(`unexpected entry in archive: ${e.name.slice(0, 120)}`);
      const hash = crypto.createHash("sha256");
      const out = fs.createWriteStream(dest, { flags: "wx" });
      for await (const c of chunks()) {
        hash.update(c);
        if (!out.write(c)) await once(out, "drain");
      }
      out.end();
      await once(out, "close");
      seen.set(e.name, { sha256: hash.digest("hex"), size: e.size });
    });

    let manifest: Manifest;
    try {
      manifest = JSON.parse(manifestText);
    } catch {
      throw new RestoreError("not a TR Board backup (no readable manifest.json)");
    }
    if (manifest?.format !== FORMAT) throw new RestoreError("not a TR Board backup");
    if (manifest.formatVersion !== FORMAT_VERSION) {
      throw new RestoreError(`backup format ${manifest.formatVersion} is not supported by this version (${FORMAT_VERSION})`);
    }
    const mine = await migrations();
    const theirs = manifest.migrations ?? [];
    if (mine.length !== theirs.length || mine.some((m, i) => m.hash !== theirs[i]?.hash)) {
      const rel = theirs.length < mine.length ? "an older" : theirs.length > mine.length ? "a newer" : "a different";
      throw new RestoreError(
        `this backup is from ${rel} database version (${theirs.length} migrations; this instance has ${mine.length}). ` +
          "Restore it with the TR Board version that made it, then upgrade.",
      );
    }
    const tables = (await appTables()).filter((t) => !EXCLUDED.has(t)).sort();
    const backed = Object.keys(manifest.tables ?? {}).sort();
    if (tables.join() !== backed.join()) throw new RestoreError("the backup's tables don't match this database");
    for (const t of tables) {
      const s = seen.get(`db/${t}.ndjson`);
      if (!s || s.sha256 !== manifest.tables[t].sha256) throw new RestoreError(`db/${t}.ndjson is missing or damaged`);
    }
    const listed = new Set<string>();
    for (const u of manifest.uploads ?? []) {
      const s = seen.get(`uploads/${u.path}`);
      if (!s || s.sha256 !== u.sha256 || s.size !== u.size) throw new RestoreError(`uploads/${u.path} is missing or damaged`);
      listed.add(`uploads/${u.path}`);
    }
    for (const name of seen.keys()) {
      if (name.startsWith("uploads/") && !listed.has(name)) throw new RestoreError(`${name} is not in the manifest`);
    }

    const current: Record<string, number> = {};
    for (const t of COUNTED) current[t] = Number((await pg.unsafe(`select count(*)::int as n from ${q(t)}`))[0].n);
    const expires = Date.now() + PREPARED_MS;
    prepared.set(id, { dir, manifest, expires, timer: setTimeout(() => void discard(id), PREPARED_MS).unref() });
    return {
      id,
      createdAt: manifest.createdAt,
      appVersion: manifest.appVersion,
      counts: Object.fromEntries(COUNTED.map((t) => [t, manifest.tables[t]?.rows ?? 0])),
      current,
      uploads: { files: manifest.uploads.length, bytes: manifest.uploads.reduce((a, u) => a + u.size, 0) },
      expiresAt: new Date(expires).toISOString(),
    };
  } catch (err) {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    if (err instanceof RestoreError) throw err;
    throw new RestoreError(`could not read the archive: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function* batches(file: string, maxRows = 500, maxBytes = 8 * 1024 * 1024): AsyncGenerator<string> {
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  let rows: string[] = [];
  let bytes = 0;
  for await (const line of rl) {
    if (!line) continue;
    rows.push(line);
    bytes += line.length;
    if (rows.length >= maxRows || bytes >= maxBytes) {
      yield `[${rows.join(",")}]`;
      rows = [];
      bytes = 0;
    }
  }
  if (rows.length) yield `[${rows.join(",")}]`;
}

/** Replace all data with a prepared backup. Caller holds `exclusive`. */
export async function applyRestore(id: string): Promise<Record<string, number>> {
  const p = prepared.get(id);
  if (!p || p.expires <= Date.now()) throw new RestoreError("that restore has expired; upload the backup again");
  const all = await appTables();
  const tables = all.filter((t) => !EXCLUDED.has(t));
  const { order, selfRefs } = await fkPlan(tables);

  await pg.begin(async (tx) => {
    await tx.unsafe(`truncate ${all.map(q).join(", ")} cascade`);
    for (const t of order) {
      const file = path.join(p.dir, "db", `${t}.ndjson`);
      const cols = selfRefs.get(t) ?? [];
      const strip = cols.map((c) => ` - '${c}'`).join("");
      for await (const batch of batches(file)) {
        if (cols.length) {
          await tx.unsafe(
            `insert into ${q(t)} select * from json_populate_recordset(null::${q(t)},
               (select coalesce(json_agg((e::jsonb${strip})::json), '[]'::json) from json_array_elements($1::json) e))`,
            [batch],
          );
        } else {
          await tx.unsafe(`insert into ${q(t)} select * from json_populate_recordset(null::${q(t)}, $1::json)`, [batch]);
        }
      }
      if (cols.length) {
        const set = cols.map((c) => `${q(c)} = s.${q(c)}`).join(", ");
        const any = cols.map((c) => `s.${q(c)} is not null`).join(" or ");
        for await (const batch of batches(file)) {
          await tx.unsafe(
            `update ${q(t)} set ${set} from json_populate_recordset(null::${q(t)}, $1::json) s where ${q(t)}.id = s.id and (${any})`,
            [batch],
          );
        }
      }
    }
  });

  // Uploads: the DB is committed, so swap the folder contents. Old files are
  // moved aside first and deleted only once the new ones are in place.
  const aside = path.join(tmpRoot(), `pre-restore-${id}`);
  await fsp.mkdir(aside, { recursive: true });
  for (const name of await fsp.readdir(env.uploadsDir)) {
    if (name === ".trboard-tmp") continue;
    await fsp.rename(path.join(env.uploadsDir, name), path.join(aside, name));
  }
  for (const name of await fsp.readdir(path.join(p.dir, "uploads"))) {
    await fsp.rename(path.join(p.dir, "uploads", name), path.join(env.uploadsDir, name));
  }
  await fsp.rm(aside, { recursive: true, force: true });
  await discard(id);
  return Object.fromEntries(COUNTED.map((t) => [t, p.manifest.tables[t]?.rows ?? 0]));
}

/* --------------------------------------------------------------- scheduled */

export type BackupFile = { name: string; size: number; createdAt: string };

export async function listBackups(): Promise<BackupFile[]> {
  if (!env.backup.dir) return [];
  let names: string[];
  try {
    names = await fsp.readdir(env.backup.dir);
  } catch {
    return [];
  }
  const out: BackupFile[] = [];
  for (const name of names.filter((n) => BACKUP_NAME_RE.test(n))) {
    const st = await fsp.stat(path.join(env.backup.dir, name));
    out.push({ name, size: st.size, createdAt: st.mtime.toISOString() });
  }
  return out.sort((a, b) => b.name.localeCompare(a.name)); // names sort by time
}

const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);

/** write one backup into BACKUP_DIR (atomic rename) and apply retention */
export async function runScheduledBackup(): Promise<BackupFile> {
  if (!env.backup.dir) throw new RestoreError("BACKUP_DIR is not set");
  await fsp.mkdir(env.backup.dir, { recursive: true });
  const name = `trboard-backup-${stamp(new Date())}.tar.gz`;
  // dot-prefixed while being written, so retention, the restore list and any
  // external sync never see a half-written archive
  const partial = path.join(env.backup.dir, `.${name}.partial`);
  try {
    await exclusive("backup", () => createBackup(partial));
    await fsp.rename(partial, path.join(env.backup.dir, name));
  } catch (err) {
    await fsp.rm(partial, { force: true });
    throw err;
  }
  const all = await listBackups();
  for (const old of all.slice(env.backup.keep)) await fsp.rm(path.join(env.backup.dir, old.name), { force: true });
  return all.find((b) => b.name === name)!;
}

/**
 * Timer for BACKUP_DIR + BACKUP_INTERVAL_HOURS. The next run is worked out
 * from the newest file already in the folder, not from boot: Unraid restarts
 * containers on every array stop and image update, and counting from boot
 * would either never back up (frequent restarts) or back up on every boot.
 */
export function startBackupSchedule(): void {
  const { dir, intervalHours } = env.backup;
  if (!dir || !intervalHours) return;
  const intervalMs = intervalHours * 3600_000;
  const minDelay = Number(process.env.BACKUP_START_DELAY_SECONDS ?? 60) * 1000;
  const schedule = async () => {
    const newest = (await listBackups())[0];
    const due = newest ? Date.parse(newest.createdAt) + intervalMs : 0;
    const delay = Math.max(minDelay, due - Date.now());
    setTimeout(() => {
      runScheduledBackup()
        .then((b) => console.log(`TR Board: scheduled backup written: ${b.name}`))
        .catch((err) => console.error("TR Board: scheduled backup failed:", err instanceof Error ? err.message : err))
        // a failure retries after minDelay rather than a whole interval later
        .finally(() => void schedule());
    }, Math.min(delay, 2 ** 31 - 1)).unref();
  };
  void schedule();
  console.log(`TR Board: scheduled backups every ${intervalHours} h to ${dir}, keeping ${env.backup.keep}`);
}

/** remove crash leftovers even when scheduling is off */
export async function cleanTmp(): Promise<void> {
  await fsp.rm(tmpRoot(), { recursive: true, force: true }).catch(() => {});
}
