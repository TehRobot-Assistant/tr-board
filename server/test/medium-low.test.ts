/**
 * Regression tests for the Medium/Low items in research/code-review-2026-11.md
 * (pass 2). Same harness as integration.test.ts (throwaway Postgres + the
 * real server as a child process), started with TRUST_PROXY=loopback so the
 * tests can present different client IPs via X-Forwarded-For (M3/M4).
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Socket } from "socket.io-client";
import { client, connectSocket, joinBoard, nextEvent, sleep, startHarness, type Harness } from "./harness.js";

let h: Harness;
let api: ReturnType<typeof client>;
let adminCookie: string;
const sockets: Socket[] = [];

type U = { id: string; email: string; cookie: string };

/** a fresh fake client IP per call, so the per-IP limits never couple tests */
let ipSeq = 1;
const ip = () => ({ "x-forwarded-for": `203.0.113.${ipSeq++ % 250}` });

async function makeUser(label: string, isAdmin = false): Promise<U> {
  const email = `${label}-${crypto.randomBytes(3).toString("hex")}@test.local`;
  const created = await api.post("/api/admin/users", { email, name: label, password: "password123", isAdmin }, adminCookie);
  assert.equal(created.status, 200, JSON.stringify(created.body));
  return { id: created.body.user.id, email, cookie: await login(email) };
}

async function login(email: string, password = "password123"): Promise<string> {
  const r = await api.post("/api/auth/login", { email, password }, undefined, ip());
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.cookie!;
}

async function socketFor(u: U): Promise<Socket> {
  const s = await connectSocket(h.base, u.cookie);
  sockets.push(s);
  return s;
}

async function workspace(owner: U): Promise<string> {
  const r = await api.post("/api/workspaces", { name: "WS" }, owner.cookie);
  assert.equal(r.status, 200);
  return r.body.workspace.id;
}

async function addToWs(ws: string, admin: U, who: U) {
  assert.equal((await api.post(`/api/workspaces/${ws}/members`, { email: who.email, role: "member" }, admin.cookie)).status, 200);
}

async function board(owner: U, workspaceId: string, visibility = "workspace", name = "B"): Promise<string> {
  const r = await api.post("/api/boards", { workspaceId, name, visibility }, owner.cookie);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.board.id;
}

async function list(owner: U, boardId: string, name = "L"): Promise<string> {
  return (await api.post(`/api/boards/${boardId}/lists`, { name }, owner.cookie)).body.list.id;
}

async function card(owner: U, listId: string, title = "c"): Promise<any> {
  const r = await api.post(`/api/lists/${listId}/cards`, { title }, owner.cookie);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.card;
}

async function upload(u: U, cardId: string, name: string, type: string, content: string) {
  const fd = new FormData();
  fd.append("file", new Blob([content], { type }), name);
  const res = await fetch(`${h.base}/api/cards/${cardId}/attachments`, { method: "POST", body: fd, headers: { cookie: u.cookie } });
  return { status: res.status, body: await res.json() };
}

/** resolves true if the socket is disconnected by the server within ms */
function disconnected(s: Socket, ms = 3_000): Promise<boolean> {
  if (!s.connected) return Promise.resolve(true);
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), ms);
    s.once("disconnect", () => {
      clearTimeout(t);
      resolve(true);
    });
  });
}

before(async () => {
  h = await startHarness({ TRUST_PROXY: "loopback", SOCKET_SWEEP_MS: "500" });
  api = client(h.base);
  const reg = await api.post("/api/auth/register", { email: "root@test.local", name: "Root", password: "password123" }, undefined, ip());
  assert.equal(reg.status, 200);
  adminCookie = reg.cookie!;
});

after(async () => {
  for (const s of sockets) s.disconnect();
  await h?.stop();
});

/* ------------------------------------------------------------------ Medium */

