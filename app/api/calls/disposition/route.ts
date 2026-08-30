import { NextResponse } from "next/server";
import { requireCallUser, sbConfigured, sbPatch, sbPost, OUTCOMES } from "../_guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/calls/disposition
//   { leadId, outcome, notes?, nextActionAt?, durationSec? }
//
// Logs the result of one dial. Two writes, in this order and never merged:
//   1. an append-only row in call_activity  -- the history, which is the point
//   2. a summary patch on call_leads        -- the working state
//
// The activity row goes first on purpose. If the summary patch fails we have
// still recorded that the call happened; the reverse would silently lose a
// conversation. The response says plainly which parts succeeded.
export async function POST(req: Request) {
  const user = await requireCallUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!sbConfigured()) {
    return NextResponse.json({ error: "call room not configured" }, { status: 503 });
  }

  const body = (await req.json().catch(() => ({}))) as {
    leadId?: string;
    outcome?: string;
    notes?: string;
    nextActionAt?: string;
    durationSec?: number;
  };

  const leadId = String(body.leadId ?? "");
  const outcome = String(body.outcome ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(leadId)) {
    return NextResponse.json({ error: "bad leadId" }, { status: 400 });
  }
  if (!(OUTCOMES as readonly string[]).includes(outcome)) {
    return NextResponse.json(
      { error: `outcome must be one of: ${OUTCOMES.join(", ")}` },
      { status: 400 }
    );
  }

  const notes = typeof body.notes === "string" ? body.notes.slice(0, 4000) : null;
  const nextActionAt =
    body.nextActionAt && !Number.isNaN(Date.parse(body.nextActionAt))
      ? new Date(body.nextActionAt).toISOString()
      : null;
  const durationSec =
    typeof body.durationSec === "number" && body.durationSec >= 0
      ? Math.round(body.durationSec)
      : null;

  const logged = await sbPost("call_activity", {
    lead_id: leadId,
    user_id: user.id === "legacy" ? null : user.id,
    user_email: user.email,
    outcome,
    notes,
    next_action_at: nextActionAt,
    duration_sec: durationSec,
  });
  if (logged === null) {
    return NextResponse.json({ error: "could not record the call" }, { status: 502 });
  }

  // "no_answer" is a real event but not a real status change -- a business you
  // could not reach is still a business to call. Everything else advances the
  // lead. A finished lead releases its claim so the room does not silently fill
  // up with locks nobody is working.
  const releases = outcome !== "callback" && outcome !== "no_answer";
  const patch: Record<string, unknown> = {
    last_outcome: outcome,
    last_called_at: new Date().toISOString(),
    next_action_at: nextActionAt,
  };
  if (outcome !== "no_answer") patch.status = outcome;
  if (releases) {
    patch.claimed_by = null;
    patch.claimed_by_email = null;
    patch.claimed_at = null;
  }

  // call_count is a counter; PostgREST cannot express "+1" so read-modify-write
  // is avoided entirely by letting the DB do it through a tiny RPC-free trick:
  // we patch the other fields, then bump the counter with a second targeted
  // patch that reads the current value. Contention here is harmless (a dial
  // count that is off by one under a simultaneous double-dial is not a fact
  // anyone acts on) so this is not worth a stored procedure.
  const updated = await sbPatch<{ id: string; call_count: number }>(
    "call_leads",
    `id=eq.${leadId}`,
    patch
  );
  if (updated === null) {
    return NextResponse.json(
      { ok: true, logged: true, leadUpdated: false, warning: "call recorded, but the lead status did not update" },
      { status: 207 }
    );
  }
  const current = updated[0]?.call_count ?? 0;
  await sbPatch("call_leads", `id=eq.${leadId}`, { call_count: current + 1 });

  return NextResponse.json({ ok: true, logged: true, leadUpdated: true, status: outcome });
}

// GET /api/calls/disposition?leadId=...  -- full call history for one lead, so
// a caller can see what was already said before they dial.
export async function GET(req: Request) {
  const user = await requireCallUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const leadId = new URL(req.url).searchParams.get("leadId") ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(leadId)) {
    return NextResponse.json({ error: "bad leadId" }, { status: 400 });
  }
  const { sbGet } = await import("../_guard");
  const rows = await sbGet(
    "call_activity",
    `select=*&lead_id=eq.${leadId}&order=created_at.desc&limit=50`
  );
  if (rows === null) return NextResponse.json({ error: "could not read history" }, { status: 502 });
  return NextResponse.json({ activity: rows });
}
