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
} from "@/app/api/pipeline/_lib";
import { emitEvent } from "@/lib/automations/emit";
import type { TaskRow } from "@/lib/automations/types";

// ───────────────────────────────────────────────────────────────────────────
// /api/automations/tasks: follow-up tasks. Staff only.
//
//   GET                    open tasks (done_at null), soonest due first, tasks
//                          with no due date last, contact embedded
//   POST  {title, contact_id?, deal_id?, due_at?, body?, client_slug?}
//                          create one by hand (source "os-ui")
//   PATCH {id, done: true|false}
//                          mark done / reopen. Marking done emits a
//                          task.completed event so a workflow can react.
//
// NULL rules: due_at absent means "no due date", never "now". contact_id
// absent means the task belongs to nobody in particular, which is allowed.
// ───────────────────────────────────────────────────────────────────────────

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type TaskWithContact = TaskRow & {
  crm_contacts: { business_name: string; contact_name: string | null; phone: string | null } | null;
};

function isoOrNull(v: unknown): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

export async function GET() {
  const auth = await requireStaff();
  if (isAuthFailure(auth)) return auth;
  try {
    const tasks = await sbGet<TaskWithContact>(
      "tasks",
      "*,crm_contacts(business_name,contact_name,phone)",
      "done_at=is.null&order=due_at.asc.nullslast,created_at.desc&limit=200"
    );
    return NextResponse.json({ tasks });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: Request) {
  const auth = await requireStaff();
  if (isAuthFailure(auth)) return auth;
  try {
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return badRequest("Body must be JSON.");
    const title = nullableText(body.title);
    if (!title) return badRequest("title is required.");

    let contactId: number | null = null;
    if (body.contact_id !== undefined && body.contact_id !== null && body.contact_id !== "") {
      contactId = Number(body.contact_id);
      if (!Number.isInteger(contactId) || contactId <= 0) return badRequest("contact_id must be a contact id.");
      const c = await sbGet<{ id: number }>("crm_contacts", "id", `id=eq.${contactId}`);
      if (!c.length) return badRequest(`No contact with id ${contactId}.`);
    }
    let dealId: number | null = null;
    if (body.deal_id !== undefined && body.deal_id !== null && body.deal_id !== "") {
      dealId = Number(body.deal_id);
      if (!Number.isInteger(dealId) || dealId <= 0) return badRequest("deal_id must be a deal id.");
    }
    const dueAt = isoOrNull(body.due_at);
    if (dueAt === undefined && body.due_at !== undefined) return badRequest("due_at must be an ISO timestamp or null.");

    const task = await sbPost<TaskRow>("tasks", {
      contact_id: contactId,
      deal_id: dealId,
      client_slug: nullableText(body.client_slug),
      title,
      body: nullableText(body.body),
      due_at: dueAt ?? null,
      assigned_email: auth.email,
      source: "os-ui",
    });
    return NextResponse.json({ ok: true, task }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function PATCH(req: Request) {
  const auth = await requireStaff();
  if (isAuthFailure(auth)) return auth;
  try {
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return badRequest("Body must be JSON.");
    const id = Number(body.id);
    if (!Number.isInteger(id) || id <= 0) return badRequest("id is required.");
    if (typeof body.done !== "boolean") return badRequest("done must be true or false.");

    const existing = (await sbGet<TaskRow>("tasks", "*", `id=eq.${id}`))[0];
    if (!existing) return NextResponse.json({ error: "not_found", message: `No task #${id}.` }, { status: 404 });

    const patch: Record<string, unknown> = {};
    if (body.done) {
      if (existing.done_at) return NextResponse.json({ ok: true, task: existing, changed: false });
      patch.done_at = new Date().toISOString();
    } else {
      patch.done_at = null;
    }
    if (body.title !== undefined) {
      const t = nullableText(body.title);
      if (!t) return badRequest("title cannot be blank.");
      patch.title = t;
    }
    if (body.due_at !== undefined) {
      const d = isoOrNull(body.due_at);
      if (d === undefined) return badRequest("due_at must be an ISO timestamp or null.");
      patch.due_at = d;
    }
    const updated = await sbPatch<TaskRow>("tasks", `id=eq.${id}`, patch);
    if (!updated.length) throw new Error("Update matched no rows.");
    const task = updated[0];

    let event: { id: number | null; error: string | null } | null = null;
    if (body.done) {
      event = await emitEvent({
        type: "task.completed",
        client_slug: task.client_slug,
        contact_id: task.contact_id,
        payload: { task_id: task.id, title: task.title, source: task.source, completed_by: auth.email },
      });
    }
    return NextResponse.json({ ok: true, changed: true, task, event });
  } catch (e) {
    return errorResponse(e);
  }
}
