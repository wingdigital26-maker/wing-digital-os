import { NextResponse } from "next/server";
import { requireCallUser, sbGet, sbPost } from "../_guard";
import { sbUrl, sbService } from "../../../../lib/osSupabase";

// ───────────────────────────────────────────────────────────────────────────
// Team Schedule API — the shared trio calendar for the Cold Call Room.
//
// One feed, three sources, all real:
//   blocks    calendar_blocks rows for jack / grant / maddox / team, with
//             recurrence='weekly' expanded into dated instances in app code
//             (same convention as /api/calendar's blocks lane).
//   calls     call_leads with status='booked' and a next_action_at — the
//             booked sales calls, overlaid so nobody has to text call times.
//   bookings  public.bookings (starts_at/ends_at), cancelled excluded.
//
// Auth: requireCallUser() — the caller role (Maddox) is allowed in, which is
// the whole reason this lives under /api/calls. Writes go through the service
// key; identity comes from the session, never from the client.
// ───────────────────────────────────────────────────────────────────────────

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PERSONS = new Set(["jack", "grant", "maddox", "team"]);
const CATEGORIES = new Set(["study", "call", "work", "personal", "other"]);

type BlockRow = {
  id: string;
  title: string;
  date: string;       // YYYY-MM-DD anchor
  start_time: string; // HH:MM:SS
  end_time: string;
  category: string;
  notes: string | null;
  recurrence: string | null;
  person: string;
};

export type ScheduleEvent = {
  id: string;
  kind: "block" | "call" | "booking";
  title: string;
  person: string;         // jack | grant | maddox | team (calls/bookings = team)
  date: string;           // YYYY-MM-DD
  start: string;          // HH:MM
  end: string | null;     // HH:MM
  category: string | null;
  weekly: boolean;
  detail: string | null;
  blockId: string | null; // set only for blocks, so the UI can delete them
};

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}

function parseYmd(v: string | null): Date | null {
  if (!v) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v.trim());
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

const hhmm = (t: string) => t.slice(0, 5);

// Match the current session to a person slug so the add form can default
// honestly. Only exact first-name hits count; anything else gets a picker.
function guessPerson(email: string): string | null {
  const local = email.toLowerCase();
  if (local.includes("maddox")) return "maddox";
  if (local.includes("grant")) return "grant";
  if (local.includes("jack") || local.includes("wjackwing") || local === "shared-login")
    return "jack";
  return null;
}

export async function GET(req: Request) {
  const user = await requireCallUser();
  if (!user) return NextResponse.json({ error: "Not signed in to the call room." }, { status: 401 });
  if (!sbUrl() || !sbService())
    return NextResponse.json(
      { error: "Supabase is not configured (OS_SUPABASE_URL / OS_SUPABASE_SERVICE_KEY)." },
      { status: 503 }
    );

  const sp = new URL(req.url).searchParams;
  // Default window: this week's Monday through Sunday.
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const defFrom = new Date(today);
  defFrom.setDate(defFrom.getDate() - ((defFrom.getDay() + 6) % 7)); // back to Monday
  const defTo = new Date(defFrom);
  defTo.setDate(defTo.getDate() + 6);

  const from = parseYmd(sp.get("from")) ?? defFrom;
  const to = parseYmd(sp.get("to")) ?? defTo;
  if (to < from)
    return NextResponse.json({ error: "'to' is before 'from'." }, { status: 400 });

  const events: ScheduleEvent[] = [];
  const problems: string[] = [];

  // ── Blocks (all four persons), weekly expanded across [from, to] ──
  const blocks = await sbGet<BlockRow>(
    "calendar_blocks",
    "select=*&order=date.asc,start_time.asc&limit=2000"
  );
  if (blocks === null) {
    problems.push("Time blocks could not be read.");
  } else {
    for (const r of blocks) {
      const anchor = parseYmd(r.date);
      if (!anchor) continue;
      const push = (day: Date) =>
        events.push({
          id: `block:${r.id}:${ymd(day)}`,
          kind: "block",
          title: r.title,
          person: PERSONS.has(r.person) ? r.person : "team",
          date: ymd(day),
          start: hhmm(r.start_time),
          end: r.end_time ? hhmm(r.end_time) : null,
          category: r.category,
          weekly: r.recurrence === "weekly",
          detail: r.notes,
          blockId: r.id,
        });
      if (r.recurrence === "weekly") {
        const start = anchor > from ? anchor : from;
        for (const d = new Date(start); d <= to; d.setDate(d.getDate() + 1)) {
          if (d.getDay() === anchor.getDay() && d >= anchor) push(d);
        }
      } else if (anchor >= from && anchor <= to) {
        push(anchor);
      }
    }
  }

  // ── Booked sales calls (call_leads.status='booked' with a time) ──
  type LeadRow = {
    id: string;
    company: string | null;
    contact_name: string | null;
    phone: string | null;
    next_action_at: string | null;
  };
  const leads = await sbGet<LeadRow>(
    "call_leads",
    "select=id,company,contact_name,phone,next_action_at" +
      "&status=eq.booked&next_action_at=not.is.null&order=next_action_at.asc&limit=500"
  );
  if (leads === null) {
    problems.push("Booked calls could not be read.");
  } else {
    for (const r of leads) {
      if (!r.next_action_at) continue;
      const dt = new Date(r.next_action_at);
      if (Number.isNaN(dt.getTime())) continue;
      const day = new Date(dt);
      day.setHours(0, 0, 0, 0);
      if (day < from || day > to) continue;
      events.push({
        id: `call:${r.id}`,
        kind: "call",
        title: `CALL: ${r.company?.trim() || r.contact_name?.trim() || "Booked call"}`,
        person: "team",
        date: ymd(dt),
        start: `${String(dt.getHours()).padStart(2, "0")}:${String(dt.getMinutes()).padStart(2, "0")}`,
        end: null,
        category: null,
        weekly: false,
        detail: [r.contact_name, r.phone].filter(Boolean).join(" · ") || null,
        blockId: null,
      });
    }
  }

  // ── Bookings from the public /book link (cancelled excluded) ──
  type BookingRow = {
    id: string;
    name: string;
    phone: string | null;
    starts_at: string;
    ends_at: string | null;
    status: string;
  };
  const bookings = await sbGet<BookingRow>(
    "bookings",
    "select=id,name,phone,starts_at,ends_at,status&status=neq.cancelled&order=starts_at.asc&limit=500"
  );
  if (bookings === null) {
    problems.push("Bookings could not be read.");
  } else {
    for (const r of bookings) {
      const dt = new Date(r.starts_at);
      if (Number.isNaN(dt.getTime())) continue;
      const day = new Date(dt);
      day.setHours(0, 0, 0, 0);
      if (day < from || day > to) continue;
      const endDt = r.ends_at ? new Date(r.ends_at) : null;
      events.push({
        id: `booking:${r.id}`,
        kind: "booking",
        title: `CALL: ${r.name}`,
        person: "team",
        date: ymd(dt),
        start: `${String(dt.getHours()).padStart(2, "0")}:${String(dt.getMinutes()).padStart(2, "0")}`,
        end:
          endDt && !Number.isNaN(endDt.getTime())
            ? `${String(endDt.getHours()).padStart(2, "0")}:${String(endDt.getMinutes()).padStart(2, "0")}`
            : null,
        category: null,
        weekly: false,
        detail: r.phone,
        blockId: null,
      });
    }
  }

  events.sort((a, b) => (a.date + a.start < b.date + b.start ? -1 : 1));
  return NextResponse.json({
    from: ymd(from),
    to: ymd(to),
    events,
    problems,
    me: { email: user.email, person: guessPerson(user.email) },
  });
}

