import { NextResponse } from "next/server";
import { requireCallUser, sbConfigured, sbGet, CLAIM_MINUTES } from "../_guard";
import { sbUrl, sbService } from "../../../../lib/osSupabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Lead = {
  id: string;
  company: string;
  contact_name: string | null;
  title: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  linkedin: string | null;
  city: string | null;
  vertical: string | null;
  employees: number | null;
  revenue: number | null;
  score: number | null;
  signals: string | null;
  status: string;
  claimed_by: string | null;
  claimed_at: string | null;
  last_outcome: string | null;
  last_called_at: string | null;
  call_count: number;
  next_action_at: string | null;
  assigned_to: string | null;
  assigned_to_email: string | null;
  // Dial-sheet intel (migration 0032). Every one is nullable: the backfill
  // lands progressively, so a row with none of it is normal, not an error.
  angle: string | null;
  cautions: unknown;
  chips: unknown;
  socials: unknown;
  google_reviews: number | null;
  google_rating: number | null;
  site_pages: number | null;
  has_blog: boolean | null;
  service_pages: number | null;
};

// Buy-likelihood tier. A separate pipeline owns this column and is still
// choosing its name, so the room discovers it instead of assuming one. If none
// of these exist yet, the tier pills simply do not appear and everything else
// works exactly as before.
const TIER_COLUMN_CANDIDATES = ["tier", "buy_tier", "lead_tier", "likelihood_tier"] as const;
const TIER_VALUES = ["A", "B", "C"] as const;

let tierColumnCache: { name: string | null; at: number } | null = null;
const TIER_CACHE_MS = 60_000;

// Ask PostgREST for one row of a candidate column. A missing column 400s, which
// is the signal we want; a real row (or an empty table) 200s.
async function columnExists(table: string, column: string): Promise<boolean> {
  const url = sbUrl();
  const key = sbService();
  if (!url || !key) return false;
  try {
    const r = await fetch(`${url}/rest/v1/${table}?select=${column}&limit=1`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
      cache: "no-store",
    });
    return r.ok;
  } catch {
    return false;
  }
}

async function tierColumn(): Promise<string | null> {
  if (tierColumnCache && Date.now() - tierColumnCache.at < TIER_CACHE_MS) {
    return tierColumnCache.name;
  }
  let found: string | null = null;
  for (const c of TIER_COLUMN_CANDIDATES) {
    if (await columnExists("call_leads", c)) {
      found = c;
      break;
    }
  }
  tierColumnCache = { name: found, at: Date.now() };
  return found;
}

// Every status a lead can sit at. Counts are computed per status with real
// count queries so the pills are true even when only a page of rows is sent.
const STATUSES = [
  "new",
  "contacted",
  "callback",
  "booked",
  "not_interested",
  "bad_number",
  "dnc",
] as const;

