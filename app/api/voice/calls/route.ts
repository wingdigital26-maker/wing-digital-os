// GET /api/voice/calls   staff: the last 100 phone_calls, newest first, with
// the linked CRM contact's business name embedded so the board can show who
// called instead of a bare number.
import { NextResponse } from "next/server";
import { requireStaff, isAuthFailure, sbGet, errorResponse, clampInt } from "../../pipeline/_lib";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SELECT =
  "id,provider_sid,contact_id,client_slug,direction,from_number,to_number,status,duration_sec,recording_url,started_at,ended_at," +
  "crm_contacts(id,business_name)";

export async function GET(req: Request) {
  const auth = await requireStaff();
  if (isAuthFailure(auth)) return auth;
  const limit = clampInt(new URL(req.url).searchParams.get("limit"), 100, 1, 500);
  try {
    const calls = await sbGet("phone_calls", SELECT, `order=started_at.desc&limit=${limit}`);
    return NextResponse.json({ ok: true, calls, paging: { limit, returned: calls.length } });
  } catch (e) {
    return errorResponse(e);
  }
}
