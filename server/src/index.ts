import Fastify from "fastify";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import fs from "node:fs";
import { env } from "./lib/env.js";
import { requireUser } from "./lib/auth.js";
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

// apply SQL migrations on boot (idempotent — makes `docker compose up` zero-step)
if (fs.existsSync(new URL("../drizzle", import.meta.url))) {
  const { db } = await import("./db/client.js");
  await migrate(db, { migrationsFolder: new URL("../drizzle", import.meta.url).pathname });
}

const app = Fastify({
  logger: { level: env.prod ? "warn" : "info" },
  bodyLimit: 2 * 1024 * 1024,
});

await app.register(cookie);
await app.register(multipart, {
  limits: { fileSize: 1024 * 1024 * 1024, files: 1 }, // 1 GB — "no cap" in practice
});

app.addHook("onRequest", async (_req, reply) => {
  reply.header("X-Content-Type-Options", "nosniff");
  reply.header("Referrer-Policy", "same-origin");
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

await app.listen({ port: env.port, host: env.host });
console.log(`TR Board API on :${env.port}`);
