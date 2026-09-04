import type { NextRequest } from "next/server";
import {
  parseTwilioWebhook,
  twiml,
  escapeXml,
  callbackUrl,
  voiceNumberFor,
  contactIdForPhone,
  insertCall,
  markMissed,
} from "../_lib";

// ───────────────────────────────────────────────────────────────────────────
// POST /api/voice/inbound: the Twilio Voice webhook for a tracked number.
//
// A call comes in on a number listed in voice_numbers. We log it, then tell
// Twilio to ring the owner's cell (forward_to) for ring_seconds. Twilio POSTs
// the outcome of that dial to /api/voice/status, which decides whether the
// call was answered or missed. Missed calls become call.missed events, which
// is how a client's missed-call text-back workflow fires.
//
// Public path in middleware; auth is the X-Twilio-Signature check (or the
// ?k= gate when only API keys are configured) and it fails closed: 503 when
// Twilio is unconfigured, 403 on a bad signature, nothing stored either way.
//
// Nothing here sends a text. "We will text you shortly" is only spoken when
// there is no number to forward to; whether a text actually goes out is the
// engine's decision under its own send rules.
// ───────────────────────────────────────────────────────────────────────────

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const parsed = await parseTwilioWebhook(req);
  if (!parsed.ok) return parsed.response;
  const p = parsed.params;

  const from = p.From ?? "";
  const to = p.To ?? "";
  const callSid = p.CallSid ?? "";

  const lookup = await voiceNumberFor(to);

  if (!lookup.ok) {
    // The database did not answer. That is an outage, not a missing setup,
    // so the caller hears something neutral and the row (if it can be
    // written at all) says failed with the reason. Nothing rings.
    await insertCall({
      provider_sid: callSid || null,
      contact_id: null,
      client_slug: null,
      direction: "inbound",
      from_number: from || null,
      to_number: to || null,
      status: "failed",
      ended_at: new Date().toISOString(),
      notes: `voice_numbers lookup failed: ${lookup.error}`.slice(0, 500),
    });
    return twiml("<Say>Sorry, we could not take your call right now.</Say><Hangup/>");
  }

  const number = lookup.row;
  if (!number) {
    // A number Twilio routed to us that nobody registered. Say so, hang up,
    // and leave evidence: the row is the only way anyone finds out.
    await insertCall({
      provider_sid: callSid || null,
      contact_id: null,
      client_slug: null,
      direction: "inbound",
      from_number: from || null,
      to_number: to || null,
      status: "failed",
      ended_at: new Date().toISOString(),
    });
    return twiml("<Say>This number is not set up yet.</Say><Hangup/>");
  }

  const contactId = await contactIdForPhone(from);
  await insertCall({
    provider_sid: callSid || null,
    contact_id: contactId,
    client_slug: number.client_slug,
    direction: "inbound",
    from_number: from || null,
    to_number: to || null,
    status: "ringing",
  });

  const greeting = number.greeting ? `<Say>${escapeXml(number.greeting)}</Say>` : "";

  if (!number.forward_to) {
    // Nowhere to ring: this is a missed call the moment it lands.
    await markMissed({
      callSid,
      from,
      to,
      clientSlug: number.client_slug,
      contactId,
      dialStatus: "no-forward",
    });
    const say =
      process.env.AUTOMATION_SEND_ENABLED === "1"
        ? "Sorry, nobody is available right now. We will text you shortly."
        : "Sorry, nobody is available right now. Please try again shortly.";
    return twiml(`${greeting}<Say>${escapeXml(say)}</Say><Hangup/>`);
  }

  const ring = Number.isFinite(number.ring_seconds) && number.ring_seconds > 0
    ? Math.min(60, Math.trunc(number.ring_seconds))
    : 20;
  const action = escapeXml(callbackUrl(req, "/api/voice/status"));
  return twiml(
    `${greeting}<Dial timeout="${ring}" action="${action}" method="POST">${escapeXml(number.forward_to)}</Dial>`
  );
}
