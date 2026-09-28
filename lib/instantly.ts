// Server-only helper for the Instantly.ai V2 API.
//
// Jack's cold email actually sends through Instantly, not through anything
// local. Our ledger never sees those sends -- the only way to show what is
// really going out (and, above all, who REPLIED) is to read Instantly's own
// API server-side. This helper is READ-ONLY: it never posts a lead, never
// triggers a send, never mutates campaign state. Every function fails closed
// (returns { ok:false, kind, reason }) instead of throwing, so a route can
// degrade one section at a time instead of 500ing the whole page.
//
// Auth facts (verified 2026-09-15, re-verified 2026-09-24): Instantly sits
// behind Cloudflare and 403s (error 1010) any request without a real browser
// User-Agent, even with a valid API key. Bearer auth + Accept + a real UA are
// required on every call.
//
// API facts (developer.instantly.ai, read 2026-09-24):
//   * v2 only (v1 is deprecated). Base https://api.instantly.ai/api/v2.
//   * Workspace limit 100 req/s and 6,000 req/min, shared across v1+v2.
//   * GET /emails is special: 20 requests per MINUTE per workspace.
//   * Lists page with `limit` (max 100) + `starting_after`; the response hands
//     back `next_starting_after` even on the last page, so a short page = end.
//   * GET /emails?email_type=received is the reply inbox (ue_type 2).

const BASE = "https://api.instantly.ai/api/v2";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

export function instantlyKey(): string | undefined {
  return process.env.INSTANTLY_API_KEY?.trim() || undefined;
}
export function instantlyCampaignId(): string | undefined {
  return process.env.INSTANTLY_DEFAULT_CAMPAIGN?.trim() || undefined;
}

// ── The one shared client ──────────────────────────────────────────────────
//
// Every Instantly read in the OS goes through iRequest(). It gives each call:
//   * READ-ONLY enforcement: GET, plus POST only to the list endpoints named
//     in READ_ONLY_POSTS (Instantly uses POST for "list leads"). Anything else
//     is refused before it leaves the server. (Enqueueing a lead lives in
//     lib/email.ts on purpose and does not use this client.)
//   * a hard timeout (default 8s) so a hung Instantly never hangs a page;
//   * retries: 429 honours Retry-After (capped at 5s), 5xx / network errors
//     retry with a short backoff; other 4xx and timeouts never retry;
//   * a per-process TTL cache with in-flight de-duplication, so ten tabs
//     asking at once cost one upstream call;
//   * stale-on-error: if a refresh fails and we still hold an answer younger
//     than STALE_MAX_MS, that answer is served WITH stale:true and its age,
//     so the UI can say "Instantly did not answer, showing data from 2 min
//     ago" instead of going blank or pretending it is fresh;
//   * a budget for /emails (Instantly: 20/min per workspace). We spend at most
//     EMAILS_PER_MIN of those per server instance and serve cache past it.

export type InstantlyErrorKind = "no_key" | "auth" | "rate_limited" | "timeout" | "down" | "bad_request";

export type Fetched<T> =
  | { ok: true; data: T; at: number; stale: boolean; staleReason?: string }
  | { ok: false; kind: InstantlyErrorKind; reason: string; status?: number };

const READ_ONLY_POSTS = new Set(["/leads/list"]);

const DEFAULT_TIMEOUT_MS = 8_000;
const STALE_MAX_MS = 15 * 60 * 1000;
// Per server instance. Several warm instances can each spend this, so it sits
// well under Instantly's 20; if the workspace still hits 429 the client backs
// off and serves the last answer, labelled stale.
const EMAILS_PER_MIN = 10;

type CacheEntry = { at: number; data: unknown; expired?: boolean };
// Kept on globalThis, not in module scope: Next can load this module more than
// once in one server process (one copy per route bundle, and again on dev
// reloads). Module-level state would give each route its own cache and its own
// /emails budget, which is exactly how a workspace overspends a 20/min limit.
type ClientState = {
  cache: Map<string, CacheEntry>;
  inflight: Map<string, Promise<Fetched<unknown>>>;
  emailCalls: number[];
};
const G = globalThis as typeof globalThis & { __wingInstantly?: ClientState };
const state: ClientState = (G.__wingInstantly ??= { cache: new Map(), inflight: new Map(), emailCalls: [] });
const cache = state.cache;
const inflight = state.inflight;
const emailCalls = state.emailCalls;

