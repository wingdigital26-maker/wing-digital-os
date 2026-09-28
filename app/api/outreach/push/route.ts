import { NextRequest, NextResponse } from "next/server";
import { outreachStore, storeFailure } from "@/lib/outreach/store";
import { pushEnabled, staffActor } from "@/lib/outreach/auth";

// POST /api/outreach/push  { tenant? }   Staff only. OFF unless OUTREACH_PUSH_ENABLED=1.
//
// "Push approved to Instantly" is a separate, explicit step from approving.
// Even when enabled, the OS itself never writes to Instantly: this marks every
// approved, not-yet-handed-over draft as push-requested (who + when). The
// engine on Jack's PC (ghl-cli instantly_sender.py push-queue) reads those from
// GET /api/outreach/approved?requested=1 and does the push under its own
// guards (suppression, do-not-touch campaigns, audit log).

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const actor = await staffActor();
  if (!actor) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!pushEnabled()) {
    return NextResponse.json(
      { ok: false, reason: "Pushing to Instantly is switched off on this deployment (OUTREACH_PUSH_ENABLED is not 1). Approvals are saved; nothing was handed to the sender." },
      { status: 403 }
    );
  }
  const choice = outreachStore();
  if (!choice.store) return NextResponse.json({ ok: false, reason: choice.reason }, { status: 503 });
  let body: { tenant?: string } = {};
  try {
    body = await req.json();
  } catch {
    /* empty body is fine */
  }
  try {
    const requested = await choice.store.requestPush(actor, body.tenant || null);
    return NextResponse.json({ ok: true, requested, by: actor });
  } catch (e) {
    const f = storeFailure(e);
    return NextResponse.json({ ok: false, reason: f.message }, { status: f.status });
  }
}
