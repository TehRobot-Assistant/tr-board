/**
 * Integration harness: a throwaway Postgres container + the real server
 * started as a child process (`tsx src/index.ts`). A child process, not an
 * in-process import, so a crash (review H1) shows up as the process exiting,
 * exactly as it did in production.
 *
 * The container uses --rm and a tmpfs data dir, so it leaves no volume behind;
 * stop() force-removes it even if a test failed.
 */
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { io as ioClient, type Socket } from "socket.io-client";

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export type Harness = {
  base: string;
  /** the current server process (replaced by restart()) */
  child: ChildProcess;
  output: () => string;
  /** stop the server and start it again on the same DB + port (M10); `env` overrides merge into the start env */
  restart: (env?: Record<string, string>) => Promise<void>;
  /** direct SQL against the throwaway DB, for setting up / checking state */
  sql: postgres.Sql;
  uploadsDir: string;
  stop: () => Promise<void>;
};

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

async function waitFor(what: string, fn: () => Promise<boolean>, ms = 60_000): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      if (await fn()) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`timed out waiting for ${what}`);
}

export async function startHarness(extraEnv: Record<string, string> = {}): Promise<Harness> {
  const name = `trboard-test-pg-${crypto.randomBytes(4).toString("hex")}`;
  const password = crypto.randomBytes(12).toString("hex");
  execFileSync("docker", [
    "run", "-d", "--rm", "--name", name,
    "--tmpfs", "/var/lib/postgresql/data",
    "-e", "POSTGRES_USER=trboard", "-e", `POSTGRES_PASSWORD=${password}`, "-e", "POSTGRES_DB=trboard",
    "-p", "127.0.0.1::5432",
    "postgres:16-alpine",
  ]);
  let child: ChildProcess | undefined;
  const removeDb = () => {
    try {
      execFileSync("docker", ["rm", "-f", name], { stdio: "ignore" });
    } catch {}
  };
  try {
    const hostPort = execFileSync("docker", ["port", name, "5432/tcp"]).toString().trim().split("\n")[0].split(":").pop();
    const dbUrl = `postgres://trboard:${password}@127.0.0.1:${hostPort}/trboard`;
    // TCP only answers once the image's init phase is over (init listens on a
    // unix socket only), so a successful query means the real server is up.
    await waitFor("postgres", async () => {
      const sql = postgres(dbUrl, { max: 1, connect_timeout: 2, onnotice: () => {} });
      try {
        await sql`select 1`;
        return true;
      } finally {
        await sql.end({ timeout: 1 });
      }
    });

    const port = await freePort();
    const uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), "trboard-test-uploads-"));
    let out = "";
    const base = `http://127.0.0.1:${port}`;
    let envNow = { ...extraEnv };
    const launch = async () => {
      const c = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
        cwd: serverDir,
        env: {
          ...process.env,
          DATABASE_URL: dbUrl,
          PORT: String(port),
          HOST: "127.0.0.1",
          NODE_ENV: "test",
          ALLOW_REGISTRATION: "", // exercise the closed-by-default path
          WEB_DIST: "/nonexistent", // API only
          UPLOADS_DIR: uploadsDir,
          ...envNow,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      child = c;
      c.stdout!.on("data", (d) => (out += d));
      c.stderr!.on("data", (d) => (out += d));
      await waitFor("server", async () => {
        if (c.exitCode !== null) throw new Error(`server exited early:\n${out}`);
        return (await fetch(`${base}/api/health`)).ok;
      });
    };
    const kill = async () => {
      const c = child!;
      if (c.exitCode === null && c.signalCode === null) {
        c.kill("SIGTERM");
        await new Promise((r) => c.once("exit", r));
      }
    };
    await launch();
    const sql = postgres(dbUrl, { max: 2, onnotice: () => {} });

    const h: Harness = {
      base,
      child: child!,
      output: () => out,
      restart: async (env?: Record<string, string>) => {
        await kill();
        if (env) envNow = { ...envNow, ...env };
        await launch();
        h.child = child!;
      },
      sql,
      uploadsDir,
      stop: async () => {
        await kill();
        await sql.end({ timeout: 2 }).catch(() => {});
        fs.rmSync(uploadsDir, { recursive: true, force: true });
        removeDb();
      },
    };
    return h;
  } catch (err) {
    child?.kill("SIGKILL");
    removeDb();
    throw err;
  }
}

export type Res = { status: number; body: any; cookie?: string; setCookie?: string; headers: Headers };

export function client(base: string) {
  const call = async (
    method: string,
    url: string,
    body?: unknown,
    cookie?: string,
    headers: Record<string, string> = {},
  ): Promise<Res> => {
    const res = await fetch(base + url, {
      method,
      headers: {
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(cookie ? { cookie } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get("set-cookie");
    return {
      status: res.status,
      body: await res.json().catch(() => null),
      cookie: set ? set.split(";")[0] : undefined,
      setCookie: set ?? undefined,
      headers: res.headers,
    };
  };
  type H = Record<string, string>;
  return {
    get: (u: string, c?: string, h?: H) => call("GET", u, undefined, c, h),
    post: (u: string, b: unknown, c?: string, h?: H) => call("POST", u, b, c, h),
    put: (u: string, b: unknown, c?: string, h?: H) => call("PUT", u, b, c, h),
    patch: (u: string, b: unknown, c?: string, h?: H) => call("PATCH", u, b, c, h),
    del: (u: string, c?: string, h?: H) => call("DELETE", u, undefined, c, h),
  };
}

export function connectSocket(base: string, cookie: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s = ioClient(base, {
      transports: ["websocket"],
      extraHeaders: { cookie },
      reconnection: false,
      forceNew: true,
    });
    s.once("connect", () => resolve(s));
    s.once("connect_error", reject);
  });
}

export function joinBoard(s: Socket, boardId: unknown): Promise<boolean> {
  return s.timeout(5_000).emitWithAck("board:join", boardId);
}

export function nextEvent<T = any>(s: Socket, event: string, ms = 5_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`no ${event} within ${ms}ms`)), ms);
    s.once(event, (p: T) => {
      clearTimeout(t);
      resolve(p);
    });
  });
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
