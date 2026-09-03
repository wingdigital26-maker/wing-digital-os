import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { sbGet, sbPost, sbPatch, SbError } from "../../pipeline/_lib";
import { normalizePhone } from "@/lib/phone";
import { emitEvent } from "@/lib/automations/emit";
import type { FormRow } from "@/lib/automations/types";

// ───────────────────────────────────────────────────────────────────────────
// /api/forms/[slug]: the PUBLIC lead-capture endpoint every Wing-built client
// site posts to. This is the GHL "form" replacement.
//
//   OPTIONS  CORS preflight (any origin: client sites live on their own domains)
//   POST     accept JSON, x-www-form-urlencoded, or multipart; store the raw
//            submission forever; emit form.submitted for the automation engine
//   GET      a plain-text note for a human who opens the URL in a browser
//
// WHAT HAPPENS ON A POST, IN ORDER
//   1. rate limit (30 posts per IP per hour, then a smaller cap on VALID
//      submissions so a visitor's typos never lock them out)
//   2. look up the form by slug: 404 if none, 410 if paused (stores nothing)
//   3. honeypot: a filled `_hp` or `website_url_confirm` gets a friendly 200
//      and NOTHING is stored, so the bot cannot tell it was caught
//   4. normalize email / phone / name / company / city / message
//   5. insert form_submissions (raw data minus honeypots), bump forms.submissions
//   6. optional SMS consent row when sms_consent is truthy and the phone is E.164
//   7. emitEvent("form.submitted"). The engine resolves or creates the CRM
//      contact from the payload and emits contact.created ITSELF if it made
//      one; this route deliberately does not, so a contact is never announced
//      twice.
//   8. HTML form posts with a redirect_url get a 303 there; everything else
//      gets JSON {ok, submission_id}.
//
// Public path in middleware; every check above runs inside this file. Writes
// use the service key (RLS on forms/form_submissions is staff-only).
// ───────────────────────────────────────────────────────────────────────────

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const SLUG_RE = /^[a-z0-9-]{2,60}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const HONEYPOT_FIELDS = ["_hp", "website_url_confirm"];

function json(body: unknown, status = 200, extra: Record<string, string> = {}): NextResponse {
  return NextResponse.json(body, { status, headers: { ...CORS, ...extra } });
}

// ── Rate limit: same naive per-IP buckets as /api/booking. One Vercel instance,
// best-effort; validation and honest failure are the real defence. ──────────
const RATE_WINDOW_MS = 60 * 60 * 1000;
const POST_MAX = 30; // total POSTs per IP per hour, abuse backstop
const SUBMIT_MAX = 15; // valid submissions per IP per hour, checked AFTER validation
const postHits = new Map<string, number[]>();
const submitHits = new Map<string, number[]>();

function bucketLimited(map: Map<string, number[]>, ip: string, max: number): boolean {
  const now = Date.now();
  const list = (map.get(ip) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (list.length >= max) {
    map.set(ip, list);
    return true;
  }
  list.push(now);
  map.set(ip, list);
  return false;
}

// First x-forwarded-for entry only. Vercel overwrites the header with the real
// client IP; anywhere else this is best-effort.
function clientIp(req: NextRequest): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "unknown"
  );
}

// ── Body parsing: JSON, urlencoded, or multipart. File parts are dropped (a
// lead form has no business uploading files into a jsonb column). ──────────
async function readBody(req: NextRequest): Promise<{ fields: Record<string, unknown>; isJson: boolean } | null> {
  const ct = (req.headers.get("content-type") || "").toLowerCase();
  try {
    if (ct.includes("application/json")) {
      const parsed = await req.json();
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
      return { fields: parsed as Record<string, unknown>, isJson: true };
    }
    if (ct.includes("application/x-www-form-urlencoded") || ct.includes("multipart/form-data")) {
      const fd = await req.formData();
      const fields: Record<string, unknown> = {};
      for (const [k, v] of fd.entries()) {
        if (typeof v !== "string") continue;
        // Repeated keys (checkbox groups) become arrays.
        if (k in fields) {
          const prev = fields[k];
          fields[k] = Array.isArray(prev) ? [...prev, v] : [prev, v];
        } else {
          fields[k] = v;
        }
      }
      return { fields, isJson: false };
    }
    // Unknown content type: try JSON as a courtesy, else refuse.
    const text = await req.text();
    if (!text.trim()) return { fields: {}, isJson: false };
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return { fields: parsed as Record<string, unknown>, isJson: true };
  } catch {
    return null;
  }
}

