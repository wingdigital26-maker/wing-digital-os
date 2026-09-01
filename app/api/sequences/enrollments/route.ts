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
  dueDateFrom,
  type SequenceRow,
  type StepRow,
  type EnrollmentRow,
} from "../_lib";

// ───────────────────────────────────────────────────────────────────────────
// /api/sequences/enrollments — who is on what sequence. Staff only.
//
//   GET  [?sequence_id=]  → list enrollments (all, or one sequence's)
//   POST                  → enroll a person manually (the "Add person" form)
//   PATCH                 → { id, action: "pause" | "resume" }
//   DELETE ?id=           → remove a person from the sequence entirely
//
// Enrolling writes a row and a due date. It sends NOTHING — the external
// sender decides when to act on due rows, and only for ACTIVE sequences.
//
// TODO(auto-enrollment): this round is manual-only by design. Auto-enrolling
// from prospect lists (e.g. every new b2b prospect lands on the cold
// sequence) is a later, deliberate step with its own suppression checks.
// ───────────────────────────────────────────────────────────────────────────

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

type EnrollmentWithSeq = EnrollmentRow & { sequences: { name: string; status: string } | null };

export async function GET(req: Request) {
  const auth = await requireStaff();
  if (isAuthFailure(auth)) return auth;
  try {
    const sequenceId = new URL(req.url).searchParams.get("sequence_id");
    const filter = sequenceId ? `&sequence_id=eq.${encodeURIComponent(sequenceId)}` : "";
    const rows = await sbGet<EnrollmentWithSeq>(
      "sequence_enrollments",
      "*,sequences(name,status)",
      `order=next_send_at.asc.nullslast${filter}`
    );
    return NextResponse.json({ enrollments: rows });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: Request) {
  const auth = await requireStaff();
  if (isAuthFailure(auth)) return auth;
  try {
    const body = await req.json().catch(() => null);
    const sequenceId = nullableText(body?.sequence_id);
    const email = (nullableText(body?.email) || "").toLowerCase();
    if (!sequenceId) return badRequest("Pick a sequence to add this person to.");
    if (!email || !EMAIL_RE.test(email)) return badRequest("That does not look like an email address.");

    const [seqs, steps] = await Promise.all([
      sbGet<SequenceRow>("sequences", "*", `id=eq.${encodeURIComponent(sequenceId)}`),
      sbGet<StepRow>(
        "sequence_steps",
        "*",
        `sequence_id=eq.${encodeURIComponent(sequenceId)}&order=step_order.asc&limit=1`
      ),
    ]);
    if (!seqs[0]) return NextResponse.json({ error: "not_found" }, { status: 404 });
    if (!steps[0]) {
      return badRequest("This sequence has no steps yet. Add at least one email before enrolling anyone.");
    }

    const row = await sbPost<EnrollmentRow>("sequence_enrollments", {
      sequence_id: sequenceId,
      email,
      name: nullableText(body?.name),
      company: nullableText(body?.company),
      current_step: 0,
      status: "active",
      next_send_at: dueDateFrom(new Date(), steps[0].wait_days),
    }).catch((e) => {
      // UNIQUE (sequence_id, email): the same person cannot be on the same
      // sequence twice. Surface that as plain English, not a 502.
      const msg = e instanceof Error ? `${e.message} ${(e as { detail?: string }).detail ?? ""}` : String(e);
      if (/duplicate|23505|unique/i.test(msg)) {
        throw badRequestError("This person is already on this sequence.");
      }
      throw e;
    });
    return NextResponse.json({ enrollment: row }, { status: 201 });
  } catch (e) {
    if (e instanceof Response) return e;
    return errorResponse(e);
  }
}

// badRequest() returns a NextResponse; wrap it so it can travel through throw.
function badRequestError(message: string): Response {
  return badRequest(message);
}

export async function PATCH(req: Request) {
  const auth = await requireStaff();
  if (isAuthFailure(auth)) return auth;
  try {
    const body = await req.json().catch(() => null);
    const id = nullableText(body?.id);
    const action = nullableText(body?.action);
    if (!id) return badRequest("Missing enrollment id.");
    if (action !== "pause" && action !== "resume") return badRequest("action must be 'pause' or 'resume'.");

    const found = await sbGet<EnrollmentRow>("sequence_enrollments", "*", `id=eq.${encodeURIComponent(id)}`);
    const en = found[0];
    if (!en) return NextResponse.json({ error: "not_found" }, { status: 404 });

    const now = new Date().toISOString();
    if (action === "pause") {
      const rows = await sbPatch<EnrollmentRow>("sequence_enrollments", `id=eq.${en.id}`, {
        status: "paused",
        updated_at: now,
      });
      return NextResponse.json({ enrollment: rows[0] });
    }

    // Resume. Only paused rows can come back; completed/replied/unsubscribed/
    // bounced are terminal and resuming them would re-mail someone who should
    // never be re-mailed from here.
    if (en.status !== "paused") {
      return badRequest(`Only paused people can be resumed (this one is ${en.status}).`);
    }
    const patch: Record<string, unknown> = { status: "active", updated_at: now };
    if (!en.next_send_at) {
      // Was paused without a due date on record: schedule the next step from
      // today using its own wait, never backdated.
      const nextSteps = await sbGet<StepRow>(
        "sequence_steps",
        "*",
        `sequence_id=eq.${en.sequence_id}&step_order=eq.${en.current_step + 1}`
      );
      if (!nextSteps[0]) return badRequest("This person already finished every step; nothing to resume.");
      patch.next_send_at = dueDateFrom(new Date(), nextSteps[0].wait_days);
    }
    const rows = await sbPatch<EnrollmentRow>("sequence_enrollments", `id=eq.${en.id}`, patch);
    return NextResponse.json({ enrollment: rows[0] });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function DELETE(req: Request) {
  const auth = await requireStaff();
  if (isAuthFailure(auth)) return auth;
  try {
    const id = new URL(req.url).searchParams.get("id");
    if (!id) return badRequest("Missing enrollment id.");
    const rows = await sbDelete("sequence_enrollments", `id=eq.${encodeURIComponent(id)}`);
    if (!rows.length) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ deleted: rows.length });
  } catch (e) {
    return errorResponse(e);
  }
}
