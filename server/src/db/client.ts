import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

const url =
  process.env.DATABASE_URL ??
  "postgres://trboard:trboard-dev@127.0.0.1:5433/trboard";

export const sql = postgres(url, { max: 10, onnotice: () => {} });
export const db = drizzle(sql, { schema });
export { schema };
