import { NextResponse } from "next/server";
import { requireStaff, isAuthFailure, errorResponse, badRequest, nullableText, sbGet, esc } from "@/app/api/pipeline/_lib";
import { sbInsertOrConflict, sbDelete } from "@/lib/automations/db";

// ───────────────────────────────────────────────────────────────────────────
// /api/automations/tags: GHL-style tags on a contact. Staff only.
//
//   GET    ?contact_id=            list that contact's tags (newest first)
//   POST   {contact_id, tag}       add; adding a tag twice is not an error
//   DELETE ?contact_id=&tag=       remove; removing a tag that was not there
//                                  answers 404 so a stale UI notices
//
// Tags are free text, trimmed, case preserved. The PRIMARY KEY
// (contact_id, tag) is what keeps them unique.
// ───────────────────────────────────────────────────────────────────────────

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type TagRow = { contact_id: number; tag: string; created_at: string };

function contactIdFrom(v: unknown): number | null {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export async function GET(req: Request) {
  const auth = await requireStaff();
  if (isAuthFailure(auth)) return auth;
  try {
    const contactId = contactIdFrom(new URL(req.url).searchParams.get("contact_id"));
    if (!contactId) return badRequest("contact_id is required.");
    const tags = await sbGet<TagRow>("contact_tags", "*", `contact_id=eq.${contactId}&order=created_at.desc`);
    return NextResponse.json({ contact_id: contactId, tags });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: Request) {
  const auth = await requireStaff();
  if (isAuthFailure(auth)) return auth;
  try {
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return badRequest("Body must be JSON.");
    const contactId = contactIdFrom(body.contact_id);
    const tag = nullableText(body.tag);
    if (!contactId) return badRequest("contact_id is required.");
    if (!tag) return badRequest("tag is required.");
    const c = await sbGet<{ id: number }>("crm_contacts", "id", `id=eq.${contactId}`);
    if (!c.length) return badRequest(`No contact with id ${contactId}.`);
    const r = await sbInsertOrConflict<TagRow>("contact_tags", { contact_id: contactId, tag });
    if (r.conflict) return NextResponse.json({ ok: true, added: false, contact_id: contactId, tag });
    return NextResponse.json({ ok: true, added: true, tag: r.row }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function DELETE(req: Request) {
  const auth = await requireStaff();
  if (isAuthFailure(auth)) return auth;
  try {
    const u = new URL(req.url);
    const contactId = contactIdFrom(u.searchParams.get("contact_id"));
    const tag = nullableText(u.searchParams.get("tag"));
    if (!contactId) return badRequest("contact_id is required.");
    if (!tag) return badRequest("tag is required.");
    const rows = await sbDelete<TagRow>("contact_tags", `contact_id=eq.${contactId}&tag=eq.${esc(tag)}`);
    if (!rows.length) return NextResponse.json({ error: "not_found", message: "That tag was not on this contact." }, { status: 404 });
    return NextResponse.json({ ok: true, removed: rows.length });
  } catch (e) {
    return errorResponse(e);
  }
}
