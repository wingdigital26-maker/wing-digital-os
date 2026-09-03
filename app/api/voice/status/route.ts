import type { NextRequest } from "next/server";
import { parseTwilioWebhook, twiml, patchCallBySid, markMissed } from "../_lib";

// ───────────────────────────────────────────────────────────────────────────
// POST /api/voice/status: the <Dial action> callback from /api/voice/inbound,
// and usable as the number's StatusCallback too.
//
// Twilio tells us how the forwarded leg ended:
//   DialCallStatus completed              => answered; store the duration
//   busy | no-answer | failed | canceled  => missed; emit call.missed
//
// When Twilio posts a plain CallStatus (StatusCallback shape) instead of a
// DialCallStatus, only a terminal "completed" with no DialCallStatus is
// treated as the call ending, and the row is closed without guessing whether
// anyone answered.
//
// Public path in middleware; same fail-closed auth as /api/voice/inbound.
// ───────────────────────────────────────────────────────────────────────────

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MISSED = new Set(["busy", "no-answer", "failed", "canceled"]);

export async function POST(req: NextRequest) {
  const parsed = await parseTwilioWebhook(req);
  if (!parsed.ok) return parsed.response;
  const p = parsed.params;

  const callSid = p.CallSid ?? "";
  const dialStatus = (p.DialCallStatus ?? "").toLowerCase();
  const from = p.From ?? "";
  const to = p.To ?? "";
  const now = new Date().toISOString();

  if (!callSid) return twiml("");

  if (dialStatus === "completed") {
    const dur = Number(p.DialCallDuration);
    await patchCallBySid(callSid, {
      status: "completed",
      duration_sec: Number.isFinite(dur) && dur >= 0 ? Math.trunc(dur) : null,
      ended_at: now,
    });
    return twiml("");
  }

  if (MISSED.has(dialStatus)) {
    await markMissed({ callSid, from, to, clientSlug: null, contactId: null, dialStatus });
    return twiml("<Say>Sorry we missed you. We will text you right back.</Say><Hangup/>");
  }

  // StatusCallback shape (no DialCallStatus): close the row on a terminal
  // status without inventing an answered / missed verdict we do not have.
  const callStatus = (p.CallStatus ?? "").toLowerCase();
  if (!dialStatus && ["completed", "busy", "no-answer", "failed", "canceled"].includes(callStatus)) {
    await patchCallBySid(callSid, {
      status: callStatus === "completed" ? "completed" : callStatus,
      ended_at: now,
    });
  }
  return twiml("");
}
