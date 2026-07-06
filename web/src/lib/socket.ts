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

/** reconnect with fresh auth after login/logout */
export function resetSocket(): void {
  socket?.disconnect();
  socket = null;
}
