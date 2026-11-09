/**
 * Nov 2026 features, part 1: calendar feeds, recurring cards, backup and
 * restore (incl. the scheduled backup). Same harness as the other files:
 * throwaway Postgres + the real server as a child process.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createGzip } from "node:zlib";
import { client, sleep, startHarness, type Harness } from "./harness.js";
import { TarWriter } from "../src/lib/tar.js";

let h: Harness;
let api: ReturnType<typeof client>;
let root: U;
const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), "trboard-test-backups-"));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "trboard-test-scratch-"));

type U = { id: string; email: string; cookie: string };
let ipSeq = 1;
const ip = () => ({ "x-forwarded-for": `198.51.100.${ipSeq++ % 250}` });

async function login(email: string, password = "password123"): Promise<string> {
  const r = await api.post("/api/auth/login", { email, password }, undefined, ip());
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.cookie!;
}
async function makeUser(label: string, isAdmin = false): Promise<U> {
  const email = `${label}-${crypto.randomBytes(3).toString("hex")}@test.local`;
  const r = await api.post("/api/admin/users", { email, name: label, password: "password123", isAdmin }, root.cookie);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return { id: r.body.user.id, email, cookie: await login(email) };
}
async function workspace(owner: U) {
  return (await api.post("/api/workspaces", { name: "WS" }, owner.cookie)).body.workspace.id as string;
}
async function board(owner: U, ws: string, visibility = "workspace", name = "B") {
  const r = await api.post("/api/boards", { workspaceId: ws, name, visibility }, owner.cookie);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.board.id as string;
}
async function list(owner: U, b: string, name = "L") {
  return (await api.post(`/api/boards/${b}/lists`, { name }, owner.cookie)).body.list.id as string;
}
async function card(owner: U, l: string, title = "c") {
  const r = await api.post(`/api/lists/${l}/cards`, { title }, owner.cookie);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.card as { id: string; boardId: string; listId: string };
}
const text = async (url: string) => {
  const r = await fetch(h.base + url);
  return { status: r.status, body: await r.text(), type: r.headers.get("content-type") };
};

before(async () => {
  h = await startHarness({
    TRUST_PROXY: "loopback",
    BACKUP_DIR: backupDir,
    BACKUP_INTERVAL_HOURS: "1",
    BACKUP_KEEP: "2",
    BACKUP_START_DELAY_SECONDS: "1",
  });
  api = client(h.base);
  const reg = await api.post("/api/auth/register", { email: "root@test.local", name: "Root", password: "password123" }, undefined, ip());
  assert.equal(reg.status, 200);
  root = { id: reg.body.user.id, email: "root@test.local", cookie: reg.cookie! };
});

after(async () => {
  await h?.stop();
  fs.rmSync(backupDir, { recursive: true, force: true });
  fs.rmSync(scratch, { recursive: true, force: true });
});

/* -------------------------------------------------------------- calendar feed */

