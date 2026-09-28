// Pure mappers for the outreach queue and the Instantly sync.
//
// No I/O, no imports beyond types: every function here takes plain JSON and
// returns plain JSON, so tests/outreach/*.test.mjs can run them directly with
// `node --test` and the routes can trust one definition of each mapping.
//
//   normalizeQueueItem()   ghl-cli outreach_queue/<tenant>/<date>/<lead>.json -> DraftInput
//   mapInstantlyEmail()    Instantly GET /emails row                         -> OutreachEventInput
//   mapInstantlyLead()     Instantly POST /leads/list row                    -> OutreachEventInput[]
//   mapWebhookEvent()      Instantly webhook body                            -> OutreachEventInput | null
//   stopReasonForReply()   reply text + interest label                       -> StopReason
//
// THE QUEUE SHAPE. ghl-cli's CUSTOM_OUTREACH.md is the contract. At the time
// this was written that file did not exist yet, so the ingest accepts the
// shape outreach_core.py implies AND the obvious aliases (lead.company or
// company, sequence or emails or steps, qa.passed or qa.status or status).
// A file that has no lead id or no steps is rejected with a reason, never
// half-loaded.
import type {
  DraftInput,
  DraftStep,
  OutreachEventInput,
  OutreachEventType,
  QaStatus,
  ResearchFact,
  StopReason,
} from "./types";

// ── small coercions ─────────────────────────────────────────────────────────

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => Boolean(v) && typeof v === "object" && !Array.isArray(v);

function str(v: unknown, max = 5_000): string | null {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return null;
}

/** First non-empty string among several candidate fields. */
function pick(o: Obj | null | undefined, keys: string[], max?: number): string | null {
  if (!o) return null;
  for (const k of keys) {
    const s = str(o[k], max);
    if (s) return s;
  }
  return null;
}

