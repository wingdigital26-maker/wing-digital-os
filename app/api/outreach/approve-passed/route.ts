import { NextRequest, NextResponse } from "next/server";
import { outreachStore, storeFailure } from "@/lib/outreach/store";
import { staffActor } from "@/lib/outreach/auth";

// POST /api/outreach/approve-passed  { date: "YYYY-MM-DD", tenant? }
// Approves every PENDING draft in that batch whose QA passed and that nobody
// edited (QA passed on the engine's text, so an edit gets its own look).
// QA-failed, edited, rejected and already-decided drafts are left exactly as
// they are. Staff only.
// Approval only flips status; nothing is sent or pushed.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const actor = await staffActor();
  if (!actor) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const choice = outreachStore();
  if (!choice.store) return NextResponse.json({ ok: false, reason: choice.reason }, { status: 503 });
  let body: { date?: string; tenant?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, reason: "Body must be JSON." }, { status: 400 });
  }
  if (!body.date || !/^\d{4}-\d{2}-\d{2}$/.test(body.date)) {
    return NextResponse.json({ ok: false, reason: "Which batch? Send date as YYYY-MM-DD." }, { status: 400 });
  }
  try {
    const approved = await choice.store.approveAllPassed(body.date, body.tenant || null, actor);
    return NextResponse.json({ ok: true, approved, approver: actor });
  } catch (e) {
    const f = storeFailure(e);
    return NextResponse.json({ ok: false, reason: f.message }, { status: f.status });
  }
}
