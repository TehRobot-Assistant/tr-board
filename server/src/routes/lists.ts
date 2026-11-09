import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, asc, desc, eq } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { after, between, evenRanks } from "../lib/rank.js";
import { emitBoard } from "../sockets/index.js";
import { logActivity } from "../lib/activity.js";
import { originSocket, parseBody, requireBoard, uuidSchema } from "./helpers.js";
import { dispatchAutomation } from "../automation/engine.js";
import { announceMirrorsDeleted, mirrorsOf } from "../lib/mirror.js";
import { removeCardUploads } from "../lib/uploads.js";

const rankSchema = z.object({
  beforeId: uuidSchema.nullish(), // neighbour ids; server computes the rank
  afterId: uuidSchema.nullish(),
});

export type Reranked = Array<{ id: string; rank: string }>;

/**
 * Compute a rank between two sibling rows (same board/list scope).
 *
 * M9: two users dropping into the same gap at the same moment get identical
 * ranks (there is deliberately no unique constraint: it would turn the race
 * into a failed drop). Ties are shown in (rank, id) order everywhere, and the
 * first later drop *between* a tied pair finds lo == hi. That used to fall
 * back to "after lo", which could land the card below later siblings. Now the
 * scope is re-ranked evenly (in its current rank, id order) and the drop is
 * placed properly; `reranked` lists the rows whose rank changed so the caller
 * can broadcast them (other clients can't derive them).
 */
export async function rankBetween(
  table: typeof schema.lists | typeof schema.cards,
  scope: { col: any; id: string },
  beforeId: string | null | undefined,
  afterId: string | null | undefined,
  movingId?: string,
): Promise<{ rank: string; reranked: Reranked }> {
  const t = table as any;
  const rankOf = async (id: string | null | undefined) => {
    if (!id) return null;
    const [row] = await db
      .select({ rank: table.rank })
      .from(t)
      .where(and(eq(t.id, id), eq(scope.col, scope.id)));
    return row?.rank ?? null;
  };
  let lo = await rankOf(afterId); // the row we land after
  let hi = await rankOf(beforeId); // the row we land before
  if (lo === null && hi === null) {
    // append to the end
    const [last] = await db
      .select({ rank: table.rank })
      .from(t)
      .where(eq(scope.col, scope.id))
      .orderBy(desc(table.rank), desc(t.id))
      .limit(1);
    return { rank: after(last?.rank ?? null), reranked: [] };
  }
  let reranked: Reranked = [];
  if (lo !== null && hi !== null && lo === hi) {
    reranked = await rebalance(table, scope, movingId);
    const fresh = new Map(reranked.map((r) => [r.id, r.rank]));
    lo = fresh.get(afterId!) ?? lo;
    hi = fresh.get(beforeId!) ?? hi;
  }
  // stale or inverted neighbours (the client's view was out of date): degrade gracefully
  if (lo !== null && hi !== null && lo >= hi) hi = null;
  return { rank: between(lo, hi), reranked };
}

/** evenly re-rank every row in scope except the one being moved, keeping (rank, id) order */
async function rebalance(
  table: typeof schema.lists | typeof schema.cards,
  scope: { col: any; id: string },
  movingId?: string,
): Promise<Reranked> {
  const t = table as any;
  return db.transaction(async (tx) => {
    const rows = (
      await tx
        .select({ id: t.id, rank: table.rank })
        .from(t)
        .where(eq(scope.col, scope.id))
        .orderBy(asc(table.rank), asc(t.id))
        .for("update")
    ).filter((r: { id: string }) => r.id !== movingId) as Array<{ id: string; rank: string }>;
    const ranks = evenRanks(rows.length);
    const changed: Reranked = [];
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].rank === ranks[i]) continue;
      await tx.update(t).set({ rank: ranks[i] }).where(eq(t.id, rows[i].id));
      changed.push({ id: rows[i].id, rank: ranks[i] });
    }
    return changed;
  });
}

export async function listRoutes(app: FastifyInstance) {
  app.post("/api/boards/:boardId/lists", async (req, reply) => {
    const { boardId } = req.params as { boardId: string };
    const body = parseBody(z.object({ name: z.string().trim().min(1).max(120) }), req, reply);
    if (!body) return;
    const access = await requireBoard(req, reply, boardId, "write");
    if (!access) return;

    const [last] = await db
      .select({ rank: schema.lists.rank })
      .from(schema.lists)
      .where(eq(schema.lists.boardId, boardId))
      .orderBy(desc(schema.lists.rank))
      .limit(1);
    const [list] = await db
      .insert(schema.lists)
      .values({ boardId, name: body.name, rank: after(last?.rank ?? null) })
      .returning();
    emitBoard(boardId, "list.created", { list }, originSocket(req));
    logActivity({ boardId, userId: req.user.id, type: "list.created", data: { name: list.name } });
    return { list };
  });

  app.patch("/api/lists/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = parseBody(
      z.object({
        name: z.string().trim().min(1).max(120).optional(),
        archived: z.boolean().optional(),
        move: rankSchema.optional(),
      }),
      req,
      reply,
    );
    if (!body) return;
    const [existing] = uuidSchema.safeParse(id).success
      ? await db.select().from(schema.lists).where(eq(schema.lists.id, id))
      : [];
    if (!existing) return reply.code(404).send({ error: "not found" });
    const access = await requireBoard(req, reply, existing.boardId, "write");
    if (!access) return;

    const patch: Partial<typeof schema.lists.$inferInsert> = {};
    if (body.name !== undefined) patch.name = body.name;
    if (body.archived !== undefined) patch.archived = body.archived;
    let reranked: Reranked = [];
    if (body.move) {
      const r = await rankBetween(
        schema.lists,
        { col: schema.lists.boardId, id: existing.boardId },
        body.move.beforeId,
        body.move.afterId,
        id,
      );
      patch.rank = r.rank;
      reranked = r.reranked;
    }
    const [list] = await db
      .update(schema.lists)
      .set(patch)
      .where(eq(schema.lists.id, id))
      .returning();
    // to everyone, the mover included: nobody can work these ranks out locally
    if (reranked.length) emitBoard(existing.boardId, "lists.reranked", { boardId: existing.boardId, ranks: reranked });
    emitBoard(existing.boardId, "list.updated", { list }, originSocket(req));
    if (body.archived !== undefined) {
      logActivity({
        boardId: existing.boardId, userId: req.user.id,
        type: body.archived ? "list.archived" : "list.restored", data: { name: list.name },
      });
    }
    return { list };
  });

  app.delete("/api/lists/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const [existing] = uuidSchema.safeParse(id).success
      ? await db.select().from(schema.lists).where(eq(schema.lists.id, id))
      : [];
    if (!existing) return reply.code(404).send({ error: "not found" });
    const access = await requireBoard(req, reply, existing.boardId, "write");
    if (!access) return;
    // collect before the cascade: the cards' upload folders (M6) and their
    // mirrors on other boards (L7 FK cascade), which need a card.deleted there
    const cardIds = (
      await db.select({ id: schema.cards.id }).from(schema.cards).where(eq(schema.cards.listId, id))
    ).map((c) => c.id);
    const mirrors = await mirrorsOf(cardIds);
    await db.delete(schema.lists).where(eq(schema.lists.id, id));
    void removeCardUploads([...cardIds, ...mirrors.map((m) => m.id)]);
    announceMirrorsDeleted(mirrors);
    emitBoard(existing.boardId, "list.deleted", { listId: id }, originSocket(req));
    logActivity({ boardId: existing.boardId, userId: req.user.id, type: "list.deleted", data: { name: existing.name } });
    return { ok: true };
  });
}
