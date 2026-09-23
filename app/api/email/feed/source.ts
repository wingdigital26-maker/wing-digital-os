import { sbUrl, sbService } from "@/lib/osSupabase";
import { instantlyKey, type InstantlyEmail } from "@/lib/instantly";

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
};

export type LaneId = "cold" | "ledger" | "approved";

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

const INSTANTLY_BASE = "https://api.instantly.ai/api/v2";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

type Fetched<T> = { ok: true; data: T } | { ok: false; reason: string };

async function iGet<T>(path: string): Promise<Fetched<T>> {
  const key = instantlyKey();
  if (!key) return { ok: false, reason: "INSTANTLY_API_KEY is not set on this deployment." };
  try {
    const res = await fetch(`${INSTANTLY_BASE}${path}`, {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json", "User-Agent": UA },
      cache: "no-store",
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { ok: false, reason: `Instantly ${path.split("?")[0]} returned HTTP ${res.status}: ${body.slice(0, 160)}` };
    }
    return { ok: true, data: (await res.json()) as T };
  } catch (e) {
    return { ok: false, reason: `Instantly ${path.split("?")[0]} unreachable: ${e instanceof Error ? e.message : String(e)}` };
  }
}

async function iPost<T>(path: string, body: unknown): Promise<Fetched<T>> {
  const key = instantlyKey();
  if (!key) return { ok: false, reason: "INSTANTLY_API_KEY is not set on this deployment." };
  try {
    const res = await fetch(`${INSTANTLY_BASE}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`, Accept: "application/json",
        "Content-Type": "application/json", "User-Agent": UA,
      },
      body: JSON.stringify(body),
      cache: "no-store",
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      return { ok: false, reason: `Instantly ${path} returned HTTP ${res.status}: ${t.slice(0, 160)}` };
    }
    return { ok: true, data: (await res.json()) as T };
  } catch (e) {
    return { ok: false, reason: `Instantly ${path} unreachable: ${e instanceof Error ? e.message : String(e)}` };
  }
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

  const cRes = await iGet<{ items?: RawCampaign[] }>("/campaigns?limit=100");
  if (cRes.ok) {
    for (const c of cRes.data.items ?? []) if (c.id) campaigns.set(c.id, c);
  } else {
    notes.push(`Campaign names could not be read (${cRes.reason}), so rows show the campaign id instead.`);
  }

  const aRes = await iGet<RawAnalytics[]>("/campaigns/analytics");
  if (aRes.ok && Array.isArray(aRes.data)) analytics = aRes.data;
  else if (!aRes.ok) notes.push(`Campaign totals are unavailable (${aRes.reason}).`);

  // Lead records carry the recipient's name, company and per-person engagement.
  // Pulled per campaign because /leads/list is scoped that way.
  for (const id of campaigns.keys()) {
    const lRes = await iPost<{ items?: RawLead[] }>("/leads/list", { campaign_ids: [id], limit: 100 });
    if (!lRes.ok) {
      notes.push(`Recipient names for one campaign could not be read (${lRes.reason}); those rows show the bare address.`);
      continue;
    }
    for (const l of lRes.data.items ?? []) {
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
  const raw = eRes.data.items ?? [];

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
    replies: a.reply_count ?? null,
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

// ── The merge ───────────────────────────────────────────────────────────────

export async function loadEmailFeed(opts: { limit?: number; forceContext?: boolean } = {}): Promise<FeedPayload> {
  const limit = Math.min(500, Math.max(10, opts.limit ?? 100));

  // The three lanes are independent; one being down must not delay the others.
  const [cold, ledger, approved] = await Promise.all([
    loadCold(limit, opts.forceContext ?? false),
    loadLedger(limit),
    loadApproved(limit),
  ]);

  const items = [...cold.items, ...ledger.items, ...approved.items]
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));

  const lanes = [cold.lane, ledger.lane, approved.lane];
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
