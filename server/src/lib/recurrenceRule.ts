/**
 * Recurring cards: the rule shape and the date maths. Pure (no DB), so it's
 * unit-tested directly (test/units.test.ts).
 *
 * All arithmetic happens in the rule's IANA time zone, not UTC: "every Monday
 * 9am" has to stay Monday 9am in Auckland across DST changes, and in UTC that
 * card is due on Sunday evening. The browser sends its zone when the rule is
 * set; a missing/unknown zone falls back to UTC.
 */
import { z } from "zod";

export type RecurrenceRule = {
  freq: "daily" | "weekly" | "monthly" | "yearly";
  /** every N days/weeks/months/years */
  interval: number;
  /** weekly only: ISO weekdays, 1 = Monday ... 7 = Sunday */
  weekdays?: number[];
  /** IANA zone the rule is evaluated in */
  tz: string;
  /**
   * monthly/yearly: the day-of-month to aim for, kept separately so a rule
   * anchored on the 31st clamps to the 30th/28th in short months and goes back
   * to the 31st after (Jan 31 -> Feb 28 -> Mar 31, not -> Mar 28). Filled in
   * by the server from the due date.
   */
  monthDay?: number;
  /** yearly: the month to aim for (1-12), for the same reason (Feb 29) */
  month?: number;
  /** optional: create the next copy in this list (default: the card's list) */
  listId?: string;
};

function validTz(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** what a client may send; monthDay/month are always derived server-side */
export const recurrenceInputSchema = z
  .object({
    freq: z.enum(["daily", "weekly", "monthly", "yearly"]),
    interval: z.number().int().min(1).max(365).default(1),
    weekdays: z.array(z.number().int().min(1).max(7)).max(7).optional(),
    tz: z.string().max(64).optional(),
    listId: z.string().uuid().optional(),
  })
  .strict();
export type RecurrenceInput = z.infer<typeof recurrenceInputSchema>;

type Local = { y: number; m: number; d: number; h: number; mi: number; s: number; ms: number };

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23",
      year: "numeric", month: "numeric", day: "numeric",
      hour: "numeric", minute: "numeric", second: "numeric",
    });
    fmtCache.set(tz, f);
  }
  return f;
}

/** wall-clock fields of instant `d` in zone `tz` */
export function toLocal(d: Date, tz: string): Local {
  const p: Record<string, number> = {};
  for (const part of fmt(tz).formatToParts(d)) {
    if (part.type !== "literal") p[part.type] = Number(part.value);
  }
  return { y: p.year, m: p.month, d: p.day, h: p.hour, mi: p.minute, s: p.second, ms: d.getUTCMilliseconds() };
}

/**
 * The instant at which zone `tz` shows wall time `l`. Two correction passes
 * handle offsets that differ either side of a DST change; a wall time that
 * doesn't exist (inside a spring-forward gap) lands an hour later, which is
 * what calendar apps do too.
 */
export function fromLocal(l: Local, tz: string): Date {
  const wall = Date.UTC(l.y, l.m - 1, l.d, l.h, l.mi, l.s, l.ms);
  let t = wall;
  for (let i = 0; i < 2; i++) {
    const seen = toLocal(new Date(t), tz);
    const seenWall = Date.UTC(seen.y, seen.m - 1, seen.d, seen.h, seen.mi, seen.s, l.ms);
    t += wall - seenWall;
  }
  return new Date(t);
}

const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** add n calendar days to the wall date (time of day unchanged) */
function addDays(l: Local, n: number): Local {
  const u = new Date(Date.UTC(l.y, l.m - 1, l.d + n));
  return { ...l, y: u.getUTCFullYear(), m: u.getUTCMonth() + 1, d: u.getUTCDate() };
}

/** ISO weekday (1 = Mon ... 7 = Sun) of a wall date */
function isoWeekday(l: Local): number {
  const w = new Date(Date.UTC(l.y, l.m - 1, l.d)).getUTCDay();
  return w === 0 ? 7 : w;
}

/** one step of the rule from `from` */
function step(from: Date, rule: RecurrenceRule): Date {
  const tz = validTz(rule.tz) ? rule.tz : "UTC";
  const l = toLocal(from, tz);
  const n = Math.max(1, Math.floor(rule.interval || 1));
  switch (rule.freq) {
    case "daily":
      return fromLocal(addDays(l, n), tz);
    case "weekly": {
      const days = [...new Set(rule.weekdays?.length ? rule.weekdays : [isoWeekday(l)])].sort((a, b) => a - b);
      const cur = isoWeekday(l);
      const later = days.find((d) => d > cur);
      if (later !== undefined) return fromLocal(addDays(l, later - cur), tz);
      // wrap: to Monday of this week, forward n weeks, then the first chosen day
      return fromLocal(addDays(l, 1 - cur + 7 * n + (days[0] - 1)), tz);
    }
    case "monthly": {
      const total = l.m - 1 + n;
      const y = l.y + Math.floor(total / 12);
      const m = (total % 12) + 1;
      const want = rule.monthDay ?? l.d;
      return fromLocal({ ...l, y, m, d: Math.min(want, daysInMonth(y, m)) }, tz);
    }
    case "yearly": {
      const y = l.y + n;
      const m = rule.month ?? l.m;
      const want = rule.monthDay ?? l.d;
      return fromLocal({ ...l, y, m, d: Math.min(want, daysInMonth(y, m)) }, tz);
    }
  }
}

/**
 * The next due date after `due`, stepping until it's in the future. A chore
 * completed three weeks late gets one new card due next week, not three
 * already-overdue ones (or one due in the past). Completing early just steps
 * once. The cap only guards against a corrupt rule looping forever.
 */
export function nextDue(due: Date, rule: RecurrenceRule, now: Date = new Date()): Date {
  let next = step(due, rule);
  for (let i = 0; i < 5000 && next.getTime() <= now.getTime(); i++) next = step(next, rule);
  return next;
}

/** turn client input into a stored rule anchored on the card's due date */
export function normaliseRule(input: RecurrenceInput, due: Date): RecurrenceRule {
  const tz = input.tz && validTz(input.tz) ? input.tz : "UTC";
  const l = toLocal(due, tz);
  const rule: RecurrenceRule = { freq: input.freq, interval: input.interval ?? 1, tz };
  if (input.freq === "weekly") {
    rule.weekdays = [...new Set(input.weekdays?.length ? input.weekdays : [isoWeekday(l)])].sort((a, b) => a - b);
  }
  if (input.freq === "monthly" || input.freq === "yearly") rule.monthDay = l.d;
  if (input.freq === "yearly") rule.month = l.m;
  if (input.listId) rule.listId = input.listId;
  return rule;
}

/** re-anchor an existing rule after the due date was edited by hand */
export function reanchor(rule: RecurrenceRule, due: Date): RecurrenceRule {
  return normaliseRule(
    { freq: rule.freq, interval: rule.interval, weekdays: rule.weekdays, tz: rule.tz, listId: rule.listId },
    due,
  );
}
