// POST  /api/pipeline/deals — create a deal against an existing contact.
// PATCH /api/pipeline/deals — move stage, set value, or mark won/lost.
//
// MONEY: value_cents is integer cents. Sending no value, null, or "" stores
// NULL = "not quoted yet", which is a different fact from a $0 deal and must
// never be flattened into one. Floats are rejected outright rather than rounded.
//
// STAGE CHANGES write a crm_activities row of kind 'stage_change' so the
// timeline shows how a deal actually moved. That log is best-effort: if it
// fails the deal update has already happened, so the response says so instead
// of pretending the history is complete.
import { NextResponse } from "next/server";
import {
  requireStaff,
  isAuthFailure,
  sbGet,
  sbPost,
  sbPatch,
  errorResponse,
  badRequest,
  nullableText,
  nullableCents,
  esc,
} from "../_lib";
import { emitEvent } from "@/lib/automations/emit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEAL_SELECT =
  "id,contact_id,stage_id,title,value_cents,status,expected_close,won_at,lost_at,lost_reason,owner_id,created_at,updated_at";

type Stage = { id: number; key: string; label: string; is_won: boolean; is_lost: boolean };
type Deal = {
  id: number;
  contact_id: number;
  stage_id: number;
  title: string;
  value_cents: number | null;
  status: string;
};

// Accept a stage as either its numeric id or its key ("booked"), because the
// board sends ids and scripts send keys.
async function resolveStage(v: unknown): Promise<Stage | null> {
  if (v === undefined || v === null || v === "") return null;
  const asNum = typeof v === "number" ? v : Number(v);
  const filter =
    Number.isInteger(asNum) && String(v).trim() !== ""
      ? `id=eq.${asNum}`
      : `key=eq.${esc(String(v))}`;
  const rows = await sbGet<Stage>("crm_stages", "id,key,label,is_won,is_lost", filter);
  return rows[0] ?? null;
}

// ISO date (YYYY-MM-DD) or null. Anything else is a caller bug, not a guess.
function nullableDate(v: unknown): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  const s = String(v).trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : undefined;
}