describe("calendar feeds", () => {
  test("my feed has assigned cards and checklist items; board feed has the board's dates", async () => {
    const u = await makeUser("feed1");
    const ws = await workspace(u);
    const b = await board(u, ws, "workspace", "Homelab");
    const l = await list(u, b);
    const c = await card(u, l, "Renew, TLS cert");
    await api.patch(`/api/cards/${c.id}`, { dueAt: "2030-01-10T09:00:00Z", startAt: "2030-01-08T09:00:00Z" }, u.cookie);
    assert.equal((await api.put(`/api/cards/${c.id}/members/${u.id}`, {}, u.cookie)).status, 200);
    const other = await card(u, l, "Not mine");
    await api.patch(`/api/cards/${other.id}`, { dueAt: "2030-02-01T09:00:00Z" }, u.cookie);
    const cl = (await api.post(`/api/cards/${other.id}/checklists`, { name: "Steps" }, u.cookie)).body.checklist.id;
    const item = (await api.post(`/api/checklists/${cl}/items`, { text: "Check parity" }, u.cookie)).body.item.id;
    assert.equal((await api.patch(`/api/checklist-items/${item}`, { assigneeId: u.id, dueAt: "2030-01-15T00:00:00Z" }, u.cookie)).status, 200);

    assert.equal((await api.get("/api/me/feeds", u.cookie)).body.enabled, false);
    const made = await api.post("/api/me/feeds/token", {}, u.cookie);
    assert.equal(made.status, 200);
    const feeds = (await api.get("/api/me/feeds", u.cookie)).body;
    assert.equal(feeds.myUrl, made.body.myUrl);
    const boardUrl = feeds.boards.find((x: any) => x.id === b).url;

    const my = await text(feeds.myUrl);
    assert.equal(my.status, 200);
    assert.match(my.type!, /text\/calendar/);
    assert.match(my.body, /SUMMARY:Renew\\, TLS cert/);
    assert.match(my.body, /DTSTART:20300108T090000Z\r\nDTEND:20300110T090000Z/);
    assert.match(my.body, /SUMMARY:Check parity \(Not mine\)/);
    assert.doesNotMatch(my.body, /SUMMARY:Not mine/);

    const bf = await text(boardUrl);
    assert.equal(bf.status, 200);
    assert.match(bf.body, /X-WR-CALNAME:TR Board: Homelab/);
    assert.match(bf.body, /SUMMARY:Not mine/);
    assert.match(bf.body, /SUMMARY:Renew/);
  });

  test("regenerating revokes the old URLs; turning feeds off revokes everything", async () => {
    const u = await makeUser("feed2");
    const ws = await workspace(u);
    const b = await board(u, ws);
    const first = (await api.post("/api/me/feeds/token", {}, u.cookie)).body.myUrl as string;
    const firstBoard = first.replace("/my.ics", `/boards/${b}.ics`);
    assert.equal((await text(first)).status, 200);
    assert.equal((await text(firstBoard)).status, 200);
    const second = (await api.post("/api/me/feeds/token", {}, u.cookie)).body.myUrl as string;
    assert.notEqual(second, first);
    assert.equal((await text(first)).status, 404, "old my-feed URL still works");
    assert.equal((await text(firstBoard)).status, 404, "old board-feed URL still works");
    assert.equal((await text(second)).status, 200);
    assert.equal((await api.del("/api/me/feeds/token", u.cookie)).status, 200);
    assert.equal((await text(second)).status, 404);
    assert.equal((await text("/api/feed/not-a-token/my.ics")).status, 404);
  });

  test("losing board access removes its events and 404s the board feed at the next fetch", async () => {
    const owner = await makeUser("feedown");
    const u = await makeUser("feedmem");
    const ws = await workspace(owner);
    assert.equal((await api.post(`/api/workspaces/${ws}/members`, { email: u.email }, owner.cookie)).status, 200);
    const b = await board(owner, ws, "workspace", "Shared");
    const l = await list(owner, b);
    const c = await card(owner, l, "Shared chore");
    await api.patch(`/api/cards/${c.id}`, { dueAt: "2030-03-01T09:00:00Z" }, owner.cookie);
    assert.equal((await api.put(`/api/cards/${c.id}/members/${u.id}`, {}, owner.cookie)).status, 200);

    const my = (await api.post("/api/me/feeds/token", {}, u.cookie)).body.myUrl as string;
    const bUrl = my.replace("/my.ics", `/boards/${b}.ics`);
    assert.match((await text(my)).body, /Shared chore/);
    assert.equal((await text(bUrl)).status, 200);

    // board goes private (u isn't a board member): access gone
    assert.equal((await api.patch(`/api/boards/${b}`, { visibility: "private" }, owner.cookie)).status, 200);
    assert.doesNotMatch((await text(my)).body, /Shared chore/);
    assert.equal((await text(bUrl)).status, 404);

    // back to workspace-visible, then u leaves the workspace
    await api.patch(`/api/boards/${b}`, { visibility: "workspace" }, owner.cookie);
    assert.match((await text(my)).body, /Shared chore/);
    assert.equal((await api.del(`/api/workspaces/${ws}/members/${u.id}`, owner.cookie)).status, 200);
    assert.doesNotMatch((await text(my)).body, /Shared chore/);
    assert.equal((await text(bUrl)).status, 404);
  });

  test("an outsider's token can't open someone else's board feed", async () => {
    const owner = await makeUser("feedo2");
    const outsider = await makeUser("feedout");
    const b = await board(owner, await workspace(owner), "private");
    const my = (await api.post("/api/me/feeds/token", {}, outsider.cookie)).body.myUrl as string;
    assert.equal((await text(my.replace("/my.ics", `/boards/${b}.ics`))).status, 404);
    assert.equal((await text(my.replace("/my.ics", `/boards/not-a-uuid.ics`))).status, 404);
  });
});

