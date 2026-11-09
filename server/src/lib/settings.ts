/**
 * Instance settings (the single instance_settings row), cached in memory:
 * requireUser reads require2fa on every request, and this is one process, so
 * the cache is refreshed by whoever writes the row (admin route, restore).
 */
import { eq } from "drizzle-orm";
import { db, schema } from "../db/client.js";

export type InstanceSettings = { require2fa: boolean };

let cache: InstanceSettings | null = null;

export async function reloadSettings(): Promise<InstanceSettings> {
  const [row] = await db.select().from(schema.instanceSettings).where(eq(schema.instanceSettings.id, 1));
  if (!row) {
    // a restore of a hand-edited archive could drop the row; put it back
    await db.insert(schema.instanceSettings).values({ id: 1 }).onConflictDoNothing();
  }
  cache = { require2fa: row?.require2fa ?? false };
  return cache;
}

export async function getSettings(): Promise<InstanceSettings> {
  return cache ?? reloadSettings();
}

export async function updateSettings(patch: Partial<InstanceSettings>): Promise<InstanceSettings> {
  await db
    .update(schema.instanceSettings)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(schema.instanceSettings.id, 1));
  return reloadSettings();
}
