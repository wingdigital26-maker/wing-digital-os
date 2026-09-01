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
  type StepRow,
} from "../_lib";

// ───────────────────────────────────────────────────────────────────────────
// /api/sequences/steps — CRUD for the ordered steps inside a sequence.
//
//   POST           → add a step at the end ("Wait N days, then send this email")
//   PATCH          → edit wait/subject/body, or move: "up" | "down" to reorder
//   DELETE ?id=    → remove a step and renumber the rest so orders stay 1..N
//
// step_order is 1-based and has a UNIQUE (sequence_id, step_order) constraint,
// so reordering swaps through a temporary order (-1) instead of colliding.
// Editing steps never touches enrollments: someone mid-sequence keeps their
// current_step number and simply gets whatever the step at the next order
// says when it comes due.
// ───────────────────────────────────────────────────────────────────────────

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseWait(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0 || n > 365) return null;
  return n;
}

export async function POST(req: Request) {
  const auth = await requireStaff();
  if (isAuthFailure(auth)) return auth;
  try {
    const body = await req.json().catch(() => null);
    const sequenceId = nullableText(body?.sequence_id);
    const text = nullableText(body?.body);
    if (!sequenceId) return badRequest("Missing sequence_id.");
    if (!text) return badRequest("The email body cannot be empty.");
    const wait = parseWait(body?.wait_days ?? 0);
    if (wait === null) return badRequest("wait_days must be a whole number of days (0 to 365).");

    const existing = await sbGet<Pick<StepRow, "step_order">>(
      "sequence_steps",
      "step_order",
      `sequence_id=eq.${encodeURIComponent(sequenceId)}&order=step_order.desc&limit=1`
    );
    const nextOrder = (existing[0]?.step_order ?? 0) + 1;
    const row = await sbPost<StepRow>("sequence_steps", {
      sequence_id: sequenceId,
      step_order: nextOrder,
      wait_days: wait,
      channel: "email",
      subject: nullableText(body?.subject),
      body: text,
    });
    return NextResponse.json({ step: row }, { status: 201 });
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
    if (!id) return badRequest("Missing step id.");

    const found = await sbGet<StepRow>("sequence_steps", "*", `id=eq.${encodeURIComponent(id)}`);
    const step = found[0];
    if (!step) return NextResponse.json({ error: "not_found" }, { status: 404 });

    const move = nullableText(body?.move);
    if (move) {
      if (move !== "up" && move !== "down") return badRequest("move must be 'up' or 'down'.");
      const targetOrder = move === "up" ? step.step_order - 1 : step.step_order + 1;
      const neighbors = await sbGet<StepRow>(
        "sequence_steps",
        "*",
        `sequence_id=eq.${step.sequence_id}&step_order=eq.${targetOrder}`
      );
      const other = neighbors[0];
      if (!other) return badRequest("That step is already at the end.");
      // Three-hop swap so the UNIQUE (sequence_id, step_order) never collides.
      await sbPatch("sequence_steps", `id=eq.${step.id}`, { step_order: -1 });
      await sbPatch("sequence_steps", `id=eq.${other.id}`, { step_order: step.step_order });
      await sbPatch("sequence_steps", `id=eq.${step.id}`, { step_order: targetOrder });
      return NextResponse.json({ ok: true });
    }

    const patch: Record<string, unknown> = {};
    if (body?.wait_days !== undefined) {
      const wait = parseWait(body.wait_days);
      if (wait === null) return badRequest("wait_days must be a whole number of days (0 to 365).");
      patch.wait_days = wait;
    }
    if (body?.subject !== undefined) patch.subject = nullableText(body.subject);
    if (body?.body !== undefined) {
      const text = nullableText(body.body);
      if (!text) return badRequest("The email body cannot be empty.");
      patch.body = text;
    }
    if (!Object.keys(patch).length) return badRequest("Nothing to change.");
    const rows = await sbPatch<StepRow>("sequence_steps", `id=eq.${encodeURIComponent(id)}`, patch);
    return NextResponse.json({ step: rows[0] ?? null });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function DELETE(req: Request) {
  const auth = await requireStaff();
  if (isAuthFailure(auth)) return auth;
  try {
    const id = new URL(req.url).searchParams.get("id");
    if (!id) return badRequest("Missing step id.");
    const deleted = await sbDelete<StepRow>("sequence_steps", `id=eq.${encodeURIComponent(id)}`);
    if (!deleted[0]) return NextResponse.json({ error: "not_found" }, { status: 404 });

    // Renumber the survivors to a clean 1..N so ordering and the due-step
    // arithmetic ("current_step + 1") stay literal. Walk high-to-low or
    // low-to-high is safe either way because we only ever shrink orders.
    const rest = await sbGet<StepRow>(
      "sequence_steps",
      "*",
      `sequence_id=eq.${deleted[0].sequence_id}&order=step_order.asc`
    );
    for (let i = 0; i < rest.length; i++) {
      if (rest[i].step_order !== i + 1) {
        await sbPatch("sequence_steps", `id=eq.${rest[i].id}`, { step_order: i + 1 });
      }
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
