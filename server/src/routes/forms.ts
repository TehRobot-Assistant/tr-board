/**
 * Forms (Monday WorkForms) — a public form whose submissions become cards.
 * Authenticated CRUD lives under /api/boards/:id/forms; the public render +
 * submit endpoints are token-gated and rate-limited.
 */
import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { desc, eq } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { after } from "../lib/rank.js";
import { emitBoard } from "../sockets/index.js";
import { logActivity } from "../lib/activity.js";
import { originSocket, parseBody, requireBoard, uuidSchema } from "./helpers.js";
import { dispatchAutomation } from "../automation/engine.js";

const fieldSchema = z.object({
  id: z.string().min(1).max(40),
  label: z.string().trim().min(1).max(120),
  type: z.enum(["text", "textarea", "email", "number", "date", "select"]),
  required: z.boolean().default(false),
  options: z.array(z.string().trim().min(1).max(80)).max(30).optional(),
});

const formBody = z.object({
  listId: uuidSchema,
  title: z.string().trim().min(1).max(120),
  description: z.string().max(2000).default(""),
  enabled: z.boolean().default(true),
  fields: z.array(fieldSchema).min(1).max(20),
});

export async function formRoutes(app: FastifyInstance) {
  app.get("/api/boards/:boardId/forms", async (req, reply) => {
    const { boardId } = req.params as { boardId: string };
    if (!(await requireBoard(req, reply, boardId, "read"))) return;
    const rows = await db
      .select()
      .from(schema.forms)
      .where(eq(schema.forms.boardId, boardId))
      .orderBy(desc(schema.forms.createdAt));
    return { forms: rows };
  });

  app.post("/api/boards/:boardId/forms", async (req, reply) => {
    const { boardId } = req.params as { boardId: string };
    const body = parseBody(formBody, req, reply);
    if (!body) return;
    if (!(await requireBoard(req, reply, boardId, "admin"))) return;
    const [list] = await db
      .select()
      .from(schema.lists)
      .where(eq(schema.lists.id, body.listId));
    if (!list || list.boardId !== boardId) return reply.code(400).send({ error: "list not on this board" });
    const [form] = await db
      .insert(schema.forms)
      .values({ boardId, ...body, token: crypto.randomBytes(16).toString("hex"), createdBy: req.user.id })
      .returning();
    return { form };
  });

  app.patch("/api/forms/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = parseBody(formBody.partial(), req, reply);
    if (!body) return;
    const [existing] = uuidSchema.safeParse(id).success
      ? await db.select().from(schema.forms).where(eq(schema.forms.id, id))
      : [];
    if (!existing) return reply.code(404).send({ error: "not found" });
    if (!(await requireBoard(req, reply, existing.boardId, "admin"))) return;
    if (body.listId) {
      const [list] = await db.select().from(schema.lists).where(eq(schema.lists.id, body.listId));
      if (!list || list.boardId !== existing.boardId) {
        return reply.code(400).send({ error: "list not on this board" });
      }
    }
    const [form] = await db.update(schema.forms).set(body).where(eq(schema.forms.id, id)).returning();
    return { form };
  });

  app.delete("/api/forms/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const [existing] = uuidSchema.safeParse(id).success
      ? await db.select().from(schema.forms).where(eq(schema.forms.id, id))
      : [];
    if (!existing) return reply.code(404).send({ error: "not found" });
    if (!(await requireBoard(req, reply, existing.boardId, "admin"))) return;
    await db.delete(schema.forms).where(eq(schema.forms.id, id));
    return { ok: true };
  });
}

/* --------------------------------------------------------------- public */

// naive per-IP throttle: 20 submissions / 10 min, swept opportunistically
const submits = new Map<string, { n: number; resetAt: number }>();
function throttled(ip: string): boolean {
  const now = Date.now();
  if (submits.size > 5000) submits.clear();
  const cur = submits.get(ip);
  if (!cur || cur.resetAt < now) {
    submits.set(ip, { n: 1, resetAt: now + 10 * 60_000 });
    return false;
  }
  cur.n += 1;
  return cur.n > 20;
}

