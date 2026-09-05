import { NextRequest, NextResponse } from "next/server";
import { getOsSession, hasLegacyAuth } from "@/lib/osSupabase";
import { logMessage, patchMessages } from "@/lib/sms";
import { instantlyKey, instantlyAddLead, INSTANTLY_NOT_CONFIGURED } from "@/lib/email";

// ───────────────────────────────────────────────────────────────────────────
// POST /api/email/enqueue-approved — take human-APPROVED cold-outreach rows
// from the Sonar outbound queue and enqueue them into the Instantly cold
// campaign, so approved copy actually flows into sending.
//
// This is one deliberate call. Nothing here runs automatically. Every row is
// pulled from the Sonar `outbound_sendable` view — the same read-only queue
// app/api/outbound/export/route.ts exposes — where every row is
// status='approved', i.e. a human approved it in the CRM board. This route
// only READS Sonar and only WRITES to Instantly + the local `messages` ledger.
//
// Instantly has no "send now" primitive: it sends on its own warmed schedule,
// so this ENQUEUES, it does not send. Each hand-off is logged BEFORE the
// enqueue (status "queued") and patched after (status "enqueued"/"failed"),
// mirroring app/api/email/campaign/route.ts.
//
// SUPPRESSION NOTE (honesty): the Sonar export view carries NO suppression /
// do-not-contact screening (documented in docs/SENDING-CONTRACT.md; the
// export route itself fails closed on a missing suppression table). Here that
// is acceptable because Instantly owns unsubscribe handling for the campaign —
// it suppresses opt-outs on its side. We are handing addresses to the same
// campaign that manages their unsubscribes, not to a raw SMTP pipe. This route
// therefore does NOT re-screen; that is a deliberate, documented choice.
//
// SAFETY RAILS
//  * Nothing calls this automatically. Every enqueue is a deliberate call.
//  * Auth, fail closed: a staff OS session OR x-heartbeat-key = HEARTBEAT_KEY.
//  * Instantly unconfigured => 503. Sonar creds unset => 503.
//  * campaign id comes from the request or INSTANTLY_DEFAULT_CAMPAIGN.
//  * Empty approved queue => 200 with an explicit count:0 summary, not an error.
//
// Body: { limit?, campaign?, ids? }
// ───────────────────────────────────────────────────────────────────────────

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STAFF = new Set(["admin", "owner", "staff"]);
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 200;

async function authorized(req: NextRequest): Promise<boolean> {
  const machineKey = process.env.HEARTBEAT_KEY;
  if (machineKey && req.headers.get("x-heartbeat-key") === machineKey) return true;
  const session = await getOsSession();
  if (session) return STAFF.has(session.role);
  return await hasLegacyAuth();
}

// Same Sonar project + env names as app/api/outbound/export/route.ts — this
// MUST match exactly or we read the wrong Supabase project.
function creds() {
  return {
    url: process.env.SONAR_SUPABASE_URL,
    key: process.env.SONAR_SUPABASE_SERVICE_KEY,
  };
}

// Field shape of the Sonar `outbound_sendable` view (see export route).
type SendableRow = {
  id: number;
  to: string | null;
  subject: string | null;
  body: string | null;
  pid: number;
  client: string | null;
  channel: string | null;
  tier: string | null;
  created_at: string | null;
  reviewed_at: string | null;
};

type RowResult = {
  id: number;
  to: string | null;
  result: "enqueued" | "failed";
  instantlyLeadId?: string;
  error?: string;
};

