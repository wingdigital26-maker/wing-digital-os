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
import { phoneMatchFilter } from "@/lib/phone";

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
  notes?: string | null;
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
// "Not found" and "the query failed" are different facts: an unregistered
// number is a config gap, a failed query is an outage. The inbound route must
// say different things to the caller for each, so the result carries which.
export type VoiceNumberLookup =
  | { ok: true; row: VoiceNumberRow | null }
  | { ok: false; error: string };

export async function voiceNumberFor(to: string): Promise<VoiceNumberLookup> {
  if (!to) return { ok: true, row: null };
  const s = svc();
  if (!s) return { ok: false, error: "OS_SUPABASE_URL / OS_SUPABASE_SERVICE_KEY are not set" };
  const qs = `select=${encodeURIComponent("number,client_slug,forward_to,greeting,ring_seconds")}&number=eq.${encodeURIComponent(to)}&limit=1`;
  try {
    const r = await fetch(`${s.url}/rest/v1/voice_numbers?${qs}`, {
      headers: { apikey: s.key, Authorization: `Bearer ${s.key}` },
      cache: "no-store",
    });
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      return { ok: false, error: `voice_numbers query failed (HTTP ${r.status}): ${body.slice(0, 200)}` };
    }
    const rows = (await r.json()) as VoiceNumberRow[];
    return { ok: true, row: rows[0] ?? null };
  } catch (e) {
    return { ok: false, error: `voice_numbers unreachable: ${e instanceof Error ? e.message : String(e)}` };
  }
}

// Which client owns a Twilio number. Shared by the voice and SMS webhooks so
// an event is scoped to the client whose number was called or texted.
//   found=false            the number is not registered (or the lookup failed)
//   found=true, slug=null  registered as Wing's own number
//   found=true, slug=...   registered to that client
export type NumberOwner = { found: boolean; client_slug: string | null };

export async function numberOwner(to: string): Promise<NumberOwner> {
  if (!to) return { found: false, client_slug: null };
  const rows = await sbSelect<{ client_slug: string | null }>({
    table: "voice_numbers",
    select: "client_slug",
    query: `number=eq.${encodeURIComponent(to)}&limit=1`,
    service: true,
  });
  return rows[0] ? { found: true, client_slug: rows[0].client_slug ?? null } : { found: false, client_slug: null };
}

// Contact by phone. Twilio hands us E.164; the filter also tries the bare
// 10-digit form for rows written before phones were normalized on write.
export async function contactIdForPhone(phone: string): Promise<number | null> {
  const filter = phoneMatchFilter(phone);
  if (!filter) return null;
  const rows = await sbSelect<{ id: number }>({
    table: "crm_contacts",
    select: "id",
    query: `${filter}&limit=1`,
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
//
// CLIENT SCOPING IS MANDATORY. The engine fires NULL-client workflows only
// for NULL-client events (Wing's own), so a call.missed whose client is
// merely UNKNOWN would run Wing's missed-call workflow for a client's
// caller. The client comes from the phone_calls row, then the caller's
// argument, then voice_numbers by the To number (where a registered row
// with a NULL client_slug is Wing's own number, which is a known answer).
// If none of those knows the number, NO event is emitted and the reason is
// returned so the route can record it.
export type MissedResult = { emitted: boolean; clientSlug: string | null; reason: string | null };

export async function markMissed(args: {
  callSid: string;
  from: string;
  to: string;
  clientSlug: string | null;
  contactId: number | null;
  dialStatus: string;
}): Promise<MissedResult> {
  const updated = await patchCallBySid(args.callSid, {
    status: "missed",
    ended_at: new Date().toISOString(),
  });
  let clientSlug = updated?.client_slug ?? args.clientSlug ?? null;
  if (!clientSlug) {
    const owner = await numberOwner(args.to);
    if (!owner.found) {
      return {
        emitted: false,
        clientSlug: null,
        reason: `call.missed not emitted: no client for call ${args.callSid} (phone_calls row ${updated ? "has no client_slug" : "not found"}, and ${args.to || "(no To number)"} is not in voice_numbers)`,
      };
    }
    clientSlug = owner.client_slug; // null here means Wing's own registered number
  }
  try {
    await emitEventAsync({
      type: "call.missed",
      client_slug: clientSlug,
      contact_id: updated?.contact_id ?? args.contactId,
      payload: {
        phone: args.from || null,
        to: args.to || null,
        call_sid: args.callSid,
        dial_status: args.dialStatus,
      },
    });
    return { emitted: true, clientSlug, reason: null };
  } catch (e) {
    // The call row already says missed; the engine's cron can still notice.
    return { emitted: false, clientSlug, reason: `emit failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

// What the caller hears after a miss. Only promise a text when the engine can
// actually send one on this deployment.
export function missedSay(): string {
  return process.env.AUTOMATION_SEND_ENABLED === "1"
    ? "Sorry we missed you. We will text you right back."
    : "Sorry we missed you. Please try again shortly.";
}
