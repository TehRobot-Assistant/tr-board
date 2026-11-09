/**
 * Pure-function tests for the Nov 2026 features: TOTP (RFC 6238 vectors),
 * recurrence date maths, the iCal writer, and the tar writer/reader
 * (including interop with the system `tar`). No database needed.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import { base32Decode, base32Encode, hotp, matchStep, normaliseRecoveryCode, newRecoveryCode, stepAt } from "../src/lib/totp.js";
import { nextDue, normaliseRule, toLocal } from "../src/lib/recurrenceRule.js";
import { buildCalendar, escapeText, foldLine } from "../src/lib/ical.js";
import { readTar, TarWriter } from "../src/lib/tar.js";

describe("TOTP", () => {
  test("RFC 6238 appendix B vectors (SHA1, 8 digits)", () => {
    const key = Buffer.from("12345678901234567890");
    const vectors: Array<[number, string]> = [
      [59, "94287082"], [1111111109, "07081804"], [1111111111, "14050471"],
      [1234567890, "89005924"], [2000000000, "69279037"], [20000000000, "65353130"],
    ];
    for (const [t, code] of vectors) assert.equal(hotp(key, Math.floor(t / 30), 8), code, `t=${t}`);
  });

  test("base32 round-trips and matchStep accepts +-1 step only", () => {
    const secret = base32Encode(Buffer.from("12345678901234567890"));
    assert.equal(secret, "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    assert.deepEqual(base32Decode(secret), Buffer.from("12345678901234567890"));
    const now = 1_800_000_000_000;
    const key = base32Decode(secret);
    const s = stepAt(now);
    assert.equal(matchStep(secret, hotp(key, s), now), s);
    assert.equal(matchStep(secret, hotp(key, s - 1), now), s - 1);
    assert.equal(matchStep(secret, hotp(key, s + 1), now), s + 1);
    assert.equal(matchStep(secret, hotp(key, s - 2), now), null);
    assert.equal(matchStep(secret, "12345", now), null);
    assert.equal(matchStep(secret, "abcdef", now), null);
  });

  test("recovery codes are 16 base32 chars and normalise", () => {
    const c = newRecoveryCode();
    assert.match(c, /^[a-z2-7]{4}-[a-z2-7]{4}-[a-z2-7]{4}-[a-z2-7]{4}$/);
    assert.equal(normaliseRecoveryCode(` ${c.toUpperCase()} `), c.replace(/-/g, ""));
  });
});

describe("recurrence", () => {
  const AKL = "Pacific/Auckland";
  const at = (iso: string) => new Date(iso);
  const past = at("2000-01-01T00:00:00Z");

  test("daily keeps the wall-clock time across a DST change", () => {
    // NZ DST starts Sun 27 Sep 2026 (02:00 -> 03:00)
    const due = at("2026-09-26T09:00:00+12:00"); // Sat 9am NZST
    const next = nextDue(due, normaliseRule({ freq: "daily", interval: 1, tz: AKL }, due), past);
    assert.equal(next.toISOString(), at("2026-09-27T09:00:00+13:00").toISOString());
    const l = toLocal(next, AKL);
    assert.deepEqual([l.d, l.h], [27, 9]);
  });

  test("weekly on chosen weekdays, every 2 weeks", () => {
    const due = at("2026-11-02T09:00:00+13:00"); // Monday
    const rule = normaliseRule({ freq: "weekly", interval: 2, weekdays: [1, 4], tz: AKL }, due);
    const thu = nextDue(due, rule, past);
    assert.equal(toLocal(thu, AKL).d, 5); // Thu 5 Nov
    const mon = nextDue(thu, rule, past);
    assert.deepEqual([toLocal(mon, AKL).m, toLocal(mon, AKL).d], [11, 16]); // Mon two weeks on
  });

  test("weekly with no weekdays repeats on the due date's weekday", () => {
    const due = at("2026-11-04T10:00:00Z"); // Wednesday
    const rule = normaliseRule({ freq: "weekly", interval: 1, tz: "UTC" }, due);
    assert.deepEqual(rule.weekdays, [3]);
    assert.equal(nextDue(due, rule, past).toISOString(), "2026-11-11T10:00:00.000Z");
  });

  test("monthly on the 31st clamps and then returns to the 31st", () => {
    const due = at("2027-01-31T12:00:00Z");
    const rule = normaliseRule({ freq: "monthly", interval: 1, tz: "UTC" }, due);
    const feb = nextDue(due, rule, past);
    assert.equal(feb.toISOString(), "2027-02-28T12:00:00.000Z");
    assert.equal(nextDue(feb, rule, past).toISOString(), "2027-03-31T12:00:00.000Z");
  });

  test("yearly on Feb 29", () => {
    const due = at("2028-02-29T08:00:00Z");
    const rule = normaliseRule({ freq: "yearly", interval: 1, tz: "UTC" }, due);
    const n1 = nextDue(due, rule, past);
    assert.equal(n1.toISOString(), "2029-02-28T08:00:00.000Z");
    assert.equal(nextDue(at("2031-02-28T08:00:00Z"), rule, past).toISOString(), "2032-02-29T08:00:00.000Z");
  });

  test("a late completion skips to the first future occurrence", () => {
    const due = at("2026-10-01T09:00:00Z");
    const rule = normaliseRule({ freq: "weekly", interval: 1, tz: "UTC" }, due);
    const now = at("2026-10-20T12:00:00Z");
    assert.equal(nextDue(due, rule, now).toISOString(), "2026-10-22T09:00:00.000Z");
  });

  test("an unknown zone falls back to UTC", () => {
    const rule = normaliseRule({ freq: "daily", interval: 3, tz: "Mars/Olympus" }, new Date());
    assert.equal(rule.tz, "UTC");
  });
});

describe("iCal writer", () => {
  test("escapes TEXT and folds at 75 octets without splitting UTF-8", () => {
    assert.equal(escapeText("a,b;c\\d\ne"), "a\\,b\\;c\\\\d\\ne");
    const long = "SUMMARY:" + "é".repeat(60);
    const folded = foldLine(long);
    for (const line of folded.split("\r\n")) assert.ok(Buffer.byteLength(line) <= 75);
    assert.equal(folded.split("\r\n").map((l, i) => (i ? l.slice(1) : l)).join(""), long);
  });

  test("builds a calendar with CRLF lines and UTC times", () => {
    const ics = buildCalendar("X", [
      { uid: "card-1@trboard", summary: "Renew, cert", start: new Date("2026-11-05T01:02:03Z"), completed: true },
      { uid: "card-2@trboard", summary: "Span", start: new Date("2026-11-01T00:00:00Z"), end: new Date("2026-11-03T00:00:00Z") },
    ]);
    assert.ok(ics.startsWith("BEGIN:VCALENDAR\r\n"));
    assert.ok(ics.endsWith("END:VCALENDAR\r\n"));
    assert.match(ics, /DTSTART:20261105T010203Z/);
    assert.match(ics, /SUMMARY:✓ Renew\\, cert/);
    assert.match(ics, /DTEND:20261103T000000Z/);
    assert.equal((ics.match(/BEGIN:VEVENT/g) ?? []).length, 2);
  });
});

describe("tar", () => {
  test("system tar reads our archives, including pax long names", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trboard-tar-"));
    try {
      const file = path.join(dir, "a.tar");
      const out = fs.createWriteStream(file);
      const w = new TarWriter(out);
      const long = `uploads/${"a".repeat(36)}/${"b".repeat(36)}-ünïcødé-name-that-is-long.txt`;
      await w.add("db/x.ndjson", 3, Buffer.from("{}\n"));
      await w.add(long, 5, Readable.from([Buffer.from("he"), Buffer.from("llo")]));
      await w.finish();
      const listed = execFileSync("tar", ["-tf", file]).toString().trim().split("\n");
      assert.deepEqual(listed, ["db/x.ndjson", long]);
      execFileSync("tar", ["-xf", file, "-C", dir]);
      assert.equal(fs.readFileSync(path.join(dir, long), "utf8"), "hello");

      const seen: Record<string, string> = {};
      await readTar(fs.createReadStream(file), async (e, chunks) => {
        const parts: Buffer[] = [];
        for await (const c of chunks()) parts.push(c);
        seen[e.name] = Buffer.concat(parts).toString();
      });
      assert.deepEqual(seen, { "db/x.ndjson": "{}\n", [long]: "hello" });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the reader refuses symlinks and corrupt headers", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trboard-tar-"));
    try {
      fs.symlinkSync("/etc/passwd", path.join(dir, "evil"));
      const file = path.join(dir, "evil.tar");
      execFileSync("tar", ["-cf", file, "-C", dir, "evil"]);
      await assert.rejects(readTar(fs.createReadStream(file), async () => {}), /unsupported tar entry type '2'/);
      const bad = Buffer.alloc(1024);
      bad.write("x", 0);
      bad.write("0000000", 148);
      const s = new PassThrough();
      s.end(bad);
      await assert.rejects(readTar(s, async () => {}), /checksum/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
