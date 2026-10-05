// ───────────────────────────────────────────────────────────────────────────
// Roof Command, read-only, server-side only.
//
// Roof Command lives in its OWN Supabase project (a separate free org, on
// purpose: a quota 402 is org-wide and the OS project has been REST-restricted
// since 09-21). The OS never merges it and never writes to it. This module only
// issues GET / HEAD SELECTs against its REST API with the service key, which
// stays on the server: nothing here is importable from a client component.
//
// Env (both required, else the page shows the single "not connected" state):
//   ROOF_SUPABASE_URL          https://<ref>.supabase.co
//   ROOF_SUPABASE_SERVICE_KEY  the Roof Command service-role key
//
// Per-roofer aggregates mirror the "overview" action of
// roof-command-demo-ja/supabase/functions/admin/index.ts. Owner and homeowner
// names are never selected. Any number we could not read is null ("unknown"),
// never a fake 0.
// ───────────────────────────────────────────────────────────────────────────

export type RoofCoverage = {
  homesWatched: number | null;
  countiesLive: number;
  counties: string[];
  latestStorm: { date: string; homes1in: number | null; maxHailIn: number | null; counties: number } | null;
  stormsThisSeason: number | null;
  seasonYear: number;
};

export type RoofClient = {
  name: string;
  plan: string | null;
  status: string | null;
  isTest: boolean;
  counties: number | null;
  queuedToday: number | null;
  callAttempts7d: number | null;
  bookedFromCalls7d: number | null;
  booked: number | null;
  shown: number | null;
  signed: number | null;
  jobValue: number | null;
  pilotFloor: number | null;
  lastActivity: string | null;
};

export type RoofOverview =
  | { connected: false }
  | { connected: true; ok: false; error: string }
  | {
      connected: true;
      ok: true;
      generatedAt: string;
      monthStart: string;
      coverage: RoofCoverage;
      clients: RoofClient[];
    };

function creds(): { url: string; key: string } | null {
  const url = (process.env.ROOF_SUPABASE_URL || "").trim().replace(/\/+$/, "");
  const key = (process.env.ROOF_SUPABASE_SERVICE_KEY || "").trim();
  return url && key ? { url, key } : null;
}

class RoofError extends Error {}

async function rest(c: { url: string; key: string }, path: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(`${c.url}/rest/v1/${path}`, {
    ...init,
    // GET/HEAD only. This client has no write verbs on purpose.
    method: init.method === "HEAD" ? "HEAD" : "GET",
    headers: {
      apikey: c.key,
      Authorization: `Bearer ${c.key}`,
      ...(init.headers || {}),
    },
    cache: "no-store",
    signal: AbortSignal.timeout(15000),
  });
  return res;
}

async function rows<T>(c: { url: string; key: string }, path: string): Promise<T[]> {
  const res = await rest(c, path);
  if (!res.ok) throw new RoofError(`Roof Command returned ${res.status} for ${path.split("?")[0]}`);
  return (await res.json()) as T[];
}

/** Exact row count for a filter, or null if it could not be read. */
async function count(c: { url: string; key: string }, table: string, filter: string): Promise<number | null> {
  try {
    const res = await rest(c, `${table}?select=*&${filter}`, {
      method: "HEAD",
      headers: { Prefer: "count=exact", Range: "0-0" },
    });
    if (!res.ok && res.status !== 206) return null;
    const m = /\/(\d+)$/.exec(res.headers.get("content-range") || "");
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

async function safeRows<T>(c: { url: string; key: string }, path: string): Promise<T[] | null> {
  try {
    return await rows<T>(c, path);
  } catch {
    return null;
  }
}

// ── America/Chicago calendar math (DST aware), same approach as the admin fn ──
function chiParts(d: Date): Record<string, number> {
  const o: Record<string, number> = {};
  for (const p of new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago", hourCycle: "h23", year: "numeric", month: "numeric",
    day: "numeric", hour: "numeric", minute: "numeric", second: "numeric",
  }).formatToParts(d)) if (p.type !== "literal") o[p.type] = Number(p.value);
  return o;
}
function chiMidnight(y: number, m: number, d: number): string {
  let t = Date.UTC(y, m - 1, d);
  for (let i = 0; i < 2; i++) {
    const o = chiParts(new Date(t));
    t -= Date.UTC(o.year, o.month - 1, o.day, o.hour, o.minute, o.second) - Date.UTC(y, m - 1, d);
  }
  return new Date(t).toISOString();
}
const pad = (n: number) => String(n).padStart(2, "0");

const enc = encodeURIComponent;

