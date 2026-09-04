import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { sbUrl, sbService } from "@/lib/osSupabase";
import { requireStaff, isAuthFailure } from "../pipeline/_lib";
import { emitEvent } from "@/lib/automations/emit";
import { normalizePhone } from "@/lib/phone";

// ───────────────────────────────────────────────────────────────────────────
// Booking API — the GHL calendar replacement's engine room.
//
//   GET  ?from=YYYY-MM-DD&to=YYYY-MM-DD   public: available 30-min slots
//   GET  ?admin=1                          staff: upcoming booking rows
//   POST { name, email, starts_at, ... }   public: create a booking
//   PATCH { id, status }                   staff: cancel / complete / no-show
//
// Availability: Mon-Fri 9:00-17:00 America/Chicago, 30-minute slots. A slot
// is gone when it overlaps any non-cancelled booking. Times are STORED as UTC
// timestamptz and DISPLAYED in CT; all the zone math lives here, explicitly,
// so the client never has to guess an offset.
//
// TODO: fold in Google Calendar busy times (GOOGLE_CALENDAR_ICS_URL) so a
// slot Jack already has a meeting in is not offered. Deliberately left out of
// this round; the public link only knows about its own bookings table.
// ───────────────────────────────────────────────────────────────────────────

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TZ = "America/Chicago";
const SLOT_MINUTES = 30;
const OPEN_HOUR = 9; // 9:00 CT
const CLOSE_HOUR = 17; // last slot starts 16:30 CT

// ── Timezone math ──────────────────────────────────────────────────────────
// UTC-ms offset of Chicago at a given instant (local = utc + offset). Read
// from Intl so DST is always right without a tz library.
const dtf = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
  weekday: "short",
});

type Wall = { y: number; mo: number; d: number; h: number; mi: number; s: number; wd: string };

function wallAt(instant: Date): Wall {
  const p: Record<string, string> = {};
  for (const part of dtf.formatToParts(instant)) p[part.type] = part.value;
  return {
    y: Number(p.year),
    mo: Number(p.month),
    d: Number(p.day),
    // Intl can emit "24" for midnight with hour12:false + 2-digit in some engines.
    h: Number(p.hour) % 24,
    mi: Number(p.minute),
    s: Number(p.second),
    wd: p.weekday,
  };
}

function chicagoOffsetMs(instant: Date): number {
  const w = wallAt(instant);
  const asUtc = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s);
  return asUtc - instant.getTime();
}

// "That wall-clock time in Chicago" to a real UTC instant. Two iterations
// converge across DST boundaries (spring forward / fall back).
function chicagoToUtc(y: number, mo: number, d: number, h: number, mi: number): Date {
  const wallUtc = Date.UTC(y, mo - 1, d, h, mi);
  let ts = wallUtc;
  for (let i = 0; i < 2; i++) {
    ts = wallUtc - chicagoOffsetMs(new Date(ts));
  }
  return new Date(ts);
}

function isYmd(v: unknown): v is string {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
}

// A CT slot start on a day: label like "9:30 AM" for humans, plus UTC bounds.
type Slot = { starts_at: string; ends_at: string; label: string };

function slotsForDay(ymd: string): Slot[] {
  const [y, mo, d] = ymd.split("-").map(Number);
  // Weekday of that DATE in Chicago: noon CT on that day is safely inside it.
  const wd = wallAt(chicagoToUtc(y, mo, d, 12, 0)).wd;
  if (wd === "Sat" || wd === "Sun") return [];
  const out: Slot[] = [];
  for (let h = OPEN_HOUR; h < CLOSE_HOUR; h++) {
    for (const mi of [0, SLOT_MINUTES]) {
      const start = chicagoToUtc(y, mo, d, h, mi);
      const end = new Date(start.getTime() + SLOT_MINUTES * 60_000);
      const h12 = h % 12 || 12;
      out.push({
        starts_at: start.toISOString(),
        ends_at: end.toISOString(),
        label: `${h12}:${String(mi).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`,
      });
    }
  }
  return out;
}

// ── Bookings reads (service key: RLS is staff-only; this route validates) ──
type BookingRow = {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  starts_at: string;
  ends_at: string;
  status: string;
  source: string;
  client_slug: string | null;
  notes: string | null;
  created_at: string;
};

