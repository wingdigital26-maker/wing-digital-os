import { NextRequest, NextResponse } from "next/server";
import { pushToAll } from "@/lib/push";
import { bearerOk } from "@/lib/rateLimit";
import { sbSelect } from "@/lib/osSupabase";

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
  // Constant-time compare, and fails closed when SCHEDULE_PUSH_SECRET is unset.
  return bearerOk(req.headers.get("authorization"), process.env.SCHEDULE_PUSH_SECRET);
}

// Hosts a notification is allowed to open when tapped.
//
// The url comes from the caller's JSON and public/sw.js hands it straight to
// w.navigate() on notificationclick, so without this list anyone holding the
// push secret can make a notification on Jack's phone open any site they like.
// "starts with https" is not enough -- https://evil.example is https. The host
// itself has to be one we chose.
const ALLOWED_PUSH_HOSTS = (
  process.env.SCHEDULE_PUSH_ALLOWED_HOSTS ||
  "canvas.ou.edu,wingdigital26-maker.github.io"
)
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

function safeUrl(raw: string): string | null {
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null;
  const host = u.hostname.toLowerCase();
  // Exact host, or any Canvas tenant on instructure.com (schools move between
  // their own vanity host and *.instructure.com).
  const ok =
    ALLOWED_PUSH_HOSTS.includes(host) ||
    host === "instructure.com" ||
    host.endsWith(".instructure.com");
  return ok ? u.toString() : null;
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

// Same definition of "configured" the send path uses (result.total > 0): VAPID
// + Supabase set AND at least one device actually registered. Computed here
// without sending anything, so the zero-items path can report it honestly.
async function pushConfigured(): Promise<boolean> {
  if (!process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) return false;
  const subs = await sbSelect<{ id: number }>({
    table: "push_subscriptions",
    select: "id",
    query: "limit=1",
    service: true,
  });
  return subs.length > 0;
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
    // `configured` is still reported: the caller has to be able to tell "nothing
    // was due" apart from "the push pipe is dead", and those look identical
    // without it. Nothing was sent, so this reflects whether it COULD have been.
    const reachable = await pushConfigured();
    return NextResponse.json({
      sent: 0,
      failed: 0,
      total: 0,
      notified: 0,
      configured: reachable,
      ...(reachable
        ? {}
        : { note: "no push subscriptions reachable (VAPID/Supabase unset or no devices registered)" }),
    });
  }

  const { title, body: text } = summarize(items);
  // Single item with its own Canvas link opens that; otherwise the schedule
  // app. A url pointing anywhere we did not whitelist falls back too.
  const target = (items.length === 1 && safeUrl(items[0].url)) || SCHEDULE_URL;
  const result = await pushToAll({
    title,
    body: text,
    url: target,
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
