import { NextResponse } from "next/server";

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/outbound/sent — the write-back half of GET /api/outbound/export.
//
// The export route hands a sender a queue and never mutates anything. Nothing
// in this repo ever marked a row as sent, so the same message would export
// forever and the same person would get emailed repeatedly. This route closes
// that loop: a sender reports what happened to each row it attempted, and
// this route records it so the row stops being exportable (sent_at removes it
// from outbound_sendable) and, for a hard bounce or a complaint, so the
// address can never be exported again for anyone.
//
// This route NEVER sends anything itself. It only records outcomes that
// already happened elsewhere.
//
// `outbound` and `suppression` both live in the separate Sonar Supabase
// project (SONAR_SUPABASE_URL / SONAR_SUPABASE_SERVICE_KEY), same as
// app/api/outbound/export/route.ts and app/api/crm/route.ts.
// ═══════════════════════════════════════════════════════════════════════════

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Same fail-closed key check as the export route, same env var (this is the
// other half of the same authorization boundary: whoever can pull the queue
// is who gets to report back on it).
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

type Outcome = "sent" | "failed" | "bounced" | "complained" | "rejected";
const VALID_OUTCOMES: Outcome[] = ["sent", "failed", "bounced", "complained", "rejected"];

type ResultIn = {
  id?: unknown;
  outcome?: unknown;
  error?: unknown;
  mailbox?: unknown;
};

type RowResult = {
  id: number | null;
  outcome: string | null;
  status: "ok" | "already_sent" | "error";
  detail: string;
};

// The `outbound` row shape needed to check idempotency and to report a
// meaningful "already sent" instead of silently overwriting the timestamp.
type OutRow = { id: number; status: string | null; sent_at: string | null };

export async function POST(req: Request) {
  // Auth first, before anything else runs or touches the database.
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

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  // Accept either { results: [...] } or a bare array, so a sender can post a
  // single-result batch without wrapping it.
  const results: unknown = Array.isArray(payload)
    ? payload
    : payload && typeof payload === "object"
    ? (payload as Record<string, unknown>).results
    : undefined;

  if (!Array.isArray(results) || results.length === 0) {
    return NextResponse.json(
      { error: "expected a non-empty array of results, either as the body or as body.results" },
      { status: 400 }
    );
  }
  if (results.length > 500) {
    return NextResponse.json(
      { error: `batch too large: ${results.length} results, max 500 per request` },
      { status: 400 }
    );
  }

  // ── Validate every row up front. Malformed entries get an explicit
  // per-row error and never reach the database, but they do not abort the
  // whole batch — a sender's report of 49 good rows and 1 bad row must not
  // become a 500 that hides all 50.
  const rowResults: RowResult[] = [];
  const validIds: number[] = [];
  const byId = new Map<number, ResultIn & { outcome: Outcome }>();

  for (const raw of results as ResultIn[]) {
    const idNum = typeof raw?.id === "number" ? raw.id : Number(raw?.id);
    if (raw == null || typeof raw !== "object") {
      rowResults.push({ id: null, outcome: null, status: "error", detail: "result entry is not an object" });
      continue;
    }
    if (!Number.isFinite(idNum) || !Number.isInteger(idNum) || idNum <= 0) {
      rowResults.push({
        id: null, outcome: (raw.outcome as string) ?? null, status: "error",
        detail: `id "${String(raw.id)}" is not a positive integer`,
      });
      continue;
    }
    const outcome = raw.outcome as string;
    if (!VALID_OUTCOMES.includes(outcome as Outcome)) {
      rowResults.push({
        id: idNum, outcome: outcome ?? null, status: "error",
        detail: `outcome "${String(raw.outcome)}" is not one of ${VALID_OUTCOMES.join(", ")}`,
      });
      continue;
    }
    if (byId.has(idNum)) {
      rowResults.push({
        id: idNum, outcome, status: "error",
        detail: "duplicate id within this batch; only the first occurrence in a batch is honored, resend the rest separately",
      });
      continue;
    }
    byId.set(idNum, { ...raw, outcome: outcome as Outcome });
    validIds.push(idNum);
  }

  if (validIds.length === 0) {
    // Nothing to look up, but this is not a server error — return the
    // per-row validation failures as-is.
    return NextResponse.json({ results: rowResults }, { status: 200 });
  }

  // ── Look up current state for every referenced id in one call, so we can
  // detect unknown ids and already-sent rows without a write racing ahead of
  // a read.
  let existing: OutRow[];
  try {
    const res = await fetch(
      `${url}/rest/v1/outbound?id=in.(${validIds.join(",")})&select=id,status,sent_at`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` }, cache: "no-store" }
    );
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return NextResponse.json(
        { error: `upstream read failed: HTTP ${res.status}`, detail: detail.slice(0, 500) },
        { status: 502 }
      );
    }
    existing = (await res.json()) as OutRow[];
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: `upstream unreachable: ${msg}` }, { status: 502 });
  }
  const existingById = new Map(existing.map((r) => [r.id, r]));

  const now = new Date().toISOString();

  // Recipient emails to suppress, collected as we go (bounced/complained/rejected).
  // The export route filters strictly on `to`, so suppression needs that
  // address, which is not in `outbound`'s minimal select above. Fetch it only
  // for the ids we will actually suppress, to avoid pulling every row's PII
  // for a batch that is mostly `sent`.
  const suppressCandidateIds = validIds.filter((id) => {
    const r = byId.get(id);
    return r && (r.outcome === "bounced" || r.outcome === "complained" || r.outcome === "rejected");
  });

  const emailById = new Map<number, string>();
  if (suppressCandidateIds.length) {
    try {
      const res = await fetch(
        `${url}/rest/v1/outbound?id=in.(${suppressCandidateIds.join(",")})&select=id,recipient`,
        { headers: { apikey: key, Authorization: `Bearer ${key}` }, cache: "no-store" }
      );
      if (res.ok) {
        const rows = (await res.json()) as { id: number; recipient: string | null }[];
        for (const r of rows) if (r.recipient) emailById.set(r.id, r.recipient.trim().toLowerCase());
      }
      // If this read fails, we still proceed row by row below; each affected
      // row will report the suppression failure individually rather than
      // aborting the whole batch.
    } catch {
      // same: handled per-row below via emailById staying empty for those ids.
    }
  }

  for (const id of validIds) {
    const entry = byId.get(id)!;
    const outcome = entry.outcome;
    const row = existingById.get(id);

    if (!row) {
      rowResults.push({ id, outcome, status: "error", detail: `no outbound row with id ${id} exists` });
      continue;
    }

    if (outcome === "sent") {
      if (row.sent_at) {
        // Idempotency: never move the clock on a row already marked sent.
        rowResults.push({
          id, outcome, status: "already_sent",
          detail: `row ${id} was already marked sent at ${row.sent_at}; timestamp was NOT overwritten`,
        });
        continue;
      }
      const patchRes = await fetch(`${url}/rest/v1/outbound?id=eq.${id}`, {
        method: "PATCH",
        headers: {
          apikey: key, Authorization: `Bearer ${key}`,
          "Content-Type": "application/json", Prefer: "return=minimal",
        },
        body: JSON.stringify({ status: "sent", sent_at: now }),
      });
      if (!patchRes.ok) {
        const detail = await patchRes.text().catch(() => "");
        rowResults.push({
          id, outcome, status: "error",
          detail: `failed to write sent_at: HTTP ${patchRes.status} ${detail.slice(0, 300)}`,
        });
        continue;
      }
      rowResults.push({ id, outcome, status: "ok", detail: `marked sent at ${now}` });
      continue;
    }

    if (outcome === "failed") {
      // Record the failure but do NOT set sent_at, so the row stays eligible
      // for retry via /api/outbound/export. The error text, if any, is kept
      // for visibility rather than swallowed.
      const errText = typeof entry.error === "string" ? entry.error.slice(0, 2000) : null;
      const patchRes = await fetch(`${url}/rest/v1/outbound?id=eq.${id}`, {
        method: "PATCH",
        headers: {
          apikey: key, Authorization: `Bearer ${key}`,
          "Content-Type": "application/json", Prefer: "return=minimal",
        },
        body: JSON.stringify({ last_send_error: errText, last_send_attempt_at: now }),
      });
      if (!patchRes.ok) {
        const detail = await patchRes.text().catch(() => "");
        // If the columns don't exist yet, say so plainly rather than hiding
        // behind a generic 502 — this is a real, actionable gap.
        rowResults.push({
          id, outcome, status: "error",
          detail:
            `failed to record failure: HTTP ${patchRes.status} ${detail.slice(0, 300)}. ` +
            `If this mentions an unknown column, outbound is missing ` +
            `last_send_error/last_send_attempt_at and needs a migration; the row ` +
            `was NOT marked sent and remains retryable regardless.`,
        });
        continue;
      }
      rowResults.push({
        id, outcome, status: "ok",
        detail: `recorded as failed (transient), not marked sent, remains eligible for retry${errText ? `: ${errText}` : ""}`,
      });
      continue;
    }

    // bounced / complained / rejected: mark the row AND suppress the address.
    // These share handling because all three mean "do not contact this
    // address again," which is the property that actually matters here.
    const statusForOutcome =
      outcome === "bounced" ? "bounced" : outcome === "complained" ? "complained" : "rejected";

    const email = emailById.get(id);
    let suppressOk = false;
    let suppressDetail = "";
    if (!email) {
      suppressDetail =
        "could not resolve a recipient email for this row (read failed or recipient is empty), " +
        "so suppression was NOT written; the address may still be exported and re-contacted";
    } else {
      const supRes = await fetch(`${url}/rest/v1/suppression`, {
        method: "POST",
        headers: {
          apikey: key, Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          // Upsert on the email primary key. Never delete a suppression row
          // from this endpoint; a hard bounce that gets un-suppressed later
          // by a different path is exactly the failure mode this exists to
          // prevent.
          Prefer: "resolution=merge-duplicates,return=minimal",
        },
        body: JSON.stringify([{ email, reason: outcome, source: "outbound/sent", added_at: now }]),
      });
      if (supRes.ok) {
        suppressOk = true;
      } else {
        const detail = await supRes.text().catch(() => "");
        suppressDetail = `suppression insert failed: HTTP ${supRes.status} ${detail.slice(0, 300)}`;
      }
    }

    const patchRes = await fetch(`${url}/rest/v1/outbound?id=eq.${id}`, {
      method: "PATCH",
      headers: {
        apikey: key, Authorization: `Bearer ${key}`,
        "Content-Type": "application/json", Prefer: "return=minimal",
      },
      // No sent_at here on purpose: a bounce/complaint is not a delivery.
      body: JSON.stringify({ status: statusForOutcome, last_send_attempt_at: now }),
    });

    if (!patchRes.ok) {
      const detail = await patchRes.text().catch(() => "");
      rowResults.push({
        id, outcome, status: "error",
        detail:
          `row status update failed: HTTP ${patchRes.status} ${detail.slice(0, 300)}. ` +
          `Suppression ${suppressOk ? "WAS still recorded for " + email : "was not recorded"}.`,
      });
      continue;
    }

    if (!suppressOk) {
      // The row is marked, but the one part of this outcome that actually
      // protects the address failed. This must be loud, not a bare ok.
      rowResults.push({
        id, outcome, status: "error",
        detail: `row marked "${statusForOutcome}" but suppression was NOT confirmed: ${suppressDetail}`,
      });
      continue;
    }

    rowResults.push({
      id, outcome, status: "ok",
      detail: `row marked "${statusForOutcome}" and ${email} inserted into suppression (reason: ${outcome})`,
    });
  }

  // Never a blanket ok:true. The caller gets one entry per id it sent, in
  // whatever order they were processed, so partial success is always visible.
  const summary = {
    total: rowResults.length,
    ok: rowResults.filter((r) => r.status === "ok").length,
    already_sent: rowResults.filter((r) => r.status === "already_sent").length,
    error: rowResults.filter((r) => r.status === "error").length,
  };

  return NextResponse.json({ summary, results: rowResults }, { status: 200 });
}
