import { NextRequest, NextResponse } from "next/server";
import {
  twilioCreds,
  validTwilioSignature,
  publicUrl,
  patchMessages,
} from "@/lib/sms";

// ───────────────────────────────────────────────────────────────────────────
// POST /api/sms/status — Twilio delivery-status callback.
//
// Twilio POSTs MessageSid + MessageStatus (queued/sent/delivered/failed/
// undelivered) as a message moves through the carrier. The matching ledger row
// (matched on provider_sid) gets the new status and timestamp, so "sent" vs
// "delivered" vs "failed" on the Messages board is carrier truth, not a guess.
//
// Public path in middleware; auth is the X-Twilio-Signature check, fail closed.
// ───────────────────────────────────────────────────────────────────────────

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const creds = twilioCreds();
  if (!creds) {
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

  const sid = params.MessageSid ?? params.SmsSid ?? "";
  const status = params.MessageStatus ?? params.SmsStatus ?? "";
  if (!sid || !status) {
    return NextResponse.json({ error: "MessageSid and MessageStatus required" }, { status: 400 });
  }

  const patch: Record<string, unknown> = {
    status,
    status_updated_at: new Date().toISOString(),
  };
  const code = params.ErrorCode;
  if (code && code !== "0") {
    patch.error = `Twilio error ${code}${params.ErrorMessage ? `: ${params.ErrorMessage}` : ""}`;
  }

  const err = await patchMessages(`provider_sid=eq.${encodeURIComponent(sid)}`, patch);
  if (err) return NextResponse.json({ ok: false, error: err }, { status: 502 });
  return NextResponse.json({ ok: true });
}
