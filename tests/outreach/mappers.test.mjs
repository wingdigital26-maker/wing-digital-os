// Ingest + sync mapper tests. Run: npm run test:outreach
// Node strips the TypeScript types from lib/outreach/*.ts on import (Node 23.6+).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  contextFromPath,
  isPermanentStop,
  mapInstantlyEmail,
  mapInstantlyLead,
  mapWebhookEvent,
  mergeStop,
  normalizeQueueItem,
  parseStep,
  stepsDiffer,
  stopReasonForReply,
} from "../../lib/outreach/mappers.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (f) => JSON.parse(fs.readFileSync(path.join(here, "fixtures", f), "utf8"));

// ── ingest ──────────────────────────────────────────────────────────────────

test("ingest: a real engine queue file (custom-outreach-item/1) maps to a draft", () => {
  const item = fixture("queue-item-2622.json");
  item.research = fixture("research-2622.json"); // what scripts/outreach_ingest.mjs inlines
  const r = normalizeQueueItem(item, contextFromPath("wing/2026-09-28/2622.json"));
  assert.equal(r.ok, true, r.reason);
  const d = r.draft;
  assert.equal(d.tenant, "wing");
  assert.equal(d.leadId, "2622");
  assert.equal(d.batchDate, "2026-09-28");
  assert.equal(d.round, 1);
  assert.equal(d.company, "Example Plumbing Co");
  assert.equal(d.contactName, "Dana");
  assert.equal(d.contactEmail, "owner@example-plumbing.test");
  assert.equal(d.steps.length, 3);
  assert.deepEqual(d.steps.map((s) => s.step), [1, 2, 3]);
  assert.ok(d.steps[0].subject.length > 0 && d.steps[0].body.length > 0);
  assert.equal(d.steps[0].factId, "serp_absent");
  assert.equal(d.qaStatus, "passed");
  assert.deepEqual(d.qaReasons, []);
  assert.equal(d.engineApproval, null);
  assert.equal(d.sourcePath, "wing/2026-09-28/2622.json");
  // Facts the emails cite come first and are flagged.
  const cited = new Set(d.steps.map((s) => s.factId));
  assert.ok(d.facts.length > 0);
  assert.equal(d.facts[0].used, true);
  for (const f of d.facts) assert.equal(f.used, Boolean(f.id && cited.has(f.id)));
});

test("ingest: a blocked item with no sequence is refused with a reason, not loaded empty", () => {
  const r = normalizeQueueItem(fixture("queue-item-blocked.json"), contextFromPath("wing/2026-09-28/8.json"));
  assert.equal(r.ok, false);
  assert.match(r.reason, /no email steps \(status blocked\)/);
});

test("ingest: tenant and date fall back to the folder, aliases are accepted", () => {
  const r = normalizeQueueItem(
    {
      lead_id: 77,
      status: "qa-failed",
      company: "Acme Roofing",
      email: "Boss@Acme.test",
      emails: [
        { subject: "roof leak", text: "Body one" },
        { subject: "follow up", text: "Body two", delay_days: 3 },
      ],
      qa: { passed: false, failures: [{ step: 2, reason: "over 110 words" }, "no opt-out"] },
    },
    contextFromPath("outreach_queue/acme/2026-10-01/77.json")
  );
  assert.equal(r.ok, true);
  assert.equal(r.draft.tenant, "acme");
  assert.equal(r.draft.batchDate, "2026-10-01");
  assert.equal(r.draft.contactEmail, "boss@acme.test");
  assert.equal(r.draft.qaStatus, "failed");
  assert.deepEqual(r.draft.qaReasons, ["Step 2: over 110 words", "no opt-out"]);
  assert.equal(r.draft.steps[1].delayDays, 3);
});

