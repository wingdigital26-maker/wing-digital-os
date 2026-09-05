import { NextResponse } from "next/server";
import { sbUrl, sbService } from "../../../lib/osSupabase";
import { GET as schoolGET, SCHEDULE_URL, type SchoolPayload } from "../school/route";
import { parseIcs } from "../../lib/ics";

// ───────────────────────────────────────────────────────────────────────────
// Calendar API — every real dated thing on Jack's plate, in one feed.
//
// Four lanes, each independently configured and each reported honestly:
//
//   google    Google Calendar, read through the calendar's private iCal
//             address (GOOGLE_CALENDAR_ICS_URL). Read-only, no OAuth, works
//             PC-off from the cloud. Not set = the lane reports itself
//             unconfigured and names the variable. It never invents events.
//   callbacks Scheduled call-backs from the Cold Call Room
//             (OS Supabase call_leads.next_action_at).
//   payments  Invoice due dates and the next recurring payment
//             (Sonar Supabase invoices).
//   school    Jack's class schedule, expanded from the LIVE published
//             schedule app. See the school lane below.
//
// Nothing here is ever synthesized. A lane with no credential returns zero
// events and says which credential is missing; a lane that errors says so.
// ───────────────────────────────────────────────────────────────────────────

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export type CalendarSource =
  | "google"
  | "callbacks"
  | "payments"
  | "school"
  | "blocks"
  | "stripe"
  | "bookings";

export type CalendarEvent = {
  id: string;
  source: CalendarSource;
  title: string;
  /** ISO instant, or YYYY-MM-DD for an all-day event. */
  start: string;
  end: string | null;
  allDay: boolean;
  /** Secondary line: who it is with, or what it is worth. */
  detail: string | null;
  /** Real link back to the record this event came from. Never invented. */
  url: string | null;
  /** True when `url` leaves the OS and needs target=_blank. */
  external: boolean;
  status: string | null;
  /** Explicit colour token, when the source colours per-item (block categories). */
  color?: string | null;
  /** The raw calendar_blocks row behind a block event, so the UI can edit it. */
  block?: BlockRow | null;
  /** Whose item this is: jack | maddox | grant | team. Null = not a person's
   *  item (payments, Stripe, Google) or unknown (a booking nobody was
   *  assigned to). Drives the person filter in the UI. */
  person?: string | null;
};

export type LaneStatus = {
  source: CalendarSource;
  label: string;
  configured: boolean;
  /** Exactly which credential is missing, when one is. */
  missing: string | null;
  error: string | null;
  count: number;
  /** Honest plain-language state when a configured lane is simply empty. */
  note?: string | null;
};

// ── iCal parsing ───────────────────────────────────────────────────────────
// The parser now lives in app/lib/ics.ts (imported above as parseIcs) so the
// booking engine reads the same busy events this lane draws. parseIcs returns
// IcsEvent[], structurally a CalendarEvent with source pinned to "google".

// ── Lanes ──────────────────────────────────────────────────────────────────

async function googleLane(): Promise<{ lane: LaneStatus; events: CalendarEvent[] }> {
  const feed = process.env.GOOGLE_CALENDAR_ICS_URL;
  const lane: LaneStatus = {
    source: "google",
    label: "Google Calendar",
    configured: Boolean(feed),
    missing: feed ? null : "GOOGLE_CALENDAR_ICS_URL",
    error: null,
    count: 0,
  };
  if (!feed) return { lane, events: [] };
  try {
    const res = await fetch(feed, { cache: "no-store" });
    if (!res.ok) {
      lane.error = `Google Calendar feed returned HTTP ${res.status}`;
      return { lane, events: [] };
    }
    const events = parseIcs(await res.text());
    lane.count = events.length;
    return { lane, events };
  } catch (e) {
    lane.error = `Google Calendar feed unreachable: ${String(e)}`;
    return { lane, events: [] };
  }
}

type LeadRow = {
  id: string;
  company: string | null;
  contact_name: string | null;
  phone: string | null;
  status: string | null;
  next_action_at: string | null;
};

