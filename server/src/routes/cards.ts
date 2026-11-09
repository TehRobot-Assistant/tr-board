import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, asc, desc, eq } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { after, before } from "../lib/rank.js";
import { emitBoard } from "../sockets/index.js";
import { logActivity } from "../lib/activity.js";
import { originSocket, parseBody, requireBoard, uuidSchema } from "./helpers.js";
import { rankBetween } from "./lists.js";
import { dispatchAutomation } from "../automation/engine.js";
import { announceMirrorsDeleted, mirrorSnapshots, mirrorsOf, propagateMirror } from "../lib/mirror.js";
import { boardAccess, userCanReadBoard } from "../lib/perms.js";
import { emitBoardEach } from "../sockets/index.js";
import { removeCardUploads } from "../lib/uploads.js";
import type { Reranked } from "./lists.js";
import { normaliseRule, reanchor, recurrenceInputSchema, type RecurrenceRule } from "../lib/recurrenceRule.js";
import { spawnNextOccurrence } from "../lib/recurrence.js";

/**
 * Stored title of every mirror row (M2). The real face comes from the
 * access-checked snapshot; the row's own title is visible to everyone on the
 * target board (and in search, exports, My Work), so it must say nothing
 * about the source.
 */
export const MIRROR_TITLE = "Mirrored card";

export async function loadCard(id: string) {
  if (!uuidSchema.safeParse(id).success) return null;
  const [card] = await db.select().from(schema.cards).where(eq(schema.cards.id, id));
  return card ?? null;
}

const isoDate = z
  .string()
  .datetime({ offset: true })
  .transform((s) => new Date(s));

