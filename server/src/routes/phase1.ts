/**
 * Phase 1 REST: custom field defs + values, automation rules, board activity,
 * notifications. (The views — Calendar/Timeline/Table — are frontend lenses
 * over the same /full payload.)
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, desc, eq, inArray } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { after } from "../lib/rank.js";
import { emitBoard } from "../sockets/index.js";
import { originSocket, parseBody, requireBoard, uuidSchema } from "./helpers.js";
import { loadCard } from "./cards.js";
import { dispatchAutomation, MAX_RULES_PER_BOARD } from "../automation/engine.js";

const optionSchema = z.object({
  id: z.string().min(1).max(40),
  label: z.string().trim().min(1).max(80),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
});

const fieldTypes = ["text", "number", "date", "checkbox", "select", "multiselect", "member", "url"] as const;

export async function phase1Routes(app: FastifyInstance) {
  /* ------------------------------------------------- custom field defs */

  app.post("/api/boards/:boardId/fields", async (req, reply) => {
    const { boardId } = req.params as { boardId: string };
    const body = parseBody(
      z.object({
        name: z.string().trim().min(1).max(80),
        type: z.enum(fieldTypes),
        options: z.array(optionSchema).max(50).default([]),
        showOnFront: z.boolean().default(false),
      }),
      req,
      reply,
    );
    if (!body) return;
    if (!(await requireBoard(req, reply, boardId, "admin"))) return;
    const [last] = await db
      .select({ rank: schema.customFieldDefs.rank })
      .from(schema.customFieldDefs)
      .where(eq(schema.customFieldDefs.boardId, boardId))
      .orderBy(desc(schema.customFieldDefs.rank))
      .limit(1);
    const [field] = await db
      .insert(schema.customFieldDefs)
      .values({ boardId, ...body, rank: after(last?.rank ?? null) })
      .returning();
    emitBoard(boardId, "field.created", { field }, originSocket(req));
    return { field };
  });

  app.patch("/api/fields/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = parseBody(
      z.object({
        name: z.string().trim().min(1).max(80).optional(),
        options: z.array(optionSchema).max(50).optional(),
        showOnFront: z.boolean().optional(),
      }),
      req,
      reply,
    );
    if (!body) return;
    const [def] = uuidSchema.safeParse(id).success
      ? await db.select().from(schema.customFieldDefs).where(eq(schema.customFieldDefs.id, id))
      : [];
    if (!def) return reply.code(404).send({ error: "not found" });
    if (!(await requireBoard(req, reply, def.boardId, "admin"))) return;
    const [field] = await db
      .update(schema.customFieldDefs)
      .set(body)
      .where(eq(schema.customFieldDefs.id, id))
      .returning();
    emitBoard(def.boardId, "field.updated", { field }, originSocket(req));
    return { field };
  });

  app.delete("/api/fields/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const [def] = uuidSchema.safeParse(id).success
      ? await db.select().from(schema.customFieldDefs).where(eq(schema.customFieldDefs.id, id))
      : [];
    if (!def) return reply.code(404).send({ error: "not found" });
    if (!(await requireBoard(req, reply, def.boardId, "admin"))) return;
    await db.delete(schema.customFieldDefs).where(eq(schema.customFieldDefs.id, id));
    emitBoard(def.boardId, "field.deleted", { fieldId: id }, originSocket(req));
    return { ok: true };
  });

  /* ---------------------------------------------------- field values */

  app.put("/api/cards/:cardId/fields/:fieldId", async (req, reply) => {
    const { cardId, fieldId } = req.params as { cardId: string; fieldId: string };
    const card = await loadCard(cardId);
    if (!card) return reply.code(404).send({ error: "not found" });
    if (!(await requireBoard(req, reply, card.boardId, "write"))) return;
    const [def] = uuidSchema.safeParse(fieldId).success
      ? await db
          .select()
          .from(schema.customFieldDefs)
          .where(and(eq(schema.customFieldDefs.id, fieldId), eq(schema.customFieldDefs.boardId, card.boardId)))
      : [];
    if (!def) return reply.code(404).send({ error: "no such field on this board" });

    const raw = (req.body as { value?: unknown })?.value;
    const value = validateFieldValue(def, raw);
    if (value === undefined) return reply.code(400).send({ error: `invalid value for ${def.type} field` });

    if (value === null) {
      await db
        .delete(schema.customFieldValues)
        .where(and(eq(schema.customFieldValues.cardId, cardId), eq(schema.customFieldValues.fieldId, fieldId)));
    } else {
      await db
        .insert(schema.customFieldValues)
        .values({ cardId, fieldId, value })
        .onConflictDoUpdate({
          target: [schema.customFieldValues.cardId, schema.customFieldValues.fieldId],
          set: { value },
        });
    }
    emitBoard(card.boardId, "card.fieldChanged", { cardId, fieldId, value }, originSocket(req));
    dispatchAutomation(card.boardId, { type: "field_changed", cardId, listId: card.listId, fieldId }, req.user.id);
    return { ok: true, value };
  });

  /* ---------------------------------------------------- automation rules */

  const ruleSchema = z.object({
    name: z.string().trim().min(1).max(120),
    enabled: z.boolean().default(true),
    trigger: z.object({ type: z.string().min(1).max(40) }).passthrough(),
    conditions: z.array(z.object({ type: z.string().min(1).max(40) }).passthrough()).max(10).default([]),
    actions: z.array(z.object({ type: z.string().min(1).max(40) }).passthrough()).max(10).default([]),
  });

  app.get("/api/boards/:boardId/automation", async (req, reply) => {
    const { boardId } = req.params as { boardId: string };
    if (!(await requireBoard(req, reply, boardId, "read"))) return;
    const rules = await db
      .select()
      .from(schema.automationRules)
      .where(eq(schema.automationRules.boardId, boardId))
      .orderBy(desc(schema.automationRules.createdAt));
    const runs = await db
      .select({
        id: schema.automationRuns.id, ruleId: schema.automationRuns.ruleId,
        ok: schema.automationRuns.ok, detail: schema.automationRuns.detail,
        createdAt: schema.automationRuns.createdAt,
      })
      .from(schema.automationRuns)
      .innerJoin(schema.automationRules, eq(schema.automationRules.id, schema.automationRuns.ruleId))
      .where(eq(schema.automationRules.boardId, boardId))
      .orderBy(desc(schema.automationRuns.createdAt))
      .limit(50);
    return { rules, runs };
  });

  app.post("/api/boards/:boardId/automation", async (req, reply) => {
    const { boardId } = req.params as { boardId: string };
    const body = parseBody(ruleSchema, req, reply);
    if (!body) return;
    if (!(await requireBoard(req, reply, boardId, "admin"))) return;
    // H2: bound how many rules one event can fan out to. Not transactional, so
    // two simultaneous creates could overshoot by one; the per-chain action
    // budget in the engine is the hard limit, this just keeps boards sane.
    const count = await db.$count(schema.automationRules, eq(schema.automationRules.boardId, boardId));
    if (count >= MAX_RULES_PER_BOARD) {
      return reply.code(409).send({ error: `a board can have at most ${MAX_RULES_PER_BOARD} automation rules` });
    }
    const [rule] = await db
      .insert(schema.automationRules)
      .values({ boardId, ...body, createdBy: req.user.id })
      .returning();
    emitBoard(boardId, "automation.updated", {}, originSocket(req));
    return { rule };
  });

  app.patch("/api/automation/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = parseBody(ruleSchema.partial(), req, reply);
    if (!body) return;
    const [existing] = uuidSchema.safeParse(id).success
      ? await db.select().from(schema.automationRules).where(eq(schema.automationRules.id, id))
      : [];
    if (!existing) return reply.code(404).send({ error: "not found" });
    if (!(await requireBoard(req, reply, existing.boardId, "admin"))) return;
    const [rule] = await db
      .update(schema.automationRules)
      .set(body)
      .where(eq(schema.automationRules.id, id))
      .returning();
    emitBoard(existing.boardId, "automation.updated", {}, originSocket(req));
    return { rule };
  });

  app.delete("/api/automation/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const [existing] = uuidSchema.safeParse(id).success
      ? await db.select().from(schema.automationRules).where(eq(schema.automationRules.id, id))
      : [];
    if (!existing) return reply.code(404).send({ error: "not found" });
    if (!(await requireBoard(req, reply, existing.boardId, "admin"))) return;
    await db.delete(schema.automationRules).where(eq(schema.automationRules.id, id));
    emitBoard(existing.boardId, "automation.updated", {}, originSocket(req));
    return { ok: true };
  });

  /* ------------------------------------------------------------ activity */

  app.get("/api/boards/:boardId/activity", async (req, reply) => {
    const { boardId } = req.params as { boardId: string };
    if (!(await requireBoard(req, reply, boardId, "read"))) return;
    const rows = await db
      .select({
        id: schema.activityLog.id, type: schema.activityLog.type,
        data: schema.activityLog.data, cardId: schema.activityLog.cardId,
        createdAt: schema.activityLog.createdAt,
        userId: schema.activityLog.userId, userName: schema.users.name,
        avatarColor: schema.users.avatarColor,
      })
      .from(schema.activityLog)
      .leftJoin(schema.users, eq(schema.users.id, schema.activityLog.userId))
      .where(eq(schema.activityLog.boardId, boardId))
      .orderBy(desc(schema.activityLog.createdAt))
      .limit(100);
    return { activity: rows };
  });

  /* ------------------------------------------------------- notifications */

  app.get("/api/notifications", async (req) => {
    const rows = await db
      .select()
      .from(schema.notifications)
      .where(eq(schema.notifications.userId, req.user.id))
      .orderBy(desc(schema.notifications.createdAt))
      .limit(50);
    return { notifications: rows };
  });

  app.post("/api/notifications/read", async (req, reply) => {
    const body = parseBody(z.object({ ids: z.array(uuidSchema).max(100).optional() }), req, reply);
    if (!body) return;
    await db
      .update(schema.notifications)
      .set({ read: true })
      .where(
        body.ids
          ? and(eq(schema.notifications.userId, req.user.id), inArray(schema.notifications.id, body.ids))
          : eq(schema.notifications.userId, req.user.id),
      );
    return { ok: true };
  });
}