async function callbackLane(): Promise<{ lane: LaneStatus; events: CalendarEvent[] }> {
  const url = sbUrl();
  const key = sbService();
  const lane: LaneStatus = {
    source: "callbacks",
    label: "Call-backs",
    configured: Boolean(url && key),
    missing: url && key ? null : "OS_SUPABASE_URL / OS_SUPABASE_SERVICE_KEY",
    error: null,
    count: 0,
  };
  if (!url || !key) return { lane, events: [] };
  try {
    const res = await fetch(
      `${url}/rest/v1/call_leads?select=id,company,contact_name,phone,status,next_action_at` +
        `&next_action_at=not.is.null&order=next_action_at.asc&limit=500`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` }, cache: "no-store" }
    );
    if (!res.ok) {
      lane.error = `Call room read failed (HTTP ${res.status})`;
      return { lane, events: [] };
    }
    const rows = (await res.json()) as LeadRow[];
    const events = rows
      .filter((r) => r.next_action_at)
      .map<CalendarEvent>((r) => ({
        id: `callback:${r.id}`,
        source: "callbacks",
        title: r.company?.trim() || r.contact_name?.trim() || "Call-back",
        start: r.next_action_at as string,
        end: null,
        allDay: false,
        detail: [r.contact_name, r.phone].filter(Boolean).join(" · ") || null,
        url: "/calls",
        external: false,
        status: r.status,
      }));
    lane.count = events.length;
    return { lane, events };
  } catch (e) {
    lane.error = `Call room unreachable: ${String(e)}`;
    return { lane, events: [] };
  }
}

type InvoiceRow = {
  id: number;
  client: string;
  invoice_no: string;
  amount_cents: number;
  currency: string | null;
  status: string;
  due_on: string | null;
  next_due_on: string | null;
};

function money(cents: number, currency = "USD"): string {
  const n = Math.round(Number.isFinite(cents) ? cents : 0);
  const sym = currency === "USD" ? "$" : `${currency} `;
  return `${sym}${Math.floor(Math.abs(n) / 100).toLocaleString("en-US")}.${String(
    Math.abs(n) % 100
  ).padStart(2, "0")}`;
}

async function paymentLane(): Promise<{ lane: LaneStatus; events: CalendarEvent[] }> {
  const url = process.env.SONAR_SUPABASE_URL;
  const key = process.env.SONAR_SUPABASE_SERVICE_KEY;
  const lane: LaneStatus = {
    source: "payments",
    label: "Payments due",
    configured: Boolean(url && key),
    missing: url && key ? null : "SONAR_SUPABASE_URL / SONAR_SUPABASE_SERVICE_KEY",
    error: null,
    count: 0,
  };
  if (!url || !key) return { lane, events: [] };
  try {
    const res = await fetch(
      `${url}/rest/v1/invoices?select=id,client,invoice_no,amount_cents,currency,status,due_on,next_due_on&limit=1000`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` }, cache: "no-store" }
    );
    if (!res.ok) {
      lane.error = `Invoices read failed (HTTP ${res.status})`;
      return { lane, events: [] };
    }
    const rows = (await res.json()) as InvoiceRow[];
    const events: CalendarEvent[] = [];
    for (const r of rows) {
      if (r.status === "void") continue;
      // One marker per real date on the row: when it is due, and when the
      // recurring schedule expects the next one. Deduped so a row whose two
      // dates agree is only drawn once.
      const dates = new Set<string>();
      if (r.due_on) dates.add(r.due_on.slice(0, 10));
      if (r.next_due_on) dates.add(r.next_due_on.slice(0, 10));
      for (const d of dates) {
        events.push({
          id: `payment:${r.id}:${d}`,
          source: "payments",
          title: r.client,
          start: d,
          end: null,
          allDay: true,
          detail: `${money(r.amount_cents, r.currency || "USD")} · ${r.invoice_no}`,
          url: "#invoices",
          external: false,
          status: r.status,
        });
      }
    }
    lane.count = events.length;
    return { lane, events };
  } catch (e) {
    lane.error = `Invoices unreachable: ${String(e)}`;
    return { lane, events: [] };
  }
}

