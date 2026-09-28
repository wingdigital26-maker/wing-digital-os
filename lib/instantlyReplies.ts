// Replies to Wing's Instantly campaigns: who replied, what they said, when.
//
// This is the part of the Instantly connection that makes money, so it is
// built to be FAST and HONEST:
//
//   Fast path  POST /api/webhooks/instantly (reply_received) records the reply
//              the moment Instantly fires it (Postgres over OS_DB_URL, shared by
//              every server instance) and expires the reply cache, so the next
//              look at the OS (the board re-checks every 15s) shows it.
//   Fallback   GET /emails?email_type=received from Instantly's own inbox,
//              cached 20s per server instance and budgeted against Instantly's
//              20-a-minute inbox limit. This alone catches every reply within
//              about half a minute, webhook or not.
//
// The two are merged and de-duplicated (same person within 10 minutes of an
// inbox row; webhook retries with the same words within 24h). If
// Instantly cannot be read, the payload says exactly why (no key, key
// rejected, rate limited, down) and still carries any webhook replies we hold,
// so a reply is never hidden behind an outage and a failure never reads as
// "no replies".
//
// READ-ONLY. Nothing here replies, labels, marks read, or changes anything in
// Instantly.
import {
  iListAll,
  fetchCampaigns,
  fetchLeads,
  htmlToText,
  instantlyKey,
  type InstantlyEmail,
  type InstantlyErrorKind,
  type InstantlyLead,
} from "./instantly";
import { recentInstantlyEvents, lastInstantlyWebhookAt } from "./instantlyEvents";

export const REPLY_EVENT_TYPES = [
  "reply_received",
  "auto_reply_received",
  "lead_interested",
  "lead_meeting_booked",
];

export type Reply = {
  key: string;
  source: "instantly" | "webhook";
  at: string;
  fromEmail: string;
  name: string | null;
  company: string | null;
  campaignId: string | null;
  campaign: string | null;
  subject: string;
  /** What they wrote, with the quoted thread below it removed. */
  text: string;
  snippet: string;
  unread: boolean | null;
  autoReply: boolean;
  /** Instantly's interest label in words, e.g. "Interested". Null when unset. */
  interest: string | null;
  /** hot = interested / meeting; cold = not interested / wrong person / auto reply. */
  temperature: "hot" | "neutral" | "cold";
  threadId: string | null;
  /** Where to answer it. Replies are sent from Instantly, never from here. */
  uniboxUrl: string;
};

export type RepliesPayload = {
  /** ok: Instantly read fine. partial: webhook replies shown but Instantly failed. error: nothing readable. */
  status: "ok" | "partial" | "error";
  errorKind: InstantlyErrorKind | null;
  reason: string | null;
  /** Instantly answered earlier but not just now; the list is from `checkedAt`. */
  stale: boolean;
  staleReason: string | null;
  replies: Reply[];
  counts: { total: number; hot: number; unread: number };
  checkedAt: string | null;
  lastWebhookAt: string | null;
  truncated: boolean;
};

const UNIBOX = "https://app.instantly.ai/app/unibox";

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
const HOT = new Set(["1", "2", "3", "4"]);
const COLD = new Set(["0", "-1", "-2", "-3", "-4"]);

/** Cut the quoted thread ("On Tue, ... wrote:", "> ...", "From: ...") off a reply. */
export function stripQuoted(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    // "On Tue, Sep 24 ... wrote:" on one line.
    if (/^On\s.{4,300}wrote:\s*$/i.test(t)) break;
    // The same header wrapped over two or three lines by the mail client:
    // "On Tue, Sep 24, 2026 at 9:14 AM Grant <" / "g@x.com> wrote:" / "wrote:".
    if (/^On\s.{4,300}$/i.test(t)) {
      const next = [lines[i + 1], lines[i + 2]].map((l) => (l ?? "").trim());
      if (next.some((l) => /wrote:\s*$/i.test(l))) break;
    }
    if (/^-{2,}\s*Original Message\s*-{2,}$/i.test(t)) break;
    if (/^_{5,}$/.test(t)) break;
    if (/^From:\s.+/i.test(t) && out.length > 0 && /^(Sent|Date|To):\s/i.test((lines[i + 1] ?? "").trim())) break;
    if (t.startsWith(">")) continue;
    out.push(lines[i]);
  }
  const cleaned = out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return cleaned || text.trim();
}

/** HTML-only replies: drop the quoted history (blockquote / Gmail / Outlook markers) before converting. */
export function stripQuotedHtml(html: string): string {
  const cut = html.search(/<blockquote|<div[^>]*class=["'][^"']*gmail_quote|<div[^>]*id=["'](divRplyFwdMsg|appendonsend)["']|<hr[^>]*id=["']stopSpelling["']/i);
  return cut >= 0 ? html.slice(0, cut) : html;
}