async function bookingsBetween(
  fromIso: string,
  toIso: string,
  opts: { includeCancelled?: boolean } = {}
): Promise<BookingRow[] | null> {
  const url = sbUrl();
  const key = sbService();
  if (!url || !key) return null;
  const qs =
    `select=*${opts.includeCancelled ? "" : "&status=neq.cancelled"}` +
    `&starts_at=lt.${encodeURIComponent(toIso)}` +
    `&ends_at=gt.${encodeURIComponent(fromIso)}` +
    `&order=starts_at.asc&limit=2000`;
  try {
    const r = await fetch(`${url}/rest/v1/bookings?${qs}`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
      cache: "no-store",
    });
    if (!r.ok) return null;
    return (await r.json()) as BookingRow[];
  } catch {
    return null;
  }
}

function overlaps(slotStart: string, slotEnd: string, rows: BookingRow[]): boolean {
  return rows.some((b) => b.starts_at < slotEnd && b.ends_at > slotStart);
}

// ── Rate limit: naive in-memory, per IP. Good enough for one Vercel instance;
// a determined abuser is stopped by validation and honest failure, not this.
// Two buckets: valid booking attempts (small cap, runs AFTER validation so a
// typo never burns an attempt) and total POSTs (larger abuse backstop).
const RATE_WINDOW_MS = 60 * 60 * 1000;
const RATE_MAX = 6; // valid booking attempts per IP per hour
const POST_MAX = 20; // total POSTs per IP per hour, abuse backstop
const hits = new Map<string, number[]>();
const postHits = new Map<string, number[]>();

function bucketLimited(map: Map<string, number[]>, ip: string, max: number): boolean {
  const now = Date.now();
  const list = (map.get(ip) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (list.length >= max) {
    map.set(ip, list);
    return true;
  }
  list.push(now);
  map.set(ip, list);
  return false;
}

// Trust note: we read only the FIRST x-forwarded-for entry. On Vercel the
// platform overwrites this header with the real client IP, so it cannot be
// spoofed in production. Anywhere without a trusted proxy in front, treat this
// as best-effort only; the small rate caps are a convenience, not a security
// boundary.
function clientIp(req: NextRequest): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "unknown"
  );
}

// ── GET: public availability, or the staff admin list ──────────────────────
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;

  if (sp.get("admin") === "1") {
    const auth = await requireStaff();
    if (isAuthFailure(auth)) return auth;
    // Window starts 7 days back so staff can still mark just-ended bookings
    // Completed or No show, and includes cancelled rows so Restore works.
    const fromIso = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const farIso = new Date(Date.now() + 90 * 86_400_000).toISOString();
    const rows = await bookingsBetween(fromIso, farIso, { includeCancelled: true });
    if (rows === null) {
      return NextResponse.json(
        { error: "unavailable", message: "Bookings database is not configured or unreachable." },
        { status: 503 }
      );
    }
    return NextResponse.json({ bookings: rows });
  }

  const today = wallAt(new Date());
  const defFrom = `${today.y}-${String(today.mo).padStart(2, "0")}-${String(today.d).padStart(2, "0")}`;
  const from = isYmd(sp.get("from")) ? (sp.get("from") as string) : defFrom;
  let to = isYmd(sp.get("to")) ? (sp.get("to") as string) : "";
  if (!to || to < from) {
    const [y, mo, d] = from.split("-").map(Number);
    const end = new Date(Date.UTC(y, mo - 1, d + 13));
    to = end.toISOString().slice(0, 10);
  }

  // Bound the window so nobody asks for a year of slots.
  const dayList: string[] = [];
  {
    const [y, mo, d] = from.split("-").map(Number);
    for (let i = 0; i < 31; i++) {
      const dt = new Date(Date.UTC(y, mo - 1, d + i));
      const ymd = dt.toISOString().slice(0, 10);
      if (ymd > to) break;
      dayList.push(ymd);
    }
  }
  if (!dayList.length) {
    return NextResponse.json({ error: "bad_request", message: "Invalid date range." }, { status: 400 });
  }

  const windowStart = slotsForDay(dayList[0])[0]?.starts_at ?? chicagoToUtc(...(dayList[0].split("-").map(Number) as [number, number, number]), 0, 0).toISOString();
  const lastDay = dayList[dayList.length - 1];
  const [ly, lmo, ld] = lastDay.split("-").map(Number);
  const windowEnd = chicagoToUtc(ly, lmo, ld, 23, 59).toISOString();

  const existing = await bookingsBetween(windowStart, windowEnd);
  if (existing === null) {
    return NextResponse.json(
      { error: "unavailable", message: "The booking calendar is not connected to its database right now. Please try again later." },
      { status: 503 }
    );
  }

  const nowIso = new Date().toISOString();
  const days = dayList.map((ymd) => {
    const slots = slotsForDay(ymd)
      .filter((s) => s.starts_at > nowIso)
      .map((s) => ({ ...s, available: !overlaps(s.starts_at, s.ends_at, existing) }));
    return { date: ymd, slots };
  });

  return NextResponse.json({ timezone: TZ, from, to, days });
}

