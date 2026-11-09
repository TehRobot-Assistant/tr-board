/**
 * Live board state. Hydrated from /api/boards/:id/full, then kept current two
 * ways at once: optimistic local mutations (instant UI) and socket events from
 * everyone else (own events are excluded server-side via x-socket-id).
 */
import { create } from "zustand";
import type {
  Board, BoardFull, BoardMember, Card, CardLink, CustomFieldDef, Label, List, MyAccess,
} from "../lib/types";
import { api } from "../lib/api";
import { between } from "../lib/rank";
import { getSocket } from "../lib/socket";

export type BoardFilter = {
  text: string;
  labelIds: string[];
  memberIds: string[];
  due: "any" | "overdue" | "today" | "week" | "none" | "done";
};

export const EMPTY_FILTER: BoardFilter = { text: "", labelIds: [], memberIds: [], due: "any" };

export function filterActive(f: BoardFilter): number {
  return (
    (f.text.trim() ? 1 : 0) + f.labelIds.length + f.memberIds.length + (f.due !== "any" ? 1 : 0)
  );
}

export function matchesFilter(c: Card, f: BoardFilter): boolean {
  if (f.text.trim() && !c.title.toLowerCase().includes(f.text.trim().toLowerCase())) return false;
  if (f.labelIds.length && !f.labelIds.some((l) => c.labelIds.includes(l))) return false;
  if (f.memberIds.length && !f.memberIds.some((m) => c.memberIds.includes(m))) return false;
  switch (f.due) {
    case "overdue":
      if (!c.dueAt || c.dueComplete || Date.parse(c.dueAt) >= Date.now()) return false;
      break;
    case "today": {
      if (!c.dueAt) return false;
      const d = new Date(c.dueAt);
      const now = new Date();
      if (d.toDateString() !== now.toDateString()) return false;
      break;
    }
    case "week":
      if (!c.dueAt) return false;
      if (Date.parse(c.dueAt) > Date.now() + 7 * 86400_000 || Date.parse(c.dueAt) < Date.now() - 86400_000) return false;
      break;
    case "none":
      if (c.dueAt) return false;
      break;
    case "done":
      if (!c.dueComplete) return false;
      break;
  }
  return true;
}

type BoardState = {
  boardId: string | null;
  filter: BoardFilter;
  setFilter(patch: Partial<BoardFilter>): void;
  clearFilter(): void;
  loading: boolean;
  error: string | null;
  board: Board | null;
  /** whether I starred this board */
  starred: boolean;
  myAccess: MyAccess | null;
  lists: List[];
  cards: Card[];
  labels: Label[];
  members: BoardMember[];
  teamIds: string[];
  customFieldDefs: CustomFieldDef[];
  links: CardLink[];

  load(boardId: string): Promise<void>;
  /** re-join the room + refetch without a loading flash (reconnect / kick) */
  resync(): Promise<void>;
  clear(): void;

  // optimistic mutations (fire API, apply locally)
  addList(name: string): Promise<void>;
  renameList(id: string, name: string): Promise<void>;
  archiveList(id: string, archived: boolean): Promise<void>;
  moveList(id: string, beforeId: string | null, afterId: string | null): void;
  addCard(listId: string, title: string, position?: "top" | "bottom"): Promise<void>;
  moveCard(id: string, listId: string, beforeId: string | null, afterId: string | null): void;
  /** local-only reposition used mid-drag (no API call) */
  moveCardLocal(id: string, listId: string, beforeId: string | null, afterId: string | null): void;
  patchCard(id: string, patch: Partial<Card>): void;
  snapshotCards(): Card[];
  restoreCards(cards: Card[]): void;
};

/**
 * Rank order with id as the tiebreaker (M9). Two concurrent drops into one gap
 * can produce equal ranks; without a tiebreak each client (and the server)
 * could show the pair in a different order. Plain string compare of lowercase
 * uuids matches Postgres' uuid ordering, which the server uses too.
 */
export const sortRank = <T extends { rank: string; id?: string }>(xs: T[]) =>
  [...xs].sort((a, b) =>
    a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : (a.id ?? "") < (b.id ?? "") ? -1 : (a.id ?? "") > (b.id ?? "") ? 1 : 0,
  );

/**
 * Socket events that bump a counter. They can't be replayed safely on top of
 * a /full snapshot (the snapshot may already include them), so one arriving
 * mid-fetch triggers a follow-up refetch instead (L6).
 */
