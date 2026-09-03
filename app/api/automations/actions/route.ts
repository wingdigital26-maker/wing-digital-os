import { NextResponse } from "next/server";
import { ACTION_DEFS } from "@/lib/automations/types";
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
  isActionType,
  cleanActionConfig,
  type WorkflowActionRow,
} from "../_workflows";

// /api/automations/actions: the ordered steps inside a workflow.
//
//   POST          add an action (appended at the end unless step_order given)
//   PATCH         edit config, or move: "up" | "down", or step_order: <n>
//   DELETE ?id=   remove an action and renumber the rest to 1..N
//
// step_order is 1-based with UNIQUE (workflow_id, step_order), so any reorder
// goes through a temporary negative order instead of colliding.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function renumber(workflowId: string) {
  const rest = await sbGet<WorkflowActionRow>(
    "workflow_actions",
    "*",
    `workflow_id=eq.${encodeURIComponent(workflowId)}&order=step_order.asc`
  );
  for (let i = 0; i < rest.length; i++) {
    if (rest[i].step_order !== i + 1) {
      await sbPatch("workflow_actions", `id=eq.${rest[i].id}`, { step_order: i + 1 });
    }
  }
}

async function swap(a: WorkflowActionRow, b: WorkflowActionRow) {
  await sbPatch("workflow_actions", `id=eq.${a.id}`, { step_order: -1 });
  await sbPatch("workflow_actions", `id=eq.${b.id}`, { step_order: a.step_order });
  await sbPatch("workflow_actions", `id=eq.${a.id}`, { step_order: b.step_order });
}

export async function POST(req: Request) {
  const auth = await requireStaff();
  if (isAuthFailure(auth)) return auth;
  try {
    const body = await req.json().catch(() => null);
    const workflowId = nullableText(body?.workflow_id);
    if (!workflowId) return badRequest("Missing workflow_id.");
    const type = nullableText(body?.action_type);
    if (!isActionType(type)) return badRequest("That is not an action this OS knows how to do.");
    const cleaned = cleanActionConfig(type, body?.config);
    if (!cleaned.ok) return badRequest(cleaned.message);

    const existing = await sbGet<Pick<WorkflowActionRow, "step_order">>(
      "workflow_actions",
      "step_order",
      `workflow_id=eq.${encodeURIComponent(workflowId)}&order=step_order.desc&limit=1`
    );
    const last = existing[0]?.step_order ?? 0;
    let order = last + 1;
    if (body?.step_order !== undefined && body?.step_order !== null && body?.step_order !== "") {
      const n = Number(body.step_order);
      if (!Number.isInteger(n) || n < 1) return badRequest("step_order must be a whole number from 1.");
      order = Math.min(n, last + 1);
    }
    const row = await sbPost<WorkflowActionRow>("workflow_actions", {
      workflow_id: workflowId,
      step_order: last + 1,
      action_type: type,
      config: cleaned.config,
    });
    if (order !== last + 1) {
      // Inserted at the end, then walked up to the requested slot one swap
      // at a time so the UNIQUE constraint is never violated.
      let current = row;
      while (current.step_order > order) {
        const above = await sbGet<WorkflowActionRow>(
          "workflow_actions",
          "*",
          `workflow_id=eq.${encodeURIComponent(workflowId)}&step_order=eq.${current.step_order - 1}`
        );
        if (!above[0]) break;
        await swap(current, above[0]);
        current = { ...current, step_order: above[0].step_order };
      }
    }
    const fresh = await sbGet<WorkflowActionRow>("workflow_actions", "*", `id=eq.${row.id}`);
    return NextResponse.json({ action: fresh[0] ?? row, label: ACTION_DEFS[type].label }, { status: 201 });
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
    if (!id) return badRequest("Missing action id.");
    const found = await sbGet<WorkflowActionRow>("workflow_actions", "*", `id=eq.${encodeURIComponent(id)}`);
    const action = found[0];
    if (!action) return NextResponse.json({ error: "not_found", message: "That action no longer exists." }, { status: 404 });

    const move = nullableText(body?.move);
    let targetOrder: number | null = null;
    if (move) {
      if (move !== "up" && move !== "down") return badRequest("move must be 'up' or 'down'.");
      targetOrder = move === "up" ? action.step_order - 1 : action.step_order + 1;
    } else if (body?.step_order !== undefined) {
      const n = Number(body.step_order);
      if (!Number.isInteger(n) || n < 1) return badRequest("step_order must be a whole number from 1.");
      targetOrder = n;
    }
    if (targetOrder !== null) {
      if (targetOrder === action.step_order) return NextResponse.json({ ok: true, action });
      const neighbors = await sbGet<WorkflowActionRow>(
        "workflow_actions",
        "*",
        `workflow_id=eq.${action.workflow_id}&step_order=eq.${targetOrder}`
      );
      const other = neighbors[0];
      if (!other) {
        return badRequest(targetOrder < action.step_order ? "That action is already first." : "That action is already last.");
      }
      await swap(action, other);
      return NextResponse.json({ ok: true });
    }

    if (body?.config === undefined) return badRequest("Nothing to change.");
    if (!isActionType(action.action_type)) return badRequest("This action's type is no longer supported.");
    const cleaned = cleanActionConfig(action.action_type, body.config);
    if (!cleaned.ok) return badRequest(cleaned.message);
    const rows = await sbPatch<WorkflowActionRow>("workflow_actions", `id=eq.${encodeURIComponent(id)}`, {
      config: cleaned.config,
    });
    return NextResponse.json({ action: rows[0] ?? null });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function DELETE(req: Request) {
  const auth = await requireStaff();
  if (isAuthFailure(auth)) return auth;
  try {
    const id = new URL(req.url).searchParams.get("id");
    if (!id) return badRequest("Missing action id.");
    const deleted = await sbDelete<WorkflowActionRow>("workflow_actions", `id=eq.${encodeURIComponent(id)}`);
    if (!deleted[0]) return NextResponse.json({ error: "not_found", message: "That action no longer exists." }, { status: 404 });
    await renumber(deleted[0].workflow_id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
