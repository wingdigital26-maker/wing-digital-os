import { NextResponse } from "next/server";
import { outreachStore, storeFailure } from "@/lib/outreach/store";
import { staffActor } from "@/lib/outreach/auth";
import { runInstantlySync } from "@/lib/outreach/sync";

// POST /api/outreach/sync: the "Sync now" button on /outreach. Staff only.
// Same read-only Instantly pull the 15-minute job runs (/api/cron/outreach-sync).

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST() {
  if (!(await staffActor())) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const choice = outreachStore();
  if (!choice.store) return NextResponse.json({ ok: false, reason: choice.reason }, { status: 503 });
  try {
    const summary = await runInstantlySync(choice.store);
    return NextResponse.json({ ok: summary.ok, summary });
  } catch (e) {
    const f = storeFailure(e);
    return NextResponse.json({ ok: false, reason: f.message }, { status: f.status });
  }
}
