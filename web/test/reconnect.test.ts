/**
 * H4: the board store must re-join its room and refetch after a reconnect.
 * Drives the real store (stores/board.ts) with a fake socket (module mock)
 * and a stubbed fetch, so no browser or server is needed.
 * Run: npm test -w web  (node --test with --experimental-test-module-mocks)
 */
import { mock, test } from "node:test";
import assert from "node:assert/strict";

type Handler = (...args: any[]) => void;

class FakeSocket {
  connected = false;
  id = "sock-1";
  sent: Array<[string, unknown]> = [];
  private handlers = new Map<string, Handler[]>();
  on(ev: string, fn: Handler) {
    this.handlers.set(ev, [...(this.handlers.get(ev) ?? []), fn]);
    return this;
  }
  off(ev: string, fn: Handler) {
    this.handlers.set(ev, (this.handlers.get(ev) ?? []).filter((f) => f !== fn));
    return this;
  }
  emit(ev: string, ...args: unknown[]) {
    this.sent.push([ev, args[0]]);
    return this;
  }
  /** simulate a server -> client event / lifecycle event */
  fire(ev: string, payload?: unknown) {
    if (ev === "connect") this.connected = true;
    if (ev === "disconnect") this.connected = false;
    for (const fn of this.handlers.get(ev) ?? []) fn(payload);
  }
  joins() {
    return this.sent.filter(([ev]) => ev === "board:join").map(([, id]) => id);
  }
}

const fake = new FakeSocket();
mock.module("../src/lib/socket.ts", {
  namedExports: { getSocket: () => fake, getSocketId: () => fake.id, resetSocket: () => {} },
});

const BOARD = "11111111-1111-4111-8111-111111111111";
let fetches = 0;
let titles = ["before"];
globalThis.fetch = (async (url: string) => {
  assert.equal(url, `/api/boards/${BOARD}/full`);
  fetches++;
  const body = {
    board: { id: BOARD, name: "B" },
    myAccess: { canRead: true, canWrite: true, canAdmin: true },
    lists: [],
    cards: titles.map((t, i) => ({ id: `c${i}`, title: t, rank: `a${i}`, listId: "l" })),
    labels: [], members: [], teamIds: [], customFieldDefs: [], links: [],
  };
  return new Response(JSON.stringify(body), { status: 200 });
}) as typeof fetch;

const { useBoard } = await import("../src/stores/board.ts");
const settle = () => new Promise((r) => setTimeout(r, 10));

test("first connect after load() does not double-fetch", async () => {
  await useBoard.getState().load(BOARD);
  assert.deepEqual(fake.joins(), [BOARD]);
  assert.equal(fetches, 1);
  fake.fire("connect"); // initial connection completing after load()
  await settle();
  assert.deepEqual(fake.joins(), [BOARD]);
  assert.equal(fetches, 1);
});

test("after a reconnect the store re-joins the room and refetches missed state", async () => {
  fake.fire("disconnect");
  titles = ["before", "added while offline"]; // server state moved on meanwhile
  fake.fire("connect");
  await settle();
  assert.deepEqual(fake.joins(), [BOARD, BOARD], "re-emitted board:join");
  assert.equal(fetches, 2, "refetched /full");
  assert.deepEqual(
    useBoard.getState().cards.map((c) => c.title),
    ["before", "added while offline"],
  );
  assert.equal(useBoard.getState().loading, false, "no loading flash on resync");
});

test("board:kicked resyncs (server re-checks access on the re-join)", async () => {
  fake.fire("board:kicked", { boardId: BOARD });
  await settle();
  assert.equal(fake.joins().length, 3);
  assert.equal(fetches, 3);
});

test("no resync once the board is closed", async () => {
  useBoard.getState().clear();
  fake.fire("disconnect");
  fake.fire("connect");
  await settle();
  assert.equal(fetches, 3);
  assert.equal(fake.joins().length, 3);
});
