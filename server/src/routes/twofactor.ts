/**
 * TOTP two-factor: the second login step and self-service enrolment.
 *
 *   POST /api/auth/login/2fa          ticket cookie + code (or recovery code) -> session
 *   GET  /api/auth/2fa                status
 *   POST /api/auth/2fa/setup          new pending secret + QR code
 *   POST /api/auth/2fa/enable         first code proves the app has it -> on, recovery codes
 *   POST /api/auth/2fa/disable        needs the password (SSO-only accounts: a code)
 *   POST /api/auth/2fa/recovery-codes new set, same re-auth as disable
 *
 * The management routes accept a session that is still waiting for
 * enrolment (instance "require 2FA"), because enrolling is the one thing that
 * session must be able to do.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { renderSVG } from "uqr";
import { db, schema } from "../db/client.js";
import { createSession, requireUserAllowEnrol, setSessionCookie, verifyPassword } from "../lib/auth.js";
import {
  dropTicket, failTicket, hasPassword, mfaFailsByAccount, mfaFailsByIp, peekTicket,
  recoveryCodesLeft, regenerateRecoveryCodes, useRecoveryCode, verifyTotpFor,
} from "../lib/mfa.js";
import { getSettings } from "../lib/settings.js";
import { matchStep, newSecret, otpauthUrl } from "../lib/totp.js";
import { parseBody } from "./helpers.js";

const tooMany = (reply: FastifyReply) =>
  reply.code(429).send({ error: "too many wrong codes, try again in 15 minutes" });

async function loadUser(id: string) {
  const [u] = await db.select().from(schema.users).where(eq(schema.users.id, id));
  return u;
}

/**
 * Re-authentication for turning 2FA off or replacing recovery codes: the
 * password, as asked. Accounts created by SSO have no password, so for those
 * a current TOTP code stands in. Failures share the second-step limiter, so
 * this can't be used to guess the password faster than the login can.
 */
async function reauth(
  req: FastifyRequest,
  reply: FastifyReply,
  user: typeof schema.users.$inferSelect,
  body: { password?: string; code?: string },
): Promise<boolean> {
  if (mfaFailsByIp.blocked(req.ip) || mfaFailsByAccount.blocked(user.id)) {
    tooMany(reply);
    return false;
  }
  const ok = hasPassword(user.passwordHash)
    ? !!body.password && (await verifyPassword(user.passwordHash, body.password))
    : !!body.code && !!user.totpSecret && (await verifyTotpFor(user.id, user.totpSecret, body.code));
  if (!ok) {
    mfaFailsByIp.hit(req.ip);
    mfaFailsByAccount.hit(user.id);
    reply.code(403).send({ error: hasPassword(user.passwordHash) ? "password is wrong" : "code is wrong" });
  }
  return ok;
}

