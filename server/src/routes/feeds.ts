/**
 * Read-only iCal feeds (one-way, like Wekan/Kanboard): subscribe once in a
 * phone/desktop calendar and due dates show up with the calendar's own alerts.
 *
 *   GET  /api/me/feeds                      URLs for the account settings page
 *   POST /api/me/feeds/token                create / regenerate (old URLs stop at once)
 *   DELETE /api/me/feeds/token              turn feeds off
 *   GET  /api/feed/:token/my.ics            cards + checklist items assigned to me
 *   GET  /api/feed/:token/boards/:id.ics    one board's dated cards + checklist items
 *
 * Calendar apps can't send a cookie, so the token in the URL is the
 * credential. It only identifies the user: what they may see is resolved
 * through perms.ts on every fetch, so losing a board removes its events on the
 * next refresh and a board you can't read is a 404, same as everywhere else.
 */
import crypto from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, eq, gte, inArray, isNull, or, sql } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { mustEnrol2fa } from "../lib/auth.js";
import { allVisibleBoards, boardAccess } from "../lib/perms.js";
import { buildCalendar, type IcsEvent } from "../lib/ical.js";
import { uuidSchema } from "./helpers.js";

const TOKEN_RE = /^[0-9a-f]{64}$/;
/**
 * Events older than this are left out, and a feed holds at most MAX_EVENTS:
 * calendar apps re-download the whole file every refresh, and years of done
 * cards would make each refresh slower for nothing.
 */
const PAST_DAYS = 180;
const MAX_EVENTS = 2000;

const feedPaths = (token: string) => ({
  my: `/api/feed/${token}/my.ics`,
  board: (id: string) => `/api/feed/${token}/boards/${id}.ics`,
});

const notFound = (reply: FastifyReply) => reply.code(404).send({ error: "not found" });

/** the feed owner, or null (unknown token, or an account that must enrol 2FA first) */
async function feedOwner(token: string) {
  if (!TOKEN_RE.test(token)) return null;
  const [u] = await db
    .select({ id: schema.users.id, isAdmin: schema.users.isAdmin, totpEnabledAt: schema.users.totpEnabledAt })
    .from(schema.users)
    .where(eq(schema.users.feedToken, token));
  if (!u) return null;
  if (await mustEnrol2fa({ totpEnabled: !!u.totpEnabledAt })) return null;
  return u;
}

type CardRow = {
  id: string; title: string; boardId: string; boardName: string; listName: string;
  startAt: Date | null; dueAt: Date | null; dueComplete: boolean; updatedAt: Date;
};
type ItemRow = {
  id: string; text: string; dueAt: Date | null; cardId: string; cardTitle: string;
  boardId: string; boardName: string;
};

function origin(req: FastifyRequest): string {
  // Host is client-supplied, but it only shapes the links in this response
  // to this client; nothing is stored or sent to anyone else.
  return `${req.protocol}://${req.host}`;
}

function cardEvents(rows: CardRow[], base: string): IcsEvent[] {
  const out: IcsEvent[] = [];
  for (const c of rows) {
    const url = `${base}/b/${c.boardId}/c/${c.id}`;
    const description = `${c.boardName} · ${c.listName}\n${url}`;
    const common = { description, url, lastModified: c.updatedAt, completed: c.dueComplete };
    if (c.dueAt && c.startAt && c.startAt < c.dueAt) {
      // start + due: one event spanning the work, ending at the deadline
      out.push({ uid: `card-${c.id}@trboard`, summary: c.title, start: c.startAt, end: c.dueAt, ...common });
    } else if (c.dueAt) {
      out.push({ uid: `card-${c.id}@trboard`, summary: c.title, start: c.dueAt, ...common });
    } else if (c.startAt) {
      out.push({ uid: `card-${c.id}-start@trboard`, summary: `Start: ${c.title}`, start: c.startAt, ...common });
    }
  }
  return out;
}

function itemEvents(rows: ItemRow[], base: string): IcsEvent[] {
  return rows
    .filter((i) => i.dueAt)
    .map((i) => ({
      uid: `item-${i.id}@trboard`,
      summary: `${i.text} (${i.cardTitle})`,
      start: i.dueAt!,
      description: `Checklist item · ${i.boardName}\n${base}/b/${i.boardId}/c/${i.cardId}`,
      url: `${base}/b/${i.boardId}/c/${i.cardId}`,
    }));
}

const cardCols = {
  id: schema.cards.id, title: schema.cards.title, boardId: schema.cards.boardId,
  boardName: schema.boards.name, listName: schema.lists.name,
  startAt: schema.cards.startAt, dueAt: schema.cards.dueAt,
  dueComplete: schema.cards.dueComplete, updatedAt: schema.cards.updatedAt,
};
const itemCols = {
  id: schema.checklistItems.id, text: schema.checklistItems.text, dueAt: schema.checklistItems.dueAt,
  cardId: schema.cards.id, cardTitle: schema.cards.title,
  boardId: schema.cards.boardId, boardName: schema.boards.name,
};

/** open card on an open list of an open board, not a mirror (its row title is a placeholder, M2) */
const liveCard = and(
  eq(schema.cards.archived, false),
  eq(schema.lists.archived, false),
  eq(schema.boards.archived, false),
  isNull(schema.cards.mirrorOfCardId),
);

function sendIcs(reply: FastifyReply, name: string, events: IcsEvent[]) {
  reply
    .header("Content-Type", "text/calendar; charset=utf-8")
    // no caching anywhere: a regenerated token or lost access must take effect on the next fetch
    .header("Cache-Control", "no-store")
    .header("Content-Disposition", 'inline; filename="trboard.ics"');
  return reply.send(buildCalendar(name, events.slice(0, MAX_EVENTS)));
}

