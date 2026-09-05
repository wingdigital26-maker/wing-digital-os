import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getOsSession, hasLegacyAuth } from "@/lib/osSupabase";
import { sbGet, sbPatch, esc } from "../../pipeline/_lib";

// ───────────────────────────────────────────────────────────────────────────
// POST /api/reviews/send — the "auto-send once armed" delivery step for review
// requests. It turns QUEUED review rows (migration 0027) into actual sent
// texts/emails, but ONLY when the OS send switch is on.
//
// FAILS CLOSED. The switch is off today (A2P 10DLC is not verified, so Twilio /
// SMTP are unconfigured on this deployment). When that is the case this route
// sends NOTHING and leaves every request queued. It does not re-implement the
// arming/A2P gate: it delivers by calling the EXISTING internal send routes
// (/api/sms/send, /api/email/send), which already refuse — with a 503 — when
// their provider is unconfigured. That is the single gate; this route only
// reads its answer. A "not armed" answer stops the run and leaves rows queued.
//
// It never sends to a do_not_contact contact, never sends when the needed
// address is missing, and is idempotent: it only ever reads status='queued'
// rows, so a request already 'requested' is never re-sent.
//
// Auth mirrors /api/notify and /api/sms/send: a staff OS session OR the machine
// key header x-heartbeat-key = HEARTBEAT_KEY. This route is NOT in the
// middleware public allowlist, so a staff session is the working path in a
// deployed environment; the machine key is honoured for a same-process caller.
//
// Body (all optional): { client_slug?: string, limit?: number }
// Returns: { ok, sent, held, skipped, reason? }
// ───────────────────────────────────────────────────────────────────────────

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STAFF = new Set(["admin", "owner", "staff"]);
const SLUG_RE = /^[a-z0-9-]{1,60}$/;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

async function authorized(req: NextRequest): Promise<boolean> {
  const machineKey = process.env.HEARTBEAT_KEY;
  if (machineKey && req.headers.get("x-heartbeat-key") === machineKey) return true;
  const session = await getOsSession();
  if (session) return STAFF.has(session.role);
  return await hasLegacyAuth();
}

type ReviewRow = {
  id: number;
  client_slug: string;
  contact_id: number | null;
  channel: string;
  status: string;
};

type ContactRow = {
  id: number;
  business_name: string;
  contact_name: string | null;
  email: string | null;
  phone: string | null;
  do_not_contact: boolean;
};

