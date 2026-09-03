import { NextResponse } from "next/server";

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/outbound/export — the read-only queue the SMTP sender (a friend's
// project, built against docs/SENDING-CONTRACT.md) pulls from.
//
// This route NEVER sends anything and NEVER marks anything as sent. It reads
// the outbound_sendable VIEW (supabase/migrations/0005_outbound_sendable.sql)
// and hands back rows already shaped to smtp_sender.py's batch JSONL fields
// ("to", "subject", "body", "pid"), so the consumer needs no translation
// layer. Approval (status='approved') still happens only in the CRM board via
// POST /api/crm; this route cannot write.
//
// `outbound` lives in the separate Sonar Supabase project (SONAR_SUPABASE_URL /
// SONAR_SUPABASE_SERVICE_KEY), same as app/api/crm/route.ts — NOT the OS's own
// project. See the migration file for why.
// ═══════════════════════════════════════════════════════════════════════════

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Fail-closed key check: if the secret is unset, no request is authorized,
// ever. Its own env var because this guards a high-stakes surface (an unsent
// send queue) and must not be able to piggyback on a key issued for
// something else.
// Accepts either `Authorization: Bearer <key>` (the header documented in
// SENDING-CONTRACT.md) or `?k=<key>` (matches the existing dashboard-link
// pattern), so a browser spot-check and a scripted client both work the
// same way.
function exportKeyOk(req: Request): boolean {
  const key = process.env.OUTBOUND_EXPORT_KEY;
  if (!key) return false;
  const auth = req.headers.get("authorization") || "";
  const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  if (bearer && bearer === key) return true;
  const provided = new URL(req.url).searchParams.get("k");
  return provided === key;
}

function creds() {
  return {
    url: process.env.SONAR_SUPABASE_URL,
    key: process.env.SONAR_SUPABASE_SERVICE_KEY,
  };
}

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

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

export async function GET(req: Request) {
  // Auth first, before anything else runs or leaks via error detail.
  if (!exportKeyOk(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { url, key } = creds();
  if (!url || !key) {
    return NextResponse.json(
      { error: "not configured: SONAR_SUPABASE_URL / SONAR_SUPABASE_SERVICE_KEY unset" },
      { status: 503 }
    );
  }

  const { searchParams } = new URL(req.url);
  const format = (searchParams.get("format") || "jsonl").toLowerCase();
  const limitParam = Number(searchParams.get("limit"));
  const limit =
    Number.isFinite(limitParam) && limitParam > 0
      ? Math.min(Math.trunc(limitParam), MAX_LIMIT)
      : DEFAULT_LIMIT;

  // ── Suppression gate ──────────────────────────────────────────────────────
  // This endpoint hands a list of addresses to a machine whose entire job is to
  // email them. Exporting a row that belongs to someone who opted out, bounced,
  // or is a paying client is the single worst thing this route could do, and it
  // is unrecoverable once the mail leaves.
  //
  // The suppression list is NOT reachable from here. It historically lived in
  // ghl-cli/outreach_logs/suppression.json, seeded from GoHighLevel, which was
  // retired on 2026-08-22 and now 401s permanently. That file is not present on
  // disk, and the Sonar project holds no suppression table. So there is
  // currently no way to prove any given row is safe to send.
  //
  // Therefore this route FAILS CLOSED. It refuses to export rather than hand
  // over an unscreened queue. Create the `suppression` table in the Sonar
  // project (email text primary key) and this gate starts enforcing instead of
  // refusing. Never replace this with a pass-through.
  const suppression = await fetch(
    `${url}/rest/v1/suppression?select=email`,
    { headers: { apikey: key, Authorization: `Bearer ${key}` }, cache: "no-store" }
  ).catch(() => null);

  if (!suppression || !suppression.ok) {
    return NextResponse.json(
      {
        error: "suppression list unavailable",
        detail:
          "Refusing to export a send queue that has not been checked against " +
          "the do-not-contact list. Create the `suppression` table in the Sonar " +
          "Supabase project and populate it before using this endpoint.",
        exported: 0,
      },
      { status: 503 }
    );
  }

  // Must match public.canonical_email in migration 0009 exactly. Lowercase,
  // trim, and strip any plus tag, because info+x@d.com and info@d.com are the
  // same mailbox. Dots are deliberately NOT stripped: that is Gmail specific
  // and would wrongly collapse distinct addresses on other providers.
  //
  // This filter and the view previously agreed with each other while both
  // applying the same incomplete rule, which is worse than disagreeing because
  // it looks like corroboration. If you change one, change the other.
  const canonical = (addr: string): string =>
    (addr || "").trim().toLowerCase().replace(/\+[^@]*@/, "@");

  const blocked = new Set(
    ((await suppression.json().catch(() => [])) as { email?: string }[])
      .map((r) => canonical(r.email || ""))
      .filter(Boolean)
  );

  let rows: SendableRow[];
  try {
    const res = await fetch(
      `${url}/rest/v1/outbound_sendable?select=*&order=created_at.asc&limit=${limit}`,
      {
        headers: { apikey: key, Authorization: `Bearer ${key}` },
        cache: "no-store",
      }
    );
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return NextResponse.json(
        { error: `upstream read failed: HTTP ${res.status}`, detail: detail.slice(0, 500) },
        { status: 502 }
      );
    }
    rows = (await res.json()) as SendableRow[];
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: `upstream unreachable: ${msg}` }, { status: 502 });
  }

  // Drop anything on the do-not-contact list. Reported separately so the caller
  // can see that screening happened rather than assuming an empty list means
  // nothing was filtered.
  const before = rows.length;
  rows = rows.filter((r) => !blocked.has(canonical(r.to || "")));
  const removed = before - rows.length;

  if (format === "json") {
    return NextResponse.json({
      count: rows.length,
      suppressed: removed,
      suppressionListSize: blocked.size,
      items: rows,
    });
  }

  // Default: JSONL, one object per line, exactly matching smtp_sender.py's
  // --batch queue format (see that file's docstring: `{"to","subject","body","pid"}`,
  // plus any extra fields as pass-through meta it logs and echoes back).
  const jsonl = rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "");
  return new NextResponse(jsonl, {
    status: 200,
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "X-Row-Count": String(rows.length),
      "X-Suppressed-Count": String(removed),
    },
  });
}