function emailsBudgetLeft(): boolean {
  const now = Date.now();
  while (emailCalls.length && now - emailCalls[0] > 60_000) emailCalls.shift();
  return emailCalls.length < EMAILS_PER_MIN;
}

/** Mark cached answers whose key starts with prefix (e.g. "GET /emails") as expired.
 *  They stay available as a stale fallback; the next read refetches. */
export function invalidateInstantly(prefix = ""): void {
  for (const [k, v] of cache) if (k.startsWith(prefix)) cache.set(k, { ...v, expired: true });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function describeStatus(path: string, status: number, body: string): { kind: InstantlyErrorKind; reason: string } {
  const where = `Instantly ${path.split("?")[0]}`;
  if (status === 401) {
    return { kind: "auth", reason: `${where} rejected the API key (HTTP 401). The INSTANTLY_API_KEY on this deployment is wrong, revoked, or missing a read scope.` };
  }
  if (status === 403) {
    const cf = /1010|cloudflare/i.test(body);
    return {
      kind: "auth",
      reason: cf
        ? `${where} was blocked by Instantly's Cloudflare (HTTP 403). Usually a missing browser User-Agent; the key itself may be fine.`
        : `${where} refused this key (HTTP 403). The key probably lacks the read scope for this endpoint.`,
    };
  }
  if (status === 429) {
    return { kind: "rate_limited", reason: `${where} is rate-limiting us (HTTP 429). Instantly allows 20 inbox reads a minute per workspace.` };
  }
  if (status >= 500) return { kind: "down", reason: `${where} is failing on Instantly's side (HTTP ${status}).` };
  return { kind: "bad_request", reason: `${where} returned HTTP ${status}: ${body.slice(0, 160)}` };
}

export type RequestOpts = {
  method?: "GET" | "POST";
  body?: unknown;
  /** How long a good answer is reused. 0 = never served from cache while fresh. */
  ttlMs?: number;
  /** Skip the fresh-cache check (still de-duplicated and still budgeted). */
  force?: boolean;
  timeoutMs?: number;
};

export async function iRequest<T>(path: string, opts: RequestOpts = {}): Promise<Fetched<T>> {
  const method = opts.method ?? "GET";
  const pathOnly = path.split("?")[0];
  if (method !== "GET" && !(method === "POST" && READ_ONLY_POSTS.has(pathOnly))) {
    return { ok: false, kind: "bad_request", reason: `Refused: ${method} ${pathOnly} is not a read. The OS only reads from Instantly.` };
  }
  const key = instantlyKey();
  if (!key) {
    return { ok: false, kind: "no_key", reason: "INSTANTLY_API_KEY is not set on this deployment, so Instantly cannot be read." };
  }

  const ttl = opts.ttlMs ?? 0;
  const cacheKey = `${method} ${path} ${opts.body === undefined ? "" : JSON.stringify(opts.body)}`;
  const hit = cache.get(cacheKey);
  if (hit && !hit.expired && !opts.force && Date.now() - hit.at < ttl) {
    return { ok: true, data: hit.data as T, at: hit.at, stale: false };
  }

  const running = inflight.get(cacheKey);
  if (running) return running as Promise<Fetched<T>>;

  const isEmails = pathOnly === "/emails" || pathOnly.startsWith("/emails/");
  if (isEmails && !emailsBudgetLeft()) {
    const reason = "Held back to stay under Instantly's limit of 20 inbox reads a minute.";
    if (hit && Date.now() - hit.at < STALE_MAX_MS) {
      return { ok: true, data: hit.data as T, at: hit.at, stale: true, staleReason: reason };
    }
    return { ok: false, kind: "rate_limited", reason: `${reason} Try again in a few seconds.` };
  }

  const p = (async (): Promise<Fetched<T>> => {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs + 4_000; // retries never run past this
    let last: Fetched<T> = { ok: false, kind: "down", reason: `Instantly ${pathOnly} was not reached.` };
    for (let attempt = 0; attempt < 3; attempt++) {
      if (isEmails) emailCalls.push(Date.now());
      let waitMs = 0;
      try {
        const res = await fetch(`${BASE}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${key}`,
            Accept: "application/json",
            ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
            "User-Agent": UA,
          },
          body: method === "POST" ? JSON.stringify(opts.body ?? {}) : undefined,
          cache: "no-store",
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (res.ok) {
          const data = (await res.json()) as T;
          const at = Date.now();
          cache.set(cacheKey, { at, data });
          return { ok: true, data, at, stale: false };
        }
        const text = await res.text().catch(() => "");
        last = { ok: false, ...describeStatus(path, res.status, text), status: res.status };
        if (res.status === 429) {
          const ra = Number(res.headers.get("retry-after"));
          waitMs = Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 5_000) : 1_500 * (attempt + 1);
        } else if (res.status >= 500) {
          waitMs = 600 * (attempt + 1);
        } else {
          break; // 4xx other than 429: retrying will not help
        }
      } catch (err) {
        const name = err instanceof Error ? err.name : "";
        const timedOut = name === "TimeoutError" || name === "AbortError";
        last = timedOut
          ? { ok: false, kind: "timeout", reason: `Instantly ${pathOnly} did not answer within ${Math.round(timeoutMs / 1000)}s.` }
          : { ok: false, kind: "down", reason: `Instantly ${pathOnly} is unreachable: ${err instanceof Error ? err.message : String(err)}` };
        if (timedOut) break; // a second 8s wait makes the page slower, not better
        waitMs = 600 * (attempt + 1);
      }
      if (attempt === 2 || Date.now() + waitMs > deadline) break;
      if (isEmails && !emailsBudgetLeft()) break;
      await sleep(waitMs);
    }
    // Stale-on-error: an older real answer beats a blank screen, if labelled.
    const prev = cache.get(cacheKey);
    if (!last.ok && prev && last.kind !== "auth" && Date.now() - prev.at < STALE_MAX_MS) {
      return { ok: true, data: prev.data as T, at: prev.at, stale: true, staleReason: last.reason };
    }
    return last;
  })();

  inflight.set(cacheKey, p as Promise<Fetched<unknown>>);
  try {
    return await p;
  } finally {
    inflight.delete(cacheKey);
  }
}

