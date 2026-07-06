/**
 * Card mirroring (Trello Standard+) — a mirror card lives on another board and
 * renders the SOURCE card's face. Source of truth stays the source card;
 * mirrors carry only `mirrorOfCardId`.
 */
import { eq, inArray } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { emitBoard } from "../sockets/index.js";

export type MirrorSnapshot = {
  sourceCardId: string;
  sourceBoardId: string;
  boardName: string;
  title: string;
  dueAt: Date | null;
  dueComplete: boolean;
  archived: boolean;
  labels: Array<{ name: string; color: string }>;
} | null; // null = source gone

/** bulk-load face data for a set of source card ids */
export async function mirrorSnapshots(sourceIds: string[]): Promise<Map<string, MirrorSnapshot>> {
  const out = new Map<string, MirrorSnapshot>();
  if (!sourceIds.length) return out;
  const cards = await db.select().from(schema.cards).where(inArray(schema.cards.id, sourceIds));
  const boardIds = [...new Set(cards.map((c) => c.boardId))];
  const boards = boardIds.length
    ? await db.select().from(schema.boards).where(inArray(schema.boards.id, boardIds))
    : [];
  const links = cards.length
    ? await db.select().from(schema.cardLabels).where(inArray(schema.cardLabels.cardId, cards.map((c) => c.id)))
    : [];
  const labelIds = [...new Set(links.map((l) => l.labelId))];
  const labels = labelIds.length
    ? await db.select().from(schema.labels).where(inArray(schema.labels.id, labelIds))
    : [];

  for (const id of sourceIds) out.set(id, null);
  for (const c of cards) {
    out.set(c.id, {
      sourceCardId: c.id,
      sourceBoardId: c.boardId,
      boardName: boards.find((b) => b.id === c.boardId)?.name ?? "?",
      title: c.title,
      dueAt: c.dueAt,
      dueComplete: c.dueComplete,
      archived: c.archived,
      labels: links
        .filter((l) => l.cardId === c.id)
        .map((l) => labels.find((x) => x.id === l.labelId))
        .filter((x): x is NonNullable<typeof x> => !!x)
        .map((x) => ({ name: x.name, color: x.color })),
    });
  }
  return out;
}

/** push a fresh snapshot to every board holding a mirror of this source card */
export async function propagateMirror(sourceCardId: string): Promise<void> {
  const mirrors = await db
    .select({ id: schema.cards.id, boardId: schema.cards.boardId })
    .from(schema.cards)
    .where(eq(schema.cards.mirrorOfCardId, sourceCardId));
  if (!mirrors.length) return;
  const snap = (await mirrorSnapshots([sourceCardId])).get(sourceCardId) ?? null;
  for (const m of mirrors) {
    emitBoard(m.boardId, "mirror.updated", { cardId: m.id, mirror: snap });
  }
}

/** delete all mirrors of a source card (called when the source is deleted) */
export async function deleteMirrorsOf(sourceCardId: string): Promise<void> {
  const mirrors = await db
    .select({ id: schema.cards.id, boardId: schema.cards.boardId, listId: schema.cards.listId })
    .from(schema.cards)
    .where(eq(schema.cards.mirrorOfCardId, sourceCardId));
  for (const m of mirrors) {
    await db.delete(schema.cards).where(eq(schema.cards.id, m.id));
    emitBoard(m.boardId, "card.deleted", { cardId: m.id, listId: m.listId });
  }
}
