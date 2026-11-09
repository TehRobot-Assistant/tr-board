/** client-side recurrence + feed URL helpers */
import { test } from "node:test";
import assert from "node:assert/strict";
import { absoluteUrl, describeRecurrence, isoWeekday, recurrenceRequest } from "../src/lib/recurrence.ts";

test("describeRecurrence reads naturally", () => {
  assert.equal(describeRecurrence({ freq: "daily", interval: 1 }), "Every day");
  assert.equal(describeRecurrence({ freq: "daily", interval: 3 }), "Every 3 days");
  assert.equal(describeRecurrence({ freq: "weekly", interval: 2, weekdays: [4, 1] }), "Every 2 weeks on Mon, Thu");
  assert.equal(describeRecurrence({ freq: "weekly", interval: 1, weekdays: [1, 2, 3, 4, 5] }), "Every week on weekdays");
  assert.equal(describeRecurrence({ freq: "monthly", interval: 1, monthDay: 31 }), "Every month on day 31");
  assert.equal(describeRecurrence({ freq: "yearly", interval: 1, month: 2, monthDay: 29 }), "Every year on 29 Feb");
});

test("recurrenceRequest clamps the interval and only sends weekdays for weekly", () => {
  assert.deepEqual(recurrenceRequest("weekly", 0, [3, 1, 3], "Pacific/Auckland"), {
    freq: "weekly", interval: 1, tz: "Pacific/Auckland", weekdays: [1, 3],
  });
  assert.deepEqual(recurrenceRequest("monthly", 999, [1], "UTC"), { freq: "monthly", interval: 365, tz: "UTC" });
  assert.equal(typeof recurrenceRequest("daily", 1, []).tz, "string");
});

test("isoWeekday and absoluteUrl", () => {
  assert.equal(isoWeekday(new Date(2026, 10, 8)), 7); // Sunday
  assert.equal(isoWeekday(new Date(2026, 10, 9)), 1); // Monday
  assert.equal(absoluteUrl("/api/feed/abc/my.ics", "https://board.example.com"), "https://board.example.com/api/feed/abc/my.ics");
});
