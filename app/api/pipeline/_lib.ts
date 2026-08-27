// ───────────────────────────────────────────────────────────────────────────
// Shared plumbing for /api/pipeline/** — the CRM that replaced GoHighLevel.
//
// STYLE: plain fetch against the Supabase REST API, same shape as
// lib/osSupabase.ts and app/api/crm/route.ts. No SDK, deliberately.
//
// WHY A LOCAL FETCH HELPER INSTEAD OF sbSelect(): sbSelect returns [] on any
// failure so read-only dashboards can degrade quietly. That is exactly wrong
// here — an empty pipeline and a broken pipeline look identical, and the UI
// would show "0 deals" for a dead connection. These helpers throw SbError so
// every route can return an honest error the UI can display.
//
// MONEY: value_cents is an integer number of cents, everywhere, always. NULL
// means "not quoted yet" and must survive as null all the way to the client —
// it is never coerced to 0.
// ───────────────────────────────────────────────────────────────────────────
import { NextResponse } from "next/server";
import { getOsSession, hasLegacyAuth, sbUrl, sbService } from "@/lib/osSupabase";

export const STAFF_ROLES = ["admin", "owner", "staff"];

export class SbError extends Error {
  status: number;
  detail: string | null;
  constructor(message: string, status: number, detail: string | null = null) {
    super(message);
    this.name = "SbError";
    this.status = status;
    this.detail = detail;
  }
}

// ── Auth gate ──────────────────────────────────────────────────────────────
// Middleware already blocks unauthenticated requests and 403s client-role
// sessions on /api/*, but every route re-checks here: a route must never depend
// on an upstream matcher staying correct. Fails CLOSED — no session and no
// legacy cookie means no access, and an unconfigured secret means no access.
//
// Returns the staff user's uuid when we have one (Supabase-auth session), or
// null for legacy OS_PASSWORD access, which has no per-user identity. Callers
// use that for owner_id/created_by, where null is honest: "a staff member did
// this, we don't know which".
export type StaffAuth = { ok: true; userId: string | null; email: string | null };

export async function requireStaff(): Promise<StaffAuth | NextResponse> {
  const session = await getOsSession();
  if (session) {
    if (!STAFF_ROLES.includes(session.role)) {
      return NextResponse.json(
        { error: "forbidden", message: "The pipeline is staff-only." },
        { status: 403 }
      );
    }
    return { ok: true, userId: session.sub || null, email: session.email || null };
  }
  if (await hasLegacyAuth()) {
    return { ok: true, userId: null, email: null };
  }
  return NextResponse.json(
    { error: "unauthorized", message: "Sign in to view the pipeline." },
    { status: 401 }
  );
}

export function isAuthFailure(a: StaffAuth | NextResponse): a is NextResponse {
  return a instanceof NextResponse;
}

// ── REST helpers (service key: RLS is staff-only and this process IS staff,
// having already proven it above) ──────────────────────────────────────────
function creds(): { url: string; key: string } {
  const url = sbUrl();
  const key = sbService();
  if (!url || !key) {
    throw new SbError("CRM database is not configured on this deployment.", 503);
  }
  return { url, key };
}

async function sbFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const { url, key } = creds();
  let r: Response;
  try {
    r = await fetch(`${url}/rest/v1/${path}`, {
      ...init,
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        ...(init.headers as Record<string, string> | undefined),
      },
      cache: "no-store",
    });
  } catch (e) {
    throw new SbError("Could not reach the CRM database.", 502, String(e));
  }
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new SbError(
      `CRM query failed (${r.status}).`,
      r.status === 404 ? 500 : 502,
      body.slice(0, 500) || null
    );
  }
  return r;
}

// Read rows. Throws on failure — never an empty array pretending to be a result.
export async function sbGet<T = any>(
  table: string,
  select: string,
  query = ""
): Promise<T[]> {
  const qs = `select=${encodeURIComponent(select)}${query ? `&${query}` : ""}`;
  const r = await sbFetch(`${table}?${qs}`);
  return (await r.json()) as T[];
}

// Read rows plus the authoritative total from Content-Range, so a paginated
// list can say how many rows really exist rather than implying the page is all.
export async function sbGetPaged<T = any>(
  table: string,
  select: string,
  query: string,
  offset: number,
  limit: number
): Promise<{ rows: T[]; total: number | null }> {
  const qs = `select=${encodeURIComponent(select)}${query ? `&${query}` : ""}`;
  const r = await sbFetch(`${table}?${qs}`, {
    headers: {
      Prefer: "count=exact",
      Range: `${offset}-${offset + limit - 1}`,
      "Range-Unit": "items",
    },
  });
  const parsed = Number((r.headers.get("content-range") || "").split("/").pop());
  return {
    rows: (await r.json()) as T[],
    total: Number.isFinite(parsed) ? parsed : null,
  };
}

export async function sbPost<T = any>(
  table: string,
  row: Record<string, unknown>
): Promise<T> {
  const r = await sbFetch(table, {
    method: "POST",
    headers: { "Content-Type": "application/json", Prefer: "return=representation" },
    body: JSON.stringify(row),
  });
  const rows = (await r.json()) as T[];
  if (!rows?.[0]) throw new SbError("Insert returned no row.", 502);
  return rows[0];
}

export async function sbPatch<T = any>(
  table: string,
  query: string,
  patch: Record<string, unknown>
): Promise<T[]> {
  const r = await sbFetch(`${table}?${query}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Prefer: "return=representation" },
    body: JSON.stringify(patch),
  });
  return (await r.json()) as T[];
}

// ── Error rendering ────────────────────────────────────────────────────────
// One shape for every failure so the UI can always show what actually broke
// instead of rendering a plausible-looking empty board.
export function errorResponse(e: unknown): NextResponse {
  if (e instanceof SbError) {
    return NextResponse.json(
      { error: "crm_unavailable", message: e.message, detail: e.detail },
      { status: e.status }
    );
  }
  return NextResponse.json(
    { error: "server_error", message: "Unexpected failure handling the request.", detail: String(e).slice(0, 500) },
    { status: 500 }
  );
}

export function badRequest(message: string): NextResponse {
  return NextResponse.json({ error: "bad_request", message }, { status: 400 });
}

// ── Input coercion ─────────────────────────────────────────────────────────
// NULL means unknown. An empty string, whitespace, or an absent key all mean
// "we do not know this", and are stored as NULL — never as "" and never as 0.
export function nullableText(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length ? t : null;
}

export function requiredText(v: unknown): string | null {
  return nullableText(v);
}

// Money in, as integer cents. undefined/null/"" => null (not quoted).
// A real 0 stays 0 only if the caller explicitly sent the number 0.
export function nullableCents(v: unknown): number | null | undefined {
  if (v === undefined) return undefined; // key absent: leave the column alone
  if (v === null || v === "") return null; // explicitly unknown
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return undefined;
  return n;
}

export function clampInt(v: string | null, def: number, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

// PostgREST value escaping for filters that take a bare value (eq., ilike.).
export function esc(v: string): string {
  return encodeURIComponent(v.replace(/[(),]/g, " "));
}
