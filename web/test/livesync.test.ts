/**
 * Live-sync fixes from research/code-review-2026-11.md pass 2 (L6, M9),
 * driven through the real board store with a fake socket and stubbed fetch.
 * Run: npm test -w web
 */
import { mock, test } from "node:test";
import assert from "node:assert/strict";

type Handler = (...args: any[]) => void;

class FakeSocket {
  connected = true;
  id = "sock-1";
  private handlers = new Map<string, Handler[]>();
  on(ev: string, fn: Handler) {
    this.handlers.set(ev, [...(this.handlers.get(ev) ?? []), fn]);
    return this;
  }
  off() {
    return this;
  }
  emit() {
    return this;
  }
  fire(ev: string, payload?: unknown) {
    for (const fn of this.handlers.get(ev) ?? []) fn(payload);
  }
}

const fake = new FakeSocket();
mock.module("../src/lib/socket.ts", {
  namedExports: { getSocket: () => fake, getSocketId: () => fake.id, resetSocket: () => {} },
});

const BOARD = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

let fullCalls = 0;
let releaseFull: (() => void) | null = null; // when set, /full waits for it
let snapshotCards: any[] = [];
let patchReply: any = null;
let releasePatch: (() => void) | null = null;

const card = (id: string, rank: string, extra: Record<string, unknown> = {}) => ({
  id, rank, listId: "L", title: id, labelIds: [], memberIds: [], fieldValues: {},
  badges: { comments: 0, attachments: 0, checklist: { total: 2, done: 0 } }, ...extra,
});

globalThis.fetch = (async (url: string, init?: RequestInit) => {
  if (url === `/api/boards/${BOARD}/full`) {
    fullCalls++;
    const cards = snapshotCards.map((c) => ({ ...c }));
    if (releaseFull) await new Promise<void>((r) => (releaseFull = r));
    return new Response(
      JSON.stringify({
        board: { id: BOARD, name: "B" }, starred: false,
        myAccess: { canRead: true, canWrite: true, canAdmin: true },
        lists: [], cards, labels: [], members: [], teamIds: [], customFieldDefs: [], links: [],
      }),
    );
  }
  if (init?.method === "PATCH") {
    const reply = patchReply; // captured at send time, like a real server answer
    if (releasePatch) await new Promise<void>((r) => (releasePatch = r));
    return new Response(JSON.stringify(reply));
  }
  throw new Error(`unexpected fetch ${url}`);
}) as typeof fetch;

const { useBoard, sortRank } = await import("../src/stores/board.ts");
const settle = () => new Promise((r) => setTimeout(r, 10));
const ids = () => useBoard.getState().cards.map((c) => c.id);

test("M9: equal ranks sort by id, consistently", () => {
  const sorted = sortRank([{ id: "b", rank: "n" }, { id: "a", rank: "n" }, { id: "c", rank: "m" }]);
  assert.deepEqual(sorted.map((x) => x.id), ["c", "a", "b"]);
});

test("L6: events that arrive during /full are replayed on top of the snapshot", async () => {
  snapshotCards = [card("a", "a"), card("b", "b")];
  releaseFull = () => {};
  const loading = useBoard.getState().load(BOARD);
  await settle();
  // arrives while /full is in flight; the snapshot below predates it
  fake.fire("card.updated", { card: { id: "a", title: "renamed live" } });
  releaseFull!();
  releaseFull = null;
  await loading;
  await settle();
  assert.equal(useBoard.getState().cards.find((c) => c.id === "a")!.title, "renamed live");
});

test("L6: a counter event during /full triggers one follow-up fetch instead of double counting", async () => {
  const before = fullCalls;
  releaseFull = () => {};
  const p = useBoard.getState().resync();
  await settle();
  fake.fire("comment.created", { cardId: "a" });
  releaseFull!();
  releaseFull = null;
  await p;
  await settle();
  assert.equal(fullCalls, before + 2);
  assert.equal(useBoard.getState().cards.find((c) => c.id === "a")!.badges.comments, 0, "bump was not applied blind");
});

test("L6: checklist badge moves only when done changes", () => {
  const done = () => useBoard.getState().cards.find((c) => c.id === "a")!.badges.checklist!.done;
  fake.fire("checklistItem.updated", { cardId: "a", item: { done: true }, prevDone: false });
  assert.equal(done(), 1);
  // text-only edit of a done item: used to count as another +1
  fake.fire("checklistItem.updated", { cardId: "a", item: { done: true, text: "edited" }, prevDone: true });
  assert.equal(done(), 1, "a text edit changed the done count");
});

test("L6: memberUpserted for another board is ignored", () => {
  fake.fire("board.memberUpserted", { boardId: OTHER, member: { id: "u9", name: "X" } });
  assert.equal(useBoard.getState().members.length, 0);
  fake.fire("board.memberUpserted", { boardId: BOARD, member: { id: "u1", name: "Y" } });
  assert.equal(useBoard.getState().members.length, 1);
});

test("M9: the mover adopts the server's rank from the PATCH response", async () => {
  patchReply = { card: { id: "a", listId: "L", rank: "bm" } };
  useBoard.getState().moveCard("a", "L", null, "b"); // after b
  await settle();
  assert.equal(useBoard.getState().cards.find((c) => c.id === "a")!.rank, "bm");
});

test("M9: a slow response can't undo a newer move", async () => {
  patchReply = { card: { id: "a", listId: "L", rank: "0z" } };
  releasePatch = () => {};
  useBoard.getState().moveCard("a", "L", "b", null); // first move, response held
  await settle();
  const hold = releasePatch!;
  releasePatch = null;
  patchReply = { card: { id: "a", listId: "L", rank: "c" } };
  useBoard.getState().moveCard("a", "L", null, "b"); // newer move
  await settle();
  // now the stale first response (rank 0z) arrives
  hold();
  await settle();
  assert.equal(useBoard.getState().cards.find((c) => c.id === "a")!.rank, "c");
});

test("M9: cards.reranked from the server is applied", () => {
  assert.deepEqual(ids(), ["b", "a"]); // a is at "c", b at "b"
  fake.fire("cards.reranked", { boardId: BOARD, listId: "L", ranks: [{ id: "b", rank: "zz" }] });
  assert.deepEqual(ids(), ["a", "b"]);
  fake.fire("cards.reranked", { boardId: OTHER, listId: "L", ranks: [{ id: "b", rank: "0a" }] });
  assert.deepEqual(ids(), ["a", "b"], "re-rank for another board was applied");
});
