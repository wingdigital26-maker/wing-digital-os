import { NextResponse } from "next/server";
import {
  requireStaff,
  isAuthFailure,
  errorResponse,
  badRequest,
  nullableText,
  sbGet,
  sbPatch,
} from "@/app/api/pipeline/_lib";
import { emitEvent } from "@/lib/automations/emit";
import { processEvents } from "@/lib/automations/engine";
import type { WorkflowRow, WorkflowRunRow } from "@/lib/automations/types";

// ───────────────────────────────────────────────────────────────────────────
// POST /api/automations/run: run a workflow by hand, or re-process an event.
//
//   { workflow_id, contact_id }  emits a manual.trigger event for that contact,
//                                scoped to the workflow's client, naming the
//                                workflow in the payload so ONLY it fires.
//                                Works on draft workflows too (that is how you
//                                test one); the send gate still requires active.
//   { event_id }                 clears processed_at on one event and runs the
//                                engine on it again. Workflows that already
//                                ran for that event are skipped (UNIQUE), so
//                                this only fires workflows added since, or ones
//                                whose run row was deleted on purpose.
//
// Staff only. Returns the run rows the call produced.
// ───────────────────────────────────────────────────────────────────────────

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function runsForEvent(eventId: number): Promise<WorkflowRunRow[]> {
  return sbGet<WorkflowRunRow>("workflow_runs", "*", `event_id=eq.${eventId}&order=started_at.asc`);
}

export async function POST(req: Request) {
  const auth = await requireStaff();
  if (isAuthFailure(auth)) return auth;
  try {
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return badRequest("Body must be JSON.");

    // Re-process one event.
    if (body.event_id !== undefined) {
      const eventId = Number(body.event_id);
      if (!Number.isInteger(eventId) || eventId <= 0) return badRequest("event_id must be a positive integer.");
      const cleared = await sbPatch<{ id: number }>("events", `id=eq.${eventId}`, { processed_at: null });
      if (!cleared.length) return NextResponse.json({ error: "not_found", message: `No event #${eventId}.` }, { status: 404 });
      const summary = await processEvents({ limit: 1, onlyEventId: eventId });
      return NextResponse.json({ ok: summary.errors.length === 0, event_id: eventId, summary, runs: await runsForEvent(eventId) });
    }

    // Manual trigger.
    const workflowId = nullableText(body.workflow_id);
    const contactId = Number(body.contact_id);
    if (!workflowId) return badRequest("workflow_id is required.");
    if (!Number.isInteger(contactId) || contactId <= 0) return badRequest("contact_id must be an existing contact id.");

    const wf = (await sbGet<WorkflowRow>("workflows", "*", `id=eq.${encodeURIComponent(workflowId)}`))[0];
    if (!wf) return NextResponse.json({ error: "not_found", message: "No such workflow." }, { status: 404 });
    const contact = (await sbGet<{ id: number }>("crm_contacts", "id", `id=eq.${contactId}`))[0];
    if (!contact) return badRequest(`No contact with id ${contactId}.`);

    const emitted = await emitEvent({
      type: "manual.trigger",
      client_slug: wf.client_slug,
      contact_id: contactId,
      payload: { workflow_id: wf.id, triggered_by: auth.email },
    });
    if (emitted.id == null) {
      return NextResponse.json({ error: "emit_failed", message: emitted.error }, { status: 502 });
    }
    const runs = await runsForEvent(emitted.id);
    return NextResponse.json({
      ok: !emitted.error,
      event_id: emitted.id,
      summary: emitted.processed ?? null,
      warning: emitted.error,
      run: runs[0] ?? null,
      runs,
    });
  } catch (e) {
    return errorResponse(e);
  }
}
