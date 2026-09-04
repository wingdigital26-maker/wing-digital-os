// ───────────────────────────────────────────────────────────────────────────
// GET /api/home/summary: the "Today" strip on the home screen.
//
// Seven counts, each answered straight from the OS Supabase (the CRM that
// replaced GoHighLevel). Every number is independent: a query that fails
// yields null for that one figure and the rest still come back. The UI shows
// null as "not available", never as 0, because a zero here would be read as
// "nothing to do" when the truth is "the database did not answer".
//
// Tables and columns (see supabase/migrations 0004, 0014, 0017, 0021):
//   tasks(due_at, done_at)        crm_deals(status)     workflows(status)
//   events(type, occurred_at)     bookings(status, starts_at)
//   messages(direction, channel, read_at)
// ───────────────────────────────────────────────────────────────────────────
import { NextResponse } from "next/server";
import { requireStaff, isAuthFailure, sbGetPaged } from "@/app/api/pipeline/_lib";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CENTRAL = "America/Chicago";

// Midnight at the start of TODAY and of TOMORROW in Central time, as UTC
// instants. Built from the wall clock rather than a fixed offset so DST is
// handled by Intl.
function centralDayBounds(now: Date): { start: Date; end: Date } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: CENTRAL, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
  // Intl renders midnight as hour 24 in some runtimes; normalise.
  const hour = get("hour") % 24;
  const wall = Date.UTC(get("year"), get("month") - 1, get("day"), hour, get("minute"), get("second"));
  const offsetMs = wall - now.getTime(); // Central wall clock minus real UTC
  const midnightWall = Date.UTC(get("year"), get("month") - 1, get("day"), 0, 0, 0);
  const nextMidnightWall = Date.UTC(get("year"), get("month") - 1, get("day") + 1, 0, 0, 0);
  return { start: new Date(midnightWall - offsetMs), end: new Date(nextMidnightWall - offsetMs) };
}

// Exact row count via Content-Range, fetching a single id. null on any failure.
async function count(table: string, query: string): Promise<number | null> {
  try {
    const { total } = await sbGetPaged(table, "id", query, 0, 1);
    return typeof total === "number" && Number.isFinite(total) ? total : null;
  } catch {
    return null;
  }
}

const iso = (d: Date) => encodeURIComponent(d.toISOString());

export async function GET() {
  const auth = await requireStaff();
  if (isAuthFailure(auth)) return auth;

  const now = new Date();
  const today = centralDayBounds(now);
  const weekAgo = new Date(now.getTime() - 7 * 86400_000);
  const weekAhead = new Date(now.getTime() + 7 * 86400_000);

  const [
    tasks_due_today,
    tasks_overdue,
    new_leads_7d,
    bookings_upcoming_7d,
    open_deals,
    automations_active,
    unread_texts,
  ] = await Promise.all([
    // Due today = due at some point during today (Central). Overdue is the
    // separate figure below; the two do not overlap once a task is past due.
    count("tasks", `done_at=is.null&due_at=gte.${iso(today.start)}&due_at=lt.${iso(today.end)}`),
    count("tasks", `done_at=is.null&due_at=lt.${iso(now)}`),
    count("events", `type=in.(form.submitted,call.missed)&occurred_at=gte.${iso(weekAgo)}`),
    count("bookings", `status=eq.confirmed&starts_at=gte.${iso(now)}&starts_at=lt.${iso(weekAhead)}`),
    count("crm_deals", "status=eq.open"),
    count("workflows", "status=eq.active"),
    count("messages", "direction=eq.inbound&channel=eq.sms&read_at=is.null"),
  ]);

  return NextResponse.json({
    as_of: now.toISOString(),
    tasks_due_today,
    tasks_overdue,
    new_leads_7d,
    bookings_upcoming_7d,
    open_deals,
    automations_active,
    unread_texts,
  });
}
