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
//     Every helper here THROWS IntakeDbError (lib/restOrPooler DbError) on failure, so the route can tell
//     the client plainly that nothing was saved.
//   * Since 2026-09-21 Supabase answers HTTP 402 to every REST call (storage
//     quota), while Postgres itself is fine. Every call here goes through
//     lib/restOrPooler: REST first, the direct pooler (OS_DB_URL) on a 402.
//
// Nothing in this file sends a text or an email.
// ───────────────────────────────────────────────────────────────────────────
import { DbError, dbSelect, dbInsert, dbPatch, lastPath as dbLastPath } from "@/lib/restOrPooler";

// The intake route catches this name; it is the shared DbError.
export { DbError as IntakeDbError };
export const lastPath = dbLastPath;

const select = dbSelect;
const insert = dbInsert;
const patch = dbPatch;

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
  if (!rows.length) throw new DbError("The database did not confirm the customer update.");
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

// ── Consent paper trail ────────────────────────────────────────────────────
// When the client ticks "OK to ask for a review" they are attesting, on the
// customer's behalf, that the customer agreed to hear from them about this
// job. That attestation is the only consent evidence we have, so it is written
// to public.consent (the A2P paper trail) as a GRANT, one row per address,
// with method 'client-attested'. It never overrides a revocation: the send
// routes block on any revoked row regardless of later grants.
export async function recordAttestedConsent(row: {
  contact_id: number;
  client_slug: string;
  phone: string | null;
  email: string | null;
  job_date: string;
}): Promise<void> {
  const now = new Date().toISOString();
  const proof =
    `Client ${row.client_slug} attested via /add form on ${now.slice(0, 10)} ` +
    `(job ${row.job_date}) that the customer agreed to be contacted by text or email about this job, including a review request.`;
  const writes: Record<string, unknown>[] = [];
  if (row.phone) writes.push({ contact_id: row.contact_id, address: row.phone, channel: "sms", granted_at: now, method: "client-attested", proof });
  if (row.email) writes.push({ contact_id: row.contact_id, address: row.email, channel: "email", granted_at: now, method: "client-attested", proof });
  for (const w of writes) await insert("consent", w);
}