// ── School lane ────────────────────────────────────────────────────────────
//
// Jack's classes are recurring weekly meetings ("Astronomy MWF 14:00-14:50"),
// not dated events, so the calendar cannot draw them until they are expanded
// into one real dated meeting per day the class actually meets.
//
// The data is NOT duplicated here. We call /api/school's own handler, which
// fetches the published schedule app live with its cache-buster and no-store,
// and parses the DATA block. That keeps exactly one parser in the codebase and
// keeps this lane as live as that route is: edit the markers, run build.py, and
// the next request here sees the new courses. Nothing is snapshotted.
//
// Bounds come from the schedule's own SEMESTER block, never from a constant in
// this file: classes run from `start` through `lastClass`, and finals are drawn
// only on the dates the courses themselves carry. If the live fetch fails, the
// lane reports the failure by name and returns zero events. It never falls back
// to a remembered schedule.

// build.py's day letters. R is Thursday and U is Sunday, the standard
// university shorthand that avoids the T/Th and S/Su collisions.
const DAY_LETTER: Record<string, number> = { U: 0, M: 1, T: 2, W: 3, R: 4, F: 5, S: 6 };

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}

function parseYmd(v: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v.trim());
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "14:00" on a given day → a floating local ISO the browser reads in Jack's
 *  own zone, the same convention the iCal lane uses for local times. */
function at(day: Date, hhmm: string): string | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  return `${ymd(day)}T${String(Number(m[1])).padStart(2, "0")}:${m[2]}:00`;
}

function where(bldg: string, room: string): string | null {
  const b = bldg.trim();
  const r = room.trim();
  if (b && r) return `${b} ${r}`;
  return b || r || null;
}

async function schoolLane(): Promise<{ lane: LaneStatus; events: CalendarEvent[] }> {
  const lane: LaneStatus = {
    source: "school",
    label: "Classes",
    // The schedule app is public, so this lane needs no credential. It is
    // configured whenever the live page can actually be read.
    configured: true,
    missing: null,
    error: null,
    count: 0,
  };

  let payload: SchoolPayload;
  try {
    payload = (await (await schoolGET()).json()) as SchoolPayload;
  } catch (e) {
    lane.configured = false;
    lane.error = `Class schedule unreachable: ${String(e)}`;
    return { lane, events: [] };
  }

  if (!payload.ok) {
    lane.configured = false;
    lane.error = `Class schedule: ${payload.error ?? "the published schedule app could not be read."}`;
    return { lane, events: [] };
  }

  const from = payload.semester?.start ? parseYmd(payload.semester.start) : null;
  const lastClass = payload.semester?.lastClass ? parseYmd(payload.semester.lastClass) : null;
  if (!from || !lastClass) {
    lane.configured = false;
    lane.error =
      "Class schedule: the published schedule has no semester start and last-class dates, " +
      "so recurring classes cannot be placed on real days.";
    return { lane, events: [] };
  }

  const finalsEnd = payload.semester?.finalsEnd ? parseYmd(payload.semester.finalsEnd) : null;
  const events: CalendarEvent[] = [];

  for (const [ci, c] of payload.courses.entries()) {
    const title = c.short?.trim() || c.title?.trim();
    if (!title) continue;
    const room = where(c.bldg, c.room);
    const detail = [c.code, room].filter(Boolean).join(" · ") || null;

    // One dated meeting per day the class actually meets, walked day by day
    // between the semester's own bounds. Nothing outside them is drawn.
    const wanted = new Set(
      c.days
        .toUpperCase()
        .split("")
        .map((ch) => DAY_LETTER[ch])
        .filter((n): n is number => n !== undefined)
    );
    if (wanted.size && c.start) {
      for (const d = new Date(from); d <= lastClass; d.setDate(d.getDate() + 1)) {
        if (!wanted.has(d.getDay())) continue;
        const start = at(d, c.start);
        if (!start) continue;
        events.push({
          id: `school:${ci}:${ymd(d)}`,
          source: "school",
          title,
          start,
          end: c.end ? at(d, c.end) : null,
          allDay: false,
          detail,
          url: SCHEDULE_URL,
          external: true,
          status: "class",
        });
      }
    }

    // Finals, only when the course carries a real date. A final marked TBA has
    // no day to sit on, so it is left off rather than guessed onto one.
    const f = c.final;
    if (f && f.date && !f.tba) {
      const fd = parseYmd(f.date);
      if (fd && fd >= from && (!finalsEnd || fd <= finalsEnd)) {
        const fStart = f.start ? at(fd, f.start) : null;
        const fRoom = where(f.bldg ?? "", f.room ?? "") ?? room;
        events.push({
          id: `school:${ci}:final:${ymd(fd)}`,
          source: "school",
          title: `Final: ${title}`,
          start: fStart ?? ymd(fd),
          end: fStart && f.end ? at(fd, f.end) : null,
          allDay: !fStart,
          detail: [c.code, fRoom].filter(Boolean).join(" · ") || null,
          url: SCHEDULE_URL,
          external: true,
          status: "final",
        });
      }
    }
  }

  lane.count = events.length;
  return { lane, events };
}