test("ingest: missing lead id, date or tenant is refused", () => {
  assert.equal(normalizeQueueItem({ tenant: "wing", date: "2026-09-28", sequence: [{ subject: "a", body: "b" }] }).ok, false);
  assert.equal(normalizeQueueItem({ tenant: "wing", lead_id: 1, sequence: [{ subject: "a", body: "b" }] }).ok, false);
  assert.equal(normalizeQueueItem({ lead_id: 1, date: "2026-09-28", sequence: [{ subject: "a", body: "b" }] }).ok, false);
  assert.equal(normalizeQueueItem("not an object").ok, false);
});

test("ingest: engine approval, push time, re-touch round and engine stop carry over", () => {
  const r = normalizeQueueItem({
    tenant: "wing", lead_id: 5, date: "2026-12-12", round: 2, status: "pushed",
    lead: { company: "X", email: "x@x.test" },
    sequence: [{ step: 1, subject: "s", body: "b" }],
    approval: { by: "Jack Wing", at: "2026-12-12T15:00:00Z" },
    push: { ts: "2026-12-12T16:00:00Z" },
    stop_reason: "unsubscribed",
    next_round_due: "2027-02-25",
  });
  assert.equal(r.ok, true);
  assert.equal(r.draft.round, 2);
  assert.deepEqual(r.draft.engineApproval, { approver: "Jack Wing", at: "2026-12-12T15:00:00.000Z" });
  assert.equal(r.draft.pushedAt, "2026-12-12T16:00:00.000Z");
  assert.equal(r.draft.stopReason, "unsubscribed");
  assert.equal(r.draft.qaStatus, "passed"); // past QA in the engine lifecycle
  assert.equal(r.draft.nextRoundDue, "2027-02-25T00:00:00.000Z");
});

test("ingest: stepsDiffer notices an edited subject or body only", () => {
  const a = [{ step: 1, subject: "s", body: "b", delayDays: 0 }];
  assert.equal(stepsDiffer(a, [{ step: 1, subject: "s", body: "b", delayDays: null }]), false);
  assert.equal(stepsDiffer(a, [{ step: 1, subject: "S", body: "b", delayDays: 0 }]), true);
  assert.equal(stepsDiffer(a, []), true);
});

// ── sync: Instantly /emails ─────────────────────────────────────────────────

const SENT = {
  id: "e1", ue_type: 1, step: "0_1_0", eaccount: "JackWing@getwingdigital.com", lead: "Owner@Example.test",
  campaign_id: "c1", timestamp_email: "2026-09-28T14:16:56.000Z", subject: "roof", thread_id: "t1",
  body: { html: "<div>Hi<br>there</div>" },
};

test("sync: a campaign send (ue_type 1) becomes a sent event with step, mailbox and a shared dedupe key", () => {
  const ev = mapInstantlyEmail(SENT);
  assert.equal(ev.eventType, "sent");
  assert.equal(ev.contactEmail, "owner@example.test");
  assert.equal(ev.mailbox, "jackwing@getwingdigital.com");
  assert.equal(ev.step, 2); // "0_1_0" = second step, humans count from 1
  assert.equal(ev.bodyText, "Hi\nthere");
  assert.equal(ev.dedupeKey, "sent:c1:owner@example.test:2:2026-09-28");
  assert.equal(ev.stopReason, null);
});

test("sync: the webhook copy of the same send dedupes onto the poll copy", () => {
  const wh = mapWebhookEvent(
    { event_type: "email_sent", lead_email: "owner@example.test", campaign_id: "c1", step: 1, timestamp: "2026-09-28T14:17:01Z", email_account: "jackwing@getwingdigital.com" },
    "2026-09-28T14:17:03Z"
  );
  assert.equal(wh.dedupeKey, mapInstantlyEmail(SENT).dedupeKey);
});

test("sync: manual (3) and scheduled (4) emails are not campaign events", () => {
  assert.equal(mapInstantlyEmail({ ...SENT, ue_type: 3 }), null);
  assert.equal(mapInstantlyEmail({ ...SENT, ue_type: 4 }), null);
  assert.equal(mapInstantlyEmail({ ...SENT, timestamp_email: undefined, timestamp_created: undefined }), null);
});

