import { NextRequest, NextResponse } from "next/server";
import { getOsSession, hasLegacyAuth } from "@/lib/osSupabase";
import {
  twilioCreds,
  twilioSend,
  logMessage,
  patchMessages,
  publicUrl,
  TWILIO_NOT_CONFIGURED,
} from "@/lib/sms";

// ───────────────────────────────────────────────────────────────────────────
// POST /api/sms/send — send ONE SMS through Twilio and record it in the
// unified `messages` ledger.
//
// SAFETY RAILS
//  * Nothing calls this automatically. No cron, no agent, no workflow. It
//    exists so Jack (or a script he runs by hand) can send a text; every send
//    is a deliberate call.
//  * Auth, fail closed: either a staff OS session (the middleware already
//    gates /api/*) or the machine key header x-heartbeat-key = HEARTBEAT_KEY,
//    same contract as /api/notify.
//  * Twilio unconfigured => a clear 503 "Twilio not configured", never a crash.
//  * The ledger row is written BEFORE Twilio is called, so a crash mid-send
//    still leaves evidence a send was attempted; the row is then updated with
//    the real status or the error.
//
// Body: { to: "+1...", body: "text", client_slug?: string, contact_id?: number }
// ───────────────────────────────────────────────────────────────────────────

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STAFF = new Set(["admin", "owner", "staff"]);

async function authorized(req: NextRequest): Promise<boolean> {
  const machineKey = process.env.HEARTBEAT_KEY;
  if (machineKey && req.headers.get("x-heartbeat-key") === machineKey) return true;
  const session = await getOsSession();
  if (session) return STAFF.has(session.role);
  return await hasLegacyAuth();
}

export async function POST(req: NextRequest) {
  if (!(await authorized(req))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const creds = twilioCreds();
  if (!creds) {
    return NextResponse.json({ ok: false, error: TWILIO_NOT_CONFIGURED }, { status: 503 });
  }

  const b = (await req.json().catch(() => null)) as {
    to?: string; body?: string; client_slug?: string; contact_id?: number;
  } | null;
  const to = (b?.to ?? "").trim();
  const text = (b?.body ?? "").trim();
  if (!/^\+\d{8,15}$/.test(to)) {
    return NextResponse.json(
      { ok: false, error: "`to` must be an E.164 number like +12145550100." },
      { status: 400 }
    );
  }
  if (!text) {
    return NextResponse.json({ ok: false, error: "`body` is required." }, { status: 400 });
  }

  // 1) Log BEFORE sending.
  const logged = await logMessage({
    contact_id: typeof b?.contact_id === "number" ? b.contact_id : null,
    client_slug: (b?.client_slug ?? "").trim() || null,
    channel: "sms",
    direction: "outbound",
    to_addr: to,
    from_addr: creds.from,
    body: text,
    status: "queued",
  });
  if (logged.id == null) {
    // Refuse to send what cannot be recorded — an unlogged SMS is exactly the
    // untracked message this ledger exists to prevent.
    return NextResponse.json(
      { ok: false, error: `Refused to send: the message could not be logged first (${logged.error}).` },
      { status: 502 }
    );
  }

  // 2) Send, with delivery-status callbacks pointed at /api/sms/status.
  const statusCallback = publicUrl(req).replace(/\/api\/sms\/send.*$/, "/api/sms/status");
  const sent = await twilioSend(creds, to, text, statusCallback);

  // 3) Record the outcome on the same row.
  const now = new Date().toISOString();
  const patchErr = await patchMessages(
    `id=eq.${logged.id}`,
    sent.ok
      ? { status: sent.status || "sent", provider_sid: sent.sid, status_updated_at: now }
      : { status: "failed", error: sent.error, status_updated_at: now }
  );

  if (!sent.ok) {
    return NextResponse.json(
      { ok: false, error: sent.error, messageId: logged.id },
      { status: 502 }
    );
  }
  return NextResponse.json({
    ok: true,
    messageId: logged.id,
    sid: sent.sid,
    status: sent.status,
    ledgerNote: patchErr
      ? `Sent, but the ledger row could not be updated with the SID: ${patchErr}`
      : null,
  });
}
