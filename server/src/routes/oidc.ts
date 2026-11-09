/**
 * OIDC single sign-on (authorization code + PKCE), via openid-client, which
 * does the discovery, state/nonce/PKCE checks and ID token validation
 * (signature, iss, aud, exp, nonce). Configured entirely by env (lib/env.ts).
 *
 *   GET /api/auth/oidc/start     -> 302 to the IdP
 *   GET /api/auth/oidc/callback  -> 302 to / (signed in), /login?mfa=1 (TOTP
 *                                   step), or /login?sso_error=<reason>
 *
 * Who gets in:
 *   1. an account already linked to this (issuer, subject);
 *   2. else an existing account whose email matches the IdP's email, only if
 *      the IdP says that email is verified. The account is then linked, so
 *      later logins go by subject and survive an email change at the IdP. An
 *      account already linked to a different subject is refused: otherwise a
 *      second IdP identity claiming the same email could take it over;
 *   3. else nobody, unless OIDC_AUTO_PROVISION=true AND registration is open
 *      (ALLOW_REGISTRATION=true, or this is the first account). Invite-only
 *      stays invite-only with SSO on.
 * After that, the account's own TOTP still applies (finishPrimaryLogin): SSO
 * replaces the password step, not the second factor.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import * as oidc from "openid-client";
import { eq, and, isNull, sql } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { env } from "../lib/env.js";
import { RateLimiter } from "../lib/ratelimit.js";
import { finishPrimaryLogin, NO_PASSWORD } from "../lib/mfa.js";

const STATE_COOKIE = "trboard_oidc";
const PENDING_MS = 10 * 60_000;
const MAX_PENDING = 5_000;
const startsByIp = new RateLimiter(60, 15 * 60_000);

type Pending = { verifier: string; nonce: string; expires: number };
const pending = new Map<string, Pending>();

let cached: { config: oidc.Configuration; at: number } | null = null;

/**
 * Discovery runs on first use, not at boot, so an IdP that's down doesn't
 * stop the board from starting (password login keeps working). Re-discovered
 * hourly so rotated endpoints/keys are picked up; a failure isn't cached.
 */
async function config(): Promise<oidc.Configuration> {
  if (cached && Date.now() - cached.at < 3600_000) return cached.config;
  const o = env.oidc;
  const auth = o.tokenAuthMethod === "client_secret_post" ? oidc.ClientSecretPost(o.clientSecret) : oidc.ClientSecretBasic(o.clientSecret);
  const c = await oidc.discovery(new URL(o.issuer), o.clientId, undefined, auth, {
    execute: o.allowInsecure ? [oidc.allowInsecureRequests] : [],
    timeout: 10,
  });
  cached = { config: c, at: Date.now() };
  return c;
}

const toLogin = (reply: FastifyReply, reason: string) =>
  reply.redirect(`/login?sso_error=${encodeURIComponent(reason)}`, 302);

function cookieOpts(req: FastifyRequest) {
  return {
    path: "/api/auth/oidc",
    httpOnly: true,
    // Lax, not Strict: the IdP sends the browser back with a cross-site
    // top-level GET, and Strict would leave the cookie off that request.
    sameSite: "lax" as const,
    secure: env.cookieSecure === "auto" ? req.protocol === "https" : env.cookieSecure,
    maxAge: PENDING_MS / 1000,
  };
}

/** some IdPs (e.g. Cognito) send email_verified as the string "true" */
const isTrue = (v: unknown) => v === true || v === "true";

