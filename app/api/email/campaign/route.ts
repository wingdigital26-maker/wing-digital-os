import { NextRequest, NextResponse } from "next/server";
import { getOsSession, hasLegacyAuth } from "@/lib/osSupabase";
import { logMessage, patchMessages } from "@/lib/sms";
import {
  instantlyKey,
  instantlyAddLead,
  copyViolation,
  INSTANTLY_NOT_CONFIGURED,
} from "@/lib/email";

// ───────────────────────────────────────────────────────────────────────────
// POST /api/email/campaign — enqueue ONE lead into an Instantly campaign for
// cold outreach. Instantly has no "send now" primitive: it sends on its own
// warmed schedule, so this ENQUEUES, it does not send. Recorded in the
// `messages` ledger with status "enqueued" so every hand-off is tracked.
//
// SAFETY RAILS
//  * Nothing calls this automatically. Every enqueue is a deliberate call.
//  * Auth, fail closed: a staff OS session OR x-heartbeat-key = HEARTBEAT_KEY.
//  * Instantly unconfigured => a clear 503.
//  * Copy is gated on Wing house rules when a personalization body is given.
//  * campaign id comes from the request or INSTANTLY_DEFAULT_CAMPAIGN.
//
// Body: { to, campaign?, first_name?, last_name?, company_name?,
//         personalization?, custom_variables?, client_slug?, contact_id? }
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

  const apiKey = instantlyKey();
  if (!apiKey) {
    return NextResponse.json({ ok: false, error: INSTANTLY_NOT_CONFIGURED }, { status: 503 });
  }

  const b = (await req.json().catch(() => null)) as {
    to?: string; campaign?: string;
    first_name?: string; last_name?: string; company_name?: string;
    personalization?: string; custom_variables?: Record<string, string>;
    client_slug?: string; contact_id?: number;
  } | null;

  const to = (b?.to ?? "").trim();
  const campaign = (b?.campaign ?? "").trim() || (process.env.INSTANTLY_DEFAULT_CAMPAIGN ?? "").trim();
  if (!EMAIL_RE.test(to)) {
    return NextResponse.json({ ok: false, error: "`to` must be a valid email address." }, { status: 400 });
  }
  if (!campaign) {
    return NextResponse.json(
      { ok: false, error: "`campaign` is required (or set INSTANTLY_DEFAULT_CAMPAIGN)." },
      { status: 400 }
    );
  }
  const personalization = (b?.personalization ?? "").trim();
  if (personalization) {
    const violation = copyViolation("", personalization);
    if (violation) {
      return NextResponse.json({ ok: false, error: `Refused to enqueue: ${violation}` }, { status: 400 });
    }
  }

  // 1) Log BEFORE enqueue.
  const logged = await logMessage({
    contact_id: typeof b?.contact_id === "number" ? b.contact_id : null,
    client_slug: (b?.client_slug ?? "").trim() || null,
    channel: "email",
    direction: "outbound",
    to_addr: to,
    from_addr: `instantly:${campaign}`,
    body: personalization || "(campaign sequence copy — sent by Instantly on schedule)",
    status: "queued",
  });
  if (logged.id == null) {
    return NextResponse.json(
      { ok: false, error: `Refused to enqueue: the hand-off could not be logged first (${logged.error}).` },
      { status: 502 }
    );
  }

  // 2) Enqueue into the campaign.
  const res = await instantlyAddLead(apiKey, campaign, {
    email: to,
    first_name: (b?.first_name ?? "").trim() || undefined,
    last_name: (b?.last_name ?? "").trim() || undefined,
    company_name: (b?.company_name ?? "").trim() || undefined,
    personalization: personalization || undefined,
    custom_variables: b?.custom_variables,
  });

  // 3) Record the outcome. "enqueued" is deliberately distinct from "sent" —
  // Instantly has not sent anything yet, it has accepted the lead.
  const now = new Date().toISOString();
  const patchErr = await patchMessages(
    `id=eq.${logged.id}`,
    res.ok
      ? { status: "enqueued", provider_sid: res.leadId, status_updated_at: now }
      : { status: "failed", error: res.error, status_updated_at: now }
  );

  if (!res.ok) {
    return NextResponse.json({ ok: false, error: res.error, messageId: logged.id }, { status: 502 });
  }
  return NextResponse.json({
    ok: true,
    messageId: logged.id,
    instantlyLeadId: res.leadId,
    campaign: res.campaign,
    note: "Enqueued into Instantly. Instantly sends on its own warmed schedule — this is not an immediate send.",
    ledgerNote: patchErr ? `Enqueued, but the ledger row could not be updated: ${patchErr}` : null,
  });
}
