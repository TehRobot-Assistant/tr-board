import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { boardAccess, type BoardAccess } from "../lib/perms.js";

export const uuidSchema = z.string().uuid();

/**
 * Resolve board access for the current user, replying 404 (never 403 — board
 * existence is not revealed to outsiders) when the level isn't met.
 * Returns null after replying, so callers `if (!access) return;`.
 */
export async function requireBoard(
  req: FastifyRequest,
  reply: FastifyReply,
  boardId: string,
  level: "read" | "write" | "admin",
): Promise<BoardAccess | null> {
  if (!uuidSchema.safeParse(boardId).success) {
    reply.code(404).send({ error: "not found" });
    return null;
  }
  const access = await boardAccess(req.user.id, boardId, { isAdmin: req.user.isAdmin });
  const ok =
    access &&
    (level === "read" ? access.canRead : level === "write" ? access.canWrite : access.canAdmin);
  if (!ok) {
    // distinguish "can see but can't do" from "can't see"
    if (access?.canRead) reply.code(403).send({ error: "forbidden" });
    else reply.code(404).send({ error: "not found" });
    return null;
  }
  return access;
}

/** The acting client's socket id (excluded from its own broadcasts). */
export function originSocket(req: FastifyRequest): string | undefined {
  const v = req.headers["x-socket-id"];
  return typeof v === "string" && v.length < 64 ? v : undefined;
}

/** 400 with Zod details, returns null so callers can `if (!body) return;` */
export function parseBody<T extends z.ZodTypeAny>(
  schema: T,
  req: FastifyRequest,
  reply: FastifyReply,
): z.infer<T> | null {
  const r = schema.safeParse(req.body);
  if (!r.success) {
    reply.code(400).send({ error: "invalid body", details: r.error.flatten() });
    return null;
  }
  return r.data;
}
