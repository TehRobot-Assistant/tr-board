/**
 * Attachment files on disk (review M6). Files live at
 * `<uploadsDir>/<cardId>/<uuid><ext>`. Deleting a card, list, board or
 * workspace cascades the DB rows but used to leave the files, so disk use only
 * grew. Routes now remove the card directories after their delete commits,
 * and a sweep (at boot, then daily) removes any directory whose card no
 * longer exists, which also covers cascades no route sees (user/workspace
 * deletes, mirror cascades, a crash between commit and rm).
 */
import fs from "node:fs/promises";
import path from "node:path";
import { inArray } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { env } from "./env.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Remove the upload directories of these (already deleted) cards. Never throws. */
export async function removeCardUploads(cardIds: string[]): Promise<void> {
  for (const id of cardIds) {
    if (!UUID_RE.test(id)) continue; // ids come from the DB, but never rm a path built from anything else
    await fs.rm(path.join(env.uploadsDir, id), { recursive: true, force: true }).catch(() => {});
  }
}

/** Delete card directories with no matching card row. Returns how many went. */
export async function sweepOrphanUploads(): Promise<number> {
  let entries: string[];
  try {
    entries = (await fs.readdir(env.uploadsDir, { withFileTypes: true }))
      .filter((d) => d.isDirectory() && UUID_RE.test(d.name))
      .map((d) => d.name.toLowerCase());
  } catch {
    return 0; // no uploads dir yet
  }
  let removed = 0;
  for (let i = 0; i < entries.length; i += 500) {
    const batch = entries.slice(i, i + 500);
    const live = new Set(
      (await db.select({ id: schema.cards.id }).from(schema.cards).where(inArray(schema.cards.id, batch))).map((r) => r.id),
    );
    const orphans = batch.filter((id) => !live.has(id));
    await removeCardUploads(orphans);
    removed += orphans.length;
  }
  return removed;
}

export function startUploadSweeper(): void {
  const run = () =>
    sweepOrphanUploads()
      .then((n) => n && console.log(`upload sweep: removed ${n} orphaned card folder(s)`))
      .catch((err) => console.error("upload sweep failed:", err instanceof Error ? err.message : err));
  void run();
  setInterval(run, 24 * 3600_000).unref();
}
