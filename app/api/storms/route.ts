// ───────────────────────────────────────────────────────────────────────────
// /api/storms — Storm Response read + dismiss surface. DEMO-ONLY BUILD.
//
// GET   : hail events newest first (limit 50) with their drafts embedded.
// PATCH : dismiss one draft (status='dismissed'). That is the ONLY status
//         transition in this build. There is no publish, no approve, no Meta
//         call, no spend — nothing here can post anything anywhere.
// ───────────────────────────────────────────────────────────────────────────
import { NextRequest, NextResponse } from "next/server";
import {
  requireStaff,
  isAuthFailure,
  sbGet,
  sbPatch,
  errorResponse,
  badRequest,
  SbError,
} from "../pipeline/_lib";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET() {
  const auth = await requireStaff();
  if (isAuthFailure(auth)) return auth;
  try {
    const events = await sbGet(
      "storm_events",
      "*,storm_drafts(*)",
      "order=event_time.desc&limit=50"
    );
    return NextResponse.json({ available: true, tableMissing: false, events });
  } catch (e) {
    // A missing table is a real state, not an error page: the migration has
    // not been applied yet. Say so honestly instead of a generic failure.
    if (
      e instanceof SbError &&
      /storm_events|does not exist|PGRST205|42P01/i.test(e.detail || "")
    ) {
      return NextResponse.json({
        available: false,
        tableMissing: true,
        events: [],
        reason:
          "The storm tables are not in the database yet. Apply migration 0020_storm_response.sql.",
      });
    }
    return errorResponse(e);
  }
}

export async function PATCH(req: NextRequest) {
  const auth = await requireStaff();
  if (isAuthFailure(auth)) return auth;
  let body: any;
  try {
    body = await req.json();
  } catch {
    return badRequest("Body must be JSON.");
  }
  const id = typeof body?.draftId === "string" ? body.draftId : "";
  if (!UUID_RE.test(id)) return badRequest("draftId must be a draft uuid.");
  // The only allowed action is dismiss. No other status transitions exist in
  // this build, by design — nothing can be marked posted, approved, or sent.
  if (body?.action !== "dismiss") {
    return badRequest("The only supported action is 'dismiss'.");
  }
  try {
    const rows = await sbPatch("storm_drafts", `id=eq.${id}`, {
      status: "dismissed",
    });
    if (!rows.length) return badRequest("No draft with that id.");
    return NextResponse.json({ ok: true, draft: rows[0] });
  } catch (e) {
    return errorResponse(e);
  }
}