/** Reply text we keep per row. Longer replies are cut with a pointer to Instantly. */
const MAX_TEXT = 20_000;
function capText(t: string): string {
  return t.length > MAX_TEXT ? `${t.slice(0, MAX_TEXT)}\n\n[… cut here; the full reply is in Instantly]` : t;
}

/** Webhook timestamps are untrusted: accept ISO or epoch s/ms, never the future, else the time we received it. */
export function trustedTime(raw: unknown, receivedAt: string): string {
  const recv = Date.parse(receivedAt);
  let t = NaN;
  if (typeof raw === "number" && Number.isFinite(raw)) t = raw < 1e12 ? raw * 1000 : raw;
  else if (typeof raw === "string" && raw.trim()) {
    const n = Number(raw);
    t = Number.isFinite(n) ? (n < 1e12 ? n * 1000 : n) : Date.parse(raw);
  }
  // Plausible = not after we received it (5 min clock skew) and not more than 30 days before.
  if (!Number.isFinite(t) || t > recv + 5 * 60_000 || t < recv - 30 * 24 * 3600_000) return new Date(recv).toISOString();
  return new Date(t).toISOString();
}

function snippetOf(text: string, len = 180): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > len ? `${flat.slice(0, len - 1)}…` : flat;
}

function temperatureOf(interestCode: string | null, auto: boolean): Reply["temperature"] {
  if (auto) return "cold";
  if (interestCode && HOT.has(interestCode)) return "hot";
  if (interestCode && COLD.has(interestCode)) return "cold";
  return "neutral";
}

type RawReply = InstantlyEmail & { is_auto_reply?: number | boolean; ai_interest_value?: number | null };

/** Leads keyed by lowercase email, across every campaign. Cached upstream for 60s. */
async function leadDirectory(campaignIds: string[]): Promise<Map<string, InstantlyLead>> {
  const map = new Map<string, InstantlyLead>();
  const results = await Promise.all(campaignIds.map((id) => fetchLeads(id)));
  for (const r of results) {
    if (!r.ok) continue;
    for (const l of r.data) if (l.email) map.set(l.email.toLowerCase(), l);
  }
  return map;
}

let lastGood: { at: number; replies: Reply[] } | null = null;

