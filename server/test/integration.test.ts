/**
 * Regression tests for the High items in research/code-review-2026-11.md.
 * One throwaway Postgres + one real server for the whole file (see harness.ts).
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import type { Socket } from "socket.io-client";
import { client, connectSocket, joinBoard, nextEvent, sleep, startHarness, type Harness } from "./harness.js";

let h: Harness;
let api: ReturnType<typeof client>;
let adminCookie: string; // instance admin (first registered user)
const sockets: Socket[] = [];

type U = { id: string; email: string; cookie: string };

async function makeUser(label: string): Promise<U> {
  const email = `${label}-${crypto.randomBytes(3).toString("hex")}@test.local`;
  const created = await api.post("/api/admin/users", { email, name: label, password: "password123" }, adminCookie);
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const login = await api.post("/api/auth/login", { email, password: "password123" });
  assert.equal(login.status, 200);
  return { id: created.body.user.id, email, cookie: login.cookie! };
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

async function board(owner: U, workspaceId: string, visibility = "workspace"): Promise<string> {
  const r = await api.post("/api/boards", { workspaceId, name: "B", visibility }, owner.cookie);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.board.id;
}

before(async () => {
  h = await startHarness();
  api = client(h.base);
  const reg = await api.post("/api/auth/register", { email: "root@test.local", name: "Root", password: "password123" });
  assert.equal(reg.status, 200);
  assert.equal(reg.body.user.isAdmin, true, "first user becomes instance admin");
  adminCookie = reg.cookie!;
});

after(async () => {
  for (const s of sockets) s.disconnect();
  await h?.stop();
});

describe("registration (packaging: closed by default)", () => {
  test("second self-registration is refused when ALLOW_REGISTRATION is unset", async () => {
    const r = await api.post("/api/auth/register", { email: "late@test.local", name: "Late", password: "password123" });
    assert.equal(r.status, 403);
  });
});

describe("H1: malformed socket payloads cannot crash the server", () => {
  test("bad board:join payloads are rejected and the process stays up", async () => {
    const u = await makeUser("h1");
    const ws = await workspace(u);
    const b = await board(u, ws);
    const s = await socketFor(u);

    // the original crash: a non-UUID reached Postgres (22P02) -> unhandled rejection -> exit
    assert.equal(await joinBoard(s, "x"), false);
    assert.equal(await joinBoard(s, "'; drop table users; --"), false);
    assert.equal(await joinBoard(s, 42), false);
    assert.equal(await joinBoard(s, { id: b }), false);
    assert.equal(await joinBoard(s, crypto.randomUUID()), false); // well-formed, no such board
    // no ack callback / a non-function "ack": used to be `ack?.()` -> TypeError
    s.emit("board:join", "x");
    s.emit("board:join", b, "not-a-function");
    s.emit("board:leave", { nope: true });
    s.emit("board:leave", "x");
    await sleep(500);

    assert.equal(h.child.exitCode, null, `server exited:\n${h.output()}`);
    assert.equal((await fetch(`${h.base}/api/health`)).status, 200);
    // handled at the source, not merely caught by the process-level backstop
    assert.doesNotMatch(h.output(), /unhandledRejection/);
    // and the socket still works for a legitimate join
    assert.equal(await joinBoard(s, b), true);
  });
});

describe("H2: automation fan-out is bounded", () => {
  test("rules per board are capped and one event's action count is budgeted", async () => {
    const u = await makeUser("h2");
    const ws = await workspace(u);
    const b = await board(u, ws);
    const list = (await api.post(`/api/boards/${b}/lists`, { name: "L" }, u.cookie)).body.list;
    const labels: string[] = [];
    for (let i = 0; i < 10; i++) {
      labels.push((await api.post(`/api/boards/${b}/labels`, { name: `l${i}` }, u.cookie)).body.label.id);
    }
    const rule = (n: number) => ({
      name: `r${n}`,
      trigger: { type: "label_added" },
      actions: labels.map((labelId) => ({ type: "add_label", labelId })),
    });
    // 20 rules x 10 add_label each: unbounded, one click was 200 actions at
    // depth 0 alone, and every action re-dispatched all 20 rules.
    for (let i = 0; i < 20; i++) {
      assert.equal((await api.post(`/api/boards/${b}/automation`, rule(i), u.cookie)).status, 200);
    }
    const card = (await api.post(`/api/lists/${list.id}/cards`, { title: "c" }, u.cookie)).body.card;
    assert.equal((await api.put(`/api/cards/${card.id}/labels/${labels[0]}`, {}, u.cookie)).status, 200);

    // wait until the run log stops growing
    let runs: Array<{ ok: boolean; detail: string }> = [];
    let last = -1;
    for (let i = 0; i < 40; i++) {
      await sleep(400);
      runs = (await api.get(`/api/boards/${b}/automation`, u.cookie)).body.runs;
      if (runs.length === last) break;
      last = runs.length;
    }
    // a run is logged ok only if all 10 of its actions ran (a run cut short by
    // the budget is logged as failed), so ok runs x 10 <= total actions <= budget
    const ok = runs.filter((r) => r.ok);
    assert.ok(ok.length * 10 <= 100, `expected <=100 actions, got ${ok.length} ok runs`);
    // dedupe: each rule runs at most once per (card, event type) in a chain
    assert.ok(runs.length <= 20, `expected at most one run per rule, got ${runs.length}`);
    assert.ok(runs.some((r) => !r.ok && /at most 100/.test(r.detail)), "budget stop is logged");

    // cap: 50 rules per board
    for (let i = 20; i < 50; i++) {
      assert.equal((await api.post(`/api/boards/${b}/automation`, rule(i), u.cookie)).status, 200);
    }
    const over = await api.post(`/api/boards/${b}/automation`, rule(50), u.cookie);
    assert.equal(over.status, 409);
    assert.equal(h.child.exitCode, null);
  });
});

describe("H3: workspace roles", () => {
  test("a plain member cannot demote an admin by re-inviting them", async () => {
    const a = await makeUser("h3a");
    const m = await makeUser("h3m");
    const c = await makeUser("h3c");
    const ws = await workspace(a);
    assert.equal((await api.post(`/api/workspaces/${ws}/members`, { email: m.email, role: "member" }, a.cookie)).status, 200);

    // the exploit
    const demote = await api.post(`/api/workspaces/${ws}/members`, { email: a.email, role: "member" }, m.cookie);
    assert.equal(demote.status, 403);
    const roles = async () =>
      Object.fromEntries(
        (await api.get(`/api/workspaces/${ws}`, a.cookie)).body.members.map((x: any) => [x.id, x.role]),
      );
    assert.equal((await roles())[a.id], "admin");

    // members can still invite new people (default "inviting: members") ...
    assert.equal((await api.post(`/api/workspaces/${ws}/members`, { email: c.email, role: "member" }, m.cookie)).status, 200);
    // ... and a no-op re-invite at the same role is fine
    assert.equal((await api.post(`/api/workspaces/${ws}/members`, { email: c.email, role: "member" }, m.cookie)).status, 200);

    // last admin can't be demoted, even by themselves
    const self = await api.post(`/api/workspaces/${ws}/members`, { email: a.email, role: "member" }, a.cookie);
    assert.equal(self.status, 409);
    assert.equal((await roles())[a.id], "admin");

    // admins can change roles when another admin remains
    assert.equal((await api.post(`/api/workspaces/${ws}/members`, { email: m.email, role: "admin" }, a.cookie)).status, 200);
    assert.equal((await api.post(`/api/workspaces/${ws}/members`, { email: m.email, role: "member" }, a.cookie)).status, 200);
    assert.equal((await roles())[m.id], "member");

    // last admin can't be removed either
    assert.equal((await api.del(`/api/workspaces/${ws}/members/${a.id}`, a.cookie)).status, 409);
  });
});

describe("H5: losing workspace / team access removes board access and live rooms", () => {
  test("removed workspace member loses board roles and is kicked from the room", async () => {
    const a = await makeUser("h5a");
    const x = await makeUser("h5x");
    const ws = await workspace(a);
    await api.post(`/api/workspaces/${ws}/members`, { email: x.email, role: "member" }, a.cookie);
    const p = await board(a, ws, "private");
    assert.equal((await api.put(`/api/boards/${p}/members/${x.id}`, { role: "admin" }, a.cookie)).status, 200);
    assert.equal((await api.get(`/api/boards/${p}/full`, x.cookie)).body.myAccess.canAdmin, true);

    const s = await socketFor(x);
    assert.equal(await joinBoard(s, p), true);
    const kicked = nextEvent(s, "board:kicked");

    assert.equal((await api.del(`/api/workspaces/${ws}/members/${x.id}`, a.cookie)).status, 200);
    assert.deepEqual(await kicked, { boardId: p });
    assert.equal((await api.get(`/api/boards/${p}/full`, x.cookie)).status, 404);
    assert.equal(await joinBoard(s, p), false);

    // and no longer receives that board's events
    let leaked = false;
    s.on("list.created", () => (leaked = true));
    await api.post(`/api/boards/${p}/lists`, { name: "after" }, a.cookie);
    await sleep(300);
    assert.equal(leaked, false);
  });

  test("removing a team grant drops implicit access and the live room", async () => {
    const a = await makeUser("h5t");
    const t = await makeUser("h5tm");
    const ws = await workspace(a);
    await api.post(`/api/workspaces/${ws}/members`, { email: t.email, role: "member" }, a.cookie);
    const team = (await api.post(`/api/workspaces/${ws}/teams`, { name: "T" }, a.cookie)).body.team.id;
    assert.equal((await api.patch(`/api/teams/${team}`, { memberIds: [t.id] }, a.cookie)).status, 200);
    const tb = await board(a, ws, "team");
    assert.equal((await api.patch(`/api/boards/${tb}`, { teamIds: [team] }, a.cookie)).status, 200);

    // starring used to create an observer row that survived the grant; stars
    // now live in board_stars (M7) and grant nothing, so this still must 404
    assert.equal((await api.put(`/api/boards/${tb}/star`, { starred: true }, t.cookie)).status, 200);
    const s = await socketFor(t);
    assert.equal(await joinBoard(s, tb), true);
    const kicked = nextEvent(s, "board:kicked");

    assert.equal((await api.patch(`/api/boards/${tb}`, { teamIds: [] }, a.cookie)).status, 200);
    assert.deepEqual(await kicked, { boardId: tb });
    assert.equal((await api.get(`/api/boards/${tb}/full`, t.cookie)).status, 404);
    assert.equal(await joinBoard(s, tb), false);
  });

  test("removing a user from a granted team drops their access", async () => {
    const a = await makeUser("h5r");
    const t = await makeUser("h5rm");
    const ws = await workspace(a);
    await api.post(`/api/workspaces/${ws}/members`, { email: t.email, role: "member" }, a.cookie);
    const team = (await api.post(`/api/workspaces/${ws}/teams`, { name: "T" }, a.cookie)).body.team.id;
    await api.patch(`/api/teams/${team}`, { memberIds: [t.id] }, a.cookie);
    const tb = await board(a, ws, "team");
    await api.patch(`/api/boards/${tb}`, { teamIds: [team] }, a.cookie);
    await api.put(`/api/boards/${tb}/star`, { starred: true }, t.cookie);
    const s = await socketFor(t);
    assert.equal(await joinBoard(s, tb), true);
    const kicked = nextEvent(s, "board:kicked");

    assert.equal((await api.patch(`/api/teams/${team}`, { memberIds: [] }, a.cookie)).status, 200);
    assert.deepEqual(await kicked, { boardId: tb });
    assert.equal((await api.get(`/api/boards/${tb}/full`, t.cookie)).status, 404);
  });
});
