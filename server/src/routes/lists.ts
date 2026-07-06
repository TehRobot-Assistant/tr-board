import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, asc, desc, eq } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { after, between } from "../lib/rank.js";
import { emitBoard } from "../sockets/index.js";
import { logActivity } from "../lib/activity.js";
import { originSocket, parseBody, requireBoard, uuidSchema } from "./helpers.js";
import { dispatchAutomation } from "../automation/engine.js";

const rankSchema = z.object({
  beforeId: uuidSchema.nullish(), // neighbour ids; server computes the rank
  afterId: uuidSchema.nullish(),
});

/** compute a rank between two sibling rows (same board/list scope) */
export async function rankBetween(
  table: typeof schema.lists | typeof schema.cards,
  scope: { col: any; id: string },
  beforeId: string | null | undefined,
  afterId: string | null | undefined,
): Promise<string> {
  const rankOf = async (id: string | null | undefined) => {
    if (!id) return null;
    const [row] = await db
      .select({ rank: table.rank })
      .from(table as any)
      .where(and(eq((table as any).id, id), eq(scope.col, scope.id)));
    return row?.rank ?? null;
  };
  let lo = await rankOf(afterId); // the row we land after
  let hi = await rankOf(beforeId); // the row we land before
  if (lo === null && hi === null) {
    // append to the end
    const [last] = await db
      .select({ rank: table.rank })
      .from(table as any)
      .where(eq(scope.col, scope.id))
      .orderBy(desc(table.rank))
      .limit(1);
    return after(last?.rank ?? null);
  }
  if (lo !== null && hi !== null && lo >= hi) hi = null; // stale neighbours — degrade gracefully
  return between(lo, hi);
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
    if (body.move) {
      patch.rank = await rankBetween(
        schema.lists,
        { col: schema.lists.boardId, id: existing.boardId },
        body.move.beforeId,
        body.move.afterId,
      );
    }
    const [list] = await db
      .update(schema.lists)
      .set(patch)
      .where(eq(schema.lists.id, id))
      .returning();
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
    await db.delete(schema.lists).where(eq(schema.lists.id, id));
    emitBoard(existing.boardId, "list.deleted", { listId: id }, originSocket(req));
    logActivity({ boardId: existing.boardId, userId: req.user.id, type: "list.deleted", data: { name: existing.name } });
    return { ok: true };
  });
}
