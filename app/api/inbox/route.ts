import { NextResponse } from "next/server";

// ───────────────────────────────────────────────────────────────────────────
// Client Inbox API, a working queue, not a browsing board. One row per
// client: what is waiting for a human, oldest first, plus whether this
// client can be sent for at all, plus when their scraper last ran.
//
// Backed by the same Sonar Supabase tables as /api/crm (outbound,
// crm_clients, client_send_policy). Nothing here sends. Approve/skip just
// moves status, exactly like the CRM board's proven pattern.
// ───────────────────────────────────────────────────────────────────────────

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function creds() {
  return {
    url: process.env.SONAR_SUPABASE_URL,
    key: process.env.SONAR_SUPABASE_SERVICE_KEY,
  };
}

async function sb(path: string, extra: Record<string, string> = {}) {
  const { url, key } = creds();
  return fetch(`${url}/rest/v1/${path}`, {
    headers: { apikey: key as string, Authorization: `Bearer ${key}`, ...extra },
    cache: "no-store",
  });
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const s = (v: unknown): string | null =>
  typeof v === "string" && v.trim() !== "" ? v.trim() : null;

// PostgREST caps an unbounded select at 1000 rows and stays silent about it.
// Page against the real Content-Range total, same defense as /api/crm.
const PAGE = 500;
const INBOX_COLUMNS = [
  "id", "client", "channel", "direction", "recipient", "recipient_handle",
  "recipient_url", "subject", "body", "personalization", "evidence_url",
  "status", "tier", "created_at", "reviewed_at", "sent_at",
] as const;
type OutRow = Record<string, unknown>;

async function scanOutbound(filter: string): Promise<{ rows: OutRow[]; complete: boolean; total: number | null; note: string | null }> {
  const q = filter ? `outbound?${filter}&select=id&limit=1` : "outbound?select=id&limit=1";
  const head = await sb(q, { Prefer: "count=exact", Range: "0-0" });
  const parsed = Number((head.headers.get("content-range") || "").split("/").pop());
  const total = Number.isFinite(parsed) ? parsed : null;
  if (total == null) {
    return { rows: [], complete: false, total: null,
      note: "PostgREST returned no Content-Range total, so the true row count is unknown." };
  }
  const rows: OutRow[] = [];
  for (let offset = 0; offset < total; offset += PAGE) {
    const cols = `select=${INBOX_COLUMNS.join(",")}`;
    const url = filter
      ? `outbound?${filter}&${cols}&order=created_at.asc&offset=${offset}&limit=${PAGE}`
      : `outbound?${cols}&order=created_at.asc&offset=${offset}&limit=${PAGE}`;
    const res = await sb(url);
    if (!res.ok) {
      return { rows, complete: false, total,
        note: `A page failed to load, so this read is a floor of ${rows.length} of ${total} rows.` };
    }
    const batch = (await res.json()) as OutRow[];
    if (!batch.length) break;
    rows.push(...batch);
  }
  const complete = rows.length === total;
  return { rows, complete, total,
    note: complete ? null : `Read ${rows.length} of ${total} rows. Counts below are a floor, not a total.` };
}

function shapeItem(r: OutRow) {
  return {
    id: typeof r.id === "number" ? r.id : Number(r.id ?? 0),
    client: s(r.client),
    channel: s(r.channel),
    direction: s(r.direction),
    recipient: s(r.recipient),
    recipientHandle: s(r.recipient_handle),
    recipientUrl: s(r.recipient_url),
    subject: s(r.subject),
    body: s(r.body),
    personalization: s(r.personalization),
    evidenceUrl: s(r.evidence_url),
    status: s(r.status),
    tier: s(r.tier),
    createdAt: s(r.created_at),
    reviewedAt: s(r.reviewed_at),
    sentAt: s(r.sent_at),
    // The single strongest reason to contact them, said in one line, never
    // invented. Falls back to an honest "nothing recorded" rather than 0/"".
    reason: reasonFor(r),
  };
}

function reasonFor(r: OutRow): string {
  const p = s(r.personalization);
  const subject = s(r.subject);
  const fromP = p?.match(/[""]([^""]{8,})[""]/) ?? null;
  const fromS = subject?.match(/[""]([^""]{8,})[""]/) ?? null;
  const quoted = fromP ?? fromS;
  if (quoted) return `In their own words: "${quoted[1]}"`;
  if (p) return p.length > 180 ? `${p.slice(0, 180)}...` : p;
  return "No reason recorded, the drafter left no personalization note on this row.";
}

export type ClientInboxEntry = {
  client: string;
  waiting: number;
  counts: { draft: number; approved: number; skipped: number; sent: number; other: number };
  sendPolicy: { available: boolean; maySend: boolean | null; scopeNote: string | null };
  lastScrapedAt: string | null;
  lastScrapedTracked: boolean;
  queue: ReturnType<typeof shapeItem>[];
  // Seam for replies. No fake data ever placed here, just an honest marker of
  // whether the pipe exists yet.
  replies: { available: boolean; reason: string; items: never[] };
};

export async function GET(req: Request) {
  const { url, key } = creds();
  if (!url || !key) {
    return NextResponse.json({ configured: false, clients: [], error: null });
  }
  const { searchParams } = new URL(req.url);
  const onlyClient = searchParams.get("client") || "";

  try {
    const filter = onlyClient ? `client=eq.${encodeURIComponent(onlyClient)}` : "";
    const scan = await scanOutbound(filter);

    // Send policy, default deny, same contract as /api/crm.
    let policyAvailable = false;
    let policyByClient: Record<string, { may_send: boolean; scope_note: string | null }> = {};
    try {
      const res = await sb("client_send_policy?select=client,may_send,scope_note");
      if (res.ok) {
        policyAvailable = true;
        const rows = (await res.json()) as { client: string; may_send: boolean; scope_note: string | null }[];
        for (const row of rows) policyByClient[norm(row.client)] = row;
      }
    } catch { /* leave unavailable */ }

    // crm_clients for last_scraped_at, select=* so a missing column never 400s.
    let cfgs: Record<string, unknown>[] = [];
    try {
      const cfgRes = await sb("crm_clients?select=*");
      if (cfgRes.ok) cfgs = (await cfgRes.json()) as Record<string, unknown>[];
    } catch { /* leave empty */ }
    const lastScrapedTracked = cfgs.some((c) => "last_scraped_at" in c);
    const cfgByName: Record<string, Record<string, unknown>> =
      Object.fromEntries(cfgs.filter((c) => c.name).map((c) => [norm(String(c.name)), c]));

    type Bucket = {
      client: string; draft: OutRow[]; approved: number; skipped: number; sent: number; other: number;
    };
    const byClient: Record<string, Bucket> = {};
    for (const r of scan.rows) {
      const client = String(r.client ?? "");
      if (!client) continue;
      const b = (byClient[client] ||= { client, draft: [], approved: 0, skipped: 0, sent: 0, other: 0 });
      const status = String(r.status ?? "");
      if (status === "draft") b.draft.push(r);
      else if (status === "approved") b.approved++;
      else if (status === "skipped") b.skipped++;
      else if (status === "sent") b.sent++;
      else b.other++;
    }
    // A configured client with nothing drafted yet still belongs in the rail.
    for (const cfg of cfgs) {
      const n = String(cfg.name ?? "");
      if (n && !byClient[n]) byClient[n] = { client: n, draft: [], approved: 0, skipped: 0, sent: 0, other: 0 };
    }

    const clients: ClientInboxEntry[] = Object.values(byClient)
      .map((b) => {
        const pol = policyByClient[norm(b.client)];
        const cfg = cfgByName[norm(b.client)];
        const lastScrapedAt =
          lastScrapedTracked && cfg ? (s(cfg.last_scraped_at) ?? null) : null;
        // draft rows already sorted created_at.asc by the scan query = oldest unhandled first.
        const queue = b.draft.map(shapeItem);
        return {
          client: b.client,
          waiting: queue.length,
          counts: { draft: b.draft.length, approved: b.approved, skipped: b.skipped, sent: b.sent, other: b.other },
          sendPolicy: {
            available: policyAvailable,
            maySend: policyAvailable ? (pol ? pol.may_send === true : false) : null,
            scopeNote: pol?.scope_note ?? (policyAvailable
              ? "No send-policy row on file for this client, which defaults to deny."
              : null),
          },
          lastScrapedAt,
          lastScrapedTracked,
          queue,
          replies: {
            available: false,
            reason:
              "No reply pipeline exists yet. This client's inbox will show replies here " +
              "once one is built; nothing is faked in the meantime.",
            items: [],
          },
        };
      })
      .sort((a, b) => b.waiting - a.waiting);

    return NextResponse.json({
      configured: true,
      clients,
      scan: { complete: scan.complete, total: scan.total, note: scan.note },
      error: null,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ configured: true, clients: [], error: msg }, { status: 502 });
  }
}

// Approve / skip. Mirrors the CRM board's write contract exactly: a failed
// write returns a non-200-ish error body so the row must stay on screen with
// the real error, never a silent success.
export async function POST(req: Request) {
  const { url, key } = creds();
  if (!url || !key) {
    return NextResponse.json({ ok: false, error: "Sonar Supabase is not configured." }, { status: 500 });
  }
  const b = await req.json().catch(() => ({}));
  const { id, action } = b as { id?: number; action?: string };
  if (!id) return NextResponse.json({ ok: false, error: "Missing row id." }, { status: 400 });

  const now = new Date().toISOString();
  const patch: Record<string, unknown> =
    action === "approve" ? { status: "approved", reviewed_at: now }
    : action === "skip" ? { status: "skipped", reviewed_at: now }
    : {};
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ ok: false, error: `Unknown action "${action}".` }, { status: 400 });
  }

  const res = await fetch(`${url}/rest/v1/outbound?id=eq.${id}`, {
    method: "PATCH",
    headers: {
      apikey: key, Authorization: `Bearer ${key}`,
      "Content-Type": "application/json", Prefer: "return=minimal",
    },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    return NextResponse.json(
      { ok: false, error: detail || `${action} failed (HTTP ${res.status})` },
      { status: 502 }
    );
  }
  return NextResponse.json({ ok: true, status: patch.status ?? null });
}