export async function POST(req: Request) {
  const auth = await requireStaff();
  if (isAuthFailure(auth)) return auth;

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return badRequest("Body must be JSON.");
  }

  const title = nullableText(body.title);
  if (!title) return badRequest("title is required.");

  const contactId = Number(body.contact_id);
  if (!Number.isInteger(contactId) || contactId <= 0) {
    return badRequest("contact_id must be an existing contact id.");
  }

  const value = nullableCents(body.value_cents);
  if (value === undefined && body.value_cents !== undefined) {
    return badRequest("value_cents must be an integer number of cents, or null if not quoted.");
  }

  const expected = nullableDate(body.expected_close);
  if (expected === undefined && body.expected_close !== undefined) {
    return badRequest("expected_close must be YYYY-MM-DD or null.");
  }

  try {
    const contact = await sbGet<{ id: number }>("crm_contacts", "id", `id=eq.${contactId}`);
    if (!contact.length) return badRequest(`No contact with id ${contactId}.`);

    // Default to the first stage by sort, not to a hardcoded key — the stages
    // table is editable by design.
    let stage = await resolveStage(body.stage ?? body.stage_id);
    if (!stage && (body.stage !== undefined || body.stage_id !== undefined)) {
      return badRequest("Unknown stage.");
    }
    if (!stage) {
      const first = await sbGet<Stage>(
        "crm_stages",
        "id,key,label,is_won,is_lost",
        "order=sort.asc&limit=1"
      );
      if (!first.length) return badRequest("No pipeline stages are configured.");
      stage = first[0];
    }

    const created = await sbPost<Deal>("crm_deals", {
      contact_id: contactId,
      stage_id: stage.id,
      title,
      // Absent => NULL (not quoted). Never 0.
      value_cents: value ?? null,
      status: stage.is_won ? "won" : stage.is_lost ? "lost" : "open",
      expected_close: expected ?? null,
      won_at: stage.is_won ? new Date().toISOString() : null,
      lost_at: stage.is_lost ? new Date().toISOString() : null,
      owner_id: auth.userId,
    });

    return NextResponse.json({ ok: true, deal: created }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function PATCH(req: Request) {
  const auth = await requireStaff();
  if (isAuthFailure(auth)) return auth;

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return badRequest("Body must be JSON.");
  }

  const id = Number(body.id ?? body.deal_id);
  if (!Number.isInteger(id) || id <= 0) return badRequest("id (deal id) is required.");

  try {
    const existing = await sbGet<Deal>("crm_deals", DEAL_SELECT, `id=eq.${id}`);
    if (!existing.length) return badRequest(`No deal with id ${id}.`);
    const before = existing[0];

    const patch: Record<string, unknown> = {};
    let fromStage: Stage | null = null;
    let toStage: Stage | null = null;

    // ── stage move ────────────────────────────────────────────────────────
    if (body.stage !== undefined || body.stage_id !== undefined) {
      toStage = await resolveStage(body.stage ?? body.stage_id);
      if (!toStage) return badRequest("Unknown stage.");
      if (toStage.id !== before.stage_id) {
        patch.stage_id = toStage.id;
        const fromRows = await sbGet<Stage>(
          "crm_stages",
          "id,key,label,is_won,is_lost",
          `id=eq.${before.stage_id}`
        );
        fromStage = fromRows[0] ?? null;
      } else {
        toStage = null; // no-op move; don't log a stage_change that didn't happen
      }
    }

    // ── explicit status (won/lost/open) ───────────────────────────────────
    // A terminal stage implies the status; an explicit status wins over it.
    const wanted = nullableText(body.status);
    let status: string | null = null;
    if (wanted) {
      if (!["open", "won", "lost"].includes(wanted)) {
        return badRequest("status must be open, won, or lost.");
      }
      status = wanted;
    } else if (patch.stage_id !== undefined) {
      const s = toStage ?? fromStage;
      if (s?.is_won) status = "won";
      else if (s?.is_lost) status = "lost";
    }

    if (status && status !== before.status) {
      patch.status = status;
      const now = new Date().toISOString();
      if (status === "won") {
        patch.won_at = now;
        patch.lost_at = null;
        patch.lost_reason = null;
      } else if (status === "lost") {
        patch.lost_at = now;
        patch.won_at = null;
        // A lost reason is optional; NULL means nobody recorded one, which is
        // honest. We do not invent "unknown" text.
        patch.lost_reason = nullableText(body.lost_reason);
      } else {
        // Reopened: the close timestamps are no longer true, so they go away.
        patch.won_at = null;
        patch.lost_at = null;
        patch.lost_reason = null;
      }
    } else if (status === "lost" && body.lost_reason !== undefined) {
      patch.lost_reason = nullableText(body.lost_reason);
    }

    // ── value ─────────────────────────────────────────────────────────────
    if (body.value_cents !== undefined) {
      const v = nullableCents(body.value_cents);
      if (v === undefined) {
        return badRequest("value_cents must be an integer number of cents, or null if not quoted.");
      }
      patch.value_cents = v; // may be null: back to "not quoted"
    }

    if (body.title !== undefined) {
      const t = nullableText(body.title);
      if (!t) return badRequest("title cannot be blank.");
      patch.title = t;
    }

    if (body.expected_close !== undefined) {
      const d = nullableDate(body.expected_close);
      if (d === undefined) return badRequest("expected_close must be YYYY-MM-DD or null.");
      patch.expected_close = d;
    }

    if (!Object.keys(patch).length) {
      return NextResponse.json({
        ok: true,
        deal: before,
        changed: false,
        message: "Nothing to update.",
      });
    }

    const updated = await sbPatch<Deal>("crm_deals", `id=eq.${id}`, patch);
    if (!updated.length) throw new Error("Update matched no rows.");

    // ── stage_change activity ─────────────────────────────────────────────
    let activityLogged = false;
    let activityError: string | null = null;
    if (patch.stage_id !== undefined && toStage) {
      try {
        await sbPost("crm_activities", {
          contact_id: before.contact_id,
          deal_id: id,
          kind: "stage_change",
          outcome: toStage.key,
          body: `${fromStage ? fromStage.label : `stage ${before.stage_id}`} -> ${toStage.label}`,
          source: "os-ui",
          created_by: auth.userId,
        });
        activityLogged = true;
      } catch (e) {
        activityError = String(e).slice(0, 300);
      }

      // Automation hook: the stage is written, so the engine hears about it.
      // Wrapped so a failed emit never changes the response.
      try {
        await emitEvent({
          type: "deal.stage_changed",
          contact_id: before.contact_id,
          payload: {
            deal_id: id,
            stage_key: toStage.key,
            from_stage_key: fromStage?.key ?? null,
            title: (patch.title as string | undefined) ?? before.title,
          },
        });
      } catch {
        // The deal moved; the timeline row above is the record.
      }
    }

    return NextResponse.json({
      ok: true,
      changed: true,
      deal: updated[0],
      stage_change: patch.stage_id !== undefined ? { logged: activityLogged, error: activityError } : null,
    });
  } catch (e) {
    return errorResponse(e);
  }
}
