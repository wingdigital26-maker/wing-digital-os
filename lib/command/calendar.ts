// The one shared team calendar. Server-only.
//
// Lives on the wingdigital26 Google account (never Jack's personal one).
// Env:
//   COMMAND_CALENDAR_ID      the shared calendar's ID (Settings > Integrate calendar)
//   GOOGLE_SA_EMAIL          a Google Cloud service account's email
//   GOOGLE_SA_PRIVATE_KEY    that service account's private key (PEM; \n escapes are fine)
// With only the calendar ID: the embed shows, and Add event opens a pre-filled
// Google Calendar link. With the service account too (and the calendar shared
// with it as "Make changes to events"): Add event writes directly and Home
// lists today's and this week's events.
import { importPKCS8, SignJWT } from "jose";
import { TZ } from "./time";

export type CalEvent = { id: string; title: string; start: string; end: string; allDay: boolean; where: string | null; link: string | null };

export function calendarId(): string | null {
  const id = (process.env.COMMAND_CALENDAR_ID || "").trim();
  if (!id) return null;
  // Hard rule: the team calendar is never Jack's personal account.
  if (/wjackwing1/i.test(id)) return null;
  return id;
}

export function calendarApiReady(): boolean {
  return Boolean(calendarId() && process.env.GOOGLE_SA_EMAIL && process.env.GOOGLE_SA_PRIVATE_KEY);
}

export function embedUrl(mode: "WEEK" | "AGENDA" | "MONTH" = "WEEK"): string | null {
  const id = calendarId();
  if (!id) return null;
  const q = new URLSearchParams({ src: id, ctz: TZ, mode, showPrint: "0", showTitle: "0", wkst: "2" });
  return `https://calendar.google.com/calendar/embed?${q}`;
}

/** Pre-filled "add to Google Calendar" link, for when the API is not set up. */
export function addLink(e: { title: string; start: string; end: string; details?: string; where?: string }): string {
  const fmt = (s: string) => s.replace(/[-:]/g, "").replace(/\.\d+/, "");
  const q = new URLSearchParams({
    action: "TEMPLATE",
    text: e.title,
    dates: `${fmt(e.start)}/${fmt(e.end)}`,
    ctz: TZ,
    details: e.details || "",
    location: e.where || "",
  });
  const id = calendarId();
  if (id) q.set("src", id);
  return `https://calendar.google.com/calendar/render?${q}`;
}

let cached: { token: string; exp: number } | null = null;

async function accessToken(): Promise<string> {
  if (cached && cached.exp > Date.now() + 60_000) return cached.token;
  const email = process.env.GOOGLE_SA_EMAIL as string;
  const pem = (process.env.GOOGLE_SA_PRIVATE_KEY as string).replace(/\\n/g, "\n");
  const key = await importPKCS8(pem, "RS256");
  const now = Math.floor(Date.now() / 1000);
  const assertion = await new SignJWT({ scope: "https://www.googleapis.com/auth/calendar.events" })
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuer(email)
    .setAudience("https://oauth2.googleapis.com/token")
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(key);
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
    signal: AbortSignal.timeout(10000),
  });
  const j = (await r.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error_description?: string };
  if (!r.ok || !j.access_token) throw new Error(j.error_description || `Google token HTTP ${r.status}`);
  cached = { token: j.access_token, exp: Date.now() + (j.expires_in ?? 3600) * 1000 };
  return j.access_token;
}

const base = () => `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId()!)}/events`;

export async function listEvents(fromIso: string, toIso: string): Promise<{ ok: true; events: CalEvent[] } | { ok: false; reason: string }> {
  if (!calendarApiReady()) return { ok: false, reason: "not-configured" };
  try {
    const q = new URLSearchParams({ timeMin: fromIso, timeMax: toIso, singleEvents: "true", orderBy: "startTime", maxResults: "100", timeZone: TZ });
    const r = await fetch(`${base()}?${q}`, {
      headers: { Authorization: `Bearer ${await accessToken()}` },
      cache: "no-store",
      signal: AbortSignal.timeout(10000),
    });
    type GEvent = { id: string; summary?: string; location?: string; htmlLink?: string; start?: { dateTime?: string; date?: string }; end?: { dateTime?: string; date?: string } };
    const j = (await r.json().catch(() => ({}))) as { items?: GEvent[]; error?: { message?: string } };
    if (!r.ok) return { ok: false, reason: `Google Calendar said: ${j.error?.message ?? `HTTP ${r.status}`}` };
    return {
      ok: true,
      events: (j.items ?? []).map((e) => ({
        id: String(e.id),
        title: String(e.summary ?? "(no title)"),
        start: e.start?.dateTime ?? e.start?.date ?? "",
        end: e.end?.dateTime ?? e.end?.date ?? "",
        allDay: !e.start?.dateTime,
        where: e.location ?? null,
        link: e.htmlLink ?? null,
      })),
    };
  } catch (e) {
    return { ok: false, reason: `Google Calendar unreachable: ${e instanceof Error ? e.message : e}` };
  }
}

export async function addEvent(e: { title: string; start: string; end: string; details?: string; where?: string; allDay?: boolean }) {
  const body = e.allDay
    ? { summary: e.title, description: e.details, location: e.where, start: { date: e.start.slice(0, 10) }, end: { date: e.end.slice(0, 10) } }
    : { summary: e.title, description: e.details, location: e.where, start: { dateTime: e.start, timeZone: TZ }, end: { dateTime: e.end, timeZone: TZ } };
  const r = await fetch(base(), {
    method: "POST",
    headers: { Authorization: `Bearer ${await accessToken()}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  const j = (await r.json().catch(() => ({}))) as { htmlLink?: string; error?: { message?: string } };
  if (!r.ok) throw new Error(j.error?.message ?? `HTTP ${r.status}`);
  return j.htmlLink ?? null;
}
