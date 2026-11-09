/**
 * Minimal RFC 5545 writer for the read-only calendar feeds. Only what the
 * feeds need (VEVENT with UTC times), so no library. Pure, unit-tested.
 */

export type IcsEvent = {
  uid: string;
  summary: string;
  /** instantaneous event when `end` is omitted (RFC 5545 3.6.1) */
  start: Date;
  end?: Date;
  description?: string;
  url?: string;
  lastModified?: Date;
  completed?: boolean;
};

/** TEXT escaping: backslash, semicolon, comma, newline */
export function escapeText(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n")
    // other control characters aren't allowed in TEXT values at all
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
}

/** content lines are folded at 75 octets (not characters), without splitting a UTF-8 sequence */
export function foldLine(line: string): string {
  const buf = Buffer.from(line, "utf8");
  if (buf.length <= 75) return line;
  const parts: string[] = [];
  let start = 0;
  let limit = 75;
  while (start < buf.length) {
    let end = Math.min(start + limit, buf.length);
    // back off to a character boundary (continuation bytes are 10xxxxxx)
    while (end < buf.length && (buf[end] & 0xc0) === 0x80) end--;
    parts.push(buf.subarray(start, end).toString("utf8"));
    start = end;
    limit = 74; // continuation lines start with a space, which counts
  }
  return parts.join("\r\n ");
}

export const icsDate = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

export function buildCalendar(name: string, events: IcsEvent[], now = new Date()): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//TR Studios//TR Board//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeText(name)}`,
    // a hint only; Google ignores it and polls on its own schedule
    "REFRESH-INTERVAL;VALUE=DURATION:PT30M",
    "X-PUBLISHED-TTL:PT30M",
  ];
  const stamp = icsDate(now);
  for (const e of events) {
    lines.push("BEGIN:VEVENT", `UID:${e.uid}`, `DTSTAMP:${stamp}`, `DTSTART:${icsDate(e.start)}`);
    if (e.end && e.end.getTime() > e.start.getTime()) lines.push(`DTEND:${icsDate(e.end)}`);
    lines.push(`SUMMARY:${escapeText((e.completed ? "✓ " : "") + e.summary)}`);
    if (e.description) lines.push(`DESCRIPTION:${escapeText(e.description)}`);
    if (e.url) lines.push(`URL:${e.url.replace(/[\r\n]/g, "")}`);
    if (e.lastModified) lines.push(`LAST-MODIFIED:${icsDate(e.lastModified)}`);
    lines.push("TRANSP:TRANSPARENT", "END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.map(foldLine).join("\r\n") + "\r\n";
}
