import { NextResponse } from "next/server";
import { sbUrl, sbService } from "@/lib/osSupabase";
import { requireStaff, isAuthFailure } from "../../pipeline/_lib";
import {
  PEOPLE,
  FIRST_NAME,
  loadAvailability,
  normalizeHours,
  type AvailabilityRow,
} from "./_lib";

// ───────────────────────────────────────────────────────────────────────────
// Staff availability API — the hours behind the public booking link.
//
//   GET                       every person's weekly hours + takes_bookings
//   PATCH { person, hours?, takes_bookings? }   update one person
//
// Staff-only (requireStaff, same as /api/booking?admin=1). The public /book
// page never reads this; it only ever sees the merged available/unavailable
// slot list from /api/booking, with no names on it.
// ───────────────────────────────────────────────────────────────────────────

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noDb = () =>
  NextResponse.json(
    { error: "unavailable", message: "OS Supabase is not configured (OS_SUPABASE_URL / OS_SUPABASE_SERVICE_KEY)." },
    { status: 503 }
  );

export async function GET() {
  const auth = await requireStaff();
  if (isAuthFailure(auth)) return auth;
  const rows = await loadAvailability();
  if (rows === null) {
    return NextResponse.json(
      { error: "unavailable", message: "Availability could not be read. Has migration 0024 been applied?" },
      { status: 503 }
    );
  }
  // Every person appears, even one whose row is missing, so the panel can
  // say "no hours set" instead of silently dropping them.
  const people = PEOPLE.map((p) => {
    const r = rows.find((x) => x.person === p);
    return r
      ? { ...r, label: FIRST_NAME[p], exists: true }
      : { person: p, hours: {}, takes_bookings: false, updated_at: null, label: FIRST_NAME[p], exists: false };
  });
  return NextResponse.json({ people });
}

export async function PATCH(req: Request) {
  const auth = await requireStaff();
  if (isAuthFailure(auth)) return auth;

  let body: { person?: unknown; hours?: unknown; takes_bookings?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request", message: "Invalid request body." }, { status: 400 });
  }
  const person = typeof body.person === "string" ? body.person.toLowerCase() : "";
  if (!(PEOPLE as readonly string[]).includes(person)) {
    return NextResponse.json(
      { error: "bad_request", message: `Person must be one of: ${PEOPLE.join(", ")}.` },
      { status: 400 }
    );
  }

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (body.hours !== undefined) {
    const n = normalizeHours(body.hours);
    if ("error" in n) return NextResponse.json({ error: "bad_request", message: n.error }, { status: 400 });
    patch.hours = n.hours;
  }
  if (body.takes_bookings !== undefined) {
    if (typeof body.takes_bookings !== "boolean") {
      return NextResponse.json({ error: "bad_request", message: "takes_bookings must be true or false." }, { status: 400 });
    }
    patch.takes_bookings = body.takes_bookings;
  }
  if (Object.keys(patch).length === 1) {
    return NextResponse.json({ error: "bad_request", message: "Nothing to update." }, { status: 400 });
  }

  const url = sbUrl();
  const key = sbService();
  if (!url || !key) return noDb();
  try {
    // Upsert so a person whose seed row is somehow missing still gets one.
    const r = await fetch(`${url}/rest/v1/availability?on_conflict=person`, {
      method: "POST",
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=representation",
      },
      body: JSON.stringify({ person, ...patch }),
      cache: "no-store",
    });
    if (!r.ok) {
      return NextResponse.json(
        { error: "update_failed", message: `Availability update failed (HTTP ${r.status}).` },
        { status: 502 }
      );
    }
    const rows = (await r.json()) as AvailabilityRow[];
    return NextResponse.json({ ok: true, person: rows[0] ?? null });
  } catch (e) {
    return NextResponse.json(
      { error: "unreachable", message: `Availability database unreachable: ${String(e)}` },
      { status: 502 }
    );
  }
}
