import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import {
  COOKIE,
  clearSessionCookie,
  createSession,
  destroySession,
  hashPassword,
  requireUser,
  setSessionCookie,
  userFromToken,
  verifyPassword,
} from "../lib/auth.js";
import { env } from "../lib/env.js";
import { parseBody } from "./helpers.js";

const AVATAR_COLORS = [
  "#0079bf", "#d29034", "#519839", "#b04632", "#89609e",
  "#cd5a91", "#4bbf6b", "#00aecc", "#838c91",
];

const credsSchema = z.object({
  email: z.string().email().max(254).transform((s) => s.toLowerCase().trim()),
  password: z.string().min(8).max(200),
});

export async function authRoutes(app: FastifyInstance) {
  /** First registered user becomes instance admin. */
  app.post("/api/auth/register", async (req, reply) => {
    const body = parseBody(credsSchema.extend({ name: z.string().trim().min(1).max(80) }), req, reply);
    if (!body) return;

    const isFirst = (await db.$count(schema.users)) === 0;
    if (!isFirst && !env.allowRegistration) {
      return reply.code(403).send({ error: "registration disabled — ask an admin" });
    }

    const existing = await db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.email, body.email))
      .limit(1);
    if (existing.length) return reply.code(409).send({ error: "email already registered" });

    const [user] = await db
      .insert(schema.users)
      .values({
        email: body.email,
        name: body.name,
        passwordHash: await hashPassword(body.password),
        avatarColor: AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)],
        isAdmin: isFirst,
      })
      .returning();

    const token = await createSession(user.id);
    setSessionCookie(reply, token, req);
    return {
      user: {
        id: user.id, email: user.email, name: user.name,
        avatarColor: user.avatarColor, isAdmin: user.isAdmin, theme: user.theme,
      },
    };
  });

  app.post("/api/auth/login", async (req, reply) => {
    const body = parseBody(credsSchema, req, reply);
    if (!body) return;
    const rows = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, body.email))
      .limit(1);
    const user = rows[0];
    // constant-shape failure: verify against a dummy hash when no user
    const ok = user
      ? await verifyPassword(user.passwordHash, body.password)
      : (await hashPassword("timing-equalizer"), false);
    if (!ok || !user) return reply.code(401).send({ error: "wrong email or password" });

    const token = await createSession(user.id);
    setSessionCookie(reply, token, req);
    return {
      user: {
        id: user.id, email: user.email, name: user.name,
        avatarColor: user.avatarColor, isAdmin: user.isAdmin, theme: user.theme,
      },
    };
  });

  app.post("/api/auth/logout", async (req, reply) => {
    const token = req.cookies[COOKIE];
    if (token) await destroySession(token);
    clearSessionCookie(reply);
    return { ok: true };
  });

  app.get("/api/auth/me", async (req, reply) => {
    const user = await userFromToken(req.cookies[COOKIE]);
    if (!user) return reply.code(401).send({ error: "unauthenticated" });
    return { user };
  });

  /** profile self-service */
  app.patch("/api/auth/me", { preHandler: requireUser }, async (req, reply) => {
    const body = parseBody(
      z.object({
        name: z.string().trim().min(1).max(80).optional(),
        theme: z.enum(["system", "light", "dark"]).optional(),
        avatarColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
        password: z.string().min(8).max(200).optional(),
        currentPassword: z.string().max(200).optional(),
      }),
      req,
      reply,
    );
    if (!body) return;

    const patch: Partial<typeof schema.users.$inferInsert> = {};
    if (body.name) patch.name = body.name;
    if (body.theme) patch.theme = body.theme;
    if (body.avatarColor) patch.avatarColor = body.avatarColor;
    if (body.password) {
      const [row] = await db
        .select({ hash: schema.users.passwordHash })
        .from(schema.users)
        .where(eq(schema.users.id, req.user.id));
      if (!body.currentPassword || !(await verifyPassword(row.hash, body.currentPassword))) {
        return reply.code(403).send({ error: "current password is wrong" });
      }
      patch.passwordHash = await hashPassword(body.password);
    }
    if (Object.keys(patch).length) {
      await db.update(schema.users).set(patch).where(eq(schema.users.id, req.user.id));
    }
    const user = await userFromToken(req.cookies[COOKIE]);
    return { user };
  });
}
