// GET    /api/clients/keys?client_slug=   staff: list that client's keys (full
//                                         key value included — staff need it to
//                                         build the dashboard link)
// POST   /api/clients/keys               staff: mint a key {client_slug, label?}
// DELETE /api/clients/keys?id=           staff: revoke a key (active=false)
//
// Backs per-client dashboard access. Staff-only via requireStaff (same gate as
// the CRM). The dashboard route itself verifies keys with verifyClientKey.
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
} from "../../pipeline/_lib";
import { mintClientKey, type DashboardKeyRow } from "@/app/lib/clientKeys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SLUG_RE = /^[a-z0-9-]{2,60}$/;
const KEY_SELECT = "id,client_slug,key,label,active,created_at,last_used_at";

export async function GET(req: Request) {
  const auth = await requireStaff();
  if (isAuthFailure(auth)) return auth;

  const slug = new URL(req.url).searchParams.get("client_slug")?.toLowerCase() ?? "";
  if (!SLUG_RE.test(slug)) {
    return badRequest("client_slug is required: 2 to 60 lowercase letters, digits, and dashes.");
  }
  try {
    const keys = await sbGet<DashboardKeyRow>(
      "client_dashboard_keys",
      KEY_SELECT,
      `client_slug=eq.${encodeURIComponent(slug)}&order=created_at.desc&limit=200`
    );
    return NextResponse.json({ ok: true, keys });
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

  const slug = nullableText(body.client_slug)?.toLowerCase() ?? null;
  if (!slug || !SLUG_RE.test(slug)) {
    return badRequest("client_slug must be 2 to 60 characters: lowercase letters, digits, and dashes.");
  }
  const label = nullableText(body.label);

  try {
    const created = await sbPost<DashboardKeyRow>("client_dashboard_keys", {
      client_slug: slug,
      key: mintClientKey(),
      label: label ? label.slice(0, 200) : null,
      active: true,
    });
    return NextResponse.json({ ok: true, key: created }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function DELETE(req: Request) {
  const auth = await requireStaff();
  if (isAuthFailure(auth)) return auth;

  const id = new URL(req.url).searchParams.get("id") ?? "";
  if (!/^\d+$/.test(id)) return badRequest("id (numeric key id) is required.");
  try {
    const rows = await sbPatch<DashboardKeyRow>(
      "client_dashboard_keys",
      `id=eq.${encodeURIComponent(id)}`,
      { active: false }
    );
    if (!rows.length) {
      return NextResponse.json({ error: "not_found", message: "No key with that id." }, { status: 404 });
    }
    return NextResponse.json({ ok: true, revoked: rows[0].id });
  } catch (e) {
    return errorResponse(e);
  }
}
