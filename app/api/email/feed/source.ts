import { sbUrl, sbService } from "@/lib/osSupabase";
import { instantlyKey, iRequest, iListAll, fetchLeads, type InstantlyEmail } from "@/lib/instantly";
import { outreachStore, storeFailure } from "@/lib/outreach/store";

// ═══════════════════════════════════════════════════════════════════════════
// The email feed loader — one normalized list of every email Wing sends.
//
// Jack's ask, in his words: "I want to see all the emails that are going out.
// That's really what I want." Nothing in this repo answered that, because the
// emails live in three unrelated places and no screen joined them:
//
//   1. COLD CAMPAIGNS (Instantly, live)  — the sequence sender. Real subject,
//      real HTML body, the sequence step, the campaign, the mailbox it left
//      from. This is where almost every Wing email actually goes out.
//   2. ONE-TO-ONE (OS Supabase `messages`, migration 0014) — everything
//      POST /api/email/send logs: CRM replies, confirmations, follow-ups.
//   3. APPROVED QUEUE (Sonar Supabase `outbound`) — human-approved rows the
//      SMTP sender will pick up. Queued, not yet sent.
//
// Each lane reports its own availability. A lane that is down does NOT make
// the feed empty and does NOT make the other lanes disappear: it contributes
// a one-line honest reason the UI prints verbatim. That matters right now —
// both Supabase projects answer HTTP 402 (storage quota) as of 2026-09-21, so
// lanes 2 and 3 are genuinely unreadable and the screen has to say so rather
// than render as "no emails".
//
// NOTHING IN THIS FILE SENDS ANYTHING. Every call is a GET/read.
// ═══════════════════════════════════════════════════════════════════════════

export type FeedState =
  | "sent"
  | "queued"
  | "scheduled"
  | "failed"
  | "bounced"
  | "replied"
  | "received"
  | "draft"
  | "unknown";

export type FeedItem = {
  /** Stable across reloads and unique across lanes. The SSE stream diffs on it. */
  key: string;
  lane: LaneId;
  laneLabel: string;
  direction: "out" | "in";
  to: string | null;
  from: string | null;
  /** Person name when known, never invented. */
  name: string | null;
  company: string | null;
  subject: string;
  /** Sanitized HTML, ready to render. Null when the source only had plain text. */
  html: string | null;
  /** Plain text of the same body, for search and for the snippet. */
  text: string;
  snippet: string;
  state: FeedState;
  /** Extra truth the state word alone would hide, e.g. "dry run, nothing left the mailbox". */
  stateNote: string | null;
  campaign: string | null;
  campaignId: string | null;
  /** Human sequence step ("Step 2"), or null when the lane has no sequence. */
  step: string | null;
  at: string;
  opens: number | null;
  clicks: number | null;
  replies: number | null;
  error: string | null;
  /** Earlier messages in the same conversation, oldest first (outreach replies). */
  thread?: ThreadMessage[];
  /** Where this conversation lives elsewhere in the OS, e.g. its draft on /outreach. */
  link?: { href: string; label: string } | null;
};

export type ThreadMessage = {
  at: string | null;
  direction: "out" | "in";
  step: number | null;
  subject: string;
  text: string;
};

export type LaneId = "cold" | "ledger" | "approved" | "outreach";

export type Lane = {
  id: LaneId;
  label: string;
  /** True only when the read actually succeeded. Never optimistic. */
  available: boolean;
  /** Exactly why it is unavailable, in words Jack can act on. Null when fine. */
  reason: string | null;
  /** How many items this lane contributed to `items`. */
  count: number;
};

export type CampaignSummary = {
  id: string;
  name: string;
  /** Instantly's numeric status, translated. Null when it is not a campaign lane. */
  state: string | null;
  sent: number | null;
  opens: number | null;
  clicks: number | null;
  replies: number | null;
  bounces: number | null;
  unsubscribes: number | null;
  /** Leads loaded but never contacted: the real "waiting to go out" number. */
  waiting: number | null;
};