describe("M1: sockets follow their session", () => {
  test("logout disconnects that session's socket", async () => {
    const u = await makeUser("m1a");
    const ws = await workspace(u);
    const b = await board(u, ws);
    const s = await socketFor(u);
    assert.equal(await joinBoard(s, b), true);
    const gone = disconnected(s);
    assert.equal((await api.post("/api/auth/logout", {}, u.cookie)).status, 200);
    assert.equal(await gone, true, "socket was not disconnected on logout");
  });

  test("a session deleted behind the socket's back is swept", async () => {
    const u = await makeUser("m1b");
    const s = await socketFor(u);
    const gone = disconnected(s, 4_000);
    await h.sql`delete from sessions where user_id = ${u.id}`;
    assert.equal(await gone, true, "sweep did not drop the socket");
  });

  test("a demoted instance admin loses private boards on the open socket", async () => {
    const owner = await makeUser("m1o");
    const ws = await workspace(owner);
    const p = await board(owner, ws, "private");
    const adm = await makeUser("m1adm", true);
    const s = await socketFor(adm);
    assert.equal(await joinBoard(s, p), true, "instance admin can join any board");
    const kicked = nextEvent(s, "board:kicked");
    assert.equal((await api.patch(`/api/admin/users/${adm.id}`, { isAdmin: false }, adminCookie)).status, 200);
    assert.deepEqual(await kicked, { boardId: p });
    assert.equal(await joinBoard(s, p), false, "used the cached isAdmin=true");
  });

  test("deleting a user disconnects them", async () => {
    const u = await makeUser("m1d");
    const s = await socketFor(u);
    const gone = disconnected(s);
    assert.equal((await api.del(`/api/admin/users/${u.id}`, adminCookie)).status, 200);
    assert.equal(await gone, true);
  });
});

describe("M2: mirrors don't leak private cards", () => {
  test("viewers without source access get a placeholder, in /full and live", async () => {
    const a = await makeUser("m2a");
    const outsider = await makeUser("m2o");
    const ws = await workspace(a);
    await addToWs(ws, a, outsider);
    const secret = await board(a, ws, "private", "Secret");
    const sl = await list(a, secret);
    const src = await card(a, sl, "salary review");
    const shared = await board(a, ws, "workspace", "Shared");
    const tl = await list(a, shared);

    const m = await api.post(`/api/cards/${src.id}/mirror`, { listId: tl }, a.cookie);
    assert.equal(m.status, 200);
    assert.equal(m.body.card.mirror.title, "salary review", "the creator can read the source");

    const full = await api.get(`/api/boards/${shared}/full`, outsider.cookie);
    assert.equal(full.status, 200);
    const raw = JSON.stringify(full.body);
    assert.doesNotMatch(raw, /salary review/);
    assert.doesNotMatch(raw, /Secret/);
    const mc = full.body.cards.find((c: any) => c.id === m.body.card.id);
    assert.deepEqual(mc.mirror, { restricted: true });
    // and the owner still sees the face
    const own = (await api.get(`/api/boards/${shared}/full`, a.cookie)).body.cards.find((c: any) => c.id === m.body.card.id);
    assert.equal(own.mirror.title, "salary review");

    // live: a source edit is pushed per viewer
    const so = await socketFor(outsider);
    const sa = await socketFor(a);
    assert.equal(await joinBoard(so, shared), true);
    assert.equal(await joinBoard(sa, shared), true);
    const evO = nextEvent(so, "mirror.updated");
    const evA = nextEvent(sa, "mirror.updated");
    assert.equal((await api.patch(`/api/cards/${src.id}`, { title: "salary review 2" }, a.cookie)).status, 200);
    assert.deepEqual((await evO).mirror, { restricted: true });
    assert.equal((await evA).mirror.title, "salary review 2");

    // the activity log on the target board doesn't name the source either
    const act = await api.get(`/api/boards/${shared}/activity`, outsider.cookie);
    assert.doesNotMatch(JSON.stringify(act.body), /salary|Secret/);
  });
});