export async function oidcRoutes(app: FastifyInstance) {
  app.get("/api/auth/oidc/start", async (req, reply) => {
    if (!env.oidc.enabled) return reply.code(404).send({ error: "not found" });
    if (startsByIp.hit(req.ip)) return toLogin(reply, "rate_limited");
    let c: oidc.Configuration;
    try {
      c = await config();
    } catch (err) {
      req.log.error({ err }, "OIDC discovery failed");
      return toLogin(reply, "unavailable");
    }
    const now = Date.now();
    if (pending.size >= MAX_PENDING) {
      for (const [k, p] of pending) if (p.expires <= now) pending.delete(k);
      for (const k of pending.keys()) {
        if (pending.size < MAX_PENDING) break;
        pending.delete(k);
      }
    }
    const state = oidc.randomState();
    const verifier = oidc.randomPKCECodeVerifier();
    const nonce = oidc.randomNonce();
    pending.set(state, { verifier, nonce, expires: now + PENDING_MS });
    reply.setCookie(STATE_COOKIE, state, cookieOpts(req));
    const url = oidc.buildAuthorizationUrl(c, {
      redirect_uri: env.oidc.redirectUri,
      scope: env.oidc.scopes,
      state,
      nonce,
      code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
      code_challenge_method: "S256",
    });
    return reply.redirect(url.href, 302);
  });

  app.get("/api/auth/oidc/callback", async (req, reply) => {
    if (!env.oidc.enabled) return reply.code(404).send({ error: "not found" });
    const state = req.cookies[STATE_COOKIE];
    reply.clearCookie(STATE_COOKIE, { path: "/api/auth/oidc" });
    const p = state ? pending.get(state) : undefined;
    if (state) pending.delete(state); // single use, whatever happens next
    if (!state || !p || p.expires <= Date.now()) return toLogin(reply, "expired");

    let claims: Record<string, unknown>;
    let issuer: string;
    try {
      const c = await config();
      // Built from the configured redirect URI, not the Host header: it has
      // to match what was registered at the IdP, and Host is client-supplied.
      const current = new URL(env.oidc.redirectUri);
      current.search = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
      const tokens = await oidc.authorizationCodeGrant(c, current, {
        pkceCodeVerifier: p.verifier,
        expectedState: state,
        expectedNonce: p.nonce,
        idTokenExpected: true,
      });
      const idClaims = tokens.claims()!;
      issuer = String(idClaims.iss);
      claims = { ...idClaims };
      // Authelia (and others) leave email out of the ID token; ask userinfo.
      if ((claims.email === undefined || claims.email_verified === undefined) && tokens.access_token) {
        const info = await oidc.fetchUserInfo(c, tokens.access_token, String(idClaims.sub));
        claims = { ...info, ...idClaims, email: idClaims.email ?? info.email, email_verified: idClaims.email_verified ?? info.email_verified };
      }
    } catch (err) {
      req.log.warn({ err }, "OIDC callback rejected");
      return toLogin(reply, "failed");
    }

    const sub = String(claims.sub);
    const email = typeof claims.email === "string" ? claims.email.toLowerCase().trim() : "";
    const verified = isTrue(claims.email_verified);

    // 1. already linked
    let [user] = await db
      .select()
      .from(schema.users)
      .where(and(eq(schema.users.oidcIssuer, issuer), eq(schema.users.oidcSubject, sub)));

    if (!user) {
      if (!email || !verified) return toLogin(reply, "email_unverified");
      const [byEmail] = await db.select().from(schema.users).where(eq(schema.users.email, email));
      if (byEmail) {
        // 2. link by verified email, only if not bound to another identity
        if (byEmail.oidcSubject) return toLogin(reply, "identity_mismatch");
        const [linked] = await db
          .update(schema.users)
          .set({ oidcIssuer: issuer, oidcSubject: sub })
          .where(and(eq(schema.users.id, byEmail.id), isNull(schema.users.oidcSubject)))
          .returning();
        if (!linked) return toLogin(reply, "identity_mismatch"); // lost a race to another link
        user = linked;
      } else {
        // 3. auto-provision: flag AND open registration, same lock as /register
        if (!env.oidc.autoProvision) return toLogin(reply, "no_account");
        const name =
          (typeof claims.name === "string" && claims.name.trim()) ||
          (typeof claims.preferred_username === "string" && claims.preferred_username.trim()) ||
          email.split("@")[0];
        const created = await db.transaction(async (tx) => {
          await tx.execute(sql`select pg_advisory_xact_lock(hashtext('trboard:register'))`);
          const isFirst = (await tx.$count(schema.users)) === 0;
          if (!isFirst && !env.allowRegistration) return null;
          const [u] = await tx
            .insert(schema.users)
            .values({
              email, name: name.slice(0, 80), passwordHash: NO_PASSWORD, isAdmin: isFirst,
              oidcIssuer: issuer, oidcSubject: sub,
            })
            .onConflictDoNothing()
            .returning();
          return u ?? null;
        });
        if (!created) return toLogin(reply, "no_account");
        user = created;
      }
    }

    const outcome = await finishPrimaryLogin(user, req, reply);
    return reply.redirect(outcome === "second_factor" ? "/login?mfa=1" : "/", 302);
  });
}
