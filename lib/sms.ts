// Twilio SMS plumbing + the unified message ledger helpers.
//
// Plain fetch against Twilio's REST API — no SDK dependency. Everything here
// FAILS CLOSED: missing TWILIO_* env vars produce a clear "Twilio not
// configured" result, never a crash and never a silent success.
//
// Env var names (values live in Vercel/local env only, never in code or vault):
//   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER
import crypto from "node:crypto";
import { sbUrl, sbService } from "./osSupabase";

export type TwilioCreds = { sid: string; token: string; from: string };

/** null when any of the three env vars is missing — the caller must say so. */
export function twilioCreds(): TwilioCreds | null {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM_NUMBER;
  if (!sid || !token || !from) return null;
  return { sid, token, from };
}

export const TWILIO_NOT_CONFIGURED =
  "Twilio not configured: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and " +
  "TWILIO_FROM_NUMBER must all be set on this deployment. Nothing was sent.";

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
      `https://api.twilio.com/2010-04-01/Accounts/${creds.sid}/Messages.json`,
      {
        method: "POST",
        headers: {
          Authorization:
            "Basic " + Buffer.from(`${creds.sid}:${creds.token}`).toString("base64"),
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
