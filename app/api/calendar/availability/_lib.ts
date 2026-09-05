import { sbUrl, sbService } from "@/lib/osSupabase";

// ───────────────────────────────────────────────────────────────────────────
// Availability rules — who on the team is actually free for a public booking.
//
// One place for the rule so /api/booking (public slots + insert) and the
// staff availability route agree. Everything is Central wall-clock time:
//
//   free(person, date, start..end) =
//        availability.takes_bookings
//     && the range sits inside one of their hours for that weekday
//     && no calendar_blocks row for that person (or 'team') covers any of it
//        (recurrence='weekly' blocks land on every matching weekday from
//        their anchor date forward, same rule as /api/calendar's blocks lane)
//     && no non-cancelled booking assigned to them overlaps it
//        (a booking with assigned_to NULL is a legacy/unknown row: it is
//        treated as blocking everyone, never as free).
//     && no Google Calendar busy event overlaps it, for the one person whose
//        calendar GOOGLE_CALENDAR_ICS_URL is (Jack). The busy list is passed
//        in by the booking engine (which owns the Chicago↔UTC math); when the
//        feed is unset the list is empty and nobody is excluded by it.
//
// Nothing here invents hours: a person with no availability row is simply
// never free.
//
// Per-person blocks (GAP 2): calendar_blocks already carries a `person` column
// (migration 0019: jack | grant | maddox | team). blockedBy scopes to it, so a
// block owned by 'grant' blocks only Grant and never Jack. That is the whole
// mechanism for keeping Grant off the board during his classes — Jack enters
// each class as a weekly calendar_blocks row with person='grant'. No global
// block and no new column is needed; a 'team' block still blocks everyone as
// before.
// ───────────────────────────────────────────────────────────────────────────

export const PEOPLE = ["jack", "maddox", "grant"] as const;
export type Person = (typeof PEOPLE)[number];

// Assignment preference when several people are free for the same slot.
export const ASSIGN_ORDER: Person[] = ["jack", "grant", "maddox"];

export const FIRST_NAME: Record<string, string> = { jack: "Jack", maddox: "Maddox", grant: "Grant" };

export const WEEKDAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export type WeekdayKey = (typeof WEEKDAY_KEYS)[number];

export type HourRange = [string, string]; // ["09:00", "17:00"]
export type Hours = Partial<Record<WeekdayKey, HourRange[]>>;

export type AvailabilityRow = {
  person: string;
  hours: Hours;
  takes_bookings: boolean;
  updated_at: string;
};

export type BlockRow = {
  id: string;
  date: string;       // YYYY-MM-DD anchor
  start_time: string; // HH:MM:SS
  end_time: string;
  recurrence: string | null;
  person: string;
};

export type BookingSlim = {
  starts_at: string;
  ends_at: string;
  status: string;
  assigned_to: string | null;
};

/** A Google Calendar busy window as real UTC epoch-ms bounds. Built by the
 *  booking engine from the parsed ICS feed (app/lib/ics.ts), which is where
 *  the Chicago↔UTC conversion lives. */
export type BusyInterval = { startMs: number; endMs: number };

/** Whose calendar GOOGLE_CALENDAR_ICS_URL is: busy events exclude only him. */
export const ICS_BUSY_PERSON = "jack";

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isHhmm(v: unknown): v is string {
  return typeof v === "string" && HHMM.test(v);
}

export function toMin(hhmm: string): number {
  const [h, m] = hhmm.slice(0, 5).split(":").map(Number);
  return h * 60 + m;
}

/** Weekday key of a YYYY-MM-DD, read as a plain calendar date. */
export function weekdayOf(ymd: string): WeekdayKey {
  const [y, mo, d] = ymd.split("-").map(Number);
  return WEEKDAY_KEYS[new Date(Date.UTC(y, mo - 1, d)).getUTCDay()];
}

/** Validate a hours object exactly as the table would want it stored. */
export function normalizeHours(input: unknown): { hours: Hours } | { error: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { error: "Hours must be an object keyed by weekday (mon..sun)." };
  }
  const out: Hours = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (!(WEEKDAY_KEYS as readonly string[]).includes(k)) {
      return { error: `Unknown weekday "${k}". Use mon, tue, wed, thu, fri, sat, sun.` };
    }
    if (!Array.isArray(v)) return { error: `${k}: expected a list of [start, end] ranges.` };
    const ranges: HourRange[] = [];
    for (const r of v) {
      if (!Array.isArray(r) || r.length !== 2 || !isHhmm(r[0]) || !isHhmm(r[1])) {
        return { error: `${k}: each range must be ["HH:MM", "HH:MM"].` };
      }
      if (toMin(r[1]) <= toMin(r[0])) return { error: `${k}: a range must end after it starts.` };
      ranges.push([r[0], r[1]]);
    }
    ranges.sort((a, b) => toMin(a[0]) - toMin(b[0]));
    for (let i = 1; i < ranges.length; i++) {
      if (toMin(ranges[i][0]) < toMin(ranges[i - 1][1])) {
        return { error: `${k}: ranges overlap.` };
      }
    }
    if (ranges.length) out[k as WeekdayKey] = ranges;
  }
  return { hours: out };
}

