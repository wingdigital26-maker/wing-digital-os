import { NextResponse } from "next/server";

// ───────────────────────────────────────────────────────────────────────────
// Sonar API — the free social + web lead engine's queue, surfaced in the OS.
//
// Unlike /api/prospects (which shells out to python against a local sqlite db),
// Sonar's data lives in Supabase, so this works with Jack's PC off. No isCloud()
// guard is needed: the same fetch runs locally and on Vercel.
//
// NOTE this is a DIFFERENT Supabase project from the OS one. Sonar writes to the
// Prowl project, so it needs its own credentials rather than OS_SUPABASE_*:
//   SONAR_SUPABASE_URL
//   SONAR_SUPABASE_SERVICE_KEY
// Without them the route degrades to a "not configured" body instead of 500ing,
// matching how the other data routes fail soft.
// ───────────────────────────────────────────────────────────────────────────

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TABLE = "candidates";

function creds() {
  return {
    url: process.env.SONAR_SUPABASE_URL,
    key: process.env.SONAR_SUPABASE_SERVICE_KEY,
  };
}

type Lead = {
  id: number;
  title: string | null;
  place_name: string | null;
  category: string | null;
  source: string | null;
  url: string | null;
  website: string | null;
  phone: string | null;
  need_score: number | null;
  gmb_rating: number | null;
  gmb_reviews: number | null;
  seo_rank: number | null;
  audit_gaps: string[] | null;
  draft_reply: string | null;
  status: string | null;
  discovered_at: string | null;
};

async function sb(path: string, extraHeaders: Record<string, string> = {}) {
  const { url, key } = creds();
  const res = await fetch(`${url}/rest/v1/${path}`, {
    headers: {
      apikey: key as string,
      Authorization: `Bearer ${key}`,
      ...extraHeaders,
    },
    cache: "no-store",
  });
  return res;
}

// Total row count without pulling the rows: PostgREST reports it in
// content-range when asked for an exact count over a single-row window.
async function countWhere(filter: string): Promise<number> {
  const res = await sb(`${TABLE}?${filter}&select=id`, {
    Prefer: "count=exact",
    Range: "0-0",
  });
  const cr = res.headers.get("content-range") || "";
  const total = Number(cr.split("/").pop());
  return Number.isFinite(total) ? total : 0;
}

export async function GET(req: Request) {
  const { url, key } = creds();
  if (!url || !key) {
    return NextResponse.json({
      configured: false,
      error:
        "Sonar Supabase credentials are not set. Add SONAR_SUPABASE_URL and SONAR_SUPABASE_SERVICE_KEY.",
      totals: null,
      leads: [],
    });
  }

  const { searchParams } = new URL(req.url);
  const limit = Math.min(Number(searchParams.get("limit") || 40), 200);
  // Default to showing ONLY identity-verified businesses. A fact-check of the
  // raw table found 63% junk — wrong-state companies, lead-gen doorway shells,
  // and LinkedIn person profiles. identity_gate.py classifies every row; a
  // call list must never default to the unfiltered pile.
  const identity = searchParams.get("identity") ?? "verified";
  const minNeed = searchParams.get("minNeed") || "0.6";
  const city = searchParams.get("city") || "";

  try {
    const [total, awaiting, highNeed, verified, unresolved, outOfRegion,
           notABusiness, unaudited, withPhone, approved] =
      await Promise.all([
        countWhere("id=gt.0"),
        countWhere("status=eq.new"),
        countWhere("need_score=gte.0.7"),
        countWhere("identity=eq.verified"),
        countWhere("identity=eq.unresolved"),
        countWhere("identity=eq.out_of_region"),
        countWhere("identity=eq.not_a_business"),
        countWhere("audited_at=is.null"),
        countWhere("phone=not.is.null"),
        countWhere("status=eq.approved"),
      ]);

    // The working list: audited businesses worth a call, best first. People
    // (LinkedIn profiles) carry a null need_score by design and are excluded.
    const filters = [
      "status=eq.new",
      identity === "all" ? "" : `identity=eq.${encodeURIComponent(identity)}`,
      `need_score=gte.${encodeURIComponent(minNeed)}`,
      city ? `place_name=eq.${encodeURIComponent(city)}` : "",
      "order=need_score.desc.nullslast",
      `limit=${limit}`,
      "select=id,title,place_name,category,source,url,website,phone,need_score," +
        "gmb_rating,gmb_reviews,seo_rank,audit_gaps,draft_reply,status,discovered_at",
    ]
      .filter(Boolean)
      .join("&");

    const res = await sb(`${TABLE}?${filters}`);
    if (!res.ok) {
      return NextResponse.json(
        { configured: true, error: `Supabase ${res.status}`, totals: null, leads: [] },
        { status: 200 }
      );
    }
    const leads = (await res.json()) as Lead[];

    // Cities present in the working list, so the UI can offer a real filter
    // rather than a hardcoded list that drifts from the data.
    const cities = Array.from(
      new Set(leads.map((l) => l.place_name).filter(Boolean) as string[])
    ).sort();

    return NextResponse.json({
      configured: true,
      totals: { total, awaiting, highNeed, unaudited, withPhone, approved,
                verified, unresolved, outOfRegion, notABusiness },
      identityFilter: identity,
      cities,
      leads,
      fetchedAt: new Date().toISOString(),
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { configured: true, error: message, totals: null, leads: [] },
      { status: 200 }
    );
  }
}

// Approve or skip a lead straight from the OS. Mirrors queue/serve.py so both
// front ends drive the same rows. Nothing here sends a message.
export async function POST(req: Request) {
  const { url, key } = creds();
  if (!url || !key) {
    return NextResponse.json({ ok: false, error: "Sonar not configured" }, { status: 200 });
  }
  const body = await req.json().catch(() => ({}));
  const { id, action } = body as { id?: number; action?: string };
  const patch: Record<string, string> | null =
    action === "approve"
      ? { status: "approved" }
      : action === "reject"
      ? { status: "rejected" }
      : null;
  if (!id || !patch) {
    return NextResponse.json({ ok: false, error: "bad request" }, { status: 400 });
  }
  const res = await fetch(`${url}/rest/v1/${TABLE}?id=eq.${id}`, {
    method: "PATCH",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify(patch),
  });
  return NextResponse.json({ ok: res.ok });
}
