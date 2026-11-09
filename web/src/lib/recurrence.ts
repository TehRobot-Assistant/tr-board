/**
 * Recurring-card helpers shared by the card modal and the card front.
 * The server owns the date maths (server/src/lib/recurrenceRule.ts); this
 * only builds the request and describes a rule in words.
 */
export type Recurrence = {
  freq: "daily" | "weekly" | "monthly" | "yearly";
  interval: number;
  weekdays?: number[]; // ISO: 1 = Mon ... 7 = Sun
  tz?: string;
  monthDay?: number;
  month?: number;
  listId?: string;
};

export const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const UNIT: Record<Recurrence["freq"], [string, string]> = {
  daily: ["day", "days"],
  weekly: ["week", "weeks"],
  monthly: ["month", "months"],
  yearly: ["year", "years"],
};
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function describeRecurrence(r: Recurrence): string {
  const n = Math.max(1, r.interval || 1);
  const [one, many] = UNIT[r.freq];
  let s = n === 1 ? `Every ${one}` : `Every ${n} ${many}`;
  if (r.freq === "weekly" && r.weekdays?.length) {
    const days = [...r.weekdays].sort((a, b) => a - b);
    s += days.length === 5 && days.join() === "1,2,3,4,5" ? " on weekdays" : ` on ${days.map((d) => WEEKDAYS[d - 1]).join(", ")}`;
  }
  if (r.freq === "monthly" && r.monthDay) s += ` on day ${r.monthDay}`;
  if (r.freq === "yearly" && r.month && r.monthDay) s += ` on ${r.monthDay} ${MONTHS[r.month - 1]}`;
  return s;
}

/** the PATCH body for a rule; the browser's zone keeps "Monday 9am" local */
export function recurrenceRequest(
  freq: Recurrence["freq"],
  interval: number,
  weekdays: number[],
  tz = Intl.DateTimeFormat().resolvedOptions().timeZone,
): Recurrence {
  const body: Recurrence = { freq, interval: Math.min(365, Math.max(1, Math.floor(interval) || 1)), tz };
  if (freq === "weekly" && weekdays.length) body.weekdays = [...new Set(weekdays)].sort((a, b) => a - b);
  return body;
}

/** ISO weekday of a date in local time */
export const isoWeekday = (d: Date) => (d.getDay() === 0 ? 7 : d.getDay());

/** feed paths come back relative; calendar apps need the full URL */
export const absoluteUrl = (p: string, origin = window.location.origin) => new URL(p, origin).href;
