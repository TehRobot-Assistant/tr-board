import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq, sql } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import {
  COOKIE,
  clearSessionCookie,
  createSession,
  destroyOtherSessions,
  destroySession,
  hashPassword,
  setSessionCookie,
  userFromToken,
  verifyPassword,
  sha256,
} from "../lib/auth.js";
import { env } from "../lib/env.js";
import { RateLimiter } from "../lib/ratelimit.js";
import { disconnectSessions } from "../sockets/index.js";
import { parseBody } from "./helpers.js";
import { finishPrimaryLogin } from "../lib/mfa.js";
import { mustEnrol2fa, requireUserAllowEnrol } from "../lib/auth.js";

/**
 * M4: brute-force limits. Only FAILED sign-ins count, so normal use never
 * trips them. Per IP (needs TRUST_PROXY behind a proxy, see M3) and per
 * account; the per-account limit is what stops a slow spread-out guess at one
 * password, at the cost that someone can keep a known email locked out by
 * failing on purpose (it unlocks itself after the window). A blocked attempt
 * is answered before argon2 runs, so floods stop costing CPU/memory.
 */
const LOGIN_WINDOW_MS = 15 * 60_000;
const loginFailsByIp = new RateLimiter(Number(process.env.LOGIN_MAX_FAILS_PER_IP ?? 30), LOGIN_WINDOW_MS);
const loginFailsByAccount = new RateLimiter(Number(process.env.LOGIN_MAX_FAILS_PER_ACCOUNT ?? 10), LOGIN_WINDOW_MS);
/** every registration attempt counts (open registration answers 409 for taken emails) */
const registerByIp = new RateLimiter(10, 60 * 60_000);

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

    const closed = () =>
      reply.code(403).send({ error: "registration is invite-only: ask an admin to create your account" });
    if (registerByIp.hit(req.ip)) {
      return reply.code(429).send({ error: "too many sign-up attempts, try again later" });
    }
    // Cheap early reject so a closed instance doesn't run argon2 for every probe.
    if (!env.allowRegistration && (await db.$count(schema.users)) > 0) return closed();

    // Hash before taking the lock so the serialised section stays short.
    const passwordHash = await hashPassword(body.password);

    // "First user becomes admin" is check-then-insert; with registration now
    // closed by default, losing that race would mean two instance admins or a
    // stray account. A transaction-scoped advisory lock serialises the check
    // and the insert (also fixes L8).
    const result = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('trboard:register'))`);
      const isFirst = (await tx.$count(schema.users)) === 0;
      if (!isFirst && !env.allowRegistration) return { error: 403 as const };
      const existing = await tx
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(eq(schema.users.email, body.email))
        .limit(1);
      if (existing.length) return { error: 409 as const };
      const [user] = await tx
        .insert(schema.users)
        .values({
          email: body.email,
          name: body.name,
          passwordHash,
          avatarColor: AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)],
          isAdmin: isFirst,
        })
        .returning();
      return { user };
    });
    if ("error" in result) {
      return result.error === 403
        ? closed()
        : reply.code(409).send({ error: "email already registered" });
    }
    const { user } = result;

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
    if (loginFailsByIp.blocked(req.ip) || loginFailsByAccount.blocked(body.email)) {
      return reply.code(429).send({ error: "too many failed sign-ins, try again in 15 minutes" });
    }
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
    if (!ok || !user) {
      loginFailsByIp.hit(req.ip);
      loginFailsByAccount.hit(body.email);
      return reply.code(401).send({ error: "wrong email or password" });
    }
    loginFailsByAccount.reset(body.email);

    // 2FA: a correct password alone never yields a session when TOTP is on;
    // the browser gets a 5-minute ticket for POST /api/auth/login/2fa instead.
    if ((await finishPrimaryLogin(user, req, reply)) === "second_factor") {
      return { twoFactorRequired: true };
    }
    return {
      user: {
        id: user.id, email: user.email, name: user.name,
        avatarColor: user.avatarColor, isAdmin: user.isAdmin, theme: user.theme,
      },
    };
  });

  app.post("/api/auth/logout", async (req, reply) => {
    const token = req.cookies[COOKIE];
    if (token) {
      await destroySession(token);
      // M1: the socket of this session kept receiving board events after logout
      if (/^[0-9a-f]{64}$/.test(token)) disconnectSessions([sha256(token)]);
    }
    clearSessionCookie(reply);
    return { ok: true };
  });

  app.get("/api/auth/me", async (req, reply) => {
    const user = await userFromToken(req.cookies[COOKIE]);
    if (!user) return reply.code(401).send({ error: "unauthenticated" });
    // mustEnrol2fa: the client shows the enrolment screen instead of the app
    return { user: { ...user, mustEnrol2fa: await mustEnrol2fa(user) } };
  });

  /** what the login page needs to know before anyone is signed in */
  app.get("/api/auth/config", async () => ({
    registrationOpen: env.allowRegistration || (await db.$count(schema.users)) === 0,
    oidc: env.oidc.enabled ? { enabled: true, label: env.oidc.buttonLabel } : { enabled: false },
  }));

  /** profile self-service (allowed while 2FA enrolment is pending: theme, name, password) */
  app.patch("/api/auth/me", { preHandler: requireUserAllowEnrol }, async (req, reply) => {
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
    if (patch.passwordHash) {
      // M5: a new password ends every OTHER session (a stolen cookie is the
      // usual reason to change it), and their sockets. This one stays signed in.
      disconnectSessions(await destroyOtherSessions(req.user.id, req.cookies[COOKIE]));
    }
    const user = await userFromToken(req.cookies[COOKIE]);
    return { user: user && { ...user, mustEnrol2fa: await mustEnrol2fa(user) } };
  });
}
