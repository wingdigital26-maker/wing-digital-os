import { NextResponse } from "next/server";
import { sbSelect } from "@/lib/osSupabase";

export const runtime = "nodejs";

// The "why was I notified" feed: open + recently resolved watchdog alerts and
// current heartbeats, straight from the same tables the phone pushes come from.
// Session-gated by middleware like every other /api route.
export async function GET() {
  const [alerts, beats] = await Promise.all([
    sbSelect({
      table: "watchdog_alerts",
      service: true,
      query: "order=last_seen.desc&limit=25",
    }),
    sbSelect({
      table: "agent_heartbeats",
      service: true,
      query: "order=last_beat.desc",
    }),
  ]);
  return NextResponse.json({ alerts, heartbeats: beats });
}