// Best-effort E.164 normalisation for a US-style number. Returns null when the
// value cannot be trusted as a real number, so the caller skips rather than
// sends somewhere wrong. A value already in +... form with 8-15 digits passes
// through untouched.
function toE164(raw: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (/^\+\d{8,15}$/.test(trimmed)) return trimmed;
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

function firstName(contact: ContactRow): string {
  const n = (contact.contact_name ?? "").trim();
  if (!n) return "there";
  return n.split(/\s+/)[0];
}

// Honest, generic, non-spammy review-request copy. No fabricated links (the
// clients table has no review URL to offer), no em dashes, no unrendered
// tokens — the email route's copy guard rejects both.
function smsBody(brand: string, first: string): string {
  return (
    `Hi ${first}, this is ${brand}. Thank you for choosing us. ` +
    `If you have a minute, a quick review would mean a lot and helps other ` +
    `local folks find us. Thank you so much.`
  );
}

function emailSubject(brand: string): string {
  return `A quick favor from ${brand}`;
}

function emailBody(brand: string, first: string): string {
  return (
    `Hi ${first},\n\n` +
    `Thank you for choosing ${brand}. It was a pleasure working with you.\n\n` +
    `If you have a moment, we would be grateful for a short review. A few ` +
    `honest words go a long way in helping other local folks find us.\n\n` +
    `Thank you so much,\n${brand}`
  );
}

// Title-case a slug as a last-resort brand name when the client is not in the
// clients table (never invent anything beyond the words already in the slug).
function slugToName(slug: string): string {
  return slug
    .split("-")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export async function POST(req: NextRequest) {
  if (!(await authorized(req))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const body = (await req.json().catch(() => ({}))) as {
    client_slug?: unknown;
    limit?: unknown;
  };

  let clientFilter = "";
  if (body.client_slug !== undefined && body.client_slug !== null && body.client_slug !== "") {
    const slug = String(body.client_slug).toLowerCase();
    if (!SLUG_RE.test(slug)) {
      return NextResponse.json(
        { ok: false, error: "client_slug must be lowercase letters, digits, and dashes." },
        { status: 400 }
      );
    }
    clientFilter = `client_slug=eq.${esc(slug)}&`;
  }

  let limit = DEFAULT_LIMIT;
  if (body.limit !== undefined) {
    const n = Number(body.limit);
    if (Number.isFinite(n) && n > 0) limit = Math.min(Math.floor(n), MAX_LIMIT);
  }

  // The base URL for the same-origin server-to-server delivery calls, rebuilt
  // from the proxy headers (same technique the send routes use for their own
  // callbacks).
  const proto =
    req.headers.get("x-forwarded-proto") ?? new URL(req.url).protocol.replace(":", "");
  const host =
    req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? new URL(req.url).host;
  const origin = `${proto}://${host}`;
  const heartbeatKey = process.env.HEARTBEAT_KEY ?? "";

  let queued: ReviewRow[];
  try {
    queued = await sbGet<ReviewRow>(
      "reviews",
      "id,client_slug,contact_id,channel,status",
      `${clientFilter}status=eq.queued&order=created_at.asc&limit=${limit}`
    );
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: "Could not read queued review requests.", detail: String(e).slice(0, 300) },
      { status: 502 }
    );
  }

  // Dedicated arming switch, independent of raw provider config. The underlying
  // /api/sms/send and /api/email/send deliver the moment Twilio/SMTP creds
  // exist -- which they do in production -- so relying on those alone would let
  // a queued review go out before A2P 10DLC is verified. This gate is OFF unless
  // REVIEWS_SEND_ENABLED is exactly "1". While off, we send NOTHING and hold
  // every queued request, without ever calling a send route.
  if (process.env.REVIEWS_SEND_ENABLED !== "1") {
    return NextResponse.json({
      ok: true,
      sent: 0,
      held: queued.length,
      skipped: 0,
      reason:
        "Review sending is turned off. Set REVIEWS_SEND_ENABLED=1 once A2P 10DLC is verified to arm it.",
    });
  }

  let sent = 0;
  let held = 0;
  let skipped = 0;
  let reason: string | null = null;

  const brandCache = new Map<string, string>();
  async function brandFor(slug: string): Promise<string> {
    const cached = brandCache.get(slug);
    if (cached) return cached;
    let name = slugToName(slug);
    try {
      const rows = await sbGet<{ slug: string; name: string }>(
        "clients",
        "slug,name",
        `slug=eq.${esc(slug)}&limit=1`
      );
      if (rows[0]?.name?.trim()) name = rows[0].name.trim();
    } catch {
      // Fall back to the slug-derived name; a lookup miss is not fatal.
    }
    brandCache.set(slug, name);
    return name;
  }

  for (const r of queued) {
    if (r.contact_id == null) {
      skipped++;
      continue;
    }

    // Look up the contact for the name + address, and honour suppression.
    let contact: ContactRow | undefined;
    try {
      const rows = await sbGet<ContactRow>(
        "crm_contacts",
        "id,business_name,contact_name,email,phone,do_not_contact",
        `id=eq.${r.contact_id}&limit=1`
      );
      contact = rows[0];
    } catch {
      skipped++;
      continue;
    }
    if (!contact || contact.do_not_contact) {
      skipped++;
      continue;
    }

    const brand = await brandFor(r.client_slug);
    const first = firstName(contact);

    // Build the exact request body for the matching internal send route.
    let path: string;
    let payload: Record<string, unknown>;
    if (r.channel === "email") {
      const to = (contact.email ?? "").trim();
      if (!to || !to.includes("@")) {
        skipped++;
        continue;
      }
      path = "/api/email/send";
      payload = {
        to,
        subject: emailSubject(brand),
        body: emailBody(brand, first),
        client_slug: r.client_slug,
        contact_id: contact.id,
      };
    } else {
      // Default to SMS for 'sms' (and any unexpected channel value).
      const to = toE164(contact.phone);
      if (!to) {
        skipped++;
        continue;
      }
      path = "/api/sms/send";
      payload = {
        to,
        body: smsBody(brand, first),
        client_slug: r.client_slug,
        contact_id: contact.id,
      };
    }

    // Deliver via the existing send route. That route owns the arming/A2P gate:
    // it answers 503 when its provider is unconfigured (the switch-off default).
    let resStatus = 0;
    let resOk = false;
    try {
      const res = await fetch(`${origin}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-heartbeat-key": heartbeatKey,
        },
        body: JSON.stringify(payload),
        cache: "no-store",
      });
      resStatus = res.status;
      const j = (await res.json().catch(() => null)) as { ok?: boolean } | null;
      resOk = res.ok && j?.ok === true;
    } catch {
      // Could not reach the send route at all — treat like the gate being shut:
      // hold, do not mark requested, and stop so nothing is hammered.
      held++;
      reason = "send route unreachable";
      break;
    }

    if (resOk) {
      try {
        await sbPatch("reviews", `id=eq.${r.id}`, {
          status: "requested",
          requested_at: new Date().toISOString(),
        });
        sent++;
      } catch {
        // The text/email went out but the status could not be stamped. Count it
        // as sent (it was) and stop, so a retry does not double-send this row.
        sent++;
        reason = "sent, but a review row could not be stamped requested";
        break;
      }
      continue;
    }

    // Not delivered. A 503 (or a config-level 401) is the global arming gate
    // being off: hold everything, mark nothing, stop the run.
    if (resStatus === 503 || resStatus === 401) {
      held++;
      reason = "send switch off / A2P not verified";
      break;
    }

    // Any other refusal (bad address, suppressed recipient, provider error) is
    // per-contact: skip this row and keep going.
    skipped++;
  }

  return NextResponse.json({
    ok: true,
    sent,
    held,
    skipped,
    ...(held > 0 ? { reason: reason ?? "send switch off / A2P not verified" } : {}),
  });
}
