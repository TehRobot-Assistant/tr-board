import { io, type Socket } from "socket.io-client";

let socket: Socket | null = null;

export function getSocket(): Socket {
  if (!socket) {
    socket = io({ withCredentials: true, autoConnect: true });
  }
  return socket;
}

export function getSocketId(): string | null {
  return socket?.id ?? null;
}

/**
 * Reconnect with fresh auth after login/logout. Reuses the SAME Socket
 * instance: the board store and notification bell attach their listeners once,
 * so swapping in a new instance (as this used to) left them listening to a dead
 * socket until a full page reload. The new handshake carries the new cookie,
 * and the store's "connect" handler re-joins the board room (H4).
 */
export function resetSocket(): void {
  if (!socket) return;
  socket.disconnect();
  socket.connect();
}
