import { db, schema } from "../db/client.js";

/** Fire-and-forget activity log write. `userId: null` = automation. */
export function logActivity(entry: {
  boardId: string;
  cardId?: string | null;
  userId?: string | null;
  type: string;
  data?: Record<string, unknown>;
}): void {
  db.insert(schema.activityLog)
    .values({
      boardId: entry.boardId,
      cardId: entry.cardId ?? null,
      userId: entry.userId ?? null,
      type: entry.type,
      data: entry.data ?? {},
    })
    .catch((err) => console.error("activity log failed:", err.message));
}
