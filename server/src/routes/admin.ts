/** Instance admin — user management (SCOPE §7 "admin controls"). */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { hashPassword } from "../lib/auth.js";
import { parseBody, uuidSchema } from "./helpers.js";

export async function adminRoutes(app: FastifyInstance) {
  app.addHook("preHandler", async (req, reply) => {
    if (!req.user?.isAdmin) return reply.code(403).send({ error: "instance admin only" });
  });

  app.get("/api/admin/users", async () => {
    const users = await db
      .select({
        id: schema.users.id, email: schema.users.email, name: schema.users.name,
        avatarColor: schema.users.avatarColor, isAdmin: schema.users.isAdmin,
        createdAt: schema.users.createdAt,
      })
      .from(schema.users);
    return { users };
  });

  app.post("/api/admin/users", async (req, reply) => {
    const body = parseBody(
      z.object({
        email: z.string().email().max(254).transform((s) => s.toLowerCase().trim()),
        name: z.string().trim().min(1).max(80),
        password: z.string().min(8).max(200),
        isAdmin: z.boolean().default(false),
      }),
      req,
      reply,
    );
    if (!body) return;
    const existing = await db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.email, body.email));
    if (existing.length) return reply.code(409).send({ error: "email already registered" });
    const [user] = await db
      .insert(schema.users)
      .values({
        email: body.email, name: body.name,
        passwordHash: await hashPassword(body.password), isAdmin: body.isAdmin,
      })
      .returning();
    return {
      user: { id: user.id, email: user.email, name: user.name, avatarColor: user.avatarColor, isAdmin: user.isAdmin },
    };
  });

  app.patch("/api/admin/users/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = parseBody(
      z.object({
        name: z.string().trim().min(1).max(80).optional(),
        password: z.string().min(8).max(200).optional(),
        isAdmin: z.boolean().optional(),
      }),
      req,
      reply,
    );
    if (!body) return;
    if (!uuidSchema.safeParse(id).success) return reply.code(404).send({ error: "not found" });
    if (body.isAdmin === false && id === req.user.id) {
      return reply.code(409).send({ error: "cannot demote yourself" });
    }
    const patch: Record<string, unknown> = {};
    if (body.name) patch.name = body.name;
    if (body.isAdmin !== undefined) patch.isAdmin = body.isAdmin;
    if (body.password) patch.passwordHash = await hashPassword(body.password);
    const [user] = await db.update(schema.users).set(patch).where(eq(schema.users.id, id)).returning();
    if (!user) return reply.code(404).send({ error: "not found" });
    if (body.password) {
      await db.delete(schema.sessions).where(eq(schema.sessions.userId, id)); // force re-login
    }
    return { user: { id: user.id, email: user.email, name: user.name, isAdmin: user.isAdmin } };
  });

  app.delete("/api/admin/users/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!uuidSchema.safeParse(id).success) return reply.code(404).send({ error: "not found" });
    if (id === req.user.id) return reply.code(409).send({ error: "cannot delete yourself" });
    await db.delete(schema.users).where(eq(schema.users.id, id));
    return { ok: true };
  });
}
