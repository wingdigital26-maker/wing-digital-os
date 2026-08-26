import { NextResponse } from "next/server";

// ───────────────────────────────────────────────────────────────────────────
// Creator / competitor intel API — what the AI builders Wing follows shipped.
//
// Backed by the Sonar Supabase project (SONAR_SUPABASE_*), filled by
// social-scraper-handoff/ingest/intel_watch.py off free YouTube RSS, so it
// works with the PC off. Rows carry only what the feed actually said: a
// title, a date and the creator's own description. `takeaway` stays empty
// until a human writes one — nothing here invents an interpretation.
// ───────────────────────────────────────────────────────────────────────────

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function creds() {
  return {
    url: process.env.SONAR_SUPABASE_URL,
    key: process.env.SONAR_SUPABASE_SERVICE_KEY,
  };
}

async function sb(path: string, extra: Record<string, string> = {}) {
  const { url, key } = creds();
  return fetch(`${url}/rest/v1/${path}`, {
    headers: { apikey: key as string, Authorization: `Bearer ${key}`, ...extra },
    cache: "no-store",
  });
}

type Item = {
  id: number;
  source_handle: string;
  title: string;
  url: string;
  published_at: string | null;
  summary: string | null;
  takeaway: string | null;
  actionable: boolean;
  status: string;
};

type Source = {
  id: number;
  kind: string;
  handle: string;
  name: string | null;
  channel_url: string | null;
  why: string | null;
  active: boolean;
};

// A proposed change to Wing's own systems, derived from one watched video.
// Nothing here is ever applied by this API — `approved` only means a human
// said yes and it is queued for Jack to apply by hand. There is no apply path.
type Proposal = {
  id: number;
  intel_item_id: number | null;
  source_handle: string | null;
  video_title: string | null;
  video_url: string | null;
  title: string;
  rationale: string | null;
  evidence_quote: string | null;
  evidence_ts: string | null;
  target_system: string | null;
  target_paths: string[] | string | null;
  effort: string | null;
  risk: string | null;
  status: string;
  decided_at: string | null;
  applied_at: string | null;
  outcome: string | null;
  created_at: string | null;
};

const PROPOSAL_COLS =
  "id,intel_item_id,source_handle,video_title,video_url,title,rationale," +
  "evidence_quote,evidence_ts,target_system,target_paths,effort,risk,status," +
  "decided_at,applied_at,outcome,created_at";

