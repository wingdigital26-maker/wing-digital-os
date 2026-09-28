import { NextRequest, NextResponse } from "next/server";
import {
  twilioCreds,
  validTwilioSignature,
  validWebhookKey,
  publicUrl,
  logMessage,
} from "@/lib/sms";
import { emitEventAsync } from "@/lib/automations/emit";
import { contactIdForPhone, numberOwner } from "../../voice/_lib";
import { dbInsert, dbPatch, dbSelect } from "@/lib/restOrPooler";
import { brandNameOrNull } from "@/lib/clientBrands";

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

// One Wing number texts for several businesses, so the confirmation names the
// business that last texted this person (from the messages ledger), falling
// back to Wing Digital. A STOP here opts the number out of EVERY text from this
// line, whichever business it was for, so the copy says "this number".
function stopReply(brand: string | null): string {
  return (
    `${brand ?? "Wing Digital"}: you are unsubscribed and will get no more texts from this number. ` +
    "Reply START to resubscribe."
  );
}
function helpReply(brand: string | null): string {
  return `${brand ?? "Wing Digital"}: reply STOP to unsubscribe. Msg & data rates may apply.`;
}

// The client whose message this person most recently received, if any.
async function lastClientFor(phone: string): Promise<string | null> {
  try {
    const rows = await dbSelect<{ client_slug: string | null }>(
      "messages",
      `select=client_slug&direction=eq.outbound&channel=eq.sms&to_addr=eq.${encodeURIComponent(phone)}` +
        `&client_slug=not.is.null&order=id.desc&limit=1`
    );
    return rows[0]?.client_slug ?? null;
  } catch {
    return null;
  }
}

// The HELP copy carries "&" and brand names carry apostrophes; a raw "&" makes
// the TwiML invalid XML and Twilio drops the reply.
function xmlEscape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c] as string);
}

function twiml(message?: string): NextResponse {
  const xml = message
    ? `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${xmlEscape(message)}</Message></Response>`
    : `<?xml version="1.0" encoding="UTF-8"?><Response></Response>`;
  return new NextResponse(xml, { headers: { "Content-Type": "text/xml" } });
}

// contactIdForPhone (E.164 or bare-10-digit match) and numberOwner (which
// client owns the To number) are shared with the voice webhooks in
// app/api/voice/_lib.ts.

// REST first, direct pooler on a 402 (lib/restOrPooler). A failed opt-out
// write is logged loudly: the send routes read this row to honour STOP.
async function writeConsent(row: Record<string, unknown>): Promise<void> {
  try {
    await dbInsert("consent", row);
  } catch (e) {
    console.error("[sms/inbound] CONSENT WRITE FAILED:", e instanceof Error ? e.message : e, row);
  }
}

// Mark every CRM row with this number do_not_contact (all clients: the STOP
// covers the whole line). Matches the exact E.164 and any stored format that
// ends in the same 10 digits, same rule as isPhoneSuppressed.
async function markDoNotContact(phone: string): Promise<void> {
  const last10 = phone.replace(/\D/g, "").slice(-10);
  const parts = [`phone.eq.${phone}`];
  if (last10.length === 10) parts.push(`phone.like.*${last10}`);
  try {
    await dbPatch(
      "crm_contacts",
      `or=(${encodeURIComponent(parts.join(","))})&do_not_contact=not.is.true`,
      { do_not_contact: true }
    );
  } catch (e) {
    console.error("[sms/inbound] do_not_contact update failed:", e instanceof Error ? e.message : e);
  }
}

export async function POST(req: NextRequest) {
  const creds = twilioCreds();
  if (!creds) {
    return NextResponse.json({ error: "Twilio not configured" }, { status: 503 });
  }

  const raw = await req.text();
  const params: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(raw)) params[k] = v;

  // Auth, fail closed. With an auth token: full X-Twilio-Signature validation.
  // With API-key-only config (no auth token — API keys CANNOT validate
  // Twilio's signature), the gate is the shared-secret ?k=TWILIO_WEBHOOK_KEY
  // in the webhook URL, constant-time compared. When an auth token is added
  // later, signature validation automatically takes over.
  const authorized = creds.authToken
    ? validTwilioSignature(
        creds.authToken,
        publicUrl(req),
        params,
        req.headers.get("x-twilio-signature")
      )
    : validWebhookKey(req);
  if (!authorized) {
    return NextResponse.json({ error: "unauthorized" }, { status: 403 });
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
    if (from) await markDoNotContact(from);
    const brand = brandNameOrNull(await lastClientFor(from));
    const reply = stopReply(brand);
    await logMessage({
      contact_id: contactId, channel: "sms", direction: "outbound",
      to_addr: from, from_addr: to, body: reply,
      status: "sent", provider_sid: null,
    });
    return twiml(reply);
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
    const reply = helpReply(brandNameOrNull(await lastClientFor(from)));
    await logMessage({
      contact_id: contactId, channel: "sms", direction: "outbound",
      to_addr: from, from_addr: to, body: reply,
      status: "sent", provider_sid: null,
    });
    return twiml(reply);
  }

  // A real reply: stored and left for a human in the Messages board. No auto
  // response — nothing on this pipe talks to a person on its own.
  //
  // Automation hook: hand the reply to the engine as sms.received. Only real
  // replies reach here (STOP/START/HELP returned above). Async so Twilio gets
  // its TwiML promptly, and wrapped so a failed emit never changes the reply.
  // client_slug comes from voice_numbers by the To number: null when the
  // number is Wing's own or not registered (NULL means unknown; the engine's
  // client scoping decides what that may fire).
  try {
    const owner = await numberOwner(to);
    await emitEventAsync({
      type: "sms.received",
      client_slug: owner.client_slug,
      contact_id: contactId,
      payload: { phone: from, to, body, message_sid: sid, number_registered: owner.found },
    });
  } catch {
    // The inbound row is already in the ledger; nothing else depends on this.
  }
  return twiml();
}
