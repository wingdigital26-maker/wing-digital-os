// Shared guard + Supabase helpers for the Cold Call Room API.
//
// Every /api/calls/* route re-checks the caller's role here. Middleware already
// blocks non-call roles from these paths, but a route that trusts middleware
// alone breaks the moment someone edits the matcher, so the check lives in both
// places on purpose.
//
// All writes use the SERVICE key. That is deliberate: the browser never holds a
// Supabase key, and the identity we attribute work to comes from the signed
// wingos_session cookie, not from anything the client sent us.
import { getOsSession, hasLegacyAuth, sbUrl, sbService } from "../../../lib/osSupabase";
import type { Session } from "../../lib/session";

export type CallUser = {
  id: string;       // auth.users id, or "legacy" for shared-password access
  email: string;
  role: string;
  isAdmin: boolean;
};

const CALL_ROLES = new Set(["admin", "owner", "staff", "caller"]);
const ADMIN_ROLES = new Set(["admin", "owner"]);

// Returns the signed-in call-room user, or null if this request has no business
// here. Legacy OS_PASSWORD access is accepted and treated as Jack (admin), so
// the room keeps working before the auth swap is finished -- but it has no user
// id, so its activity is attributed to the shared login honestly rather than
// being silently credited to a real person.
export async function requireCallUser(): Promise<CallUser | null> {
  const session: Session | null = await getOsSession();
  if (session) {
    if (!CALL_ROLES.has(session.role)) return null;
    return {
      id: session.sub,
      email: session.email,
      role: session.role,
      isAdmin: ADMIN_ROLES.has(session.role),
    };
  }
  if (await hasLegacyAuth()) {
    return { id: "legacy", email: "shared-login", role: "admin", isAdmin: true };
  }
  return null;
}

function svc() {
  const url = sbUrl();
  const key = sbService();
  if (!url || !key) return null;
  return { url, key };
}

export function sbConfigured(): boolean {
  return svc() !== null;
}

// PATCH rows matching a PostgREST filter. Returns the updated rows, or null on
// any failure so callers can report an honest error instead of a false success.
export async function sbPatch<T = unknown>(
  table: string,
  filter: string,
  patch: Record<string, unknown>
): Promise<T[] | null> {
  const s = svc();
  if (!s) return null;
  try {
    const r = await fetch(`${s.url}/rest/v1/${table}?${filter}`, {
      method: "PATCH",
      headers: {
        apikey: s.key,
        Authorization: `Bearer ${s.key}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
      },
      body: JSON.stringify(patch),
    });
    if (!r.ok) return null;
    return (await r.json()) as T[];
  } catch {
    return null;
  }
}

// GET with the service key (bypasses RLS; the role check above is the gate).
export async function sbGet<T = unknown>(
  table: string,
  qs: string
): Promise<T[] | null> {
  const s = svc();
  if (!s) return null;
  try {
    const r = await fetch(`${s.url}/rest/v1/${table}?${qs}`, {
      headers: { apikey: s.key, Authorization: `Bearer ${s.key}` },
      cache: "no-store",
    });
    if (!r.ok) return null;
    return (await r.json()) as T[];
  } catch {
    return null;
  }
}

export async function sbPost<T = unknown>(
  table: string,
  body: unknown
): Promise<T[] | null> {
  const s = svc();
  if (!s) return null;
  try {
    const r = await fetch(`${s.url}/rest/v1/${table}`, {
      method: "POST",
      headers: {
        apikey: s.key,
        Authorization: `Bearer ${s.key}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
      },
      body: JSON.stringify(body),
    });
    if (!r.ok) return null;
    return (await r.json()) as T[];
  } catch {
    return null;
  }
}

// A claim is a soft lock so two dialers don't hit the same business at once.
// It expires on its own -- a caller who wanders off must not strand a lead.
export const CLAIM_MINUTES = 20;

export const OUTCOMES = [
  "contacted",
  "callback",
  "booked",
  "not_interested",
  "bad_number",
  "dnc",
  "no_answer",
] as const;
export type Outcome = (typeof OUTCOMES)[number];
