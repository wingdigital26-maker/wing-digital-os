import { NextResponse } from "next/server";
import {
  requireStaff,
  isAuthFailure,
  errorResponse,
  badRequest,
  sbGet,
  type WorkflowRow,
  type WorkflowActionRow,
  type WorkflowRunRow,
} from "../_workflows";

// GET /api/automations/<id>: one workflow, its actions in step order, and
// its last 20 runs (newest first). Staff only.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ContactLite = { id: number; business_name: string; contact_name: string | null };

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireStaff();
  if (isAuthFailure(auth)) return auth;
  try {
    const { id } = await ctx.params;
    if (!id) return badRequest("Missing automation id.");
    const q = encodeURIComponent(id);
    const workflows = await sbGet<WorkflowRow>("workflows", "*", `id=eq.${q}`);
    if (!workflows[0]) {
      return NextResponse.json({ error: "not_found", message: "That automation no longer exists." }, { status: 404 });
    }
    const [actions, runs] = await Promise.all([
      sbGet<WorkflowActionRow>("workflow_actions", "*", `workflow_id=eq.${q}&order=step_order.asc`),
      sbGet<WorkflowRunRow>("workflow_runs", "*", `workflow_id=eq.${q}&order=started_at.desc&limit=20`),
    ]);

    // Name the contacts the runs touched so the UI can say who, not "#4127".
    const contactIds = Array.from(new Set(runs.map((r) => r.contact_id).filter((v): v is number => typeof v === "number")));
    let contacts: ContactLite[] = [];
    if (contactIds.length) {
      contacts = await sbGet<ContactLite>(
        "crm_contacts",
        "id,business_name,contact_name",
        `id=in.(${contactIds.join(",")})`
      );
    }
    const byId = new Map(contacts.map((c) => [c.id, c]));
    return NextResponse.json({
      workflow: workflows[0],
      actions,
      runs: runs.map((r) => ({ ...r, contact: r.contact_id != null ? byId.get(r.contact_id) ?? null : null })),
    });
  } catch (e) {
    return errorResponse(e);
  }
}
