/**
 * Recurring cards: create the next occurrence when one is completed.
 *
 * Model: ON COMPLETION, not on a schedule. Trello's repeater creates a copy
 * on a timetable whether or not the last one was done; Kanboard (recurring
 * tasks are generated when a task is closed) and Vikunja (marking a repeating
 * task done moves it to its next date) both work from completion. For the
 * chores this is for (parity check, cert renewal, key rotation) the
 * completion model is the better fit: an ignored chore stays one overdue card
 * instead of piling up a copy every period, and nothing needs a timer, so
 * there is nothing to re-fire after a restart (compare M10, which needed a
 * table to stop the due ticker repeating itself). The next due date steps
 * from the previous DUE date, not from the completion time, so "every Monday"
 * stays on Mondays even when done on a Wednesday (see nextDue for late ones).
 *
 * Exactly-once: the rule lives on the card that should spawn next. Spawning
 * takes the source row FOR UPDATE inside one transaction, clears its rule and
 * inserts the copy (which gets the rule). A second completion, a retry, two
 * racing PATCHes, or an untick/re-tick all find the rule already gone, so no
 * second copy can appear, and a crash mid-way rolls the whole thing back.
 */
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { after } from "./rank.js";
import { emitBoard } from "../sockets/index.js";
import { logActivity } from "./activity.js";
import { userCanReadBoard } from "./perms.js";
import { nextDue, type RecurrenceRule } from "./recurrenceRule.js";

export async function spawnNextOccurrence(cardId: string, actorId: string | null): Promise<string | null> {
  const result = await db.transaction(async (tx) => {
    const [src] = await tx.select().from(schema.cards).where(eq(schema.cards.id, cardId)).for("update");
    if (!src || !src.recurrence || !src.dueAt || !src.dueComplete || src.archived || src.mirrorOfCardId) return null;
    const rule = src.recurrence as RecurrenceRule;

    const due = nextDue(src.dueAt, rule);
    const shift = due.getTime() - src.dueAt.getTime();
    const startAt = src.startAt ? new Date(src.startAt.getTime() + shift) : null;

    // target list: the rule's list if it's still an open list on this board
    let listId = src.listId;
    if (rule.listId) {
      const [l] = await tx
        .select({ id: schema.lists.id })
        .from(schema.lists)
        .where(and(eq(schema.lists.id, rule.listId), eq(schema.lists.boardId, src.boardId), eq(schema.lists.archived, false)));
      if (l) listId = l.id;
    }
    const [edge] = await tx
      .select({ rank: schema.cards.rank })
      .from(schema.cards)
      .where(eq(schema.cards.listId, listId))
      .orderBy(desc(schema.cards.rank))
      .limit(1);

    await tx.update(schema.cards).set({ recurrence: null, updatedAt: new Date() }).where(eq(schema.cards.id, src.id));
    const [next] = await tx
      .insert(schema.cards)
      .values({
        boardId: src.boardId, listId, title: src.title, description: src.description,
        rank: after(edge?.rank ?? null), startAt, dueAt: due, dueComplete: false,
        // the cover image is an attachment of the old card; attachments and
        // comments belong to that occurrence and stay with it
        coverColor: src.coverColor, recurrence: rule, createdBy: src.createdBy,
      })
      .returning();

    const [labels, members, values, checklists] = await Promise.all([
      tx.select().from(schema.cardLabels).where(eq(schema.cardLabels.cardId, src.id)),
      tx.select().from(schema.cardMembers).where(eq(schema.cardMembers.cardId, src.id)),
      tx.select().from(schema.customFieldValues).where(eq(schema.customFieldValues.cardId, src.id)),
      tx.select().from(schema.checklists).where(eq(schema.checklists.cardId, src.id)).orderBy(asc(schema.checklists.rank)),
    ]);
    // M8: someone who has lost the board since must not be re-assigned to it
    const readable = new Map<string, boolean>();
    const canRead = async (uid: string) => {
      if (!readable.has(uid)) readable.set(uid, await userCanReadBoard(uid, src.boardId));
      return readable.get(uid)!;
    };
    const keptMembers: string[] = [];
    for (const m of members) if (await canRead(m.userId)) keptMembers.push(m.userId);

    if (labels.length) await tx.insert(schema.cardLabels).values(labels.map((l) => ({ cardId: next.id, labelId: l.labelId })));
    if (keptMembers.length) await tx.insert(schema.cardMembers).values(keptMembers.map((userId) => ({ cardId: next.id, userId })));
    if (values.length) {
      await tx.insert(schema.customFieldValues).values(values.map((v) => ({ cardId: next.id, fieldId: v.fieldId, value: v.value })));
    }
    let total = 0;
    if (checklists.length) {
      const items = await tx
        .select()
        .from(schema.checklistItems)
        .where(inArray(schema.checklistItems.checklistId, checklists.map((c) => c.id)))
        .orderBy(asc(schema.checklistItems.rank));
      for (const cl of checklists) {
        const [copy] = await tx.insert(schema.checklists).values({ cardId: next.id, name: cl.name, rank: cl.rank }).returning();
        const mine = items.filter((i) => i.checklistId === cl.id);
        const rows = [];
        for (const i of mine) {
          rows.push({
            checklistId: copy.id, text: i.text, rank: i.rank,
            done: false, // checklist items reset for the new occurrence
            assigneeId: i.assigneeId && (await canRead(i.assigneeId)) ? i.assigneeId : null,
            dueAt: i.dueAt ? new Date(i.dueAt.getTime() + shift) : null,
          });
        }
        if (rows.length) await tx.insert(schema.checklistItems).values(rows);
        total += rows.length;
      }
    }
    return {
      src: { ...src, recurrence: null },
      card: {
        ...next,
        labelIds: labels.map((l) => l.labelId),
        memberIds: keptMembers,
        fieldValues: Object.fromEntries(values.map((v) => [v.fieldId, v.value])),
        badges: { comments: 0, attachments: 0, checklist: total ? { total, done: 0 } : null },
      },
    };
  });
  if (!result) return null;
  // the source lost its rule (indicator moves to the new card)
  emitBoard(result.src.boardId, "card.updated", { card: result.src });
  emitBoard(result.src.boardId, "card.created", { card: result.card });
  logActivity({
    boardId: result.src.boardId, cardId: result.card.id, userId: actorId, type: "card.recurred",
    data: { title: result.card.title, dueAt: result.card.dueAt?.toISOString() ?? null },
  });
  return result.card.id;
}
