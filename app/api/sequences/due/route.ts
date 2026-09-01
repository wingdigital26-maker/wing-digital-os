import { NextResponse } from "next/server";
import {
  errorResponse,
  badRequest,
  nullableText,
  sbGet,
  sbPatch,
  exportKeyOk,
  renderMergeTags,
  dueDateFrom,
  type StepRow,
  type EnrollmentRow,
} from "../_lib";

// ───────────────────────────────────────────────────────────────────────────
// /api/sequences/due — the MACHINE endpoint. The external sender (separate
// repo, see docs/SEQUENCES-CONTRACT.md) polls GET for enrollments whose next
// step is due, sends the mail itself, then POSTs back per send so the OS can
// advance the enrollment. The OS NEVER sends — this route only reads state
// and records what the sender reports.
//
// Auth: Authorization: Bearer <OUTBOUND_EXPORT_KEY> (or ?k=), fail-closed,
// same key and same shape as /api/outbound/export.
//
// GET returns only enrollments where ALL of:
//   * enrollment.status = 'active'
//   * enrollment.next_send_at <= now
//   * the parent sequence.status = 'active'  (paused/draft sequences export nothing)
//
// POST { enrollment_id, sent_at? } advances the state machine:
//   current_step += 1
//   next step exists  → next_send_at = sent_at + that step's wait_days
//   no next step      → status = 'completed', next_send_at = null
// ───────────────────────────────────────────────────────────────────────────

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type DueEnrollment = EnrollmentRow & {
  sequences: { id: string; name: string; status: string; client_slug: string | null };
};

export async function GET(req: Request) {
  if (!exportKeyOk(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const nowIso = new Date().toISOString();
    const rows = await sbGet<DueEnrollment>(
      "sequence_enrollments",
      "*,sequences!inner(id,name,status,client_slug)",
      `status=eq.active&next_send_at=lte.${encodeURIComponent(nowIso)}` +
        `&sequences.status=eq.active&order=next_send_at.asc&limit=200`
    );

    if (!rows.length) {
      return NextResponse.json({ count: 0, generated_at: nowIso, items: [], anomalies: [] });
    }

    const seqIds = Array.from(new Set(rows.map((r) => r.sequence_id)));
    const steps = await sbGet<StepRow>(
      "sequence_steps",
      "*",
      `sequence_id=in.(${seqIds.join(",")})&order=step_order.asc`
    );
    const stepByKey = new Map<string, StepRow>();
    for (const s of steps) stepByKey.set(`${s.sequence_id}:${s.step_order}`, s);

    const items: unknown[] = [];
    const anomalies: unknown[] = [];
    for (const en of rows) {
      const dueStep = stepByKey.get(`${en.sequence_id}:${en.current_step + 1}`);
      if (!dueStep) {
        // Due with no matching step (steps were deleted after enrollment).
        // Never invent a message; report it so a human can resolve the row.
        anomalies.push({
          enrollment_id: en.id,
          email: en.email,
          sequence: en.sequences.name,
          problem: `Due at step ${en.current_step + 1} but the sequence has no step ${en.current_step + 1}. POST this enrollment_id to mark it completed, or fix the steps.`,
        });
        continue;
      }
      const subject = renderMergeTags(dueStep.subject ?? "", en);
      const body = renderMergeTags(dueStep.body, en);
      const unresolved = Array.from(new Set([...subject.unresolved, ...body.unresolved]));
      items.push({
        enrollment_id: en.id,
        sequence_id: en.sequence_id,
        sequence: en.sequences.name,
        client_slug: en.sequences.client_slug,
        step_order: dueStep.step_order,
        channel: dueStep.channel,
        to: en.email,
        name: en.name,
        company: en.company,
        subject: subject.text,
        body: body.text,
        due_at: en.next_send_at,
        // Non-empty means the row is NOT safe to send as-is: a merge tag had
        // no data (e.g. {{company}} with no company on file). Hold it.
        unresolved_tags: unresolved,
      });
    }

    return NextResponse.json({ count: items.length, generated_at: nowIso, items, anomalies });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: Request) {
  if (!exportKeyOk(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const body = await req.json().catch(() => null);
    const id = nullableText(body?.enrollment_id);
    if (!id) return badRequest("Missing enrollment_id.");
    const sentAtRaw = nullableText(body?.sent_at);
    const sentAt = sentAtRaw ? new Date(sentAtRaw) : new Date();
    if (Number.isNaN(sentAt.getTime())) return badRequest("sent_at is not a valid timestamp.");

    const found = await sbGet<EnrollmentRow>("sequence_enrollments", "*", `id=eq.${encodeURIComponent(id)}`);
    const en = found[0];
    if (!en) return NextResponse.json({ error: "not_found" }, { status: 404 });
    if (en.status !== "active") {
      return badRequest(`This enrollment is ${en.status}, not active; refusing to advance it.`);
    }

    const completedStep = en.current_step + 1;
    const nextSteps = await sbGet<StepRow>(
      "sequence_steps",
      "*",
      `sequence_id=eq.${en.sequence_id}&step_order=eq.${completedStep + 1}`
    );
    const next = nextSteps[0] ?? null;

    const patch: Record<string, unknown> = {
      current_step: completedStep,
      updated_at: new Date().toISOString(),
      ...(next
        ? { next_send_at: dueDateFrom(sentAt, next.wait_days) }
        : { status: "completed", next_send_at: null }),
    };
    const rows = await sbPatch<EnrollmentRow>("sequence_enrollments", `id=eq.${en.id}`, patch);
    const updated = rows[0];
    return NextResponse.json({
      enrollment_id: updated.id,
      current_step: updated.current_step,
      status: updated.status,
      next_send_at: updated.next_send_at,
      done: updated.status === "completed",
    });
  } catch (e) {
    return errorResponse(e);
  }
}
