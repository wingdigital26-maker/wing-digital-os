import { NextRequest, NextResponse } from "next/server";
import { outreachStore, storeFailure } from "@/lib/outreach/store";
import { isMachine, staffActor } from "@/lib/outreach/auth";

// GET /api/outreach/approved?tenant=wing&requested=1
// What the engine on Jack's PC reads back: every approved draft not yet pushed,
// with the exact subject/body a person approved (edits included), the approver
// and the time. requested=1 narrows it to drafts someone explicitly handed to
// the sender with "Push approved to Instantly".
// x-heartbeat-key (the engine) or staff. Read-only.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!isMachine(req) && !(await staffActor())) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const choice = outreachStore();
  if (!choice.store) return NextResponse.json({ ok: false, reason: choice.reason }, { status: 503 });
  const tenant = req.nextUrl.searchParams.get("tenant") || null;
  const requested = req.nextUrl.searchParams.get("requested") === "1";
  try {
    const drafts = await choice.store.listApproved(tenant, requested);
    return NextResponse.json({
      ok: true,
      drafts: drafts.map((d) => ({
        id: d.id,
        tenant: d.tenant,
        leadId: d.leadId,
        batchDate: d.batchDate,
        round: d.round,
        contactEmail: d.contactEmail,
        steps: d.steps,
        edited: Boolean(d.editedAt),
        editedBy: d.editedBy,
        approver: d.approver,
        approvedAt: d.approvedAt,
        approvalNote: d.rejectedReason,
        pushRequestedAt: d.pushRequestedAt,
        pushRequestedBy: d.pushRequestedBy,
      })),
    });
  } catch (e) {
    const f = storeFailure(e);
    return NextResponse.json({ ok: false, reason: f.message }, { status: f.status });
  }
}