// True row count for a PostgREST filter, via a HEAD request with count=exact.
// Returns null on failure so callers can fall back honestly.
async function sbCount(table: string, qs: string): Promise<number | null> {
  const url = sbUrl();
  const key = sbService();
  if (!url || !key) return null;
  try {
    const r = await fetch(`${url}/rest/v1/${table}?${qs}`, {
      method: "HEAD",
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        Prefer: "count=exact",
      },
      cache: "no-store",
    });
    if (!r.ok) return null;
    const range = r.headers.get("content-range"); // "0-99/714" or "*/714"
    const total = range?.split("/")[1];
    const n = total ? Number(total) : NaN;
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

// GET /api/calls/leads
//   ?status=new|contacted|callback|booked|...   (optional filter)
//   ?q=search text                              (company / contact / city)
//   ?limit=100&offset=0                         (pagination; limit max 500)
// Returns a page of leads, best-scoring first, with each lead's claim resolved
// to "free | mine | someone else", plus TRUE per-status counts and the true
// total for the current query so the UI never lies about how many exist.
export async function GET(req: Request) {
  const user = await requireCallUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!sbConfigured()) {
    return NextResponse.json(
      { error: "call room not configured: OS_SUPABASE_URL / OS_SUPABASE_SERVICE_KEY missing" },
      { status: 503 }
    );
  }

  const url = new URL(req.url);
  const status = url.searchParams.get("status");
  const q = (url.searchParams.get("q") ?? "").trim();

  const limitRaw = Number(url.searchParams.get("limit") ?? 100);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.trunc(limitRaw), 1), 500) : 100;
  const offsetRaw = Number(url.searchParams.get("offset") ?? 0);
  const offset = Number.isFinite(offsetRaw) ? Math.max(Math.trunc(offsetRaw), 0) : 0;

  // Base filters shared by the row query and every count query, so the counts
  // describe exactly the population the caller is looking at.
  const base: string[] = [];

  // Leads that failed the quality audit (excluded=true, with excluded_reason)
  // are NEVER dialable and must not reach the dial list -- not merely be hidden
  // by the client. The Sources screen asks for them explicitly with
  // ?includeExcluded=1 to show WHY they were cut.
  const includeExcluded = url.searchParams.get("includeExcluded") === "1";
  if (!includeExcluded) base.push("excluded=is.false");

  // Assignment filter. Everyone can still see everything -- this narrows the
  // view, it never walls anything off. "unassigned" means no email on the row.
  const assigned = url.searchParams.get("assigned");
  if (assigned && assigned !== "all") {
    base.push(
      assigned === "unassigned"
        ? "assigned_to_email=is.null"
        : `assigned_to_email=eq.${encodeURIComponent(assigned.toLowerCase())}`
    );
  }
  // Buy-likelihood tier filter. The column name is discovered, never assumed,
  // and the clause is only added when the column really exists -- otherwise a
  // caller tapping a stale pill would 400 the whole list.
  const tierName = await tierColumn();
  const tier = url.searchParams.get("tier");
  const baseBeforeTier = [...base];
  if (tierName && tier && tier !== "all") {
    base.push(`${tierName}=ilike.${encodeURIComponent(tier)}`);
  }

  if (q) {
    const safe = q.replace(/[(),*]/g, " ").trim();
    if (safe) {
      const pat = `*${safe}*`;
      const clause = `or=(company.ilike.${encodeURIComponent(pat)},contact_name.ilike.${encodeURIComponent(
        pat
      )},city.ilike.${encodeURIComponent(pat)},vertical.ilike.${encodeURIComponent(pat)})`;
      base.push(clause);
      baseBeforeTier.push(clause);
    }
  }

  const statusPart =
    status && status !== "all" ? [`status=eq.${encodeURIComponent(status)}`] : [];

  const rowParts = [
    "select=*",
    "order=score.desc,company.asc",
    `limit=${limit}`,
    `offset=${offset}`,
    ...base,
    ...statusPart,
  ];

  // Rows, per-status counts, and the total for the current query all run in
  // parallel. Counts are computed with count=exact HEAD requests against the
  // full table, so they are true regardless of the page size.
  const [rows, total, ...allCounts] = await Promise.all([
    sbGet<Lead>("call_leads", rowParts.join("&")),
    sbCount("call_leads", ["select=id", ...base, ...statusPart].join("&")),
    ...STATUSES.map((s) =>
      sbCount("call_leads", ["select=id", ...base, `status=eq.${s}`].join("&"))
    ),
    // Tier counts describe the current status/sheet/search view but ignore the
    // tier filter itself, so the pills never zero each other out.
    ...(tierName
      ? TIER_VALUES.map((t) =>
          sbCount(
            "call_leads",
            ["select=id", ...baseBeforeTier, ...statusPart, `${tierName}=ilike.${t}`].join("&")
          )
        )
      : []),
  ]);
  const statusCounts = allCounts.slice(0, STATUSES.length);
  const tierCountsRaw = allCounts.slice(STATUSES.length);
  if (rows === null) {
    return NextResponse.json({ error: "could not read leads" }, { status: 502 });
  }

  const counts: Record<string, number> = {};
  STATUSES.forEach((s, i) => {
    const n = statusCounts[i];
    if (n !== null) counts[s] = n;
  });

  // Resolve claims. A claim older than CLAIM_MINUTES is treated as expired here
  // (and swept on the next claim attempt) so a stale lock never hides a lead.
  const cutoff = Date.now() - CLAIM_MINUTES * 60_000;
  const leads = rows.map((r) => {
    const claimedAt = r.claimed_at ? Date.parse(r.claimed_at) : 0;
    const live = Boolean(r.claimed_by) && claimedAt > cutoff;
    return {
      ...r,
      claim: !live ? "free" : r.claimed_by === user.id ? "mine" : "taken",
    };
  });

  // Distinct sheet owners present in the room, queried unfiltered so the pills
  // do not vanish when a filter is active. Never hardcoded names.
  const assignedRows = await sbGet<{ assigned_to_email: string | null }>(
    "call_leads",
    "select=assigned_to_email&assigned_to_email=not.is.null&excluded=is.false&limit=2000"
  );
  const assignedEmails = Array.from(
    new Set((assignedRows ?? []).map((r) => (r.assigned_to_email ?? "").toLowerCase()).filter(Boolean))
  ).sort();

  // Counts are published whenever the column exists, zeroes included. The UI
  // hides the pills while every count is zero, but it still needs the numbers
  // to know that -- and a caller who arrives on a ?tier= link that matches
  // nothing must still be shown a pill that clears it.
  const tierCounts: Record<string, number> = {};
  if (tierName) {
    TIER_VALUES.forEach((t, i) => {
      const n = tierCountsRaw[i];
      if (n !== null && n !== undefined) tierCounts[t] = n;
    });
  }

  const trueTotal = total ?? offset + rows.length;
  return NextResponse.json({
    leads,
    counts,
    total: trueTotal,
    hasMore: offset + rows.length < trueTotal,
    limit,
    offset,
    assignedEmails,
    tierField: tierName,
    tierCounts,
    me: { email: user.email, role: user.role, isAdmin: user.isAdmin },
  });
}
