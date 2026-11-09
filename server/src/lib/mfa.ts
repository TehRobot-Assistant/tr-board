/**
 * The half-signed-in state between "password (or SSO) accepted" and "TOTP
 * accepted". No session exists yet: the browser holds only a short-lived
 * ticket in an HttpOnly cookie scoped to /api/auth, and the ticket can do
 * exactly one thing, which is be exchanged for a session by
 * POST /api/auth/login/2fa with a valid code.
 *
 * Tickets live in memory (one process). A restart drops them, which only
 * means someone mid-login types their password again.
 */
import crypto from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { createSession, setSessionCookie, sha256 } from "./auth.js";
import { env } from "./env.js";
import { RateLimiter } from "./ratelimit.js";
import { matchStep, newRecoveryCode, normaliseRecoveryCode } from "./totp.js";

export const MFA_COOKIE = "trboard_mfa";
const TICKET_MS = 5 * 60_000;
/** wrong codes on one ticket before it is burned and the password is needed again */
const MAX_TICKET_ATTEMPTS = 5;
const MAX_TICKETS = 10_000;

type Ticket = { userId: string; expires: number; attempts: number };
const tickets = new Map<string, Ticket>();

/**
 * Second-step brute-force limits, the M4 pattern: only failures count, per IP
 * and per account. A 6-digit code is a 1-in-a-million guess; with 10 failures
 * per account per 15 minutes (and a fresh password step every 5), guessing
 * takes decades. Keyed by user id, not email, because the ticket already
 * says who it is.
 */
const WINDOW_MS = 15 * 60_000;
export const mfaFailsByIp = new RateLimiter(Number(process.env.MFA_MAX_FAILS_PER_IP ?? 30), WINDOW_MS);
export const mfaFailsByAccount = new RateLimiter(Number(process.env.MFA_MAX_FAILS_PER_ACCOUNT ?? 10), WINDOW_MS);

export function issueTicket(userId: string, req: FastifyRequest, reply: FastifyReply): void {
  const now = Date.now();
  if (tickets.size >= MAX_TICKETS) {
    for (const [k, t] of tickets) if (t.expires <= now) tickets.delete(k);
    for (const k of tickets.keys()) {
      if (tickets.size < MAX_TICKETS) break;
      tickets.delete(k);
    }
  }
  const raw = crypto.randomBytes(32).toString("hex");
  tickets.set(sha256(raw), { userId, expires: now + TICKET_MS, attempts: 0 });
  reply.setCookie(MFA_COOKIE, raw, {
    path: "/api/auth",
    httpOnly: true,
    sameSite: "lax", // the OIDC callback sets it on a cross-site top-level redirect
    secure: env.cookieSecure === "auto" ? req.protocol === "https" : env.cookieSecure,
    maxAge: TICKET_MS / 1000,
  });
}

export function peekTicket(req: FastifyRequest): { key: string; ticket: Ticket } | null {
  const raw = req.cookies[MFA_COOKIE];
  if (!raw || !/^[0-9a-f]{64}$/.test(raw)) return null;
  const key = sha256(raw);
  const ticket = tickets.get(key);
  if (!ticket) return null;
  if (ticket.expires <= Date.now()) {
    tickets.delete(key);
    return null;
  }
  return { key, ticket };
}

/** count a wrong code against the ticket; burns it after MAX_TICKET_ATTEMPTS */
export function failTicket(key: string): void {
  const t = tickets.get(key);
  if (!t) return;
  t.attempts += 1;
  if (t.attempts >= MAX_TICKET_ATTEMPTS) tickets.delete(key);
}

export function dropTicket(key: string, reply: FastifyReply): void {
  tickets.delete(key);
  reply.clearCookie(MFA_COOKIE, { path: "/api/auth" });
}

/** forget every pending second step (after a restore replaced the users) */
export function clearTickets(): void {
  tickets.clear();
}

/**
 * Check a TOTP code and claim its time step in one UPDATE, so the same code
 * can't be used twice, even by two requests racing each other.
 */
export async function verifyTotpFor(userId: string, secret: string, code: string): Promise<boolean> {
  const step = matchStep(secret, code.trim());
  if (step === null) return false;
  const rows = await db
    .update(schema.users)
    .set({ totpLastStep: step })
    .where(
      and(
        eq(schema.users.id, userId),
        or(isNull(schema.users.totpLastStep), lt(schema.users.totpLastStep, step)),
      ),
    )
    .returning({ id: schema.users.id });
  return rows.length === 1;
}

/** spend a recovery code (single use, atomically) */
export async function useRecoveryCode(userId: string, code: string): Promise<boolean> {
  const norm = normaliseRecoveryCode(code);
  if (norm.length !== 16) return false;
  const rows = await db
    .update(schema.recoveryCodes)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(schema.recoveryCodes.userId, userId),
        eq(schema.recoveryCodes.codeHash, sha256(norm)),
        isNull(schema.recoveryCodes.usedAt),
      ),
    )
    .returning({ id: schema.recoveryCodes.id });
  return rows.length === 1;
}

export const RECOVERY_CODE_COUNT = 10;

/** replace the user's recovery codes; returns the new plaintext codes (shown once) */
export async function regenerateRecoveryCodes(userId: string): Promise<string[]> {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);
  await db.transaction(async (tx) => {
    await tx.delete(schema.recoveryCodes).where(eq(schema.recoveryCodes.userId, userId));
    await tx
      .insert(schema.recoveryCodes)
      .values(codes.map((c) => ({ userId, codeHash: sha256(normaliseRecoveryCode(c)) })));
  });
  return codes;
}

export async function recoveryCodesLeft(userId: string): Promise<number> {
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.recoveryCodes)
    .where(and(eq(schema.recoveryCodes.userId, userId), isNull(schema.recoveryCodes.usedAt)));
  return r?.n ?? 0;
}

/**
 * The end of every successful primary sign-in (password or SSO). With TOTP on
 * the account, no session is made: a ticket is issued and the caller tells the
 * browser to ask for a code. Returns whether a session was created.
 */
export async function finishPrimaryLogin(
  user: { id: string; totpEnabledAt: Date | null },
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<"session" | "second_factor"> {
  if (user.totpEnabledAt) {
    issueTicket(user.id, req, reply);
    return "second_factor";
  }
  const token = await createSession(user.id);
  setSessionCookie(reply, token, req);
  return "session";
}

/** SSO-only accounts get this instead of an argon2 hash: no password can match it */
export const NO_PASSWORD = "!sso-only";
export const hasPassword = (hash: string) => hash.startsWith("$argon2");
