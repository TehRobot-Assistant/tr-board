/**
 * Instance-admin backup and restore (lib/backup.ts).
 *
 *   GET    /api/admin/backup                  schedule config + files in BACKUP_DIR
 *   GET    /api/admin/backup/download         stream a fresh full backup
 *   POST   /api/admin/backup/run              write one into BACKUP_DIR now
 *   POST   /api/admin/restore/upload          multipart archive -> verified summary
 *   POST   /api/admin/restore/from-backup     { name } from BACKUP_DIR -> summary
 *   POST   /api/admin/restore/:id/confirm     { confirm: "RESTORE" } -> replaces everything
 *   DELETE /api/admin/restore/:id             discard a prepared restore
 *
 * Instance admins only, like the rest of /api/admin (403 for anyone else:
 * the admin area's existence isn't a secret, unlike a board's).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { env } from "../lib/env.js";
import {
  applyRestore, BACKUP_NAME_RE, cancelRestore, createBackup, exclusive, listBackups,
  prepareRestore, RestoreError, runScheduledBackup, tmpRoot,
} from "../lib/backup.js";
import { reloadSettings } from "../lib/settings.js";
import { clearTickets } from "../lib/mfa.js";
import { disconnectAll } from "../sockets/index.js";
import { parseBody } from "./helpers.js";

const fail = (reply: FastifyReply, err: unknown) => {
  if (err instanceof RestoreError) return reply.code(400).send({ error: err.message });
  throw err;
};

export async function backupRoutes(app: FastifyInstance) {
  app.addHook("preHandler", async (req, reply) => {
    if (!req.user?.isAdmin) return reply.code(403).send({ error: "instance admin only" });
  });

  app.get("/api/admin/backup", async () => ({
    schedule: env.backup.dir
      ? { dir: env.backup.dir, intervalHours: env.backup.intervalHours, keep: env.backup.keep }
      : null,
    files: await listBackups(),
  }));

  app.get("/api/admin/backup/download", async (req, reply) => {
    await fsp.mkdir(tmpRoot(), { recursive: true });
    const file = path.join(tmpRoot(), `download-${crypto.randomBytes(6).toString("hex")}.tar.gz`);
    try {
      await exclusive("backup", () => createBackup(file));
    } catch (err) {
      await fsp.rm(file, { force: true });
      return fail(reply, err);
    }
    // Built to a temp file first: a tar header needs each table's size up
    // front, and a failure half-way must be an error, not a truncated download.
    const stream = fs.createReadStream(file);
    stream.on("close", () => void fsp.rm(file, { force: true }));
    const name = `trboard-backup-${new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15)}.tar.gz`;
    return reply
      .header("Content-Type", "application/gzip")
      .header("Content-Disposition", `attachment; filename="${name}"`)
      .header("Cache-Control", "no-store")
      .send(stream);
  });

  app.post("/api/admin/backup/run", async (_req, reply) => {
    if (!env.backup.dir) return reply.code(400).send({ error: "BACKUP_DIR is not set" });
    try {
      return { file: await runScheduledBackup() };
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post("/api/admin/restore/upload", async (req, reply) => {
    const part = await req.file({ limits: { fileSize: env.backup.maxRestoreBytes, files: 1 } });
    if (!part) return reply.code(400).send({ error: "no file" });
    await fsp.mkdir(tmpRoot(), { recursive: true });
    const file = path.join(tmpRoot(), `upload-${crypto.randomBytes(6).toString("hex")}.tar.gz`);
    try {
      await pipeline(part.file, fs.createWriteStream(file));
      if (part.file.truncated) return reply.code(413).send({ error: "backup is larger than BACKUP_MAX_RESTORE_GB" });
      return { restore: await prepareRestore(file) };
    } catch (err) {
      return fail(reply, err);
    } finally {
      await fsp.rm(file, { force: true });
    }
  });

  app.post("/api/admin/restore/from-backup", async (req, reply) => {
    const body = parseBody(z.object({ name: z.string().regex(BACKUP_NAME_RE) }), req, reply);
    if (!body) return;
    if (!env.backup.dir) return reply.code(400).send({ error: "BACKUP_DIR is not set" });
    const file = path.join(env.backup.dir, body.name); // regex above: no separators, no ..
    if (!fs.existsSync(file)) return reply.code(404).send({ error: "not found" });
    try {
      return { restore: await prepareRestore(file) };
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post("/api/admin/restore/:id/confirm", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = parseBody(z.object({ confirm: z.literal("RESTORE") }), req, reply);
    if (!body) return;
    if (!/^[0-9a-f]{24}$/.test(id)) return reply.code(404).send({ error: "not found" });
    try {
      const counts = await exclusive("restore", () => applyRestore(id));
      // every user, session and setting just changed under the running process
      await reloadSettings();
      clearTickets();
      disconnectAll();
      return { ok: true, counts };
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.delete("/api/admin/restore/:id", async (req) => {
    const { id } = req.params as { id: string };
    if (/^[0-9a-f]{24}$/.test(id)) await cancelRestore(id);
    return { ok: true };
  });
}
