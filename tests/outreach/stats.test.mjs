// Tracking / mailbox health / re-touch pool roll-ups. Run: npm run test:outreach
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildMailboxHealth, buildRetouchPool, buildSuppression, buildTracking } from "../../lib/outreach/stats.ts";
import { OUTREACH_DDL } from "../../lib/outreach/schema.ts";

const DAY = 24 * 3600 * 1000;
const NOW = Date.parse("2026-09-30T18:00:00Z");
let id = 0;
const ev = (o) => ({
  id: ++id, eventType: "sent", occurredAt: new Date(NOW - DAY).toISOString(), contactEmail: "a@x.test", tenant: "wing",
  campaignId: "c1", mailbox: "m1@wing.test", step: 1, instantlyEmailId: null, threadId: null, subject: null, bodyText: null,
  interest: null, stopReason: null, source: "poll", dedupeKey: `k${id}`, payload: null, draftId: null, leadId: null, round: 1, ...o,
});

test("tracking: no sends means null rates, never 0%", () => {
  const t = buildTracking([], { now: NOW });
  assert.equal(t.totals.sent, 0);
  assert.equal(t.totals.replyRate, null);
  assert.equal(t.totals.bounceRate, null);
  assert.deepEqual(t.days, []);
});

test("tracking: replies are people, credited to the last step and mailbox that reached them", () => {
  const events = [
    ev({ contactEmail: "a@x.test", step: 1, mailbox: "m1@wing.test", occurredAt: new Date(NOW - 5 * DAY).toISOString() }),
    ev({ contactEmail: "a@x.test", step: 2, mailbox: "m2@wing.test", occurredAt: new Date(NOW - 2 * DAY).toISOString() }),
    ev({ contactEmail: "b@x.test", step: 1, mailbox: "m1@wing.test", occurredAt: new Date(NOW - 2 * DAY).toISOString() }),
    // a replies twice (one person), plus an auto reply that must not count
    ev({ eventType: "replied", contactEmail: "a@x.test", step: null, mailbox: null, occurredAt: new Date(NOW - DAY).toISOString() }),
    ev({ eventType: "replied", contactEmail: "a@x.test", step: null, mailbox: null, occurredAt: new Date(NOW - DAY + 3600e3).toISOString() }),
    ev({ eventType: "auto_replied", contactEmail: "b@x.test", step: null, mailbox: null }),
    ev({ eventType: "bounced", contactEmail: "b@x.test", step: null, mailbox: null, occurredAt: new Date(NOW - DAY).toISOString() }),
  ];
  const t = buildTracking(events, { now: NOW, windowDays: 30 });
  assert.equal(t.totals.sent, 3);
  assert.equal(t.totals.replies, 1);
  assert.equal(t.totals.bounces, 1);
  assert.ok(Math.abs(t.totals.replyRate - 1 / 3) < 1e-9);
  const step2 = t.steps.find((s) => s.step === 2);
  assert.equal(step2.replies, 1);
  assert.equal(t.steps.find((s) => s.step === 1).replies, 0);
  assert.equal(t.steps.find((s) => s.step === 1).bounces, 1); // b's last send was step 1
  const m2 = t.mailboxes.find((m) => m.mailbox === "m2@wing.test");
  assert.equal(m2.replies, 1);
  assert.equal(t.mailboxes.find((m) => m.mailbox === "m1@wing.test").bounces, 1);
});

test("mailbox health: 7-day bounce rate, complaints, engine pause state, quiet mailboxes", () => {
  const events = [];
  for (let i = 0; i < 40; i++) events.push(ev({ contactEmail: `p${i}@x.test`, mailbox: "m1@wing.test", occurredAt: new Date(NOW - 2 * DAY).toISOString() }));
  events.push(ev({ eventType: "bounced", contactEmail: "p1@x.test", mailbox: null, occurredAt: new Date(NOW - DAY).toISOString() }));
  events.push(ev({ eventType: "bounced", contactEmail: "p2@x.test", mailbox: null, occurredAt: new Date(NOW - DAY).toISOString() }));
  events.push(ev({ eventType: "complaint", contactEmail: "p3@x.test", mailbox: null, occurredAt: new Date(NOW - DAY).toISOString() }));
  // an old bounce outside 7 days does not count
  events.push(ev({ eventType: "bounced", contactEmail: "p4@x.test", mailbox: "m1@wing.test", occurredAt: new Date(NOW - 20 * DAY).toISOString() }));
  const states = [{ mailbox: "M1@wing.test", tenant: "wing", paused: true, pausedReason: "bounce rate 5%", pausedAt: "2026-09-30T10:00:00Z", updatedAt: "" }];
  const h = buildMailboxHealth(events, states, { now: NOW, mailboxes: ["m3@wing.test"] });
  const m1 = h.find((x) => x.mailbox === "m1@wing.test");
  assert.equal(m1.sent7, 40);
  assert.equal(m1.bounces7, 2);
  assert.equal(m1.bounceRate7, 0.05);
  assert.equal(m1.complaints7, 1);
  assert.equal(m1.paused, true);
  assert.equal(m1.level, "high");
  const m3 = h.find((x) => x.mailbox === "m3@wing.test");
  assert.equal(m3.sent7, 0);
  assert.equal(m3.bounceRate7, null);
  assert.equal(m3.level, "quiet");
});