describe("M3: proxy-aware cookies and client IPs (TRUST_PROXY=loopback)", () => {
  test("X-Forwarded-Proto: https from a trusted proxy makes the cookie Secure", async () => {
    const u = await makeUser("m3");
    const viaHttps = await api.post("/api/auth/login", { email: u.email, password: "password123" }, undefined, {
      ...ip(), "x-forwarded-proto": "https",
    });
    assert.equal(viaHttps.status, 200);
    assert.match(viaHttps.setCookie!, /;\s*Secure/i);
    const plain = await api.post("/api/auth/login", { email: u.email, password: "password123" }, undefined, ip());
    assert.doesNotMatch(plain.setCookie!, /Secure/i, "plain-http LAN use must keep a non-Secure cookie");
  });

  test("the public-form throttle is per client IP, not one global bucket", async () => {
    const u = await makeUser("m3f");
    const ws = await workspace(u);
    const b = await board(u, ws);
    const l = await list(u, b);
    const form = await api.post(`/api/boards/${b}/forms`, {
      listId: l, title: "F", fields: [{ id: "q", label: "Q", type: "text", required: true }],
    }, u.cookie);
    assert.equal(form.status, 200);
    const token = form.body.form.token;
    const spammer = { "x-forwarded-for": "198.51.100.7" };
    for (let i = 0; i < 20; i++) {
      assert.equal((await api.post(`/api/public/forms/${token}`, { answers: { q: `s${i}` } }, undefined, spammer)).status, 200);
    }
    assert.equal((await api.post(`/api/public/forms/${token}`, { answers: { q: "x" } }, undefined, spammer)).status, 429);
    const other = await api.post(`/api/public/forms/${token}`, { answers: { q: "legit" } }, undefined, { "x-forwarded-for": "198.51.100.8" });
    assert.equal(other.status, 200, "a different client was blocked by the spammer's bucket");
  });
});

describe("M4: login brute-force limits", () => {
  test("an account locks after 10 failed sign-ins, before argon2 runs", async () => {
    const u = await makeUser("m4");
    for (let i = 0; i < 10; i++) {
      // spread over IPs: this is the per-account limit
      assert.equal((await api.post("/api/auth/login", { email: u.email, password: "wrong-pass" }, undefined, ip())).status, 401);
    }
    const blocked = await api.post("/api/auth/login", { email: u.email, password: "password123" }, undefined, ip());
    assert.equal(blocked.status, 429);
  });

  test("one IP is limited across accounts", async () => {
    const attacker = { "x-forwarded-for": "192.0.2.66" };
    for (let i = 0; i < 30; i++) {
      const r = await api.post("/api/auth/login", { email: `nobody${i}@test.local`, password: "wrong-pass" }, undefined, attacker);
      assert.equal(r.status, 401);
    }
    assert.equal((await api.post("/api/auth/login", { email: "x@test.local", password: "wrong-pass" }, undefined, attacker)).status, 429);
    // someone else is unaffected
    const u = await makeUser("m4b");
    assert.ok(u.cookie);
  });
});

describe("M5: changing your password ends your other sessions", () => {
  test("other session is revoked, this one survives", async () => {
    const u = await makeUser("m5");
    const other = await login(u.email);
    const so = await connectSocket(h.base, other);
    sockets.push(so);
    const gone = disconnected(so);
    const r = await api.patch("/api/auth/me", { password: "newpassword1", currentPassword: "password123" }, u.cookie);
    assert.equal(r.status, 200);
    assert.equal((await api.get("/api/auth/me", other)).status, 401);
    assert.equal((await api.get("/api/auth/me", u.cookie)).status, 200);
    assert.equal(await gone, true, "the other session's socket stayed connected");
  });
});