export async function cardRoutes(app: FastifyInstance) {
  app.post("/api/lists/:listId/cards", async (req, reply) => {
    const { listId } = req.params as { listId: string };
    const body = parseBody(
      z.object({ title: z.string().trim().min(1).max(400), position: z.enum(["top", "bottom"]).default("bottom") }),
      req,
      reply,
    );
    if (!body) return;
    const [list] = uuidSchema.safeParse(listId).success
      ? await db.select().from(schema.lists).where(eq(schema.lists.id, listId))
      : [];
    if (!list) return reply.code(404).send({ error: "not found" });
    const access = await requireBoard(req, reply, list.boardId, "write");
    if (!access) return;

    const [edge] = await db
      .select({ rank: schema.cards.rank })
      .from(schema.cards)
      .where(eq(schema.cards.listId, listId))
      .orderBy(body.position === "top" ? asc(schema.cards.rank) : desc(schema.cards.rank))
      .limit(1);
    const rank =
      body.position === "top" ? before(edge?.rank ?? null) : after(edge?.rank ?? null);

    const [card] = await db
      .insert(schema.cards)
      .values({ boardId: list.boardId, listId, title: body.title, rank, createdBy: req.user.id })
      .returning();
    const payload = { ...card, labelIds: [], memberIds: [], fieldValues: {}, badges: { comments: 0, attachments: 0, checklist: null } };
    emitBoard(list.boardId, "card.created", { card: payload }, originSocket(req));
    logActivity({ boardId: list.boardId, cardId: card.id, userId: req.user.id, type: "card.created", data: { title: card.title, list: list.name } });
    dispatchAutomation(list.boardId, { type: "card_created", cardId: card.id, listId }, req.user.id);
    return { card: payload };
  });

  /** full card detail for the card modal */
  app.get("/api/cards/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const card = await loadCard(id);
    if (!card) return reply.code(404).send({ error: "not found" });
    const access = await requireBoard(req, reply, card.boardId, "read");
    if (!access) return;

    const [checklistRows, itemRows, commentRows, attachmentRows, labelRows, memberRows, valueRows, activityRows] =
      await Promise.all([
        db.select().from(schema.checklists).where(eq(schema.checklists.cardId, id)).orderBy(asc(schema.checklists.rank)),
        db
          .select({ item: schema.checklistItems })
          .from(schema.checklistItems)
          .innerJoin(schema.checklists, eq(schema.checklists.id, schema.checklistItems.checklistId))
          .where(eq(schema.checklists.cardId, id))
          .orderBy(asc(schema.checklistItems.rank)),
        db
          .select({
            id: schema.comments.id, body: schema.comments.body,
            createdAt: schema.comments.createdAt, updatedAt: schema.comments.updatedAt,
            userId: schema.comments.userId, userName: schema.users.name, avatarColor: schema.users.avatarColor,
          })
          .from(schema.comments)
          .leftJoin(schema.users, eq(schema.users.id, schema.comments.userId))
          .where(eq(schema.comments.cardId, id))
          .orderBy(desc(schema.comments.createdAt)),
        db.select().from(schema.attachments).where(eq(schema.attachments.cardId, id)).orderBy(desc(schema.attachments.createdAt)),
        db.select().from(schema.cardLabels).where(eq(schema.cardLabels.cardId, id)),
        db.select().from(schema.cardMembers).where(eq(schema.cardMembers.cardId, id)),
        db.select().from(schema.customFieldValues).where(eq(schema.customFieldValues.cardId, id)),
        db
          .select({
            id: schema.activityLog.id, type: schema.activityLog.type, data: schema.activityLog.data,
            createdAt: schema.activityLog.createdAt, userId: schema.activityLog.userId, userName: schema.users.name,
          })
          .from(schema.activityLog)
          .leftJoin(schema.users, eq(schema.users.id, schema.activityLog.userId))
          .where(eq(schema.activityLog.cardId, id))
          .orderBy(desc(schema.activityLog.createdAt))
          .limit(50),
      ]);

    return {
      card: {
        ...card,
        labelIds: labelRows.map((r) => r.labelId),
        memberIds: memberRows.map((r) => r.userId),
        fieldValues: Object.fromEntries(valueRows.map((v) => [v.fieldId, v.value])),
      },
      checklists: checklistRows.map((cl) => ({
        ...cl,
        items: itemRows.map((r) => r.item).filter((i) => i.checklistId === cl.id),
      })),
      comments: commentRows,
      attachments: attachmentRows,
      activity: activityRows,
    };
  });

  app.patch("/api/cards/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = parseBody(
      z.object({
        title: z.string().trim().min(1).max(400).optional(),
        description: z.string().max(50_000).optional(),
        startAt: isoDate.nullable().optional(),
        dueAt: isoDate.nullable().optional(),
        dueComplete: z.boolean().optional(),
        coverColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
        coverAttachmentId: uuidSchema.nullable().optional(),
        archived: z.boolean().optional(),
        recurrence: recurrenceInputSchema.nullable().optional(),
        move: z
          .object({
            listId: uuidSchema,
            beforeId: uuidSchema.nullish(),
            afterId: uuidSchema.nullish(),
          })
          .optional(),
      }),
      req,
      reply,
    );
    if (!body) return;
    const card = await loadCard(id);
    if (!card) return reply.code(404).send({ error: "not found" });
    const access = await requireBoard(req, reply, card.boardId, "write");
    if (!access) return;

    const { move, recurrence, ...rest } = body;
    const patch: Record<string, unknown> = { ...rest, updatedAt: new Date() };

    // Recurrence is anchored on the due date (lib/recurrenceRule.ts), so it
    // needs one; clearing the due date clears the rule, and editing the due
    // date re-anchors it (monthly "on the 31st" follows the new date).
    const dueAfter = rest.dueAt !== undefined ? rest.dueAt : card.dueAt;
    if (recurrence !== undefined) {
      if (recurrence === null) patch.recurrence = null;
      else {
        if (card.mirrorOfCardId) return reply.code(400).send({ error: "a mirror can't repeat" });
        if (!dueAfter) return reply.code(400).send({ error: "set a due date before making the card repeat" });
        if (recurrence.listId) {
          const [l] = await db
            .select({ id: schema.lists.id })
            .from(schema.lists)
            .where(and(eq(schema.lists.id, recurrence.listId), eq(schema.lists.boardId, card.boardId)));
          if (!l) return reply.code(400).send({ error: "that list is not on this board" });
        }
        patch.recurrence = normaliseRule(recurrence, dueAfter);
      }
    } else if (rest.dueAt !== undefined && card.recurrence) {
      patch.recurrence = rest.dueAt ? reanchor(card.recurrence as RecurrenceRule, rest.dueAt) : null;
    }

    let movedFrom: string | null = null;
    let reranked: Reranked = [];
    if (move) {
      const [target] = await db
        .select()
        .from(schema.lists)
        .where(and(eq(schema.lists.id, move.listId), eq(schema.lists.boardId, card.boardId)));
      if (!target) return reply.code(400).send({ error: "target list not on this board" });
      patch.listId = move.listId;
      const r = await rankBetween(
        schema.cards,
        { col: schema.cards.listId, id: move.listId },
        move.beforeId,
        move.afterId,
        id,
      );
      patch.rank = r.rank;
      reranked = r.reranked;
      if (move.listId !== card.listId) movedFrom = card.listId;
    }

    const [updated] = await db
      .update(schema.cards)
      .set(patch)
      .where(eq(schema.cards.id, id))
      .returning();
    // M9: sent to everyone including the mover (they can't derive these)
    if (reranked.length) {
      emitBoard(card.boardId, "cards.reranked", { boardId: card.boardId, listId: move!.listId, ranks: reranked });
    }
    emitBoard(card.boardId, "card.updated", { card: updated }, originSocket(req));
    if (rest.title !== undefined || rest.dueAt !== undefined || rest.dueComplete !== undefined || rest.archived !== undefined) {
      propagateMirror(id).catch(() => {});
    }

    if (movedFrom) {
      const names = await db
        .select({ id: schema.lists.id, name: schema.lists.name })
        .from(schema.lists)
        .where(eq(schema.lists.boardId, card.boardId));
      const nameOf = (lid: string) => names.find((l) => l.id === lid)?.name ?? "?";
      logActivity({
        boardId: card.boardId, cardId: id, userId: req.user.id, type: "card.moved",
        data: { title: updated.title, from: nameOf(movedFrom), to: nameOf(updated.listId) },
      });
      dispatchAutomation(card.boardId, { type: "card_moved", cardId: id, listId: updated.listId, fromListId: movedFrom }, req.user.id);
    }
    if (rest.dueAt !== undefined) {
      logActivity({
        boardId: card.boardId, cardId: id, userId: req.user.id,
        type: rest.dueAt ? "card.dueSet" : "card.dueCleared",
        data: { title: updated.title, dueAt: updated.dueAt?.toISOString() ?? null },
      });
    }
    let nextCardId: string | null = null;
    if (rest.dueComplete !== undefined && rest.dueComplete) {
      // awaited so the response (and the card.created event) already carry the next occurrence
      nextCardId = await spawnNextOccurrence(id, req.user.id);
      dispatchAutomation(card.boardId, { type: "due_completed", cardId: id, listId: updated.listId }, req.user.id);
    }
    if (rest.archived !== undefined) {
      logActivity({
        boardId: card.boardId, cardId: id, userId: req.user.id,
        type: rest.archived ? "card.archived" : "card.restored", data: { title: updated.title },
      });
    }
    return { card: nextCardId ? { ...updated, recurrence: null } : updated, nextCardId };
  });

  app.delete("/api/cards/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const card = await loadCard(id);
    if (!card) return reply.code(404).send({ error: "not found" });
    const access = await requireBoard(req, reply, card.boardId, "write");
    if (!access) return;
    const mirrors = await mirrorsOf([id]); // before the FK cascade removes them (L7)
    await db.delete(schema.cards).where(eq(schema.cards.id, id));
    emitBoard(card.boardId, "card.deleted", { cardId: id, listId: card.listId }, originSocket(req));
    logActivity({ boardId: card.boardId, userId: req.user.id, type: "card.deleted", data: { title: card.title } });
    announceMirrorsDeleted(mirrors);
    void removeCardUploads([id, ...mirrors.map((m) => m.id)]); // M6
    return { ok: true };
  });

  /**
   * Mirror this card onto another board's list. Needs read on the source and
   * write on the target; the mirror renders the source's face, live.
   */
  app.post("/api/cards/:id/mirror", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = parseBody(z.object({ listId: uuidSchema }), req, reply);
    if (!body) return;
    const source = await loadCard(id);
    if (!source) return reply.code(404).send({ error: "not found" });
    if (!(await requireBoard(req, reply, source.boardId, "read"))) return;
    if (source.mirrorOfCardId) return reply.code(400).send({ error: "cannot mirror a mirror" });

    const [targetList] = await db.select().from(schema.lists).where(eq(schema.lists.id, body.listId));
    if (!targetList) return reply.code(404).send({ error: "target list not found" });
    const target = await boardAccess(req.user.id, targetList.boardId, { isAdmin: req.user.isAdmin });
    if (!target?.canWrite) return reply.code(403).send({ error: "no write access to the target board" });
    if (targetList.boardId === source.boardId) {
      return reply.code(400).send({ error: "mirror onto a different board — same-board copies don't need a mirror" });
    }

    const [last] = await db
      .select({ rank: schema.cards.rank })
      .from(schema.cards)
      .where(eq(schema.cards.listId, targetList.id))
      .orderBy(desc(schema.cards.rank))
      .limit(1);
    const [mirror] = await db
      .insert(schema.cards)
      .values({
        boardId: targetList.boardId,
        listId: targetList.id,
        title: MIRROR_TITLE, // M2: see MIRROR_TITLE. The source can't vanish under a mirror now (FK cascade, L7)
        rank: after(last?.rank ?? null),
        mirrorOfCardId: source.id,
        createdBy: req.user.id,
      })
      .returning();
    const base = {
      ...mirror,
      labelIds: [], memberIds: [], fieldValues: {},
      badges: { comments: 0, attachments: 0, checklist: null },
    };
    const faceFor = async (u: { id: string; isAdmin: boolean }) =>
      (await mirrorSnapshots([source.id], u)).get(source.id) ?? null;
    // M2: per viewer: target-board members who can't read the source get a placeholder
    void emitBoardEach(
      targetList.boardId,
      "card.created",
      async (u) => ({ card: { ...base, mirror: await faceFor(u) } }),
      originSocket(req),
    );
    // The activity log is shown to the whole target board, so it names neither
    // the source card nor its board.
    logActivity({
      boardId: targetList.boardId, cardId: mirror.id, userId: req.user.id,
      type: "card.mirrored", data: { title: MIRROR_TITLE },
    });
    return { card: { ...base, mirror: await faceFor(req.user) } };
  });

  /* --------------------------------------------------- members on a card */

  app.put("/api/cards/:id/members/:userId", async (req, reply) => {
    const { id, userId } = req.params as { id: string; userId: string };
    const card = await loadCard(id);
    if (!card) return reply.code(404).send({ error: "not found" });
    const access = await requireBoard(req, reply, card.boardId, "write");
    if (!access) return;
    if (!uuidSchema.safeParse(userId).success) return reply.code(404).send({ error: "not found" });
    // M8: assignees must be able to read the board. Anyone could be put on a
    // card (and then got its title via notify); an unknown id was a 500.
    if (!(await userCanReadBoard(userId, card.boardId))) {
      return reply.code(400).send({ error: "that user can't see this board" });
    }
    await db
      .insert(schema.cardMembers)
      .values({ cardId: id, userId })
      .onConflictDoNothing();
    emitBoard(card.boardId, "card.memberAdded", { cardId: id, userId }, originSocket(req));
    dispatchAutomation(card.boardId, { type: "member_assigned", cardId: id, listId: card.listId, userId }, req.user.id);
    return { ok: true };
  });

  app.delete("/api/cards/:id/members/:userId", async (req, reply) => {
    const { id, userId } = req.params as { id: string; userId: string };
    const card = await loadCard(id);
    if (!card) return reply.code(404).send({ error: "not found" });
    const access = await requireBoard(req, reply, card.boardId, "write");
    if (!access) return;
    if (!uuidSchema.safeParse(userId).success) return reply.code(404).send({ error: "not found" }); // L2
    await db
      .delete(schema.cardMembers)
      .where(and(eq(schema.cardMembers.cardId, id), eq(schema.cardMembers.userId, userId)));
    emitBoard(card.boardId, "card.memberRemoved", { cardId: id, userId }, originSocket(req));
    return { ok: true };
  });

  /* ---------------------------------------------------- labels on a card */

  app.put("/api/cards/:id/labels/:labelId", async (req, reply) => {
    const { id, labelId } = req.params as { id: string; labelId: string };
    const card = await loadCard(id);
    if (!card) return reply.code(404).send({ error: "not found" });
    const access = await requireBoard(req, reply, card.boardId, "write");
    if (!access) return;
    if (!uuidSchema.safeParse(labelId).success) return reply.code(404).send({ error: "not found" });
    const [label] = await db
      .select()
      .from(schema.labels)
      .where(and(eq(schema.labels.id, labelId), eq(schema.labels.boardId, card.boardId)));
    if (!label) return reply.code(404).send({ error: "label not on this board" });
    await db.insert(schema.cardLabels).values({ cardId: id, labelId }).onConflictDoNothing();
    emitBoard(card.boardId, "card.labelAdded", { cardId: id, labelId }, originSocket(req));
    dispatchAutomation(card.boardId, { type: "label_added", cardId: id, listId: card.listId, labelId }, req.user.id);
    propagateMirror(id).catch(() => {});
    return { ok: true };
  });

  app.delete("/api/cards/:id/labels/:labelId", async (req, reply) => {
    const { id, labelId } = req.params as { id: string; labelId: string };
    const card = await loadCard(id);
    if (!card) return reply.code(404).send({ error: "not found" });
    const access = await requireBoard(req, reply, card.boardId, "write");
    if (!access) return;
    if (!uuidSchema.safeParse(labelId).success) return reply.code(404).send({ error: "not found" }); // L2
    await db
      .delete(schema.cardLabels)
      .where(and(eq(schema.cardLabels.cardId, id), eq(schema.cardLabels.labelId, labelId)));
    emitBoard(card.boardId, "card.labelRemoved", { cardId: id, labelId }, originSocket(req));
    propagateMirror(id).catch(() => {});
    return { ok: true };
  });
}
