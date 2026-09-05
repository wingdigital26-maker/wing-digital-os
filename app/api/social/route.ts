// GET    /api/social                staff: list posts, optional ?client_slug= ?status=
// POST   /api/social                staff: create {client_slug?, platform, caption, image_url?, scheduled_for?}
// PATCH  /api/social                staff: {id, status|caption|scheduled_for|image_url|platform|notes}
// DELETE /api/social?id=            staff: remove a post
//
// DRAFT AND SCHEDULE ONLY. This route never publishes to any social network and
// connects to no social API. "posted" is a human marking that they posted it
// themselves. Status flow: draft -> scheduled -> posted (archived is a shelf).
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

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SELECT =
  "id,client_slug,platform,caption,image_url,scheduled_for,status,posted_at,notes,created_at,updated_at";

const PLATFORMS = new Set(["facebook", "instagram", "google", "nextdoor", "other"]);
const STATUSES = new Set(["draft", "scheduled", "posted", "archived"]);
const SLUG_RE = /^[a-z0-9-]{1,60}$/;
const URL_RE = /^https?:\/\/\S+$/i;

type SocialPost = {
  id: number;
  client_slug: string | null;
  platform: string;
  caption: string;
  image_url: string | null;
  scheduled_for: string | null;
  status: string;
  posted_at: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

// A missing table is a real state, not a failure: migration 0028 has not run
// yet. Every route in this OS reports that honestly (see /api/storms).
function isMissingTable(e: unknown): boolean {
  return (
    e instanceof SbError &&
    /social_posts|does not exist|PGRST205|42P01/i.test(e.detail || "")
  );
}

const MISSING = {
  error: "run migration 0028_social_posts.sql",
  missingTable: true,
  posts: [] as SocialPost[],
};

// A date the user typed or picked. undefined = key absent (leave alone),
// null = explicitly cleared, a string = an ISO timestamp we could parse.
function cleanDate(v: unknown): string | null | undefined {
  if (v === undefined) return undefined;
  const t = nullableText(v);
  if (t === null) return null;
  const ms = Date.parse(t);
  if (!Number.isFinite(ms)) return undefined;
  return new Date(ms).toISOString();
}

function cleanImage(v: unknown): string | null | undefined {
  if (v === undefined) return undefined;
  const t = nullableText(v);
  if (t === null) return null;
  return URL_RE.test(t) ? t.slice(0, 1000) : undefined;
}

export async function GET(req: Request) {
  const auth = await requireStaff();
  if (isAuthFailure(auth)) return auth;

  const params = new URL(req.url).searchParams;
  const filters: string[] = [];
  const clientSlug = nullableText(params.get("client_slug"));
  if (clientSlug) {
    if (!SLUG_RE.test(clientSlug)) return badRequest("client_slug must be lowercase letters, digits, and dashes.");
    filters.push(`client_slug=eq.${encodeURIComponent(clientSlug)}`);
  }
  const status = nullableText(params.get("status"));
  if (status) {
    if (!STATUSES.has(status)) return badRequest("status must be draft, scheduled, posted, or archived.");
    filters.push(`status=eq.${encodeURIComponent(status)}`);
  }

  // Soonest scheduled first (unscheduled drafts sort last with nulls), then
  // newest created. This puts what is coming up next at the top of the board.
  const query =
    (filters.length ? `${filters.join("&")}&` : "") +
    "order=scheduled_for.asc.nullslast,created_at.desc&limit=500";

  try {
    const posts = await sbGet<SocialPost>("social_posts", SELECT, query);
    return NextResponse.json({ ok: true, missingTable: false, posts });
  } catch (e) {
    if (isMissingTable(e)) return NextResponse.json(MISSING, { status: 200 });
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

  const caption = nullableText(body.caption);
  if (!caption) return badRequest("caption is required.");

  const platform = nullableText(body.platform) ?? "other";
  if (!PLATFORMS.has(platform)) return badRequest("platform must be facebook, instagram, google, nextdoor, or other.");

  const clientSlug = nullableText(body.client_slug);
  if (clientSlug && !SLUG_RE.test(clientSlug)) {
    return badRequest("client_slug must be lowercase letters, digits, and dashes.");
  }

  const imageUrl = cleanImage(body.image_url);
  if (imageUrl === undefined && body.image_url !== undefined && nullableText(body.image_url) !== null) {
    return badRequest("image_url must start with http:// or https://, or be empty.");
  }

  const scheduledFor = cleanDate(body.scheduled_for);
  if (scheduledFor === undefined && body.scheduled_for !== undefined && nullableText(body.scheduled_for) !== null) {
    return badRequest("scheduled_for must be a valid date, or be empty.");
  }

  // A post given a date is scheduled; without one it is a plain draft. The
  // human always moves it to "posted" by hand later; nothing here does that.
  const status = scheduledFor ? "scheduled" : "draft";

  try {
    const created = await sbPost<SocialPost>("social_posts", {
      client_slug: clientSlug,
      platform,
      caption: caption.slice(0, 5000),
      image_url: imageUrl ?? null,
      scheduled_for: scheduledFor ?? null,
      status,
    });
    return NextResponse.json({ ok: true, post: created }, { status: 201 });
  } catch (e) {
    if (isMissingTable(e)) return NextResponse.json(MISSING, { status: 200 });
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
  if (!id || !/^[0-9]+$/.test(id)) return badRequest("id (post id) is required.");

  const patch: Record<string, unknown> = {};

  if (body.status !== undefined) {
    const s = nullableText(body.status);
    if (!s || !STATUSES.has(s)) return badRequest("status must be draft, scheduled, posted, or archived.");
    patch.status = s;
    // Marking posted stamps posted_at; moving away from posted clears it, so
    // the timestamp always tells the truth about the current status.
    patch.posted_at = s === "posted" ? new Date().toISOString() : null;
  }
  if (body.caption !== undefined) {
    const c = nullableText(body.caption);
    if (!c) return badRequest("caption cannot be blank.");
    patch.caption = c.slice(0, 5000);
  }
  if (body.platform !== undefined) {
    const p = nullableText(body.platform);
    if (!p || !PLATFORMS.has(p)) return badRequest("platform must be facebook, instagram, google, nextdoor, or other.");
    patch.platform = p;
  }
  if (body.image_url !== undefined) {
    const img = cleanImage(body.image_url);
    if (img === undefined) return badRequest("image_url must start with http:// or https://, or be empty.");
    patch.image_url = img;
  }
  if (body.scheduled_for !== undefined) {
    const d = cleanDate(body.scheduled_for);
    if (d === undefined) return badRequest("scheduled_for must be a valid date, or be empty.");
    patch.scheduled_for = d;
  }
  if (body.notes !== undefined) {
    patch.notes = nullableText(body.notes);
  }

  if (!Object.keys(patch).length) return badRequest("Nothing to update.");

  try {
    const rows = await sbPatch<SocialPost>("social_posts", `id=eq.${encodeURIComponent(id)}`, patch);
    if (!rows.length) {
      return NextResponse.json({ error: "not_found", message: "No post with that id." }, { status: 404 });
    }
    return NextResponse.json({ ok: true, post: rows[0] });
  } catch (e) {
    if (isMissingTable(e)) return NextResponse.json(MISSING, { status: 200 });
    return errorResponse(e);
  }
}

export async function DELETE(req: Request) {
  const auth = await requireStaff();
  if (isAuthFailure(auth)) return auth;
  const id = new URL(req.url).searchParams.get("id") ?? "";
  if (!/^[0-9]+$/.test(id)) return badRequest("id (post id) is required.");
  try {
    const rows = await sbDelete<{ id: number }>("social_posts", `id=eq.${encodeURIComponent(id)}`);
    if (!rows.length) {
      return NextResponse.json({ error: "not_found", message: "No post with that id." }, { status: 404 });
    }
    return NextResponse.json({ ok: true, deleted: rows[0].id });
  } catch (e) {
    if (isMissingTable(e)) return NextResponse.json(MISSING, { status: 200 });
    return errorResponse(e);
  }
}
