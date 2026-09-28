// ───────────────────────────────────────────────────────────────────────────
// Data layer for the client "add a customer" form (/add/<slug>/<key>).
//
// A client (Hero's, Jackson, Renewal...) opens their private link after a job
// and adds the customer they just served. Those rows land in crm_contacts
// tagged with the client's slug, and a review request is QUEUED (never sent).
//
// WHY THIS FILE EXISTS INSTEAD OF REUSING sbSelect / verifyClientKey
//   * sbSelect collapses every failure into [] -- a dead database would read as
//     "no customers yet" and, worse, a failed save could look like success.
//     Every helper here THROWS IntakeDbError on failure, so the route can tell
//     the client plainly that nothing was saved.
//   * Since 2026-09-21 Supabase answers HTTP 402 to every REST call (storage
//     quota), while Postgres itself is fine. Like the Call Room, each call here
//     tries REST first and, on a 402 or a network failure, replays the same
//     query over the direct pooler connection (OS_DB_URL, lib/pgFallback).
//     With no REST config at all it goes straight to the pooler.
//
// Nothing in this file sends a text or an email.
// ───────────────────────────────────────────────────────────────────────────
import { sbUrl, sbService, sbFailureReason } from "@/lib/osSupabase";
import { pgConfigured, pgSelect, pgInsert, pgPatch } from "@/lib/pgFallback";

export class IntakeDbError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntakeDbError";
  }
}

