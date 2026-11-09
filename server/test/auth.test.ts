/**
 * Nov 2026 features, part 2: TOTP two-factor and OIDC single sign-on.
 * The IdP is a tiny in-process OIDC provider (discovery, authorize, token
 * with PKCE check, userinfo, JWKS) signing real RS256 ID tokens, so
 * openid-client runs its full validation against it.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { client, connectSocket, startHarness, type Harness } from "./harness.js";
import { base32Decode, hotp, stepAt } from "../src/lib/totp.js";

let h: Harness;
let api: ReturnType<typeof client>;
let root: { id: string; cookie: string };
let ipSeq = 1;
const ip = () => ({ "x-forwarded-for": `192.0.2.${ipSeq++ % 250}` });

type U = { id: string; email: string; cookie: string };

async function login(email: string, password = "password123") {
  return api.post("/api/auth/login", { email, password }, undefined, ip());
}
async function makeUser(label: string, isAdmin = false): Promise<U> {
  const email = `${label}-${crypto.randomBytes(3).toString("hex")}@test.local`;
  const r = await api.post("/api/admin/users", { email, name: label, password: "password123", isAdmin }, root.cookie);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const l = await login(email);
  return { id: r.body.user.id, email, cookie: l.cookie! };
}
const code = (secret: string, offset = 0) => hotp(base32Decode(secret), stepAt(Date.now()) + offset);

/** enrol a user; the enabling code consumes the current step */
async function enrol(u: U): Promise<{ secret: string; recovery: string[] }> {
  const s = await api.post("/api/auth/2fa/setup", {}, u.cookie);
  assert.equal(s.status, 200);
  assert.match(s.body.otpauthUrl, /^otpauth:\/\/totp\//);
  assert.match(s.body.qrSvg, /^<svg/);
  const e = await api.post("/api/auth/2fa/enable", { code: code(s.body.secret) }, u.cookie);
  assert.equal(e.status, 200, JSON.stringify(e.body));
  return { secret: s.body.secret, recovery: e.body.recoveryCodes };
}

const sessionCookieIn = (setCookie?: string) => !!setCookie && /trboard_session=[0-9a-f]{64}/.test(setCookie);
const sessionCookie = (setCookie?: string) => /trboard_session=[0-9a-f]{64}/.exec(setCookie ?? "")?.[0];

/** password step: returns the ticket cookie (no session) */
async function passwordStep(email: string): Promise<string> {
  const r = await login(email);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { twoFactorRequired: true });
  assert.equal(sessionCookieIn(r.setCookie), false, "password alone must not create a session");
  assert.match(r.cookie!, /^trboard_mfa=/);
  return r.cookie!;
}
const secondStep = (ticket: string, body: Record<string, string>) => api.post("/api/auth/login/2fa", body, ticket, ip());

before(async () => {
  h = await startHarness({ TRUST_PROXY: "loopback" });
  api = client(h.base);
  const reg = await api.post("/api/auth/register", { email: "root@test.local", name: "Root", password: "password123" }, undefined, ip());
  root = { id: reg.body.user.id, cookie: reg.cookie! };
});
after(async () => {
  await h?.stop();
  await new Promise((r) => idp?.close(r));
});

/* ------------------------------------------------------------------- TOTP */