// ── POST: create a booking (public) ────────────────────────────────────────
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export async function POST(req: NextRequest) {
  const ip = clientIp(req);

  // Abuse backstop: cap TOTAL posts per hour. The real booking cap runs after
  // validation below, so a handful of typos never locks a visitor out.
  if (bucketLimited(postHits, ip, POST_MAX)) {
    return NextResponse.json(
      { error: "rate_limited", message: "Too many booking attempts from this connection. Please wait a bit and try again." },
      { status: 429 }
    );
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request", message: "Invalid request body." }, { status: 400 });
  }

  const name = typeof body?.name === "string" ? body.name.trim() : "";
  // Lowercased so the engine's exact email match finds an existing contact;
  // phone stored as E.164 when derivable, else as typed (NULL when empty).
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  const phoneNorm = normalizePhone(body?.phone);
  const phone = phoneNorm.e164 ?? phoneNorm.value;
  const notes = typeof body?.notes === "string" && body.notes.trim() ? body.notes.trim().slice(0, 2000) : null;
  const clientSlug =
    typeof body?.client_slug === "string" && /^[a-z0-9-]{1,60}$/.test(body.client_slug)
      ? body.client_slug
      : null;
  const startsAt = typeof body?.starts_at === "string" ? body.starts_at : "";

  if (!name || name.length > 200) {
    return NextResponse.json({ error: "bad_request", message: "Please enter your name." }, { status: 400 });
  }
  if (!EMAIL_RE.test(email) || email.length > 320) {
    return NextResponse.json({ error: "bad_request", message: "Please enter a valid email address." }, { status: 400 });
  }

  const start = new Date(startsAt);
  if (!startsAt || Number.isNaN(start.getTime())) {
    return NextResponse.json({ error: "bad_request", message: "Please pick a time slot." }, { status: 400 });
  }
  if (start.getTime() <= Date.now()) {
    return NextResponse.json({ error: "bad_request", message: "That time is in the past. Please pick another slot." }, { status: 400 });
  }

  // The requested instant must be one of OUR slots: Mon-Fri, 9:00-17:00 CT,
  // on a :00 or :30 boundary. Anything else is rejected, not rounded.
  const w = wallAt(start);
  const validWall =
    w.wd !== "Sat" &&
    w.wd !== "Sun" &&
    w.h >= OPEN_HOUR &&
    w.h < CLOSE_HOUR &&
    (w.mi === 0 || w.mi === SLOT_MINUTES) &&
    w.s === 0 &&
    start.getMilliseconds() === 0;
  if (!validWall) {
    return NextResponse.json(
      { error: "bad_request", message: "That time is outside booking hours (Monday to Friday, 9am to 5pm Central)." },
      { status: 400 }
    );
  }

  // Validation passed: this is a real booking attempt, so it counts toward
  // the (smaller) booking rate limit.
  if (bucketLimited(hits, ip, RATE_MAX)) {
    return NextResponse.json(
      { error: "rate_limited", message: "Too many booking attempts from this connection. Please wait a bit and try again." },
      { status: 429 }
    );
  }

  const slotStart = start.toISOString();
  const slotEnd = new Date(start.getTime() + SLOT_MINUTES * 60_000).toISOString();

  // Still free? Re-check right before insert. This is the friendly fast path;
  // the bookings_slot_unique index on the table is the real guarantee, and the
  // insert below handles its 409 with the same friendly message.
  const existing = await bookingsBetween(slotStart, slotEnd);
  if (existing === null) {
    return NextResponse.json(
      { error: "unavailable", message: "The booking calendar is not connected to its database right now. Please try again later." },
      { status: 503 }
    );
  }
  if (overlaps(slotStart, slotEnd, existing)) {
    return NextResponse.json(
      { error: "slot_taken", message: "Sorry, that slot was just taken. Please pick another time." },
      { status: 409 }
    );
  }

  // Insert with a direct PostgREST fetch (same URL/service-key pattern as the
  // shared sbInsert helper) so we can see the real status code instead of a
  // swallowed null. A photo-finish race hits the bookings_slot_unique index
  // and PostgREST answers 409 / code 23505; that loser gets the same friendly
  // slot-taken message as the pre-check above.
  const url = sbUrl();
  const key = sbService();
  if (!url || !key) {
    return NextResponse.json(
      { error: "unavailable", message: "The booking calendar is not connected to its database right now. Please try again later." },
      { status: 503 }
    );
  }
  try {
    const r = await fetch(`${url}/rest/v1/bookings`, {
      method: "POST",
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
      },
      body: JSON.stringify({
        name,
        email,
        phone,
        starts_at: slotStart,
        ends_at: slotEnd,
        status: "confirmed",
        source: "public_link",
        client_slug: clientSlug,
        notes,
      }),
    });
    if (!r.ok) {
      const errBody: any = await r.json().catch(() => ({}));
      if (r.status === 409 || errBody?.code === "23505") {
        return NextResponse.json(
          { error: "slot_taken", message: "Sorry, that slot was just taken. Please pick another time." },
          { status: 409 }
        );
      }
      return NextResponse.json(
        { error: "insert_failed", message: "The booking could not be saved. Please try again." },
        { status: 502 }
      );
    }
    const rows = (await r.json()) as BookingRow[];
    const created = rows?.[0] ?? null;
    if (!created) {
      return NextResponse.json(
        { error: "insert_failed", message: "The booking could not be saved. Please try again." },
        { status: 502 }
      );
    }
    // Automation hook: the booking is saved, now tell the engine. Wrapped so a
    // failed emit can never change the 201 the visitor already earned.
    try {
      await emitEvent({
        type: "booking.created",
        client_slug: clientSlug,
        payload: {
          email,
          phone,
          name,
          starts_at: created.starts_at,
          ends_at: created.ends_at,
          client_slug: clientSlug,
          booking_id: created.id,
        },
      });
    } catch {
      // The booking exists; the engine's cron can still find it.
    }
    return NextResponse.json({ ok: true, booking: created }, { status: 201 });
  } catch {
    return NextResponse.json(
      { error: "insert_failed", message: "The booking could not be saved. Please try again." },
      { status: 502 }
    );
  }
}

