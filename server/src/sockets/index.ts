/**
 * Live sync — Socket.IO, one room per board (`board:<id>`), plus a per-user
 * room (`user:<id>`) for notifications. Room joins are membership-gated via
 * perms.boardAccess — the handshake carries the same session cookie as REST,
 * so the socket layer enforces the exact same visibility rules.
 */
import type { Server as HttpServer } from "node:http";
import { Server, type Socket } from "socket.io";
import { inArray, eq } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { COOKIE, mustEnrol2fa, sha256, userFromTokenHash, type SessionUser } from "../lib/auth.js";
import { boardAccess } from "../lib/perms.js";
import { uuidSchema } from "../routes/helpers.js";

let io: Server | null = null;

function parseCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

/**
 * `tokenHash` is kept so the socket can be tied back to its session (M1):
 * identity used to be cached at handshake forever, so a socket outlived
 * logout, password change, user deletion and admin demotion.
 */
type SocketData = { user: SessionUser; tokenHash: string };
type AuthedSocket = Socket & { data: SocketData };

/** how often every socket's session + admin flag is re-checked */
const SESSION_SWEEP_MS = Number(process.env.SOCKET_SWEEP_MS ?? 60_000);

function localSockets(): AuthedSocket[] {
  return io ? ([...io.of("/").sockets.values()] as AuthedSocket[]) : [];
}

function boardRooms(s: AuthedSocket): string[] {
  return [...s.rooms].filter((r) => r.startsWith("board:")).map((r) => r.slice(6));
}

/** leave (and tell the client about) every board room this socket can no longer read */
async function revalidateSocketRooms(s: AuthedSocket): Promise<void> {
  for (const boardId of boardRooms(s)) {
    const access = await boardAccess(s.data.user.id, boardId, { isAdmin: s.data.user.isAdmin });
    if (!access?.canRead) {
      s.leave(`board:${boardId}`);
      s.emit("board:kicked", { boardId });
    }
  }
}

export function initSockets(http: HttpServer): Server {
  io = new Server(http, {
    // same-origin app in prod; the Vite dev proxy also lands here as same-origin
    cors: { origin: false },
    maxHttpBufferSize: 1e6,
  });

  io.use(async (socket, next) => {
    // A DB error here would otherwise be an unhandled rejection (socket.io
    // doesn't await middleware), so fail the handshake instead.
    try {
      const token = parseCookie(socket.request.headers.cookie, COOKIE);
      if (!token || !/^[0-9a-f]{64}$/.test(token)) return next(new Error("unauthenticated"));
      const tokenHash = sha256(token);
      const user = await userFromTokenHash(tokenHash);
      if (!user) return next(new Error("unauthenticated"));
      // instance requires 2FA and this account has none: REST answers 403,
      // so live sync must not hand out board events either
      if (await mustEnrol2fa(user)) return next(new Error("2fa_enrolment_required"));
      socket.data.user = user;
      socket.data.tokenHash = tokenHash;
      next();
    } catch (err) {
      console.error("socket auth error:", err instanceof Error ? err.message : err);
      next(new Error("server error"));
    }
  });

  io.on("connection", (socket: AuthedSocket) => {
    socket.join(`user:${socket.data.user.id}`);

    // Every payload is client-controlled. Board ids must be UUIDs before they
    // reach Postgres (a non-UUID throws 22P02), and the handler body is wrapped
    // so no rejection escapes: socket.io calls listeners via a plain
    // EventEmitter, so an async throw here used to kill the whole process (H1).
    socket.on("board:join", (boardId: unknown, ack?: unknown) => {
      const reply = (ok: boolean) => {
        if (typeof ack === "function") ack(ok); // a non-function "ack" is just extra data
      };
      if (!uuidSchema.safeParse(boardId).success) return reply(false);
      const id = boardId as string;
      // M1: re-resolve the session on every join, so a logged-out socket can't
      // join anything and a demoted admin's isAdmin is current.
      userFromTokenHash(socket.data.tokenHash)
        .then(async (fresh) => {
          if (!fresh) {
            reply(false);
            socket.disconnect(true);
            return;
          }
          socket.data.user = fresh;
          if (await mustEnrol2fa(fresh)) return reply(false);
          const access = await boardAccess(fresh.id, id, { isAdmin: fresh.isAdmin });
          if (!access?.canRead) return reply(false);
          socket.join(`board:${id}`);
          reply(true);
        })
        .catch((err) => {
          console.error("board:join failed:", err instanceof Error ? err.message : err);
          reply(false);
        });
    });

    socket.on("board:leave", (boardId: unknown) => {
      if (uuidSchema.safeParse(boardId).success) socket.leave(`board:${boardId as string}`);
    });
  });

  // M1 backstop for paths that don't call disconnectSessions (session expiry,
  // rows deleted by hand or by a cascade): periodically drop sockets whose
  // session is gone and refresh the cached user (isAdmin, name).
  const sweep = setInterval(() => {
    sweepSessions().catch((err) => console.error("socket sweep failed:", err instanceof Error ? err.message : err));
  }, SESSION_SWEEP_MS);
  sweep.unref();

  return io;
}