function isoOrNull(v: unknown): string | null {
  const s = str(v, 64);
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function lowerEmail(v: unknown): string | null {
  const s = str(v, 320);
  if (!s) return null;
  const first = s.split(",")[0].trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(first) ? first : null;
}

// ── ingest: one ghl-cli queue file -> DraftInput ────────────────────────────

/**
 * The engine's stop names (lead_state.stop_reason: unsubscribe, negative_reply,
 * spam_complaint, hard_bounce, replied-human-handoff) and loose wording from
 * suppression reasons, mapped onto the OS's five. Null = not a stop.
 */
export function normalizeStop(v: unknown): StopReason | null {
  const s = typeof v === "string" ? v.trim().toLowerCase().replace(/[\s-]+/g, "_") : "";
  if (!s) return null;
  if (s === "unsubscribed" || s === "negative_reply" || s === "spam_complaint" || s === "hard_bounce" || s === "handoff") return s;
  if (/handoff|human/.test(s)) return "handoff";
  if (/unsub|opt_?out/.test(s)) return "unsubscribed";
  if (/complain|spam/.test(s)) return "spam_complaint";
  if (/bounce/.test(s)) return "hard_bounce";
  if (/negative|remove|not_interested|no_thanks/.test(s)) return "negative_reply";
  return null;
}

export type IngestContext = {
  /** Tenant from the folder name, used when the file does not say. */
  tenant?: string | null;
  /** Batch date from the folder name (YYYY-MM-DD), used when the file does not say. */
  date?: string | null;
  sourcePath?: string | null;
};

export type IngestResult = { ok: true; draft: DraftInput } | { ok: false; reason: string };

function normalizeFacts(item: Obj, used: Set<string>): ResearchFact[] {
  const research = isObj(item.research) ? item.research : null;
  const raw =
    (Array.isArray(item.facts) && item.facts) ||
    (research && Array.isArray(research.facts) && research.facts) ||
    (research && Array.isArray(research.verified_facts) && research.verified_facts) ||
    (Array.isArray(item.research_facts) && item.research_facts) ||
    [];
  const out: ResearchFact[] = [];
  for (const f of raw as unknown[]) {
    if (typeof f === "string") {
      const t = str(f, 1_000);
      if (t) out.push({ id: null, kind: null, text: t, source: null, used: false });
    } else if (isObj(f)) {
      const text = pick(f, ["text", "fact", "claim", "value", "summary"], 1_000);
      const id = pick(f, ["id", "fact_id"], 120);
      if (text) {
        out.push({
          id,
          kind: pick(f, ["kind", "type"], 60),
          text,
          source: pick(f, ["source", "url", "source_url"], 1_000),
          used: Boolean(id && used.has(id)),
        });
      }
    }
  }
  // Facts the emails stand on first, then the rest of the research.
  return out.sort((a, b) => Number(b.used) - Number(a.used)).slice(0, 40);
}

function normalizeSteps(item: Obj): DraftStep[] {
  const raw =
    (Array.isArray(item.sequence) && item.sequence) ||
    (Array.isArray(item.emails) && item.emails) ||
    (Array.isArray(item.steps) && item.steps) ||
    (isObj(item.draft) && Array.isArray(item.draft.sequence) && item.draft.sequence) ||
    [];
  const out: DraftStep[] = [];
  (raw as unknown[]).forEach((e, i) => {
    if (!isObj(e)) return;
    const subject = pick(e, ["subject", "subject_line"], 500) ?? "";
    const body = pick(e, ["body", "text", "body_text", "content"], 20_000) ?? "";
    if (!subject && !body) return;
    out.push({
      step: num(e.step) ?? num(e.step_number) ?? i + 1,
      subject,
      body,
      delayDays: num(e.delay_days) ?? num(e.delay) ?? num(e.day_offset),
      factId: pick(e, ["fact_id", "factId"], 120),
      angle: pick(e, ["angle"], 120),
    });
  });
  return out.sort((a, b) => a.step - b.step).slice(0, 12);
}

function normalizeQa(item: Obj): { status: QaStatus; reasons: string[] } {
  const qa = isObj(item.qa) ? item.qa : isObj(item.qa_result) ? item.qa_result : null;
  const reasonsRaw =
    (qa && (Array.isArray(qa.reasons) ? qa.reasons : Array.isArray(qa.failures) ? qa.failures : Array.isArray(qa.issues) ? qa.issues : null)) ||
    (Array.isArray(item.qa_reasons) ? item.qa_reasons : null) ||
    [];
  const reasons: string[] = [];
  for (const r of reasonsRaw as unknown[]) {
    if (typeof r === "string" && r.trim()) reasons.push(r.trim().slice(0, 500));
    else if (isObj(r)) {
      const t = pick(r, ["reason", "message", "rule", "text"], 500);
      const where = num(r.step);
      if (t) reasons.push(where != null ? `Step ${where}: ${t}` : t);
    }
  }
  let status: QaStatus = "pending";
  const passed = qa ? qa.passed ?? qa.pass ?? qa.ok : undefined;
  const qaWord = (qa && str(qa.status)) || null;
  const itemStatus = str(item.status);
  if (passed === true || qaWord === "passed" || qaWord === "pass" || itemStatus === "qa-passed") status = "passed";
  else if (passed === false || qaWord === "failed" || qaWord === "fail" || itemStatus === "qa-failed") status = "failed";
  // Past QA in the engine's own lifecycle means QA passed.
  else if (itemStatus && ["approved", "pushed", "push-error"].includes(itemStatus)) status = "passed";
  return { status, reasons: reasons.slice(0, 40) };
}

export function normalizeQueueItem(raw: unknown, ctx: IngestContext = {}): IngestResult {
  if (!isObj(raw)) return { ok: false, reason: "file is not a JSON object" };
  const item = raw;
  const lead = isObj(item.lead) ? item.lead : isObj(item.prospect) ? item.prospect : {};

  const tenant = pick(item, ["tenant"], 64) ?? str(ctx.tenant, 64);
  if (!tenant) return { ok: false, reason: "no tenant in the file or its folder" };
  const leadId = pick(item, ["lead_id", "leadId", "id"], 128) ?? pick(lead, ["id", "lead_id"], 128);
  if (!leadId) return { ok: false, reason: "no lead_id" };

  const dateRaw = pick(item, ["batch_date", "date", "queue_date"], 32) ?? str(ctx.date, 32);
  const batchDate = dateRaw && DATE_RE.test(dateRaw.slice(0, 10)) ? dateRaw.slice(0, 10) : null;
  if (!batchDate) return { ok: false, reason: "no batch date (YYYY-MM-DD) in the file or its folder" };

  const steps = normalizeSteps(item);
  if (steps.length === 0) {
    // research-thin / research-failed items carry no sequence. They are not
    // reviewable drafts, so they stay out of the queue instead of showing up empty.
    return { ok: false, reason: `no email steps (status ${str(item.status) ?? "unknown"})` };
  }

  const qa = normalizeQa(item);
  const engineStatus = str(item.status, 40);
  const approver = pick(item, ["approved_by", "approver"], 200) ?? (isObj(item.approval) ? pick(item.approval, ["by", "approver", "actor"], 200) : null);
  const approvedAt = isoOrNull(item.approved_at) ?? (isObj(item.approval) ? isoOrNull(item.approval.ts) ?? isoOrNull(item.approval.at) : null);
  const engineApproval = engineStatus === "approved" || engineStatus === "pushed" || approver ? { approver, at: approvedAt } : null;

  const research = isObj(item.research) ? item.research : null;
  const usedFacts = new Set(steps.map((s) => s.factId).filter((x): x is string => Boolean(x)));
  const push = isObj(item.push) ? item.push : null;
  const stopReason = normalizeStop(item.stop_reason);

  return {
    ok: true,
    draft: {
      tenant,
      leadId,
      batchDate,
      round: Math.max(1, Math.trunc(num(item.round) ?? num(item.round_number) ?? 1)),
      company: pick(lead, ["company", "company_name", "name"], 300) ?? pick(item, ["company", "company_name"], 300),
      contactName: pick(lead, ["contact_name", "greeting_name", "owner_name", "first_name"], 200) ?? pick(item, ["contact_name"], 200),
      contactEmail: lowerEmail(pick(lead, ["email"], 320) ?? pick(item, ["email", "contact_email"], 320)),
      website: pick(lead, ["website", "url"], 500) ?? pick(item, ["website"], 500),
      city: pick(lead, ["city"], 120) ?? pick(item, ["city"], 120),
      trade: pick(lead, ["trade", "bucket", "vertical"], 120) ?? pick(item, ["trade", "bucket"], 120),
      facts: normalizeFacts(item, usedFacts),
      research,
      steps,
      engineStatus,
      qaStatus: qa.status,
      qaReasons: qa.reasons,
      engineApproval,
      nextRoundDue: isoOrNull(item.next_round_due),
      stopReason,
      pushedAt: push ? isoOrNull(push.pushed_at) ?? isoOrNull(push.ts) ?? isoOrNull(push.at) : null,
      sourcePath: str(ctx.sourcePath, 500),
      sourceUpdatedAt: isoOrNull(item.updated_at),
    },
  };
}

/** Folder convention: outreach_queue/<tenant>/<YYYY-MM-DD>/<lead_id>.json */
export function contextFromPath(relPath: string): IngestContext {
  const parts = relPath.replace(/\\/g, "/").split("/").filter(Boolean);
  const file = parts[parts.length - 1] ?? "";
  const date = parts[parts.length - 2] ?? "";
  const tenant = parts[parts.length - 3] ?? "";
  return {
    tenant: tenant && !DATE_RE.test(tenant) && tenant !== "outreach_queue" ? tenant : null,
    date: DATE_RE.test(date) ? date : null,
    sourcePath: file ? parts.slice(-3).join("/") : null,
  };
}

/** True when a human edit changed any subject or body. */
export function stepsDiffer(a: DraftStep[], b: DraftStep[]): boolean {
  if (a.length !== b.length) return true;
  return a.some((s, i) => s.step !== b[i].step || s.subject !== b[i].subject || s.body !== b[i].body);
}

// ── Instantly -> events ─────────────────────────────────────────────────────

/** Instantly encodes a step as "<subsequence>_<step>_<variant>", zero-based. Humans count from 1. */
export function parseStep(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v + 1;
  const s = str(v, 40);
  if (!s) return null;
  const parts = s.split("_");
  const n = Number(parts.length >= 2 ? parts[1] : parts[0]);
  return Number.isFinite(n) ? n + 1 : null;
}

const INTEREST: Record<string, string> = {
  "0": "Out of office",
  "1": "Interested",
  "2": "Meeting booked",
  "3": "Meeting completed",
  "4": "Won",
  "-1": "Not interested",
  "-2": "Wrong person",
  "-3": "Lost",
  "-4": "No show",
};
export function interestLabel(code: unknown): string | null {
  const n = num(code);
  if (n == null) return null;
  return INTEREST[String(n)] ?? `Custom label ${n}`;
}

// "Remove me" and friends, including the exact opt-out the engine signs with
// ("Reply 'no thanks' and I'll take you off my list").
const OPT_OUT_RE =
  /\b(remove me|unsubscribe|take me off|opt(?:\s|-)?out|stop (?:emailing|contacting|sending)|do not (?:email|contact)|don'?t (?:email|contact)|no thanks|not interested|leave me alone|quit emailing)\b/i;
const SPAM_RE = /\b(spam|reported|reporting you|can-?spam|harass)/i;

/**
 * What a real (non-automatic) reply does to the lead.
 *   negative label, "remove me" wording  -> negative_reply (suppressed forever)
 *   "this is spam", reported             -> spam_complaint (suppressed forever)
 *   anything else                        -> handoff (a human owns it now)
 */
export function stopReasonForReply(text: string | null, interestCode: unknown): StopReason {
  const t = (text ?? "").slice(0, 2_000);
  if (SPAM_RE.test(t) && /\b(spam|report)/i.test(t)) return "spam_complaint";
  const code = num(interestCode);
  if (code === -1) return "negative_reply";
  if (OPT_OUT_RE.test(t)) return "negative_reply";
  return "handoff";
}

function dayOf(iso: string): string {
  return iso.slice(0, 10);
}

/** Cut the quoted history off a reply so the thread shows what they wrote. */
export function stripQuotedText(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (/^On\s.{4,300}wrote:\s*$/i.test(t)) break;
    if (/^On\s.{4,300}$/i.test(t) && [lines[i + 1], lines[i + 2]].some((l) => /wrote:\s*$/i.test((l ?? "").trim()))) break;
    if (/^-{2,}\s*Original Message\s*-{2,}$/i.test(t)) break;
    if (/^From:\s.+/i.test(t) && out.length > 0 && /^(Sent|Date|To):\s/i.test((lines[i + 1] ?? "").trim())) break;
    if (t.startsWith(">")) continue;
    out.push(lines[i]);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim() || text.trim();
}

export function htmlToPlain(html: string | null | undefined): string {
  if (!html) return "";
  const cut = html.search(/<blockquote|<div[^>]*class=["'][^"']*gmail_quote|<div[^>]*id=["'](divRplyFwdMsg|appendonsend)["']/i);
  const h = cut >= 0 ? html.slice(0, cut) : html;
  return h
    .replace(/<\s*(script|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, "")
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\s*\/\s*(div|p|li)\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const BODY_CAP = 8_000;

/**
 * One row of GET /emails.
 *   ue_type 1 (campaign send)  -> sent
 *   ue_type 2 (received)       -> replied / auto_replied, with the stop it implies
 *   anything else (manual 3, scheduled 4) -> null: not a campaign event
 */
export function mapInstantlyEmail(e: unknown): OutreachEventInput | null {
  if (!isObj(e)) return null;
  const ue = num(e.ue_type);
  const at = isoOrNull(e.timestamp_email) ?? isoOrNull(e.timestamp_created);
  if (!at) return null;
  const campaignId = str(e.campaign_id, 80);
  const body = isObj(e.body) ? e.body : {};
  const id = str(e.id, 120);

  if (ue === 1) {
    const to = lowerEmail(e.lead) ?? lowerEmail(e.to_address_email_list);
    if (!to) return null;
    const step = parseStep(e.step);
    return {
      eventType: "sent",
      occurredAt: at,
      contactEmail: to,
      tenant: null,
      campaignId,
      mailbox: lowerEmail(e.eaccount) ?? lowerEmail(e.from_address_email),
      step,
      instantlyEmailId: id,
      threadId: str(e.thread_id, 200),
      subject: str(e.subject, 500),
      bodyText: (str(body.text, BODY_CAP) ?? htmlToPlain(str(body.html, 60_000)).slice(0, BODY_CAP)) || null,
      interest: null,
      stopReason: null,
      source: "poll",
      // Same key the webhook path builds, so a send seen both ways counts once.
      dedupeKey: `sent:${campaignId ?? "-"}:${to}:${step ?? "-"}:${dayOf(at)}`,
      payload: null,
    };
  }

  if (ue === 2) {
    const from = lowerEmail(e.from_address_email) ?? lowerEmail(e.lead);
    if (!from) return null;
    const auto = e.is_auto_reply === true || e.is_auto_reply === 1;
    const rawText = str(body.text, 60_000) ?? htmlToPlain(str(body.html, 120_000)) ?? str(e.content_preview, 2_000) ?? "";
    const text = stripQuotedText(rawText).slice(0, BODY_CAP);
    const code = e.i_status ?? null;
    return {
      eventType: auto ? "auto_replied" : "replied",
      occurredAt: at,
      contactEmail: from,
      tenant: null,
      campaignId,
      mailbox: lowerEmail(e.eaccount) ?? lowerEmail(e.to_address_email_list),
      step: parseStep(e.step),
      instantlyEmailId: id,
      threadId: str(e.thread_id, 200),
      subject: str(e.subject, 500),
      bodyText: text || null,
      interest: interestLabel(code),
      stopReason: auto ? null : stopReasonForReply(text, code),
      source: "poll",
      dedupeKey: id ? `reply:${id}` : `reply:${from}:${at}`,
      payload: null,
    };
  }
  return null;
}

/**
 * One row of POST /leads/list. Lead status is where Instantly records the
 * outcomes the email list does not: -1 bounced, -2 unsubscribed. The interest
 * label (lt_interest_status) carries not interested / interested / meeting.
 * Opens become one "opened" per lead per campaign (Instantly keeps a count,
 * not a time per open).
 */
export function mapInstantlyLead(l: unknown, campaignId: string | null, now: string): OutreachEventInput[] {
  if (!isObj(l)) return [];
  const email = lowerEmail(l.email);
  if (!email) return [];
  const at = isoOrNull(l.timestamp_updated) ?? isoOrNull(l.timestamp_last_touch) ?? isoOrNull(l.timestamp_last_contact) ?? now;
  const cid = campaignId ?? str(l.campaign, 80);
  const base = {
    occurredAt: at,
    contactEmail: email,
    tenant: null,
    campaignId: cid,
    mailbox: null,
    step: null,
    instantlyEmailId: null,
    threadId: null,
    subject: null,
    bodyText: null,
    interest: null,
    source: "poll" as const,
    payload: null,
  };
  const out: OutreachEventInput[] = [];
  const status = num(l.status);
  if (status === -1) {
    // Instantly marks a lead bounced only on a hard bounce (soft bounces retry).
    out.push({ ...base, eventType: "bounced", stopReason: "hard_bounce", dedupeKey: `bounced:${cid ?? "-"}:${email}` });
  }
  if (status === -2) {
    out.push({ ...base, eventType: "unsubscribed", stopReason: "unsubscribed", dedupeKey: `unsubscribed:${email}` });
  }
  const interest = num(l.lt_interest_status);
  if (interest === -1) {
    out.push({ ...base, eventType: "not_interested", interest: interestLabel(-1), stopReason: "negative_reply", dedupeKey: `interest:-1:${cid ?? "-"}:${email}` });
  } else if (interest === 1) {
    out.push({ ...base, eventType: "interested", interest: interestLabel(1), stopReason: "handoff", dedupeKey: `interest:1:${cid ?? "-"}:${email}` });
  } else if (interest === 2 || interest === 3 || interest === 4) {
    out.push({ ...base, eventType: "meeting_booked", interest: interestLabel(interest), stopReason: "handoff", dedupeKey: `interest:2:${cid ?? "-"}:${email}` });
  }
  if ((num(l.email_open_count) ?? 0) > 0) {
    out.push({ ...base, eventType: "opened", stopReason: null, dedupeKey: `opened:${cid ?? "-"}:${email}` });
  }
  if ((num(l.email_click_count) ?? 0) > 0) {
    out.push({ ...base, eventType: "clicked", stopReason: null, dedupeKey: `clicked:${cid ?? "-"}:${email}` });
  }
  return out;
}

/** Untrusted webhook time: ISO or epoch, never the future, else when we received it. */
export function trustedWebhookTime(raw: unknown, receivedAt: string): string {
  const recv = Date.parse(receivedAt);
  let t = NaN;
  if (typeof raw === "number" && Number.isFinite(raw)) t = raw < 1e12 ? raw * 1000 : raw;
  else if (typeof raw === "string" && raw.trim()) {
    const n = Number(raw);
    t = Number.isFinite(n) ? (n < 1e12 ? n * 1000 : n) : Date.parse(raw);
  }
  if (!Number.isFinite(t) || t > recv + 5 * 60_000 || t < recv - 30 * 24 * 3600_000) return new Date(recv).toISOString();
  return new Date(t).toISOString();
}

const WEBHOOK_TYPES: Record<string, OutreachEventType> = {
  email_sent: "sent",
  email_opened: "opened",
  email_link_clicked: "clicked",
  reply_received: "replied",
  auto_reply_received: "auto_replied",
  email_bounced: "bounced",
  lead_unsubscribed: "unsubscribed",
  lead_interested: "interested",
  lead_not_interested: "not_interested",
  custom_label_any_negative: "not_interested",
  lead_meeting_booked: "meeting_booked",
  lead_meeting_completed: "meeting_booked",
};

/**
 * One Instantly webhook body. Instantly has no spam-complaint event type
 * (verified against GET /webhooks/event-types, 2026-09-28), so a complaint
 * arrives only as an event name or payload flag mentioning it, or from the
 * engine's own suppression list through the ingest.
 */
export function mapWebhookEvent(body: unknown, receivedAt: string): OutreachEventInput | null {
  if (!isObj(body)) return null;
  const type = str(body.event_type, 80) ?? "";
  const email = lowerEmail(body.lead_email) ?? lowerEmail(body.email);
  if (!type || !email) return null;
  const at = trustedWebhookTime(body.timestamp, receivedAt);
  const campaignId = str(body.campaign_id, 80);
  const mailbox = lowerEmail(body.email_account) ?? lowerEmail(body.eaccount);
  const step = parseStep(body.step);
  const base = {
    occurredAt: at,
    contactEmail: email,
    tenant: null,
    campaignId,
    mailbox,
    step,
    instantlyEmailId: str(body.email_id, 120),
    threadId: null,
    subject: str(body.email_subject, 500) ?? str(body.reply_subject, 500),
    bodyText: null,
    interest: null,
    source: "webhook" as const,
    payload: body,
  };

  const complaint = /complain|spam/i.test(type) || body.is_spam_complaint === true || /complain|spam/i.test(str(body.bounce_type, 80) ?? "");
  if (complaint) {
    return { ...base, eventType: "complaint", stopReason: "spam_complaint", dedupeKey: `complaint:${email}` };
  }

  const mapped = WEBHOOK_TYPES[type];
  if (!mapped) return null;

  switch (mapped) {
    case "sent":
      return { ...base, eventType: "sent", stopReason: null, dedupeKey: `sent:${campaignId ?? "-"}:${email}:${step ?? "-"}:${dayOf(at)}` };
    case "opened":
    case "clicked":
      return { ...base, eventType: mapped, stopReason: null, dedupeKey: `${mapped}:${campaignId ?? "-"}:${email}` };
    case "replied":
    case "auto_replied": {
      const raw = str(body.reply_text, 60_000) ?? htmlToPlain(str(body.reply_html, 120_000)) ?? str(body.reply_text_snippet, 2_000) ?? "";
      const text = stripQuotedText(raw).slice(0, BODY_CAP);
      return {
        ...base,
        eventType: mapped,
        bodyText: text || null,
        stopReason: mapped === "auto_replied" ? null : stopReasonForReply(text, null),
        // Webhook replies carry no Instantly email id we can trust to match the
        // inbox row, so the store also collapses a reply from the same person
        // within 15 minutes of one it already holds.
        dedupeKey: `reply:w:${email}:${at}`,
      };
    }
    case "bounced": {
      const soft = /soft|transient|temporary/i.test(str(body.bounce_type, 80) ?? "");
      return {
        ...base,
        eventType: "bounced",
        stopReason: soft ? null : "hard_bounce",
        dedupeKey: soft ? `bounced-soft:${campaignId ?? "-"}:${email}:${dayOf(at)}` : `bounced:${campaignId ?? "-"}:${email}`,
      };
    }
    case "unsubscribed":
      return { ...base, eventType: "unsubscribed", stopReason: "unsubscribed", dedupeKey: `unsubscribed:${email}` };
    case "not_interested":
      return { ...base, eventType: "not_interested", interest: interestLabel(-1), stopReason: "negative_reply", dedupeKey: `interest:-1:${campaignId ?? "-"}:${email}` };
    case "interested":
      return { ...base, eventType: "interested", interest: interestLabel(1), stopReason: "handoff", dedupeKey: `interest:1:${campaignId ?? "-"}:${email}` };
    case "meeting_booked":
      return { ...base, eventType: "meeting_booked", interest: interestLabel(2), stopReason: "handoff", dedupeKey: `interest:2:${campaignId ?? "-"}:${email}` };
    default:
      return null;
  }
}

// ── stop precedence ─────────────────────────────────────────────────────────

const PERMANENT: StopReason[] = ["unsubscribed", "negative_reply", "spam_complaint", "hard_bounce"];
export function isPermanentStop(r: StopReason | null | undefined): boolean {
  return Boolean(r && PERMANENT.includes(r));
}

/**
 * Which stop wins when a lead already has one. A permanent stop is never
 * replaced (the first reason and time stay on record); a permanent stop
 * replaces a handoff; a handoff never replaces anything.
 */
export function mergeStop(current: StopReason | null, incoming: StopReason | null): StopReason | null {
  if (!incoming) return current;
  if (!current) return incoming;
  if (isPermanentStop(current)) return current;
  if (isPermanentStop(incoming)) return incoming;
  return current;
}

export const STOP_LABEL: Record<StopReason, string> = {
  unsubscribed: "Unsubscribed",
  negative_reply: "Asked to be removed",
  spam_complaint: "Spam complaint",
  hard_bounce: "Hard bounce",
  handoff: "Replied, handed to a person",
};