/* ------------------------------------------------------------- recurring cards */

describe("recurring cards", () => {
  test("needs a due date; mirrors can't repeat", async () => {
    const u = await makeUser("rec0");
    const l = await list(u, await board(u, await workspace(u)));
    const c = await card(u, l);
    const r = await api.patch(`/api/cards/${c.id}`, { recurrence: { freq: "weekly", interval: 1 } }, u.cookie);
    assert.equal(r.status, 400);
    assert.match(r.body.error, /due date/);
  });

  test("completing spawns the next card: due advanced, checklist reset, labels/members/fields kept", async () => {
    const u = await makeUser("rec1");
    const b = await board(u, await workspace(u));
    const l = await list(u, b);
    const c = await card(u, l, "Parity check");
    const label = (await api.post(`/api/boards/${b}/labels`, { name: "chore", color: "#61bd4f" }, u.cookie)).body.label.id;
    const field = (await api.post(`/api/boards/${b}/fields`, { name: "Disk", type: "text" }, u.cookie)).body.field.id;
    await api.put(`/api/cards/${c.id}/labels/${label}`, {}, u.cookie);
    await api.put(`/api/cards/${c.id}/members/${u.id}`, {}, u.cookie);
    assert.equal((await api.put(`/api/cards/${c.id}/fields/${field}`, { value: "Exos 28TB" }, u.cookie)).status, 200);
    const cl = (await api.post(`/api/cards/${c.id}/checklists`, { name: "Steps" }, u.cookie)).body.checklist.id;
    const item = (await api.post(`/api/checklists/${cl}/items`, { text: "Start check" }, u.cookie)).body.item.id;
    await api.patch(`/api/checklist-items/${item}`, { done: true }, u.cookie);

    const due = new Date(Date.now() + 2 * 86400_000);
    due.setUTCHours(9, 0, 0, 0);
    const set = await api.patch(
      `/api/cards/${c.id}`,
      { dueAt: due.toISOString(), recurrence: { freq: "weekly", interval: 1, tz: "Pacific/Auckland" } },
      u.cookie,
    );
    assert.equal(set.status, 200, JSON.stringify(set.body));
    assert.equal(set.body.card.recurrence.freq, "weekly");
    assert.equal(set.body.card.recurrence.weekdays.length, 1);

    const done = await api.patch(`/api/cards/${c.id}`, { dueComplete: true }, u.cookie);
    assert.equal(done.status, 200);
    const nextId = done.body.nextCardId as string;
    assert.ok(nextId, "no next occurrence created");

    const next = (await api.get(`/api/cards/${nextId}`, u.cookie)).body;
    assert.equal(new Date(next.card.dueAt).getTime(), due.getTime() + 7 * 86400_000);
    assert.equal(next.card.dueComplete, false);
    assert.equal(next.card.recurrence.freq, "weekly");
    assert.deepEqual(next.card.labelIds, [label]);
    assert.deepEqual(next.card.memberIds, [u.id]);
    assert.equal(next.card.fieldValues[field], "Exos 28TB");
    assert.equal(next.checklists[0].items[0].text, "Start check");
    assert.equal(next.checklists[0].items[0].done, false);

    const orig = (await api.get(`/api/cards/${c.id}`, u.cookie)).body.card;
    assert.equal(orig.recurrence, null, "rule should move to the new card");
    assert.equal(orig.dueComplete, true);
    const full = (await api.get(`/api/boards/${b}/full`, u.cookie)).body;
    assert.ok(full.cards.find((x: any) => x.id === nextId).recurrence, "/full carries the rule for the card-front indicator");
  });

  test("never double-fires: re-ticking, parallel completes, and a restart", async () => {
    const u = await makeUser("rec2");
    const l = await list(u, await board(u, await workspace(u)));
    const count = async () => Number((await h.sql`select count(*)::int as n from cards where list_id = ${l}`)[0].n);
    const c = await card(u, l, "Daily");
    await api.patch(`/api/cards/${c.id}`, { dueAt: new Date(Date.now() + 3600_000).toISOString(), recurrence: { freq: "daily", interval: 1 } }, u.cookie);

    const [a, b2] = await Promise.all([
      api.patch(`/api/cards/${c.id}`, { dueComplete: true }, u.cookie),
      api.patch(`/api/cards/${c.id}`, { dueComplete: true }, u.cookie),
    ]);
    assert.equal(a.status, 200);
    assert.equal(b2.status, 200);
    assert.equal([a.body.nextCardId, b2.body.nextCardId].filter(Boolean).length, 1);
    assert.equal(await count(), 2);

    await api.patch(`/api/cards/${c.id}`, { dueComplete: false }, u.cookie);
    await api.patch(`/api/cards/${c.id}`, { dueComplete: true }, u.cookie);
    assert.equal(await count(), 2, "un-tick + re-tick spawned another copy");

    await h.restart();
    await sleep(500);
    assert.equal(await count(), 2, "restart created cards");
    const cookie = await login(u.email);
    const live = (await h.sql`select id from cards where list_id = ${l} and recurrence is not null`) as any[];
    assert.equal(live.length, 1, "exactly one card holds the rule");
    const r = await api.patch(`/api/cards/${live[0].id}`, { dueComplete: true }, cookie);
    assert.ok(r.body.nextCardId);
    assert.equal(await count(), 3);
  });

  test("clearing the due date clears the rule", async () => {
    const u = await makeUser("rec3");
    const c = await card(u, await list(u, await board(u, await workspace(u))));
    await api.patch(`/api/cards/${c.id}`, { dueAt: "2030-01-01T00:00:00Z", recurrence: { freq: "monthly" } }, u.cookie);
    const r = await api.patch(`/api/cards/${c.id}`, { dueAt: null }, u.cookie);
    assert.equal(r.body.card.recurrence, null);
  });
});