export async function sweepSessions(): Promise<void> {
  const sockets = localSockets();
  if (!sockets.length) return;
  const hashes = [...new Set(sockets.map((s) => s.data.tokenHash))];
  const rows = await db
    .select({
      tokenHash: schema.sessions.tokenHash,
      expiresAt: schema.sessions.expiresAt,
      id: schema.users.id,
      email: schema.users.email,
      name: schema.users.name,
      avatarColor: schema.users.avatarColor,
      isAdmin: schema.users.isAdmin,
      theme: schema.users.theme,
      totpEnabledAt: schema.users.totpEnabledAt,
    })
    .from(schema.sessions)
    .innerJoin(schema.users, eq(schema.users.id, schema.sessions.userId))
    .where(inArray(schema.sessions.tokenHash, hashes));
  const live = new Map(rows.filter((r) => r.expiresAt.getTime() > Date.now()).map((r) => [r.tokenHash, r]));
  for (const s of sockets) {
    const row = live.get(s.data.tokenHash);
    if (!row) {
      s.disconnect(true);
      continue;
    }
    const wasAdmin = s.data.user.isAdmin;
    const { tokenHash: _t, expiresAt: _e, totpEnabledAt, ...rest } = row;
    const user = { ...rest, totpEnabled: !!totpEnabledAt };
    s.data.user = user;
    if (await mustEnrol2fa(user)) {
      s.disconnect(true); // require-2FA was switched on (or their 2FA was reset)
      continue;
    }
    if (wasAdmin && !user.isAdmin) await revalidateSocketRooms(s);
  }
}

/** close every socket (after a restore replaced all users and sessions) */
export function disconnectAll(): void {
  for (const s of localSockets()) s.disconnect(true);
}

/** require-2FA was just switched on: close sockets of accounts without TOTP */
export async function disconnectUnenrolled(): Promise<void> {
  for (const s of localSockets()) if (await mustEnrol2fa(s.data.user)) s.disconnect(true);
}

/** M1/M5: close the sockets of these sessions (logout, password change). */
export function disconnectSessions(tokenHashes: string[]): void {
  if (!tokenHashes.length) return;
  const set = new Set(tokenHashes);
  for (const s of localSockets()) if (set.has(s.data.tokenHash)) s.disconnect(true);
}

/** M1: close every socket of a user (deleted, or all sessions revoked by an admin). */
export function disconnectUser(userId: string): void {
  for (const s of localSockets()) if (s.data.user.id === userId) s.disconnect(true);
}

/**
 * M1: an admin changed this user's instance-admin flag. Reload the cached
 * identity on their sockets and drop board rooms they can no longer read.
 */
export async function refreshUserSockets(userId: string): Promise<void> {
  for (const s of localSockets()) {
    if (s.data.user.id !== userId) continue;
    const fresh = await userFromTokenHash(s.data.tokenHash);
    if (!fresh) {
      s.disconnect(true);
      continue;
    }
    s.data.user = fresh;
    await revalidateSocketRooms(s);
  }
}

/**
 * Broadcast a mutation to everyone viewing a board. `originSocketId` (sent by
 * clients as the `x-socket-id` header) is excluded so the acting client
 * doesn't double-apply its own optimistic update.
 */
export function emitBoard(
  boardId: string,
  event: string,
  payload: unknown,
  originSocketId?: string,
): void {
  if (!io) return;
  const room = io.to(`board:${boardId}`);
  (originSocketId ? room.except(originSocketId) : room).emit(event, payload);
}

/**
 * Like emitBoard, but the payload is built per viewer (M2: a mirror's face
 * depends on whether that viewer can read the SOURCE board). `build` is
 * called once per distinct user in the room.
 */
export async function emitBoardEach(
  boardId: string,
  event: string,
  build: (user: SessionUser) => Promise<unknown>,
  originSocketId?: string,
): Promise<void> {
  if (!io) return;
  const sockets = localSockets().filter((s) => s.rooms.has(`board:${boardId}`) && s.id !== originSocketId);
  const perUser = new Map<string, Promise<unknown>>();
  for (const s of sockets) {
    const u = s.data.user;
    if (!perUser.has(u.id)) perUser.set(u.id, build(u));
    s.emit(event, await perUser.get(u.id));
  }
}

export function emitUser(userId: string, event: string, payload: unknown): void {
  io?.to(`user:${userId}`).emit(event, payload);
}

/** Force sockets out of a board room after access is revoked. */
export async function kickFromBoard(boardId: string, userId?: string): Promise<void> {
  if (!io) return;
  const sockets = await io.in(`board:${boardId}`).fetchSockets();
  for (const s of sockets) {
    if (!userId || (s.data as { user?: SessionUser }).user?.id === userId) {
      s.leave(`board:${boardId}`);
      s.emit("board:kicked", { boardId });
    }
  }
}

/**
 * Re-check access for every socket in a board room (optionally only the given
 * users) and kick the ones that can no longer read it. Used after membership /
 * team-grant changes, where only some viewers lose access; kicking the whole
 * room would make every client refetch for nothing.
 */
export async function revalidateBoardRoom(boardId: string, userIds?: Set<string>): Promise<void> {
  if (!io) return;
  const sockets = await io.in(`board:${boardId}`).fetchSockets();
  for (const s of sockets) {
    const u = (s.data as { user?: SessionUser }).user;
    if (!u || (userIds && !userIds.has(u.id))) continue;
    const access = await boardAccess(u.id, boardId, { isAdmin: u.isAdmin });
    if (!access?.canRead) {
      s.leave(`board:${boardId}`);
      s.emit("board:kicked", { boardId });
    }
  }
}