type ListResult<T> = Fetched<T[]> & { truncated?: boolean };

/** Follow next_starting_after for a GET list endpoint, up to maxPages. */
export async function iListAll<T>(
  basePath: string,
  opts: { limit?: number; maxPages?: number; ttlMs?: number; force?: boolean } = {}
): Promise<ListResult<T>> {
  const limit = Math.min(100, opts.limit ?? 100);
  const maxPages = opts.maxPages ?? 5;
  const out: T[] = [];
  let after: string | undefined;
  let oldestAt = Date.now();
  let stale = false;
  let staleReason: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const sep = basePath.includes("?") ? "&" : "?";
    const path = `${basePath}${sep}limit=${limit}${after ? `&starting_after=${encodeURIComponent(after)}` : ""}`;
    const r = await iRequest<{ items?: T[]; next_starting_after?: string }>(path, { ttlMs: opts.ttlMs, force: opts.force });
    if (!r.ok) {
      if (page === 0) return r;
      return { ok: true, data: out, at: oldestAt, stale: true, staleReason: `Only the first ${page} page(s) could be read: ${r.reason}`, truncated: true };
    }
    oldestAt = Math.min(oldestAt, r.at);
    if (r.stale) { stale = true; staleReason = r.staleReason; }
    const items = r.data.items ?? [];
    out.push(...items);
    after = r.data.next_starting_after;
    if (!after || items.length < limit) return { ok: true, data: out, at: oldestAt, stale, staleReason };
  }
  return { ok: true, data: out, at: oldestAt, stale, staleReason, truncated: true };
}

