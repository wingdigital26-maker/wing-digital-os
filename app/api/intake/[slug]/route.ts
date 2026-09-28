import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { normalizePhone } from "@/lib/phone";
import {
  IntakeDbError,
  checkClientKey,
  findExisting,
  insertContact,
  updateContact,
  recentCustomers,
  hasReviewRequest,
  queueReview,
  recordAttestedConsent,
  lastPath,
} from "@/lib/clientIntake";

// ───────────────────────────────────────────────────────────────────────────
// /api/intake/<client-slug>: the client-facing "add a customer" endpoint that
// backs the page at /add/<slug>/<key>.
//
//   GET   the last 10 customers this client added (first name + date only)
//   POST  add one customer after a job
//
// AUTH: the client's access key travels in the x-client-key header (never the
// URL, so it stays out of request logs). It is checked against
// client_dashboard_keys, the same table the /d/<slug>/<key> dashboard link
// uses. FAILS CLOSED: no key, a wrong key, a revoked key, or a database that
// cannot answer all store nothing and show nothing.
//
// WHAT A POST DOES, IN ORDER
//   1. rate limit per IP (same buckets as /api/forms/<slug>)
//   2. key check (401 on a bad key, 503 if the key table cannot be read)
//   3. honeypot: a filled `_hp` gets a quiet success and stores NOTHING
//   4. normalize + validate: name required, phone or email required
//   5. dedupe on (client_slug, phone or email): a repeat customer is updated,
//      never duplicated
//   6. insert crm_contacts with client_slug and source='client_form'
//   7. if the review box is ticked and this person has not been asked before,
//      insert ONE reviews row with status 'queued'. Queued only: nothing is
//      sent from here, and asks drip out later one finished job at a time
//      (a burst of reviews gets a Google profile paused).
//
// Every write either succeeds or the client sees a plain error saying nothing
// was saved. There is no path that reports success after a failed write.
// Public in proxy.ts; every check above runs inside this file.
// ───────────────────────────────────────────────────────────────────────────

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SLUG_RE = /^[a-z0-9-]{2,60}$/;
const KEY_RE = /^[A-Za-z0-9_-]{16,128}$/;
// No commas, parens or quotes: they are not in real addresses and would break
// the PostgREST or=() filter used for the duplicate check.
const EMAIL_RE = /^[^\s@,()"'<>]+@[^\s@,()"'<>]+\.[^\s@,()"'<>]{2,}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_BODY_BYTES = 16 * 1024;

// ── Rate limit: same naive per-IP buckets as /api/forms/<slug> ────────────
const RATE_WINDOW_MS = 60 * 60 * 1000;
const POST_MAX = 60; // a crew adding a busy day's customers stays well under this
const READ_MAX = 240;
const MAP_SWEEP_AT = 5000;
const postHits = new Map<string, number[]>();
const readHits = new Map<string, number[]>();

function sweep(map: Map<string, number[]>, now: number): void {
  if (map.size <= MAP_SWEEP_AT) return;
  for (const [k, list] of map) {
    if (!list.some((t) => now - t < RATE_WINDOW_MS)) map.delete(k);
  }
}

function limited(map: Map<string, number[]>, ip: string, max: number): boolean {
  const now = Date.now();
  sweep(map, now);
  const list = (map.get(ip) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (list.length >= max) {
    map.set(ip, list);
    return true;
  }
  list.push(now);
  map.set(ip, list);
  return false;
}

function clientIp(req: NextRequest): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "unknown"
  );
}

function json(body: unknown, status = 200): NextResponse {
  const headers: Record<string, string> = { "Cache-Control": "no-store" };
  // Dev-only proof of which path (REST or the direct pooler) answered.
  const via = lastPath();
  if (process.env.NODE_ENV === "development" && via) headers["x-intake-db-path"] = via;
  return NextResponse.json(body, { status, headers });
}

function str(v: unknown, max: number): string | null {
  if (typeof v === "number") v = String(v);
  if (typeof v !== "string") return null;
  const t = v.replace(/\s+/g, " ").trim();
  return t ? t.slice(0, max) : null;
}

function longStr(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
}

function truthy(v: unknown): boolean {
  if (v === true || v === 1) return true;
  if (typeof v === "string") return ["1", "true", "on", "yes"].includes(v.trim().toLowerCase());
  return false;
}

// Today in Texas, as YYYY-MM-DD. Every client is in DFW.
function todayCentral(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date());
}

const UNAVAILABLE =
  "We couldn't reach the customer list just now, so nothing was saved. Please try again in a minute.";

async function gate(req: NextRequest, slug: string): Promise<NextResponse | null> {
  if (!SLUG_RE.test(slug || "")) return json({ error: "not_found", message: "This link is not valid." }, 404);
  const key = req.headers.get("x-client-key") || "";
  if (!KEY_RE.test(key)) {
    return json({ error: "unauthorized", message: "This link is not valid. Ask Wing Digital for a new one." }, 401);
  }
  try {
    const verdict = await checkClientKey(slug, key);
    if (verdict !== "ok") {
      return json({ error: "unauthorized", message: "This link is not valid. Ask Wing Digital for a new one." }, 401);
    }
  } catch (e) {
    console.error("[intake] key check failed:", e instanceof Error ? e.message : e);
    return json({ error: "unavailable", message: UNAVAILABLE }, 503);
  }
  return null;
}

type Params = { params: Promise<{ slug: string }> };