describe("M6: attachments stream to disk and are removed with their card", () => {
  test("upload, download, then delete the card removes the folder", async () => {
    const u = await makeUser("m6");
    const ws = await workspace(u);
    const b = await board(u, ws);
    const l = await list(u, b);
    const c = await card(u, l);
    const up = await upload(u, c.id, "notes.txt", "text/plain", "hello attachment");
    assert.equal(up.status, 200, JSON.stringify(up.body));
    assert.equal(up.body.attachment.size, 16);
    const dir = path.join(h.uploadsDir, c.id);
    assert.equal(fs.readdirSync(dir).length, 1);
    assert.ok(!fs.readdirSync(dir)[0].endsWith(".part"));
    const dl = await fetch(`${h.base}/api/attachments/${up.body.attachment.id}/file`, { headers: { cookie: u.cookie } });
    assert.equal(await dl.text(), "hello attachment");

    assert.equal((await api.del(`/api/cards/${c.id}`, u.cookie)).status, 200);
    await sleep(200);
    assert.equal(fs.existsSync(dir), false, "card folder left behind");
  });

  test("deleting a list or a board removes its cards' folders", async () => {
    const u = await makeUser("m6b");
    const ws = await workspace(u);
    const b = await board(u, ws);
    const l1 = await list(u, b);
    const l2 = await list(u, b);
    const c1 = await card(u, l1);
    const c2 = await card(u, l2);
    await upload(u, c1.id, "a.txt", "text/plain", "a");
    await upload(u, c2.id, "b.txt", "text/plain", "b");
    assert.equal((await api.del(`/api/lists/${l1}`, u.cookie)).status, 200);
    await sleep(200);
    assert.equal(fs.existsSync(path.join(h.uploadsDir, c1.id)), false);
    assert.equal(fs.existsSync(path.join(h.uploadsDir, c2.id)), true);
    assert.equal((await api.del(`/api/boards/${b}`, u.cookie)).status, 200);
    await sleep(200);
    assert.equal(fs.existsSync(path.join(h.uploadsDir, c2.id)), false);
  });
});

describe("M7: stars don't grant access", () => {
  test("starring a workspace board, then the board goes private: no access left", async () => {
    const a = await makeUser("m7a");
    const m = await makeUser("m7m");
    const ws = await workspace(a);
    await addToWs(ws, a, m);
    const b = await board(a, ws, "workspace");
    assert.equal((await api.put(`/api/boards/${b}/star`, { starred: true }, m.cookie)).status, 200);
    const home = await api.get(`/api/workspaces/${ws}`, m.cookie);
    assert.equal(home.body.boards.find((x: any) => x.id === b).starred, true);
    assert.equal((await api.get(`/api/boards/${b}/full`, m.cookie)).body.starred, true);
    // the star must not show up as a membership
    const full = await api.get(`/api/boards/${b}/full`, a.cookie);
    assert.equal(full.body.members.some((x: any) => x.id === m.id), false);

    assert.equal((await api.patch(`/api/boards/${b}`, { visibility: "private" }, a.cookie)).status, 200);
    assert.equal((await api.get(`/api/boards/${b}/full`, m.cookie)).status, 404);

    // unstar works too
    assert.equal((await api.put(`/api/boards/${b}/star`, { starred: false }, a.cookie)).status, 200);
  });
});

describe("M8: card assignees and notify targets must see the board", () => {
  test("outsiders and unknown users can't be assigned; notify skips them", async () => {
    const a = await makeUser("m8a");
    const outsider = await makeUser("m8o");
    const ws = await workspace(a);
    const p = await board(a, ws, "private");
    const l = await list(a, p);
    const c = await card(a, l, "private title");

    assert.equal((await api.put(`/api/cards/${c.id}/members/${outsider.id}`, {}, a.cookie)).status, 400);
    assert.equal((await api.put(`/api/cards/${c.id}/members/${crypto.randomUUID()}`, {}, a.cookie)).status, 400, "unknown id used to 500");
    assert.equal((await api.put(`/api/cards/${c.id}/members/${a.id}`, {}, a.cookie)).status, 200);

    const cl = (await api.post(`/api/cards/${c.id}/checklists`, { name: "CL" }, a.cookie)).body.checklist;
    const item = (await api.post(`/api/checklists/${cl.id}/items`, { text: "i" }, a.cookie)).body.item;
    assert.equal((await api.patch(`/api/checklist-items/${item.id}`, { assigneeId: outsider.id }, a.cookie)).status, 400);
    assert.equal((await api.patch(`/api/checklist-items/${item.id}`, { assigneeId: a.id }, a.cookie)).status, 200);

    // a rule that notifies a hand-picked outsider (and the card's members)
    const lab = (await api.post(`/api/boards/${p}/labels`, { name: "go" }, a.cookie)).body.label.id;
    const rule = await api.post(`/api/boards/${p}/automation`, {
      name: "n", trigger: { type: "label_added" },
      actions: [{ type: "notify", userId: outsider.id, text: "x" }, { type: "notify", text: "y" }],
    }, a.cookie);
    assert.equal(rule.status, 200);
    assert.equal((await api.put(`/api/cards/${c.id}/labels/${lab}`, {}, a.cookie)).status, 200);
    await sleep(800);
    const mine = (await api.get("/api/notifications", a.cookie)).body.notifications;
    assert.ok(mine.some((n: any) => n.data.cardId === c.id), "card member was notified");
    const theirs = (await api.get("/api/notifications", outsider.cookie)).body.notifications;
    assert.equal(theirs.length, 0, "outsider got a notification with a private card title");
  });
});

