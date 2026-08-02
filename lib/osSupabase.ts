// Server-side helpers for the OS Supabase project + the wingos_session cookie.
// Pure fetch against the Supabase REST/Auth endpoints -- no SDK, matching the
// style of app/api/login/route.ts. Node runtime only (uses next/headers cookies).
import { cookies } from "next/headers";
import { verifySession, type Session } from "../app/lib/session";

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

// True when the request carries the legacy shared-password cookie. Used to let
// staff-on-OS_PASSWORD still reach endpoints that don't strictly need a user id.
export async function hasLegacyAuth(): Promise<boolean> {
  const jar = await cookies();
  return Boolean(jar.get("wingos_auth")?.value);
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