/* ------------------------------------------------------------ backup / restore */

async function tableDigests(): Promise<Record<string, string>> {
  const tables = (await h.sql`select tablename from pg_tables where schemaname = 'public' and tablename <> 'sessions'`).map(
    (r: any) => r.tablename as string,
  );
  const out: Record<string, string> = {};
  for (const t of tables) {
    const [r] = await h.sql.unsafe(`select count(*)::int as n, md5(coalesce(string_agg(t::text, '|' order by t::text), '')) as d from "${t}" t`);
    out[t] = `${r.n}:${r.d}`;
  }
  return out;
}

function uploadDigests(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const d of fs.readdirSync(h.uploadsDir)) {
    if (d.startsWith(".")) continue;
    for (const f of fs.readdirSync(path.join(h.uploadsDir, d))) {
      out[`${d}/${f}`] = crypto.createHash("sha256").update(fs.readFileSync(path.join(h.uploadsDir, d, f))).digest("hex");
    }
  }
  return out;
}

async function download(cookie: string): Promise<{ status: number; file?: string }> {
  const r = await fetch(`${h.base}/api/admin/backup/download`, { headers: { cookie } });
  if (r.status !== 200) return { status: r.status };
  const file = path.join(scratch, `dl-${crypto.randomBytes(3).toString("hex")}.tar.gz`);
  fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
  return { status: 200, file };
}

async function uploadRestore(cookie: string, file: string | Buffer) {
  const fd = new FormData();
  fd.append("file", new Blob([new Uint8Array(typeof file === "string" ? fs.readFileSync(file) : file)]), "backup.tar.gz");
  const r = await fetch(`${h.base}/api/admin/restore/upload`, { method: "POST", body: fd, headers: { cookie } });
  return { status: r.status, body: (await r.json()) as any };
}

/** archive built by hand, for the tampering tests */
async function craft(entries: Array<[string, Buffer]>): Promise<Buffer> {
  const gz = createGzip();
  const parts: Buffer[] = [];
  gz.on("data", (c) => parts.push(c));
  const w = new TarWriter(gz);
  for (const [n, b] of entries) await w.add(n, b.length, b);
  await w.finish();
  return Buffer.concat(parts);
}