describe("M9: rank ties are broken and rebalanced", () => {
  test("a drop between two tied cards lands between them; others see the re-rank", async () => {
    const u = await makeUser("m9");
    const ws = await workspace(u);
    const b = await board(u, ws);
    const l = await list(u, b);
    const A = await card(u, l, "A");
    const B = await card(u, l, "B");
    const C = await card(u, l, "C");
    // simulate the concurrent-drop race: B gets A's rank
    await h.sql`update cards set rank = ${A.rank} where id = ${B.id}`;
    const [first, second] = [A, B].sort((x, y) => (x.id < y.id ? -1 : 1)); // tie order is (rank, id)

    const full = (await api.get(`/api/boards/${b}/full`, u.cookie)).body.cards.map((c: any) => c.id);
    assert.deepEqual(full, [first.id, second.id, C.id], "/full breaks the tie by id");

    const viewer = await socketFor(u);
    assert.equal(await joinBoard(viewer, b), true);
    const reranked = nextEvent(viewer, "cards.reranked");
    const r = await api.patch(`/api/cards/${C.id}`, { move: { listId: l, afterId: first.id, beforeId: second.id } }, u.cookie);
    assert.equal(r.status, 200);
    const ev = await reranked;
    assert.equal(ev.listId, l);

    const after = (await api.get(`/api/boards/${b}/full`, u.cookie)).body.cards;
    assert.deepEqual(after.map((c: any) => c.id), [first.id, C.id, second.id], "C did not land between the tied pair");
    const ranks = after.map((c: any) => c.rank);
    assert.ok(ranks[0] < ranks[1] && ranks[1] < ranks[2], `ranks not strictly increasing: ${ranks}`);
    assert.equal(r.body.card.rank, ranks[1], "PATCH response carries the stored rank");
  });
});

describe("M10: due_approaching doesn't re-fire after a restart", () => {
  test("one comment per (rule, card, due date) across restarts", async () => {
    const u = await makeUser("m10");
    const ws = await workspace(u);
    const b = await board(u, ws);
    const l = await list(u, b);
    const c = await card(u, l);
    const due = new Date(Date.now() + 2 * 3600_000).toISOString();
    assert.equal((await api.patch(`/api/cards/${c.id}`, { dueAt: due }, u.cookie)).status, 200);
    assert.equal((await api.post(`/api/boards/${b}/automation`, {
      name: "soon", trigger: { type: "due_approaching", hoursBefore: 24 }, actions: [{ type: "comment", text: "due soon" }],
    }, u.cookie)).status, 200);
    // a second due rule must not make the first fire twice per tick
    assert.equal((await api.post(`/api/boards/${b}/automation`, {
      name: "later", trigger: { type: "due_approaching", hoursBefore: 1 }, actions: [{ type: "comment", text: "within the hour" }],
    }, u.cookie)).status, 200);

    // also plant an orphaned upload folder for the boot-time sweep (M6)
    const orphan = path.join(h.uploadsDir, crypto.randomUUID());
    fs.mkdirSync(orphan);
    fs.writeFileSync(path.join(orphan, "x.bin"), "x");

    const comments = async () =>
      ((await api.get(`/api/cards/${c.id}`, u.cookie)).body.comments as Array<{ body: string }>).map((x) => x.body);
    const settle = async () => {
      for (let i = 0; i < 20 && !(await comments()).length; i++) await sleep(200);
      await sleep(500);
    };

    await h.restart(); // boot tick: fires "soon" once (2h is outside "later"'s 1h window)
    await settle();
    assert.deepEqual(await comments(), ["due soon"]);
    assert.equal(fs.existsSync(orphan), false, "boot sweep left an orphaned upload folder");

    await h.restart(); // used to fire again on every boot
    await sleep(1500);
    assert.deepEqual(await comments(), ["due soon"]);

    // a new due date is a new firing
    const due2 = new Date(Date.now() + 3 * 3600_000).toISOString();
    await api.patch(`/api/cards/${c.id}`, { dueAt: due2 }, u.cookie);
    await h.restart();
    await sleep(1500);
    assert.deepEqual(await comments(), ["due soon", "due soon"]);
  });
});