const COUNTER_EVENTS = new Set([
  "comment.created", "comment.deleted", "attachment.created", "attachment.deleted",
  "checklistItem.created", "checklistItem.updated", "checklistItem.deleted",
]);

export const useBoard = create<BoardState>((set, get) => {
  /*
   * L6: events that arrive while /full is in flight used to be applied to the
   * old state and then overwritten by the snapshot, which may predate them.
   * While any fetch is in flight they're queued, then replayed (in order) on
   * top of the snapshot. Replay is safe for set/merge/remove handlers (an
   * event the snapshot already includes just re-applies the same value);
   * counter bumps aren't, so those schedule one more fetch instead.
   */
  let inflight = 0;
  let queued: Array<() => void> = [];
  let counterMissed = false;

  /** join the board room and (re)hydrate from /full; shared by load + resync */
  const fetchBoard = async (boardId: string, followUp = false): Promise<void> => {
    getSocket().emit("board:join", boardId);
    inflight++;
    let applied = false;
    try {
      const data = await api.get<BoardFull>(`/api/boards/${boardId}/full`);
      if (get().boardId !== boardId) return; // navigated away mid-fetch
      applied = true;
      set({
        loading: false,
        error: null,
        board: data.board,
        starred: !!data.starred,
        myAccess: data.myAccess,
        lists: sortRank(data.lists),
        cards: sortRank(data.cards),
        labels: data.labels,
        members: data.members,
        teamIds: data.teamIds,
        customFieldDefs: sortRank(data.customFieldDefs),
        links: data.links ?? [],
      });
    } catch (err: any) {
      if (get().boardId !== boardId) return;
      set({ loading: false, error: err.message ?? "Failed to load board" });
    } finally {
      inflight--;
      const replay = queued;
      queued = [];
      if (get().boardId === boardId) for (const fn of replay) fn();
      if (applied && inflight === 0 && counterMissed && !followUp) {
        counterMissed = false;
        void fetchBoard(boardId, true);
      } else if (inflight === 0) {
        counterMissed = false;
      }
    }
  };

  /* ----------------------------------------------------- socket wiring */
  const socket = getSocket();
  const on = (event: string, fn: (payload: any) => void) => {
    socket.on(event, (payload: any) => {
      // only apply events for the board we're viewing
      const s = get();
      if (!s.boardId) return;
      if (inflight > 0) {
        if (COUNTER_EVENTS.has(event)) counterMissed = true;
        else queued.push(() => fn(payload));
        return;
      }
      fn(payload);
    });
  };

  on("board.updated", ({ board }) => set((s) => (board.id === s.boardId ? { board } : s)));
  on("board.deleted", ({ boardId }) => {
    if (boardId === get().boardId) set({ error: "This board was deleted." });
  });
  // Server emits "board:kicked" (colon) when access changes; this listened for
  // "board.kicked" and so never fired. Resync instead of a dead-end error: the
  // re-join re-checks access, so someone who still has access (e.g. after a
  // visibility change) just carries on, and someone who lost it gets the 404.
  socket.on("board:kicked", ({ boardId }: { boardId?: string }) => {
    if (boardId && boardId === get().boardId) void get().resync();
  });

  // H4: Socket.IO rooms belong to one connection. After any reconnect (server
  // restart, Wi-Fi drop, laptop sleep, re-auth) the new connection is in no
  // board room, so live updates silently stopped. Re-join and refetch /full so
  // events missed while disconnected aren't lost. Skips the very first connect:
  // load() already joined (emits are buffered until connected) and fetched.
  // (The per-user notification room is joined server-side on every connect.)
  let connectedBefore = socket.connected;
  socket.on("connect", () => {
    if (!connectedBefore) {
      connectedBefore = true;
      return;
    }
    if (get().boardId) void get().resync();
  });
  // L6: check the boardId like the other "created" handlers do (older
  // servers didn't send one, hence the `boardId &&`)
  on("board.memberUpserted", ({ boardId, member }) =>
    set((s) =>
      boardId && boardId !== s.boardId
        ? s
        : { members: [...s.members.filter((m) => m.id !== member.id), member] },
    ),
  );
  on("board.memberRemoved", ({ boardId, userId }) =>
    set((s) => (boardId && boardId !== s.boardId ? s : { members: s.members.filter((m) => m.id !== userId) })),
  );

  // M9: the server re-ranked a list (or the board's lists) to break a rank
  // tie. Sent to every client, the mover included.
  const applyRanks = <T extends { id: string; rank: string }>(xs: T[], ranks: Array<{ id: string; rank: string }>) => {
    const m = new Map(ranks.map((r) => [r.id, r.rank]));
    return sortRank(xs.map((x) => (m.has(x.id) ? { ...x, rank: m.get(x.id)! } : x)));
  };
  on("cards.reranked", ({ boardId, ranks }) =>
    set((s) => (boardId !== s.boardId ? s : { cards: applyRanks(s.cards, ranks) })),
  );
  on("lists.reranked", ({ boardId, ranks }) =>
    set((s) => (boardId !== s.boardId ? s : { lists: applyRanks(s.lists, ranks) })),
  );

  on("list.created", ({ list }) =>
    set((s) => (list.boardId === s.boardId ? { lists: sortRank([...s.lists, list]) } : s)),
  );
  on("list.updated", ({ list }) =>
    set((s) => ({ lists: sortRank(s.lists.map((l) => (l.id === list.id ? list : l))) })),
  );
  on("list.deleted", ({ listId }) =>
    set((s) => ({
      lists: s.lists.filter((l) => l.id !== listId),
      cards: s.cards.filter((c) => c.listId !== listId),
    })),
  );

  on("card.created", ({ card }) =>
    set((s) =>
      card.boardId === s.boardId && !s.cards.some((c) => c.id === card.id)
        ? { cards: sortRank([...s.cards, card]) }
        : s,
    ),
  );
  on("card.updated", ({ card }) =>
    set((s) => ({
      cards: sortRank(
        s.cards.map((c) => (c.id === card.id ? { ...c, ...card } : c)),
      ),
    })),
  );
  on("card.deleted", ({ cardId }) =>
    set((s) => ({
      cards: s.cards.filter((c) => c.id !== cardId),
      links: s.links.filter((l) => l.cardId !== cardId && l.blocksCardId !== cardId),
    })),
  );
  on("card.labelAdded", ({ cardId, labelId }) =>
    set((s) => ({
      cards: s.cards.map((c) =>
        c.id === cardId && !c.labelIds.includes(labelId)
          ? { ...c, labelIds: [...c.labelIds, labelId] }
          : c,
      ),
    })),
  );
  on("card.labelRemoved", ({ cardId, labelId }) =>
    set((s) => ({
      cards: s.cards.map((c) =>
        c.id === cardId ? { ...c, labelIds: c.labelIds.filter((l) => l !== labelId) } : c,
      ),
    })),
  );
  on("card.memberAdded", ({ cardId, userId }) =>
    set((s) => ({
      cards: s.cards.map((c) =>
        c.id === cardId && !c.memberIds.includes(userId)
          ? { ...c, memberIds: [...c.memberIds, userId] }
          : c,
      ),
    })),
  );
  on("card.memberRemoved", ({ cardId, userId }) =>
    set((s) => ({
      cards: s.cards.map((c) =>
        c.id === cardId ? { ...c, memberIds: c.memberIds.filter((u) => u !== userId) } : c,
      ),
    })),
  );
  on("card.fieldChanged", ({ cardId, fieldId, value }) =>
    set((s) => ({
      cards: s.cards.map((c) =>
        c.id === cardId
          ? {
              ...c,
              fieldValues:
                value === null
                  ? Object.fromEntries(Object.entries(c.fieldValues).filter(([k]) => k !== fieldId))
                  : { ...c.fieldValues, [fieldId]: value },
            }
          : c,
      ),
    })),
  );

  on("link.created", ({ cardId, blocksCardId }) =>
    set((s) => ({
      links: s.links.some((l) => l.cardId === cardId && l.blocksCardId === blocksCardId)
        ? s.links
        : [...s.links, { cardId, blocksCardId }],
    })),
  );
  on("link.deleted", ({ a, b }) =>
    set((s) => ({
      links: s.links.filter(
        (l) =>
          !(l.cardId === a && l.blocksCardId === b) && !(l.cardId === b && l.blocksCardId === a),
      ),
    })),
  );

  on("mirror.updated", ({ cardId, mirror }) =>
    set((s) => ({
      cards: s.cards.map((c) => (c.id === cardId ? { ...c, mirror } : c)),
    })),
  );

  on("label.created", ({ label }) =>
    set((s) => (label.boardId === s.boardId ? { labels: [...s.labels, label] } : s)),
  );
  on("label.updated", ({ label }) =>
    set((s) => ({ labels: s.labels.map((l) => (l.id === label.id ? label : l)) })),
  );
  on("label.deleted", ({ labelId }) =>
    set((s) => ({
      labels: s.labels.filter((l) => l.id !== labelId),
      cards: s.cards.map((c) => ({ ...c, labelIds: c.labelIds.filter((l) => l !== labelId) })),
    })),
  );

  on("field.created", ({ field }) =>
    set((s) =>
      field.boardId === s.boardId
        ? { customFieldDefs: sortRank([...s.customFieldDefs, field]) }
        : s,
    ),
  );
  on("field.updated", ({ field }) =>
    set((s) => ({
      customFieldDefs: s.customFieldDefs.map((f) => (f.id === field.id ? field : f)),
    })),
  );
  on("field.deleted", ({ fieldId }) =>
    set((s) => ({ customFieldDefs: s.customFieldDefs.filter((f) => f.id !== fieldId) })),
  );

  // badge nudges from card-detail events (comments/attachments/checklists)
  const bump = (cardId: string, fn: (b: Card["badges"]) => Card["badges"]) =>
    set((s) => ({
      cards: s.cards.map((c) => (c.id === cardId ? { ...c, badges: fn(c.badges) } : c)),
    }));
  on("comment.created", ({ cardId }) => bump(cardId, (b) => ({ ...b, comments: b.comments + 1 })));
  on("comment.deleted", ({ cardId }) => bump(cardId, (b) => ({ ...b, comments: Math.max(0, b.comments - 1) })));
  on("attachment.created", ({ cardId }) => bump(cardId, (b) => ({ ...b, attachments: b.attachments + 1 })));
  on("attachment.deleted", ({ cardId }) => bump(cardId, (b) => ({ ...b, attachments: Math.max(0, b.attachments - 1) })));
  on("checklistItem.created", ({ cardId }) =>
    bump(cardId, (b) => ({ ...b, checklist: { total: (b.checklist?.total ?? 0) + 1, done: b.checklist?.done ?? 0 } })),
  );
  // L6: only a change of `done` moves the count. The server sends the item's
  // previous state as prevDone; a text/assignee/due edit used to count as +/-1.
  on("checklistItem.updated", ({ cardId, item, prevDone }) => {
    if (typeof prevDone !== "boolean" || prevDone === item.done) return;
    bump(cardId, (b) =>
      b.checklist
        ? { ...b, checklist: { ...b.checklist, done: Math.max(0, Math.min(b.checklist.total, b.checklist.done + (item.done ? 1 : -1))) } }
        : b,
    );
  });
  on("checklistItem.deleted", ({ cardId }) =>
    bump(cardId, (b) =>
      b.checklist
        ? { ...b, checklist: { total: Math.max(0, b.checklist.total - 1), done: Math.min(b.checklist.done, Math.max(0, b.checklist.total - 1)) } }
        : b,
    ),
  );

  /** per-row move counter, so a slow PATCH response can't undo a newer move */
  const moveSeq = new Map<string, number>();
  const bumpSeq = (id: string) => {
    const n = (moveSeq.get(id) ?? 0) + 1;
    moveSeq.set(id, n);
    return n;
  };

  /* ------------------------------------------------------------- store */
  return {
    boardId: null,
    filter: EMPTY_FILTER,
    setFilter(patch) {
      set((s) => ({ filter: { ...s.filter, ...patch } }));
    },
    clearFilter() {
      set({ filter: EMPTY_FILTER });
    },
    loading: false,
    error: null,
    board: null,
    starred: false,
    myAccess: null,
    lists: [],
    cards: [],
    labels: [],
    members: [],
    teamIds: [],
    customFieldDefs: [],
    links: [],

    async load(boardId) {
      set({ boardId, loading: true, error: null });
      await fetchBoard(boardId);
    },

    async resync() {
      // same as load() but without the loading flag, so the board doesn't
      // flash a spinner on every reconnect
      const { boardId } = get();
      if (boardId) await fetchBoard(boardId);
    },

    clear() {
      const id = get().boardId;
      if (id) getSocket().emit("board:leave", id);
      set({
        boardId: null, board: null, starred: false, myAccess: null, error: null, filter: EMPTY_FILTER,
        lists: [], cards: [], labels: [], members: [], teamIds: [], customFieldDefs: [], links: [],
      });
    },

    async addList(name) {
      const { boardId } = get();
      if (!boardId) return;
      const { list } = await api.post<{ list: List }>(`/api/boards/${boardId}/lists`, { name });
      set((s) => (s.lists.some((l) => l.id === list.id) ? s : { lists: sortRank([...s.lists, list]) }));
    },

    async renameList(id, name) {
      set((s) => ({ lists: s.lists.map((l) => (l.id === id ? { ...l, name } : l)) }));
      await api.patch(`/api/lists/${id}`, { name });
    },

    async archiveList(id, archived) {
      set((s) => ({ lists: s.lists.map((l) => (l.id === id ? { ...l, archived } : l)) }));
      await api.patch(`/api/lists/${id}`, { archived });
    },

    moveList(id, beforeId, afterId) {
      const { lists } = get();
      const lo = afterId ? lists.find((l) => l.id === afterId)?.rank ?? null : null;
      const hi = beforeId ? lists.find((l) => l.id === beforeId)?.rank ?? null : null;
      let rank: string;
      if (lo !== null && lo === hi) {
        // tied neighbours (M9): no key fits between them. Sit on the tie for
        // now; the server re-ranks the board's lists and we adopt its answer.
        rank = lo;
      } else {
        try {
          rank = between(lo, hi);
        } catch {
          return;
        }
      }
      set((s) => ({ lists: sortRank(s.lists.map((l) => (l.id === id ? { ...l, rank } : l))) }));
      const seq = bumpSeq(id);
      api
        .patch<{ list: List }>(`/api/lists/${id}`, { move: { beforeId, afterId } })
        // M9: adopt the server's rank (our own echo is filtered out, so the
        // local guess could otherwise differ from the DB until reload)
        .then(({ list }) => {
          if (moveSeq.get(id) !== seq || !list) return; // a newer move of this list is in flight
          set((s) => ({ lists: sortRank(s.lists.map((l) => (l.id === id ? { ...l, rank: list.rank } : l))) }));
        })
        .catch(() => get().load(get().boardId!));
    },

    async addCard(listId, title, position = "bottom") {
      const { card } = await api.post<{ card: Card }>(`/api/lists/${listId}/cards`, { title, position });
      set((s) => (s.cards.some((c) => c.id === card.id) ? s : { cards: sortRank([...s.cards, card]) }));
    },

    moveCard(id, listId, beforeId, afterId) {
      get().moveCardLocal(id, listId, beforeId, afterId);
      const seq = bumpSeq(id);
      api
        .patch<{ card: Card }>(`/api/cards/${id}`, { move: { listId, beforeId, afterId } })
        // M9: adopt the server's rank + list, unless a newer move superseded this one
        .then(({ card }) => {
          if (moveSeq.get(id) !== seq || !card) return;
          set((s) => ({
            cards: sortRank(s.cards.map((c) => (c.id === id ? { ...c, listId: card.listId, rank: card.rank } : c))),
          }));
        })
        .catch(() => get().load(get().boardId!));
    },

    moveCardLocal(id, listId, beforeId, afterId) {
      const { cards } = get();
      const inList = cards.filter((c) => c.listId === listId && c.id !== id);
      const lo = afterId ? inList.find((c) => c.id === afterId)?.rank ?? null : null;
      const hi = beforeId ? inList.find((c) => c.id === beforeId)?.rank ?? null : null;
      let rank: string;
      if (lo !== null && lo === hi) {
        rank = lo; // tied neighbours (M9): the server re-ranks the list; see moveList
      } else {
        try {
          rank = between(lo, hi && (!lo || lo < hi) ? hi : null);
        } catch {
          rank = between(lo, null);
        }
      }
      set((s) => ({
        cards: sortRank(s.cards.map((c) => (c.id === id ? { ...c, listId, rank } : c))),
      }));
    },

    snapshotCards() {
      return get().cards;
    },
    restoreCards(cards) {
      set({ cards });
    },

    patchCard(id, patch) {
      set((s) => ({
        cards: sortRank(s.cards.map((c) => (c.id === id ? { ...c, ...patch } : c))),
      }));
    },
  };
});
