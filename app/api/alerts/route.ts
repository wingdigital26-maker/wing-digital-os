import { NextResponse } from "next/server";
import { sbSelectStrict } from "@/lib/osSupabase";

export const runtime = "nodejs";

// The "why was I notified" feed: open + recently resolved watchdog alerts and
// current heartbeats, straight from the same tables the phone pushes come from.
// Session-gated by middleware like every other /api route.
//
// HONESTY RULE: if Supabase cannot be read, this route must NOT return an
// empty list (which renders as "all clear"). It returns available:false with
// the real reason so the UI can show the source as down.
export async function GET() {
  const [alertsRes, beatsRes] = await Promise.all([
    sbSelectStrict({
      table: "watchdog_alerts",
      service: true,
      query: "order=last_seen.desc&limit=25",
    }),
    sbSelectStrict({
      table: "agent_heartbeats",
      service: true,
      query: "order=last_beat.desc",
    }),
  ]);

  if (!alertsRes.ok || !beatsRes.ok) {
    const reason = !alertsRes.ok
      ? alertsRes.error
      : (beatsRes as { ok: false; error: string }).error;
    return NextResponse.json({ available: false, reason, alerts: [], heartbeats: [] });
  }

  return NextResponse.json({ available: true, alerts: alertsRes.rows, heartbeats: beatsRes.rows });
}
