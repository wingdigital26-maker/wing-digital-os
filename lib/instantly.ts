// Server-only helper for the Instantly.ai V2 API.
//
// Jack's cold email actually sends through Instantly, not through anything
// local. Our ledger never sees those sends -- the only way to show what is
// really going out is to read Instantly's own API server-side. This helper
// is READ-ONLY: it never posts a lead, never triggers a send, never mutates
// campaign state. Every function fails closed (returns null/empty + a reason
// string) instead of throwing, so the route can degrade one section at a
// time instead of 500ing the whole page.
//
// Auth facts (verified 2026-09-15): Instantly sits behind Cloudflare and
// 403s (error 1010) any request without a real browser User-Agent, even with
// a valid API key. Bearer auth + Accept/Content-Type + a real UA are all
// required on every call.

const BASE = "https://api.instantly.ai/api/v2";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

export function instantlyKey(): string | undefined {
  return process.env.INSTANTLY_API_KEY;
}
export function instantlyCampaignId(): string | undefined {
  return process.env.INSTANTLY_DEFAULT_CAMPAIGN;
}

function headers(): HeadersInit {
  return {
    Authorization: `Bearer ${instantlyKey()}`,
    Accept: "application/json",
    "Content-Type": "application/json",
    "User-Agent": UA,
  };
}

type Fetched<T> = { ok: true; data: T } | { ok: false; reason: string };

async function getJson<T>(path: string): Promise<Fetched<T>> {
  try {
    const res = await fetch(`${BASE}${path}`, { method: "GET", headers: headers(), cache: "no-store" });
    if (!res.ok) {
      return { ok: false, reason: `Instantly ${path} returned HTTP ${res.status}` };
    }
    const data = (await res.json()) as T;
    return { ok: true, data };
  } catch (err) {
    return { ok: false, reason: `Instantly ${path} unreachable: ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function postJson<T>(path: string, body: unknown): Promise<Fetched<T>> {
  try {
    const res = await fetch(`${BASE}${path}`, { method: "POST", headers: headers(), body: JSON.stringify(body), cache: "no-store" });
    if (!res.ok) {
      return { ok: false, reason: `Instantly ${path} returned HTTP ${res.status}` };
    }
    const data = (await res.json()) as T;
    return { ok: true, data };
  } catch (err) {
    return { ok: false, reason: `Instantly ${path} unreachable: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// ── Raw upstream shapes (only the fields we use) ───────────────────────────

export type InstantlyCampaign = {
  id: string;
  name: string;
  status: number;
  campaign_schedule?: {
    schedules?: Array<{
      timing?: { from?: string; to?: string };
      days?: Record<string, boolean> | string[];
      timezone?: string;
    }>;
  };
  sequences?: Array<{
    steps?: Array<{
      type?: string;
      delay?: number;
      variants?: Array<{ subject?: string; body?: string }>;
    }>;
  }>;
};

export type InstantlyAnalytics = {
  campaign_name?: string;
  campaign_status?: number;
  leads_count?: number;
  contacted_count?: number;
  emails_sent_count?: number;
  open_count?: number;
  reply_count?: number;
  link_click_count?: number;
  bounced_count?: number;
  unsubscribed_count?: number;
  completed_count?: number;
};

export type InstantlyEmail = {
  to_address_email_list?: string;
  from_address_email?: string;
  timestamp_created?: string;
  subject?: string;
  body?: { text?: string; html?: string };
};

export type InstantlyLead = {
  email?: string;
  first_name?: string;
  last_name?: string;
  company_name?: string;
  status?: number;
  // Set only once Instantly has actually emailed the lead. This is the
  // reliable "has been contacted" signal: `status` stays 1 (active/verified)
  // for every loaded lead whether or not it has been emailed yet.
  timestamp_last_contact?: string | null;
};

export async function fetchCampaign(campaignId: string) {
  return getJson<InstantlyCampaign>(`/campaigns/${encodeURIComponent(campaignId)}`);
}

export async function fetchAnalytics(campaignId: string) {
  return getJson<InstantlyAnalytics[]>(`/campaigns/analytics?campaign_id=${encodeURIComponent(campaignId)}`);
}

export async function fetchSentEmails(campaignId: string, limit = 25) {
  return getJson<{ items?: InstantlyEmail[] }>(
    `/emails?campaign_id=${encodeURIComponent(campaignId)}&limit=${limit}`
  );
}

export async function fetchLeads(campaignId: string, limit = 50) {
  return postJson<{ items?: InstantlyLead[] }>(`/leads/list`, { campaign_ids: [campaignId], limit });
}

// ── Text cleanup ────────────────────────────────────────────────────────────

// Strip HTML down to readable plain text. Instantly's stored bodies are
// div/br soup, not real paragraphs, so div/br become newlines and everything
// else is dropped.
export function htmlToText(html: string | undefined | null): string {
  if (!html) return "";
  let out = html
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\s*\/\s*div\s*>/gi, "\n")
    .replace(/<\s*\/\s*p\s*>/gi, "\n\n")
    .replace(/<[^>]+>/g, "");
  out = out
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
  // Known mojibake: a garbled/replacement-char separator before a street
  // address should read as a middle dot, e.g. "...3312 Caleo Court".
  out = out.replace(/\s*[�ï¿½]+\s*(?=\d+\s+\w)/g, " · ");
  out = out.replace(/\n{3,}/g, "\n\n").trim();
  return out;
}

const DAY_ORDER = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;
const DAY_ABBR: Record<string, string> = {
  monday: "Mon",
  tuesday: "Tue",
  wednesday: "Wed",
  thursday: "Thu",
  friday: "Fri",
  saturday: "Sat",
  sunday: "Sun",
};

// Render a campaign_schedule into a human string like "Mon-Fri 9:00-17:00 America/Chicago".
export function describeSchedule(campaign: InstantlyCampaign): string | null {
  const sched = campaign.campaign_schedule?.schedules?.[0];
  if (!sched) return null;
  const from = sched.timing?.from ?? null;
  const to = sched.timing?.to ?? null;
  const tz = sched.timezone ?? null;

  let dayLabel = "";
  const days = sched.days;
  if (Array.isArray(days)) {
    dayLabel = days.map((d) => DAY_ABBR[d.toLowerCase()] ?? d).join(", ");
  } else if (days && typeof days === "object") {
    // Instantly V2 keys days numerically as {"0":false,...,"6":true} where
    // 0 = Sunday .. 6 = Saturday. Older/named payloads use {"monday":true}.
    // Support both so the weekday label never silently drops.
    const rec = days as Record<string, boolean>;
    // numeric key per Instantly: sunday=0, monday=1 .. saturday=6
    const numKey: Record<string, string> = {
      sunday: "0", monday: "1", tuesday: "2", wednesday: "3",
      thursday: "4", friday: "5", saturday: "6",
    };
    const active = DAY_ORDER.filter((d) => rec[d] === true || rec[numKey[d]] === true);
    if (active.length === 5 && active.join(",") === "monday,tuesday,wednesday,thursday,friday") {
      dayLabel = "Mon-Fri";
    } else if (active.length === 7) {
      dayLabel = "Every day";
    } else if (active.length > 0) {
      dayLabel = active.map((d) => DAY_ABBR[d]).join(", ");
    }
  }

  const timeLabel = from && to ? `${from}-${to}` : null;
  const parts = [dayLabel, timeLabel, tz].filter(Boolean);
  return parts.length > 0 ? parts.join(" ") : null;
}