// ── Reads (service key; the callers have already proven staff or are the
// public booking engine, which exposes none of this) ──────────────────────
function creds(): { url: string; key: string } | null {
  const url = sbUrl();
  const key = sbService();
  return url && key ? { url, key } : null;
}

async function restGet<T>(path: string): Promise<T[] | null> {
  const c = creds();
  if (!c) return null;
  try {
    const r = await fetch(`${c.url}/rest/v1/${path}`, {
      headers: { apikey: c.key, Authorization: `Bearer ${c.key}` },
      cache: "no-store",
    });
    if (!r.ok) return null;
    return (await r.json()) as T[];
  } catch {
    return null;
  }
}

export async function loadAvailability(): Promise<AvailabilityRow[] | null> {
  return restGet<AvailabilityRow>("availability?select=*&order=person.asc");
}

export async function loadBlocks(): Promise<BlockRow[] | null> {
  return restGet<BlockRow>(
    "calendar_blocks?select=id,date,start_time,end_time,recurrence,person&limit=2000"
  );
}

// ── The rule ───────────────────────────────────────────────────────────────

/** Does a person's calendar_blocks cover any minute of [startMin, endMin) on ymd? */
export function blockedBy(person: string, ymd: string, startMin: number, endMin: number, blocks: BlockRow[]): boolean {
  const wd = weekdayOf(ymd);
  for (const b of blocks) {
    if (b.person !== person && b.person !== "team") continue;
    if (b.recurrence === "weekly") {
      if (weekdayOf(b.date) !== wd || ymd < b.date) continue;
    } else if (b.date !== ymd) {
      continue;
    }
    const bs = toMin(b.start_time);
    const be = toMin(b.end_time);
    if (bs < endMin && be > startMin) return true;
  }
  return false;
}

export function insideHours(row: AvailabilityRow, ymd: string, startMin: number, endMin: number): boolean {
  const ranges = row.hours?.[weekdayOf(ymd)] ?? [];
  return ranges.some((r) => toMin(r[0]) <= startMin && toMin(r[1]) >= endMin);
}

export function bookedFor(person: string, slotStartIso: string, slotEndIso: string, bookings: BookingSlim[]): boolean {
  return bookings.some(
    (b) =>
      b.status !== "cancelled" &&
      (b.assigned_to === person || b.assigned_to == null) &&
      b.starts_at < slotEndIso &&
      b.ends_at > slotStartIso
  );
}

/** Does any Google Calendar busy window overlap [slotStartIso, slotEndIso)? */
export function isBusy(slotStartIso: string, slotEndIso: string, busy: BusyInterval[]): boolean {
  const s = Date.parse(slotStartIso);
  const e = Date.parse(slotEndIso);
  if (Number.isNaN(s) || Number.isNaN(e)) return false;
  return busy.some((b) => s < b.endMs && e > b.startMs);
}

export type FreeCheck = {
  /** People whose hours contain the slot at all (bookings on or off). */
  inHours: string[];
  /** People who take bookings and are free: in hours, no block, no booking. */
  free: string[];
};

export function whoIsFree(args: {
  ymd: string;
  startMin: number;
  endMin: number;
  slotStartIso: string;
  slotEndIso: string;
  availability: AvailabilityRow[];
  blocks: BlockRow[];
  bookings: BookingSlim[];
  /** Google Calendar busy windows (UTC ms). Empty when the feed is unset, so
   *  behavior is unchanged without it. */
  busy?: BusyInterval[];
  /** Who those busy windows belong to. Defaults to ICS_BUSY_PERSON (jack). */
  busyPerson?: string;
}): FreeCheck {
  const inHours: string[] = [];
  const free: string[] = [];
  const busy = args.busy ?? [];
  const busyPerson = args.busyPerson ?? ICS_BUSY_PERSON;
  for (const row of args.availability) {
    if (!insideHours(row, args.ymd, args.startMin, args.endMin)) continue;
    inHours.push(row.person);
    if (!row.takes_bookings) continue;
    if (blockedBy(row.person, args.ymd, args.startMin, args.endMin, args.blocks)) continue;
    if (bookedFor(row.person, args.slotStartIso, args.slotEndIso, args.bookings)) continue;
    // The Google feed is one person's calendar: a busy event there removes only
    // his freeness, so a slot Jack has a meeting in can still be offered when
    // Grant or Maddox is free — it just never double-books Jack.
    if (row.person === busyPerson && busy.length && isBusy(args.slotStartIso, args.slotEndIso, busy)) continue;
    free.push(row.person);
  }
  return { inHours, free };
}

/** Pick who gets the booking: preference order, first one free. */
export function pickAssignee(free: string[]): string | null {
  for (const p of ASSIGN_ORDER) if (free.includes(p)) return p;
  return free[0] ?? null;
}

/** Union of every booking-taking person's hours on a weekday, as minute ranges. */
export function unionHours(availability: AvailabilityRow[], ymd: string): [number, number][] {
  const wd = weekdayOf(ymd);
  const raw: [number, number][] = [];
  for (const row of availability) {
    if (!row.takes_bookings) continue;
    for (const r of row.hours?.[wd] ?? []) raw.push([toMin(r[0]), toMin(r[1])]);
  }
  raw.sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const r of raw) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else out.push([r[0], r[1]]);
  }
  return out;
}