describe("TOTP enrolment and the two-step login", () => {
  test("enrol: wrong code refused, right code enables and returns 10 recovery codes", async () => {
    const u = await makeUser("t1");
    const s = await api.post("/api/auth/2fa/setup", {}, u.cookie);
    assert.equal((await api.post("/api/auth/2fa/enable", { code: "000000" === code(s.body.secret) ? "111111" : "000000" }, u.cookie)).status, 400);
    const e = await api.post("/api/auth/2fa/enable", { code: code(s.body.secret) }, u.cookie);
    assert.equal(e.body.recoveryCodes.length, 10);
    const st = (await api.get("/api/auth/2fa", u.cookie)).body;
    assert.equal(st.enabled, true);
    assert.equal(st.recoveryCodesLeft, 10);
    assert.equal((await api.post("/api/auth/2fa/setup", {}, u.cookie)).status, 409);
  });

  test("bypass attempts: ticket isn't a session, no ticket, replayed code, burned ticket", async () => {
    const u = await makeUser("t2");
    const { secret } = await enrol(u);
    const ticket = await passwordStep(u.email);
    const raw = ticket.split("=")[1];
    // the ticket value presented as a session cookie
    assert.equal((await api.get("/api/auth/me", `trboard_session=${raw}`)).status, 401);
    assert.equal((await api.get("/api/workspaces", `trboard_session=${raw}`)).status, 401);
    // second step with no ticket / a made-up ticket
    assert.equal((await secondStep("", { code: code(secret, 1) })).status, 401);
    assert.equal((await secondStep(`trboard_mfa=${"a".repeat(64)}`, { code: code(secret, 1) })).status, 401);
    // the code used to enable is spent (replay inside its 30 s window)
    assert.equal((await secondStep(ticket, { code: code(secret) })).status, 401);
    // empty body / non-numeric
    assert.equal((await secondStep(ticket, {})).status, 401);
    assert.equal((await secondStep(ticket, { code: "12345a" })).status, 401);
    const ok = await secondStep(ticket, { code: code(secret, 1) });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.ok(sessionCookieIn(ok.setCookie));
    assert.equal((await api.get("/api/auth/me", sessionCookie(ok.setCookie))).body.user.id, u.id);
    // the ticket is single use, and the same code can't be used again on a new ticket
    assert.equal((await secondStep(ticket, { code: code(secret, 1) })).status, 401);
    assert.equal((await secondStep(await passwordStep(u.email), { code: code(secret, 1) })).status, 401);
  });

  test("a ticket burns after 5 wrong codes", async () => {
    const u = await makeUser("t3");
    const { secret } = await enrol(u);
    const ticket = await passwordStep(u.email);
    const wrong = String((Number(code(secret, 1)) + 1) % 1_000_000).padStart(6, "0");
    for (let i = 0; i < 5; i++) assert.equal((await secondStep(ticket, { code: wrong })).status, 401);
    const r = await secondStep(ticket, { code: code(secret, 1) });
    assert.equal(r.status, 401);
    assert.match(r.body.error, /expired/);
  });

  test("per-account limit: after 10 wrong codes even the right one gets 429", async () => {
    const u = await makeUser("t4");
    const { secret } = await enrol(u);
    const wrong = "999999" === code(secret, 1) ? "888888" : "999999";
    for (let t = 0; t < 2; t++) {
      const ticket = await passwordStep(u.email);
      for (let i = 0; i < 5; i++) await secondStep(ticket, { code: wrong });
    }
    const r = await secondStep(await passwordStep(u.email), { code: code(secret, 1) });
    assert.equal(r.status, 429);
  });

  test("recovery codes work once each", async () => {
    const u = await makeUser("t5");
    const { recovery } = await enrol(u);
    const r = await secondStep(await passwordStep(u.email), { recoveryCode: recovery[0].toUpperCase() });
    assert.equal(r.status, 200);
    assert.equal(r.body.recoveryCodesLeft, 9);
    assert.equal((await secondStep(await passwordStep(u.email), { recoveryCode: recovery[0] })).status, 401);
  });

  test("disable needs the password; afterwards login is one step", async () => {
    const u = await makeUser("t6");
    await enrol(u);
    assert.equal((await api.post("/api/auth/2fa/disable", { password: "wrong-password" }, u.cookie, ip())).status, 403);
    assert.equal((await api.post("/api/auth/2fa/disable", {}, u.cookie, ip())).status, 403);
    assert.equal((await api.post("/api/auth/2fa/disable", { password: "password123" }, u.cookie, ip())).status, 200);
    const l = await login(u.email);
    assert.ok(sessionCookieIn(l.setCookie));
    assert.equal(Number((await h.sql`select count(*)::int as n from recovery_codes where user_id = ${u.id}`)[0].n), 0);
  });

  test("an instance admin can reset someone's 2FA; a non-admin can't", async () => {
    const u = await makeUser("t7");
    const other = await makeUser("t7other");
    await enrol(u);
    assert.equal((await api.post(`/api/admin/users/${u.id}/2fa/reset`, {}, other.cookie)).status, 403);
    assert.equal((await api.post(`/api/admin/users/${u.id}/2fa/reset`, {}, root.cookie)).status, 200);
    assert.ok(sessionCookieIn((await login(u.email)).setCookie));
    const users = (await api.get("/api/admin/users", root.cookie)).body.users;
    assert.equal(users.find((x: any) => x.id === u.id).totpEnabled, false);
  });

  test("require 2FA instance-wide: unenrolled sessions can only enrol (REST, sockets, feeds)", async () => {
    const admin = await makeUser("t8admin", true);
    assert.equal((await api.patch("/api/admin/settings", { require2fa: true }, admin.cookie)).status, 409, "admin must enrol first");
    const { secret: adminSecret } = await enrol(admin);
    const c = await makeUser("t8user");
    const feed = (await api.post("/api/me/feeds/token", {}, c.cookie)).body.myUrl as string;
    assert.equal((await fetch(h.base + feed)).status, 200);
    assert.equal((await api.get("/api/admin/settings", admin.cookie)).status, 200);
    assert.equal((await api.patch("/api/admin/settings", { require2fa: true }, admin.cookie)).status, 200);
    try {
      const w = await api.get("/api/workspaces", c.cookie);
      assert.equal(w.status, 403);
      assert.equal(w.body.code, "2fa_enrolment_required");
      assert.equal((await api.get("/api/auth/me", c.cookie)).body.user.mustEnrol2fa, true);
      await assert.rejects(connectSocket(h.base, c.cookie), /2fa_enrolment_required/);
      assert.equal((await fetch(h.base + feed)).status, 404);
      // a fresh password login is still restricted
      const l = await login(c.email);
      assert.equal((await api.get("/api/workspaces", l.cookie)).status, 403);

      await enrol(c);
      assert.equal((await api.get("/api/workspaces", c.cookie)).status, 200);
      assert.equal((await fetch(h.base + feed)).status, 200);
      assert.equal((await api.post("/api/auth/2fa/disable", { password: "password123" }, c.cookie, ip())).status, 409);
    } finally {
      // admin's step was consumed by enrol; the next step is free
      assert.equal((await api.patch("/api/admin/settings", { require2fa: false }, admin.cookie)).status, 200);
      void adminSecret;
    }
  });
});

