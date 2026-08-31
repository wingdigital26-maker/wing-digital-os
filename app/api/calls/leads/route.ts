import { NextResponse } from "next/server";
import { requireCallUser, sbConfigured, sbGet, CLAIM_MINUTES } from "../_guard";

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
};

// GET /api/calls/leads
//   ?status=new|contacted|callback|booked|...   (optional filter)
//   ?q=search text                              (company / contact / city)
// Returns every lead in the room, best-scoring first, with each lead's claim
// resolved to "free | mine | someone else" so the UI never has to guess.
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

  const parts = ["select=*", "order=score.desc,company.asc", "limit=500"];

  // Leads that failed the quality audit (excluded=true, with excluded_reason)
  // are NEVER dialable and must not reach the dial list -- not merely be hidden
  // by the client, which would still ship 35 rejected businesses over the wire
  // and skew every count computed here. The Sources screen asks for them
  // explicitly with ?includeExcluded=1 to show WHY they were cut.
  const includeExcluded = url.searchParams.get("includeExcluded") === "1";
  if (!includeExcluded) parts.push("excluded=is.false");

  if (status && status !== "all") parts.push(`status=eq.${encodeURIComponent(status)}`);
  if (q) {
    const safe = q.replace(/[(),*]/g, " ").trim();
    if (safe) {
      const pat = `*${safe}*`;
      parts.push(
        `or=(company.ilike.${encodeURIComponent(pat)},contact_name.ilike.${encodeURIComponent(
          pat
        )},city.ilike.${encodeURIComponent(pat)},vertical.ilike.${encodeURIComponent(pat)})`
      );
    }
  }

  const rows = await sbGet<Lead>("call_leads", parts.join("&"));
  if (rows === null) {
    return NextResponse.json({ error: "could not read leads" }, { status: 502 });
  }

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

  const counts: Record<string, number> = {};
  for (const l of rows) counts[l.status] = (counts[l.status] ?? 0) + 1;

  return NextResponse.json({
    leads,
    counts,
    total: rows.length,
    me: { email: user.email, role: user.role, isAdmin: user.isAdmin },
  });
}
