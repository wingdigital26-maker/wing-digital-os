// Twilio SMS plumbing + the unified message ledger helpers.
//
// Plain fetch against Twilio's REST API — no SDK dependency. Everything here
// FAILS CLOSED: missing TWILIO_* env vars produce a clear "Twilio not
// configured" result, never a crash and never a silent success.
//
// Env var names (values live in Vercel/local env only, never in code or vault):
//   TWILIO_ACCOUNT_SID, TWILIO_FROM_NUMBER, and EITHER an API key pair
//   (TWILIO_API_KEY_SID + TWILIO_API_KEY_SECRET, preferred) OR the account
//   TWILIO_AUTH_TOKEN. TWILIO_WEBHOOK_KEY gates the inbound/status webhooks
//   when no auth token is available for signature validation (see below).
import crypto from "node:crypto";
import { sbUrl, sbService } from "./osSupabase";

export type TwilioCreds = {
  /** The AC... account SID — always in the REST URL path. */
  accountSid: string;
  /** Basic-auth username: the SK... API key SID when set, else the account SID. */
  user: string;
  /** Basic-auth password: the API key secret, else the auth token. */
  secret: string;
  from: string;
  /** The account auth token, ONLY if TWILIO_AUTH_TOKEN is set. This is the
   *  single credential that can validate X-Twilio-Signature; API keys cannot.
   *  null => webhooks must fall back to the TWILIO_WEBHOOK_KEY URL gate. */
  authToken: string | null;
};

/** null when the required env vars are missing — the caller must say so.
 *  Prefers API-key auth (TWILIO_API_KEY_SID/SECRET), falls back to
 *  TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN. */
export function twilioCreds(): TwilioCreds | null {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const from = process.env.TWILIO_FROM_NUMBER;
  const keySid = process.env.TWILIO_API_KEY_SID;
  const keySecret = process.env.TWILIO_API_KEY_SECRET;
  const authToken = process.env.TWILIO_AUTH_TOKEN ?? null;
  if (!accountSid || !from) return null;
  if (keySid && keySecret) {
    return { accountSid, user: keySid, secret: keySecret, from, authToken };
  }
  if (authToken) {
    return { accountSid, user: accountSid, secret: authToken, from, authToken };
  }
  return null;
}

/** The shared secret that gates the inbound/status webhooks via ?k=. */
export function webhookKey(): string | null {
  return process.env.TWILIO_WEBHOOK_KEY || null;
}

/** Constant-time check of the ?k= webhook gate. False on any missing piece. */
export function validWebhookKey(req: Request): boolean {
  const expected = webhookKey();
  if (!expected) return false;
  const got = new URL(req.url).searchParams.get("k");
  if (!got) return false;
  const a = crypto.createHash("sha256").update(expected).digest();
  const b = crypto.createHash("sha256").update(got).digest();
  return crypto.timingSafeEqual(a, b);
}

export const TWILIO_NOT_CONFIGURED =
  "Twilio not configured: TWILIO_ACCOUNT_SID, TWILIO_FROM_NUMBER and either " +
  "TWILIO_API_KEY_SID+TWILIO_API_KEY_SECRET or TWILIO_AUTH_TOKEN must be set " +
  "on this deployment. Nothing was sent.";

export type TwilioSendResult =
  | { ok: true; sid: string; status: string }
  | { ok: false; error: string };

/** POST one SMS to Twilio's Messages endpoint. Never throws. */
export async function twilioSend(
  creds: TwilioCreds,
  to: string,
  body: string,
  statusCallback?: string
): Promise<TwilioSendResult> {
  const form = new URLSearchParams({ To: to, From: creds.from, Body: body });
  if (statusCallback) form.set("StatusCallback", statusCallback);
  try {
    const r = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${creds.accountSid}/Messages.json`,
      {
        method: "POST",
        headers: {
          Authorization:
            "Basic " + Buffer.from(`${creds.user}:${creds.secret}`).toString("base64"),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: form.toString(),
      }
    );
    const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    if (!r.ok) {
      const msg = typeof j.message === "string" ? j.message : `HTTP ${r.status}`;
      return { ok: false, error: `Twilio rejected the send: ${msg}` };
    }
    return {
      ok: true,
      sid: String(j.sid ?? ""),
      status: String(j.status ?? "queued"),
    };
  } catch (e) {
    return {
      ok: false,
      error: `Could not reach Twilio: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/**
 * Validate X-Twilio-Signature per Twilio's spec: HMAC-SHA1 over the full URL
 * plus every POST param appended in sorted-key order, base64, keyed by the auth
 * token. Constant-time compare. False on any missing piece — fail closed.
 */
export function validTwilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
  signature: string | null
): boolean {
  if (!signature) return false;
  let data = url;
  for (const k of Object.keys(params).sort()) data += k + params[k];
  const expected = crypto
    .createHmac("sha1", authToken)
    .update(Buffer.from(data, "utf8"))
    .digest("base64");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** The public URL Twilio signed against, rebuilt from proxy headers. */
export function publicUrl(req: Request): string {
  const u = new URL(req.url);
  const proto = req.headers.get("x-forwarded-proto") ?? u.protocol.replace(":", "");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? u.host;
  return `${proto}://${host}${u.pathname}${u.search}`;
}

// ── The message ledger (public.messages) ───────────────────────────────────

export type MessageRow = {
  contact_id?: number | null;
  client_slug?: string | null;
  channel: "sms" | "email";
  direction: "outbound" | "inbound";
  to_addr?: string | null;
  from_addr?: string | null;
  body?: string | null;
  status: string;
  provider_sid?: string | null;
  error?: string | null;
};

/** Insert one ledger row via the service key. Returns the row id, or null with
 *  a reason — the caller decides whether that is fatal. */
export async function logMessage(
  row: MessageRow
): Promise<{ id: number | null; error: string | null }> {
  const url = sbUrl();
  const key = sbService();
  if (!url || !key) {
    return { id: null, error: "OS_SUPABASE_URL / OS_SUPABASE_SERVICE_KEY are not set." };
  }
  try {
    const r = await fetch(`${url}/rest/v1/messages`, {
      method: "POST",
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
      },
      body: JSON.stringify(row),
    });
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      return { id: null, error: `messages insert failed (HTTP ${r.status}): ${body.slice(0, 200)}` };
    }
    const rows = (await r.json()) as { id: number }[];
    return { id: rows?.[0]?.id ?? null, error: null };
  } catch (e) {
    return { id: null, error: e instanceof Error ? e.message : String(e) };
  }
}

