import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

/**
 * No built-in fallback URL/password: a default credential is what left the
 * live instance on `trboard`. Refuse to start instead, with a message that
 * says exactly what to set (exit, not throw, so the log is one clear line
 * rather than a stack trace).
 */
function databaseUrl(): string {
  const url = process.env.DATABASE_URL?.trim();
  const fail = (why: string): never => {
    console.error(
      `TR Board: ${why}. Set DATABASE_URL=postgres://trboard:<password>@<host>:5432/trboard ` +
        "(with docker compose, set POSTGRES_PASSWORD in .env).",
    );
    process.exit(1);
  };
  if (!url) return fail("DATABASE_URL is not set");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return fail("DATABASE_URL is not a valid URL");
  }
  if (!parsed.password) return fail("DATABASE_URL has no password");
  return url;
}

export const sql = postgres(databaseUrl(), { max: 10, onnotice: () => {} });
export const db = drizzle(sql, { schema });
export { schema };
