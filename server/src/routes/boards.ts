import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, asc, count, eq, inArray, sql } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { workspaceRoleOf } from "../lib/perms.js";
import { emitBoard, kickFromBoard } from "../sockets/index.js";
import { logActivity } from "../lib/activity.js";
import { originSocket, parseBody, requireBoard, uuidSchema } from "./helpers.js";

const BACKGROUNDS = [
  "navy", "sky", "teal", "forest", "amber", "crimson", "plum", "slate", "ink",
];

export async function boardRoutes(app: FastifyInstance) {
  app.post("/api/boards", async (req, reply) => {
    const body = parseBody(
      z.object({
        workspaceId: uuidSchema,
        name: z.string().trim().min(1).max(120),
        background: z.enum(BACKGROUNDS as [string, ...string[]]).default("navy"),
        visibility: z.enum(["private", "team", "workspace"]).default("workspace"),
      }),
      req,
      reply,
    );
    if (!body) return;

    const wsRole = req.user.isAdmin
      ? "admin"
      : await workspaceRoleOf(req.user.id, body.workspaceId);
    if (!wsRole) return reply.code(404).send({ error: "not found" });
    const [ws] = await db
      .select()
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, body.workspaceId));
    if ((ws.settings.boardCreation ?? "members") === "admins" && wsRole !== "admin") {
      return reply.code(403).send({ error: "only workspace admins can create boards" });
    }

    const [board] = await db
      .insert(schema.boards)
      .values({ ...body, createdBy: req.user.id })
      .returning();
    await db
      .insert(schema.boardMembers)
      .values({ boardId: board.id, userId: req.user.id, role: "admin" });
    logActivity({ boardId: board.id, userId: req.user.id, type: "board.created", data: { name: board.name } });
    return { board };
  });

  /** everything the board view needs, in one round trip */
  app.get("/api/boards/:id/full", async (req, reply) => {
    const { id } = req.params as { id: string };
    const access = await requireBoard(req, reply, id, "read");
    if (!access) return;

    const [listRows, cardRows, labelRows, memberRows, teamGrantRows, fieldDefs] =
      await Promise.all([
        db.select().from(schema.lists).where(eq(schema.lists.boardId, id)).orderBy(asc(schema.lists.rank)),
        db.select().from(schema.cards).where(eq(schema.cards.boardId, id)).orderBy(asc(schema.cards.rank)),
        db.select().from(schema.labels).where(eq(schema.labels.boardId, id)),
        db
          .select({
            id: schema.users.id, name: schema.users.name, email: schema.users.email,
            avatarColor: schema.users.avatarColor,
            role: schema.boardMembers.role, starred: schema.boardMembers.starred,
          })
          .from(schema.boardMembers)
          .innerJoin(schema.users, eq(schema.users.id, schema.boardMembers.userId))
          .where(eq(schema.boardMembers.boardId, id)),
        db.select().from(schema.boardTeams).where(eq(schema.boardTeams.boardId, id)),
        db
          .select()
          .from(schema.customFieldDefs)
          .where(eq(schema.customFieldDefs.boardId, id))
          .orderBy(asc(schema.customFieldDefs.rank)),
      ]);

    const cardIds = cardRows.map((c) => c.id);
    const [cardLabelRows, cardMemberRows, fieldValues, commentCounts, attachCounts, checkAgg] =
      cardIds.length
        ? await Promise.all([
            db.select().from(schema.cardLabels).where(inArray(schema.cardLabels.cardId, cardIds)),
            db.select().from(schema.cardMembers).where(inArray(schema.cardMembers.cardId, cardIds)),
            db.select().from(schema.customFieldValues).where(inArray(schema.customFieldValues.cardId, cardIds)),
            db
              .select({ cardId: schema.comments.cardId, n: count() })
              .from(schema.comments)
              .where(inArray(schema.comments.cardId, cardIds))
              .groupBy(schema.comments.cardId),
            db
              .select({ cardId: schema.attachments.cardId, n: count() })
              .from(schema.attachments)
              .where(inArray(schema.attachments.cardId, cardIds))
              .groupBy(schema.attachments.cardId),
            db
              .select({
                cardId: schema.checklists.cardId,
                total: count(schema.checklistItems.id),
                done: sql<number>`count(*) filter (where ${schema.checklistItems.done})`,
              })
              .from(schema.checklists)
              .innerJoin(
                schema.checklistItems,
                eq(schema.checklistItems.checklistId, schema.checklists.id),
              )
              .where(inArray(schema.checklists.cardId, cardIds))
              .groupBy(schema.checklists.cardId),
          ])
        : [[], [], [], [], [], []];

    const by = <T extends { cardId: string }>(rows: T[]) => {
      const m = new Map<string, T[]>();
      for (const r of rows) {
        const arr = m.get(r.cardId) ?? [];
        arr.push(r);
        m.set(r.cardId, arr);
      }
      return m;
    };
    const labelsBy = by(cardLabelRows);
    const membersBy = by(cardMemberRows);
    const valuesBy = by(fieldValues);
    const comments = new Map(commentCounts.map((r) => [r.cardId, Number(r.n)]));
    const attach = new Map(attachCounts.map((r) => [r.cardId, Number(r.n)]));
    const checks = new Map(checkAgg.map((r) => [r.cardId, { total: Number(r.total), done: Number(r.done) }]));

    return {
      board: access.board,
      myAccess: {
        role: access.role,
        canWrite: access.canWrite,
        canAdmin: access.canAdmin,
        workspaceRole: access.workspaceRole,
      },
      lists: listRows,
      cards: cardRows.map((c) => ({
        ...c,
        labelIds: (labelsBy.get(c.id) ?? []).map((r) => r.labelId),
        memberIds: (membersBy.get(c.id) ?? []).map((r) => r.userId),
        fieldValues: Object.fromEntries((valuesBy.get(c.id) ?? []).map((v) => [v.fieldId, v.value])),
        badges: {
          comments: comments.get(c.id) ?? 0,
          attachments: attach.get(c.id) ?? 0,
          checklist: checks.get(c.id) ?? null,
        },
      })),
      labels: labelRows,
      members: memberRows,
      teamIds: teamGrantRows.map((t) => t.teamId),
      customFieldDefs: fieldDefs,
    };
  });

  app.patch("/api/boards/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = parseBody(
      z.object({
        name: z.string().trim().min(1).max(120).optional(),
        background: z.enum(BACKGROUNDS as [string, ...string[]]).optional(),
        visibility: z.enum(["private", "team", "workspace"]).optional(),
        archived: z.boolean().optional(),
        teamIds: z.array(uuidSchema).max(100).optional(), // grants, with visibility=team
      }),
      req,
      reply,
    );
    if (!body) return;
    // rename/background = member action; visibility/archive/teams = admin action
    const needsAdmin = body.visibility !== undefined || body.archived !== undefined || body.teamIds;
    const access = await requireBoard(req, reply, id, needsAdmin ? "admin" : "write");
    if (!access) return;

    if (body.visibility && access.workspaceRole !== "admin" && !req.user.isAdmin) {
      const [ws] = await db
        .select()
        .from(schema.workspaces)
        .where(eq(schema.workspaces.id, access.board.workspaceId));
      if ((ws.settings.visibilityChanges ?? "members") === "admins") {
        return reply.code(403).send({ error: "only workspace admins can change visibility" });
      }
    }

    const { teamIds, ...patch } = body;
    const [board] = Object.keys(patch).length
      ? await db.update(schema.boards).set(patch).where(eq(schema.boards.id, id)).returning()
      : [access.board];

    if (teamIds) {
      // only teams of this workspace
      const wsTeams = new Set(
        (
          await db
            .select({ id: schema.teams.id })
            .from(schema.teams)
            .where(eq(schema.teams.workspaceId, board.workspaceId))
        ).map((t) => t.id),
      );
      await db.delete(schema.boardTeams).where(eq(schema.boardTeams.boardId, id));
      const valid = teamIds.filter((t) => wsTeams.has(t));
      if (valid.length) {
        await db.insert(schema.boardTeams).values(valid.map((teamId) => ({ boardId: id, teamId })));
      }
    }

    emitBoard(id, "board.updated", { board }, originSocket(req));
    logActivity({ boardId: id, userId: req.user.id, type: "board.updated", data: patch });
    if (body.visibility) await kickFromBoard(id); // re-join re-checks access
    return { board };
  });

  app.delete("/api/boards/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const access = await requireBoard(req, reply, id, "admin");
    if (!access) return;
    await db.delete(schema.boards).where(eq(schema.boards.id, id));
    emitBoard(id, "board.deleted", { boardId: id });
    await kickFromBoard(id);
    return { ok: true };
  });

  /* ------------------------------------------------------------- members */

  app.put("/api/boards/:id/members/:userId", async (req, reply) => {
    const { id, userId } = req.params as { id: string; userId: string };
    const body = parseBody(
      z.object({ role: z.enum(["admin", "member", "observer", "guest"]).default("member") }),
      req,
      reply,
    );
    if (!body) return;
    const access = await requireBoard(req, reply, id, "admin");
    if (!access) return;
    if (!uuidSchema.safeParse(userId).success) return reply.code(404).send({ error: "not found" });
    const [user] = await db.select().from(schema.users).where(eq(schema.users.id, userId));
    if (!user) return reply.code(404).send({ error: "no such user" });
    // non-workspace-members can only be guests or observers
    const wsRole = await workspaceRoleOf(userId, access.board.workspaceId);
    const role = !wsRole && (body.role === "admin" || body.role === "member") ? "guest" : body.role;

    await db
      .insert(schema.boardMembers)
      .values({ boardId: id, userId, role })
      .onConflictDoUpdate({
        target: [schema.boardMembers.boardId, schema.boardMembers.userId],
        set: { role },
      });
    const member = {
      id: user.id, name: user.name, email: user.email,
      avatarColor: user.avatarColor, role, starred: false,
    };
    emitBoard(id, "board.memberUpserted", { member }, originSocket(req));
    logActivity({ boardId: id, userId: req.user.id, type: "board.memberAdded", data: { member: user.name, role } });
    return { member };
  });

  app.delete("/api/boards/:id/members/:userId", async (req, reply) => {
    const { id, userId } = req.params as { id: string; userId: string };
    // leaving yourself needs only read; removing others needs admin
    const access = await requireBoard(req, reply, id, userId === req.user.id ? "read" : "admin");
    if (!access) return;
    const admins = await db
      .select({ userId: schema.boardMembers.userId })
      .from(schema.boardMembers)
      .where(and(eq(schema.boardMembers.boardId, id), eq(schema.boardMembers.role, "admin")));
    if (admins.length === 1 && admins[0].userId === userId) {
      return reply.code(409).send({ error: "cannot remove the last board admin" });
    }
    await db
      .delete(schema.boardMembers)
      .where(and(eq(schema.boardMembers.boardId, id), eq(schema.boardMembers.userId, userId)));
    emitBoard(id, "board.memberRemoved", { userId }, originSocket(req));
    await kickFromBoard(id, userId);
    return { ok: true };
  });

  /** self-join a workspace-visible board */
  app.post("/api/boards/:id/join", async (req, reply) => {
    const { id } = req.params as { id: string };
    const access = await requireBoard(req, reply, id, "read");
    if (!access) return;
    if (access.role) return { ok: true }; // already a member
    if (access.board.visibility !== "workspace" || !access.workspaceRole) {
      return reply.code(403).send({ error: "this board is invite-only" });
    }
    await db
      .insert(schema.boardMembers)
      .values({ boardId: id, userId: req.user.id, role: "member" })
      .onConflictDoNothing();
    const member = {
      id: req.user.id, name: req.user.name, email: req.user.email,
      avatarColor: req.user.avatarColor, role: "member", starred: false,
    };
    emitBoard(id, "board.memberUpserted", { member }, originSocket(req));
    return { ok: true };
  });

  app.put("/api/boards/:id/star", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = parseBody(z.object({ starred: z.boolean() }), req, reply);
    if (!body) return;
    const access = await requireBoard(req, reply, id, "read");
    if (!access) return;
    // starring implies membership for non-members with read access
    await db
      .insert(schema.boardMembers)
      .values({ boardId: id, userId: req.user.id, role: "observer", starred: body.starred })
      .onConflictDoUpdate({
        target: [schema.boardMembers.boardId, schema.boardMembers.userId],
        set: { starred: body.starred },
      });
    return { ok: true };
  });
}