type Via = "rest" | "pooler";
// Which path answered the most recent call. Surfaced in the dev-only proof
// header so a test can show a save really went through the pooler under 402.
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
    throw new IntakeDbError(`Direct database connection failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// GET rows. qs is a PostgREST query string that includes select=.
async function select<T>(table: string, qs: string): Promise<T[]> {
  const s = svc();
  if (!s) {
    if (pgConfigured()) return viaPooler(() => pgSelect<T>(table, qs));
    throw new IntakeDbError("The customer database is not configured on this server.");
  }
  let r: Response;
  try {
    r = await fetch(`${s.url}/rest/v1/${table}?${qs}`, {
      headers: { apikey: s.key, Authorization: `Bearer ${s.key}` },
      cache: "no-store",
    });
  } catch (e) {
    if (pgConfigured()) return viaPooler(() => pgSelect<T>(table, qs));
    throw new IntakeDbError(`Could not reach the customer database: ${String(e)}`);
  }
  if (r.status === 402 && pgConfigured()) return viaPooler(() => pgSelect<T>(table, qs));
  if (!r.ok) {
    throw new IntakeDbError(sbFailureReason(r.status, await r.text().catch(() => ""), table));
  }
  lastVia = "rest";
  return (await r.json()) as T[];
}

// INSERT one row and return it. Throws unless the database handed a row back.
async function insert<T>(table: string, row: Record<string, unknown>): Promise<T> {
  const s = svc();
  let rows: T[];
  if (!s) {
    if (!pgConfigured()) throw new IntakeDbError("The customer database is not configured on this server.");
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
      if (!pgConfigured()) throw new IntakeDbError(`Could not reach the customer database: ${String(e)}`);
    }
    if (!r || (r.status === 402 && pgConfigured())) {
      rows = await viaPooler(() => pgInsert<T>(table, row));
    } else if (!r.ok) {
      throw new IntakeDbError(sbFailureReason(r.status, await r.text().catch(() => ""), table));
    } else {
      rows = (await r.json()) as T[];
      lastVia = "rest";
    }
  }
  if (!rows?.[0]) throw new IntakeDbError(`The database did not confirm the new ${table} row.`);
  return rows[0];
}

// PATCH rows matching a filter. Throws on failure.
async function patch<T>(table: string, filter: string, body: Record<string, unknown>): Promise<T[]> {
  const s = svc();
  if (!s) {
    if (!pgConfigured()) throw new IntakeDbError("The customer database is not configured on this server.");
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
    if (!pgConfigured()) throw new IntakeDbError(`Could not reach the customer database: ${String(e)}`);
  }
  if (!r || (r.status === 402 && pgConfigured())) return viaPooler(() => pgPatch<T>(table, filter, body));
  if (!r.ok) throw new IntakeDbError(sbFailureReason(r.status, await r.text().catch(() => ""), table));
  lastVia = "rest";
  return (await r.json()) as T[];
}

const enc = encodeURIComponent;

// ── Access key ─────────────────────────────────────────────────────────────
// Same table and same rule as the dashboard gate (app/lib/clientKeys.ts): an
// ACTIVE row must match BOTH slug and key exactly. Returns:
//   "ok"       key is valid
//   "denied"   no such active key (wrong key, wrong slug, revoked)
// and THROWS IntakeDbError when the database cannot be read, so the caller
// fails closed but can say "try again" instead of "your link is wrong".
export async function checkClientKey(slug: string, key: string): Promise<"ok" | "denied"> {
  if (!slug || !key) return "denied";
  const rows = await select<{ id: number }>(
    "client_dashboard_keys",
    `select=id&client_slug=eq.${enc(slug)}&key=eq.${enc(key)}&active=eq.true&limit=1`
  );
  if (!rows.length) return "denied";
  // Best-effort last-used touch; never allowed to fail the request.
  patch("client_dashboard_keys", `id=eq.${rows[0].id}`, { last_used_at: new Date().toISOString() }).catch(() => {});
  return "ok";
}

// The client's display name from public.clients, falling back to null.
export async function clientName(slug: string): Promise<string | null> {
  try {
    const rows = await select<{ name: string }>("clients", `select=name&slug=eq.${enc(slug)}&limit=1`);
    return rows[0]?.name?.trim() || null;
  } catch {
    return null; // cosmetic only; the page falls back to a generic heading
  }
}

// ── Customers ──────────────────────────────────────────────────────────────
export type ContactRow = {
  id: number;
  contact_name: string | null;
  business_name: string | null;
  email: string | null;
  phone: string | null;
  city: string | null;
  notes: string | null;
  created_at: string;
};

// An existing customer of THIS client with the same phone or email.
export async function findExisting(
  slug: string,
  phoneE164: string | null,
  email: string | null
): Promise<ContactRow | null> {
  const ors: string[] = [];
  if (phoneE164) {
    ors.push(`phone.eq.${enc(phoneE164)}`);
    // Older rows may hold the bare 10-digit US form.
    if (phoneE164.startsWith("+1") && phoneE164.length === 12) ors.push(`phone.eq.${phoneE164.slice(2)}`);
  }
  if (email) ors.push(`email.eq.${enc(email)}`);
  if (!ors.length) return null;
  const rows = await select<ContactRow>(
    "crm_contacts",
    `select=id,contact_name,business_name,email,phone,city,notes,created_at` +
      `&client_slug=eq.${enc(slug)}&or=(${ors.join(",")})&order=id.asc&limit=1`
  );
  return rows[0] ?? null;
}

export async function insertContact(row: Record<string, unknown>): Promise<ContactRow> {
  return insert<ContactRow>("crm_contacts", row);
}

export async function updateContact(id: number, body: Record<string, unknown>): Promise<void> {
  const rows = await patch<ContactRow>("crm_contacts", `id=eq.${id}`, body);
  if (!rows.length) throw new IntakeDbError("The database did not confirm the customer update.");
}

// The last few customers this client added through the form: name + date only.
export async function recentCustomers(slug: string, limit = 10): Promise<{ name: string; added: string }[]> {
  const rows = await select<{ contact_name: string | null; business_name: string | null; created_at: string; updated_at: string }>(
    "crm_contacts",
    `select=contact_name,business_name,created_at,updated_at` +
      `&client_slug=eq.${enc(slug)}&source=eq.client_form&order=updated_at.desc&limit=${limit}`
  );
  return rows.map((r) => ({
    name: (r.contact_name || r.business_name || "Customer").trim(),
    added: r.updated_at || r.created_at,
  }));
}

// ── Review requests ────────────────────────────────────────────────────────
// True when this contact already has an open or finished ask for this client,
// so a repeat job never asks the same person twice.
export async function hasReviewRequest(slug: string, contactId: number): Promise<boolean> {
  const rows = await select<{ id: number }>(
    "reviews",
    `select=id&client_slug=eq.${enc(slug)}&contact_id=eq.${contactId}` +
      `&status=in.(queued,requested,received)&limit=1`
  );
  return rows.length > 0;
}

// Queue ONE review request. Status 'queued' records intent only: the reviews
// table never sends anything, and the sender (app/api/reviews/send) stays
// unarmed. Requests drip out later one finished job at a time.
export async function queueReview(row: {
  client_slug: string;
  contact_id: number;
  channel: "sms" | "email";
  notes: string | null;
}): Promise<{ id: number }> {
  return insert<{ id: number }>("reviews", { ...row, status: "queued" });
}