// ── PATCH: staff status change ─────────────────────────────────────────────
const PATCH_STATUSES = ["cancelled", "completed", "no_show", "confirmed"];

export async function PATCH(req: NextRequest) {
  const auth = await requireStaff();
  if (isAuthFailure(auth)) return auth;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request", message: "Invalid request body." }, { status: 400 });
  }
  const id = typeof body?.id === "string" ? body.id : "";
  const status = typeof body?.status === "string" ? body.status : "";
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return NextResponse.json({ error: "bad_request", message: "Missing booking id." }, { status: 400 });
  }
  if (!PATCH_STATUSES.includes(status)) {
    return NextResponse.json(
      { error: "bad_request", message: `Status must be one of: ${PATCH_STATUSES.join(", ")}.` },
      { status: 400 }
    );
  }

  const url = sbUrl();
  const key = sbService();
  if (!url || !key) {
    return NextResponse.json(
      { error: "unavailable", message: "Bookings database is not configured on this deployment." },
      { status: 503 }
    );
  }
  try {
    const r = await fetch(`${url}/rest/v1/bookings?id=eq.${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
      },
      body: JSON.stringify({ status }),
    });
    if (!r.ok) {
      return NextResponse.json(
        { error: "update_failed", message: `Update failed (HTTP ${r.status}).` },
        { status: 502 }
      );
    }
    const rows = (await r.json()) as BookingRow[];
    if (!rows.length) {
      return NextResponse.json({ error: "not_found", message: "No booking with that id." }, { status: 404 });
    }
    return NextResponse.json({ ok: true, booking: rows[0] });
  } catch (e) {
    return NextResponse.json(
      { error: "unreachable", message: `Bookings database unreachable: ${String(e)}` },
      { status: 502 }
    );
  }
}