test("sync: a real reply is a handoff, with the quoted thread cut off", () => {
  const ev = mapInstantlyEmail({
    id: "r1", ue_type: 2, from_address_email: "owner@example.test", eaccount: "jackwing@getwingdigital.com",
    campaign_id: "c1", timestamp_email: "2026-09-29T15:00:00Z",
    body: { text: "Sure, send the list over.\n\nOn Mon, Sep 28, 2026 at 9:16 AM Jack <jackwing@getwingdigital.com> wrote:\n> roof" },
  });
  assert.equal(ev.eventType, "replied");
  assert.equal(ev.bodyText, "Sure, send the list over.");
  assert.equal(ev.stopReason, "handoff");
  assert.equal(ev.dedupeKey, "reply:r1");
});

test("sync: 'no thanks' / 'remove me' / not-interested label are permanent negative stops", () => {
  assert.equal(stopReasonForReply("no thanks", null), "negative_reply");
  assert.equal(stopReasonForReply("Please remove me from your list", null), "negative_reply");
  assert.equal(stopReasonForReply("ok", -1), "negative_reply");
  assert.equal(stopReasonForReply("This is spam, reporting you", null), "spam_complaint");
  assert.equal(stopReasonForReply("What does it cost?", 1), "handoff");
});

test("sync: auto-replies never stop a lead", () => {
  const ev = mapInstantlyEmail({ id: "r2", ue_type: 2, is_auto_reply: 1, from_address_email: "a@b.test", timestamp_email: "2026-09-29T15:00:00Z", body: { text: "I am out of office" } });
  assert.equal(ev.eventType, "auto_replied");
  assert.equal(ev.stopReason, null);
});

test("sync: parseStep handles Instantly's step codes", () => {
  assert.equal(parseStep("0_0_0"), 1);
  assert.equal(parseStep("0_3_1"), 4);
  assert.equal(parseStep(0), 1);
  assert.equal(parseStep(null), null);
  assert.equal(parseStep("junk"), null);
});

// ── sync: lead outcomes ─────────────────────────────────────────────────────

test("sync: lead status -1 = hard bounce, -2 = unsubscribed, labels and opens map", () => {
  const now = "2026-09-30T00:00:00.000Z";
  const bounced = mapInstantlyLead({ email: "b@x.test", status: -1, timestamp_updated: "2026-09-29T10:00:00Z" }, "c1", now);
  assert.deepEqual(bounced.map((e) => [e.eventType, e.stopReason, e.dedupeKey]), [["bounced", "hard_bounce", "bounced:c1:b@x.test"]]);
  const unsub = mapInstantlyLead({ email: "u@x.test", status: -2 }, "c1", now);
  assert.equal(unsub[0].eventType, "unsubscribed");
  assert.equal(unsub[0].stopReason, "unsubscribed");
  assert.equal(unsub[0].occurredAt, now);
  const notInt = mapInstantlyLead({ email: "n@x.test", status: 3, lt_interest_status: -1 }, "c1", now);
  assert.deepEqual(notInt.map((e) => e.stopReason), ["negative_reply"]);
  const hot = mapInstantlyLead({ email: "h@x.test", status: 1, lt_interest_status: 2, email_open_count: 3 }, "c1", now);
  assert.deepEqual(hot.map((e) => e.eventType), ["meeting_booked", "opened"]);
  assert.deepEqual(mapInstantlyLead({ email: "q@x.test", status: 3 }, "c1", now), []);
  assert.deepEqual(mapInstantlyLead({ status: -1 }, "c1", now), []);
});

// ── sync: webhook ───────────────────────────────────────────────────────────