describe("M11: Trello import is all-or-nothing and tolerates bad dates", () => {
  test("malformed dates become no date instead of a 500", async () => {
    const u = await makeUser("m11");
    const ws = await workspace(u);
    const r = await api.post(`/api/workspaces/${ws}/import/trello`, {
      name: "T",
      lists: [{ id: "l1", name: "L", pos: 1 }],
      cards: [
        { id: "c1", idList: "l1", name: "bad due", due: "not a date", pos: 1 },
        { id: "c2", idList: "l1", name: "good due", due: "2026-12-01T00:00:00.000Z", pos: 2 },
      ],
    }, u.cookie);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const full = (await api.get(`/api/boards/${r.body.board.id}/full`, u.cookie)).body.cards;
    assert.equal(full.find((c: any) => c.title === "bad due").dueAt, null);
    assert.ok(full.find((c: any) => c.title === "good due").dueAt);
  });

  test("a failure late in the import leaves no half-built board", async () => {
    const u = await makeUser("m11b");
    const ws = await workspace(u);
    const before = (await api.get(`/api/workspaces/${ws}`, u.cookie)).body.boards.length;
    // Postgres rejects NUL in text: this fails at the comments stage, after
    // the board, lists and cards were inserted
    const r = await api.post(`/api/workspaces/${ws}/import/trello`, {
      name: "Half",
      lists: [{ id: "l1", name: "L" }],
      cards: [{ id: "c1", idList: "l1", name: "card" }],
      actions: [{ type: "commentCard", data: { card: { id: "c1" }, text: "bad \u0000 byte" } }],
    }, u.cookie);
    assert.ok(r.status >= 400, `expected a failure, got ${r.status}`);
    const afterCount = (await api.get(`/api/workspaces/${ws}`, u.cookie)).body.boards.length;
    assert.equal(afterCount, before, "a partial board was left behind");
    assert.equal(h.child.exitCode, null);
  });
});

/* --------------------------------------------------------------------- Low */

