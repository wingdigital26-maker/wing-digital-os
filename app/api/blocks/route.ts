import { NextResponse } from "next/server";
import { getOsSession, hasLegacyAuth, sbUrl, sbService } from "@/lib/osSupabase";

// ───────────────────────────────────────────────────────────────────────────
// Time-blocks API — CRUD for the manual blocks Jack lays onto the calendar.
//
// Backed by the OS Supabase project's `calendar_blocks` table (migration
// 0015). Staff-only, same double lock as /api/crm: middleware keeps client
// sessions off /api/*, and this route re-checks the role so the data never
// depends on a matcher staying correct. Writes go through the service key;
// RLS on the table is defense in depth.
//
// Reading for DISPLAY happens in /api/calendar (the blocks lane there expands
// weekly repeats into dated instances). This route is only how blocks are
// created, edited and deleted.
// ───────────────────────────────────────────────────────────────────────────

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STAFF_ROLES = new Set(["admin", "owner", "staff"]);

async function isStaff(): Promise<boolean> {
  const session = await getOsSession();
  if (session) return STAFF_ROLES.has(session.role);
  // Legacy shared-password access is Jack himself.
  return await hasLegacyAuth();
}

export const CATEGORIES = ["study", "call", "work", "personal", "other"] as const;

type BlockBody = {
  id?: string;
  title?: string;
  date?: string;
  start_time?: string;
  end_time?: string;
  category?: string;
  notes?: string | null;
  recurrence?: string | null;
};

// Validate exactly what the table would reject anyway, but with readable
// errors instead of a PostgREST status code.
function validate(b: BlockBody, forInsert: boolean): string | null {
  if (forInsert || b.title !== undefined) {
    if (!b.title || !b.title.trim()) return "A block needs a title.";
  }
  if (forInsert || b.date !== undefined) {
    if (!b.date || !/^\d{4}-\d{2}-\d{2}$/.test(b.date)) return "Date must be YYYY-MM-DD.";
  }
  const t = /^\d{2}:\d{2}(:\d{2})?$/;
  if (forInsert || b.start_time !== undefined) {
    if (!b.start_time || !t.test(b.start_time)) return "Start time must be HH:MM.";
  }
  if (forInsert || b.end_time !== undefined) {
    if (!b.end_time || !t.test(b.end_time)) return "End time must be HH:MM.";
  }
  if (b.start_time && b.end_time && b.end_time <= b.start_time) {
    return "The block must end after it starts.";
  }
  if (b.category !== undefined && !CATEGORIES.includes(b.category as (typeof CATEGORIES)[number])) {
    return `Category must be one of: ${CATEGORIES.join(", ")}.`;
  }
  if (b.recurrence != null && b.recurrence !== "weekly") {
    return "Recurrence is either empty (one-off) or 'weekly'.";
  }
  return null;
}

function pick(b: BlockBody): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (b.title !== undefined) out.title = b.title.trim();
  if (b.date !== undefined) out.date = b.date;
  if (b.start_time !== undefined) out.start_time = b.start_time;
  if (b.end_time !== undefined) out.end_time = b.end_time;
  if (b.category !== undefined) out.category = b.category;
  if (b.notes !== undefined) out.notes = b.notes?.trim() || null;
  if (b.recurrence !== undefined) out.recurrence = b.recurrence || null;
  return out;
}

function db() {
  const url = sbUrl();
  const key = sbService();
  if (!url || !key) return null;
  return { url, key };
}

async function rest(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  qs: string,
  body?: unknown
) {
  const c = db();
  if (!c) return null;
  return fetch(`${c.url}/rest/v1/calendar_blocks${qs}`, {
    method,
    headers: {
      apikey: c.key,
      Authorization: `Bearer ${c.key}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });
}

const noDb = () =>
  NextResponse.json(
    { error: "OS Supabase is not configured (OS_SUPABASE_URL / OS_SUPABASE_SERVICE_KEY)." },
    { status: 503 }
  );

export async function GET() {
  if (!(await isStaff())) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const res = await rest("GET", "?select=*&order=date.asc,start_time.asc");
  if (!res) return noDb();
  if (!res.ok) return NextResponse.json({ error: `Read failed (HTTP ${res.status})` }, { status: 502 });
  return NextResponse.json({ blocks: await res.json() });
}

export async function POST(req: Request) {
  if (!(await isStaff())) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => null)) as BlockBody | null;
  if (!body) return NextResponse.json({ error: "Bad JSON body." }, { status: 400 });
  const bad = validate(body, true);
  if (bad) return NextResponse.json({ error: bad }, { status: 400 });
  const res = await rest("POST", "", { category: "work", ...pick(body) });
  if (!res) return noDb();
  if (!res.ok) return NextResponse.json({ error: `Insert failed (HTTP ${res.status})` }, { status: 502 });
  const rows = await res.json();
  return NextResponse.json({ block: rows?.[0] ?? null });
}

export async function PATCH(req: Request) {
  if (!(await isStaff())) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => null)) as BlockBody | null;
  if (!body?.id) return NextResponse.json({ error: "id is required." }, { status: 400 });
  const bad = validate(body, false);
  if (bad) return NextResponse.json({ error: bad }, { status: 400 });
  const patch = pick(body);
  if (!Object.keys(patch).length) return NextResponse.json({ error: "Nothing to update." }, { status: 400 });
  const res = await rest("PATCH", `?id=eq.${encodeURIComponent(body.id)}`, patch);
  if (!res) return noDb();
  if (!res.ok) return NextResponse.json({ error: `Update failed (HTTP ${res.status})` }, { status: 502 });
  const rows = await res.json();
  if (!rows?.length) return NextResponse.json({ error: "No block with that id." }, { status: 404 });
  return NextResponse.json({ block: rows[0] });
}

export async function DELETE(req: Request) {
  if (!(await isStaff())) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id is required." }, { status: 400 });
  const res = await rest("DELETE", `?id=eq.${encodeURIComponent(id)}`);
  if (!res) return noDb();
  if (!res.ok) return NextResponse.json({ error: `Delete failed (HTTP ${res.status})` }, { status: 502 });
  const rows = await res.json();
  if (!rows?.length) return NextResponse.json({ error: "No block with that id." }, { status: 404 });
  return NextResponse.json({ deleted: rows[0].id });
}
