import { NextRequest, NextResponse } from "next/server";
import { sbUrl, sbService } from "@/lib/osSupabase";

export const runtime = "nodejs";

// Save (POST) or remove (DELETE) a browser push subscription. Reached only by
// logged-in devices — middleware gates /api/* behind the OS session cookies.
export async function POST(req: NextRequest) {
  const url = sbUrl();
  const key = sbService();
  if (!url || !key) return NextResponse.json({ error: "supabase not configured" }, { status: 503 });
  const sub = await req.json().catch(() => null);
  if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth)
    return NextResponse.json({ error: "bad subscription" }, { status: 400 });
  const r = await fetch(`${url}/rest/v1/push_subscriptions?on_conflict=endpoint`, {
    method: "POST",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates",
    },
    body: JSON.stringify({
      endpoint: sub.endpoint,
      p256dh: sub.keys.p256dh,
      auth: sub.keys.auth,
      user_agent: req.headers.get("user-agent") ?? undefined,
    }),
  });
  return NextResponse.json({ ok: r.ok }, { status: r.ok ? 200 : 500 });
}

export async function DELETE(req: NextRequest) {
  const url = sbUrl();
  const key = sbService();
  if (!url || !key) return NextResponse.json({ error: "supabase not configured" }, { status: 503 });
  const { endpoint } = await req.json().catch(() => ({}));
  if (!endpoint) return NextResponse.json({ error: "endpoint required" }, { status: 400 });
  await fetch(`${url}/rest/v1/push_subscriptions?endpoint=eq.${encodeURIComponent(endpoint)}`, {
    method: "DELETE",
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  return NextResponse.json({ ok: true });
}