export async function publicFormRoutes(app: FastifyInstance) {
  app.get("/api/public/forms/:token", async (req, reply) => {
    const { token } = req.params as { token: string };
    if (!/^[0-9a-f]{32}$/.test(token)) return reply.code(404).send({ error: "not found" });
    const [form] = await db.select().from(schema.forms).where(eq(schema.forms.token, token));
    if (!form || !form.enabled) return reply.code(404).send({ error: "not found" });
    // public shape: no board/list ids
    return {
      form: { title: form.title, description: form.description, fields: form.fields },
    };
  });

  app.post("/api/public/forms/:token", async (req, reply) => {
    const { token } = req.params as { token: string };
    if (!/^[0-9a-f]{32}$/.test(token)) return reply.code(404).send({ error: "not found" });
    if (throttled(req.ip)) return reply.code(429).send({ error: "too many submissions — try again later" });
    const [form] = await db.select().from(schema.forms).where(eq(schema.forms.token, token));
    if (!form || !form.enabled) return reply.code(404).send({ error: "not found" });

    const answers = (req.body as { answers?: Record<string, unknown> })?.answers;
    if (!answers || typeof answers !== "object") return reply.code(400).send({ error: "no answers" });

    // validate against the form's own field defs
    const clean: Array<{ label: string; value: string }> = [];
    for (const f of form.fields) {
      const raw = (answers as Record<string, unknown>)[f.id];
      const str = raw === null || raw === undefined ? "" : String(raw).trim();
      if (!str) {
        if (f.required) return reply.code(400).send({ error: `"${f.label}" is required` });
        continue;
      }
      if (str.length > 5000) return reply.code(400).send({ error: `"${f.label}" is too long` });
      if (f.type === "email" && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(str)) {
        return reply.code(400).send({ error: `"${f.label}" must be an email address` });
      }
      if (f.type === "number" && Number.isNaN(Number(str))) {
        return reply.code(400).send({ error: `"${f.label}" must be a number` });
      }
      if (f.type === "date" && Number.isNaN(Date.parse(str))) {
        return reply.code(400).send({ error: `"${f.label}" must be a date` });
      }
      if (f.type === "select" && !(f.options ?? []).includes(str)) {
        return reply.code(400).send({ error: `"${f.label}" has an invalid choice` });
      }
      clean.push({ label: f.label, value: str });
    }
    if (!clean.length) return reply.code(400).send({ error: "form is empty" });

    // the list may have been deleted since the form was built
    const [list] = await db.select().from(schema.lists).where(eq(schema.lists.id, form.listId));
    if (!list) return reply.code(410).send({ error: "this form's destination no longer exists" });

    const title = clean[0].value.slice(0, 400);
    const description = clean
      .map((a) => `**${a.label}**\n${a.value}`)
      .join("\n\n")
      .slice(0, 50_000);

    const [last] = await db
      .select({ rank: schema.cards.rank })
      .from(schema.cards)
      .where(eq(schema.cards.listId, list.id))
      .orderBy(desc(schema.cards.rank))
      .limit(1);
    const [card] = await db
      .insert(schema.cards)
      .values({ boardId: form.boardId, listId: list.id, title, description, rank: after(last?.rank ?? null) })
      .returning();
    const payload = {
      ...card, labelIds: [], memberIds: [], fieldValues: {},
      badges: { comments: 0, attachments: 0, checklist: null },
    };
    emitBoard(form.boardId, "card.created", { card: payload });
    logActivity({
      boardId: form.boardId, cardId: card.id, userId: null,
      type: "card.formSubmitted", data: { title, form: form.title },
    });
    dispatchAutomation(form.boardId, { type: "card_created", cardId: card.id, listId: list.id }, null);
    return { ok: true };
  });
}
