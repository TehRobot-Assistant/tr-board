/**
 * Butler-lite — per-board automation rules: trigger + conditions + actions,
 * run server-side on mutation events and on a due-date scheduler tick.
 *
 * Triggers: card_created | card_moved | label_added | member_assigned |
 *           due_approaching | due_completed | checklist_completed | field_changed
 * Conditions (all must hold): in_list, has_label, has_member, title_contains
 * Actions: move_to_list, set_due, clear_due, add_label, remove_label,
 *          assign_member, unassign_member, set_field, add_checklist,
 *          comment, notify, archive, mark_due_complete
 *
 * Loop safety: automation-caused mutations re-dispatch with depth+1 and stop
 * at MAX_DEPTH, so "move → rule moves it again" chains terminate.
 */
import { and, asc, desc, eq, gt, inArray, isNotNull, lt } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { after } from "../lib/rank.js";
import { emitBoard, emitUser } from "../sockets/index.js";
import { logActivity } from "../lib/activity.js";

const MAX_DEPTH = 3;

export type AutomationEvent = {
  type:
    | "card_created"
    | "card_moved"
    | "label_added"
    | "member_assigned"
    | "due_approaching"
    | "due_completed"
    | "checklist_completed"
    | "field_changed";
  cardId: string;
  listId: string;
  fromListId?: string;
  labelId?: string;
  userId?: string;
  fieldId?: string;
  checklistId?: string;
};

type Rule = typeof schema.automationRules.$inferSelect;

/** fire-and-forget from routes — never blocks or fails a request */
export function dispatchAutomation(
  boardId: string,
  event: AutomationEvent,
  actorId: string | null,
  depth = 0,
): void {
  run(boardId, event, actorId, depth).catch((err) =>
    console.error("automation error:", err.message),
  );
}

