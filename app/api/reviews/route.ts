// GET    /api/reviews              staff: review requests + per-client summary
//                                  optional ?client=<slug> narrows to one client
// POST   /api/reviews              staff: queue a request {client_slug, contact_id?, channel?}
// PATCH  /api/reviews              staff: {id, status|rating|review_text|platform|notes|...}
// DELETE /api/reviews?id=          staff: remove a request
//
// This module NEVER sends anything. Queuing a request only records the intent
// to ask a contact for a review; the real SMS/email goes out through the
// automations pipe, and only when Jack arms it. Honesty rules like every OS
// board: a missing table says "run the migration", an empty table says exactly
// what would fill it, and NULL (an unknown rating) never becomes 0.
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
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
  esc,
  SbError,
} from "../pipeline/_lib";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SLUG_RE = /^[a-z0-9-]{1,60}$/;
const SELECT =
  "id,client_slug,contact_id,channel,status,rating,review_text,platform,requested_at,received_at,notes,created_at,updated_at";

const CHANNELS = new Set(["sms", "email"]);
const STATUSES = new Set(["queued", "requested", "received", "dismissed"]);
const PLATFORMS = new Set(["google", "facebook", "site", "other"]);

type ReviewRow = {
  id: number;
  client_slug: string;
  contact_id: number | null;
  channel: string;
  status: string;
  rating: number | null;
  review_text: string | null;
  platform: string | null;
  requested_at: string | null;
  received_at: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

// True when the failure smells like "the reviews table does not exist yet"
// (migration 0027 not applied), so the UI can say exactly that instead of a
// generic error.
function tableMissing(e: unknown): boolean {
  if (!(e instanceof SbError)) return false;
  const d = (e.detail || "").toLowerCase();
  return d.includes("42p01") || d.includes("does not exist") || d.includes("could not find the table");
}

const MISSING_REASON =
  "The reviews table does not exist in the OS database yet. Run migration " +
  "supabase/migrations/0027_reviews.sql, then queued requests and ratings will appear here.";

type Summary = {
  client_slug: string;
  requests: number;   // total rows for the client
  received: number;   // rows with a real star rating
  avg_rating: number | null; // average of received ratings, NULL if none received
};

// Build per-client aggregates from the rows we already have, so the summary is
// always the same reviews the list shows. avg_rating stays NULL for a client
// with no received ratings — it is never reported as 0.
function summarize(rows: ReviewRow[]): Summary[] {
  const by = new Map<string, { requests: number; ratings: number[] }>();
  for (const r of rows) {
    const g = by.get(r.client_slug) ?? { requests: 0, ratings: [] };
    g.requests += 1;
    if (typeof r.rating === "number") g.ratings.push(r.rating);
    by.set(r.client_slug, g);
  }
  const out: Summary[] = [];
  for (const [client_slug, g] of by) {
    const received = g.ratings.length;
    out.push({
      client_slug,
      requests: g.requests,
      received,
      avg_rating: received ? Math.round((g.ratings.reduce((a, b) => a + b, 0) / received) * 10) / 10 : null,
    });
  }
  out.sort((a, b) => a.client_slug.localeCompare(b.client_slug));
  return out;
}

export async function GET(req: NextRequest) {
  const auth = await requireStaff();
  if (isAuthFailure(auth)) return auth;

  const client = nullableText(req.nextUrl.searchParams.get("client"));
  if (client && !SLUG_RE.test(client)) {
    return badRequest("client must be lowercase letters, digits, and dashes.");
  }

  try {
    // Rows for the summary always cover every client, so filtering to one
    // client never makes the other clients' averages vanish. The list is
    // filtered; the summary is not.
    const filter = client ? `client_slug=eq.${esc(client)}&` : "";
    const [listRows, allRows] = await Promise.all([
      sbGet<ReviewRow>("reviews", SELECT, `${filter}order=created_at.desc&limit=1000`),
      client
        ? sbGet<ReviewRow>("reviews", "client_slug,rating", "limit=5000")
        : Promise.resolve(null),
    ]);
    const summary = summarize((allRows as ReviewRow[] | null) ?? listRows);
    return NextResponse.json({
      available: true,
      tableMissing: false,
      reason: null,
      reviews: listRows,
      summary,
    });
  } catch (e) {
    if (tableMissing(e)) {
      return NextResponse.json({
        available: false,
        tableMissing: true,
        reason: MISSING_REASON,
        reviews: [],
        summary: [],
      });
    }
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

  const clientSlug = nullableText(body.client_slug)?.toLowerCase() ?? null;
  if (!clientSlug || !SLUG_RE.test(clientSlug)) {
    return badRequest("client_slug is required: lowercase letters, digits, and dashes.");
  }

  let contactId: number | null = null;
  if (body.contact_id !== undefined && body.contact_id !== null && body.contact_id !== "") {
    const n = typeof body.contact_id === "number" ? body.contact_id : Number(body.contact_id);
    if (!Number.isInteger(n) || n <= 0) return badRequest("contact_id must be a positive whole number.");
    contactId = n;
  }

  let channel = "sms";
  if (body.channel !== undefined) {
    const c = nullableText(body.channel);
    if (!c || !CHANNELS.has(c)) return badRequest("channel must be sms or email.");
    channel = c;
  }

  const notes = nullableText(body.notes);

  try {
    const created = await sbPost<ReviewRow>("reviews", {
      client_slug: clientSlug,
      contact_id: contactId,
      channel,
      status: "queued",
      notes: notes ?? null,
    });
    return NextResponse.json({ ok: true, review: created }, { status: 201 });
  } catch (e) {
    if (tableMissing(e)) {
      return NextResponse.json({ error: "table_missing", message: MISSING_REASON, missingTable: true });
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

  const idNum = typeof body.id === "number" ? body.id : Number(nullableText(body.id));
  if (!Number.isInteger(idNum) || idNum <= 0) return badRequest("id (review id) is required.");

  const patch: Record<string, unknown> = {};

  if (body.status !== undefined) {
    const s = nullableText(body.status);
    if (!s || !STATUSES.has(s)) return badRequest("status must be queued, requested, received, or dismissed.");
    patch.status = s;
    // Stamp the moment the ask went out / the rating came back so the timeline
    // is real, without overwriting a stamp the caller set explicitly below.
    if (s === "requested" && body.requested_at === undefined) patch.requested_at = new Date().toISOString();
    if (s === "received" && body.received_at === undefined) patch.received_at = new Date().toISOString();
  }

  if (body.rating !== undefined) {
    if (body.rating === null || body.rating === "") {
      patch.rating = null; // explicitly unknown again
    } else {
      const n = typeof body.rating === "number" ? body.rating : Number(body.rating);
      if (!Number.isInteger(n) || n < 1 || n > 5) return badRequest("rating must be a whole number from 1 to 5.");
      patch.rating = n;
    }
  }

  if (body.review_text !== undefined) patch.review_text = nullableText(body.review_text);

  if (body.platform !== undefined) {
    if (body.platform === null || body.platform === "") {
      patch.platform = null;
    } else {
      const p = nullableText(body.platform);
      if (!p || !PLATFORMS.has(p)) return badRequest("platform must be google, facebook, site, or other.");
      patch.platform = p;
    }
  }

  if (body.channel !== undefined) {
    const c = nullableText(body.channel);
    if (!c || !CHANNELS.has(c)) return badRequest("channel must be sms or email.");
    patch.channel = c;
  }

  if (body.notes !== undefined) patch.notes = nullableText(body.notes);

  if (body.requested_at !== undefined) {
    patch.requested_at = body.requested_at === null || body.requested_at === "" ? null : nullableText(body.requested_at);
  }
  if (body.received_at !== undefined) {
    patch.received_at = body.received_at === null || body.received_at === "" ? null : nullableText(body.received_at);
  }

  if (!Object.keys(patch).length) return badRequest("Nothing to update.");

  try {
    const rows = await sbPatch<ReviewRow>("reviews", `id=eq.${idNum}`, patch);
    if (!rows.length) {
      return NextResponse.json({ error: "not_found", message: "No review request with that id." }, { status: 404 });
    }
    return NextResponse.json({ ok: true, review: rows[0] });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function DELETE(req: NextRequest) {
  const auth = await requireStaff();
  if (isAuthFailure(auth)) return auth;
  const idNum = Number(req.nextUrl.searchParams.get("id"));
  if (!Number.isInteger(idNum) || idNum <= 0) return badRequest("id (review id) is required.");
  try {
    const rows = await sbDelete<{ id: number }>("reviews", `id=eq.${idNum}`);
    if (!rows.length) {
      return NextResponse.json({ error: "not_found", message: "No review request with that id." }, { status: 404 });
    }
    return NextResponse.json({ ok: true, deleted: rows[0].id });
  } catch (e) {
    return errorResponse(e);
  }
}