// ── Blocks lane ────────────────────────────────────────────────────────────
//
// Jack's own manual time-blocks (calendar_blocks, migration 0015; CRUD in
// /api/blocks). A one-off block is one event on its date. recurrence='weekly'
// repeats every week on the anchor date's weekday, from that date forward,
// expanded here into real dated instances across a bounded window (8 weeks
// back, 16 weeks forward) so both the month and week grids see them without
// the table ever storing generated rows.

export type BlockRow = {
  id: string;
  title: string;
  date: string;       // YYYY-MM-DD anchor
  start_time: string; // HH:MM:SS
  end_time: string;
  category: string;
  notes: string | null;
  recurrence: string | null;
  /** jack | grant | maddox | team (migration 0019). */
  person: string;
};

// Category → colour token. The UI stays token-only; hex never appears.
export const BLOCK_COLOR: Record<string, string> = {
  study: "var(--accent-2)",
  call: "var(--orange)",
  work: "var(--accent)",
  personal: "var(--green)",
  other: "var(--text-muted)",
};

const hhmm = (t: string) => t.slice(0, 5);

async function blocksLane(): Promise<{ lane: LaneStatus; events: CalendarEvent[] }> {
  const url = sbUrl();
  const key = sbService();
  const lane: LaneStatus = {
    source: "blocks",
    label: "Time blocks",
    configured: Boolean(url && key),
    missing: url && key ? null : "OS_SUPABASE_URL / OS_SUPABASE_SERVICE_KEY",
    error: null,
    count: 0,
    note: null,
  };
  if (!url || !key) return { lane, events: [] };
  try {
    const res = await fetch(
      `${url}/rest/v1/calendar_blocks?select=*&order=date.asc,start_time.asc&limit=1000`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` }, cache: "no-store" }
    );
    if (!res.ok) {
      lane.error = `Time blocks read failed (HTTP ${res.status})`;
      return { lane, events: [] };
    }
    const rows = (await res.json()) as BlockRow[];
    if (!rows.length) {
      lane.note = "No time blocks yet — click a day to add one.";
      return { lane, events: [] };
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const winStart = new Date(today); winStart.setDate(winStart.getDate() - 56);
    const winEnd = new Date(today);   winEnd.setDate(winEnd.getDate() + 112);

    const events: CalendarEvent[] = [];
    const push = (r: BlockRow, day: Date) => {
      const dk = ymd(day);
      events.push({
        id: `block:${r.id}:${dk}`,
        source: "blocks",
        title: r.title,
        start: `${dk}T${hhmm(r.start_time)}:00`,
        end: `${dk}T${hhmm(r.end_time)}:00`,
        allDay: false,
        detail: [r.category, r.notes].filter(Boolean).join(" · ") || null,
        url: null,
        external: false,
        status: r.recurrence === "weekly" ? "weekly" : null,
        color: BLOCK_COLOR[r.category] ?? "var(--accent)",
        block: r,
        person: r.person || "jack",
      });
    };

    for (const r of rows) {
      const anchor = parseYmd(r.date);
      if (!anchor) continue;
      if (r.recurrence === "weekly") {
        const from = anchor > winStart ? anchor : winStart;
        for (const d = new Date(from); d <= winEnd; d.setDate(d.getDate() + 1)) {
          if (d.getDay() === anchor.getDay() && d >= anchor) push(r, d);
        }
      } else {
        push(r, anchor);
      }
    }
    lane.count = events.length;
    return { lane, events };
  } catch (e) {
    lane.error = `Time blocks unreachable: ${String(e)}`;
    return { lane, events: [] };
  }
}

// ── Stripe lane ────────────────────────────────────────────────────────────
//
// Real money on real dates from Wing's live Stripe account, via the restricted
// key in STRIPE_SECRET_KEY. Two reads, both plain REST (no SDK):
//
//   invoices       due dates for open/paid invoices; an open invoice past its
//                  due date is reported overdue. Draft/void/uncollectible are
//                  skipped — they have no calendar meaning.
//   subscriptions  each active subscription's current_period_end = the next
//                  recurring charge.
//
// A configured account with nothing billed yet says so in plain words (note),
// which is the expected state today. Nothing is ever synthesized.

type StripeInvoice = {
  id: string;
  number: string | null;
  status: string;
  due_date: number | null;
  amount_due: number;
  currency: string;
  customer_name: string | null;
  customer_email: string | null;
  hosted_invoice_url: string | null;
};

type StripeSub = {
  id: string;
  status: string;
  current_period_end: number | null;
  items?: { data?: { price?: { unit_amount: number | null; currency: string } }[] };
};

function epochYmd(sec: number): string {
  return ymd(new Date(sec * 1000));
}

async function stripeGet(key: string, path: string) {
  return fetch(`https://api.stripe.com/v1/${path}`, {
    headers: { Authorization: `Bearer ${key}` },
    cache: "no-store",
  });
}

