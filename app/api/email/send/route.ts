import { NextRequest, NextResponse } from "next/server";
import { getOsSession, hasLegacyAuth } from "@/lib/osSupabase";
import { logMessage, patchMessages } from "@/lib/sms";
import {
  smtpCreds,
  smtpSend,
  copyViolation,
  isEmailSuppressed,
  makeUnsubToken,
  SMTP_NOT_CONFIGURED,
} from "@/lib/email";

// ───────────────────────────────────────────────────────────────────────────
// POST /api/email/send — send ONE email NOW through a Wing-owned mailbox and
// record it in the unified `messages` ledger. The instant 1:1 lane: CRM
// replies, appointment confirmations, missed-call follow-ups.
//
// SAFETY RAILS (mirror app/api/sms/send/route.ts exactly)
//  * Nothing calls this automatically. Every send is a deliberate call.
//  * Auth, fail closed: a staff OS session OR x-heartbeat-key = HEARTBEAT_KEY.
//  * SMTP unconfigured => a clear 503, never a crash.
//  * Copy is gated on Wing house rules (no em dashes, no unrendered tokens).
//  * The ledger row is written BEFORE the mailbox is touched, and refused
//    outright if it cannot be logged first.
//
// Body: { to, subject, body, client_slug?, contact_id?, replyTo?,
//         unsubscribeMailto? }
// ───────────────────────────────────────────────────────────────────────────

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STAFF = new Set(["admin", "owner", "staff"]);
const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

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

  const creds = smtpCreds();
  if (!creds) {
    return NextResponse.json({ ok: false, error: SMTP_NOT_CONFIGURED }, { status: 503 });
  }

  const b = (await req.json().catch(() => null)) as {
    to?: string; subject?: string; body?: string;
    client_slug?: string; contact_id?: number;
    replyTo?: string; unsubscribeMailto?: string;
  } | null;
  const to = (b?.to ?? "").trim();
  const subject = (b?.subject ?? "").trim();
  const text = (b?.body ?? "").trim();

  if (!EMAIL_RE.test(to)) {
    return NextResponse.json(
      { ok: false, error: "`to` must be a valid email address." },
      { status: 400 }
    );
  }
  if (!subject) {
    return NextResponse.json({ ok: false, error: "`subject` is required." }, { status: 400 });
  }
  if (!text) {
    return NextResponse.json({ ok: false, error: "`body` is required." }, { status: 400 });
  }
  const violation = copyViolation(subject, text);
  if (violation) {
    return NextResponse.json(
      { ok: false, error: `Refused to send: ${violation}` },
      { status: 400 }
    );
  }

  // Suppression gate: never email anyone who has opted out or is marked
  // do_not_contact. Fails closed (isEmailSuppressed returns suppressed=true if
  // the backend is unreachable). Runs AFTER the copy guard, BEFORE logging or
  // sending, so a refused address touches neither the ledger nor the mailbox.
  const supp = await isEmailSuppressed(to);
  if (supp.suppressed) {
    return NextResponse.json(
      { ok: false, error: `Refused: ${supp.reason ?? "recipient is suppressed"}` },
      { status: 403 }
    );
  }

  // Build the absolute public unsubscribe URL from the proxy headers (same
  // technique as publicUrl in lib/sms.ts), carrying a signed one-click token.
  const proto = req.headers.get("x-forwarded-proto") ?? new URL(req.url).protocol.replace(":", "");
  const host =
    req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? new URL(req.url).host;
  const unsubToken = makeUnsubToken(to);
  const unsubscribeUrl = unsubToken
    ? `${proto}://${host}/api/email/unsubscribe?email=${encodeURIComponent(to)}&token=${unsubToken}`
    : undefined;

  // 1) Log BEFORE sending.
  const logged = await logMessage({
    contact_id: typeof b?.contact_id === "number" ? b.contact_id : null,
    client_slug: (b?.client_slug ?? "").trim() || null,
    channel: "email",
    direction: "outbound",
    to_addr: to,
    from_addr: creds.user,
    body: `${subject}\n\n${text}`,
    status: "queued",
  });
  if (logged.id == null) {
    return NextResponse.json(
      { ok: false, error: `Refused to send: the message could not be logged first (${logged.error}).` },
      { status: 502 }
    );
  }

  // 2) Send.
  const sent = await smtpSend(creds, to, subject, text, {
    replyTo: (b?.replyTo ?? "").trim() || undefined,
    unsubscribeMailto: (b?.unsubscribeMailto ?? "").trim() || undefined,
    unsubscribeUrl,
  });

  // 3) Record the outcome on the same row.
  const now = new Date().toISOString();
  const patchErr = await patchMessages(
    `id=eq.${logged.id}`,
    sent.ok
      ? { status: "sent", provider_sid: sent.messageId, status_updated_at: now }
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
    providerMessageId: sent.messageId,
    from: sent.from,
    ledgerNote: patchErr
      ? `Sent, but the ledger row could not be updated: ${patchErr}`
      : null,
  });
}
