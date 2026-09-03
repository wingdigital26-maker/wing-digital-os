// Shared plumbing for the Twilio Voice webhooks (/api/voice/inbound and
// /api/voice/status) plus the staff voice routes.
//
// Same auth as /api/sms/inbound: X-Twilio-Signature when TWILIO_AUTH_TOKEN is
// set, else the ?k=TWILIO_WEBHOOK_KEY gate. Fails closed. Writes use the
// service key (phone_calls / voice_numbers RLS is staff-only). Nothing here
// ever throws into a TwiML route: a database hiccup must not turn into a
// dead line for the caller.
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { sbUrl, sbService, sbSelect } from "@/lib/osSupabase";
import { twilioCreds, validTwilioSignature, validWebhookKey, publicUrl, webhookKey } from "@/lib/sms";
import { emitEventAsync } from "@/lib/automations/emit";

export type VoiceNumberRow = {
  number: string;
  client_slug: string | null;
  forward_to: string | null;
  greeting: string | null;
  ring_seconds: number;
  created_at?: string;
};

export type PhoneCallRow = {
  id: number;
  provider_sid: string | null;
  contact_id: number | null;
  client_slug: string | null;
  direction: "inbound" | "outbound";
  from_number: string | null;
  to_number: string | null;
  status: string;
  duration_sec: number | null;
  started_at: string;
  ended_at: string | null;
};

// ── Auth + body ────────────────────────────────────────────────────────────
export type WebhookParse =
  | { ok: true; params: Record<string, string> }
  | { ok: false; response: NextResponse };

export async function parseTwilioWebhook(req: NextRequest): Promise<WebhookParse> {
  const creds = twilioCreds();
  if (!creds) {
    return { ok: false, response: NextResponse.json({ error: "Twilio not configured" }, { status: 503 }) };
  }
  const raw = await req.text();
  const params: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(raw)) params[k] = v;

  const authorized = creds.authToken
    ? validTwilioSignature(creds.authToken, publicUrl(req), params, req.headers.get("x-twilio-signature"))
    : validWebhookKey(req);
  if (!authorized) {
    return { ok: false, response: NextResponse.json({ error: "unauthorized" }, { status: 403 }) };
  }
  return { ok: true, params };
}

// ── TwiML ──────────────────────────────────────────────────────────────────
export function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function twiml(inner: string): NextResponse {
  const xml = `<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`;
  return new NextResponse(xml, { headers: { "Content-Type": "text/xml" } });
}

// The absolute URL Twilio should call back, on the same host it reached us on,
// carrying the ?k= gate when that is how this deployment authenticates.
export function callbackUrl(req: NextRequest, path: string): string {
  const base = new URL(publicUrl(req));
  const u = new URL(path, `${base.protocol}//${base.host}`);
  const creds = twilioCreds();
  const k = webhookKey();
  if (!creds?.authToken && k) u.searchParams.set("k", k);
  return u.toString();
}

// ── Lookups ────────────────────────────────────────────────────────────────
export async function voiceNumberFor(to: string): Promise<VoiceNumberRow | null> {
  if (!to) return null;
  const rows = await sbSelect<VoiceNumberRow>({
    table: "voice_numbers",
    select: "number,client_slug,forward_to,greeting,ring_seconds",
    query: `number=eq.${encodeURIComponent(to)}&limit=1`,
    service: true,
  });
  return rows[0] ?? null;
}

export async function contactIdForPhone(phone: string): Promise<number | null> {
  if (!phone) return null;
  const rows = await sbSelect<{ id: number }>({
    table: "crm_contacts",
    select: "id",
    query: `phone=eq.${encodeURIComponent(phone)}&limit=1`,
    service: true,
  });
  return rows[0]?.id ?? null;
}

// ── Writes (never throw) ───────────────────────────────────────────────────
function svc(): { url: string; key: string } | null {
  const url = sbUrl();
  const key = sbService();
  return url && key ? { url, key } : null;
}

export async function insertCall(row: Record<string, unknown>): Promise<PhoneCallRow | null> {
  const s = svc();
  if (!s) return null;
  try {
    const r = await fetch(`${s.url}/rest/v1/phone_calls`, {
      method: "POST",
      headers: {
        apikey: s.key,
        Authorization: `Bearer ${s.key}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
      },
      body: JSON.stringify(row),
    });
    if (!r.ok) return null;
    const rows = (await r.json()) as PhoneCallRow[];
    return rows[0] ?? null;
  } catch {
    return null;
  }
}

export async function patchCallBySid(sid: string, patch: Record<string, unknown>): Promise<PhoneCallRow | null> {
  const s = svc();
  if (!s || !sid) return null;
  try {
    const r = await fetch(`${s.url}/rest/v1/phone_calls?provider_sid=eq.${encodeURIComponent(sid)}`, {
      method: "PATCH",
      headers: {
        apikey: s.key,
        Authorization: `Bearer ${s.key}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
      },
      body: JSON.stringify(patch),
    });
    if (!r.ok) return null;
    const rows = (await r.json()) as PhoneCallRow[];
    return rows[0] ?? null;
  } catch {
    return null;
  }
}

// A missed call is the one voice fact the automation layer cares about
// (missed-call text-back). Mark the row and hand the fact to the engine. The
// async emit returns fast so the TwiML response is never held up.
export async function markMissed(args: {
  callSid: string;
  from: string;
  to: string;
  clientSlug: string | null;
  contactId: number | null;
  dialStatus: string;
}): Promise<void> {
  const updated = await patchCallBySid(args.callSid, {
    status: "missed",
    ended_at: new Date().toISOString(),
  });
  try {
    await emitEventAsync({
      type: "call.missed",
      client_slug: updated?.client_slug ?? args.clientSlug,
      contact_id: updated?.contact_id ?? args.contactId,
      payload: {
        phone: args.from || null,
        to: args.to || null,
        call_sid: args.callSid,
        dial_status: args.dialStatus,
      },
    });
  } catch {
    // The call row already says missed; the engine's cron can still notice.
  }
}