function untar(file: string): string {
  const dir = fs.mkdtempSync(path.join(scratch, "x-"));
  execFileSync("tar", ["-xzf", file, "-C", dir]);
  return dir;
}
function retar(dir: string): string {
  const file = path.join(scratch, `re-${crypto.randomBytes(3).toString("hex")}.tar.gz`);
  execFileSync("tar", ["--format=ustar", "-czf", file, "-C", dir, "."]);
  return file;
}

describe("backup and restore", () => {
  test("non-admins and anonymous callers can't back up or restore", async () => {
    const u = await makeUser("bk-nonadmin");
    assert.equal((await download(u.cookie)).status, 403);
    assert.equal((await api.get("/api/admin/backup", u.cookie)).status, 403);
    assert.equal((await api.post("/api/admin/backup/run", {}, u.cookie)).status, 403);
    assert.equal((await uploadRestore(u.cookie, Buffer.from("x"))).status, 403);
    assert.equal((await api.post("/api/admin/restore/from-backup", { name: "trboard-backup-20260101-000000.tar.gz" }, u.cookie)).status, 403);
    assert.equal((await api.post(`/api/admin/restore/${"a".repeat(24)}/confirm`, { confirm: "RESTORE" }, u.cookie)).status, 403);
    assert.equal((await fetch(`${h.base}/api/admin/backup/download`)).status, 401);
  });

  test("tampered, foreign, wrong-version and path-escaping archives are refused", async () => {
    const good = await download(root.cookie);
    assert.equal(good.status, 200);
    const list = execFileSync("tar", ["-tzf", good.file!]).toString();
    assert.match(list, /^manifest\.json$/m);
    assert.match(list, /^db\/cards\.ndjson$/m);

    // migration list differs (as if made by an older version)
    let dir = untar(good.file!);
    const m = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
    m.migrations = m.migrations.slice(0, -1);
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(m));
    let r = await uploadRestore(root.cookie, retar(dir));
    assert.equal(r.status, 400);
    assert.match(r.body.error, /older database version/);

    // a table file edited after the backup
    dir = untar(good.file!);
    fs.appendFileSync(path.join(dir, "db", "boards.ndjson"), "{}\n");
    r = await uploadRestore(root.cookie, retar(dir));
    assert.equal(r.status, 400);
    assert.match(r.body.error, /boards\.ndjson is missing or damaged/);

    // path escape attempts never get written anywhere
    const uuid = crypto.randomUUID();
    for (const evil of [`uploads/${uuid}/../../../escaped.txt`, "db/../../escaped.ndjson", "../escaped.txt", `uploads/${uuid}/.hidden`]) {
      r = await uploadRestore(root.cookie, await craft([[evil, Buffer.from("pwned")]]));
      assert.equal(r.status, 400, evil);
      assert.match(r.body.error, /unexpected entry/);
    }
    assert.equal(fs.existsSync(path.join(h.uploadsDir, "..", "escaped.txt")), false);

    r = await uploadRestore(root.cookie, Buffer.from("definitely not gzip"));
    assert.equal(r.status, 400);
    r = await uploadRestore(root.cookie, await craft([["manifest.json", Buffer.from('{"format":"other"}')]]));
    assert.equal(r.status, 400);
    assert.match(r.body.error, /not a TR Board backup/);
  });

  test("round trip: back up, wipe, restore onto the empty instance, everything matches", async () => {
    // some extra content with an attachment, on top of everything the tests above made
    const u = await makeUser("bk-user");
    const c = await card(u, await list(u, await board(u, await workspace(u), "private", "Secret")), "With file");
    const fd = new FormData();
    fd.append("file", new Blob([crypto.randomBytes(200_000)], { type: "application/octet-stream" }), "blob ünï.bin");
    assert.equal((await fetch(`${h.base}/api/cards/${c.id}/attachments`, { method: "POST", body: fd, headers: { cookie: u.cookie } })).status, 200);

    const before = await tableDigests();
    const filesBefore = uploadDigests();
    assert.ok(Object.keys(filesBefore).length >= 1);
    const bk = await download(root.cookie);
    assert.equal(bk.status, 200);

    // wipe: every table and every upload, like a brand-new install
    const tables = Object.keys(before).concat("sessions").map((t) => `"${t}"`).join(", ");
    await h.sql.unsafe(`truncate ${tables} cascade`);
    for (const d of fs.readdirSync(h.uploadsDir)) fs.rmSync(path.join(h.uploadsDir, d), { recursive: true, force: true });
    assert.equal((await api.get("/api/auth/me", root.cookie)).status, 401);
    await h.sql`insert into instance_settings (id) values (1) on conflict do nothing`;

    // fresh instance: first account is the admin who restores
    const fresh = await api.post("/api/auth/register", { email: "fresh@test.local", name: "Fresh", password: "password123" }, undefined, ip());
    assert.equal(fresh.status, 200);
    const prep = await uploadRestore(fresh.cookie!, bk.file!);
    assert.equal(prep.status, 200, JSON.stringify(prep.body));
    assert.equal(prep.body.restore.current.users, 1);
    assert.ok(prep.body.restore.counts.users > 5);
    assert.equal(prep.body.restore.uploads.files, Object.keys(filesBefore).length);

    const id = prep.body.restore.id;
    assert.equal((await api.post(`/api/admin/restore/${id}/confirm`, { confirm: "yes" }, fresh.cookie)).status, 400, "confirm word required");
    const done = await api.post(`/api/admin/restore/${id}/confirm`, { confirm: "RESTORE" }, fresh.cookie);
    assert.equal(done.status, 200, JSON.stringify(done.body));

    assert.deepEqual(await tableDigests(), before, "table contents differ after restore");
    assert.deepEqual(uploadDigests(), filesBefore, "upload files differ after restore");
    assert.equal((await api.get("/api/auth/me", fresh.cookie)).status, 401, "restore must end every session");

    root.cookie = await login("root@test.local");
    const again = await login(u.email);
    const att = (await api.get(`/api/cards/${c.id}`, again)).body.attachments[0];
    const file = await fetch(`${h.base}/api/attachments/${att.id}/file`, { headers: { cookie: again } });
    assert.equal(file.status, 200);
    assert.equal((await file.arrayBuffer()).byteLength, 200_000);
    assert.equal((await api.post(`/api/admin/restore/${id}/confirm`, { confirm: "RESTORE" }, root.cookie)).status, 400, "a prepared restore is single use");
  });

  test("scheduled backups: written on schedule, not again on restart, retention applied, restorable by name", async () => {
    const names = () => fs.readdirSync(backupDir).filter((n) => /^trboard-backup-.*\.tar\.gz$/.test(n)).sort();
    for (let i = 0; i < 40 && names().length === 0; i++) await sleep(250);
    assert.equal(names().length, 1, "no scheduled backup was written");
    const mode = fs.statSync(path.join(backupDir, names()[0])).mode & 0o777;
    assert.equal(mode, 0o600);

    await h.restart();
    await sleep(2500);
    assert.equal(names().length, 1, "a restart within the interval must not back up again");
    root.cookie = await login("root@test.local");

    await sleep(1100);
    assert.equal((await api.post("/api/admin/backup/run", {}, root.cookie)).status, 200);
    await sleep(1100);
    assert.equal((await api.post("/api/admin/backup/run", {}, root.cookie)).status, 200);
    assert.equal(names().length, 2, "BACKUP_KEEP=2 not applied");
    const listed = (await api.get("/api/admin/backup", root.cookie)).body;
    assert.equal(listed.files.length, 2);
    assert.equal(listed.schedule.keep, 2);

    const prep = await api.post("/api/admin/restore/from-backup", { name: names()[1] }, root.cookie);
    assert.equal(prep.status, 200, JSON.stringify(prep.body));
    assert.equal((await api.del(`/api/admin/restore/${prep.body.restore.id}`, root.cookie)).status, 200);
    assert.equal((await api.post("/api/admin/restore/from-backup", { name: "../../etc/passwd" }, root.cookie)).status, 400);
    assert.deepEqual(fs.readdirSync(path.join(h.uploadsDir, ".trboard-tmp")).filter((n) => n.startsWith("restore-")), []);
  });
});
