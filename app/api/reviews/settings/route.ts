// GET   /api/reviews/settings              staff: list clients with their
//                                            google_review_url (null when unset)
// POST  /api/reviews/settings               staff: {client_slug, google_review_url}
//                                            upsert-style: PATCH if the client row
//                                            exists, otherwise create a minimal one
// PATCH /api/reviews/settings               staff: same body, requires the row to
//                                            already exist (404 if not)
//
// Round-1 added clients.google_review_url (migration referenced in
// app/api/reviews/send/route.ts) and a send pipeline that reads it, but nothing
// in the UI could ever SET it — so the feature could never actually be used.
// This route is the missing write path. It never sends anything and never
// exposes a service key; it only lets staff attach/replace a review link.
//
// Auth mirrors /api/reviews/send and every /api/pipeline/** route exactly:
// a staff OS session OR the machine key header x-heartbeat-key = HEARTBEAT_KEY.
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getOsSession, hasLegacyAuth } from "@/lib/osSupabase";
import { sbGet, sbPatch, sbPost, errorResponse, badRequest, nullableText, esc, SbError } from "../../pipeline/_lib";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STAFF = new Set(["admin", "owner", "staff"]);
const SLUG_RE = /^[a-z0-9-]{1,60}$/;

async function authorized(req: NextRequest): Promise<boolean> {
  const machineKey = process.env.HEARTBEAT_KEY;
  if (machineKey && req.headers.get("x-heartbeat-key") === machineKey) return true;
  const session = await getOsSession();
  if (session) return STAFF.has(session.role);
  return await hasLegacyAuth();
}

type ClientRow = {
  slug: string;
  name: string | null;
  google_review_url: string | null;
};

function tableMissing(e: unknown): boolean {
  if (!(e instanceof SbError)) return false;
  const d = (e.detail || "").toLowerCase();
  return d.includes("42p01") || d.includes("does not exist") || d.includes("could not find the table");
}

function columnMissing(e: unknown): boolean {
  if (!(e instanceof SbError)) return false;
  const d = (e.detail || "").toLowerCase();
  return d.includes("google_review_url") && (d.includes("42703") || d.includes("does not exist") || d.includes("could not find"));
}

// A real review link, not just any https URL, is what makes the send pipeline
// useful. We accept any https(s) URL (the send route's own comment says "any
// https" is fine) but flag when it plainly is not a Google link, purely as UI
// guidance -- the API itself never rejects a valid https URL for this reason.
function looksLikeGoogleReview(url: string): boolean {
  return /google\.com\/(maps|search)|g\.page|goo\.gl/i.test(url);
}

function validateUrl(raw: unknown): { ok: true; url: string; isGoogle: boolean } | { ok: false; error: string } {
  const v = nullableText(raw);
  if (!v) return { ok: false, error: "google_review_url is required." };
  let parsed: URL;
  try {
    parsed = new URL(v);
  } catch {
    return { ok: false, error: "That is not a valid URL." };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { ok: false, error: "The link must start with http:// or https://." };
  }
  if (parsed.protocol !== "https:") {
    return { ok: false, error: "Use an https:// link (http:// is not accepted)." };
  }
  return { ok: true, url: v, isGoogle: looksLikeGoogleReview(v) };
}

export async function GET(req: NextRequest) {
  if (!(await authorized(req))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  try {
    const rows = await sbGet<ClientRow>("clients", "slug,name,google_review_url", "order=slug.asc&limit=500");
    return NextResponse.json({ ok: true, available: true, clients: rows });
  } catch (e) {
    if (tableMissing(e)) {
      return NextResponse.json({
        ok: true,
        available: false,
        reason: "The clients table does not exist in the OS database yet.",
        clients: [],
      });
    }
    if (columnMissing(e)) {
      return NextResponse.json({
        ok: true,
        available: false,
        reason: "clients.google_review_url does not exist yet. Run the round-1 migration that adds it.",
        clients: [],
      });
    }
    return errorResponse(e);
  }
}

async function upsert(req: NextRequest, requireExisting: boolean) {
  if (!(await authorized(req))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return badRequest("Body must be JSON.");
  }

  const slug = nullableText(body.client_slug)?.toLowerCase() ?? null;
  if (!slug || !SLUG_RE.test(slug)) {
    return badRequest("client_slug is required: lowercase letters, digits, and dashes.");
  }

  // Allow explicitly clearing the link by sending an empty string / null.
  const clearing = body.google_review_url === null || body.google_review_url === "";
  let url: string | null = null;
  let isGoogle = false;
  if (!clearing) {
    const v = validateUrl(body.google_review_url);
    if (!v.ok) return badRequest(v.error);
    url = v.url;
    isGoogle = v.isGoogle;
  }

  try {
    const existing = await sbGet<{ slug: string }>("clients", "slug", `slug=eq.${esc(slug)}&limit=1`);
    if (existing.length) {
      const rows = await sbPatch<ClientRow>("clients", `slug=eq.${esc(slug)}`, { google_review_url: url });
      return NextResponse.json({ ok: true, client: rows[0], isGoogle });
    }
    if (requireExisting) {
      return NextResponse.json(
        { ok: false, error: "not_found", message: `No client with slug "${slug}".` },
        { status: 404 }
      );
    }
    const nameGuess = slug.split("-").filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
    const created = await sbPost<ClientRow>("clients", { slug, name: nameGuess, google_review_url: url });
    return NextResponse.json({ ok: true, client: created, isGoogle }, { status: 201 });
  } catch (e) {
    if (tableMissing(e)) {
      return NextResponse.json(
        { ok: false, error: "table_missing", message: "The clients table does not exist in the OS database yet." },
        { status: 503 }
      );
    }
    if (columnMissing(e)) {
      return NextResponse.json(
        { ok: false, error: "column_missing", message: "clients.google_review_url does not exist yet. Run the round-1 migration that adds it." },
        { status: 503 }
      );
    }
    return errorResponse(e);
  }
}

// POST creates the client row if it does not exist yet (so a client that has
// no vault page / roster row can still get a review link set); PATCH requires
// the row to already exist.
export async function POST(req: NextRequest) {
  return upsert(req, false);
}

export async function PATCH(req: NextRequest) {
  return upsert(req, true);
}
