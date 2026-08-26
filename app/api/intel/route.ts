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

export async function GET(req: Request) {
  const { url, key } = creds();
  if (!url || !key) {
    return NextResponse.json({ configured: false, sources: [], items: [] });
  }
  const { searchParams } = new URL(req.url);
  const status = searchParams.get("status") || "";
  const source = searchParams.get("source") || "";

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

    return NextResponse.json({
      configured: true,
      sources: sources.map((s) => ({ ...s, count: bySource[s.handle] || 0 })),
      items,
      totals,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ configured: true, error: msg, sources: [], items: [] });
  }
}

// Mark an item reviewed / actioned / ignored, or save a human-written takeaway.
export async function POST(req: Request) {
  const { url, key } = creds();
  if (!url || !key) return NextResponse.json({ ok: false, error: "not configured" });
  const b = await req.json().catch(() => ({}));
  const { id, action, takeaway } = b as { id?: number; action?: string; takeaway?: string };

  if (!id) return NextResponse.json({ ok: false, error: "bad request" }, { status: 400 });

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
