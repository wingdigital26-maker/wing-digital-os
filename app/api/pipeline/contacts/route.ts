// GET  /api/pipeline/contacts — searchable, paginated contact list.
// POST /api/pipeline/contacts — create one contact.
//
// Query params: q (matches business/contact name, email, phone), limit, offset,
// stage (stage KEY — contacts having an open deal in that stage), trade.
//
// UNKNOWNS: every optional column is stored NULL when not supplied. A contact
// with no known phone has phone = null, never "" and never a placeholder — the
// UI must be able to ask "do we have a number for this business" and get a real
// answer.
import { NextResponse } from "next/server";
import {
  requireStaff,
  isAuthFailure,
  sbGet,
  sbGetPaged,
  sbPost,
  errorResponse,
  badRequest,
  nullableText,
  clampInt,
  esc,
} from "../_lib";
import { emitEvent } from "@/lib/automations/emit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CONTACT_SELECT =
  "id,business_name,contact_name,title,email,phone,website,city,state,trade," +
  "source,source_ref,verified_at,do_not_contact,dnc_reason,notes,owner_id,created_at,updated_at";

export async function GET(req: Request) {
  const auth = await requireStaff();
  if (isAuthFailure(auth)) return auth;

  const sp = new URL(req.url).searchParams;
  const q = nullableText(sp.get("q"));
  const trade = nullableText(sp.get("trade"));
  const stage = nullableText(sp.get("stage"));
  const limit = clampInt(sp.get("limit"), 50, 1, 200);
  const offset = clampInt(sp.get("offset"), 0, 0, 1_000_000);

  try {
    const filters: string[] = [];

    if (q) {
      const like = `*${esc(q)}*`;
      filters.push(
        `or=(business_name.ilike.${like},contact_name.ilike.${like},email.ilike.${like},phone.ilike.${like})`
      );
    }
    if (trade) filters.push(`trade=eq.${esc(trade)}`);

    // stage filter: resolve the stage key to its id, then to the contact ids
    // holding an OPEN deal there. Two small reads beat an un-indexable join
    // expressed through PostgREST embedding.
    if (stage) {
      const stageRows = await sbGet<{ id: number }>(
        "crm_stages",
        "id",
        `key=eq.${esc(stage)}`
      );
      if (!stageRows.length) {
        return badRequest(`Unknown stage "${stage}".`);
      }
      const dealRows = await sbGet<{ contact_id: number }>(
        "crm_deals",
        "contact_id",
        `stage_id=eq.${stageRows[0].id}&status=eq.open`
      );
      const ids = Array.from(new Set(dealRows.map((d) => d.contact_id)));
      if (!ids.length) {
        // Honest empty: the query worked and there genuinely is nobody here.
        return NextResponse.json({
          ok: true,
          contacts: [],
          paging: { limit, offset, returned: 0, total: 0 },
          filters: { q, trade, stage },
        });
      }
      filters.push(`id=in.(${ids.join(",")})`);
    }

    const query = [...filters, "order=updated_at.desc"].join("&");
    const { rows, total } = await sbGetPaged<Record<string, unknown>>(
      "crm_contacts",
      CONTACT_SELECT,
      query,
      offset,
      limit
    );

    return NextResponse.json({
      ok: true,
      contacts: rows,
      paging: { limit, offset, returned: rows.length, total },
      filters: { q, trade, stage },
    });
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

  const business_name = nullableText(body.business_name);
  if (!business_name) {
    return badRequest("business_name is required.");
  }

  const row: Record<string, unknown> = {
    business_name,
    contact_name: nullableText(body.contact_name),
    title: nullableText(body.title),
    email: nullableText(body.email),
    phone: nullableText(body.phone),
    website: nullableText(body.website),
    city: nullableText(body.city),
    state: nullableText(body.state),
    trade: nullableText(body.trade),
    source: nullableText(body.source) ?? "os-ui",
    source_ref: nullableText(body.source_ref),
    notes: nullableText(body.notes),
    // Suppression is a real boolean; only an explicit true sets it.
    do_not_contact: body.do_not_contact === true,
    dnc_reason: nullableText(body.dnc_reason),
    // verified_at stays NULL unless the caller says a human confirmed it.
    // "Never verified" is not the same as "unverifiable", and we do not invent
    // a timestamp just because a row was typed in.
    verified_at: body.verified === true ? new Date().toISOString() : null,
    owner_id: auth.userId,
  };

  try {
    const created = await sbPost<{ id: number }>("crm_contacts", row);
    // Automation hook: a hand-entered contact is still a new contact. Wrapped
    // so a failed emit never changes the 201.
    try {
      await emitEvent({
        type: "contact.created",
        contact_id: created.id,
        payload: { source: "os-ui" },
      });
    } catch {
      // The contact exists; nothing else depends on this.
    }
    return NextResponse.json({ ok: true, contact: created }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