export type FeedPayload = {
  items: FeedItem[];
  lanes: Lane[];
  campaigns: CampaignSummary[];
  /** True when at least one lane read succeeded. */
  anyAvailable: boolean;
  /** Said out loud when every lane is readable and there is still nothing. */
  emptyNote: string | null;
  /** Per-message open/click tracking honesty, shown in the reading pane. */
  trackingNote: string | null;
  fetchedAt: string;
};

// ── Small helpers ───────────────────────────────────────────────────────────

/** Strip HTML to readable text. Block tags become newlines so paragraphs survive. */
function toText(html: string): string {
  return html
    .replace(/<\s*(script|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, "")
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\s*\/\s*(div|p|li|tr|h[1-6])\s*>/gi, "\n")
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

// Allow-list sanitizer. The reading pane renders this HTML inline so the email
// looks the way the recipient sees it, which means anything executable has to
// be gone BEFORE it reaches the browser. Bodies can come from an inbound reply
// one day, so this is not optional even though today's bodies are our own.
const ALLOWED_TAGS = new Set([
  "div", "p", "br", "span", "b", "strong", "i", "em", "u", "a", "ul", "ol", "li",
  "blockquote", "pre", "code", "h1", "h2", "h3", "h4", "h5", "h6", "hr",
  "table", "thead", "tbody", "tr", "td", "th", "img",
]);

function safeHtml(raw: string): string {
  let out = raw
    // Whole dangerous elements, contents included.
    .replace(/<\s*(script|style|iframe|object|embed|form|noscript|svg|math)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, "")
    // Self-closing or unmatched versions of the same.
    .replace(/<\s*\/?\s*(script|style|iframe|object|embed|form|noscript|svg|math|link|meta|base)[^>]*>/gi, "");

  // Drop any tag not on the allow-list, and scrub the attributes of those that
  // survive: no on* handlers, no javascript:/data: URLs, no style expressions.
  out = out.replace(/<\s*(\/?)\s*([a-zA-Z0-9-]+)((?:[^>"']|"[^"]*"|'[^']*')*)>/g, (_m, close: string, tag: string, attrs: string) => {
    const name = tag.toLowerCase();
    if (!ALLOWED_TAGS.has(name)) return "";
    if (close) return `</${name}>`;
    const kept: string[] = [];
    const attrRe = /([a-zA-Z0-9:_-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
    let m: RegExpExecArray | null;
    while ((m = attrRe.exec(attrs)) !== null) {
      const key = m[1].toLowerCase();
      const value = (m[3] ?? m[4] ?? m[5] ?? "").trim();
      if (key.startsWith("on") || key === "style" || key === "srcset") continue;
      if ((key === "href" || key === "src") && !/^(https?:|mailto:|tel:|cid:)/i.test(value)) continue;
      if (!["href", "src", "alt", "title", "width", "height", "align", "target", "rel"].includes(key)) continue;
      kept.push(`${key}="${value.replace(/"/g, "&quot;")}"`);
    }
    // Outbound links open in a new tab and never hand the opener over.
    if (name === "a") kept.push('target="_blank"', 'rel="noopener noreferrer nofollow"');
    return `<${name}${kept.length ? " " + kept.join(" ") : ""}>`;
  });

  return out.trim();
}

function snippetOf(text: string, len = 130): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > len ? `${flat.slice(0, len - 1)}…` : flat;
}

/** Instantly encodes a step as "sequence_step_variant". Report the step humans count. */
function stepLabel(step: string | null | undefined): string | null {
  if (!step) return null;
  const parts = step.split("_");
  const n = Number(parts[1]);
  return Number.isFinite(n) ? `Step ${n + 1}` : step;
}

/** Instantly campaign status codes, in words. Unknown codes render as themselves. */
function campaignState(code: number | null | undefined): string | null {
  switch (code) {
    case 0: return "draft";
    case 1: return "active";
    case 2: return "paused";
    case 3: return "completed";
    case 4: return "running subsequence";
    case -99: return "account suspended";
    case -1: return "accounts unhealthy";
    case -2: return "bounce rate too high";
    default: return code == null ? null : `status ${code}`;
  }
}

// ── Instantly (the cold campaign lane) ──────────────────────────────────────

// Every read goes through the shared client in lib/instantly.ts: timeouts,
// retries, caching, and Instantly's 20-a-minute inbox budget live there, so the
// SSE stream ticking every 20s in several tabs cannot get the workspace blocked.
type Fetched<T> = { ok: true; data: T } | { ok: false; reason: string };

async function iGet<T>(path: string, ttlMs = 30_000): Promise<Fetched<T>> {
  const r = await iRequest<T>(path, { ttlMs });
  return r.ok ? { ok: true, data: r.data } : { ok: false, reason: r.reason };
}

type RawEmail = InstantlyEmail & {
  id?: string;
  campaign_id?: string;
  step?: string;
  lead?: string;
  eaccount?: string;
  ue_type?: number;
  timestamp_email?: string;
  thread_id?: string;
  message_id?: string;
};

type RawLead = {
  email?: string; first_name?: string; last_name?: string; company_name?: string;
  timestamp_last_contact?: string | null;
  email_open_count?: number; email_click_count?: number; email_reply_count?: number;
};

type RawCampaign = { id?: string; name?: string; status?: number };

type RawAnalytics = {
  campaign_id?: string; campaign_name?: string; campaign_status?: number;
  emails_sent_count?: number; open_count?: number; link_click_count?: number;
  reply_count?: number; bounced_count?: number; unsubscribed_count?: number;
  reply_count_unique?: number; reply_count_automatic_unique?: number;
};

// The campaign roster, lead directory and analytics change slowly and cost an
// API call each. The SSE stream re-reads the email list every tick; it must not
// re-read these every tick too. 5 minutes, in-process, cleared on restart.
type ColdContext = {
  campaigns: Map<string, RawCampaign>;
  leads: Map<string, RawLead>;
  analytics: RawAnalytics[];
  notes: string[];
};
let coldContextCache: { at: number; value: ColdContext } | null = null;
const COLD_CONTEXT_TTL_MS = 5 * 60 * 1000;

async function coldContext(force = false): Promise<ColdContext> {
  if (!force && coldContextCache && Date.now() - coldContextCache.at < COLD_CONTEXT_TTL_MS) {
    return coldContextCache.value;
  }
  const notes: string[] = [];
  const campaigns = new Map<string, RawCampaign>();
  const leads = new Map<string, RawLead>();
  let analytics: RawAnalytics[] = [];

  const cRes = await iGet<{ items?: RawCampaign[] }>("/campaigns?limit=100", 60_000);
  if (cRes.ok) {
    for (const c of cRes.data.items ?? []) if (c.id) campaigns.set(c.id, c);
  } else {
    notes.push(`Campaign names could not be read (${cRes.reason}), so rows show the campaign id instead.`);
  }

  const aRes = await iGet<RawAnalytics[]>("/campaigns/analytics", 30_000);
  if (aRes.ok && Array.isArray(aRes.data)) analytics = aRes.data;
  else if (!aRes.ok) notes.push(`Campaign totals are unavailable (${aRes.reason}).`);

  // Lead records carry the recipient's name, company and per-person engagement.
  // Pulled per campaign because /leads/list is scoped that way.
  for (const id of campaigns.keys()) {
    const lRes = await fetchLeads(id);
    if (!lRes.ok) {
      notes.push(`Recipient names for one campaign could not be read (${lRes.reason}); those rows show the bare address.`);
      continue;
    }
    for (const l of lRes.data as RawLead[]) {
      if (l.email) leads.set(l.email.toLowerCase(), l);
    }
  }

  const value: ColdContext = { campaigns, leads, analytics, notes };
  coldContextCache = { at: Date.now(), value };
  return value;
}

async function loadCold(limit: number, forceContext: boolean): Promise<{ lane: Lane; items: FeedItem[]; campaigns: CampaignSummary[]; notes: string[] }> {
  const label = "Cold campaigns";
  if (!instantlyKey()) {
    return {
      lane: {
        id: "cold", label, available: false, count: 0,
        reason: "INSTANTLY_API_KEY is not set on this deployment, so the campaign sender cannot be read at all.",
      },
      items: [], campaigns: [], notes: [],
    };
  }

  const eRes = await iGet<{ items?: RawEmail[] }>(`/emails?limit=${Math.min(100, Math.max(1, limit))}`);
  if (!eRes.ok) {
    return {
      lane: { id: "cold", label, available: false, count: 0, reason: eRes.reason },
      items: [], campaigns: [], notes: [],
    };
  }

  const ctx = await coldContext(forceContext);
  const raw = [...(eRes.data.items ?? [])];

  // Replies older than the newest `limit` emails would fall off the list above.
  // Pull the reply inbox too (same cached read the Replies board uses, so it is
  // usually free) and add any reply not already present.
  const inbox = await iListAll<RawEmail>("/emails?email_type=received&sort_order=desc", { ttlMs: 20_000, maxPages: 3 });
  if (inbox.ok) {
    const have = new Set(raw.map((e) => e.id).filter(Boolean));
    for (const e of inbox.data) if (e.id && !have.has(e.id)) raw.push(e);
  }

  // Every thread that has an inbound message in this page is a thread that got
  // a reply. Used to mark the outgoing email as replied without inventing it.
  const repliedThreads = new Set(
    raw.filter((e) => e.ue_type === 2 && e.thread_id).map((e) => e.thread_id as string)
  );

  const items: FeedItem[] = raw.map((e) => {
    const inbound = e.ue_type === 2;
    const addr = (inbound ? e.from_address_email : e.to_address_email_list) ?? null;
    const lead = addr ? ctx.leads.get(addr.split(",")[0].trim().toLowerCase()) : undefined;
    const html = e.body?.html ? safeHtml(e.body.html) : null;
    const text = e.body?.text?.trim() || (e.body?.html ? toText(e.body.html) : "");
    const campaign = e.campaign_id ? ctx.campaigns.get(e.campaign_id) : undefined;
    const name = [lead?.first_name, lead?.last_name].filter(Boolean).join(" ").trim() || null;
    const replied = Boolean(e.thread_id && repliedThreads.has(e.thread_id)) || (lead?.email_reply_count ?? 0) > 0;

    return {
      key: `cold:${e.id ?? `${e.message_id ?? addr}-${e.timestamp_created ?? ""}`}`,
      lane: "cold",
      laneLabel: label,
      direction: inbound ? "in" : "out",
      to: e.to_address_email_list ?? null,
      from: e.from_address_email ?? e.eaccount ?? null,
      name,
      company: lead?.company_name ?? null,
      subject: (e.subject ?? "").trim() || "(no subject)",
      html,
      text,
      snippet: snippetOf(text),
      state: inbound ? "received" : replied ? "replied" : "sent",
      stateNote: null,
      campaign: campaign?.name ?? e.campaign_id ?? null,
      campaignId: e.campaign_id ?? null,
      step: stepLabel(e.step),
      at: e.timestamp_email ?? e.timestamp_created ?? new Date().toISOString(),
      opens: lead?.email_open_count ?? null,
      clicks: lead?.email_click_count ?? null,
      replies: lead?.email_reply_count ?? null,
      error: null,
    };
  });

  // A loaded lead that has never been contacted is a real queued send: the
  // sequence will pick it up on its next window. Rendered as a queued row so
  // "what is going out next" lives in the same list as what already went.
  for (const [addr, l] of ctx.leads) {
    if (l.timestamp_last_contact) continue;
    items.push({
      key: `cold-queued:${addr}`,
      lane: "cold",
      laneLabel: label,
      direction: "out",
      to: l.email ?? addr,
      from: null,
      name: [l.first_name, l.last_name].filter(Boolean).join(" ").trim() || null,
      company: l.company_name ?? null,
      subject: "(the sequence writes the subject at send time)",
      html: null,
      text: "",
      snippet: "Loaded into the campaign, not emailed yet.",
      state: "queued",
      stateNote: "Waiting on the campaign's own sending window. Nothing in the OS schedules it.",
      campaign: null,
      campaignId: null,
      step: "Step 1",
      at: new Date().toISOString(),
      opens: null, clicks: null, replies: null, error: null,
    });
  }

  const campaigns: CampaignSummary[] = ctx.analytics.map((a) => ({
    id: a.campaign_id ?? "",
    name: a.campaign_name ?? a.campaign_id ?? "unnamed campaign",
    state: campaignState(a.campaign_status),
    sent: a.emails_sent_count ?? null,
    opens: a.open_count ?? null,
    clicks: a.link_click_count ?? null,
    // Same definition as /api/outreach/instantly: people who replied, minus auto-replies.
    replies: a.reply_count_unique != null || a.reply_count != null
      ? Math.max(0, (a.reply_count_unique ?? a.reply_count ?? 0) - (a.reply_count_automatic_unique ?? 0))
      : null,
    bounces: a.bounced_count ?? null,
    unsubscribes: a.unsubscribed_count ?? null,
    waiting: null,
  }));

  return {
    lane: { id: "cold", label, available: true, count: items.length, reason: null },
    items,
    campaigns,
    notes: ctx.notes,
  };
}

// ── OS Supabase `messages` (the one-to-one lane) ────────────────────────────

type LedgerRow = {
  id: number; client_slug: string | null; direction: string;
  to_addr: string | null; from_addr: string | null; body: string | null;
  status: string; error: string | null; created_at: string;
};

/** POST /api/email/send stores "subject\n\nbody" in one column. Split it back. */
function splitLogged(body: string | null): { subject: string; text: string } {
  const raw = (body ?? "").replace(/\r\n/g, "\n");
  const cut = raw.indexOf("\n\n");
  if (cut <= 0) return { subject: "(no subject recorded)", text: raw.trim() };
  return { subject: raw.slice(0, cut).trim(), text: raw.slice(cut + 2).trim() };
}

function ledgerState(status: string, error: string | null, direction: string): FeedState {
  if (error || status === "failed" || status === "undelivered") return "failed";
  if (direction === "inbound" || status === "received") return "received";
  if (status === "delivered" || status === "sent") return "sent";
  if (status === "queued") return "queued";
  if (status === "bounced") return "bounced";
  return "unknown";
}

async function loadLedger(limit: number): Promise<{ lane: Lane; items: FeedItem[] }> {
  const label = "One to one";
  const url = sbUrl(); const key = sbService();
  if (!url || !key) {
    return {
      lane: {
        id: "ledger", label, available: false, count: 0,
        reason: "OS_SUPABASE_URL / OS_SUPABASE_SERVICE_KEY are not set, so the one-to-one send ledger cannot be read.",
      },
      items: [],
    };
  }
  const q =
    "messages?select=id,client_slug,direction,to_addr,from_addr,body,status,error,created_at" +
    `&channel=eq.email&order=created_at.desc&limit=${limit}`;
  try {
    const res = await fetch(`${url}/rest/v1/${q}`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
      cache: "no-store",
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const quota = res.status === 402 || /exceed_storage_size_quota/i.test(body);
      return {
        lane: {
          id: "ledger", label, available: false, count: 0,
          reason: quota
            ? "The OS Supabase project is restricted for exceeding its storage quota (HTTP 402), so every one-to-one email ever logged is unreadable right now. Clearing that quota in the Supabase dashboard brings this lane back."
            : `The one-to-one send ledger returned HTTP ${res.status}: ${body.slice(0, 200)}`,
        },
        items: [],
      };
    }
    const rows = (await res.json()) as LedgerRow[];
    const items: FeedItem[] = rows.map((m) => {
      const { subject, text } = splitLogged(m.body);
      return {
        key: `ledger:${m.id}`,
        lane: "ledger",
        laneLabel: label,
        direction: m.direction === "inbound" ? "in" : "out",
        to: m.to_addr, from: m.from_addr,
        name: null, company: null,
        subject, html: null, text, snippet: snippetOf(text),
        state: ledgerState(m.status, m.error, m.direction),
        stateNote: null,
        campaign: m.client_slug ? `for ${m.client_slug}` : null,
        campaignId: null,
        step: null,
        at: m.created_at,
        opens: null, clicks: null, replies: null,
        error: m.error,
      };
    });
    return { lane: { id: "ledger", label, available: true, count: items.length, reason: null }, items };
  } catch (e) {
    return {
      lane: {
        id: "ledger", label, available: false, count: 0,
        reason: `The one-to-one send ledger could not be reached: ${e instanceof Error ? e.message : String(e)}`,
      },
      items: [],
    };
  }
}

// ── Sonar Supabase `outbound` (the approved queue lane) ─────────────────────

type OutboundRow = {
  id: number; recipient: string | null; subject: string | null; body: string | null;
  client: string | null; tier: string | null; status: string | null;
  created_at: string | null; sent_at: string | null;
};

function outboundState(status: string | null, sentAt: string | null): FeedState {
  if (sentAt) return "sent";
  switch (status) {
    case "approved": return "queued";
    case "scheduled": return "scheduled";
    case "sent": return "sent";
    case "failed": case "rejected": return "failed";
    case "bounced": case "complained": return "bounced";
    case "new": case "draft": return "draft";
    default: return "unknown";
  }
}

async function loadApproved(limit: number): Promise<{ lane: Lane; items: FeedItem[] }> {
  const label = "Approved queue";
  const url = process.env.SONAR_SUPABASE_URL;
  const key = process.env.SONAR_SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    return {
      lane: {
        id: "approved", label, available: false, count: 0,
        reason: "SONAR_SUPABASE_URL / SONAR_SUPABASE_SERVICE_KEY are not set, so the approved send queue cannot be read.",
      },
      items: [],
    };
  }
  const q =
    "outbound?select=id,recipient,subject,body,client,tier,status,created_at,sent_at" +
    `&channel=eq.email&order=created_at.desc&limit=${limit}`;
  try {
    const res = await fetch(`${url}/rest/v1/${q}`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
      cache: "no-store",
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const quota = res.status === 402 || /exceed_storage_size_quota/i.test(body);
      return {
        lane: {
          id: "approved", label, available: false, count: 0,
          reason: quota
            ? "The outreach Supabase project is restricted for exceeding its storage quota (HTTP 402), so the approved send queue is unreadable right now. Clearing that quota brings this lane back."
            : `The approved send queue returned HTTP ${res.status}: ${body.slice(0, 200)}`,
        },
        items: [],
      };
    }
    const rows = (await res.json()) as OutboundRow[];
    const items: FeedItem[] = rows.map((o) => {
      const text = (o.body ?? "").trim();
      return {
        key: `approved:${o.id}`,
        lane: "approved",
        laneLabel: label,
        direction: "out",
        to: o.recipient, from: null,
        name: null, company: null,
        subject: (o.subject ?? "").trim() || "(no subject on this row)",
        html: null, text, snippet: snippetOf(text),
        state: outboundState(o.status, o.sent_at),
        stateNote: o.status && o.status !== "approved" && !o.sent_at ? `database status: ${o.status}` : null,
        campaign: [o.client, o.tier].filter(Boolean).join(" · ") || null,
        campaignId: null,
        step: null,
        at: o.sent_at ?? o.created_at ?? new Date().toISOString(),
        opens: null, clicks: null, replies: null, error: null,
      };
    });
    return { lane: { id: "approved", label, available: true, count: items.length, reason: null }, items };
  } catch (e) {
    return {
      lane: {
        id: "approved", label, available: false, count: 0,
        reason: `The approved send queue could not be reached: ${e instanceof Error ? e.message : String(e)}`,
      },
      items: [],
    };
  }
}

// ── Outreach replies (the OS outreach queue + Instantly sync) ───────────────
//
// Replies recorded by /api/cron/outreach-sync and the Instantly webhook, each
// tied to the lead and the draft it answers. The thread is the sequence as it
// was approved (from outreach_drafts) with the times each step actually went
// out (from outreach_events), then the reply. When the cold lane already shows
// the same Instantly message, that row gains the thread and the draft link
// instead of appearing twice.

type OutreachThread = { instantlyId: string | null; item: FeedItem };

// The SSE stream reloads the feed every tick; the outreach threads change only
// when the 15-minute sync or a webhook lands, so 30s of reuse costs nothing.
const OUTREACH_TTL_MS = 30_000;
let outreachCache: { at: number; limit: number; value: { lane: Lane; threads: OutreachThread[] } } | null = null;

async function loadOutreach(limit: number): Promise<{ lane: Lane; threads: OutreachThread[] }> {
  if (outreachCache && outreachCache.limit >= limit && Date.now() - outreachCache.at < OUTREACH_TTL_MS) {
    // Fresh copies: the merge below mutates cold rows, never these, but the
    // SSE stream diffs items across ticks so they must not be shared objects.
    return { lane: outreachCache.value.lane, threads: outreachCache.value.threads.map((t) => ({ ...t, item: { ...t.item } })) };
  }
  const value = await loadOutreachFresh(limit);
  if (value.lane.available) outreachCache = { at: Date.now(), limit, value };
  return { lane: value.lane, threads: value.threads.map((t) => ({ ...t, item: { ...t.item } })) };
}

async function loadOutreachFresh(limit: number): Promise<{ lane: Lane; threads: OutreachThread[] }> {
  const label = "Outreach replies";
  const choice = outreachStore();
  if (!choice.store) {
    return { lane: { id: "outreach", label, available: false, count: 0, reason: choice.reason }, threads: [] };
  }
  try {
    const store = choice.store;
    const replies = await store.listReplies(Math.min(limit, 200));
    const oldest = replies.reduce((m, r) => Math.min(m, Date.parse(r.occurredAt)), Date.now());
    const sends = replies.length ? await store.listEvents(new Date(oldest - 120 * 24 * 3600 * 1000).toISOString()) : [];
    const draftCache = new Map<number, Awaited<ReturnType<typeof store.getDraft>>>();
    const threads: OutreachThread[] = [];
    for (const r of replies) {
      let draft = null;
      if (r.draftId != null) {
        if (!draftCache.has(r.draftId)) draftCache.set(r.draftId, await store.getDraft(r.draftId));
        draft = draftCache.get(r.draftId) ?? null;
      }
      const sentTimes = new Map<number, string>();
      for (const e of sends) {
        if (e.eventType === "sent" && e.contactEmail === r.contactEmail && e.step != null && Date.parse(e.occurredAt) <= Date.parse(r.occurredAt)) {
          if (!sentTimes.has(e.step) || sentTimes.get(e.step)! < e.occurredAt) sentTimes.set(e.step, e.occurredAt);
        }
      }
      const thread: ThreadMessage[] = (draft?.steps ?? [])
        .filter((st) => sentTimes.has(st.step))
        .map((st) => ({ at: sentTimes.get(st.step) ?? null, direction: "out" as const, step: st.step, subject: st.subject, text: st.body }));
      const text = (r.bodyText ?? "").trim();
      const who = draft?.contactName ?? null;
      threads.push({
        instantlyId: r.instantlyEmailId,
        item: {
          key: `outreach:${r.id}`,
          lane: "outreach",
          laneLabel: label,
          direction: "in",
          to: r.mailbox,
          from: r.contactEmail,
          name: who,
          company: draft?.company ?? null,
          subject: (r.subject ?? "").trim() || (thread.length ? `Re: ${thread[thread.length - 1].subject}` : "(no subject)"),
          html: null,
          text,
          snippet: snippetOf(text),
          state: "received",
          stateNote: r.stopReason === "negative_reply" ? "Asked to be taken off the list. Suppressed for good."
            : r.stopReason === "spam_complaint" ? "Complained. Suppressed for good."
            : r.stopReason === "handoff" ? "A real reply: the sequence stops here and this one is yours."
            : null,
          campaign: r.interest ? `Custom outreach, labelled ${r.interest}` : "Custom outreach",
          campaignId: r.campaignId,
          step: r.round && r.round > 1 ? `Round ${r.round}` : null,
          at: r.occurredAt,
          opens: null, clicks: null, replies: null, error: null,
          thread,
          link: draft ? { href: `/outreach?date=${draft.batchDate}#draft-${draft.id}`, label: `Open ${draft.company ?? "the"} draft on Outreach` } : null,
        },
      });
    }
    return { lane: { id: "outreach", label, available: true, count: threads.length, reason: null }, threads };
  } catch (e) {
    return { lane: { id: "outreach", label, available: false, count: 0, reason: storeFailure(e).message }, threads: [] };
  }
}

// ── The merge ───────────────────────────────────────────────────────────────

export async function loadEmailFeed(opts: { limit?: number; forceContext?: boolean } = {}): Promise<FeedPayload> {
  const limit = Math.min(500, Math.max(10, opts.limit ?? 100));

  // The three lanes are independent; one being down must not delay the others.
  const [cold, ledger, approved, outreach] = await Promise.all([
    loadCold(limit, opts.forceContext ?? false),
    loadLedger(limit),
    loadApproved(limit),
    loadOutreach(limit),
  ]);

  // An outreach reply the cold lane already shows enriches that row instead of
  // repeating it.
  const coldByKey = new Map(cold.items.map((i) => [i.key, i]));
  const extra: FeedItem[] = [];
  for (const t of outreach.threads) {
    const twin = t.instantlyId ? coldByKey.get(`cold:${t.instantlyId}`) : undefined;
    if (twin) {
      twin.thread = t.item.thread;
      twin.link = t.item.link;
      twin.stateNote = twin.stateNote ?? t.item.stateNote;
      twin.name = twin.name ?? t.item.name;
      twin.company = twin.company ?? t.item.company;
    } else {
      extra.push(t.item);
    }
  }

  const items = [...cold.items, ...ledger.items, ...approved.items, ...extra]
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));

  const lanes = [cold.lane, ledger.lane, approved.lane, outreach.lane];
  const anyAvailable = lanes.some((l) => l.available);
  const allAvailable = lanes.every((l) => l.available);

  const trackedOpens = cold.campaigns.some((c) => (c.opens ?? 0) > 0 || (c.clicks ?? 0) > 0);

  return {
    items,
    lanes,
    campaigns: cold.campaigns,
    anyAvailable,
    emptyNote:
      allAvailable && items.length === 0
        ? "No email has gone out from any lane. Every source is readable, this is the real number."
        : null,
    trackingNote: !trackedOpens && cold.lane.available
      ? "Per-email opens and clicks are not in the sender's message record. The numbers on a row are that recipient's totals across the whole sequence, and they stay at zero while open tracking is off on the campaign."
      : null,
    fetchedAt: new Date().toISOString(),
  };
}

export { safeHtml, toText, snippetOf };
