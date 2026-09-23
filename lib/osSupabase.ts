// Server-side helpers for the OS Supabase project + the wingos_session cookie.
// Pure fetch against the Supabase REST/Auth endpoints -- no SDK, matching the
// style of app/api/login/route.ts. Node runtime only (uses next/headers cookies).
import { cookies } from "next/headers";
import { verifySession, type Session } from "../app/lib/session";
import { authToken } from "../app/lib/authToken";

export function sbUrl(): string | undefined {
  return process.env.OS_SUPABASE_URL;
}
export function sbAnon(): string | undefined {
  return process.env.OS_SUPABASE_ANON_KEY;
}
export function sbService(): string | undefined {
  return process.env.OS_SUPABASE_SERVICE_KEY;
}

// Read the caller's Supabase-auth session from the wingos_session cookie.
// Returns null when there is no valid session (e.g. legacy OS_PASSWORD access,
// which has no per-user identity).
export async function getOsSession(): Promise<Session | null> {
  const jar = await cookies();
  return verifySession(jar.get("wingos_session")?.value);
}

// True when the request carries the legacy shared-password cookie AND it is
// the real token derived from OS_PASSWORD (same check as middleware.ts). A
// cookie with any other value is not auth. Used to let staff-on-OS_PASSWORD
// still reach endpoints that don't strictly need a user id.
export async function hasLegacyAuth(): Promise<boolean> {
  const jar = await cookies();
  const cookie = jar.get("wingos_auth")?.value;
  if (!cookie) return false;
  // authToken() derives from OS_PASSWORD; with no password set there is no
  // legitimate legacy token, so refuse rather than compare against a default.
  if (!process.env.OS_PASSWORD) return false;
  return cookie === (await authToken());
}

type SbQuery = {
  table: string;
  select?: string;
  // raw PostgREST query string appended after select (e.g. "id=eq.123&order=date.desc")
  query?: string;
  service?: boolean; // use the service key (bypasses RLS) instead of anon
};

// Run a GET against the Supabase REST API. Returns [] on any failure so callers
// can degrade gracefully rather than throw.
export async function sbSelect<T = any>({
  table,
  select = "*",
  query = "",
  service = false,
}: SbQuery): Promise<T[]> {
  const url = sbUrl();
  const key = service ? sbService() : sbAnon();
  if (!url || !key) return [];
  const qs = `select=${encodeURIComponent(select)}${query ? `&${query}` : ""}`;
  try {
    const r = await fetch(`${url}/rest/v1/${table}?${qs}`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
      cache: "no-store",
    });
    if (!r.ok) return [];
    return (await r.json()) as T[];
  } catch {
    return [];
  }
}

// Strict variant of sbSelect: distinguishes real data from failure instead of
// collapsing every error into []. Callers that must not fake an all-clear
// (e.g. /api/alerts) use this. sbSelect's behavior is unchanged.
export type SbStrictResult<T> =
  | { ok: true; rows: T[] }
  | { ok: false; rows: []; error: string };

export async function sbSelectStrict<T = any>({
  table,
  select = "*",
  query = "",
  service = false,
}: SbQuery): Promise<SbStrictResult<T>> {
  const url = sbUrl();
  const key = service ? sbService() : sbAnon();
  if (!url || !key) {
    return { ok: false, rows: [], error: "Supabase env not configured (OS_SUPABASE_URL / key missing)" };
  }
  const qs = `select=${encodeURIComponent(select)}${query ? `&${query}` : ""}`;
  try {
    const r = await fetch(`${url}/rest/v1/${table}?${qs}`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
      cache: "no-store",
    });
    if (!r.ok) {
      return { ok: false, rows: [], error: `Supabase HTTP ${r.status} reading ${table}` };
    }
    return { ok: true, rows: (await r.json()) as T[] };
  } catch (e) {
    return {
      ok: false,
      rows: [],
      error: `Supabase unreachable reading ${table}: ${e instanceof Error ? e.message : "network error"}`,
    };
  }
}

// Insert one row via the service key and return the created row(s).
export async function sbInsert<T = any>(
  table: string,
  row: Record<string, unknown>
): Promise<T | null> {
  const url = sbUrl();
  const key = sbService();
  if (!url || !key) return null;
  try {
    const r = await fetch(`${url}/rest/v1/${table}`, {
      method: "POST",
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
      },
      body: JSON.stringify(row),
    });
    if (!r.ok) return null;
    const rows = (await r.json()) as T[];
    return rows?.[0] ?? null;
  } catch {
    return null;
  }
}

// ── Naming the failure ─────────────────────────────────────────────────────
// Every read in this OS used to collapse into the same shrug ("query failed",
// "not configured or unreachable"), which hid the one thing worth knowing:
// WHICH failure it was. These two helpers exist so a route can say the real
// reason in one sentence the reader can act on.

const QUOTA_RE = /exceed_storage_size_quota/i;
const MISSING_TABLE_RE = /PGRST205|42P01|does not exist/i;

// One sentence for a failed PostgREST read. `body` is the raw response text.
// The 402 storage restriction gets its own wording because it is not a bug in
// the route: Supabase switches the whole project off at once, every table,
// until the quota is cleared, and no amount of retrying will change that.
export function sbFailureReason(status: number, body: string, table = ""): string {
  const at = table ? ` (reading ${table})` : "";
  if (status === 402) {
    if (QUOTA_RE.test(body)) {
      return (
        "Supabase has restricted this project for exceeding its storage quota, so every table read " +
        `is refused with HTTP 402${at}. This is not an empty table. Clear the quota in the Supabase ` +
        "dashboard and the data comes back on its own."
      );
    }
    return `Supabase has restricted this project: HTTP 402${at}. ${body.slice(0, 160)}`;
  }
  if (status === 401 || status === 403) {
    return `Supabase refused the key: HTTP ${status}${at}. The service key is wrong, expired, or blocked by RLS.`;
  }
  if (status === 404 || MISSING_TABLE_RE.test(body)) {
    return `That table is not in the database yet${at}. Its migration has not been applied.`;
  }
  return `Supabase returned HTTP ${status}${at}. ${body.slice(0, 160)}`.trim();
}

// PostgREST reports the real row count in Content-Range, as "0-24/1036". A
// MISSING header means the count is UNKNOWN and must read as null: Number("")
// is 0, and that one coercion is how a dead connection rendered as an empty
// table all over this OS.
export function contentRangeTotal(header: string | null | undefined): number | null {
  const tail = (header || "").split("/").pop();
  if (!tail || !/^\d+$/.test(tail)) return null;
  return Number(tail);
}