async function run(
  boardId: string,
  event: AutomationEvent,
  actorId: string | null,
  depth: number,
): Promise<void> {
  if (depth >= MAX_DEPTH) return;
  const rules = await db
    .select()
    .from(schema.automationRules)
    .where(and(eq(schema.automationRules.boardId, boardId), eq(schema.automationRules.enabled, true)));
  if (!rules.length) return;

  const [card] = await db.select().from(schema.cards).where(eq(schema.cards.id, event.cardId));
  if (!card) return;

  for (const rule of rules) {
    if (!triggerMatches(rule, event)) continue;
    if (!(await conditionsHold(rule, card.id, event.listId))) continue;
    try {
      await applyActions(rule, boardId, event, actorId, depth);
      await db.insert(schema.automationRuns).values({ ruleId: rule.id, cardId: card.id, ok: true, detail: event.type });
    } catch (err) {
      await db.insert(schema.automationRuns).values({
        ruleId: rule.id, cardId: card.id, ok: false,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

function triggerMatches(rule: Rule, event: AutomationEvent): boolean {
  const t = rule.trigger as { type?: string; listId?: string; fromListId?: string; labelId?: string; hoursBefore?: number };
  if (t.type !== event.type) return false;
  switch (event.type) {
    case "card_moved":
      if (t.listId && t.listId !== event.listId) return false;
      if (t.fromListId && t.fromListId !== event.fromListId) return false;
      return true;
    case "card_created":
      return !t.listId || t.listId === event.listId;
    case "label_added":
      return !t.labelId || t.labelId === event.labelId;
    case "field_changed":
      return !(t as { fieldId?: string }).fieldId || (t as { fieldId?: string }).fieldId === event.fieldId;
    default:
      return true;
  }
}

async function conditionsHold(rule: Rule, cardId: string, listId: string): Promise<boolean> {
  for (const cond of rule.conditions as Array<{ type: string; listId?: string; labelId?: string; userId?: string; text?: string; negate?: boolean }>) {
    let hold = true;
    switch (cond.type) {
      case "in_list":
        hold = cond.listId === listId;
        break;
      case "has_label": {
        const n = await db.$count(
          schema.cardLabels,
          and(eq(schema.cardLabels.cardId, cardId), eq(schema.cardLabels.labelId, cond.labelId ?? "")),
        );
        hold = n > 0;
        break;
      }
      case "has_member": {
        const n = await db.$count(
          schema.cardMembers,
          and(eq(schema.cardMembers.cardId, cardId), eq(schema.cardMembers.userId, cond.userId ?? "")),
        );
        hold = n > 0;
        break;
      }
      case "title_contains": {
        const [c] = await db.select({ title: schema.cards.title }).from(schema.cards).where(eq(schema.cards.id, cardId));
        hold = (c?.title ?? "").toLowerCase().includes((cond.text ?? "").toLowerCase());
        break;
      }
      default:
        hold = true;
    }
    if (cond.negate) hold = !hold;
    if (!hold) return false;
  }
  return true;
}

async function applyActions(
  rule: Rule,
  boardId: string,
  event: AutomationEvent,
  actorId: string | null,
  depth: number,
): Promise<void> {
  const cardId = event.cardId;
  const reload = async () => (await db.select().from(schema.cards).where(eq(schema.cards.id, cardId)))[0];

  for (const action of rule.actions as Array<Record<string, any>>) {
    const card = await reload();
    if (!card) return; // deleted mid-chain

    switch (action.type) {
      case "move_to_list": {
        const [target] = await db
          .select()
          .from(schema.lists)
          .where(and(eq(schema.lists.id, action.listId), eq(schema.lists.boardId, boardId)));
        if (!target || target.id === card.listId) break;
        const [last] = await db
          .select({ rank: schema.cards.rank })
          .from(schema.cards)
          .where(eq(schema.cards.listId, target.id))
          .orderBy(desc(schema.cards.rank))
          .limit(1);
        const [updated] = await db
          .update(schema.cards)
          .set({ listId: target.id, rank: after(last?.rank ?? null), updatedAt: new Date() })
          .where(eq(schema.cards.id, cardId))
          .returning();
        emitBoard(boardId, "card.updated", { card: updated });
        logActivity({ boardId, cardId, userId: null, type: "automation.moved", data: { rule: rule.name, to: target.name } });
        dispatchAutomation(boardId, { type: "card_moved", cardId, listId: target.id, fromListId: card.listId }, actorId, depth + 1);
        break;
      }
      case "set_due": {
        // action.inDays: relative due date from now
        const dueAt = new Date(Date.now() + Number(action.inDays ?? 1) * 86400_000);
        const [updated] = await db
          .update(schema.cards)
          .set({ dueAt, dueComplete: false, updatedAt: new Date() })
          .where(eq(schema.cards.id, cardId))
          .returning();
        emitBoard(boardId, "card.updated", { card: updated });
        break;
      }
      case "clear_due": {
        const [updated] = await db
          .update(schema.cards)
          .set({ dueAt: null, dueComplete: false, updatedAt: new Date() })
          .where(eq(schema.cards.id, cardId))
          .returning();
        emitBoard(boardId, "card.updated", { card: updated });
        break;
      }
      case "mark_due_complete": {
        const [updated] = await db
          .update(schema.cards)
          .set({ dueComplete: true, updatedAt: new Date() })
          .where(eq(schema.cards.id, cardId))
          .returning();
        emitBoard(boardId, "card.updated", { card: updated });
        break;
      }
      case "add_label": {
        const [label] = await db
          .select()
          .from(schema.labels)
          .where(and(eq(schema.labels.id, action.labelId), eq(schema.labels.boardId, boardId)));
        if (!label) break;
        await db.insert(schema.cardLabels).values({ cardId, labelId: label.id }).onConflictDoNothing();
        emitBoard(boardId, "card.labelAdded", { cardId, labelId: label.id });
        dispatchAutomation(boardId, { type: "label_added", cardId, listId: card.listId, labelId: label.id }, actorId, depth + 1);
        break;
      }
      case "remove_label": {
        await db
          .delete(schema.cardLabels)
          .where(and(eq(schema.cardLabels.cardId, cardId), eq(schema.cardLabels.labelId, action.labelId)));
        emitBoard(boardId, "card.labelRemoved", { cardId, labelId: action.labelId });
        break;
      }
      case "assign_member": {
        // must be a board member
        const [m] = await db
          .select()
          .from(schema.boardMembers)
          .where(and(eq(schema.boardMembers.boardId, boardId), eq(schema.boardMembers.userId, action.userId)));
        if (!m) break;
        await db.insert(schema.cardMembers).values({ cardId, userId: action.userId }).onConflictDoNothing();
        emitBoard(boardId, "card.memberAdded", { cardId, userId: action.userId });
        break;
      }
      case "unassign_member": {
        await db
          .delete(schema.cardMembers)
          .where(and(eq(schema.cardMembers.cardId, cardId), eq(schema.cardMembers.userId, action.userId)));
        emitBoard(boardId, "card.memberRemoved", { cardId, userId: action.userId });
        break;
      }
      case "set_field": {
        const [def] = await db
          .select()
          .from(schema.customFieldDefs)
          .where(and(eq(schema.customFieldDefs.id, action.fieldId), eq(schema.customFieldDefs.boardId, boardId)));
        if (!def) break;
        await db
          .insert(schema.customFieldValues)
          .values({ cardId, fieldId: def.id, value: action.value })
          .onConflictDoUpdate({
            target: [schema.customFieldValues.cardId, schema.customFieldValues.fieldId],
            set: { value: action.value },
          });
        emitBoard(boardId, "card.fieldChanged", { cardId, fieldId: def.id, value: action.value });
        dispatchAutomation(boardId, { type: "field_changed", cardId, listId: card.listId, fieldId: def.id }, actorId, depth + 1);
        break;
      }
      case "add_checklist": {
        const [last] = await db
          .select({ rank: schema.checklists.rank })
          .from(schema.checklists)
          .where(eq(schema.checklists.cardId, cardId))
          .orderBy(desc(schema.checklists.rank))
          .limit(1);
        const [checklist] = await db
          .insert(schema.checklists)
          .values({ cardId, name: String(action.name ?? "Checklist").slice(0, 120), rank: after(last?.rank ?? null) })
          .returning();
        const items: string[] = Array.isArray(action.items) ? action.items.slice(0, 50) : [];
        let rank: string | null = null;
        for (const text of items) {
          rank = after(rank);
          await db.insert(schema.checklistItems).values({
            checklistId: checklist.id, text: String(text).slice(0, 400), rank,
          });
        }
        emitBoard(boardId, "checklist.created", { cardId, checklist: { ...checklist, items: [] } });
        break;
      }
      case "comment": {
        const [comment] = await db
          .insert(schema.comments)
          .values({ cardId, userId: null, body: String(action.text ?? "").slice(0, 20_000) })
          .returning();
        emitBoard(boardId, "comment.created", {
          cardId,
          comment: { ...comment, userName: `⚙ ${rule.name}`, avatarColor: "#838c91" },
        });
        break;
      }
      case "notify": {
        // notify card members (or a specific user)
        const targets: string[] = action.userId
          ? [action.userId]
          : (
              await db
                .select({ userId: schema.cardMembers.userId })
                .from(schema.cardMembers)
                .where(eq(schema.cardMembers.cardId, cardId))
            ).map((r) => r.userId);
        for (const userId of targets) {
          const [n] = await db
            .insert(schema.notifications)
            .values({
              userId, type: "automation",
              data: { rule: rule.name, cardId, boardId, cardTitle: card.title, text: action.text ?? "" },
            })
            .returning();
          emitUser(userId, "notification", { notification: n });
        }
        break;
      }
      case "archive": {
        const [updated] = await db
          .update(schema.cards)
          .set({ archived: true, updatedAt: new Date() })
          .where(eq(schema.cards.id, cardId))
          .returning();
        emitBoard(boardId, "card.updated", { card: updated });
        break;
      }
    }
  }
}

/* ------------------------------------------------- due-approaching ticker */

const notifiedDue = new Set<string>(); // cardId:ruleId per process lifetime

/** every 10 min: fire due_approaching rules for cards inside their window */
export function startDueTicker(): NodeJS.Timeout {
  const tick = async () => {
    try {
      const rules = await db
        .select()
        .from(schema.automationRules)
        .where(eq(schema.automationRules.enabled, true));
      const dueRules = rules.filter((r) => (r.trigger as { type?: string }).type === "due_approaching");
      for (const rule of dueRules) {
        const hours = Number((rule.trigger as { hoursBefore?: number }).hoursBefore ?? 24);
        const now = new Date();
        const windowEnd = new Date(now.getTime() + hours * 3600_000);
        const cards = await db
          .select()
          .from(schema.cards)
          .where(
            and(
              eq(schema.cards.boardId, rule.boardId),
              eq(schema.cards.archived, false),
              eq(schema.cards.dueComplete, false),
              isNotNull(schema.cards.dueAt),
              gt(schema.cards.dueAt, now),
              lt(schema.cards.dueAt, windowEnd),
            ),
          );
        for (const card of cards) {
          const key = `${card.id}:${rule.id}`;
          if (notifiedDue.has(key)) continue;
          notifiedDue.add(key);
          dispatchAutomation(rule.boardId, { type: "due_approaching", cardId: card.id, listId: card.listId }, null);
        }
      }
      if (notifiedDue.size > 10_000) notifiedDue.clear();
    } catch (err) {
      console.error("due ticker error:", err instanceof Error ? err.message : err);
    }
  };
  tick();
  return setInterval(tick, 10 * 60_000);
}
