import { NextRequest, NextResponse } from "next/server";
import { sbUrl, sbService, sbSelect } from "@/lib/osSupabase";

export const runtime = "nodejs";

// Heartbeat ingest for the 24/7 watchdog. The PC (and any cloud job) POSTs
// { agent, status?, message?, meta? } with header x-heartbeat-key. The cron
// watchdog then alerts when an expected heartbeat goes stale or reports error.
// Fails closed: no HEARTBEAT_KEY configured means no ingest.
function keyOk(req: NextRequest): boolean {
  const expected = process.env.HEARTBEAT_KEY;
  return Boolean(expected) && req.headers.get("x-heartbeat-key") === expected;
}

export async function POST(req: NextRequest) {
  if (!keyOk(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const url = sbUrl();
  const key = sbService();
  if (!url || !key) return NextResponse.json({ error: "supabase not configured" }, { status: 503 });
  const b = await req.json().catch(() => null);
  if (!b?.agent || typeof b.agent !== "string")
    return NextResponse.json({ error: "agent required" }, { status: 400 });
  // Optional run metadata folded into meta: files_changed count + short file
  // list. Only stored when reported, so the UI can stay honest (nothing ≠ 0).
  let meta = b.meta && typeof b.meta === "object" ? { ...b.meta } : null;
  const fc = Number(b.files_changed);
  if (b.files_changed != null && Number.isFinite(fc) && fc >= 0) {
    meta = { ...(meta ?? {}), files_changed: Math.min(Math.floor(fc), 100000), files_changed_at: new Date().toISOString() };
  }
  if (Array.isArray(b.files)) {
    const files = b.files
      .filter((f: unknown) => typeof f === "string" && (f as string).trim())
      .slice(0, 25)
      .map((f: string) => f.slice(0, 300));
    if (files.length) meta = { ...(meta ?? {}), files };
  }
  const r = await fetch(`${url}/rest/v1/agent_heartbeats?on_conflict=agent`, {
    method: "POST",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates",
    },
    body: JSON.stringify({
      agent: b.agent,
      status: b.status === "error" || b.status === "disabled" ? b.status : "ok",
      message: typeof b.message === "string" ? b.message.slice(0, 500) : null,
      meta,
      last_beat: new Date().toISOString(),
    }),
  });
  return NextResponse.json({ ok: r.ok }, { status: r.ok ? 200 : 500 });
}

// Dashboard read of current heartbeats (also key-gated so the endpoint stays
// machine-only; the OS UI calls it through its own session-gated routes).
export async function GET(req: NextRequest) {
  if (!keyOk(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const rows = await sbSelect({ table: "agent_heartbeats", service: true, query: "order=last_beat.desc" });
  return NextResponse.json({ heartbeats: rows });
}
