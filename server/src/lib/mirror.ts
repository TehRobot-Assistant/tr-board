/**
 * Card mirroring (Trello Standard+) — a mirror card lives on another board and
 * renders the SOURCE card's face. Source of truth stays the source card;
 * mirrors carry only `mirrorOfCardId`.
 */
import { eq, inArray } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { emitBoard, emitBoardEach } from "../sockets/index.js";
import { boardAccess } from "./perms.js";

export type MirrorFace = {
  sourceCardId: string;
  sourceBoardId: string;
  boardName: string;
  title: string;
  dueAt: Date | null;
  dueComplete: boolean;
  archived: boolean;
  labels: Array<{ name: string; color: string }>;
};

/**
 * null = source gone. `{ restricted: true }` = the viewer can't read the
 * source board (M2): read access to the source was only checked when the
 * mirror was created, so everyone on the target board saw a private card's
 * title, labels, due date and board name, live, forever. The placeholder
 * carries nothing about the source, not even its ids.
 */
export type MirrorSnapshot = MirrorFace | { restricted: true } | null;

export type Viewer = { id: string; isAdmin: boolean };

/**
 * Bulk-load face data for a set of source card ids, as seen by `viewer`.
 * Faces of sources on boards the viewer can't read come back restricted.
 */
export async function mirrorSnapshots(sourceIds: string[], viewer: Viewer): Promise<Map<string, MirrorSnapshot>> {
  const faces = await mirrorFaces(sourceIds);
  const readable = new Map<string, boolean>();
  const out = new Map<string, MirrorSnapshot>();
  for (const [id, face] of faces) {
    if (!face) {
      out.set(id, null);
      continue;
    }
    if (!readable.has(face.sourceBoardId)) {
      const a = await boardAccess(viewer.id, face.sourceBoardId, { isAdmin: viewer.isAdmin });
      readable.set(face.sourceBoardId, !!a?.canRead);
    }
    out.set(id, readable.get(face.sourceBoardId) ? face : { restricted: true });
  }
  return out;
}

/** unfiltered faces: callers must gate them (mirrorSnapshots does) */
async function mirrorFaces(sourceIds: string[]): Promise<Map<string, MirrorFace | null>> {
  const out = new Map<string, MirrorFace | null>();
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

/**
 * Push a fresh snapshot to every board holding a mirror of this source card.
 * Built per viewer, so only people who can read the source get its face.
 */
export async function propagateMirror(sourceCardId: string): Promise<void> {
  const mirrors = await db
    .select({ id: schema.cards.id, boardId: schema.cards.boardId })
    .from(schema.cards)
    .where(eq(schema.cards.mirrorOfCardId, sourceCardId));
  if (!mirrors.length) return;
  for (const m of mirrors) {
    await emitBoardEach(m.boardId, "mirror.updated", async (u) => ({
      cardId: m.id,
      mirror: (await mirrorSnapshots([sourceCardId], u)).get(sourceCardId) ?? null,
    }));
  }
}

export type MirrorRef = { id: string; boardId: string; listId: string };

/**
 * Mirrors of the given source cards. Call BEFORE deleting the sources: the FK
 * (L7) cascades the mirror rows away with them, and the target boards still
 * need a card.deleted event (announceMirrorsDeleted) afterwards.
 */
export async function mirrorsOf(sourceCardIds: string[]): Promise<MirrorRef[]> {
  if (!sourceCardIds.length) return [];
  return db
    .select({ id: schema.cards.id, boardId: schema.cards.boardId, listId: schema.cards.listId })
    .from(schema.cards)
    .where(inArray(schema.cards.mirrorOfCardId, sourceCardIds));
}

export function announceMirrorsDeleted(mirrors: MirrorRef[]): void {
  for (const m of mirrors) emitBoard(m.boardId, "card.deleted", { cardId: m.id, listId: m.listId });
}
