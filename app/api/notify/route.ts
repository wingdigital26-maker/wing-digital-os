import { NextRequest, NextResponse } from "next/server";
import { sbUrl, sbService, sbSelect } from "@/lib/osSupabase";
import { pushToAll } from "@/lib/push";

export const runtime = "nodejs";

// Agent result ingest. Scheduled Claude Code agents POST { agent, title, body?,
// url?, level?, tag? } with header x-heartbeat-key so their results land in the
// OS phone app instead of dying in a Claude session. Every call writes an
// os_feed row; level "push" also fires a web push to every subscribed device.
// Same key + fail-closed behavior as /api/heartbeat: no HEARTBEAT_KEY, no ingest.
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
  if (!b?.title || typeof b.title !== "string")
    return NextResponse.json({ error: "title required" }, { status: 400 });

  const title = b.title.slice(0, 120);
  const body = typeof b.body === "string" ? b.body.slice(0, 500) : null;
  const link = typeof b.url === "string" ? b.url.slice(0, 300) : null;
  const level = b.level === "push" ? "push" : "feed";

  const r = await fetch(`${url}/rest/v1/os_feed`, {
    method: "POST",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ agent: b.agent.slice(0, 80), title, body, url: link, level }),
  });
  if (!r.ok) return NextResponse.json({ error: "feed write failed" }, { status: 500 });

  let pushed = 0;
  if (level === "push") {
    const res = await pushToAll({
      title,
      body: body ?? undefined,
      url: link ?? "/mission",
      tag: typeof b.tag === "string" ? b.tag.slice(0, 80) : `notify:${b.agent}`,
    });
    pushed = res.sent;
  }
  return NextResponse.json({ ok: true, feed: true, pushed });
}

// Recent feed read (also key-gated so the endpoint stays machine-only; the OS
// UI reads os_feed through its own session-gated /api/mission route).
export async function GET(req: NextRequest) {
  if (!keyOk(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const rows = await sbSelect({
    table: "os_feed",
    service: true,
    query: "order=created_at.desc&limit=50",
  });
  return NextResponse.json({ feed: rows });
}
