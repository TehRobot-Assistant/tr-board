/**
 * Board tools: full JSON export, copy-as-template, Trello import.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { asc, eq, inArray } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { workspaceRoleOf } from "../lib/perms.js";
import { after, spread } from "../lib/rank.js";
import { logActivity } from "../lib/activity.js";
import { parseBody, requireBoard, uuidSchema } from "./helpers.js";

export async function boardToolsRoutes(app: FastifyInstance) {
  /* -------------------------------------------------------------- export */

  app.get("/api/boards/:id/export", async (req, reply) => {
    const { id } = req.params as { id: string };
    const access = await requireBoard(req, reply, id, "admin");
    if (!access) return;

    const [lists, cards, labels, fieldDefs, rules] = await Promise.all([
      db.select().from(schema.lists).where(eq(schema.lists.boardId, id)).orderBy(asc(schema.lists.rank)),
      db.select().from(schema.cards).where(eq(schema.cards.boardId, id)).orderBy(asc(schema.cards.rank)),
      db.select().from(schema.labels).where(eq(schema.labels.boardId, id)),
      db.select().from(schema.customFieldDefs).where(eq(schema.customFieldDefs.boardId, id)),
      db.select().from(schema.automationRules).where(eq(schema.automationRules.boardId, id)),
    ]);
    const cardIds = cards.map((c) => c.id);
    const [cardLabels, checklists, comments, fieldValues] = cardIds.length
      ? await Promise.all([
          db.select().from(schema.cardLabels).where(inArray(schema.cardLabels.cardId, cardIds)),
          db.select().from(schema.checklists).where(inArray(schema.checklists.cardId, cardIds)),
          db.select().from(schema.comments).where(inArray(schema.comments.cardId, cardIds)),
          db.select().from(schema.customFieldValues).where(inArray(schema.customFieldValues.cardId, cardIds)),
        ])
      : [[], [], [], []];
    const checklistIds = checklists.map((c) => c.id);
    const items = checklistIds.length
      ? await db.select().from(schema.checklistItems).where(inArray(schema.checklistItems.checklistId, checklistIds))
      : [];

    reply.header(
      "Content-Disposition",
      `attachment; filename*=UTF-8''${encodeURIComponent(`trboard-${access.board.name}.json`)}`,
    );
    return {
      format: "trboard-export-v1",
      exportedAt: new Date().toISOString(),
      board: access.board,
      lists, cards, labels, cardLabels, checklists,
      checklistItems: items, comments, customFieldDefs: fieldDefs,
      customFieldValues: fieldValues, automationRules: rules,
    };
  });

  /* ---------------------------------------------------------------- copy */

  app.post("/api/boards/:id/copy", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = parseBody(
      z.object({
        name: z.string().trim().min(1).max(120),
        includeCards: z.boolean().default(false),
      }),
      req,
      reply,
    );
    if (!body) return;
    const access = await requireBoard(req, reply, id, "read");
    if (!access) return;
    // creating the copy needs board-creation rights in the workspace
    const wsRole = req.user.isAdmin ? "admin" : await workspaceRoleOf(req.user.id, access.board.workspaceId);
    if (!wsRole) return reply.code(403).send({ error: "not a workspace member" });
    const [ws] = await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, access.board.workspaceId));
    if ((ws.settings.boardCreation ?? "members") === "admins" && wsRole !== "admin") {
      return reply.code(403).send({ error: "only workspace admins can create boards" });
    }

    const [newBoard] = await db
      .insert(schema.boards)
      .values({
        workspaceId: access.board.workspaceId,
        name: body.name,
        background: access.board.background,
        visibility: "private", // copies start private; owner opens them up
        createdBy: req.user.id,
      })
      .returning();
    await db.insert(schema.boardMembers).values({ boardId: newBoard.id, userId: req.user.id, role: "admin" });

    // labels + field defs + lists (id maps for downstream rows)
    const labels = await db.select().from(schema.labels).where(eq(schema.labels.boardId, id));
    const labelMap = new Map<string, string>();
    for (const l of labels) {
      const [nl] = await db.insert(schema.labels).values({ boardId: newBoard.id, name: l.name, color: l.color }).returning();
      labelMap.set(l.id, nl.id);
    }
    const defs = await db.select().from(schema.customFieldDefs).where(eq(schema.customFieldDefs.boardId, id));
    const defMap = new Map<string, string>();
    for (const d of defs) {
      const [nd] = await db
        .insert(schema.customFieldDefs)
        .values({ boardId: newBoard.id, name: d.name, type: d.type, options: d.options, showOnFront: d.showOnFront, rank: d.rank })
        .returning();
      defMap.set(d.id, nd.id);
    }
    const lists = await db.select().from(schema.lists).where(eq(schema.lists.boardId, id)).orderBy(asc(schema.lists.rank));
    const listMap = new Map<string, string>();
    for (const l of lists) {
      if (l.archived) continue;
      const [nl] = await db.insert(schema.lists).values({ boardId: newBoard.id, name: l.name, rank: l.rank }).returning();
      listMap.set(l.id, nl.id);
    }

    if (body.includeCards) {
      const cards = await db.select().from(schema.cards).where(eq(schema.cards.boardId, id)).orderBy(asc(schema.cards.rank));
      const cardIds = cards.map((c) => c.id);
      const [cardLabels, checklists, fieldValues] = cardIds.length
        ? await Promise.all([
            db.select().from(schema.cardLabels).where(inArray(schema.cardLabels.cardId, cardIds)),
            db.select().from(schema.checklists).where(inArray(schema.checklists.cardId, cardIds)),
            db.select().from(schema.customFieldValues).where(inArray(schema.customFieldValues.cardId, cardIds)),
          ])
        : [[], [], []];
      const items = checklists.length
        ? await db.select().from(schema.checklistItems).where(inArray(schema.checklistItems.checklistId, checklists.map((c) => c.id)))
        : [];

      for (const c of cards) {
        if (c.archived) continue;
        const newListId = listMap.get(c.listId);
        if (!newListId) continue;
        const [nc] = await db
          .insert(schema.cards)
          .values({
            boardId: newBoard.id, listId: newListId, title: c.title, description: c.description,
            rank: c.rank, startAt: c.startAt, dueAt: c.dueAt, coverColor: c.coverColor,
            createdBy: req.user.id,
          })
          .returning();
        for (const cl of cardLabels.filter((x) => x.cardId === c.id)) {
          const nl = labelMap.get(cl.labelId);
          if (nl) await db.insert(schema.cardLabels).values({ cardId: nc.id, labelId: nl });
        }
        for (const fv of fieldValues.filter((x) => x.cardId === c.id)) {
          const nd = defMap.get(fv.fieldId);
          if (nd) await db.insert(schema.customFieldValues).values({ cardId: nc.id, fieldId: nd, value: fv.value });
        }
        for (const chk of checklists.filter((x) => x.cardId === c.id)) {
          const [nchk] = await db
            .insert(schema.checklists)
            .values({ cardId: nc.id, name: chk.name, rank: chk.rank })
            .returning();
          for (const it of items.filter((x) => x.checklistId === chk.id)) {
            await db.insert(schema.checklistItems).values({
              checklistId: nchk.id, text: it.text, done: false, rank: it.rank, dueAt: it.dueAt,
            });
          }
        }
      }
    }

    // automation rules — remap list/label references
    const rules = await db.select().from(schema.automationRules).where(eq(schema.automationRules.boardId, id));
    const remap = (obj: Record<string, unknown>): Record<string, unknown> => {
      const out = { ...obj };
      if (typeof out.listId === "string") out.listId = listMap.get(out.listId) ?? out.listId;
      if (typeof out.fromListId === "string") out.fromListId = listMap.get(out.fromListId) ?? out.fromListId;
      if (typeof out.labelId === "string") out.labelId = labelMap.get(out.labelId) ?? out.labelId;
      if (typeof out.fieldId === "string") out.fieldId = defMap.get(out.fieldId) ?? out.fieldId;
      return out;
    };
    for (const r of rules) {
      await db.insert(schema.automationRules).values({
        boardId: newBoard.id, name: r.name, enabled: r.enabled,
        trigger: remap(r.trigger),
        conditions: r.conditions.map(remap),
        actions: r.actions.map(remap),
        createdBy: req.user.id,
      });
    }

    logActivity({ boardId: newBoard.id, userId: req.user.id, type: "board.created", data: { name: body.name, copiedFrom: access.board.name } });
    return { board: newBoard };
  });

  /* -------------------------------------------------------- Trello import */

  app.post(
    "/api/workspaces/:id/import/trello",
    { bodyLimit: 30 * 1024 * 1024 },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!uuidSchema.safeParse(id).success) return reply.code(404).send({ error: "not found" });
      const wsRole = req.user.isAdmin ? "admin" : await workspaceRoleOf(req.user.id, id);
      if (!wsRole) return reply.code(404).send({ error: "not found" });
      const [ws] = await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, id));
      if ((ws.settings.boardCreation ?? "members") === "admins" && wsRole !== "admin") {
        return reply.code(403).send({ error: "only workspace admins can create boards" });
      }

      const t = req.body as any;
      if (!t || typeof t !== "object" || !Array.isArray(t.lists) || !Array.isArray(t.cards)) {
        return reply.code(400).send({ error: "that doesn't look like a Trello board export (need lists + cards)" });
      }

      const stats = { lists: 0, cards: 0, labels: 0, checklists: 0, comments: 0 };

      const [board] = await db
        .insert(schema.boards)
        .values({
          workspaceId: id,
          name: String(t.name ?? "Imported board").slice(0, 120),
          background: "slate",
          visibility: "private",
          createdBy: req.user.id,
        })
        .returning();
      await db.insert(schema.boardMembers).values({ boardId: board.id, userId: req.user.id, role: "admin" });

      // labels — Trello colour names → our palette
      const TRELLO_COLORS: Record<string, string> = {
        green: "#61bd4f", yellow: "#f2d600", orange: "#ff9f1a", red: "#eb5a46",
        purple: "#c377e0", blue: "#0079bf", sky: "#00c2e0", lime: "#51e898",
        pink: "#ff78cb", black: "#344563",
        green_dark: "#519839", yellow_dark: "#d9a21b", orange_dark: "#cd8313",
        red_dark: "#b04632", purple_dark: "#89609e", blue_dark: "#055a8c",
        green_light: "#7bc86c", yellow_light: "#f5dd29", orange_light: "#ffaf3f",
        red_light: "#ef7564", purple_light: "#cd8de5", blue_light: "#5ba4cf",
      };
      const labelMap = new Map<string, string>();
      for (const tl of Array.isArray(t.labels) ? t.labels : []) {
        if (!tl?.id) continue;
        const [nl] = await db
          .insert(schema.labels)
          .values({
            boardId: board.id,
            name: String(tl.name ?? "").slice(0, 60),
            color: TRELLO_COLORS[String(tl.color)] ?? "#838c91",
          })
          .returning();
        labelMap.set(String(tl.id), nl.id);
        stats.labels++;
      }

      // lists — Trello pos (float) order → fresh lexical ranks
      const openLists = (t.lists as any[])
        .filter((l) => l && !l.closed)
        .sort((a, b) => Number(a.pos ?? 0) - Number(b.pos ?? 0));
      const listRanks = spread(openLists.length);
      const listMap = new Map<string, string>();
      for (let i = 0; i < openLists.length; i++) {
        const [nl] = await db
          .insert(schema.lists)
          .values({ boardId: board.id, name: String(openLists[i].name ?? "List").slice(0, 120), rank: listRanks[i] })
          .returning();
        listMap.set(String(openLists[i].id), nl.id);
        stats.lists++;
      }

      // cards
      const openCards = (t.cards as any[])
        .filter((c) => c && !c.closed && listMap.has(String(c.idList)))
        .sort((a, b) => Number(a.pos ?? 0) - Number(b.pos ?? 0));
      const cardMap = new Map<string, string>();
      const lastRankPerList = new Map<string, string | null>();
      for (const tc of openCards) {
        const listId = listMap.get(String(tc.idList))!;
        const rank = after(lastRankPerList.get(listId) ?? null);
        lastRankPerList.set(listId, rank);
        const [nc] = await db
          .insert(schema.cards)
          .values({
            boardId: board.id,
            listId,
            title: String(tc.name ?? "Card").slice(0, 400),
            description: String(tc.desc ?? "").slice(0, 50_000),
            rank,
            dueAt: tc.due ? new Date(tc.due) : null,
            dueComplete: !!tc.dueComplete,
            startAt: tc.start ? new Date(tc.start) : null,
            createdBy: req.user.id,
          })
          .returning();
        cardMap.set(String(tc.id), nc.id);
        stats.cards++;
        for (const lid of Array.isArray(tc.idLabels) ? tc.idLabels : []) {
          const nl = labelMap.get(String(lid));
          if (nl) await db.insert(schema.cardLabels).values({ cardId: nc.id, labelId: nl }).onConflictDoNothing();
        }
      }

      // checklists (top-level array in Trello exports)
      for (const tchk of Array.isArray(t.checklists) ? t.checklists : []) {
        const cardId = cardMap.get(String(tchk?.idCard));
        if (!cardId) continue;
        const [nchk] = await db
          .insert(schema.checklists)
          .values({ cardId, name: String(tchk.name ?? "Checklist").slice(0, 120), rank: after(null) })
          .returning();
        stats.checklists++;
        const items = (Array.isArray(tchk.checkItems) ? tchk.checkItems : [])
          .sort((a: any, b: any) => Number(a.pos ?? 0) - Number(b.pos ?? 0));
        let rank: string | null = null;
        for (const it of items) {
          rank = after(rank);
          await db.insert(schema.checklistItems).values({
            checklistId: nchk.id,
            text: String(it.name ?? "").slice(0, 400) || "item",
            done: it.state === "complete",
            dueAt: it.due ? new Date(it.due) : null,
            rank,
          });
        }
      }

      // comments live in actions[type=commentCard]; author kept in the text
      for (const act of Array.isArray(t.actions) ? t.actions : []) {
        if (act?.type !== "commentCard") continue;
        const cardId = cardMap.get(String(act?.data?.card?.id));
        if (!cardId) continue;
        const who = act?.memberCreator?.fullName ?? act?.memberCreator?.username ?? "someone";
        await db.insert(schema.comments).values({
          cardId,
          userId: null,
          body: `[Trello · ${who}] ${String(act?.data?.text ?? "").slice(0, 19_000)}`,
          createdAt: act?.date ? new Date(act.date) : new Date(),
        });
        stats.comments++;
      }

      logActivity({ boardId: board.id, userId: req.user.id, type: "board.created", data: { name: board.name, importedFromTrello: true } });
      return { board, stats };
    },
  );
}
