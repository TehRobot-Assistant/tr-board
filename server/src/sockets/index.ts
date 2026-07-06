/**
 * Live sync — Socket.IO, one room per board (`board:<id>`), plus a per-user
 * room (`user:<id>`) for notifications. Room joins are membership-gated via
 * perms.boardAccess — the handshake carries the same session cookie as REST,
 * so the socket layer enforces the exact same visibility rules.
 */
import type { Server as HttpServer } from "node:http";
import { Server, type Socket } from "socket.io";
import { userFromToken, COOKIE, type SessionUser } from "../lib/auth.js";
import { boardAccess } from "../lib/perms.js";

let io: Server | null = null;

function parseCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

type AuthedSocket = Socket & { data: { user: SessionUser } };

export function initSockets(http: HttpServer): Server {
  io = new Server(http, {
    // same-origin app in prod; the Vite dev proxy also lands here as same-origin
    cors: { origin: false },
    maxHttpBufferSize: 1e6,
  });

  io.use(async (socket, next) => {
    const token = parseCookie(socket.request.headers.cookie, COOKIE);
    const user = await userFromToken(token);
    if (!user) return next(new Error("unauthenticated"));
    socket.data.user = user;
    next();
  });

  io.on("connection", (socket: AuthedSocket) => {
    const user = socket.data.user;
    socket.join(`user:${user.id}`);

    socket.on("board:join", async (boardId: unknown, ack?: (ok: boolean) => void) => {
      if (typeof boardId !== "string") return ack?.(false);
      const access = await boardAccess(user.id, boardId, { isAdmin: user.isAdmin });
      if (!access?.canRead) return ack?.(false);
      socket.join(`board:${boardId}`);
      ack?.(true);
    });

    socket.on("board:leave", (boardId: unknown) => {
      if (typeof boardId === "string") socket.leave(`board:${boardId}`);
    });
  });

  return io;
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
