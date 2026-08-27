// GET  /api/pipeline/activities — timeline for a contact or a deal.
// POST /api/pipeline/activities — log a call/email/sms/note/meeting.
//
// This is where a dial-sheet outcome finally lands instead of dead-ending in a
// static page. Logging is all this does: nothing here sends an email, an SMS, or
// any outbound request to a prospect. It records that something happened.
import { NextResponse } from "next/server";
import {
  requireStaff,
  isAuthFailure,
  sbGet,
  sbPost,
  errorResponse,
  badRequest,
  nullableText,
  clampInt,
} from "../_lib";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 'stage_change' is deliberately NOT accepted here: it is written by the deals
// route when a stage actually moves. Letting a client post one by hand would
// put movement in the timeline that never happened.
const KINDS = ["call", "email", "sms", "note", "meeting"];

const ACT_SELECT =
  "id,contact_id,deal_id,kind,outcome,body,occurred_at,source,created_by,created_at";

export async function GET(req: Request) {
  const auth = await requireStaff();
  if (isAuthFailure(auth)) return auth;

  const sp = new URL(req.url).searchParams;
  const contactId = Number(sp.get("contact_id"));
  const dealId = Number(sp.get("deal_id"));
  const limit = clampInt(sp.get("limit"), 50, 1, 200);

  const filters: string[] = [];
  if (Number.isInteger(contactId) && contactId > 0) filters.push(`contact_id=eq.${contactId}`);
  if (Number.isInteger(dealId) && dealId > 0) filters.push(`deal_id=eq.${dealId}`);
  if (!filters.length) {
    return badRequest("Pass contact_id or deal_id.");
  }

  try {
    const rows = await sbGet(
      "crm_activities",
      ACT_SELECT,
      [...filters, "order=occurred_at.desc", `limit=${limit}`].join("&")
    );
    return NextResponse.json({ ok: true, activities: rows });
  } catch (e) {
    return errorResponse(e);
  }
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

  const kind = nullableText(body.kind);
  if (!kind || !KINDS.includes(kind)) {
    return badRequest(`kind must be one of: ${KINDS.join(", ")}.`);
  }

  const contactId = body.contact_id === undefined || body.contact_id === null ? null : Number(body.contact_id);
  const dealId = body.deal_id === undefined || body.deal_id === null ? null : Number(body.deal_id);
  if (contactId !== null && (!Number.isInteger(contactId) || contactId <= 0)) {
    return badRequest("contact_id must be a contact id.");
  }
  if (dealId !== null && (!Number.isInteger(dealId) || dealId <= 0)) {
    return badRequest("deal_id must be a deal id.");
  }
  // The table's own check constraint enforces this too; catching it here gives
  // the UI a readable message instead of a Postgres error string.
  if (contactId === null && dealId === null) {
    return badRequest("An activity must reference a contact_id or a deal_id.");
  }

  const occurred = nullableText(body.occurred_at);
  if (occurred && Number.isNaN(Date.parse(occurred))) {
    return badRequest("occurred_at must be an ISO timestamp.");
  }

  try {
    if (contactId !== null) {
      const c = await sbGet<{ id: number }>("crm_contacts", "id", `id=eq.${contactId}`);
      if (!c.length) return badRequest(`No contact with id ${contactId}.`);
    }
    let resolvedContact = contactId;
    if (dealId !== null) {
      const d = await sbGet<{ id: number; contact_id: number }>(
        "crm_deals",
        "id,contact_id",
        `id=eq.${dealId}`
      );
      if (!d.length) return badRequest(`No deal with id ${dealId}.`);
      // Backfill the contact from the deal so a deal-scoped note still shows on
      // the business's timeline.
      if (resolvedContact === null) resolvedContact = d[0].contact_id;
    }

    const created = await sbPost("crm_activities", {
      contact_id: resolvedContact,
      deal_id: dealId,
      kind,
      // NULL outcome = nobody recorded one. Not "unknown", not "".
      outcome: nullableText(body.outcome),
      body: nullableText(body.body),
      occurred_at: occurred ? new Date(occurred).toISOString() : new Date().toISOString(),
      source: nullableText(body.source) ?? "os-ui",
      created_by: auth.userId,
    });

    return NextResponse.json({ ok: true, activity: created }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
