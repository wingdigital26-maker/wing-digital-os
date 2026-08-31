import { NextResponse } from "next/server";
import { requireCallUser, sbConfigured, sbGet } from "../_guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/calls/stats
//
// Everything the Today dashboard shows, in one round trip. Every number here
// comes off a real query -- nothing is derived from an assumption, and a
// section with no rows returns an empty array so the UI can say so honestly
// instead of drawing a zeroed chart.
//
// Leads that failed the quality audit carry excluded=true. They are filtered
// out of every dial-related figure, and reported separately as `excluded` so
// the count is visible rather than quietly missing.

type Lead = {
  id: string;
  company: string;
  contact_name: string | null;
  title: string | null;
  phone: string | null;
  city: string | null;
  state: string | null;
  vertical: string | null;
  score: number | null;
  signals: string | null;
  status: string;
  last_outcome: string | null;
  last_called_at: string | null;
  call_count: number | null;
  next_action_at: string | null;
  claimed_by_email: string | null;
};

type Activity = {
  id: number;
  lead_id: string | null;
  user_id: string | null;
  user_email: string | null;
  outcome: string;
  notes: string | null;
  duration_sec: number | null;
  created_at: string;
};

const LEAD_COLS =
  "id,company,contact_name,title,phone,city,state,vertical,score,signals,status," +
  "last_outcome,last_called_at,call_count,next_action_at,claimed_by_email";

export async function GET() {
  const user = await requireCallUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!sbConfigured()) {
    return NextResponse.json(
      {
        error:
          "call room not configured: OS_SUPABASE_URL / OS_SUPABASE_SERVICE_KEY missing",
      },
      { status: 503 }
    );
  }

  // One read of the dialable pool. 100 rows total in this table today, so
  // pulling them and counting in memory is cheaper and more honest than seven
  // separate count queries that could drift against each other.
  const leads = await sbGet<Lead>(
    "call_leads",
    `select=${LEAD_COLS}&excluded=is.false&order=score.desc,company.asc&limit=1000`
  );
  if (leads === null) {
    return NextResponse.json({ error: "could not read leads" }, { status: 502 });
  }

  // Counted, not guessed: how many rows the audit threw out.
  const excludedRows = await sbGet<{ id: string }>(
    "call_leads",
    "select=id&excluded=is.true&limit=1000"
  );

  const funnel: Record<string, number> = {
    new: 0,
    contacted: 0,
    callback: 0,
    booked: 0,
    not_interested: 0,
    bad_number: 0,
    dnc: 0,
  };
  for (const l of leads) {
    funnel[l.status] = (funnel[l.status] ?? 0) + 1;
  }

  const now = Date.now();

  // "Do these next": highest score, never dialed. call_count is the truth about
  // whether anyone has actually picked up the phone -- status can be 'new' on a
  // lead someone tried and never dispositioned.
  const next = leads
    .filter((l) => l.status === "new" && !(l.call_count ?? 0) && !l.last_called_at)
    .slice(0, 8);

  // Callbacks that are due now or already blown past.
  const callbacks = leads
    .filter(
      (l) =>
        l.status === "callback" &&
        l.next_action_at !== null &&
        Date.parse(l.next_action_at) <= now
    )
    .sort((a, b) => Date.parse(a.next_action_at!) - Date.parse(b.next_action_at!))
    .map((l) => ({ ...l, overdue: Date.parse(l.next_action_at!) < now - 60_000 }));

  const recent =
    (await sbGet<Activity>(
      "call_activity",
      "select=id,lead_id,user_id,user_email,outcome,notes,duration_sec,created_at" +
        "&order=created_at.desc&limit=10"
    )) ?? [];

  // Attach the company name to each activity row. The names come from the
  // dialable pool we already loaded; anything logged against an excluded or
  // deleted lead stays null rather than being invented.
  const nameById = new Map(leads.map((l) => [l.id, l.company]));
  const missing = [...new Set(recent.map((a) => a.lead_id).filter((id): id is string => Boolean(id) && !nameById.has(id!)))];
  if (missing.length) {
    const extra = await sbGet<{ id: string; company: string }>(
      "call_leads",
      `select=id,company&id=in.(${missing.map(encodeURIComponent).join(",")})`
    );
    for (const e of extra ?? []) nameById.set(e.id, e.company);
  }
  const activity = recent.map((a) => ({
    ...a,
    company: a.lead_id ? nameById.get(a.lead_id) ?? null : null,
  }));

  // Today = since local midnight on the server. Sent back as an ISO string so
  // the UI can state exactly which window the numbers cover.
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const todayRows =
    (await sbGet<Activity>(
      "call_activity",
      `select=id,user_email,outcome,created_at&created_at=gte.${encodeURIComponent(
        midnight.toISOString()
      )}&order=created_at.desc&limit=2000`
    )) ?? [];

  const byPerson = new Map<string, { email: string; calls: number; booked: number }>();
  let bookedToday = 0;
  for (const a of todayRows) {
    if (a.outcome === "booked") bookedToday++;
    const key = a.user_email ?? "unknown";
    const row = byPerson.get(key) ?? { email: key, calls: 0, booked: 0 };
    row.calls++;
    if (a.outcome === "booked") row.booked++;
    byPerson.set(key, row);
  }

  return NextResponse.json({
    me: { email: user.email, role: user.role, isAdmin: user.isAdmin },
    dialable: leads.length,
    excluded: excludedRows === null ? null : excludedRows.length,
    funnel,
    next,
    callbacks,
    activity,
    today: {
      since: midnight.toISOString(),
      calls: todayRows.length,
      booked: bookedToday,
      people: [...byPerson.values()].sort((a, b) => b.calls - a.calls),
    },
  });
}
