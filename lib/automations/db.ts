// ───────────────────────────────────────────────────────────────────────────
// Database plumbing for the automation engine (lib/automations/engine.ts).
//
// Re-exports the pipeline helpers (throw-on-failure, service key, plain
// fetch) and adds the one primitive the engine needs that nothing else did:
// an insert that can tell a UNIQUE violation apart from every other failure.
// workflow_runs has UNIQUE (workflow_id, event_id); that constraint IS the
// idempotency guarantee, so "conflict" has to be a first-class result, not a
// 502 the caller has to regex out of an error string.
//
// STYLE: plain fetch against the Supabase REST API with the service key. No
// SDK. RLS on every automation table is staff-only and this process is the
// engine, which has already been authorized by whoever invoked it (staff
// route, cron secret, or a server-side emitter).
// ───────────────────────────────────────────────────────────────────────────
import { sbUrl, sbService } from "@/lib/osSupabase";
import { SbError } from "@/app/api/pipeline/_lib";

export { sbGet, sbGetPaged, sbPost, sbPatch, SbError, esc, nullableText } from "@/app/api/pipeline/_lib";
export { sbDelete } from "@/app/api/sequences/_lib";

function creds(): { url: string; key: string } {
  const url = sbUrl();
  const key = sbService();
  if (!url || !key) {
    throw new SbError("Automation database is not configured on this deployment.", 503);
  }
  return { url, key };
}

export type InsertResult<T> = { row: T; conflict: false } | { row: null; conflict: true };

// Insert one row. Returns { conflict: true } on a UNIQUE violation (HTTP 409
// from PostgREST, Postgres code 23505) and throws SbError on anything else.
export async function sbInsertOrConflict<T = unknown>(
  table: string,
  row: Record<string, unknown>
): Promise<InsertResult<T>> {
  const { url, key } = creds();
  let r: Response;
  try {
    r = await fetch(`${url}/rest/v1/${table}`, {
      method: "POST",
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
      },
      body: JSON.stringify(row),
      cache: "no-store",
    });
  } catch (e) {
    throw new SbError("Could not reach the automation database.", 502, String(e));
  }
  if (r.status === 409) {
    return { row: null, conflict: true };
  }
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    if (/23505|duplicate key/i.test(body)) return { row: null, conflict: true };
    throw new SbError(`Insert into ${table} failed (${r.status}).`, 502, body.slice(0, 500) || null);
  }
  const rows = (await r.json()) as T[];
  if (!rows?.[0]) throw new SbError(`Insert into ${table} returned no row.`, 502);
  return { row: rows[0], conflict: false };
}

// Exact row count for a PostgREST filter, from the Content-Range header.
// Returns null (unknown) when the header is missing, never 0.
export async function sbCount(table: string, query: string): Promise<number | null> {
  const { url, key } = creds();
  let r: Response;
  try {
    r = await fetch(`${url}/rest/v1/${table}?select=id${query ? `&${query}` : ""}`, {
      method: "HEAD",
      headers: { apikey: key, Authorization: `Bearer ${key}`, Prefer: "count=exact" },
      cache: "no-store",
    });
  } catch (e) {
    throw new SbError("Could not reach the automation database.", 502, String(e));
  }
  if (!r.ok) throw new SbError(`Count on ${table} failed (${r.status}).`, 502);
  const parsed = Number((r.headers.get("content-range") || "").split("/").pop());
  return Number.isFinite(parsed) ? parsed : null;
}
