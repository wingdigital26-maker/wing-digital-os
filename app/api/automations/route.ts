import { NextResponse } from "next/server";
import {
  requireStaff,
  isAuthFailure,
  errorResponse,
  badRequest,
  nullableText,
  sbGet,
  sbPost,
  sbPatch,
  sbDelete,
  isEventType,
  isWorkflowStatus,
  cleanTriggerFilter,
  type WorkflowRow,
  type WorkflowActionRow,
  type WorkflowRunRow,
} from "./_workflows";

// /api/automations: CRUD for workflows themselves. Staff only.
//
//   GET          list every workflow with its action count and the last
//                seven days of runs (done / failed) from workflow_runs
//   POST         create a workflow (always starts as draft)
//   PATCH        rename / describe / change trigger / Activate / Pause
//   DELETE ?id=  delete a workflow (actions + runs cascade in the DB)
//
// Activating a workflow sends nothing by itself. The engine that reads the
// active flag still drafts every text and email unless AUTOMATION_SEND_ENABLED
// is set on the deployment.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await requireStaff();
  if (isAuthFailure(auth)) return auth;
  try {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const [workflows, actions, runs] = await Promise.all([
      sbGet<WorkflowRow>("workflows", "*", "order=created_at.desc"),
      sbGet<Pick<WorkflowActionRow, "workflow_id">>("workflow_actions", "workflow_id"),
      sbGet<Pick<WorkflowRunRow, "workflow_id" | "status">>(
        "workflow_runs",
        "workflow_id,status",
        `started_at=gte.${encodeURIComponent(since)}`
      ),
    ]);
    const actionCount = new Map<string, number>();
    for (const a of actions) actionCount.set(a.workflow_id, (actionCount.get(a.workflow_id) ?? 0) + 1);
    const runCount = new Map<string, { done: number; failed: number; total: number }>();
    for (const r of runs) {
      const c = runCount.get(r.workflow_id) ?? { done: 0, failed: 0, total: 0 };
      c.total += 1;
      if (r.status === "done") c.done += 1;
      if (r.status === "failed") c.failed += 1;
      runCount.set(r.workflow_id, c);
    }
    return NextResponse.json({
      workflows: workflows.map((w) => ({
        ...w,
        actionCount: actionCount.get(w.id) ?? 0,
        runs7d: runCount.get(w.id) ?? { done: 0, failed: 0, total: 0 },
      })),
    });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: Request) {
  const auth = await requireStaff();
  if (isAuthFailure(auth)) return auth;
  try {
    const body = await req.json().catch(() => null);
    const name = nullableText(body?.name);
    if (!name) return badRequest("An automation needs a name.");
    const trigger = nullableText(body?.trigger_type);
    if (!isEventType(trigger)) return badRequest("Pick what should start this automation.");
    const filter = cleanTriggerFilter(body?.trigger_filter);
    if (filter === null) return badRequest("The trigger filter must be a simple set of key: value pairs.");
    const row = await sbPost<WorkflowRow>("workflows", {
      name,
      trigger_type: trigger,
      trigger_filter: filter,
      description: nullableText(body?.description),
      client_slug: nullableText(body?.client_slug),
      status: "draft",
    });
    return NextResponse.json({ workflow: row }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function PATCH(req: Request) {
  const auth = await requireStaff();
  if (isAuthFailure(auth)) return auth;
  try {
    const body = await req.json().catch(() => null);
    const id = nullableText(body?.id);
    if (!id) return badRequest("Missing automation id.");
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };

    if (body?.name !== undefined) {
      const name = nullableText(body.name);
      if (!name) return badRequest("An automation needs a name.");
      patch.name = name;
    }
    if (body?.description !== undefined) patch.description = nullableText(body.description);
    if (body?.client_slug !== undefined) patch.client_slug = nullableText(body.client_slug);
    if (body?.trigger_type !== undefined) {
      const trigger = nullableText(body.trigger_type);
      if (!isEventType(trigger)) return badRequest("That is not a trigger this OS knows about.");
      patch.trigger_type = trigger;
    }
    if (body?.trigger_filter !== undefined) {
      const filter = cleanTriggerFilter(body.trigger_filter);
      if (filter === null) return badRequest("The trigger filter must be a simple set of key: value pairs.");
      patch.trigger_filter = filter;
    }
    if (body?.status !== undefined) {
      const status = nullableText(body.status);
      if (!isWorkflowStatus(status)) return badRequest("Status must be draft, active, or paused.");
      if (status === "active") {
        const actions = await sbGet<Pick<WorkflowActionRow, "id">>(
          "workflow_actions",
          "id",
          `workflow_id=eq.${encodeURIComponent(id)}&limit=1`
        );
        if (!actions.length) return badRequest("Add at least one action first.");
      }
      patch.status = status;
    }
    if (Object.keys(patch).length === 1) return badRequest("Nothing to change.");

    const rows = await sbPatch<WorkflowRow>("workflows", `id=eq.${encodeURIComponent(id)}`, patch);
    if (!rows[0]) return NextResponse.json({ error: "not_found", message: "That automation no longer exists." }, { status: 404 });
    return NextResponse.json({ workflow: rows[0] });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function DELETE(req: Request) {
  const auth = await requireStaff();
  if (isAuthFailure(auth)) return auth;
  try {
    const id = new URL(req.url).searchParams.get("id");
    if (!id) return badRequest("Missing automation id.");
    const rows = await sbDelete("workflows", `id=eq.${encodeURIComponent(id)}`);
    if (!rows.length) return NextResponse.json({ error: "not_found", message: "That automation no longer exists." }, { status: 404 });
    return NextResponse.json({ deleted: rows.length });
  } catch (e) {
    return errorResponse(e);
  }
}