async function stripeLane(): Promise<{ lane: LaneStatus; events: CalendarEvent[] }> {
  const key = process.env.STRIPE_SECRET_KEY;
  const lane: LaneStatus = {
    source: "stripe",
    label: "Stripe",
    configured: Boolean(key),
    missing: key ? null : "STRIPE_SECRET_KEY",
    error: null,
    count: 0,
    note: null,
  };
  if (!key) return { lane, events: [] };

  const events: CalendarEvent[] = [];
  const nowSec = Math.floor(Date.now() / 1000);
  try {
    const [invRes, subRes] = await Promise.all([
      stripeGet(key, "invoices?limit=100"),
      stripeGet(key, "subscriptions?status=active&limit=100"),
    ]);

    if (!invRes.ok) {
      lane.error = `Stripe invoices read failed (HTTP ${invRes.status})`;
    } else {
      const inv = (await invRes.json()) as { data: StripeInvoice[] };
      for (const r of inv.data ?? []) {
        if (!["open", "paid"].includes(r.status)) continue;
        // An invoice with no due date has no day to sit on; skipped, not guessed.
        if (!r.due_date) continue;
        const overdue = r.status === "open" && r.due_date < nowSec;
        events.push({
          id: `stripe:inv:${r.id}`,
          source: "stripe",
          title: r.customer_name || r.customer_email || r.number || "Stripe invoice",
          start: epochYmd(r.due_date),
          end: null,
          allDay: true,
          detail: `${money(r.amount_due, r.currency.toUpperCase())} · ${
            overdue ? "OVERDUE" : r.status
          }${r.number ? ` · ${r.number}` : ""}`,
          url: r.hosted_invoice_url,
          external: true,
          status: overdue ? "overdue" : r.status,
        });
      }
    }

    if (!subRes.ok) {
      const msg = `Stripe subscriptions read failed (HTTP ${subRes.status})`;
      lane.error = lane.error ? `${lane.error}; ${msg}` : msg;
    } else {
      const subs = (await subRes.json()) as { data: StripeSub[] };
      for (const s of subs.data ?? []) {
        if (!s.current_period_end) continue;
        const price = s.items?.data?.[0]?.price;
        events.push({
          id: `stripe:sub:${s.id}`,
          source: "stripe",
          title: "Stripe subscription renews",
          start: epochYmd(s.current_period_end),
          end: null,
          allDay: true,
          detail:
            price?.unit_amount != null
              ? `${money(price.unit_amount, (price.currency || "usd").toUpperCase())} recurring`
              : "recurring payment",
          url: `https://dashboard.stripe.com/subscriptions/${s.id}`,
          external: true,
          status: s.status,
        });
      }
    }

    lane.count = events.length;
    if (!lane.error && events.length === 0) {
      lane.note = "Stripe is connected but has no invoices or subscriptions with dates yet.";
    }
    return { lane, events };
  } catch (e) {
    lane.error = `Stripe unreachable: ${String(e)}`;
    return { lane, events: [] };
  }
}