export async function twoFactorRoutes(app: FastifyInstance) {
  app.post("/api/auth/login/2fa", async (req, reply) => {
    const body = parseBody(
      z.object({ code: z.string().max(12).optional(), recoveryCode: z.string().max(40).optional() }),
      req,
      reply,
    );
    if (!body) return;
    const held = peekTicket(req);
    if (!held) return reply.code(401).send({ error: "sign-in expired, enter your password again" });
    const { key, ticket } = held;
    if (mfaFailsByIp.blocked(req.ip) || mfaFailsByAccount.blocked(ticket.userId)) return tooMany(reply);

    const user = await loadUser(ticket.userId);
    if (!user) {
      dropTicket(key, reply);
      return reply.code(401).send({ error: "sign-in expired, enter your password again" });
    }
    // An admin may have reset this account's 2FA after the password step; the
    // password was already checked, so there is no second factor left to ask.
    let ok = !user.totpEnabledAt;
    if (!ok && body.code) ok = await verifyTotpFor(user.id, user.totpSecret!, body.code);
    else if (!ok && body.recoveryCode) ok = await useRecoveryCode(user.id, body.recoveryCode);
    if (!ok) {
      mfaFailsByIp.hit(req.ip);
      mfaFailsByAccount.hit(user.id);
      failTicket(key);
      return reply.code(401).send({ error: "wrong code" });
    }
    dropTicket(key, reply);
    mfaFailsByAccount.reset(user.id);
    const token = await createSession(user.id);
    setSessionCookie(reply, token, req);
    return {
      user: {
        id: user.id, email: user.email, name: user.name,
        avatarColor: user.avatarColor, isAdmin: user.isAdmin, theme: user.theme,
      },
      recoveryCodesLeft: body.recoveryCode ? await recoveryCodesLeft(user.id) : undefined,
    };
  });

  await app.register(async (secured) => {
    secured.addHook("preHandler", requireUserAllowEnrol);

    secured.get("/api/auth/2fa", async (req) => {
      const user = await loadUser(req.user.id);
      return {
        enabled: !!user.totpEnabledAt,
        enabledAt: user.totpEnabledAt,
        recoveryCodesLeft: user.totpEnabledAt ? await recoveryCodesLeft(user.id) : 0,
        required: (await getSettings()).require2fa,
        hasPassword: hasPassword(user.passwordHash),
      };
    });

    secured.post("/api/auth/2fa/setup", async (req, reply) => {
      const user = await loadUser(req.user.id);
      if (user.totpEnabledAt) return reply.code(409).send({ error: "two-factor is already on; turn it off first" });
      const secret = newSecret();
      await db.update(schema.users).set({ totpPendingSecret: secret }).where(eq(schema.users.id, user.id));
      const url = otpauthUrl(secret, user.email);
      // QR drawn here, not in the browser, so the web bundle needs no QR code;
      // the client shows it as an <img> data URI (no innerHTML).
      return { secret, otpauthUrl: url, qrSvg: renderSVG(url, { border: 2 }) };
    });

    secured.post("/api/auth/2fa/enable", async (req, reply) => {
      const body = parseBody(z.object({ code: z.string().max(12) }), req, reply);
      if (!body) return;
      if (mfaFailsByIp.blocked(req.ip) || mfaFailsByAccount.blocked(req.user.id)) return tooMany(reply);
      const user = await loadUser(req.user.id);
      if (user.totpEnabledAt) return reply.code(409).send({ error: "two-factor is already on" });
      if (!user.totpPendingSecret) return reply.code(400).send({ error: "start the setup first" });
      const step = matchStep(user.totpPendingSecret, body.code.trim());
      if (step === null) {
        mfaFailsByIp.hit(req.ip);
        mfaFailsByAccount.hit(user.id);
        return reply.code(400).send({ error: "that code doesn't match; check the time on your phone and try again" });
      }
      await db
        .update(schema.users)
        .set({ totpSecret: user.totpPendingSecret, totpPendingSecret: null, totpEnabledAt: new Date(), totpLastStep: step })
        .where(eq(schema.users.id, user.id));
      const recoveryCodes = await regenerateRecoveryCodes(user.id);
      return { enabled: true, recoveryCodes };
    });

    secured.post("/api/auth/2fa/disable", async (req, reply) => {
      const body = parseBody(z.object({ password: z.string().max(200).optional(), code: z.string().max(12).optional() }), req, reply);
      if (!body) return;
      const user = await loadUser(req.user.id);
      if (!user.totpEnabledAt) return { enabled: false };
      if ((await getSettings()).require2fa) {
        return reply.code(409).send({ error: "this instance requires two-factor; an admin can reset it instead" });
      }
      if (!(await reauth(req, reply, user, body))) return;
      await db
        .update(schema.users)
        .set({ totpSecret: null, totpPendingSecret: null, totpEnabledAt: null, totpLastStep: null })
        .where(eq(schema.users.id, user.id));
      await db.delete(schema.recoveryCodes).where(eq(schema.recoveryCodes.userId, user.id));
      return { enabled: false };
    });

    secured.post("/api/auth/2fa/recovery-codes", async (req, reply) => {
      const body = parseBody(z.object({ password: z.string().max(200).optional(), code: z.string().max(12).optional() }), req, reply);
      if (!body) return;
      const user = await loadUser(req.user.id);
      if (!user.totpEnabledAt) return reply.code(400).send({ error: "two-factor is off" });
      if (!(await reauth(req, reply, user, body))) return;
      return { recoveryCodes: await regenerateRecoveryCodes(user.id) };
    });
  });
}