export async function POST(req: Request) {
  const user = await requireCallUser();
  if (!user) return NextResponse.json({ error: "Not signed in to the call room." }, { status: 401 });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Bad JSON." }, { status: 400 });
  }

  const title = typeof body.title === "string" ? body.title.trim() : "";
  const person = typeof body.person === "string" ? body.person.trim().toLowerCase() : "";
  const date = typeof body.date === "string" ? body.date.trim() : "";
  const start = typeof body.start === "string" ? body.start.trim() : "";
  const end = typeof body.end === "string" ? body.end.trim() : "";
  const weekly = Boolean(body.weekly);
  const category =
    typeof body.category === "string" && CATEGORIES.has(body.category) ? body.category : "other";

  if (!title) return NextResponse.json({ error: "A title is required." }, { status: 400 });
  if (!PERSONS.has(person))
    return NextResponse.json({ error: "Person must be jack, grant, maddox, or team." }, { status: 400 });
  if (!parseYmd(date))
    return NextResponse.json({ error: "Date must be YYYY-MM-DD." }, { status: 400 });
  const T = /^([01]\d|2[0-3]):([0-5]\d)$/;
  if (!T.test(start) || !T.test(end))
    return NextResponse.json({ error: "Times must be HH:MM (24h)." }, { status: 400 });
  if (end <= start)
    return NextResponse.json({ error: "End time must be after start time." }, { status: 400 });

  const rows = await sbPost<BlockRow>("calendar_blocks", {
    title,
    person,
    date,
    start_time: `${start}:00`,
    end_time: `${end}:00`,
    category,
    recurrence: weekly ? "weekly" : null,
    notes: `added by ${user.email}`,
  });
  if (!rows || !rows[0])
    return NextResponse.json({ error: "The block could not be saved." }, { status: 502 });
  return NextResponse.json({ ok: true, block: rows[0] });
}

export async function DELETE(req: Request) {
  const user = await requireCallUser();
  if (!user) return NextResponse.json({ error: "Not signed in to the call room." }, { status: 401 });

  const id = new URL(req.url).searchParams.get("id");
  if (!id || !/^[0-9a-f-]{16,64}$/i.test(id))
    return NextResponse.json({ error: "A valid block id is required." }, { status: 400 });

  const url = sbUrl();
  const key = sbService();
  if (!url || !key)
    return NextResponse.json({ error: "Supabase is not configured." }, { status: 503 });
  try {
    const r = await fetch(`${url}/rest/v1/calendar_blocks?id=eq.${id}`, {
      method: "DELETE",
      headers: { apikey: key, Authorization: `Bearer ${key}`, Prefer: "return=representation" },
    });
    if (!r.ok)
      return NextResponse.json({ error: `Delete failed (HTTP ${r.status}).` }, { status: 502 });
    const gone = (await r.json()) as unknown[];
    if (!gone.length)
      return NextResponse.json({ error: "No block with that id." }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Supabase unreachable." }, { status: 502 });
  }
}
