import { NextRequest, NextResponse } from "next/server";
import { outreachStore, storeFailure } from "@/lib/outreach/store";
import { isMachine } from "@/lib/outreach/auth";
import { runInstantlySync } from "@/lib/outreach/sync";

// GET /api/cron/outreach-sync: pull Instantly sends, replies and lead outcomes
// into outreach_events. Every 15 minutes from GitHub Actions
// (.github/workflows/outreach-sync.yml), because Vercel Hobby crons run at
// most once a day. Same auth contract as /api/cron/automations: Bearer
// CRON_SECRET or x-heartbeat-key = HEARTBEAT_KEY; unset secrets fail closed.
//
// READ-ONLY against Instantly (lib/outreach/sync.ts). Idempotent: every event
// carries a dedupe key, so overlapping runs never double count.
// Anything but 200 fails the job so it shows up in the cloud-jobs self-check.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  if (!isMachine(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const choice = outreachStore();
  if (!choice.store) return NextResponse.json({ ok: false, reason: choice.reason }, { status: 503 });
  try {
    const summary = await runInstantlySync(choice.store);
    // A partial run (one stream failed) still wrote what it could; report it
    // as 502 so the job goes red and someone looks.
    return NextResponse.json({ ok: summary.ok, summary }, { status: summary.ok ? 200 : 502 });
  } catch (e) {
    const f = storeFailure(e);
    return NextResponse.json({ ok: false, reason: f.message }, { status: f.status });
  }
}
