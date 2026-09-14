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
  SbError,
  SEQUENCE_STATUSES,
  type SequenceRow,
  type StepRow,
  type EnrollmentRow,
} from "./_lib";
import { sbUrl, sbService } from "@/lib/osSupabase";

// Exact enrollment count via a PostgREST HEAD-style count (Prefer: count=exact,
// Range 0-0) reading the authoritative total from Content-Range. This does NOT
// fetch rows, so it stays correct past PostgREST's 1000-row default cap — the
// prior approach fetched every enrollment row and counted them in JS, which
// silently undercounted once a sequence exceeded 1000 enrollments. Mirrors the
// countWhere pattern already proven in app/api/crm/route.ts.
async function countEnrollments(filter: string): Promise<number> {
  const url = sbUrl();
  const key = sbService();
  if (!url || !key) {
    throw new SbError("Sequence database is not configured on this deployment.", 503);
  }
  let r: Response;
  try {
    r = await fetch(`${url}/rest/v1/sequence_enrollments?select=id&${filter}`, {
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        Prefer: "count=exact",
        Range: "0-0",
        "Range-Unit": "items",
      },
      cache: "no-store",
    });
  } catch (e) {
    throw new SbError("Could not reach the sequence database.", 502, String(e));
  }
  if (!r.ok && r.status !== 206) {
    const body = await r.text().catch(() => "");
    throw new SbError(`Enrollment count failed (${r.status}).`, 502, body.slice(0, 500) || null);
  }
  const n = Number((r.headers.get("content-range") || "").split("/").pop());
  return Number.isFinite(n) ? n : 0;
}

// ───────────────────────────────────────────────────────────────────────────
// /api/sequences — CRUD for the sequences themselves. Staff only.
//
//   GET            → list every sequence with step + enrollment counts
//   GET ?id=<uuid> → one sequence with its full steps and enrollments
//   POST           → create a sequence (always starts as draft)
//   PATCH          → rename / describe / Activate / Pause
//   DELETE ?id=    → delete a sequence (steps + enrollments cascade in the DB)
//
// Activating a sequence sends NOTHING. It only makes enrollments on it
// visible to the external sender's /api/sequences/due poll.
// ───────────────────────────────────────────────────────────────────────────

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = await requireStaff();
  if (isAuthFailure(auth)) return auth;
  try {
    const id = new URL(req.url).searchParams.get("id");

    if (id) {
      const seqs = await sbGet<SequenceRow>("sequences", "*", `id=eq.${encodeURIComponent(id)}`);
      if (!seqs[0]) return NextResponse.json({ error: "not_found" }, { status: 404 });
      const [steps, enrollments] = await Promise.all([
        sbGet<StepRow>("sequence_steps", "*", `sequence_id=eq.${encodeURIComponent(id)}&order=step_order.asc`),
        sbGet<EnrollmentRow>(
          "sequence_enrollments",
          "*",
          `sequence_id=eq.${encodeURIComponent(id)}&order=enrolled_at.desc`
        ),
      ]);
      return NextResponse.json({ sequence: seqs[0], steps, enrollments });
    }

    const [sequences, steps] = await Promise.all([
      sbGet<SequenceRow>("sequences", "*", "order=created_at.desc"),
      sbGet<Pick<StepRow, "sequence_id">>("sequence_steps", "sequence_id"),
    ]);
    const stepCount = new Map<string, number>();
    for (const s of steps) stepCount.set(s.sequence_id, (stepCount.get(s.sequence_id) ?? 0) + 1);

    // Enrollment tallies come from exact PostgREST counts (two per sequence:
    // total + active), NOT from fetching and counting rows. This is accurate no
    // matter how many enrollments a sequence has — the old fetch-all approach
    // capped at 1000 rows and undercounted busy sequences. Counts are O(2N)
    // header-only requests run concurrently; sequences are few (a handful).
    const enrolled = new Map<string, { total: number; active: number }>();
    await Promise.all(
      sequences.map(async (s) => {
        const idFilter = `sequence_id=eq.${encodeURIComponent(s.id)}`;
        const [total, active] = await Promise.all([
          countEnrollments(idFilter),
          countEnrollments(`${idFilter}&status=eq.active`),
        ]);
        enrolled.set(s.id, { total, active });
      })
    );

    return NextResponse.json({
      sequences: sequences.map((s) => ({
        ...s,
        stepCount: stepCount.get(s.id) ?? 0,
        enrolledTotal: enrolled.get(s.id)?.total ?? 0,
        enrolledActive: enrolled.get(s.id)?.active ?? 0,
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
    if (!name) return badRequest("A sequence needs a name.");
    const row = await sbPost<SequenceRow>("sequences", {
      name,
      description: nullableText(body?.description),
      client_slug: nullableText(body?.client_slug),
      status: "draft",
    });
    return NextResponse.json({ sequence: row }, { status: 201 });
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
    if (!id) return badRequest("Missing sequence id.");
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (body?.name !== undefined) {
      const name = nullableText(body.name);
      if (!name) return badRequest("A sequence needs a name.");
      patch.name = name;
    }
    if (body?.description !== undefined) patch.description = nullableText(body.description);
    if (body?.status !== undefined) {
      const status = nullableText(body.status);
      if (!status || !SEQUENCE_STATUSES.includes(status as (typeof SEQUENCE_STATUSES)[number])) {
        return badRequest("Status must be draft, active, or paused.");
      }
      patch.status = status;
    }
    const rows = await sbPatch<SequenceRow>("sequences", `id=eq.${encodeURIComponent(id)}`, patch);
    if (!rows[0]) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ sequence: rows[0] });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function DELETE(req: Request) {
  const auth = await requireStaff();
  if (isAuthFailure(auth)) return auth;
  try {
    const id = new URL(req.url).searchParams.get("id");
    if (!id) return badRequest("Missing sequence id.");
    const rows = await sbDelete("sequences", `id=eq.${encodeURIComponent(id)}`);
    if (!rows.length) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ deleted: rows.length });
  } catch (e) {
    return errorResponse(e);
  }
}