/** returns the normalised value, null to clear, or undefined when invalid */
function validateFieldValue(
  def: typeof schema.customFieldDefs.$inferSelect,
  raw: unknown,
): unknown | null | undefined {
  if (raw === null || raw === undefined || raw === "") return null;
  switch (def.type) {
    case "text":
      return typeof raw === "string" && raw.length <= 1000 ? raw : undefined;
    case "url":
      if (typeof raw !== "string" || raw.length > 2000) return undefined;
      return /^https?:\/\//i.test(raw) ? raw : undefined;
    case "number":
      return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
    case "checkbox":
      return typeof raw === "boolean" ? raw : undefined;
    case "date":
      return typeof raw === "string" && !Number.isNaN(Date.parse(raw)) ? raw : undefined;
    case "select": {
      const ok = typeof raw === "string" && def.options.some((o) => o.id === raw);
      return ok ? raw : undefined;
    }
    case "multiselect": {
      const ok =
        Array.isArray(raw) &&
        raw.length <= 50 &&
        raw.every((v) => typeof v === "string" && def.options.some((o) => o.id === v));
      return ok ? raw : undefined;
    }
    case "member":
      return typeof raw === "string" && /^[0-9a-f-]{36}$/.test(raw) ? raw : undefined;
    default:
      return undefined;
  }
}
