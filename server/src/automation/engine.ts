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
 * Loop safety (H2). A depth limit alone bounded how DEEP a chain went but not
 * how WIDE: 5 rules x 10 add_label actions re-dispatching each other produced
 * thousands of runs from one click. Every chain started by one real event now
 * shares a Chain context with:
 *   - MAX_DEPTH hops (automation-caused events still re-dispatch, so rule
 *     chaining like "moved to Done -> archive" keeps working, but only 3 deep),
 *   - MAX_CHAIN_ACTIONS executed actions in total, across every branch,
 *   - a (rule, card, event) dedupe so a rule never re-runs on the same card
 *     for the same kind of event within one chain (stops A->B->A ping-pong).
 * Rules per board are capped at MAX_RULES_PER_BOARD at creation time.
 */
import { spawnNextOccurrence } from "../lib/recurrence.js";
import { and, desc, eq, gt, isNotNull, lt, sql } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { userCanReadBoard } from "../lib/perms.js";
import { after } from "../lib/rank.js";
import { emitBoard, emitUser } from "../sockets/index.js";
import { logActivity } from "../lib/activity.js";

const MAX_DEPTH = 3;
/** total actions one triggering event may cause, summed over the whole chain */
export const MAX_CHAIN_ACTIONS = 100;
/** enforced in routes/phase1.ts (and board copy) when rules are created */
export const MAX_RULES_PER_BOARD = 50;

type Chain = { depth: number; budget: { left: number }; seen: Set<string> };

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
  /**
   * due_approaching only: the rule whose window this card entered. Each
   * due rule has its own hoursBefore, so the ticker fires per rule; without
   * this, one rule's tick ran every due_approaching rule on the board.
   */
  ruleId?: string;
};

type Rule = typeof schema.automationRules.$inferSelect;

/**
 * Fire-and-forget from routes — never blocks or fails a request. Routes call
 * this without `parent`, which starts a fresh chain with a full budget; the
 * engine passes the parent chain for automation-caused events.
 */
export function dispatchAutomation(
  boardId: string,
  event: AutomationEvent,
  actorId: string | null,
  parent?: Chain,
): void {
  const chain: Chain = parent
    ? { depth: parent.depth + 1, budget: parent.budget, seen: parent.seen }
    : { depth: 0, budget: { left: MAX_CHAIN_ACTIONS }, seen: new Set() };
  run(boardId, event, actorId, chain).catch((err) =>
    console.error("automation error:", err instanceof Error ? err.message : err),
  );
}

async function run(
  boardId: string,
  event: AutomationEvent,
  actorId: string | null,
  chain: Chain,
): Promise<void> {
  if (chain.depth >= MAX_DEPTH || chain.budget.left <= 0) return;
  const rules = await db
    .select()
    .from(schema.automationRules)
    .where(and(eq(schema.automationRules.boardId, boardId), eq(schema.automationRules.enabled, true)));
  if (!rules.length) return;

  const [card] = await db.select().from(schema.cards).where(eq(schema.cards.id, event.cardId));
  if (!card) return;

  for (const rule of rules) {
    if (chain.budget.left <= 0) break;
    if (!triggerMatches(rule, event)) continue;
    const key = `${rule.id}:${card.id}:${event.type}`;
    if (chain.seen.has(key)) continue;
    if (!(await conditionsHold(rule, card.id, event.listId))) continue;
    chain.seen.add(key);
    try {
      await applyActions(rule, boardId, event, actorId, chain);
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
    case "due_approaching":
      return !event.ruleId || event.ruleId === rule.id;
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
  chain: Chain,
): Promise<void> {
  const cardId = event.cardId;
  const reload = async () => (await db.select().from(schema.cards).where(eq(schema.cards.id, cardId)))[0];

  for (const action of rule.actions as Array<Record<string, any>>) {
    if (chain.budget.left <= 0) {
      // Throwing records this run as failed in automation_runs, so the rule log
      // shows why it stopped part-way (and "ok" always means every action ran).
      throw new Error(`stopped: one event may cause at most ${MAX_CHAIN_ACTIONS} automation actions`);
    }
    chain.budget.left--;
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
        dispatchAutomation(boardId, { type: "card_moved", cardId, listId: target.id, fromListId: card.listId }, actorId, chain);
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
        // a rule completing a repeating card must roll it on like a person would
        await spawnNextOccurrence(cardId, null);
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
        dispatchAutomation(boardId, { type: "label_added", cardId, listId: card.listId, labelId: label.id }, actorId, chain);
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
        dispatchAutomation(boardId, { type: "field_changed", cardId, listId: card.listId, fieldId: def.id }, actorId, chain);
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
        for (const userId of new Set(targets)) {
          // M8: the notification carries the card title + board id; only send
          // it to people who can already read the board (also covers
          // action.userId, which is free-form in the rule)
          if (!(await userCanReadBoard(userId, boardId))) continue;
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

/**
 * Claim the (rule, card, due date) firing. M10: the dedupe used to be an
 * in-memory Set (also cleared past 10k entries), so every restart re-fired
 * every card in its window: duplicate comments and notifications, and
 * move/set_due actions re-ran. Now a row in automation_due_fired, claimed
 * atomically: the upsert only writes (and returns a row) when there is no
 * firing yet for this rule+card or it was for a different due date, so a
 * rescheduled card fires again but a restart doesn't, and two overlapping
 * ticks can't both claim it.
 */
async function claimDueFiring(ruleId: string, cardId: string, dueAt: Date): Promise<boolean> {
  const rows = await db
    .insert(schema.automationDueFired)
    .values({ ruleId, cardId, dueAt })
    .onConflictDoUpdate({
      target: [schema.automationDueFired.ruleId, schema.automationDueFired.cardId],
      set: { dueAt, firedAt: new Date() },
      setWhere: sql`${schema.automationDueFired.dueAt} is distinct from excluded.due_at`,
    })
    .returning({ ruleId: schema.automationDueFired.ruleId });
  return rows.length > 0;
}

/** one pass: fire due_approaching rules for cards inside their window */
export async function dueTick(): Promise<void> {
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
      if (!(await claimDueFiring(rule.id, card.id, card.dueAt!))) continue;
      dispatchAutomation(
        rule.boardId,
        { type: "due_approaching", cardId: card.id, listId: card.listId, ruleId: rule.id },
        null,
      );
    }
  }
}

/** every 10 min (and once at boot) */
export function startDueTicker(): NodeJS.Timeout {
  const tick = () =>
    dueTick().catch((err) => console.error("due ticker error:", err instanceof Error ? err.message : err));
  void tick();
  return setInterval(tick, 10 * 60_000);
}