export async function POST(req: NextRequest) {
  if (!(await authorized(req))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const apiKey = instantlyKey();
  if (!apiKey) {
    return NextResponse.json({ ok: false, error: INSTANTLY_NOT_CONFIGURED }, { status: 503 });
  }

  const { url, key } = creds();
  if (!url || !key) {
    return NextResponse.json(
      { ok: false, error: "not configured: SONAR_SUPABASE_URL / SONAR_SUPABASE_SERVICE_KEY unset" },
      { status: 503 }
    );
  }

  const b = (await req.json().catch(() => null)) as {
    limit?: number;
    campaign?: string;
    ids?: number[];
  } | null;

  const campaign =
    (b?.campaign ?? "").trim() || (process.env.INSTANTLY_DEFAULT_CAMPAIGN ?? "").trim();
  if (!campaign) {
    return NextResponse.json(
      { ok: false, error: "`campaign` is required (or set INSTANTLY_DEFAULT_CAMPAIGN)." },
      { status: 400 }
    );
  }

  const limParam = Number(b?.limit);
  const limit =
    Number.isFinite(limParam) && limParam > 0
      ? Math.min(Math.trunc(limParam), MAX_LIMIT)
      : DEFAULT_LIMIT;

  // Optional explicit id allowlist. Only positive integers are honored.
  const idsProvided = Array.isArray(b?.ids);
  const ids = idsProvided
    ? b!.ids!.filter((n): n is number => typeof n === "number" && Number.isInteger(n) && n > 0)
    : null;
  // An allowlist that was provided but sanitized down to nothing means the
  // caller named only invalid ids. Enqueue NOTHING rather than silently falling
  // back to the whole approved queue (which would push rows they never named).
  if (idsProvided && ids!.length === 0) {
    return NextResponse.json({
      ok: true,
      campaign,
      summary: { total: 0, enqueued: 0, failed: 0 },
      results: [],
      note: "No valid ids were provided, so nothing was enqueued.",
    });
  }

  // ── Fetch approved rows from the Sonar outbound_sendable view ──────────────
  // Every row in this view is status='approved' (human-approved in the CRM).
  let rows: SendableRow[];
  try {
    let query = `${url}/rest/v1/outbound_sendable?select=*&order=created_at.asc&limit=${limit}`;
    if (ids && ids.length) {
      query += `&id=in.(${ids.join(",")})`;
    }
    const res = await fetch(query, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
      cache: "no-store",
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return NextResponse.json(
        { ok: false, error: `upstream read failed: HTTP ${res.status}`, detail: detail.slice(0, 500) },
        { status: 502 }
      );
    }
    rows = (await res.json()) as SendableRow[];
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: `upstream unreachable: ${msg}` }, { status: 502 });
  }

  // Empty approved queue: not an error. Return an explicit empty summary.
  if (!rows.length) {
    return NextResponse.json({
      ok: true,
      campaign,
      summary: { total: 0, enqueued: 0, failed: 0 },
      results: [] as RowResult[],
      note: "No approved rows in the Sonar outbound queue to enqueue.",
    });
  }

  const results: RowResult[] = [];
  let enqueued = 0;
  let failed = 0;

  for (const row of rows) {
    const to = (row.to ?? "").trim();
    const subject = (row.subject ?? "").trim();
    const body = (row.body ?? "").trim();

    // A row with no address cannot be enqueued. Fail closed for that row only.
    if (!to) {
      failed += 1;
      results.push({ id: row.id, to: row.to, result: "failed", error: "row has no `to` address" });
      continue;
    }

    // 1) Log BEFORE enqueue.
    const logged = await logMessage({
      contact_id: null,
      client_slug: (row.client ?? "").trim() || null,
      channel: "email",
      direction: "outbound",
      to_addr: to,
      from_addr: `instantly:${campaign}`,
      body: body || "(approved campaign copy — sent by Instantly on schedule)",
      status: "queued",
    });
    if (logged.id == null) {
      failed += 1;
      results.push({
        id: row.id,
        to,
        result: "failed",
        error: `hand-off could not be logged first (${logged.error})`,
      });
      continue;
    }

    // 2) Enqueue into the campaign. The approved subject + body ride along as
    // custom_variables so the campaign copy can reference them, and the body is
    // also passed as personalization.
    const res = await instantlyAddLead(apiKey, campaign, {
      email: to,
      company_name: (row.client ?? "").trim() || undefined,
      personalization: body || undefined,
      custom_variables: {
        approved_subject: subject,
        approved_body: body,
        sonar_pid: String(row.pid),
      },
    });

    // 3) Patch the ledger with the outcome.
    const now = new Date().toISOString();
    await patchMessages(
      `id=eq.${logged.id}`,
      res.ok
        ? { status: "enqueued", provider_sid: res.leadId, status_updated_at: now }
        : { status: "failed", error: res.error, status_updated_at: now }
    );

    if (res.ok) {
      enqueued += 1;
      results.push({ id: row.id, to, result: "enqueued", instantlyLeadId: res.leadId });
    } else {
      failed += 1;
      results.push({ id: row.id, to, result: "failed", error: res.error });
    }
  }

  return NextResponse.json({
    ok: true,
    campaign,
    summary: { total: rows.length, enqueued, failed },
    results,
    note: "Enqueued into Instantly. Instantly sends on its own warmed schedule — this is not an immediate send.",
  });
}