// ── GET: recent customers ──────────────────────────────────────────────────
export async function GET(req: NextRequest, ctx: Params) {
  if (limited(readHits, clientIp(req), READ_MAX)) {
    return json({ error: "rate_limited", message: "Too many requests. Please wait a bit and try again." }, 429);
  }
  const { slug } = await ctx.params;
  const denied = await gate(req, slug);
  if (denied) return denied;
  try {
    const recent = await recentCustomers(slug, 10);
    // First name only on the page: the list is proof it saved, not a directory.
    return json({ ok: true, recent: recent.map((r) => ({ name: r.name.split(" ")[0], added: r.added })) });
  } catch (e) {
    console.error("[intake] recent read failed:", e instanceof Error ? e.message : e);
    return json({ error: "unavailable", message: "We couldn't load your recent customers just now." }, 503);
  }
}

// ── POST: add a customer ───────────────────────────────────────────────────
export async function POST(req: NextRequest, ctx: Params) {
  if (limited(postHits, clientIp(req), POST_MAX)) {
    return json({ error: "rate_limited", message: "Too many customers added from this connection. Please wait a bit and try again." }, 429);
  }
  const { slug } = await ctx.params;
  const denied = await gate(req, slug);
  if (denied) return denied;

  let fields: Record<string, unknown>;
  try {
    const text = await req.text();
    if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) {
      return json({ error: "bad_request", message: "That's too much text. Please shorten the notes." }, 400);
    }
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    fields = parsed as Record<string, unknown>;
  } catch {
    return json({ error: "bad_request", message: "We couldn't read the form. Please try again." }, 400);
  }

  // Honeypot: a person never sees this field. Answer like a success, store nothing.
  const hp = fields._hp;
  if (typeof hp === "string" ? hp.trim() : hp) return json({ ok: true, created: true, review_queued: false });

  const name = str(fields.name, 160);
  if (!name) return json({ error: "bad_request", field: "name", message: "Please enter the customer's name." }, 400);

  const emailRaw = str(fields.email, 320);
  const email = emailRaw ? emailRaw.toLowerCase() : null;
  if (email && !EMAIL_RE.test(email)) {
    return json({ error: "bad_request", field: "email", message: "That email address doesn't look right." }, 400);
  }
  const phoneRaw = str(fields.phone, 40);
  const phone = normalizePhone(phoneRaw ?? undefined);
  if (phoneRaw && !phone.e164) {
    return json({ error: "bad_request", field: "phone", message: "Please enter a 10-digit phone number." }, 400);
  }
  if (!email && !phone.e164) {
    return json({ error: "bad_request", field: "phone", message: "Please add a phone number or an email so we can reach them." }, 400);
  }

  const service = str(fields.service, 200);
  const city = str(fields.city, 120);
  const notes = longStr(fields.notes, 2000);
  let jobDate = str(fields.job_date, 10) ?? todayCentral();
  if (!DATE_RE.test(jobDate) || Number.isNaN(Date.parse(jobDate))) jobDate = todayCentral();
  if (jobDate > todayCentral()) {
    return json({ error: "bad_request", field: "job_date", message: "The job date can't be in the future." }, 400);
  }
  const askReview = truthy(fields.review_ok);

  // One line per job, so a repeat customer's history reads top to bottom.
  const jobLine =
    `[${jobDate}] Job added by client` +
    (service ? `: ${service}` : "") +
    (notes ? ` | Notes: ${notes}` : "") +
    ` | Review ask OK: ${askReview ? "yes" : "no"}` +
    ` | Client confirmed the customer agreed to be contacted about this job.`;

  let contactId: number;
  let created: boolean;
  try {
    const existing = await findExisting(slug, phone.e164, email);
    if (existing) {
      created = false;
      contactId = existing.id;
      const patch: Record<string, unknown> = {
        notes: [existing.notes, jobLine].filter(Boolean).join("\n").slice(-8000),
      };
      // Fill gaps only; never overwrite what is already on file.
      if (!existing.email && email) patch.email = email;
      if (!existing.phone && phone.e164) patch.phone = phone.e164;
      if (!existing.city && city) patch.city = city;
      await updateContact(existing.id, patch);
    } else {
      created = true;
      const row = await insertContact({
        client_slug: slug,
        source: "client_form",
        business_name: name, // a homeowner has no business; the board shows this column
        contact_name: name,
        email,
        phone: phone.e164,
        city,
        state: "TX",
        notes: jobLine,
      });
      contactId = row.id;
    }
  } catch (e) {
    console.error("[intake] contact write failed:", e instanceof Error ? e.message : e);
    return json({ error: "save_failed", message: UNAVAILABLE }, e instanceof IntakeDbError ? 503 : 500);
  }

  // Review request: queued only, one per person, never sent from here.
  let reviewQueued = false;
  let reviewNote: string | null = null;
  if (askReview) {
    // Paper trail first; best effort, it never blocks the save.
    await recordAttestedConsent({
      contact_id: contactId,
      client_slug: slug,
      phone: phone.e164,
      email,
      job_date: jobDate,
    }).catch((e) => console.error("[intake] consent record failed:", e instanceof Error ? e.message : e));

    try {
      if (!created && (await hasReviewRequest(slug, contactId))) {
        reviewNote = "already_asked";
      } else {
        await queueReview({
          client_slug: slug,
          contact_id: contactId,
          channel: phone.e164 ? "sms" : "email",
          notes: `From the client form. Job ${jobDate}${service ? `: ${service}` : ""}.`,
        });
        reviewQueued = true;
      }
    } catch (e) {
      // The customer IS saved; say so honestly and name what did not happen.
      console.error("[intake] review queue failed:", e instanceof Error ? e.message : e);
      return json({
        ok: true,
        created,
        review_queued: false,
        warning: "The customer was saved, but we couldn't add the review request. Wing Digital will follow up on it.",
      });
    }
  }

  return json({ ok: true, created, review_queued: reviewQueued, review_note: reviewNote });
}
