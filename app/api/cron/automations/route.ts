import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { processEvents, failStuckRuns, resumeWaitingRuns } from "@/lib/automations/engine";
import { errorResponse } from "@/app/api/pipeline/_lib";

// ───────────────────────────────────────────────────────────────────────────
// GET /api/cron/automations: the catch-up tick for the automation engine.
//
// Every emitter processes its own event inline (lib/automations/emit.ts), so
// in the normal case this finds nothing to do. It exists for the cases where
// inline processing could not finish: a Twilio webhook that had to answer in
// 4 s, a Vercel function that was killed mid-run, a database blip. It also
// marks runs stuck in "running" for over 10 minutes as failed ("timed out")
// so the board never shows a spinner forever. Then it resumes runs paused on
// a wait step whose resume_at has passed (resumeWaitingRuns); those are
// reported under `resumed` in the JSON. Waits only ever continue from here,
// so this route must run on a schedule for delayed steps to happen.
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

// Constant-time compare over sha256 digests so the length of the secret and
// the position of the first mismatch leak nothing through timing.
function sameSecret(got: string | null, expected: string | undefined): boolean {
  if (!got || !expected) return false;
  const a = crypto.createHash("sha256").update(got).digest();
  const b = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

function authorized(req: NextRequest): boolean {
  const auth = req.headers.get("authorization");
  const bearer = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
  if (sameSecret(bearer, process.env.CRON_SECRET)) return true;
  if (sameSecret(req.headers.get("x-heartbeat-key"), process.env.HEARTBEAT_KEY)) return true;
  return false;
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    const timed_out = await failStuckRuns(10);
    const summary = await processEvents({ limit: 50 });
    const resumed = await resumeWaitingRuns(50);
    return NextResponse.json({
      ok: summary.errors.length === 0 && resumed.errors.length === 0,
      timed_out,
      ...summary,
      resumed,
    });
  } catch (e) {
    return errorResponse(e);
  }
}