export async function loadReplies(opts: { force?: boolean } = {}): Promise<RepliesPayload> {
  const [inbox, campaignsR, events] = await Promise.all([
    instantlyKey()
      ? iListAll<RawReply>("/emails?email_type=received&sort_order=desc", { ttlMs: 20_000, maxPages: 3, force: opts.force })
      : Promise.resolve({ ok: false as const, kind: "no_key" as const, reason: "INSTANTLY_API_KEY is not set on this deployment, so Instantly replies cannot be read." }),
    fetchCampaigns(),
    recentInstantlyEvents(REPLY_EVENT_TYPES),
  ]);

  const campaignNames = new Map<string, string>();
  if (campaignsR.ok) for (const c of campaignsR.data) if (c.id) campaignNames.set(c.id, c.name);
  const leads = campaignsR.ok ? await leadDirectory([...campaignNames.keys()]) : new Map<string, InstantlyLead>();

  const replies: Reply[] = [];

  if (inbox.ok) {
    for (const e of inbox.data) {
      if (e.ue_type != null && e.ue_type !== 2) continue; // received only
      const fromEmail = (e.from_address_email ?? e.lead ?? "").trim();
      const lead = leads.get(fromEmail.toLowerCase());
      const raw = e.body?.text?.trim() || htmlToText(stripQuotedHtml(e.body?.html ?? "")) || e.content_preview || "";
      const text = capText(stripQuoted(raw));
      const code = e.i_status != null ? String(e.i_status) : lead?.lt_interest_status != null ? String(lead.lt_interest_status) : null;
      const auto = e.is_auto_reply === true || e.is_auto_reply === 1;
      replies.push({
        key: `i:${e.id ?? `${fromEmail}-${e.timestamp_email}`}`,
        source: "instantly",
        at: e.timestamp_email ?? e.timestamp_created ?? "",
        fromEmail,
        name: [lead?.first_name, lead?.last_name].filter(Boolean).join(" ").trim() || null,
        company: lead?.company_name ?? null,
        campaignId: e.campaign_id ?? null,
        campaign: e.campaign_id ? campaignNames.get(e.campaign_id) ?? null : null,
        subject: (e.subject ?? "").trim() || "(no subject)",
        text,
        snippet: snippetOf(text),
        unread: e.is_unread == null ? null : Boolean(e.is_unread),
        autoReply: auto,
        interest: code ? INTEREST[code] ?? `Custom label ${code}` : null,
        temperature: temperatureOf(code, auto),
        threadId: e.thread_id ?? null,
        uniboxUrl: UNIBOX,
      });
    }
  }

  // Webhook replies that the inbox read has not caught (yet, or at all).
  const polledAt = new Map<string, number[]>();
  for (const r of replies) {
    const k = r.fromEmail.toLowerCase();
    polledAt.set(k, [...(polledAt.get(k) ?? []), Date.parse(r.at)]);
  }
  const interestByLead = new Map<string, string>();
  const webhookSeen: { email: string; at: number; fp: string }[] = [];
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  // Oldest first, so a retried delivery collapses onto the first copy.
  for (const ev of [...events].reverse()) {
    const p = ev.payload;
    const email = (ev.leadEmail ?? "").trim();
    if (!email) continue;
    if (ev.eventType === "lead_interested") interestByLead.set(email.toLowerCase(), "1");
    if (ev.eventType === "lead_meeting_booked") interestByLead.set(email.toLowerCase(), "2");
    if (ev.eventType !== "reply_received" && ev.eventType !== "auto_reply_received") continue;
    const at = trustedTime(p.timestamp, ev.receivedAt);
    const atMs = Date.parse(at);
    const times = polledAt.get(email.toLowerCase()) ?? [];
    if (times.some((t) => Math.abs(t - atMs) < 10 * 60 * 1000)) continue;
    const lead = leads.get(email.toLowerCase());
    const raw = str(p.reply_text) || htmlToText(stripQuotedHtml(str(p.reply_html))) || str(p.reply_text_snippet);
    const text = capText(stripQuoted(raw));
    // Instantly retries deliveries: same person + same words within 24h = one reply.
    const fp = `${str(p.reply_subject)}|${text.slice(0, 200)}`;
    const lower = email.toLowerCase();
    if (webhookSeen.some((w) => w.email === lower && w.fp === fp && Math.abs(w.at - atMs) < 24 * 3600 * 1000)) continue;
    webhookSeen.push({ email: lower, at: atMs, fp });
    const auto = ev.eventType === "auto_reply_received";
    const campaignId = ev.campaignId ?? null;
    replies.push({
      key: `w:${lower}-${atMs}-${webhookSeen.length}`,
      source: "webhook",
      at,
      fromEmail: email,
      name: [lead?.first_name ?? p.firstName ?? p.first_name, lead?.last_name ?? p.lastName ?? p.last_name]
        .filter((x) => typeof x === "string" && x).join(" ").trim() || null,
      company: lead?.company_name ?? (str(p.companyName) || str(p.company_name) || null),
      campaignId,
      campaign: str(p.campaign_name) || (campaignId ? campaignNames.get(campaignId) ?? null : null),
      subject: str(p.reply_subject).trim() || "(no subject)",
      text,
      snippet: snippetOf(text),
      unread: null,
      autoReply: auto,
      interest: null,
      temperature: auto ? "cold" : "neutral",
      threadId: null,
      uniboxUrl: typeof p.unibox_url === "string" && /^https:\/\/app\.instantly\.ai\//.test(p.unibox_url) ? p.unibox_url : UNIBOX,
    });
  }
  // Interest labels that arrived by webhook warm up the matching rows.
  for (const r of replies) {
    const code = interestByLead.get(r.fromEmail.toLowerCase());
    if (code && !r.interest && !r.autoReply) {
      r.interest = INTEREST[code];
      r.temperature = "hot";
    }
  }

  replies.sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0));
  const counts = {
    total: replies.length,
    hot: replies.filter((r) => r.temperature === "hot").length,
    unread: replies.filter((r) => r.unread === true).length,
  };

  if (inbox.ok) {
    lastGood = { at: inbox.at, replies };
    return {
      status: "ok",
      errorKind: null,
      reason: null,
      stale: inbox.stale,
      staleReason: inbox.stale ? inbox.staleReason ?? null : null,
      replies,
      counts,
      checkedAt: new Date(inbox.at).toISOString(),
      lastWebhookAt: lastInstantlyWebhookAt(),
      truncated: Boolean((inbox as { truncated?: boolean }).truncated),
    };
  }

  return {
    status: replies.length > 0 ? "partial" : "error",
    errorKind: inbox.kind,
    reason: inbox.reason,
    stale: false,
    staleReason: null,
    replies,
    counts,
    checkedAt: lastGood ? new Date(lastGood.at).toISOString() : null,
    lastWebhookAt: lastInstantlyWebhookAt(),
    truncated: false,
  };
}