// ── Bookings lane ──────────────────────────────────────────────────────────
//
// Rows from public.bookings (migration 0017), created by the public /book
// link through /api/booking. Same OS Supabase credentials as the callbacks
// and blocks lanes. Cancelled bookings are left off the calendar; completed
// and no-show stay visible so the day's history reads honestly.

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
  assigned_to: string | null;
};

const FIRST: Record<string, string> = { jack: "Jack", maddox: "Maddox", grant: "Grant" };

async function bookingsLane(): Promise<{ lane: LaneStatus; events: CalendarEvent[] }> {
  const url = sbUrl();
  const key = sbService();
  const lane: LaneStatus = {
    source: "bookings",
    label: "Bookings",
    configured: Boolean(url && key),
    missing: url && key ? null : "OS_SUPABASE_URL / OS_SUPABASE_SERVICE_KEY",
    error: null,
    count: 0,
    note: null,
  };
  if (!url || !key) return { lane, events: [] };
  try {
    const res = await fetch(
      `${url}/rest/v1/bookings?select=id,name,email,phone,starts_at,ends_at,status,source,client_slug,assigned_to` +
        `&status=neq.cancelled&order=starts_at.asc&limit=1000`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` }, cache: "no-store" }
    );
    if (!res.ok) {
      lane.error = `Bookings read failed (HTTP ${res.status})`;
      return { lane, events: [] };
    }
    const rows = (await res.json()) as BookingRow[];
    if (!rows.length) {
      lane.note = "No bookings yet. Share the public link: /book";
      return { lane, events: [] };
    }
    const events = rows.map<CalendarEvent>((r) => ({
      id: `booking:${r.id}`,
      source: "bookings",
      title: r.name,
      start: r.starts_at,
      end: r.ends_at,
      allDay: false,
      detail:
        [
          r.assigned_to ? `with ${FIRST[r.assigned_to] ?? r.assigned_to}` : "not assigned yet",
          r.email,
          r.phone,
          r.client_slug,
        ]
          .filter(Boolean)
          .join(" · ") || null,
      url: null,
      external: false,
      status: r.status,
      color: "var(--accent-2)",
      person: r.assigned_to,
    }));
    lane.count = events.length;
    return { lane, events };
  } catch (e) {
    lane.error = `Bookings unreachable: ${String(e)}`;
    return { lane, events: [] };
  }
}

export async function GET() {
  const [g, c, p, s, b, st, bk] = await Promise.all([
    googleLane(),
    callbackLane(),
    paymentLane(),
    schoolLane(),
    blocksLane(),
    stripeLane(),
    bookingsLane(),
  ]);
  const events = [
    ...g.events, ...c.events, ...p.events, ...s.events, ...b.events, ...st.events,
    ...bk.events,
  ].sort((a, b2) =>
    a.start < b2.start ? -1 : a.start > b2.start ? 1 : 0
  );
  const now = new Date();
  return NextResponse.json({
    events,
    lanes: [g.lane, c.lane, p.lane, s.lane, b.lane, st.lane, bk.lane],
    today: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(
      now.getDate()
    ).padStart(2, "0")}`,
  });
}
