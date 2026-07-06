/**
 * Cross-board personal features (the Monday.com half of the pitch):
 *   /api/search   — boards + cards across everything the user can see
 *   /api/my-work  — every card + checklist item assigned to me, with due dates
 */
import type { FastifyInstance } from "fastify";
import { and, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { visibleBoardIds } from "../lib/perms.js";

/** all board ids this user can see, across every workspace they belong to */
async function allVisibleBoards(userId: string, isAdmin: boolean): Promise<Set<string>> {
  const wsIds = isAdmin
    ? (await db.select({ id: schema.workspaces.id }).from(schema.workspaces)).map((w) => w.id)
    : (
        await db
          .select({ id: schema.workspaceMembers.workspaceId })
          .from(schema.workspaceMembers)
          .where(eq(schema.workspaceMembers.userId, userId))
      ).map((w) => w.id);
  const out = new Set<string>();
  for (const wsId of wsIds) {
    for (const id of await visibleBoardIds(userId, wsId, isAdmin)) out.add(id);
  }
  // guest boards (member of board but not its workspace)
  const guestRows = await db
    .select({ boardId: schema.boardMembers.boardId })
    .from(schema.boardMembers)
    .where(eq(schema.boardMembers.userId, userId));
  for (const r of guestRows) out.add(r.boardId);
  return out;
}

export async function personalRoutes(app: FastifyInstance) {
  app.get("/api/search", async (req) => {
    const q = String((req.query as { q?: string }).q ?? "").trim();
    if (q.length < 2) return { boards: [], cards: [] };
    const visible = await allVisibleBoards(req.user.id, req.user.isAdmin);
    if (!visible.size) return { boards: [], cards: [] };
    const ids = [...visible];
    const pattern = `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;

    const [boards, cards] = await Promise.all([
      db
        .select({ id: schema.boards.id, name: schema.boards.name, background: schema.boards.background })
        .from(schema.boards)
        .where(and(inArray(schema.boards.id, ids), eq(schema.boards.archived, false), ilike(schema.boards.name, pattern)))
        .limit(8),
      db
        .select({
          id: schema.cards.id, title: schema.cards.title, boardId: schema.cards.boardId,
          dueAt: schema.cards.dueAt, dueComplete: schema.cards.dueComplete,
          boardName: schema.boards.name, listName: schema.lists.name,
        })
        .from(schema.cards)
        .innerJoin(schema.boards, eq(schema.boards.id, schema.cards.boardId))
        .innerJoin(schema.lists, eq(schema.lists.id, schema.cards.listId))
        .where(
          and(
            inArray(schema.cards.boardId, ids),
            eq(schema.cards.archived, false),
            or(ilike(schema.cards.title, pattern), ilike(schema.cards.description, pattern)),
          ),
        )
        .orderBy(sql`${schema.cards.dueAt} ASC NULLS LAST`)
        .limit(20),
    ]);
    return { boards, cards };
  });

  app.get("/api/my-work", async (req) => {
    const visible = await allVisibleBoards(req.user.id, req.user.isAdmin);
    if (!visible.size) return { cards: [], checklistItems: [] };
    const ids = [...visible];

    const cards = await db
      .select({
        id: schema.cards.id, title: schema.cards.title, boardId: schema.cards.boardId,
        dueAt: schema.cards.dueAt, dueComplete: schema.cards.dueComplete,
        boardName: schema.boards.name, listName: schema.lists.name,
        background: schema.boards.background,
      })
      .from(schema.cardMembers)
      .innerJoin(schema.cards, eq(schema.cards.id, schema.cardMembers.cardId))
      .innerJoin(schema.boards, eq(schema.boards.id, schema.cards.boardId))
      .innerJoin(schema.lists, eq(schema.lists.id, schema.cards.listId))
      .where(
        and(
          eq(schema.cardMembers.userId, req.user.id),
          eq(schema.cards.archived, false),
          inArray(schema.cards.boardId, ids),
        ),
      )
      .limit(500);

    const checklistItems = await db
      .select({
        id: schema.checklistItems.id, text: schema.checklistItems.text,
        done: schema.checklistItems.done, dueAt: schema.checklistItems.dueAt,
        cardId: schema.cards.id, cardTitle: schema.cards.title,
        boardId: schema.cards.boardId, boardName: schema.boards.name,
      })
      .from(schema.checklistItems)
      .innerJoin(schema.checklists, eq(schema.checklists.id, schema.checklistItems.checklistId))
      .innerJoin(schema.cards, eq(schema.cards.id, schema.checklists.cardId))
      .innerJoin(schema.boards, eq(schema.boards.id, schema.cards.boardId))
      .where(
        and(
          eq(schema.checklistItems.assigneeId, req.user.id),
          eq(schema.checklistItems.done, false),
          eq(schema.cards.archived, false),
          inArray(schema.cards.boardId, ids),
        ),
      )
      .limit(200);

    return { cards, checklistItems };
  });
}
