/**
 * Session auth — random 256-bit bearer token in an HttpOnly cookie, stored
 * server-side as a sha256 hash (a DB leak can't replay sessions). argon2id
 * for passwords.
 */
import crypto from "node:crypto";
import argon2 from "argon2";
import { eq, lt } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import { db, schema } from "../db/client.js";
import { env } from "./env.js";

export const COOKIE = "trboard_session";

export async function hashPassword(pw: string): Promise<string> {
  return argon2.hash(pw, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2 });
}

export async function verifyPassword(hash: string, pw: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, pw);
  } catch {
    return false;
  }
}

const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

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

export type SessionUser = {
  id: string;
  email: string;
  name: string;
  avatarColor: string;
  isAdmin: boolean;
  theme: string;
};

export async function userFromToken(token: string | undefined): Promise<SessionUser | null> {
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
  const rows = await db
    .select({
      id: schema.users.id,
      email: schema.users.email,
      name: schema.users.name,
      avatarColor: schema.users.avatarColor,
      isAdmin: schema.users.isAdmin,
      theme: schema.users.theme,
      expiresAt: schema.sessions.expiresAt,
    })
    .from(schema.sessions)
    .innerJoin(schema.users, eq(schema.users.id, schema.sessions.userId))
    .where(eq(schema.sessions.tokenHash, sha256(token)))
    .limit(1);
  const row = rows[0];
  if (!row || row.expiresAt.getTime() < Date.now()) return null;
  const { expiresAt: _e, ...user } = row;
  return user;
}

export function setSessionCookie(reply: FastifyReply, token: string, req: FastifyRequest) {
  reply.setCookie(COOKIE, token, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    // Secure only when actually on https — plain-http LAN previews must keep the cookie
    secure: req.protocol === "https",
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
  req.user = user;
}