/** Every lead in one campaign. POST /leads/list is a read; it pages by a body cursor. */
export async function iListLeads(
  campaignId: string,
  opts: { maxPages?: number; ttlMs?: number; force?: boolean } = {}
): Promise<ListResult<InstantlyLead>> {
  const out: InstantlyLead[] = [];
  let after: string | undefined;
  let at = Date.now();
  let stale = false;
  let staleReason: string | undefined;
  const maxPages = opts.maxPages ?? 10;
  for (let page = 0; page < maxPages; page++) {
    const body: Record<string, unknown> = { campaign: campaignId, limit: 100 };
    if (after) body.starting_after = after;
    const r = await iRequest<{ items?: InstantlyLead[]; next_starting_after?: string }>("/leads/list", {
      method: "POST", body, ttlMs: opts.ttlMs, force: opts.force,
    });
    if (!r.ok) {
      if (page === 0) return r;
      return { ok: true, data: out, at, stale: true, staleReason: r.reason, truncated: true };
    }
    at = Math.min(at, r.at);
    if (r.stale) { stale = true; staleReason = r.staleReason; }
    const items = r.data.items ?? [];
    out.push(...items);
    after = r.data.next_starting_after;
    if (!after || items.length < 100) return { ok: true, data: out, at, stale, staleReason };
  }
  return { ok: true, data: out, at, stale, staleReason, truncated: true };
}

// ── Raw upstream shapes (only the fields we use) ───────────────────────────

export type InstantlyCampaign = {
  id: string;
  name: string;
  status: number;
  open_tracking?: boolean;
  link_tracking?: boolean;
  daily_limit?: number;
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
  campaign_id?: string;
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
  reply_count_unique?: number;
  reply_count_automatic?: number;
  open_count_unique?: number;
  total_opportunities?: number;
};

export type InstantlyEmail = {
  id?: string;
  campaign_id?: string | null;
  lead?: string;
  lead_id?: string;
  eaccount?: string;
  /** 1 sent from campaign, 2 received (a reply), 3 sent manually, 4 scheduled. */
  ue_type?: number;
  step?: string | null;
  thread_id?: string;
  message_id?: string;
  timestamp_email?: string;
  is_unread?: number | boolean;
  /** Lead interest label Instantly (or a person) set on the reply. */
  i_status?: number | null;
  content_preview?: string;
  to_address_email_list?: string;
  from_address_email?: string;
  timestamp_created?: string;
  subject?: string;
  body?: { text?: string; html?: string };
};

export type InstantlyLead = {
  id?: string;
  email?: string;
  email_open_count?: number;
  email_reply_count?: number;
  email_click_count?: number;
  lt_interest_status?: number | null;
  first_name?: string;
  last_name?: string;
  company_name?: string;
  status?: number;
  // Set only once Instantly has actually emailed the lead. This is the
  // reliable "has been contacted" signal: `status` stays 1 (active/verified)
  // for every loaded lead whether or not it has been emailed yet.
  timestamp_last_contact?: string | null;
};

// Campaign metadata and totals change slowly: 60s / 30s caches.
export async function fetchCampaign(campaignId: string) {
  return iRequest<InstantlyCampaign>(`/campaigns/${encodeURIComponent(campaignId)}`, { ttlMs: 60_000 });
}

export async function fetchCampaigns() {
  return iListAll<InstantlyCampaign>("/campaigns", { ttlMs: 60_000, maxPages: 5 });
}

/** Totals for every campaign in the workspace (one call, no id needed). */
export async function fetchAnalytics() {
  return iRequest<InstantlyAnalytics[]>(`/campaigns/analytics`, { ttlMs: 30_000 });
}

/** Most recent campaign emails WE sent (ue_type 1), newest first. */
export async function fetchSentEmails(campaignId: string, limit = 25) {
  return iRequest<{ items?: InstantlyEmail[] }>(
    `/emails?campaign_id=${encodeURIComponent(campaignId)}&email_type=sent&limit=${Math.min(100, limit)}`,
    { ttlMs: 60_000 }
  );
}

export async function fetchLeads(campaignId: string) {
  return iListLeads(campaignId, { ttlMs: 60_000 });
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
