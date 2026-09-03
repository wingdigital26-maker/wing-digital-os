// GET    /api/forms            staff: every form with its submission count
// POST   /api/forms            staff: create {slug, name, client_slug?, fields?, redirect_url?}
// PATCH  /api/forms            staff: {id, status|name|redirect_url|fields}
// DELETE /api/forms?id=        staff: remove a form (its submissions cascade)
//
// The public side of a form lives at /api/forms/[slug]. This file is the admin
// side only. Slugs are the URL a client site posts to, so they are validated
// here once and never trusted again.
import { NextResponse } from "next/server";
import {
  requireStaff,
  isAuthFailure,
  sbGet,
  sbPost,
  sbPatch,
  sbDelete,
  errorResponse,
  badRequest,
  nullableText,
  SbError,
} from "../pipeline/_lib";
import type { FormRow } from "@/lib/automations/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SLUG_RE = /^[a-z0-9-]{2,60}$/;
const FORM_SELECT = "id,slug,name,client_slug,fields,redirect_url,status,submissions,created_at,updated_at";

// Reserved: these collide with staff routes under /api/forms/.
const RESERVED_SLUGS = new Set(["submissions"]);

function cleanFields(v: unknown): FormRow["fields"] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) return undefined;
  const out: FormRow["fields"] = [];
  for (const f of v.slice(0, 50)) {
    if (!f || typeof f !== "object") continue;
    const key = nullableText((f as any).key);
    if (!key) continue;
    out.push({
      key: key.slice(0, 60),
      label: nullableText((f as any).label)?.slice(0, 120) ?? key,
      type: nullableText((f as any).type)?.slice(0, 30) ?? "text",
      required: (f as any).required === true,
    });
  }
  return out;
}

function cleanRedirect(v: unknown): string | null | undefined {
  if (v === undefined) return undefined;
  const t = nullableText(v);
  if (t === null) return null;
  return /^https?:\/\/\S+$/i.test(t) ? t.slice(0, 1000) : undefined;
}

export async function GET() {
  const auth = await requireStaff();
  if (isAuthFailure(auth)) return auth;
  try {
    const forms = await sbGet<FormRow>("forms", FORM_SELECT, "order=created_at.desc&limit=500");
    return NextResponse.json({ ok: true, forms });
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

  const slug = nullableText(body.slug)?.toLowerCase() ?? null;
  if (!slug || !SLUG_RE.test(slug)) {
    return badRequest("slug must be 2 to 60 characters: lowercase letters, digits, and dashes only.");
  }
  if (RESERVED_SLUGS.has(slug)) return badRequest(`"${slug}" is reserved. Pick another slug.`);

  const name = nullableText(body.name);
  if (!name) return badRequest("name is required.");

  const clientSlug = nullableText(body.client_slug);
  if (clientSlug && !/^[a-z0-9-]{1,60}$/.test(clientSlug)) {
    return badRequest("client_slug must be lowercase letters, digits, and dashes.");
  }

  const redirect = cleanRedirect(body.redirect_url);
  if (redirect === undefined && body.redirect_url !== undefined && nullableText(body.redirect_url) !== null) {
    return badRequest("redirect_url must start with http:// or https://, or be empty.");
  }
  const fields = cleanFields(body.fields);
  if (fields === undefined && body.fields !== undefined) {
    return badRequest("fields must be a list of {key, label, type, required}.");
  }

  try {
    const dupe = await sbGet<{ id: string }>("forms", "id", `slug=eq.${encodeURIComponent(slug)}&limit=1`);
    if (dupe.length) {
      return NextResponse.json(
        { error: "conflict", message: `A form with the slug "${slug}" already exists. Pick a different slug.` },
        { status: 409 }
      );
    }
    const created = await sbPost<FormRow>("forms", {
      slug,
      name: name.slice(0, 200),
      client_slug: clientSlug,
      fields: fields ?? [],
      redirect_url: redirect ?? null,
      status: "active",
    });
    return NextResponse.json({ ok: true, form: created }, { status: 201 });
  } catch (e) {
    // A race on the unique index lands here as a 409 from PostgREST.
    if (e instanceof SbError && (e.detail ?? "").includes("23505")) {
      return NextResponse.json(
        { error: "conflict", message: `A form with the slug "${slug}" already exists. Pick a different slug.` },
        { status: 409 }
      );
    }
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
  const id = nullableText(body.id);
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) return badRequest("id (form id) is required.");

  const patch: Record<string, unknown> = {};
  if (body.status !== undefined) {
    const s = nullableText(body.status);
    if (s !== "active" && s !== "paused") return badRequest("status must be active or paused.");
    patch.status = s;
  }
  if (body.name !== undefined) {
    const n = nullableText(body.name);
    if (!n) return badRequest("name cannot be blank.");
    patch.name = n.slice(0, 200);
  }
  if (body.redirect_url !== undefined) {
    const r = cleanRedirect(body.redirect_url);
    if (r === undefined) return badRequest("redirect_url must start with http:// or https://, or be empty.");
    patch.redirect_url = r;
  }
  if (body.fields !== undefined) {
    const f = cleanFields(body.fields);
    if (f === undefined) return badRequest("fields must be a list of {key, label, type, required}.");
    patch.fields = f;
  }
  if (body.client_slug !== undefined) {
    const c = nullableText(body.client_slug);
    if (c && !/^[a-z0-9-]{1,60}$/.test(c)) return badRequest("client_slug must be lowercase letters, digits, and dashes.");
    patch.client_slug = c;
  }
  if (!Object.keys(patch).length) return badRequest("Nothing to update.");

  try {
    const rows = await sbPatch<FormRow>("forms", `id=eq.${encodeURIComponent(id)}`, patch);
    if (!rows.length) {
      return NextResponse.json({ error: "not_found", message: "No form with that id." }, { status: 404 });
    }
    return NextResponse.json({ ok: true, form: rows[0] });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function DELETE(req: Request) {
  const auth = await requireStaff();
  if (isAuthFailure(auth)) return auth;
  const id = new URL(req.url).searchParams.get("id") ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(id)) return badRequest("id (form id) is required.");
  try {
    const rows = await sbDelete<{ id: string }>("forms", `id=eq.${encodeURIComponent(id)}`);
    if (!rows.length) {
      return NextResponse.json({ error: "not_found", message: "No form with that id." }, { status: 404 });
    }
    return NextResponse.json({ ok: true, deleted: rows[0].id });
  } catch (e) {
    return errorResponse(e);
  }
}
