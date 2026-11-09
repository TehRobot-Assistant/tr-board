/**
 * Session auth — random 256-bit bearer token in an HttpOnly cookie, stored
 * server-side as a sha256 hash (a DB leak can't replay sessions). argon2id
 * for passwords.
 */
import crypto from "node:crypto";
import argon2 from "argon2";
import { and, eq, lt, ne } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import { db, schema } from "../db/client.js";
import { env } from "./env.js";
import { getSettings } from "./settings.js";

export const COOKIE = "trboard_session";

/**
 * argon2 concurrency cap (review M4). Each hash takes 19 MiB and real CPU, and
 * libuv only has 4 threads, so a flood of logins used to queue unboundedly in
 * memory and starve every other request that needs the threadpool (fs,
 * dns). At most HASH_SLOTS run at once; up to HASH_QUEUE wait; past that the
 * caller gets HashBusyError and the route answers 503 instead of piling on.
 */
const HASH_SLOTS = 2;
const HASH_QUEUE = 32;
let hashActive = 0;
const hashWaiters: Array<() => void> = [];

export class HashBusyError extends Error {
  constructor() {
    super("server busy, try again shortly");
  }
}

async function withHashSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (hashActive >= HASH_SLOTS) {
    if (hashWaiters.length >= HASH_QUEUE) throw new HashBusyError();
    await new Promise<void>((resolve) => hashWaiters.push(resolve));
  } else {
    hashActive++;
  }
  try {
    return await fn();
  } finally {
    // hand the slot straight to the next waiter (hashActive stays the same)
    const next = hashWaiters.shift();
    if (next) next();
    else hashActive--;
  }
}

export async function hashPassword(pw: string): Promise<string> {
  return withHashSlot(() => argon2.hash(pw, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2 }));
}

export async function verifyPassword(hash: string, pw: string): Promise<boolean> {
  return withHashSlot(async () => {
    try {
      return await argon2.verify(hash, pw);
    } catch {
      return false;
    }
  });
}

export const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

export async function createSession(userId: string): Promise<string> {
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + env.sessionDays * 86400_000);
  await db.insert(schema.sessions).values({ tokenHash: sha256(token), userId, expiresAt });
  // opportunistic sweep of expired sessions
  db.delete(schema.sessions).where(lt(schema.sessions.expiresAt, new Date())).catch(() => {});
  return token;
}

export async function destroySession(token: string): Promise<void> {
  await db.delete(schema.sessions).where(eq(schema.sessions.tokenHash, sha256(token)));
}

/** M5: drop every session of a user except (optionally) the caller's own. Returns the deleted hashes. */
export async function destroyOtherSessions(userId: string, keepToken?: string): Promise<string[]> {
  const rows = await db
    .delete(schema.sessions)
    .where(
      keepToken
        ? and(eq(schema.sessions.userId, userId), ne(schema.sessions.tokenHash, sha256(keepToken)))
        : eq(schema.sessions.userId, userId),
    )
    .returning({ tokenHash: schema.sessions.tokenHash });
  return rows.map((r) => r.tokenHash);
}

export type SessionUser = {
  id: string;
  email: string;
  name: string;
  avatarColor: string;
  isAdmin: boolean;
  theme: string;
  totpEnabled: boolean;
};

export async function userFromToken(token: string | undefined): Promise<SessionUser | null> {
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
  return userFromTokenHash(sha256(token));
}

/** Same lookup by stored hash: sockets keep only the hash (M1 revalidation). */
export async function userFromTokenHash(tokenHash: string): Promise<SessionUser | null> {
  const rows = await db
    .select({
      id: schema.users.id,
      email: schema.users.email,
      name: schema.users.name,
      avatarColor: schema.users.avatarColor,
      isAdmin: schema.users.isAdmin,
      theme: schema.users.theme,
      totpEnabledAt: schema.users.totpEnabledAt,
      expiresAt: schema.sessions.expiresAt,
    })
    .from(schema.sessions)
    .innerJoin(schema.users, eq(schema.users.id, schema.sessions.userId))
    .where(eq(schema.sessions.tokenHash, tokenHash))
    .limit(1);
  const row = rows[0];
  if (!row || row.expiresAt.getTime() < Date.now()) return null;
  const { expiresAt: _e, totpEnabledAt, ...user } = row;
  return { ...user, totpEnabled: !!totpEnabledAt };
}

/**
 * Instance-wide "require 2FA" (admin setting): an account without TOTP may
 * still sign in, but its session can only reach /api/auth/* (me, logout and
 * the 2FA enrolment routes) until it enrols. Checked per request rather than
 * stamped on the session, so switching the setting on restricts sessions that
 * already exist, and every other way in (sockets, calendar feeds) asks the
 * same question here.
 */
export async function mustEnrol2fa(user: { totpEnabled: boolean }): Promise<boolean> {
  return !user.totpEnabled && (await getSettings()).require2fa;
}

export function setSessionCookie(reply: FastifyReply, token: string, req: FastifyRequest) {
  reply.setCookie(COOKIE, token, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    // M3: plain-http LAN use must keep working, so the default is "Secure when
    // the request was https". Behind a proxy that only works with TRUST_PROXY
    // (so X-Forwarded-Proto counts); COOKIE_SECURE=true forces it. See env.ts.
    secure: env.cookieSecure === "auto" ? req.protocol === "https" : env.cookieSecure,
    maxAge: env.sessionDays * 86400,
  });
}

export function clearSessionCookie(reply: FastifyReply) {
  reply.clearCookie(COOKIE, { path: "/" });
}

declare module "fastify" {
  interface FastifyRequest {
    user: SessionUser; // populated by the auth preHandler on protected routes
  }
}

/** preHandler for all /api routes except /api/auth/* */
export async function requireUser(req: FastifyRequest, reply: FastifyReply) {
  const user = await userFromToken(req.cookies[COOKIE]);
  if (!user) {
    reply.code(401).send({ error: "unauthenticated" });
    return reply;
  }
  if (await mustEnrol2fa(user)) {
    reply.code(403).send({ error: "two-factor authentication is required: set it up first", code: "2fa_enrolment_required" });
    return reply;
  }
  req.user = user;
}

/** like requireUser, but lets a not-yet-enrolled session through (2FA setup, profile) */
export async function requireUserAllowEnrol(req: FastifyRequest, reply: FastifyReply) {
  const user = await userFromToken(req.cookies[COOKIE]);
  if (!user) {
    reply.code(401).send({ error: "unauthenticated" });
    return reply;
  }
  req.user = user;
}