test("webhook: unsubscribe, hard and soft bounce, negative label, complaint", () => {
  const at = "2026-09-29T12:00:00Z";
  const u = mapWebhookEvent({ event_type: "lead_unsubscribed", lead_email: "u@x.test" }, at);
  assert.equal(u.stopReason, "unsubscribed");
  assert.equal(u.dedupeKey, "unsubscribed:u@x.test"); // same key the lead poll builds
  const hb = mapWebhookEvent({ event_type: "email_bounced", lead_email: "b@x.test", campaign_id: "c1" }, at);
  assert.equal(hb.stopReason, "hard_bounce");
  assert.equal(hb.dedupeKey, "bounced:c1:b@x.test");
  const sb = mapWebhookEvent({ event_type: "email_bounced", lead_email: "b@x.test", bounce_type: "soft" }, at);
  assert.equal(sb.stopReason, null);
  const neg = mapWebhookEvent({ event_type: "custom_label_any_negative", lead_email: "n@x.test" }, at);
  assert.equal(neg.stopReason, "negative_reply");
  const c = mapWebhookEvent({ event_type: "email_complaint", lead_email: "c@x.test" }, at);
  assert.equal(c.eventType, "complaint");
  assert.equal(c.stopReason, "spam_complaint");
  assert.equal(mapWebhookEvent({ event_type: "account_error", lead_email: "a@x.test" }, at), null);
  assert.equal(mapWebhookEvent({ event_type: "reply_received" }, at), null);
});

test("webhook: a reply keeps what they wrote and never trusts a future timestamp", () => {
  const ev = mapWebhookEvent(
    { event_type: "reply_received", lead_email: "o@x.test", reply_text: "Take me off this list", timestamp: "2099-01-01T00:00:00Z" },
    "2026-09-29T12:00:00.000Z"
  );
  assert.equal(ev.occurredAt, "2026-09-29T12:00:00.000Z");
  assert.equal(ev.stopReason, "negative_reply");
  assert.equal(ev.bodyText, "Take me off this list");
});

// ── stop precedence ─────────────────────────────────────────────────────────

test("stops: permanent beats handoff, first permanent reason is kept", () => {
  assert.equal(mergeStop(null, "handoff"), "handoff");
  assert.equal(mergeStop("handoff", "unsubscribed"), "unsubscribed");
  assert.equal(mergeStop("unsubscribed", "hard_bounce"), "unsubscribed");
  assert.equal(mergeStop("hard_bounce", "handoff"), "hard_bounce");
  assert.equal(mergeStop("handoff", null), "handoff");
  assert.equal(isPermanentStop("handoff"), false);
  assert.equal(isPermanentStop("spam_complaint"), true);
});

test("stops: the engine's lead_state names map onto the OS's five", async () => {
  const { normalizeStop } = await import("../../lib/outreach/mappers.ts");
  assert.equal(normalizeStop("unsubscribe"), "unsubscribed");
  assert.equal(normalizeStop("replied-human-handoff"), "handoff");
  assert.equal(normalizeStop("hard_bounce"), "hard_bounce");
  assert.equal(normalizeStop("negative_reply"), "negative_reply");
  assert.equal(normalizeStop("spam_complaint"), "spam_complaint");
  assert.equal(normalizeStop("tenant yaml"), null);
  assert.equal(normalizeStop(null), null);
});

test("ingest: engine approval {approver, ts} and a round-2 file name", () => {
  const r = normalizeQueueItem(
    { tenant: "wing", lead_id: 9, round: 2, date: "2026-12-12", status: "approved", sequence: [{ step: 1, subject: "s", body: "b" }],
      approval: { approver: "Jack Wing", role: "owner", ts: "2026-12-12T15:00:00Z", sequence_hash: "x" } },
    contextFromPath("wing/2026-12-12/9.r2.json")
  );
  assert.equal(r.ok, true);
  assert.equal(r.draft.round, 2);
  assert.deepEqual(r.draft.engineApproval, { approver: "Jack Wing", at: "2026-12-12T15:00:00.000Z" });
});
