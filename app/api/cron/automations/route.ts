import { NextRequest, NextResponse } from "next/server";
import { processEvents, failStuckRuns } from "@/lib/automations/engine";
import { errorResponse } from "@/app/api/pipeline/_lib";

// ───────────────────────────────────────────────────────────────────────────
// GET /api/cron/automations: the catch-up tick for the automation engine.
//
// Every emitter processes its own event inline (lib/automations/emit.ts), so
// in the normal case this finds nothing to do. It exists for the cases where
// inline processing could not finish: a Twilio webhook that had to answer in
// 4 s, a Vercel function that was killed mid-run, a database blip. It also
// marks runs stuck in "running" for over 10 minutes as failed ("timed out")
// so the board never shows a spinner forever.
//
// AUTH: same contract as /api/cron/watchdog. Bearer CRON_SECRET (Vercel cron
// or GitHub Actions) or x-heartbeat-key = HEARTBEAT_KEY (manual trigger).
// Unset secrets mean nobody is authorized: fails closed.
//
// Idempotent by construction: workflow_runs UNIQUE (workflow_id, event_id).
// ───────────────────────────────────────────────────────────────────────────

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  const hbKey = process.env.HEARTBEAT_KEY;
  const auth = req.headers.get("authorization");
  if (secret && auth === `Bearer ${secret}`) return true;
  if (hbKey && req.headers.get("x-heartbeat-key") === hbKey) return true;
  return false;
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    const timed_out = await failStuckRuns(10);
    const summary = await processEvents({ limit: 50 });
    return NextResponse.json({ ok: summary.errors.length === 0, timed_out, ...summary });
  } catch (e) {
    return errorResponse(e);
  }
}
