/**
 * Link-shared boards — a read-only, unauthenticated snapshot behind an
 * unguessable token. No member emails, no comments, no socket access;
 * the gate is the 128-bit token itself.
 */
import type { FastifyInstance } from "fastify";
import { asc, eq, inArray } from "drizzle-orm";
import { db, schema } from "../db/client.js";

export async function publicRoutes(app: FastifyInstance) {
  app.get("/api/public/boards/:token", async (req, reply) => {
    const { token } = req.params as { token: string };
    if (!/^[0-9a-f]{32}$/.test(token)) return reply.code(404).send({ error: "not found" });
    const [board] = await db
      .select()
      .from(schema.boards)
      .where(eq(schema.boards.shareToken, token));
    if (!board || board.archived) return reply.code(404).send({ error: "not found" });

    const [lists, cards, labels] = await Promise.all([
      db.select().from(schema.lists).where(eq(schema.lists.boardId, board.id)).orderBy(asc(schema.lists.rank)),
      db.select().from(schema.cards).where(eq(schema.cards.boardId, board.id)).orderBy(asc(schema.cards.rank)),
      db.select().from(schema.labels).where(eq(schema.labels.boardId, board.id)),
    ]);
    const cardIds = cards.map((c) => c.id);
    const cardLabels = cardIds.length
      ? await db.select().from(schema.cardLabels).where(inArray(schema.cardLabels.cardId, cardIds))
      : [];

    reply.header("Cache-Control", "no-store");
    return {
      board: { name: board.name, background: board.background },
      lists: lists
        .filter((l) => !l.archived)
        .map((l) => ({ id: l.id, name: l.name, rank: l.rank })),
      cards: cards
        .filter((c) => !c.archived)
        .map((c) => ({
          id: c.id, listId: c.listId, title: c.title, description: c.description,
          rank: c.rank, dueAt: c.dueAt, dueComplete: c.dueComplete,
          coverColor: c.coverColor,
          labelIds: cardLabels.filter((x) => x.cardId === c.id).map((x) => x.labelId),
        })),
      labels: labels.map((l) => ({ id: l.id, name: l.name, color: l.color })),
    };
  });
}
