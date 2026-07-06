import { getSocketId } from "./socket";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      "x-socket-id": getSocketId() ?? "",
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: "same-origin",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string }).error ?? res.statusText);
  return data as T;
}

export const api = {
  get: <T>(url: string) => call<T>("GET", url),
  post: <T>(url: string, body?: unknown) => call<T>("POST", url, body),
  patch: <T>(url: string, body?: unknown) => call<T>("PATCH", url, body),
  put: <T>(url: string, body?: unknown) => call<T>("PUT", url, body),
  del: <T>(url: string) => call<T>("DELETE", url),

  async upload<T>(url: string, file: File): Promise<T> {
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch(url, {
      method: "POST",
      body: fd,
      headers: { "x-socket-id": getSocketId() ?? "" },
      credentials: "same-origin",
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(res.status, (data as { error?: string }).error ?? res.statusText);
    return data as T;
  },
};