export async function feedRoutes(app: FastifyInstance) {
  app.get("/api/feed/:token/my.ics", async (req, reply) => {
    const { token } = req.params as { token: string };
    const owner = await feedOwner(token);
    if (!owner) return notFound(reply);
    const visible = [...(await allVisibleBoards(owner.id, owner.isAdmin))];
    const since = new Date(Date.now() - PAST_DAYS * 86400_000);
    const base = origin(req);
    if (!visible.length) return sendIcs(reply, "TR Board: my cards", []);

    const cards = await db
      .select(cardCols)
      .from(schema.cardMembers)
      .innerJoin(schema.cards, eq(schema.cards.id, schema.cardMembers.cardId))
      .innerJoin(schema.lists, eq(schema.lists.id, schema.cards.listId))
      .innerJoin(schema.boards, eq(schema.boards.id, schema.cards.boardId))
      .where(
        and(
          eq(schema.cardMembers.userId, owner.id),
          inArray(schema.cards.boardId, visible),
          liveCard,
          or(gte(schema.cards.dueAt, since), gte(schema.cards.startAt, since)),
        ),
      )
      .limit(MAX_EVENTS);
    const items = await db
      .select(itemCols)
      .from(schema.checklistItems)
      .innerJoin(schema.checklists, eq(schema.checklists.id, schema.checklistItems.checklistId))
      .innerJoin(schema.cards, eq(schema.cards.id, schema.checklists.cardId))
      .innerJoin(schema.lists, eq(schema.lists.id, schema.cards.listId))
      .innerJoin(schema.boards, eq(schema.boards.id, schema.cards.boardId))
      .where(
        and(
          eq(schema.checklistItems.assigneeId, owner.id),
          eq(schema.checklistItems.done, false),
          inArray(schema.cards.boardId, visible),
          liveCard,
          gte(schema.checklistItems.dueAt, since),
        ),
      )
      .limit(MAX_EVENTS);
    return sendIcs(reply, "TR Board: my cards", [...cardEvents(cards, base), ...itemEvents(items, base)]);
  });

  app.get("/api/feed/:token/boards/:file", async (req, reply) => {
    const { token, file } = req.params as { token: string; file: string };
    const boardId = file.endsWith(".ics") ? file.slice(0, -4) : file;
    if (!uuidSchema.safeParse(boardId).success) return notFound(reply);
    const owner = await feedOwner(token);
    if (!owner) return notFound(reply);
    const access = await boardAccess(owner.id, boardId, { isAdmin: owner.isAdmin });
    if (!access?.canRead || access.board.archived) return notFound(reply);
    const since = new Date(Date.now() - PAST_DAYS * 86400_000);
    const base = origin(req);

    const cards = await db
      .select(cardCols)
      .from(schema.cards)
      .innerJoin(schema.lists, eq(schema.lists.id, schema.cards.listId))
      .innerJoin(schema.boards, eq(schema.boards.id, schema.cards.boardId))
      .where(and(eq(schema.cards.boardId, boardId), liveCard, or(gte(schema.cards.dueAt, since), gte(schema.cards.startAt, since))))
      .limit(MAX_EVENTS);
    const items = await db
      .select(itemCols)
      .from(schema.checklistItems)
      .innerJoin(schema.checklists, eq(schema.checklists.id, schema.checklistItems.checklistId))
      .innerJoin(schema.cards, eq(schema.cards.id, schema.checklists.cardId))
      .innerJoin(schema.lists, eq(schema.lists.id, schema.cards.listId))
      .innerJoin(schema.boards, eq(schema.boards.id, schema.cards.boardId))
      .where(and(eq(schema.cards.boardId, boardId), eq(schema.checklistItems.done, false), liveCard, gte(schema.checklistItems.dueAt, since)))
      .limit(MAX_EVENTS);
    return sendIcs(reply, `TR Board: ${access.board.name}`, [...cardEvents(cards, base), ...itemEvents(items, base)]);
  });
}

/** session-authenticated management, registered inside the secured scope */
export async function feedSettingsRoutes(app: FastifyInstance) {
  app.get("/api/me/feeds", async (req) => {
    const [u] = await db.select({ token: schema.users.feedToken }).from(schema.users).where(eq(schema.users.id, req.user.id));
    const visible = [...(await allVisibleBoards(req.user.id, req.user.isAdmin))];
    const boards = visible.length
      ? await db
          .select({ id: schema.boards.id, name: schema.boards.name, workspaceName: schema.workspaces.name })
          .from(schema.boards)
          .innerJoin(schema.workspaces, eq(schema.workspaces.id, schema.boards.workspaceId))
          .where(and(inArray(schema.boards.id, visible), eq(schema.boards.archived, false)))
          .orderBy(sql`${schema.workspaces.name}, ${schema.boards.name}`)
      : [];
    if (!u?.token) return { enabled: false, myUrl: null, boards: boards.map((b) => ({ ...b, url: null })) };
    const p = feedPaths(u.token);
    return { enabled: true, myUrl: p.my, boards: boards.map((b) => ({ ...b, url: p.board(b.id) })) };
  });

  app.post("/api/me/feeds/token", async (req) => {
    const token = crypto.randomBytes(32).toString("hex");
    await db.update(schema.users).set({ feedToken: token }).where(eq(schema.users.id, req.user.id));
    return { enabled: true, myUrl: feedPaths(token).my };
  });

  app.delete("/api/me/feeds/token", async (req) => {
    await db.update(schema.users).set({ feedToken: null }).where(eq(schema.users.id, req.user.id));
    return { enabled: false };
  });
}