export async function GET(req: Request) {
  const { url, key } = creds();
  if (!url || !key) {
    return NextResponse.json({
      configured: false,
      sources: [],
      items: [],
      proposals: [],
      proposalTotals: { total: 0, proposed: 0, approved: 0, rejected: 0, applied: 0, failed: 0 },
    });
  }
  const { searchParams } = new URL(req.url);
  const status = searchParams.get("status") || "";
  const source = searchParams.get("source") || "";
  const proposalStatus = searchParams.get("proposalStatus") || "";

  try {
    // Who we watch, and why — the sidebar needs this even before any video lands.
    const srcRes = await sb(
      "intel_sources?select=id,kind,handle,name,channel_url,why,active&order=id"
    );
    const sources: Source[] = srcRes.ok ? await srcRes.json() : [];

    // Counts come off one cheap pull so the filter chips can show real numbers.
    const allRes = await sb(
      "intel_items?select=status,source_handle&limit=5000&order=published_at.desc"
    );
    const all: { status: string; source_handle: string }[] = allRes.ok ? await allRes.json() : [];

    const totals = { total: all.length, new: 0, reviewed: 0, actioned: 0, ignored: 0 };
    const bySource: Record<string, number> = {};
    for (const r of all) {
      if (r.status in totals) (totals as Record<string, number>)[r.status]++;
      bySource[r.source_handle] = (bySource[r.source_handle] || 0) + 1;
    }

    const filters = [
      status ? `status=eq.${encodeURIComponent(status)}` : "",
      source ? `source_handle=eq.${encodeURIComponent(source)}` : "",
      "order=published_at.desc.nullslast",
      "limit=200",
      "select=id,source_handle,title,url,published_at,summary,takeaway,actionable,status",
    ].filter(Boolean).join("&");
    const res = await sb(`intel_items?${filters}`);
    const items: Item[] = res.ok ? await res.json() : [];

    // Proposal counts, same cheap-pull trick as the items above.
    const pAllRes = await sb("intel_proposals?select=status&limit=5000");
    const pAll: { status: string }[] = pAllRes.ok ? await pAllRes.json() : [];
    const proposalTotals = {
      total: pAll.length, proposed: 0, approved: 0, rejected: 0, applied: 0, failed: 0,
    };
    for (const r of pAll) {
      if (r.status in proposalTotals) (proposalTotals as Record<string, number>)[r.status]++;
    }

    const pFilters = [
      proposalStatus ? `status=eq.${encodeURIComponent(proposalStatus)}` : "",
      source ? `source_handle=eq.${encodeURIComponent(source)}` : "",
      "order=created_at.desc.nullslast,id.desc",
      "limit=200",
      `select=${PROPOSAL_COLS}`,
    ].filter(Boolean).join("&");
    const pRes = await sb(`intel_proposals?${pFilters}`);
    const proposals: Proposal[] = pRes.ok ? await pRes.json() : [];

    return NextResponse.json({
      configured: true,
      sources: sources.map((s) => ({ ...s, count: bySource[s.handle] || 0 })),
      items,
      totals,
      proposals,
      proposalTotals,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({
      configured: true, error: msg, sources: [], items: [],
      proposals: [],
      proposalTotals: { total: 0, proposed: 0, approved: 0, rejected: 0, applied: 0, failed: 0 },
    });
  }
}

// Mark an item reviewed / actioned / ignored, or save a human-written takeaway.
export async function POST(req: Request) {
  const { url, key } = creds();
  if (!url || !key) return NextResponse.json({ ok: false, error: "not configured" });
  const b = await req.json().catch(() => ({}));
  const { id, action, takeaway, kind } = b as {
    id?: number; action?: string; takeaway?: string; kind?: string;
  };

  if (!id) return NextResponse.json({ ok: false, error: "bad request" }, { status: 400 });

  // ── Proposal decisions ───────────────────────────────────────────────────
  // Only ever a human decision. "approved" queues the change for Jack to apply
  // himself; this route never applies anything and has no path that could.
  if (kind === "proposal") {
    const pPatch: Record<string, unknown> =
      action === "approve" ? { status: "approved", decided_at: new Date().toISOString() }
      : action === "reject" ? { status: "rejected", decided_at: new Date().toISOString() }
      : action === "undo" ? { status: "proposed", decided_at: null }
      : {};
    if (Object.keys(pPatch).length === 0) {
      return NextResponse.json({ ok: false, error: "unknown action" }, { status: 400 });
    }
    const pRes = await fetch(`${url}/rest/v1/intel_proposals?id=eq.${id}`, {
      method: "PATCH",
      headers: {
        apikey: key, Authorization: `Bearer ${key}`,
        "Content-Type": "application/json", Prefer: "return=representation",
      },
      body: JSON.stringify(pPatch),
    });
    const rows = pRes.ok ? await pRes.json().catch(() => []) : [];
    return NextResponse.json({ ok: pRes.ok, proposal: Array.isArray(rows) ? rows[0] ?? null : null });
  }

  // intel_items has no reviewed_at column — status is the whole state machine.
  const patch: Record<string, unknown> =
    action === "reviewed" ? { status: "reviewed" }
    : action === "actioned" ? { status: "actioned", actionable: true }
    : action === "ignored" ? { status: "ignored" }
    : action === "new" ? { status: "new" }
    : action === "takeaway" ? { takeaway: takeaway ?? "" }
    : {};
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ ok: false, error: "unknown action" }, { status: 400 });
  }
  const res = await fetch(`${url}/rest/v1/intel_items?id=eq.${id}`, {
    method: "PATCH",
    headers: {
      apikey: key, Authorization: `Bearer ${key}`,
      "Content-Type": "application/json", Prefer: "return=minimal",
    },
    body: JSON.stringify(patch),
  });
  return NextResponse.json({ ok: res.ok });
}
