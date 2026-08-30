import { NextRequest, NextResponse } from "next/server";
import { pushToAll } from "@/lib/push";

export const runtime = "nodejs";
export const maxDuration = 60;

// Assignment due-tomorrow push. Called by an EXTERNAL GitHub Actions job (the
// schedule app's Canvas poller) once a day, PC on or off. It only sends what it
// is given -- it never invents assignments and never sends a "nothing due"
// notification.
//
// Auth: Bearer SCHEDULE_PUSH_SECRET. Same bearer convention as the cron
// watchdog, but a DIFFERENT env var on purpose: this key must not be able to
// trigger watchdog behaviour, and CRON_SECRET must not be able to fire pushes
// here.

const SCHEDULE_URL = "https://wingdigital26-maker.github.io/schedule/";
const TAG = "schedule-due-tomorrow"; // stable: a repeat send replaces, never stacks

type Item = {
  title?: unknown;
  course?: unknown;
  due?: unknown;
  time?: unknown;
  url?: unknown;
};

type Clean = { title: string; course: string; due: string; time: string; url: string };

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function authorized(req: NextRequest): boolean {
  const secret = process.env.SCHEDULE_PUSH_SECRET;
  if (!secret) return false; // fail CLOSED: no key configured => nobody gets in
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

// "14:30" -> "2:30pm". Anything unparseable is passed through as-is.
function prettyTime(t: string): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(t);
  if (!m) return t;
  const h = Number(m[1]);
  if (h > 23 || Number(m[2]) > 59) return t;
  const suffix = h < 12 ? "am" : "pm";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${m[2]}${suffix}`;
}

function summarize(items: Clean[]): { title: string; body: string } {
  if (items.length === 1) {
    const it = items[0];
    const when = it.time ? ` — due ${prettyTime(it.time)}` : "";
    return {
      title: `Due tomorrow: ${it.course || "Class"}`,
      body: `${it.title || "Assignment"}${when}`,
    };
  }
  const lines = items.map((it) => {
    const course = it.course ? `${it.course}: ` : "";
    const when = it.time ? ` (${prettyTime(it.time)})` : "";
    return `${course}${it.title || "Assignment"}${when}`;
  });
  return { title: `${items.length} due tomorrow`, body: lines.join("\n") };
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json body" }, { status: 400 });
  }

  const raw = (body as { items?: unknown } | null)?.items;
  if (!Array.isArray(raw)) {
    return NextResponse.json(
      { error: "body must be { items: [...] }" },
      { status: 400 }
    );
  }

  // Keep only entries that carry something worth notifying about. A row with no
  // title AND no course is noise, not an assignment -- drop it rather than
  // pushing a blank line.
  const items: Clean[] = (raw as Item[])
    .map((it) => ({
      title: str(it?.title),
      course: str(it?.course),
      due: str(it?.due),
      time: str(it?.time),
      url: str(it?.url),
    }))
    .filter((it) => it.title || it.course);

  if (items.length === 0) {
    // Nothing due => stay silent. Never send a "you have nothing" notification.
    return NextResponse.json({ sent: 0, failed: 0, total: 0, notified: 0 });
  }

  const { title, body: text } = summarize(items);
  const result = await pushToAll({
    title,
    body: text,
    // Single item with its own Canvas link opens that; otherwise the schedule app.
    url: items.length === 1 && items[0].url ? items[0].url : SCHEDULE_URL,
    tag: TAG,
  });

  // total === 0 means either push is unconfigured (no VAPID / no Supabase) or no
  // device has ever subscribed. Either way nothing was delivered -- say so
  // plainly instead of letting the caller read sent:0 as success.
  const configured = result.total > 0;
  return NextResponse.json({
    ...result,
    configured,
    notified: items.length,
    ...(configured ? {} : { note: "no push subscriptions reachable (VAPID/Supabase unset or no devices registered)" }),
  });
}
