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
};

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
  if (q) {
    const safe = q.replace(/[(),*]/g, " ").trim();
    if (safe) {
      const pat = `*${safe}*`;
      base.push(
        `or=(company.ilike.${encodeURIComponent(pat)},contact_name.ilike.${encodeURIComponent(
          pat
        )},city.ilike.${encodeURIComponent(pat)},vertical.ilike.${encodeURIComponent(pat)})`
      );
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
  const [rows, total, ...statusCounts] = await Promise.all([
    sbGet<Lead>("call_leads", rowParts.join("&")),
    sbCount("call_leads", ["select=id", ...base, ...statusPart].join("&")),
    ...STATUSES.map((s) =>
      sbCount("call_leads", ["select=id", ...base, `status=eq.${s}`].join("&"))
    ),
  ]);
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

  const trueTotal = total ?? offset + rows.length;
  return NextResponse.json({
    leads,
    counts,
    total: trueTotal,
    hasMore: offset + rows.length < trueTotal,
    limit,
    offset,
    assignedEmails,
    me: { email: user.email, role: user.role, isAdmin: user.isAdmin },
  });
}
