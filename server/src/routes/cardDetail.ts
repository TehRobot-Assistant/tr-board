/**
 * Labels (board-level), checklists + items, comments, attachments.
 * All broadcast granular socket events; card badge counts are refreshed
 * client-side from these same events.
 */
import fs from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { after } from "../lib/rank.js";
import { env } from "../lib/env.js";
import { emitBoard } from "../sockets/index.js";
import { logActivity } from "../lib/activity.js";
import { originSocket, parseBody, requireBoard, uuidSchema } from "./helpers.js";
import { loadCard } from "./cards.js";
import { dispatchAutomation } from "../automation/engine.js";
import { userCanReadBoard } from "../lib/perms.js";

const LABEL_COLORS = [
  "#61bd4f", "#f2d600", "#ff9f1a", "#eb5a46", "#c377e0",
  "#0079bf", "#00c2e0", "#51e898", "#ff78cb", "#344563",
];

export async function cardDetailRoutes(app: FastifyInstance) {
  /* -------------------------------------------------------------- labels */

  app.post("/api/boards/:boardId/labels", async (req, reply) => {
    const { boardId } = req.params as { boardId: string };
    const body = parseBody(
      z.object({
        name: z.string().trim().max(60).default(""),
        color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default(LABEL_COLORS[0]),
      }),
      req,
      reply,
    );
    if (!body) return;
    if (!(await requireBoard(req, reply, boardId, "write"))) return;
    const [label] = await db
      .insert(schema.labels)
      .values({ boardId, name: body.name, color: body.color })
      .returning();
    emitBoard(boardId, "label.created", { label }, originSocket(req));
    return { label };
  });

  app.patch("/api/labels/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = parseBody(
      z.object({
        name: z.string().trim().max(60).optional(),
        color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
      }),
      req,
      reply,
    );
    if (!body) return;
    const [label] = uuidSchema.safeParse(id).success
      ? await db.select().from(schema.labels).where(eq(schema.labels.id, id))
      : [];
    if (!label) return reply.code(404).send({ error: "not found" });
    if (!(await requireBoard(req, reply, label.boardId, "write"))) return;
    const [updated] = await db
      .update(schema.labels)
      .set(body)
      .where(eq(schema.labels.id, id))
      .returning();
    emitBoard(label.boardId, "label.updated", { label: updated }, originSocket(req));
    return { label: updated };
  });

  app.delete("/api/labels/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const [label] = uuidSchema.safeParse(id).success
      ? await db.select().from(schema.labels).where(eq(schema.labels.id, id))
      : [];
    if (!label) return reply.code(404).send({ error: "not found" });
    if (!(await requireBoard(req, reply, label.boardId, "write"))) return;
    await db.delete(schema.labels).where(eq(schema.labels.id, id));
    emitBoard(label.boardId, "label.deleted", { labelId: id }, originSocket(req));
    return { ok: true };
  });

  /* ---------------------------------------------------------- checklists */

  app.post("/api/cards/:cardId/checklists", async (req, reply) => {
    const { cardId } = req.params as { cardId: string };
    const body = parseBody(z.object({ name: z.string().trim().min(1).max(120) }), req, reply);
    if (!body) return;
    const card = await loadCard(cardId);
    if (!card) return reply.code(404).send({ error: "not found" });
    if (!(await requireBoard(req, reply, card.boardId, "write"))) return;
    const [last] = await db
      .select({ rank: schema.checklists.rank })
      .from(schema.checklists)
      .where(eq(schema.checklists.cardId, cardId))
      .orderBy(desc(schema.checklists.rank))
      .limit(1);
    const [checklist] = await db
      .insert(schema.checklists)
      .values({ cardId, name: body.name, rank: after(last?.rank ?? null) })
      .returning();
    emitBoard(card.boardId, "checklist.created", { cardId, checklist: { ...checklist, items: [] } }, originSocket(req));
    return { checklist: { ...checklist, items: [] } };
  });

  app.patch("/api/checklists/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = parseBody(z.object({ name: z.string().trim().min(1).max(120) }), req, reply);
    if (!body) return;
    const ctx = await checklistCtx(id);
    if (!ctx) return reply.code(404).send({ error: "not found" });
    if (!(await requireBoard(req, reply, ctx.card.boardId, "write"))) return;
    const [checklist] = await db
      .update(schema.checklists)
      .set({ name: body.name })
      .where(eq(schema.checklists.id, id))
      .returning();
    emitBoard(ctx.card.boardId, "checklist.updated", { cardId: ctx.card.id, checklist }, originSocket(req));
    return { checklist };
  });

  app.delete("/api/checklists/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const ctx = await checklistCtx(id);
    if (!ctx) return reply.code(404).send({ error: "not found" });
    if (!(await requireBoard(req, reply, ctx.card.boardId, "write"))) return;
    await db.delete(schema.checklists).where(eq(schema.checklists.id, id));
    emitBoard(ctx.card.boardId, "checklist.deleted", { cardId: ctx.card.id, checklistId: id }, originSocket(req));
    return { ok: true };
  });

  app.post("/api/checklists/:id/items", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = parseBody(z.object({ text: z.string().trim().min(1).max(400) }), req, reply);
    if (!body) return;
    const ctx = await checklistCtx(id);
    if (!ctx) return reply.code(404).send({ error: "not found" });
    if (!(await requireBoard(req, reply, ctx.card.boardId, "write"))) return;
    const [last] = await db
      .select({ rank: schema.checklistItems.rank })
      .from(schema.checklistItems)
      .where(eq(schema.checklistItems.checklistId, id))
      .orderBy(desc(schema.checklistItems.rank))
      .limit(1);
    const [item] = await db
      .insert(schema.checklistItems)
      .values({ checklistId: id, text: body.text, rank: after(last?.rank ?? null) })
      .returning();
    emitBoard(ctx.card.boardId, "checklistItem.created", { cardId: ctx.card.id, item }, originSocket(req));
    return { item };
  });

  app.patch("/api/checklist-items/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = parseBody(
      z.object({
        text: z.string().trim().min(1).max(400).optional(),
        done: z.boolean().optional(),
        assigneeId: uuidSchema.nullable().optional(),
        dueAt: z.string().datetime({ offset: true }).transform((s) => new Date(s)).nullable().optional(),
      }),
      req,
      reply,
    );
    if (!body) return;
    const [item] = uuidSchema.safeParse(id).success
      ? await db.select().from(schema.checklistItems).where(eq(schema.checklistItems.id, id))
      : [];
    if (!item) return reply.code(404).send({ error: "not found" });
    const ctx = await checklistCtx(item.checklistId);
    if (!ctx) return reply.code(404).send({ error: "not found" });
    if (!(await requireBoard(req, reply, ctx.card.boardId, "write"))) return;
    // M8: an assignee must be able to see the board (and must exist: an
    // unknown id used to surface as a 500 from the FK)
    if (body.assigneeId && !(await userCanReadBoard(body.assigneeId, ctx.card.boardId))) {
      return reply.code(400).send({ error: "that user can't see this board" });
    }

    const [updated] = await db
      .update(schema.checklistItems)
      .set(body)
      .where(eq(schema.checklistItems.id, id))
      .returning();
    // prevDone (L6): clients adjusted the checklist badge by +/-1 on EVERY
    // item update, so a text-only edit drifted the "done" count
    emitBoard(
      ctx.card.boardId,
      "checklistItem.updated",
      { cardId: ctx.card.id, item: updated, prevDone: item.done },
      originSocket(req),
    );

    // checklist fully completed? → automation trigger
    if (body.done === true) {
      const remaining = await db.$count(
        schema.checklistItems,
        and(eq(schema.checklistItems.checklistId, item.checklistId), eq(schema.checklistItems.done, false)),
      );
      if (remaining === 0) {
        dispatchAutomation(
          ctx.card.boardId,
          { type: "checklist_completed", cardId: ctx.card.id, listId: ctx.card.listId, checklistId: item.checklistId },
          req.user.id,
        );
      }
    }
    return { item: updated };
  });

  app.delete("/api/checklist-items/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const [item] = uuidSchema.safeParse(id).success
      ? await db.select().from(schema.checklistItems).where(eq(schema.checklistItems.id, id))
      : [];
    if (!item) return reply.code(404).send({ error: "not found" });
    const ctx = await checklistCtx(item.checklistId);
    if (!ctx) return reply.code(404).send({ error: "not found" });
    if (!(await requireBoard(req, reply, ctx.card.boardId, "write"))) return;
    await db.delete(schema.checklistItems).where(eq(schema.checklistItems.id, id));
    emitBoard(ctx.card.boardId, "checklistItem.deleted", { cardId: ctx.card.id, itemId: id, checklistId: item.checklistId }, originSocket(req));
    return { ok: true };
  });

  /* ------------------------------------------------------------ comments */

  app.post("/api/cards/:cardId/comments", async (req, reply) => {
    const { cardId } = req.params as { cardId: string };
    const body = parseBody(z.object({ body: z.string().trim().min(1).max(20_000) }), req, reply);
    if (!body) return;
    const card = await loadCard(cardId);
    if (!card) return reply.code(404).send({ error: "not found" });
    if (!(await requireBoard(req, reply, card.boardId, "write"))) return;
    const [comment] = await db
      .insert(schema.comments)
      .values({ cardId, userId: req.user.id, body: body.body })
      .returning();
    const payload = {
      ...comment,
      userName: req.user.name,
      avatarColor: req.user.avatarColor,
    };
    emitBoard(card.boardId, "comment.created", { cardId, comment: payload }, originSocket(req));
    logActivity({ boardId: card.boardId, cardId, userId: req.user.id, type: "card.commented", data: { title: card.title } });
    return { comment: payload };
  });

  app.patch("/api/comments/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = parseBody(z.object({ body: z.string().trim().min(1).max(20_000) }), req, reply);
    if (!body) return;
    const [comment] = uuidSchema.safeParse(id).success
      ? await db.select().from(schema.comments).where(eq(schema.comments.id, id))
      : [];
    if (!comment) return reply.code(404).send({ error: "not found" });
    const card = await loadCard(comment.cardId);
    if (!card) return reply.code(404).send({ error: "not found" });
    const access = await requireBoard(req, reply, card.boardId, "write");
    if (!access) return;
    // only the author (or a board admin) edits a comment
    if (comment.userId !== req.user.id && !access.canAdmin) {
      return reply.code(403).send({ error: "not your comment" });
    }
    const [updated] = await db
      .update(schema.comments)
      .set({ body: body.body, updatedAt: new Date() })
      .where(eq(schema.comments.id, id))
      .returning();
    emitBoard(card.boardId, "comment.updated", { cardId: card.id, comment: updated }, originSocket(req));
    return { comment: updated };
  });

  app.delete("/api/comments/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const [comment] = uuidSchema.safeParse(id).success
      ? await db.select().from(schema.comments).where(eq(schema.comments.id, id))
      : [];
    if (!comment) return reply.code(404).send({ error: "not found" });
    const card = await loadCard(comment.cardId);
    if (!card) return reply.code(404).send({ error: "not found" });
    const access = await requireBoard(req, reply, card.boardId, "write");
    if (!access) return;
    if (comment.userId !== req.user.id && !access.canAdmin) {
      return reply.code(403).send({ error: "not your comment" });
    }
    await db.delete(schema.comments).where(eq(schema.comments.id, id));
    emitBoard(card.boardId, "comment.deleted", { cardId: card.id, commentId: id }, originSocket(req));
    return { ok: true };
  });

  /* --------------------------------------------------------- attachments */

  app.post("/api/cards/:cardId/attachments", async (req, reply) => {
    const { cardId } = req.params as { cardId: string };
    const card = await loadCard(cardId);
    if (!card) return reply.code(404).send({ error: "not found" });
    if (!(await requireBoard(req, reply, card.boardId, "write"))) return;

    const file = await req.file();
    if (!file) return reply.code(400).send({ error: "no file" });
    const safeName = path.basename(file.filename || "file").slice(0, 200) || "file";
    const ext = path.extname(safeName).slice(0, 12);
    const rel = path.join(cardId, `${crypto.randomUUID()}${ext}`);
    const abs = path.join(env.uploadsDir, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    // M6: stream to disk. toBuffer() held the whole file (up to the 1 GB
    // limit) in the heap, so a few parallel uploads could OOM the container.
    // Written to a .part name first so a half-written file is never served.
    const part = `${abs}.part`;
    try {
      await pipeline(file.file, createWriteStream(part));
    } catch (err) {
      await fs.rm(part, { force: true });
      throw err;
    }
    if (file.file.truncated) {
      // the multipart fileSize limit was hit: busboy stops, the stream ends "normally"
      await fs.rm(part, { force: true });
      return reply.code(413).send({ error: "file too large" });
    }
    await fs.rename(part, abs);
    const { size } = await fs.stat(abs);

    const [attachment] = await db
      .insert(schema.attachments)
      .values({
        cardId,
        uploaderId: req.user.id,
        filename: safeName,
        mime: file.mimetype || "application/octet-stream",
        size,
        path: rel,
      })
      .returning();
    emitBoard(card.boardId, "attachment.created", { cardId, attachment }, originSocket(req));
    logActivity({ boardId: card.boardId, cardId, userId: req.user.id, type: "card.attached", data: { filename: safeName } });
    return { attachment };
  });

  app.get("/api/attachments/:id/file", async (req, reply) => {
    const { id } = req.params as { id: string };
    const [att] = uuidSchema.safeParse(id).success
      ? await db.select().from(schema.attachments).where(eq(schema.attachments.id, id))
      : [];
    if (!att) return reply.code(404).send({ error: "not found" });
    const card = await loadCard(att.cardId);
    if (!card) return reply.code(404).send({ error: "not found" });
    if (!(await requireBoard(req, reply, card.boardId, "read"))) return;

    const abs = path.resolve(env.uploadsDir, att.path);
    if (!abs.startsWith(env.uploadsDir + path.sep)) return reply.code(404).send({ error: "not found" });
    const download = (req.query as { download?: string }).download === "1";
    // L10: exact match against an allowlist. The old regex wasn't end-anchored
    // (`image/png,text/html` matched) and was only safe because Fastify happened
    // to coerce that header value to octet-stream while still sending `inline`.
    const inlineSafe = INLINE_SAFE.has(att.mime);
    let stat;
    try {
      stat = await fs.stat(abs);
    } catch {
      return reply.code(404).send({ error: "file missing" });
    }
    reply
      .header("Content-Type", inlineSafe ? att.mime : "application/octet-stream")
      .header("Content-Length", String(stat.size))
      .header("X-Content-Type-Options", "nosniff")
      .header(
        "Content-Disposition",
        `${download || !inlineSafe ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(att.filename)}`,
      );
    // streamed: readFile() buffered the whole attachment per download (M6)
    return reply.send(createReadStream(abs));
  });

  app.delete("/api/attachments/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const [att] = uuidSchema.safeParse(id).success
      ? await db.select().from(schema.attachments).where(eq(schema.attachments.id, id))
      : [];
    if (!att) return reply.code(404).send({ error: "not found" });
    const card = await loadCard(att.cardId);
    if (!card) return reply.code(404).send({ error: "not found" });
    if (!(await requireBoard(req, reply, card.boardId, "write"))) return;
    await db.delete(schema.attachments).where(eq(schema.attachments.id, id));
    fs.rm(path.resolve(env.uploadsDir, att.path), { force: true }).catch(() => {});
    // clear the cover if this attachment was it
    if (card.coverAttachmentId === id) {
      await db.update(schema.cards).set({ coverAttachmentId: null }).where(eq(schema.cards.id, card.id));
    }
    emitBoard(card.boardId, "attachment.deleted", { cardId: card.id, attachmentId: id }, originSocket(req));
    return { ok: true };
  });
}

/** types served inline; everything else is a download as application/octet-stream */
const INLINE_SAFE = new Set([
  "image/png", "image/jpeg", "image/gif", "image/webp", "image/avif",
  "application/pdf", "video/mp4",
  "audio/mpeg", "audio/mp4", "audio/ogg", "audio/wav", "audio/webm", "audio/aac", "audio/flac",
]);

async function checklistCtx(checklistId: string) {
  if (!uuidSchema.safeParse(checklistId).success) return null;
  const [cl] = await db
    .select()
    .from(schema.checklists)
    .where(eq(schema.checklists.id, checklistId));
  if (!cl) return null;
  const card = await loadCard(cl.cardId);
  return card ? { checklist: cl, card } : null;
}
