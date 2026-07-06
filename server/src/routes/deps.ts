/** Card dependencies — "this card blocks that card", same board only. */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, eq, or } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { emitBoard } from "../sockets/index.js";
import { logActivity } from "../lib/activity.js";
import { originSocket, parseBody, requireBoard, uuidSchema } from "./helpers.js";
import { loadCard } from "./cards.js";

export async function depsRoutes(app: FastifyInstance) {
  /** link: :id blocks :targetId (or the reverse with direction=blockedBy) */
  app.put("/api/cards/:id/links/:targetId", async (req, reply) => {
    const { id, targetId } = req.params as { id: string; targetId: string };
    const body = parseBody(
      z.object({ direction: z.enum(["blocks", "blockedBy"]).default("blocks") }),
      req,
      reply,
    );
    if (!body) return;
    const card = await loadCard(id);
    const target = await loadCard(targetId);
    if (!card || !target) return reply.code(404).send({ error: "not found" });
    if (card.boardId !== target.boardId) {
      return reply.code(400).send({ error: "dependencies must be on the same board" });
    }
    if (id === targetId) return reply.code(400).send({ error: "a card cannot block itself" });
    if (!(await requireBoard(req, reply, card.boardId, "write"))) return;

    const [blocker, blocked] = body.direction === "blocks" ? [id, targetId] : [targetId, id];
    // reject if the reverse link exists (would be a 2-cycle)
    const [reverse] = await db
      .select()
      .from(schema.cardLinks)
      .where(and(eq(schema.cardLinks.cardId, blocked), eq(schema.cardLinks.blocksCardId, blocker)));
    if (reverse) return reply.code(409).send({ error: "those cards already depend on each other the other way" });

    await db
      .insert(schema.cardLinks)
      .values({ cardId: blocker, blocksCardId: blocked })
      .onConflictDoNothing();
    emitBoard(card.boardId, "link.created", { cardId: blocker, blocksCardId: blocked }, originSocket(req));
    logActivity({
      boardId: card.boardId, cardId: blocked, userId: req.user.id,
      type: "card.blockedBy", data: { title: (blocker === id ? card : target).title },
    });
    return { ok: true };
  });

  app.delete("/api/cards/:id/links/:targetId", async (req, reply) => {
    const { id, targetId } = req.params as { id: string; targetId: string };
    if (!uuidSchema.safeParse(targetId).success) return reply.code(404).send({ error: "not found" });
    const card = await loadCard(id);
    if (!card) return reply.code(404).send({ error: "not found" });
    if (!(await requireBoard(req, reply, card.boardId, "write"))) return;
    await db
      .delete(schema.cardLinks)
      .where(
        or(
          and(eq(schema.cardLinks.cardId, id), eq(schema.cardLinks.blocksCardId, targetId)),
          and(eq(schema.cardLinks.cardId, targetId), eq(schema.cardLinks.blocksCardId, id)),
        ),
      );
    emitBoard(card.boardId, "link.deleted", { a: id, b: targetId }, originSocket(req));
    return { ok: true };
  });
}