/* ------------------------------------------------------------------- OIDC */

let idp: http.Server | undefined;
let issuer = "";
const CLIENT_ID = "trboard";
const CLIENT_SECRET = "s3cret";
const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" };
/** what the next login at the IdP asserts */
let next: { claims: Record<string, unknown>; emailOnlyInUserinfo?: boolean } = { claims: {} };
const codes = new Map<string, { nonce: string; challenge: string; claims: Record<string, unknown>; emailOnlyInUserinfo?: boolean }>();
const accessTokens = new Map<string, Record<string, unknown>>();

const b64u = (b: Buffer | string) => Buffer.from(b).toString("base64url");
function signJwt(payload: Record<string, unknown>) {
  const head = b64u(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "k1" }));
  const body = b64u(JSON.stringify(payload));
  const sig = crypto.sign("sha256", Buffer.from(`${head}.${body}`), privateKey);
  return `${head}.${body}.${b64u(sig)}`;
}

function startIdp(): Promise<void> {
  idp = http.createServer(async (req, res) => {
    const url = new URL(req.url!, issuer);
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/.well-known/openid-configuration") {
      return json(200, {
        issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`,
        userinfo_endpoint: `${issuer}/userinfo`, jwks_uri: `${issuer}/jwks`,
        response_types_supported: ["code"], subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"], code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["client_secret_basic"],
      });
    }
    if (url.pathname === "/jwks") return json(200, { keys: [jwk] });
    if (url.pathname === "/authorize") {
      const p = url.searchParams;
      if (p.get("client_id") !== CLIENT_ID || p.get("code_challenge_method") !== "S256") return json(400, { error: "bad request" });
      const c = crypto.randomBytes(16).toString("hex");
      codes.set(c, { nonce: p.get("nonce")!, challenge: p.get("code_challenge")!, ...next });
      res.writeHead(302, { location: `${p.get("redirect_uri")}?code=${c}&state=${p.get("state")}` });
      return res.end();
    }
    if (url.pathname === "/token" && req.method === "POST") {
      let raw = "";
      for await (const ch of req) raw += ch;
      const form = new URLSearchParams(raw);
      const auth = Buffer.from((req.headers.authorization ?? "").replace(/^Basic /, ""), "base64").toString();
      if (auth !== `${CLIENT_ID}:${CLIENT_SECRET}`) return json(401, { error: "invalid_client" });
      const grant = codes.get(form.get("code") ?? "");
      codes.delete(form.get("code") ?? "");
      if (!grant) return json(400, { error: "invalid_grant" });
      const pkce = crypto.createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url");
      if (pkce !== grant.challenge) return json(400, { error: "invalid_grant", error_description: "pkce" });
      const now = Math.floor(Date.now() / 1000);
      const idClaims = { ...grant.claims };
      if (grant.emailOnlyInUserinfo) {
        delete idClaims.email;
        delete idClaims.email_verified;
      }
      const at = crypto.randomBytes(16).toString("hex");
      accessTokens.set(at, grant.claims);
      return json(200, {
        access_token: at, token_type: "Bearer", expires_in: 300,
        id_token: signJwt({ iss: issuer, aud: CLIENT_ID, iat: now, exp: now + 300, nonce: grant.nonce, ...idClaims }),
      });
    }
    if (url.pathname === "/userinfo") {
      const c = accessTokens.get((req.headers.authorization ?? "").replace(/^Bearer /, ""));
      return c ? json(200, c) : json(401, { error: "invalid_token" });
    }
    json(404, {});
  });
  return new Promise((resolve) =>
    idp!.listen(0, "127.0.0.1", () => {
      issuer = `http://127.0.0.1:${(idp!.address() as AddressInfo).port}`;
      resolve();
    }),
  );
}

type Sso = { location: string; cookies: string[]; session?: string; ticket?: string; callback: string; stateCookie: string };

/** drive start -> IdP -> callback like a browser that doesn't follow redirects */
async function sso(claims: Record<string, unknown>, opts: { emailOnlyInUserinfo?: boolean } = {}): Promise<Sso> {
  next = { claims, ...opts };
  const start = await fetch(`${h.base}/api/auth/oidc/start`, { redirect: "manual", headers: ip() });
  assert.equal(start.status, 302);
  const stateCookie = start.headers.getSetCookie().find((c) => c.startsWith("trboard_oidc="))!.split(";")[0];
  const auth = await fetch(start.headers.get("location")!, { redirect: "manual" });
  assert.equal(auth.status, 302);
  const callback = auth.headers.get("location")!;
  const cb = await fetch(callback, { redirect: "manual", headers: { cookie: stateCookie } });
  assert.equal(cb.status, 302);
  const cookies = cb.headers.getSetCookie();
  const pick = (name: string) => cookies.find((c) => new RegExp(`^${name}=[0-9a-f]{64}`).test(c))?.split(";")[0];
  return { location: cb.headers.get("location")!, cookies, session: pick("trboard_session"), ticket: pick("trboard_mfa"), callback, stateCookie };
}

describe("OIDC single sign-on", () => {
  before(async () => {
    await startIdp();
    await h.restart({
      OIDC_ISSUER: issuer,
      OIDC_CLIENT_ID: CLIENT_ID,
      OIDC_CLIENT_SECRET: CLIENT_SECRET,
      OIDC_REDIRECT_URI: `${h.base}/api/auth/oidc/callback`,
      OIDC_ALLOW_INSECURE_HTTP: "true",
    });
    root.cookie = (await login("root@test.local")).cookie!;
  });

  test("login page config advertises SSO", async () => {
    const c = (await api.get("/api/auth/config")).body;
    assert.deepEqual(c.oidc, { enabled: true, label: "Sign in with SSO" });
    assert.equal(c.registrationOpen, false);
  });

  test("unverified or missing email_verified is refused, even for an existing user", async () => {
    const u = await makeUser("o1");
    let r = await sso({ sub: "o1-a", email: u.email, email_verified: false });
    assert.equal(r.location, "/login?sso_error=email_unverified");
    assert.equal(r.session, undefined);
    r = await sso({ sub: "o1-b", email: u.email });
    assert.equal(r.location, "/login?sso_error=email_unverified");
    r = await sso({ sub: "o1-c", email: u.email, email_verified: "false" });
    assert.equal(r.location, "/login?sso_error=email_unverified");
    assert.equal((await h.sql`select oidc_subject from users where id = ${u.id}`)[0].oidc_subject, null);
  });

  test("a verified email with no account is refused (no auto-provisioning by default)", async () => {
    const r = await sso({ sub: "stranger", email: "stranger@elsewhere.test", email_verified: true });
    assert.equal(r.location, "/login?sso_error=no_account");
    assert.equal(Number((await h.sql`select count(*)::int as n from users where email = 'stranger@elsewhere.test'`)[0].n), 0);
  });

  test("a verified email links the existing account; later logins go by subject", async () => {
    const u = await makeUser("o2");
    const r = await sso({ sub: "o2-sub", email: u.email.toUpperCase(), email_verified: true, name: "O Two" });
    assert.equal(r.location, "/");
    assert.ok(r.session);
    assert.equal((await api.get("/api/auth/me", r.session)).body.user.id, u.id);
    // email changed at the IdP: still the same account via (issuer, sub)
    const again = await sso({ sub: "o2-sub", email: "renamed@elsewhere.test", email_verified: true });
    assert.equal((await api.get("/api/auth/me", again.session)).body.user.id, u.id);
    // a different identity claiming the same email can't take the account
    const other = await sso({ sub: "o2-intruder", email: u.email, email_verified: true });
    assert.equal(other.location, "/login?sso_error=identity_mismatch");
    assert.equal(other.session, undefined);
  });

  test("email from userinfo when the ID token leaves it out (Authelia style)", async () => {
    const u = await makeUser("o3");
    const r = await sso({ sub: "o3-sub", email: u.email, email_verified: true }, { emailOnlyInUserinfo: true });
    assert.equal(r.location, "/");
    assert.equal((await api.get("/api/auth/me", r.session)).body.user.id, u.id);
  });

  test("state is single use and bound to the browser", async () => {
    const u = await makeUser("o4");
    const r = await sso({ sub: "o4-sub", email: u.email, email_verified: true });
    assert.ok(r.session);
    const replay = await fetch(r.callback, { redirect: "manual", headers: { cookie: r.stateCookie } });
    assert.equal(replay.headers.get("location"), "/login?sso_error=expired");
    const noCookie = await fetch(r.callback, { redirect: "manual" });
    assert.equal(noCookie.headers.get("location"), "/login?sso_error=expired");
  });

  test("SSO doesn't skip the account's TOTP", async () => {
    const u = await makeUser("o5");
    const { secret } = await enrol(u);
    const r = await sso({ sub: "o5-sub", email: u.email, email_verified: true });
    assert.equal(r.location, "/login?mfa=1");
    assert.equal(r.session, undefined, "SSO must not hand out a session before the second factor");
    assert.ok(r.ticket);
    const ok = await secondStep(r.ticket!, { code: code(secret, 1) });
    assert.equal(ok.status, 200);
    assert.ok(sessionCookieIn(ok.setCookie));
  });

  test("auto-provisioning respects invite-only registration", async () => {
    const env = {
      OIDC_ISSUER: issuer, OIDC_CLIENT_ID: CLIENT_ID, OIDC_CLIENT_SECRET: CLIENT_SECRET,
      OIDC_REDIRECT_URI: `${h.base}/api/auth/oidc/callback`, OIDC_ALLOW_INSECURE_HTTP: "true",
    };
    await h.restart({ ...env, OIDC_AUTO_PROVISION: "true" }); // registration still closed
    let r = await sso({ sub: "new-1", email: "newbie@elsewhere.test", email_verified: true, name: "Newbie" });
    assert.equal(r.location, "/login?sso_error=no_account", "flag alone must not open an invite-only instance");

    await h.restart({ ...env, OIDC_AUTO_PROVISION: "true", ALLOW_REGISTRATION: "true" });
    r = await sso({ sub: "new-1", email: "newbie@elsewhere.test", email_verified: true, name: "Newbie" });
    assert.equal(r.location, "/");
    const me = (await api.get("/api/auth/me", r.session)).body.user;
    assert.equal(me.email, "newbie@elsewhere.test");
    assert.equal(me.isAdmin, false);
    // an SSO-made account has no password to log in with
    assert.equal((await login("newbie@elsewhere.test", "password123")).status, 401);
    // and unverified still loses even with provisioning on
    r = await sso({ sub: "new-2", email: "unverified@elsewhere.test", email_verified: false });
    assert.equal(r.location, "/login?sso_error=email_unverified");
  });
});
