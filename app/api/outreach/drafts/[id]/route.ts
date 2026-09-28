import { NextRequest, NextResponse } from "next/server";
import { outreachStore, storeFailure } from "@/lib/outreach/store";
import { staffActor } from "@/lib/outreach/auth";
import type { DraftStep } from "@/lib/outreach/types";

// PATCH /api/outreach/drafts/:id   Staff only.
//   { action: "edit", steps: [{step, subject, body}] }   pending drafts only
//   { action: "approve", reason? }                       reason required when QA failed
//   { action: "reject", reason? }
//   { action: "reopen" }                                 back to pending (not once handed to the sender)
// Approving only flips the status and records who and when. Nothing is sent
// or pushed from here.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const actor = await staffActor();
  if (!actor) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const choice = outreachStore();
  if (!choice.store) return NextResponse.json({ ok: false, reason: choice.reason }, { status: 503 });
  const { id: raw } = await ctx.params;
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ ok: false, reason: "Bad draft id." }, { status: 400 });

  let body: { action?: string; steps?: DraftStep[]; reason?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, reason: "Body must be JSON." }, { status: 400 });
  }
  const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 500) || null : null;

  try {
    const s = choice.store;
    let draft;
    switch (body.action) {
      case "edit":
        draft = await s.editDraft(id, Array.isArray(body.steps) ? body.steps : [], actor);
        break;
      case "approve":
        draft = await s.setApproval(id, "approved", actor, reason);
        break;
      case "reject":
        draft = await s.setApproval(id, "rejected", actor, reason);
        break;
      case "reopen":
        draft = await s.setApproval(id, "pending", actor, null);
        break;
      default:
        return NextResponse.json({ ok: false, reason: "Unknown action." }, { status: 400 });
    }
    return NextResponse.json({ ok: true, draft });
  } catch (e) {
    const f = storeFailure(e);
    return NextResponse.json({ ok: false, reason: f.message }, { status: f.status });
  }
}
