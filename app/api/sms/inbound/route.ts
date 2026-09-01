import { NextRequest, NextResponse } from "next/server";
import { sbSelect } from "@/lib/osSupabase";
import {
  twilioCreds,
  validTwilioSignature,
  publicUrl,
  logMessage,
} from "@/lib/sms";

// ───────────────────────────────────────────────────────────────────────────
// POST /api/sms/inbound — the Twilio incoming-message webhook.
//
// Public path in middleware; auth is the X-Twilio-Signature check, which fails
// closed: no TWILIO_AUTH_TOKEN or bad signature => 403 and nothing stored.
//
// Every valid inbound is written to the `messages` ledger. STOP and HELP are
// handled here (carrier requirement): STOP writes a consent-revoked row and
// replies with the required confirmation; HELP replies with help text. Both
// auto-replies are themselves logged, so the ledger stays complete.
//
// Nothing here initiates outreach — replies go back inline as TwiML.
// ───────────────────────────────────────────────────────────────────────────

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Twilio's own opt-out vocabulary.
const STOP_WORDS = new Set(["stop", "stopall", "unsubscribe", "cancel", "end", "quit"]);
const HELP_WORDS = new Set(["help", "info"]);

const STOP_REPLY =
  "You have been unsubscribed from Wing Digital messages and will receive no further texts. " +
  "Reply START to resubscribe.";
const HELP_REPLY =
  "Wing Digital: reply STOP to unsubscribe. Msg & data rates may apply.";

function twiml(message?: string): NextResponse {
  const xml = message
    ? `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${message}</Message></Response>`
    : `<?xml version="1.0" encoding="UTF-8"?><Response></Response>`;
  return new NextResponse(xml, { headers: { "Content-Type": "text/xml" } });
}

async function contactIdForPhone(phone: string): Promise<number | null> {
  const rows = await sbSelect<{ id: number }>({
    table: "crm_contacts",
    select: "id",
    query: `phone=eq.${encodeURIComponent(phone)}&limit=1`,
    service: true,
  });
  return rows[0]?.id ?? null;
}

async function writeConsent(row: Record<string, unknown>): Promise<void> {
  const url = process.env.OS_SUPABASE_URL;
  const key = process.env.OS_SUPABASE_SERVICE_KEY;
  if (!url || !key) return;
  await fetch(`${url}/rest/v1/consent`, {
    method: "POST",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify(row),
  }).catch(() => undefined);
}

export async function POST(req: NextRequest) {
  const creds = twilioCreds();
  if (!creds) {
    // Cannot validate a signature without the auth token: fail closed.
    return NextResponse.json({ error: "Twilio not configured" }, { status: 503 });
  }

  const raw = await req.text();
  const params: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(raw)) params[k] = v;

  if (
    !validTwilioSignature(
      creds.token,
      publicUrl(req),
      params,
      req.headers.get("x-twilio-signature")
    )
  ) {
    return NextResponse.json({ error: "invalid signature" }, { status: 403 });
  }

  const from = params.From ?? "";
  const to = params.To ?? "";
  const body = (params.Body ?? "").trim();
  const sid = params.MessageSid ?? params.SmsSid ?? null;
  const contactId = from ? await contactIdForPhone(from) : null;

  // Log the inbound row first, whatever it says.
  await logMessage({
    contact_id: contactId,
    channel: "sms",
    direction: "inbound",
    to_addr: to,
    from_addr: from,
    body,
    status: "received",
    provider_sid: sid,
  });

  const word = body.toLowerCase().replace(/[!.]+$/, "");
  const now = new Date().toISOString();

  if (STOP_WORDS.has(word)) {
    await writeConsent({
      contact_id: contactId,
      address: from,
      channel: "sms",
      revoked_at: now,
      method: "sms-stop",
      proof: sid ? `Twilio inbound ${sid}: "${body}"` : `inbound SMS: "${body}"`,
    });
    await logMessage({
      contact_id: contactId, channel: "sms", direction: "outbound",
      to_addr: from, from_addr: to, body: STOP_REPLY,
      status: "sent", provider_sid: null,
    });
    return twiml(STOP_REPLY);
  }

  if (word === "start" || word === "unstop" || word === "yes") {
    await writeConsent({
      contact_id: contactId,
      address: from,
      channel: "sms",
      granted_at: now,
      method: "sms-start",
      proof: sid ? `Twilio inbound ${sid}: "${body}"` : `inbound SMS: "${body}"`,
    });
    return twiml();
  }

  if (HELP_WORDS.has(word)) {
    await logMessage({
      contact_id: contactId, channel: "sms", direction: "outbound",
      to_addr: from, from_addr: to, body: HELP_REPLY,
      status: "sent", provider_sid: null,
    });
    return twiml(HELP_REPLY);
  }

  // A real reply: stored and left for a human in the Messages board. No auto
  // response — nothing on this pipe talks to a person on its own.
  return twiml();
}
