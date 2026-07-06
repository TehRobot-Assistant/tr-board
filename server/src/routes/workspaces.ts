import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, eq, inArray } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { visibleBoardIds, workspaceRoleOf } from "../lib/perms.js";
import { parseBody, uuidSchema } from "./helpers.js";

const nameSchema = z.object({ name: z.string().trim().min(1).max(120) });

async function requireWs(
  req: { user: { id: string; isAdmin: boolean } },
  reply: { code: (n: number) => { send: (b: unknown) => unknown } },
  workspaceId: string,
  level: "member" | "admin",
): Promise<"admin" | "member" | null> {
  if (!uuidSchema.safeParse(workspaceId).success) {
    reply.code(404).send({ error: "not found" });
    return null;
  }
  if (req.user.isAdmin) return "admin";
  const role = await workspaceRoleOf(req.user.id, workspaceId);
  if (!role || (level === "admin" && role !== "admin")) {
    reply.code(role ? 403 : 404).send({ error: role ? "forbidden" : "not found" });
    return null;
  }
  return role;
}

export async function workspaceRoutes(app: FastifyInstance) {
  /** workspaces I belong to (instance admin sees all) */
  app.get("/api/workspaces", async (req) => {
    if (req.user.isAdmin) {
      const all = await db.select().from(schema.workspaces);
      return { workspaces: all.map((w) => ({ ...w, role: "admin" as const })) };
    }
    const rows = await db
      .select({ ws: schema.workspaces, role: schema.workspaceMembers.role })
      .from(schema.workspaceMembers)
      .innerJoin(schema.workspaces, eq(schema.workspaces.id, schema.workspaceMembers.workspaceId))
      .where(eq(schema.workspaceMembers.userId, req.user.id));
    return { workspaces: rows.map((r) => ({ ...r.ws, role: r.role })) };
  });

  app.post("/api/workspaces", async (req, reply) => {
    const body = parseBody(nameSchema, req, reply);
    if (!body) return;
    const [ws] = await db.insert(schema.workspaces).values({ name: body.name }).returning();
    await db.insert(schema.workspaceMembers).values({
      workspaceId: ws.id,
      userId: req.user.id,
      role: "admin",
    });
    return { workspace: { ...ws, role: "admin" } };
  });

  /** workspace home payload: visible boards + members + teams */
  app.get("/api/workspaces/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const role = await requireWs(req, reply, id, "member");
    if (!role) return;

    const [ws] = await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, id));
    if (!ws) return reply.code(404).send({ error: "not found" });

    const visible = await visibleBoardIds(req.user.id, id, req.user.isAdmin);
    const boards = visible.size
      ? await db
          .select()
          .from(schema.boards)
          .where(and(eq(schema.boards.workspaceId, id), inArray(schema.boards.id, [...visible])))
      : [];
    const stars = new Set(
      (
        await db
          .select({ boardId: schema.boardMembers.boardId })
          .from(schema.boardMembers)
          .where(and(eq(schema.boardMembers.userId, req.user.id), eq(schema.boardMembers.starred, true)))
      ).map((r) => r.boardId),
    );

    const members = await db
      .select({
        id: schema.users.id, name: schema.users.name, email: schema.users.email,
        avatarColor: schema.users.avatarColor, role: schema.workspaceMembers.role,
      })
      .from(schema.workspaceMembers)
      .innerJoin(schema.users, eq(schema.users.id, schema.workspaceMembers.userId))
      .where(eq(schema.workspaceMembers.workspaceId, id));

    const teams = await db.select().from(schema.teams).where(eq(schema.teams.workspaceId, id));
    const teamMemberRows = teams.length
      ? await db
          .select()
          .from(schema.teamMembers)
          .where(inArray(schema.teamMembers.teamId, teams.map((t) => t.id)))
      : [];

    return {
      workspace: { ...ws, role },
      boards: boards.map((b) => ({ ...b, starred: stars.has(b.id) })),
      members,
      teams: teams.map((t) => ({
        ...t,
        memberIds: teamMemberRows.filter((m) => m.teamId === t.id).map((m) => m.userId),
      })),
    };
  });

  app.patch("/api/workspaces/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!(await requireWs(req, reply, id, "admin"))) return;
    const body = parseBody(
      z.object({
        name: z.string().trim().min(1).max(120).optional(),
        settings: z
          .object({
            boardCreation: z.enum(["admins", "members"]).optional(),
            inviting: z.enum(["admins", "members"]).optional(),
            visibilityChanges: z.enum(["admins", "members"]).optional(),
          })
          .optional(),
      }),
      req,
      reply,
    );
    if (!body) return;
    const [ws] = await db
      .update(schema.workspaces)
      .set({
        ...(body.name ? { name: body.name } : {}),
        ...(body.settings ? { settings: body.settings } : {}),
      })
      .where(eq(schema.workspaces.id, id))
      .returning();
    return { workspace: ws };
  });

  app.delete("/api/workspaces/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!(await requireWs(req, reply, id, "admin"))) return;
    await db.delete(schema.workspaces).where(eq(schema.workspaces.id, id));
    return { ok: true };
  });

  /* ------------------------------------------------------------- members */

  app.post("/api/workspaces/:id/members", async (req, reply) => {
    const { id } = req.params as { id: string };
    const meRole = await requireWs(req, reply, id, "member");
    if (!meRole) return;
    const [ws] = await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, id));
    if ((ws.settings.inviting ?? "members") === "admins" && meRole !== "admin") {
      return reply.code(403).send({ error: "only workspace admins can invite" });
    }
    const body = parseBody(
      z.object({ email: z.string().email().transform((s) => s.toLowerCase().trim()), role: z.enum(["admin", "member"]).default("member") }),
      req,
      reply,
    );
    if (!body) return;
    if (body.role === "admin" && meRole !== "admin") {
      return reply.code(403).send({ error: "only admins can grant admin" });
    }
    const [user] = await db.select().from(schema.users).where(eq(schema.users.email, body.email));
    if (!user) return reply.code(404).send({ error: "no user with that email" });
    await db
      .insert(schema.workspaceMembers)
      .values({ workspaceId: id, userId: user.id, role: body.role })
      .onConflictDoUpdate({
        target: [schema.workspaceMembers.workspaceId, schema.workspaceMembers.userId],
        set: { role: body.role },
      });
    return {
      member: { id: user.id, name: user.name, email: user.email, avatarColor: user.avatarColor, role: body.role },
    };
  });

  app.delete("/api/workspaces/:id/members/:userId", async (req, reply) => {
    const { id, userId } = req.params as { id: string; userId: string };
    const meRole = await requireWs(req, reply, id, userId === req.user.id ? "member" : "admin");
    if (!meRole) return;
    // never remove the last admin
    const admins = await db
      .select({ userId: schema.workspaceMembers.userId })
      .from(schema.workspaceMembers)
      .where(and(eq(schema.workspaceMembers.workspaceId, id), eq(schema.workspaceMembers.role, "admin")));
    if (admins.length === 1 && admins[0].userId === userId) {
      return reply.code(409).send({ error: "cannot remove the last workspace admin" });
    }
    await db
      .delete(schema.workspaceMembers)
      .where(and(eq(schema.workspaceMembers.workspaceId, id), eq(schema.workspaceMembers.userId, userId)));
    return { ok: true };
  });

  /* --------------------------------------------------------------- teams */

  app.post("/api/workspaces/:id/teams", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!(await requireWs(req, reply, id, "admin"))) return;
    const body = parseBody(
      nameSchema.extend({ color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional() }),
      req,
      reply,
    );
    if (!body) return;
    const [team] = await db
      .insert(schema.teams)
      .values({ workspaceId: id, name: body.name, ...(body.color ? { color: body.color } : {}) })
      .returning();
    return { team: { ...team, memberIds: [] } };
  });

  app.patch("/api/teams/:teamId", async (req, reply) => {
    const { teamId } = req.params as { teamId: string };
    const [team] = uuidSchema.safeParse(teamId).success
      ? await db.select().from(schema.teams).where(eq(schema.teams.id, teamId))
      : [];
    if (!team) return reply.code(404).send({ error: "not found" });
    if (!(await requireWs(req, reply, team.workspaceId, "admin"))) return;
    const body = parseBody(
      z.object({
        name: z.string().trim().min(1).max(120).optional(),
        color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
        memberIds: z.array(uuidSchema).max(500).optional(),
      }),
      req,
      reply,
    );
    if (!body) return;
    if (body.name || body.color) {
      await db
        .update(schema.teams)
        .set({ ...(body.name ? { name: body.name } : {}), ...(body.color ? { color: body.color } : {}) })
        .where(eq(schema.teams.id, teamId));
    }
    if (body.memberIds) {
      // replace membership wholesale — only with users who are workspace members
      const wsMembers = new Set(
        (
          await db
            .select({ userId: schema.workspaceMembers.userId })
            .from(schema.workspaceMembers)
            .where(eq(schema.workspaceMembers.workspaceId, team.workspaceId))
        ).map((r) => r.userId),
      );
      const valid = body.memberIds.filter((uid) => wsMembers.has(uid));
      await db.delete(schema.teamMembers).where(eq(schema.teamMembers.teamId, teamId));
      if (valid.length) {
        await db.insert(schema.teamMembers).values(valid.map((userId) => ({ teamId, userId })));
      }
    }
    const [updated] = await db.select().from(schema.teams).where(eq(schema.teams.id, teamId));
    const memberIds = (
      await db.select().from(schema.teamMembers).where(eq(schema.teamMembers.teamId, teamId))
    ).map((m) => m.userId);
    return { team: { ...updated, memberIds } };
  });

  app.delete("/api/teams/:teamId", async (req, reply) => {
    const { teamId } = req.params as { teamId: string };
    const [team] = uuidSchema.safeParse(teamId).success
      ? await db.select().from(schema.teams).where(eq(schema.teams.id, teamId))
      : [];
    if (!team) return reply.code(404).send({ error: "not found" });
    if (!(await requireWs(req, reply, team.workspaceId, "admin"))) return;
    await db.delete(schema.teams).where(eq(schema.teams.id, teamId));
    return { ok: true };
  });
}