describe("Low items", () => {
  test("L1: a partial settings patch keeps the other settings", async () => {
    const u = await makeUser("l1");
    const ws = await workspace(u);
    await api.patch(`/api/workspaces/${ws}`, { settings: { inviting: "admins", visibilityChanges: "admins" } }, u.cookie);
    const r = await api.patch(`/api/workspaces/${ws}`, { settings: { boardCreation: "admins" } }, u.cookie);
    assert.deepEqual(r.body.workspace.settings, { inviting: "admins", visibilityChanges: "admins", boardCreation: "admins" });
  });

  test("L2: bad ids are 404/400, not 500", async () => {
    const u = await makeUser("l2");
    const ws = await workspace(u);
    const b = await board(u, ws);
    const c = await card(u, await list(u, b));
    assert.equal((await api.del(`/api/cards/${c.id}/labels/not-a-uuid`, u.cookie)).status, 404);
    assert.equal((await api.del(`/api/cards/${c.id}/members/not-a-uuid`, u.cookie)).status, 404);
    // instance admin + well-formed unknown workspace
    assert.equal((await api.post("/api/boards", { workspaceId: crypto.randomUUID(), name: "x" }, adminCookie)).status, 404);
  });

  test("L3: a share link doesn't publish cards in archived lists", async () => {
    const u = await makeUser("l3");
    const ws = await workspace(u);
    const b = await board(u, ws);
    const keep = await list(u, b, "keep");
    const gone = await list(u, b, "gone");
    await card(u, keep, "visible");
    await card(u, gone, "hidden in archived list");
    await api.patch(`/api/lists/${gone}`, { archived: true }, u.cookie);
    const token = (await api.post(`/api/boards/${b}/share-link`, { enabled: true }, u.cookie)).body.shareToken;
    const pub = await api.get(`/api/public/boards/${token}`);
    assert.deepEqual(pub.body.cards.map((c: any) => c.title), ["visible"]);
  });

  test("L5: responses forbid framing", async () => {
    const r = await api.get("/api/health");
    assert.equal(r.headers.get("x-frame-options"), "DENY");
    assert.match(r.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
  });

  test("L7: deleting a list removes mirrors of its cards on other boards", async () => {
    const u = await makeUser("l7");
    const ws = await workspace(u);
    const b1 = await board(u, ws);
    const b2 = await board(u, ws);
    const l1 = await list(u, b1);
    const src = await card(u, l1);
    const m = (await api.post(`/api/cards/${src.id}/mirror`, { listId: await list(u, b2) }, u.cookie)).body.card;
    const s = await socketFor(u);
    assert.equal(await joinBoard(s, b2), true);
    const del = nextEvent(s, "card.deleted");
    assert.equal((await api.del(`/api/lists/${l1}`, u.cookie)).status, 200);
    assert.equal((await del).cardId, m.id);
    const left = await h.sql`select id from cards where id = ${m.id}`;
    assert.equal(left.length, 0, "mirror survived its source (used to render as 'source gone')");
  });

  test("L9: deletion impact counts private boards the admin can't open", async () => {
    const a = await makeUser("l9a");
    const other = await makeUser("l9o");
    const ws = await workspace(a);
    await addToWs(ws, a, other);
    await board(a, ws, "workspace");
    await board(a, ws, "private");
    await board(other, ws, "private"); // a (ws admin) can't open this one
    const r = await api.get(`/api/workspaces/${ws}/deletion-impact`, a.cookie);
    assert.deepEqual(r.body, { boards: 3, privateBoards: 2, hiddenPrivateBoards: 1 });
    assert.equal((await api.get(`/api/workspaces/${ws}/deletion-impact`, other.cookie)).status, 403);
  });

  test("L10: only exact allowlisted types are served inline", async () => {
    const u = await makeUser("l10");
    const ws = await workspace(u);
    const c = await card(u, await list(u, await board(u, ws)));
    const html = (await upload(u, c.id, "x.html", "text/html", "<script>1</script>")).body.attachment;
    const png = (await upload(u, c.id, "x.png", "image/png", "png")).body.attachment;
    const get = (id: string) => fetch(`${h.base}/api/attachments/${id}/file`, { headers: { cookie: u.cookie } });
    const rh = await get(html.id);
    assert.equal(rh.headers.get("content-type"), "application/octet-stream");
    assert.match(rh.headers.get("content-disposition")!, /^attachment/);
    const rp = await get(png.id);
    assert.equal(rp.headers.get("content-type"), "image/png");
    assert.match(rp.headers.get("content-disposition")!, /^inline/);
    // a stored type that merely starts with an allowed one is not inline
    await h.sql`update attachments set mime = 'image/png,text/html' where id = ${png.id}`;
    const rx = await get(png.id);
    assert.equal(rx.headers.get("content-type"), "application/octet-stream");
    assert.match(rx.headers.get("content-disposition")!, /^attachment/);
  });

  test("L6: checklist item updates say whether done changed", async () => {
    const u = await makeUser("l6");
    const ws = await workspace(u);
    const b = await board(u, ws);
    const c = await card(u, await list(u, b));
    const cl = (await api.post(`/api/cards/${c.id}/checklists`, { name: "CL" }, u.cookie)).body.checklist;
    const item = (await api.post(`/api/checklists/${cl.id}/items`, { text: "i" }, u.cookie)).body.item;
    const s = await socketFor(u);
    assert.equal(await joinBoard(s, b), true);
    const ev = nextEvent(s, "checklistItem.updated");
    await api.patch(`/api/checklist-items/${item.id}`, { text: "renamed" }, u.cookie);
    const p = await ev;
    assert.equal(p.prevDone, false);
    assert.equal(p.item.done, false);
  });
});
