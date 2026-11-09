import Fastify from "fastify";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import fs from "node:fs";
import { env } from "./lib/env.js";
import { HashBusyError, requireUser } from "./lib/auth.js";
import { startUploadSweeper } from "./lib/uploads.js";
import { initSockets } from "./sockets/index.js";
import { startDueTicker } from "./automation/engine.js";
import { authRoutes } from "./routes/auth.js";
import { workspaceRoutes } from "./routes/workspaces.js";
import { boardRoutes } from "./routes/boards.js";
import { listRoutes } from "./routes/lists.js";
import { cardRoutes } from "./routes/cards.js";
import { cardDetailRoutes } from "./routes/cardDetail.js";
import { phase1Routes } from "./routes/phase1.js";
import { adminRoutes } from "./routes/admin.js";
import { boardToolsRoutes } from "./routes/boardTools.js";
import { publicRoutes } from "./routes/public.js";
import { personalRoutes } from "./routes/personal.js";
import { depsRoutes } from "./routes/deps.js";
import { formRoutes, publicFormRoutes } from "./routes/forms.js";
import { twoFactorRoutes } from "./routes/twofactor.js";
import { oidcRoutes } from "./routes/oidc.js";
import { feedRoutes, feedSettingsRoutes } from "./routes/feeds.js";
import { backupRoutes } from "./routes/backup.js";
import { cleanTmp, startBackupSchedule } from "./lib/backup.js";

// Backstop for H1-class bugs: Node 22 exits on an unhandled rejection, which
// let one bad client message take the server down for everyone. Log it and
// keep serving; the bug itself still needs fixing at its source.
process.on("unhandledRejection", (reason) => {
  console.error("unhandledRejection (not exiting):", reason instanceof Error ? reason.stack : reason);
});

// apply SQL migrations on boot (idempotent — makes `docker compose up` zero-step)
if (fs.existsSync(new URL("../drizzle", import.meta.url))) {
  const { db } = await import("./db/client.js");
  await migrate(db, { migrationsFolder: new URL("../drizzle", import.meta.url).pathname });
}

const app = Fastify({
  logger: { level: env.prod ? "warn" : "info" },
  bodyLimit: 2 * 1024 * 1024,
  // M3: off unless TRUST_PROXY is set (see lib/env.ts). With it, req.ip and
  // req.protocol come from X-Forwarded-For/-Proto, which is what the rate
  // limits and the Secure cookie flag need behind NPM / Cloudflare.
  trustProxy: env.trustProxy,
});

/**
 * L2 backstop. Routes check ids with uuidSchema, but any that slip through
 * used to surface Postgres errors as 500s: 22P02 (not a uuid) is a lookup
 * that can't match, so 404; 23503 (FK violation) means a referenced row
 * doesn't exist, so 400. Everything else goes to Fastify's default handler.
 */
const defaultErrorHandler = app.errorHandler;
app.setErrorHandler(function (err, req, reply) {
  const code = (err as { code?: unknown }).code;
  if (err instanceof HashBusyError) return reply.code(503).send({ error: err.message }); // M4 hash queue full
  if (code === "22P02") return reply.code(404).send({ error: "not found" });
  if (code === "23503") return reply.code(400).send({ error: "a referenced item does not exist" });
  return defaultErrorHandler.call(this, err, req, reply);
});

await app.register(cookie);
await app.register(multipart, {
  limits: { fileSize: 1024 * 1024 * 1024, files: 1 }, // 1 GB — "no cap" in practice
});

app.addHook("onRequest", async (_req, reply) => {
  reply.header("X-Content-Type-Options", "nosniff");
  reply.header("Referrer-Policy", "same-origin");
  // L5: no framing by anyone (clickjacking of drag-and-drop / settings).
  // Nothing in the app is meant to be embedded, public forms and share links
  // included; X-Frame-Options covers browsers without CSP level 2.
  reply.header("X-Frame-Options", "DENY");
  reply.header("Content-Security-Policy", "frame-ancestors 'none'");
});

/**
 * CSRF guard for mutating API calls: same-origin only. Sec-Fetch-Site is
 * checked first (Chrome sends Origin: null with strict referrer policies);
 * Origin-vs-Host is the fallback for older engines.
 */
app.addHook("preHandler", async (req, reply) => {
  if (!req.url.startsWith("/api/")) return;
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return;
  const sfs = req.headers["sec-fetch-site"];
  if (sfs === "same-origin" || sfs === "none") return;
  if (typeof sfs === "string") return reply.code(403).send({ error: "cross-site request blocked" });
  const origin = req.headers.origin;
  if (!origin) return; // non-browser client (curl etc.)
  try {
    if (new URL(origin).host === req.headers.host) return;
  } catch {}
  return reply.code(403).send({ error: "cross-site request blocked" });
});

// public endpoints: auth + link-shared board snapshots
await app.register(authRoutes);
await app.register(publicRoutes);
await app.register(publicFormRoutes);
await app.register(twoFactorRoutes); // login step 2 is public; its management routes check the session
await app.register(oidcRoutes);
await app.register(feedRoutes); // token-in-URL calendar feeds (no cookie from calendar apps)

// everything else under /api requires a session
await app.register(async (secured) => {
  secured.addHook("preHandler", requireUser);
  await secured.register(workspaceRoutes);
  await secured.register(boardRoutes);
  await secured.register(listRoutes);
  await secured.register(cardRoutes);
  await secured.register(cardDetailRoutes);
  await secured.register(phase1Routes);
  await secured.register(adminRoutes);
  await secured.register(boardToolsRoutes);
  await secured.register(personalRoutes);
  await secured.register(depsRoutes);
  await secured.register(formRoutes);
  await secured.register(feedSettingsRoutes);
  await secured.register(backupRoutes);
});

app.get("/api/health", async () => ({ ok: true, name: "TR Board" }));

// production: serve the built SPA (Vite dev server proxies /api in dev)
if (fs.existsSync(env.webDist)) {
  await app.register(fastifyStatic, { root: env.webDist, wildcard: false });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith("/api/") || req.url.startsWith("/socket.io/")) {
      return reply.code(404).send({ error: "not found" });
    }
    return reply.sendFile("index.html"); // SPA fallback
  });
}

await app.ready();
initSockets(app.server);
startDueTicker();
startUploadSweeper();
await cleanTmp(); // half-written backups / restores from a crash
startBackupSchedule();

await app.listen({ port: env.port, host: env.host });
console.log(`TR Board API on :${env.port}`);
