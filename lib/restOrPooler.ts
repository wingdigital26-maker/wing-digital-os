// ───────────────────────────────────────────────────────────────────────────
// REST first, direct pooler second. Every helper THROWS DbError on failure.
//
// Since 2026-09-21 Supabase answers HTTP 402 to every REST call (storage
// quota) while Postgres itself is fine. Each call here tries PostgREST first
// and, on a 402 or a network failure before any response, replays the same
// query over the direct pooler connection (OS_DB_URL, lib/pgFallback). With no
// REST config at all it goes straight to the pooler.
//
// Used by the client intake form, the review sender, the SMS/email
// suppression checks, the message ledger and the opt-out writers, so a dead
// REST layer can never make an opt-out silently disappear or make a send look
// safe when it was not checked.
// ───────────────────────────────────────────────────────────────────────────
import { sbUrl, sbService, sbFailureReason } from "@/lib/osSupabase";
import { pgConfigured, pgSelect, pgInsert, pgPatch } from "@/lib/pgFallback";

export class DbError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DbError";
  }
}

export type Via = "rest" | "pooler";
// Which path answered the most recent call (dev-only proof headers use it).
let lastVia: Via | null = null;
export function lastPath(): Via | null {
  return lastVia;
}

function svc(): { url: string; key: string } | null {
  const url = sbUrl();
  const key = sbService();
  return url && key ? { url, key } : null;
}

async function viaPooler<T>(fn: () => Promise<T[]>): Promise<T[]> {
  try {
    const rows = await fn();
    lastVia = "pooler";
    return rows;
  } catch (e) {
    throw new DbError(`Direct database connection failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

const NOT_CONFIGURED = "The database is not configured on this server.";

// GET rows. qs is a PostgREST query string that includes select=.
export async function dbSelect<T>(table: string, qs: string): Promise<T[]> {
  const s = svc();
  if (!s) {
    if (pgConfigured()) return viaPooler(() => pgSelect<T>(table, qs));
    throw new DbError(NOT_CONFIGURED);
  }
  let r: Response;
  try {
    r = await fetch(`${s.url}/rest/v1/${table}?${qs}`, {
      headers: { apikey: s.key, Authorization: `Bearer ${s.key}` },
      cache: "no-store",
    });
  } catch (e) {
    if (pgConfigured()) return viaPooler(() => pgSelect<T>(table, qs));
    throw new DbError(`Could not reach the database: ${String(e)}`);
  }
  if (r.status === 402 && pgConfigured()) return viaPooler(() => pgSelect<T>(table, qs));
  if (!r.ok) throw new DbError(sbFailureReason(r.status, await r.text().catch(() => ""), table));
  lastVia = "rest";
  return (await r.json()) as T[];
}

// INSERT one row and return it. Throws unless the database handed a row back.
export async function dbInsert<T>(table: string, row: Record<string, unknown>): Promise<T> {
  const s = svc();
  let rows: T[];
  if (!s) {
    if (!pgConfigured()) throw new DbError(NOT_CONFIGURED);
    rows = await viaPooler(() => pgInsert<T>(table, row));
  } else {
    let r: Response | null = null;
    try {
      r = await fetch(`${s.url}/rest/v1/${table}`, {
        method: "POST",
        headers: {
          apikey: s.key,
          Authorization: `Bearer ${s.key}`,
          "Content-Type": "application/json",
          Prefer: "return=representation",
        },
        body: JSON.stringify(row),
        cache: "no-store",
      });
    } catch (e) {
      // A network failure before a response: the REST insert never happened,
      // so replaying it over the pooler cannot double-write.
      if (!pgConfigured()) throw new DbError(`Could not reach the database: ${String(e)}`);
    }
    if (!r || (r.status === 402 && pgConfigured())) {
      rows = await viaPooler(() => pgInsert<T>(table, row));
    } else if (!r.ok) {
      throw new DbError(sbFailureReason(r.status, await r.text().catch(() => ""), table));
    } else {
      rows = (await r.json()) as T[];
      lastVia = "rest";
    }
  }
  if (!rows?.[0]) throw new DbError(`The database did not confirm the new ${table} row.`);
  return rows[0];
}

// PATCH rows matching a filter and return them. Throws on failure.
export async function dbPatch<T>(table: string, filter: string, body: Record<string, unknown>): Promise<T[]> {
  const s = svc();
  if (!s) {
    if (!pgConfigured()) throw new DbError(NOT_CONFIGURED);
    return viaPooler(() => pgPatch<T>(table, filter, body));
  }
  let r: Response | null = null;
  try {
    r = await fetch(`${s.url}/rest/v1/${table}?${filter}`, {
      method: "PATCH",
      headers: {
        apikey: s.key,
        Authorization: `Bearer ${s.key}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
      },
      body: JSON.stringify(body),
      cache: "no-store",
    });
  } catch (e) {
    if (!pgConfigured()) throw new DbError(`Could not reach the database: ${String(e)}`);
  }
  if (!r || (r.status === 402 && pgConfigured())) return viaPooler(() => pgPatch<T>(table, filter, body));
  if (!r.ok) throw new DbError(sbFailureReason(r.status, await r.text().catch(() => ""), table));
  lastVia = "rest";
  return (await r.json()) as T[];
}