const lead = (o) => ({
  tenant: "wing", email: "a@x.test", leadId: "1", company: "A", contactName: null, currentRound: 1,
  lastSentAt: null, nextRoundDue: null, stopReason: null, stoppedAt: null, stopSource: null, stopDetail: null, ...o,
});

test("re-touch: due ~75 days after the last send; stopped and never-emailed leads are out", () => {
  const last = NOW - 76 * DAY;
  const sends = new Map([["a@x.test", [last - 7 * DAY, last - 3 * DAY, last]]]);
  const pool = buildRetouchPool(
    [
      lead({ email: "a@x.test", lastSentAt: new Date(last).toISOString() }),
      lead({ email: "s@x.test", lastSentAt: new Date(last).toISOString(), stopReason: "handoff" }),
      lead({ email: "n@x.test" }),
    ],
    sends,
    { now: NOW }
  );
  assert.equal(pool.length, 1);
  assert.equal(pool[0].email, "a@x.test");
  assert.equal(pool[0].state, "due");
  assert.equal(pool[0].sentThisYear, 3);
  assert.equal(pool[0].remaining, 5);
});

test("re-touch: a round that would pass 8 emails in 365 days is capped until old sends age out", () => {
  // Two full rounds already this year (6 sends) -> a third round of 3 makes 9.
  const r1 = NOW - 200 * DAY;
  const r2 = NOW - 90 * DAY;
  const times = [r1, r1 + 3 * DAY, r1 + 7 * DAY, r2, r2 + 3 * DAY, r2 + 7 * DAY];
  const pool = buildRetouchPool([lead({ lastSentAt: new Date(r2 + 7 * DAY).toISOString(), currentRound: 2 })], new Map([["a@x.test", times]]), { now: NOW });
  assert.equal(pool.length, 1);
  assert.equal(pool[0].state, "capped");
  // Needs one old send to age out: the first send + 365 days.
  assert.ok(Date.parse(pool[0].dueAt) > r1 + 365 * DAY);
  assert.ok(Date.parse(pool[0].dueAt) < r1 + 366 * DAY);
});

test("re-touch: the engine's own next_round_due wins over the default interval", () => {
  const last = NOW - 10 * DAY;
  const due = new Date(NOW + 5 * DAY).toISOString();
  const pool = buildRetouchPool([lead({ lastSentAt: new Date(last).toISOString(), nextRoundDue: due })], new Map(), { now: NOW });
  assert.equal(pool[0].state, "upcoming");
  assert.equal(pool[0].dueAt, due);
});

test("suppression lists permanent stops only, newest first", () => {
  const rows = buildSuppression([
    lead({ email: "h@x.test", stopReason: "handoff", stoppedAt: "2026-09-29T00:00:00Z" }),
    lead({ email: "u@x.test", stopReason: "unsubscribed", stoppedAt: "2026-09-20T00:00:00Z" }),
    lead({ email: "b@x.test", stopReason: "hard_bounce", stoppedAt: "2026-09-25T00:00:00Z" }),
  ]);
  assert.deepEqual(rows.map((r) => r.email), ["b@x.test", "u@x.test"]);
});

test("schema: embedded DDL matches the migration file exactly", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const file = fs.readFileSync(path.join(here, "..", "..", "supabase", "migrations", "0040_outreach_queue.sql"), "utf8");
  assert.equal(OUTREACH_DDL.replace(/\r\n/g, "\n").trim(), file.replace(/\r\n/g, "\n").trim());
});