function str(v: unknown, max = 500): string | null {
  if (typeof v === "number" || typeof v === "boolean") v = String(v);
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
}

function truthy(v: unknown): boolean {
  if (v === true || v === 1) return true;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    return s === "1" || s === "true" || s === "on" || s === "yes";
  }
  return false;
}

// ── OPTIONS: CORS preflight ────────────────────────────────────────────────
export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: { ...CORS, "Access-Control-Max-Age": "86400" } });
}

// ── GET: a human opened the URL ────────────────────────────────────────────
export async function GET() {
  return new NextResponse(
    "This address accepts form posts from a website. There is nothing to see here in a browser.\n",
    { status: 405, headers: { "Content-Type": "text/plain; charset=utf-8", Allow: "POST, OPTIONS", ...CORS } }
  );
}

// ── POST: the submission ───────────────────────────────────────────────────
export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ slug: string }> } | { params: { slug: string } }
) {
  const ip = clientIp(req);
  if (bucketLimited(postHits, ip, POST_MAX)) {
    return json(
      { error: "rate_limited", message: "Too many submissions from this connection. Please wait a bit and try again." },
      429
    );
  }

  const { slug } = await Promise.resolve(ctx.params);
  if (!SLUG_RE.test(slug || "")) {
    return json({ error: "not_found", message: "No form at this address." }, 404);
  }

  // Look the form up first: a paused or missing form must store nothing.
  let form: FormRow | null = null;
  try {
    const rows = await sbGet<FormRow>(
      "forms",
      "id,slug,name,client_slug,fields,redirect_url,status,submissions",
      `slug=eq.${encodeURIComponent(slug)}&limit=1`
    );
    form = rows[0] ?? null;
  } catch (e) {
    const status = e instanceof SbError ? e.status : 502;
    return json(
      { error: "unavailable", message: "This form is not connected to its database right now. Please try again later." },
      status === 503 ? 503 : 502
    );
  }
  if (!form) return json({ error: "not_found", message: "No form at this address." }, 404);
  if (form.status === "paused") {
    return json({ error: "paused", message: "This form is not accepting submissions right now." }, 410);
  }

  const parsed = await readBody(req);
  if (!parsed) {
    return json({ error: "bad_request", message: "Could not read the form. Please try again." }, 400);
  }
  const { fields, isJson } = parsed;

  // Honeypot. Bots fill every field; humans never see these. We answer exactly
  // like a success so the bot learns nothing, and we store NOTHING: no
  // submission row, no counter bump, no event.
  for (const hp of HONEYPOT_FIELDS) {
    if (str(fields[hp])) return json({ ok: true });
  }

  // ── Normalize the fields we understand; everything else is kept verbatim in data.
  const emailRaw = str(fields.email, 320);
  const email = emailRaw ? emailRaw.toLowerCase() : null;
  if (email && !EMAIL_RE.test(email)) {
    return json({ error: "bad_request", message: "Please enter a valid email address." }, 400);
  }
  const phoneNorm = normalizePhone(fields.phone ?? fields.phone_number ?? fields.tel);
  const phone = phoneNorm.value;

  const firstName = str(fields.first_name, 120);
  const lastName = str(fields.last_name, 120);
  const name = str(fields.name ?? fields.full_name, 200) || [firstName, lastName].filter(Boolean).join(" ") || null;
  const first = firstName ?? (name ? name.split(/\s+/)[0] : null);
  const businessName = str(fields.company ?? fields.business_name ?? fields.business, 200);
  const city = str(fields.city, 120);
  const message = str(fields.message ?? fields.notes ?? fields.comments, 4000);
  const smsConsent = truthy(fields.sms_consent);

  if (!email && !phone) {
    return json({ error: "bad_request", message: "Please enter an email or a phone number." }, 400);
  }

  // Validation passed: this is a real submission, so it counts toward the
  // smaller cap.
  if (bucketLimited(submitHits, ip, SUBMIT_MAX)) {
    return json(
      { error: "rate_limited", message: "Too many submissions from this connection. Please wait a bit and try again." },
      429
    );
  }

  // The stored data is the whole submission minus honeypots, with the
  // normalized values layered on top so the raw row is useful on its own.
  const data: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (HONEYPOT_FIELDS.includes(k)) continue;
    if (typeof v === "string") data[k] = v.slice(0, 4000);
    else if (v === null || typeof v === "number" || typeof v === "boolean") data[k] = v;
    else if (Array.isArray(v)) data[k] = v.map((x) => (typeof x === "string" ? x.slice(0, 1000) : x)).slice(0, 50);
    else data[k] = JSON.stringify(v).slice(0, 4000);
  }
  if (email) data.email = email;
  if (phone) data.phone = phone;
  if (phoneNorm.e164) data.phone_e164 = phoneNorm.e164;
  data.sms_consent = smsConsent;

  const sourceUrl = str(fields.source_url, 1000) ?? str(req.headers.get("referer"), 1000);
  const userAgent = str(req.headers.get("user-agent"), 500);

  let submissionId: number | null = null;
  try {
    const created = await sbPost<{ id: number }>("form_submissions", {
      form_id: form.id,
      data,
      ip: ip === "unknown" ? null : ip,
      user_agent: userAgent,
      source_url: sourceUrl,
    });
    submissionId = created.id;
  } catch (e) {
    const status = e instanceof SbError ? e.status : 502;
    return json(
      { error: "insert_failed", message: "Your message could not be saved. Please try again." },
      status === 503 ? 503 : 502
    );
  }

  // Counter bump: read-modify-write, same trade-off as call_leads.call_count.
  // A count off by one under a simultaneous double-post is not a fact anyone
  // acts on; the submissions table is the truth.
  try {
    const current = await sbGet<{ submissions: number }>("forms", "submissions", `id=eq.${form.id}`);
    await sbPatch("forms", `id=eq.${form.id}`, { submissions: (current[0]?.submissions ?? form.submissions ?? 0) + 1 });
  } catch {
    // The submission is saved; a stale counter is not worth failing the visitor.
  }

  // SMS consent: only when the visitor ticked the box AND we hold a number we
  // can actually text. A raw, non-E.164 phone gets no consent row because we
  // could not honor it anyway.
  if (smsConsent && phoneNorm.e164) {
    try {
      await sbPost("consent", {
        contact_id: null,
        address: phoneNorm.e164,
        channel: "sms",
        granted_at: new Date().toISOString(),
        method: "web-form",
        proof: `form ${form.slug} submission ${submissionId}`,
      });
    } catch {
      // Consent evidence failing to write is logged by the ledger's absence;
      // the engine treats "no consent row" as "no consent", which is safe.
    }
  }

  // Hand the fact to the automation engine. It resolves or creates the CRM
  // contact and emits contact.created on its own when it creates one.
  try {
    await emitEvent({
      type: "form.submitted",
      client_slug: form.client_slug,
      payload: {
        form_slug: form.slug,
        form_name: form.name,
        email,
        phone,
        name,
        first_name: first,
        business_name: businessName,
        city,
        message,
        sms_consent: smsConsent,
        submission_id: submissionId,
      },
    });
  } catch {
    // The submission is already stored; the engine's cron can still see the
    // row. A failed emit must never turn a saved lead into an error page.
  }

  if (!isJson && form.redirect_url && /^https?:\/\//i.test(form.redirect_url)) {
    return NextResponse.redirect(form.redirect_url, { status: 303, headers: CORS });
  }
  return json({ ok: true, submission_id: submissionId });
}