// ── Suppression (opt-out / do_not_contact) for SMS ──────────────────────────
// Mirror of isEmailSuppressed in lib/email.ts, keyed on the phone number. Two
// sources of truth, both already defined (migration 0014 + 0004):
//   * public.consent — a REVOKED sms-consent row (channel='sms', revoked_at
//     set) for an address is a hard opt-out (the A2P STOP paper trail).
//   * public.crm_contacts.do_not_contact = true for a row with that phone — a
//     manual "never contact".
// This never invents tables; it reads those through the service key.
// FAIL CLOSED: if Supabase is unreachable or the service key is missing we
// cannot prove the number is clear, so we treat it as suppressed (skip send).
//
// Format note: the send route validates `to` as strict E.164 (+digits) and the
// A2P STOP that writes a revoked consent row arrives as an E.164 number, so the
// consent match is exact. crm_contacts.phone may be stored in varied formats,
// so the do_not_contact check matches BOTH the exact E.164 and its last-10
// national digits — an over-match there only ever skips a send (fail-safe),
// never sends to a suppressed number.

export type SmsSuppressionResult = { suppressed: boolean; reason: string | null };

/** True if the number must not be texted: a revoked sms-consent row exists, OR
 *  a crm_contacts row with that phone has do_not_contact=true. Never throws.
 *  Fails closed (suppressed=true) when the backend cannot be reached. */
export async function isPhoneSuppressed(phone: string): Promise<SmsSuppressionResult> {
  const to = (phone || "").trim();
  if (!to) return { suppressed: true, reason: "empty number" };

  const url = sbUrl();
  const key = sbService();
  if (!url || !key) {
    return {
      suppressed: true,
      reason: "suppression list unreachable (OS_SUPABASE_URL / OS_SUPABASE_SERVICE_KEY not set)",
    };
  }
  const headers = { apikey: key, Authorization: `Bearer ${key}` };
  const last10 = to.replace(/\D/g, "").slice(-10);

  // 1) Revoked sms-consent row for this number (exact E.164 match).
  try {
    const q =
      `select=id&channel=eq.sms&revoked_at=not.is.null` +
      `&address=eq.${encodeURIComponent(to)}&limit=1`;
    const r = await fetch(`${url}/rest/v1/consent?${q}`, { headers, cache: "no-store" });
    if (!r.ok) {
      return { suppressed: true, reason: `suppression check failed (consent HTTP ${r.status})` };
    }
    const rows = (await r.json()) as unknown[];
    if (Array.isArray(rows) && rows.length > 0) {
      return { suppressed: true, reason: "recipient opted out (revoked sms consent)" };
    }
  } catch (e) {
    return {
      suppressed: true,
      reason: `suppression check errored: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  // 2) crm_contacts.do_not_contact = true for this phone. Match the exact
  //    E.164 OR any stored format ending in the same 10 national digits.
  try {
    const parts = [`phone.eq.${to}`];
    if (last10.length === 10) parts.push(`phone.like.*${last10}`);
    const q =
      `select=id&do_not_contact=is.true` +
      `&or=(${encodeURIComponent(parts.join(","))})&limit=1`;
    const r = await fetch(`${url}/rest/v1/crm_contacts?${q}`, { headers, cache: "no-store" });
    if (!r.ok) {
      return { suppressed: true, reason: `suppression check failed (crm_contacts HTTP ${r.status})` };
    }
    const rows = (await r.json()) as unknown[];
    if (Array.isArray(rows) && rows.length > 0) {
      return { suppressed: true, reason: "recipient is marked do_not_contact" };
    }
  } catch (e) {
    return {
      suppressed: true,
      reason: `suppression check errored: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  return { suppressed: false, reason: null };
}

/** PATCH ledger rows. Never throws; returns an error string or null. */
export async function patchMessages(
  filter: string,
  patch: Record<string, unknown>
): Promise<string | null> {
  const url = sbUrl();
  const key = sbService();
  if (!url || !key) return "OS_SUPABASE_URL / OS_SUPABASE_SERVICE_KEY are not set.";
  try {
    const r = await fetch(`${url}/rest/v1/messages?${filter}`, {
      method: "PATCH",
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify(patch),
    });
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      return `messages update failed (HTTP ${r.status}): ${body.slice(0, 200)}`;
    }
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}