export async function getRoofOverview(): Promise<RoofOverview> {
  const c = creds();
  if (!c) return { connected: false };

  try {
    const now = new Date();
    const lc = chiParts(now);
    const monthStart = chiMidnight(lc.year, lc.month, 1);
    const todayLocal = `${lc.year}-${pad(lc.month)}-${pad(lc.day)}`;
    const weekAgo = new Date(now.getTime() - 7 * 24 * 3600 * 1000).toISOString();
    const seasonStart = `${lc.year}-01-01`;

    // ── Coverage ────────────────────────────────────────────────────────────
    const regions = await rows<{ id: string; name: string; home_count: number | null }>(
      c, "regions?select=id,name,home_count&order=name",
    );
    const ids = regions.map(r => r.id);
    const homesWatched = regions.length && regions.every(r => typeof r.home_count === "number")
      ? regions.reduce((s, r) => s + (r.home_count as number), 0)
      : null;

    type StormRow = { region: string; date: string; max_in: number | null; homes_1in: number | null };
    let latestStorm: RoofCoverage["latestStorm"] = null;
    let stormsThisSeason: number | null = null;
    if (ids.length) {
      const inList = `region=in.(${ids.map(enc).join(",")})`;
      const recent = await rows<StormRow>(c, `storms?select=region,date,max_in,homes_1in&${inList}&order=date.desc&limit=50`);
      if (recent.length) {
        const d = recent[0].date;
        const same = recent.filter(r => r.date === d);
        const hailVals = same.map(r => r.max_in).filter((v): v is number => typeof v === "number");
        latestStorm = {
          date: d,
          homes1in: same.every(r => typeof r.homes_1in === "number")
            ? same.reduce((s, r) => s + (r.homes_1in as number), 0) : null,
          maxHailIn: hailVals.length ? Math.max(...hailVals) : null,
          counties: same.length,
        };
      }
      const season = await safeRows<{ date: string }>(c, `storms?select=date&${inList}&date=gte.${seasonStart}&limit=5000`);
      stormsThisSeason = season ? new Set(season.map(r => r.date)).size : null;
    }

    // ── Roofer clients (no owner fields selected, ever) ────────────────────────
    const companies = await rows<{
      id: string; name: string; plan: string | null; status: string | null; counties: unknown;
    }>(c, "companies?select=id,name,plan,status,counties&order=name");

    const clients: RoofClient[] = await Promise.all(companies.map(async co => {
      const cf = `company_id=eq.${enc(co.id)}`;
      const [queuedToday, callAttempts7d, bookedFromCalls7d, booked, shown, signed, jobs, settings, lastAttempt, lastLead] =
        await Promise.all([
          count(c, "daily_contacts", `${cf}&queued_on=eq.${todayLocal}`),
          count(c, "contact_attempts", `${cf}&channel=eq.call&at=gte.${enc(weekAgo)}`),
          count(c, "contact_attempts", `${cf}&outcome=eq.booked&at=gte.${enc(weekAgo)}`),
          count(c, "homeowner_leads", `${cf}&booked_at=gte.${enc(monthStart)}`),
          count(c, "homeowner_leads", `${cf}&shown_at=gte.${enc(monthStart)}`),
          count(c, "homeowner_leads", `${cf}&signed_at=gte.${enc(monthStart)}`),
          safeRows<{ job_value: number | null }>(c, `homeowner_leads?select=job_value&${cf}&signed_at=gte.${enc(monthStart)}&limit=10000`),
          safeRows<{ pilot_floor: number | null }>(c, `company_settings?select=pilot_floor&${cf}&limit=1`),
          safeRows<{ at: string }>(c, `contact_attempts?select=at&${cf}&order=at.desc&limit=1`),
          safeRows<{ created_at: string; status_at: string | null }>(c, `homeowner_leads?select=created_at,status_at&${cf}&order=created_at.desc&limit=1`),
        ]);
      const stamps = [
        lastAttempt?.[0]?.at,
        lastLead?.[0]?.created_at,
        lastLead?.[0]?.status_at,
      ].filter((s): s is string => !!s).sort();
      return {
        name: co.name,
        plan: co.plan,
        status: co.status,
        isTest: /\btest\b/i.test(co.name),
        counties: Array.isArray(co.counties) ? co.counties.length : null,
        queuedToday,
        callAttempts7d,
        bookedFromCalls7d,
        booked,
        shown,
        signed,
        jobValue: jobs ? jobs.reduce((s, j) => s + (Number(j.job_value) || 0), 0) : null,
        pilotFloor: settings ? settings[0]?.pilot_floor ?? null : null,
        lastActivity: stamps.length ? stamps[stamps.length - 1] : null,
      };
    }));

    return {
      connected: true,
      ok: true,
      generatedAt: now.toISOString(),
      monthStart: monthStart.slice(0, 10),
      coverage: {
        homesWatched,
        countiesLive: regions.length,
        counties: regions.map(r => r.name),
        latestStorm,
        stormsThisSeason,
        seasonYear: lc.year,
      },
      clients,
    };
  } catch (e) {
    const msg = e instanceof RoofError ? e.message
      : e instanceof Error && e.name === "TimeoutError" ? "Roof Command took too long to answer."
      : "Could not reach Roof Command.";
    return { connected: true, ok: false, error: msg };
  }
}
