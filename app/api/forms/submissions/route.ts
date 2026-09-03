// GET /api/forms/submissions?form_id=&limit=   staff: the most recent
// submissions, newest first, with the CRM contact the engine linked (if any)
// embedded. form_id is optional; without it you get the latest across every
// form, which is what the Forms page shows on load.
import { NextResponse } from "next/server";
import { requireStaff, isAuthFailure, sbGet, errorResponse, badRequest, clampInt } from "../../pipeline/_lib";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SELECT =
  "id,form_id,contact_id,data,ip,user_agent,source_url,created_at," +
  "forms(slug,name,client_slug),crm_contacts(id,business_name)";

export async function GET(req: Request) {
  const auth = await requireStaff();
  if (isAuthFailure(auth)) return auth;

  const sp = new URL(req.url).searchParams;
  const formId = sp.get("form_id");
  const limit = clampInt(sp.get("limit"), 50, 1, 500);
  if (formId && !/^[0-9a-f-]{36}$/i.test(formId)) return badRequest("form_id must be a form id.");

  try {
    const filters = [formId ? `form_id=eq.${encodeURIComponent(formId)}` : "", "order=created_at.desc", `limit=${limit}`]
      .filter(Boolean)
      .join("&");
    const submissions = await sbGet("form_submissions", SELECT, filters);
    return NextResponse.json({ ok: true, submissions, paging: { limit, returned: submissions.length } });
  } catch (e) {
    return errorResponse(e);
  }
}
