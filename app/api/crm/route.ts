import { NextResponse } from "next/server";

// ───────────────────────────────────────────────────────────────────────────
// CRM API — every outbound message, compartmentalized by the client it is FOR.
//
// Backed by the Sonar Supabase project's `outbound` table (SONAR_SUPABASE_*),
// so it works with the PC off. Each row is one drafted email or social reply for
// one Wing client, carrying the real fact it was personalized on. Nothing here
// sends; approve/skip just move a row's status so Jack keeps everything checked.
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

async function countWhere(filter: string): Promise<number> {
  const res = await sb(`outbound?${filter}&select=id`, { Prefer: "count=exact", Range: "0-0" });
  const n = Number((res.headers.get("content-range") || "").split("/").pop());
  return Number.isFinite(n) ? n : 0;
}

export async function GET(req: Request) {
  const { url, key } = creds();
  if (!url || !key) {
    return NextResponse.json({ configured: false, clients: [], items: [] });
  }
  const { searchParams } = new URL(req.url);
  const client = searchParams.get("client") || "";
  const status = searchParams.get("status") || "";
  const channel = searchParams.get("channel") || "";

  try {
    // Per-client rollup for the sidebar: how many drafts vs approved vs sent.
    const clientsRes = await sb(
      "outbound?select=client,status,channel&limit=5000&order=created_at.desc"
    );
    const all = clientsRes.ok ? ((await clientsRes.json()) as {
      client: string; status: string; channel: string;
    }[]) : [];
    const byClient: Record<string, {
      client: string; total: number; draft: number; approved: number; sent: number;
      channels: Set<string>;
    }> = {};
    for (const r of all) {
      const c = (byClient[r.client] ||= {
        client: r.client, total: 0, draft: 0, approved: 0, sent: 0, channels: new Set(),
      });
      c.total++;
      if (r.status === "draft") c.draft++;
      else if (r.status === "approved") c.approved++;
      else if (r.status === "sent") c.sent++;
      if (r.channel) c.channels.add(r.channel);
    }
    const clients = Object.values(byClient)
      .map((c) => ({ ...c, channels: Array.from(c.channels).sort() }))
      .sort((a, b) => b.total - a.total);

    // The item list, filtered to the current selection.
    const filters = [
      client ? `client=eq.${encodeURIComponent(client)}` : "",
      status ? `status=eq.${encodeURIComponent(status)}` : "",
      channel ? `channel=eq.${encodeURIComponent(channel)}` : "",
      "order=created_at.desc",
      "limit=200",
      "select=id,client,channel,recipient,recipient_url,subject,body,personalization," +
        "evidence_url,status,tier,created_at",
    ].filter(Boolean).join("&");
    const res = await sb(`outbound?${filters}`);
    const items = res.ok ? await res.json() : [];

    const totals = {
      total: all.length,
      draft: await countWhere("status=eq.draft"),
      approved: await countWhere("status=eq.approved"),
      sent: await countWhere("status=eq.sent"),
    };

    return NextResponse.json({ configured: true, clients, items, totals });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ configured: true, error: msg, clients: [], items: [] });
  }
}

// Approve / skip / mark-sent, and save an edited body. Never transmits.
export async function POST(req: Request) {
  const { url, key } = creds();
  if (!url || !key) return NextResponse.json({ ok: false, error: "not configured" });
  const b = await req.json().catch(() => ({}));
  const { id, action, body } = b as { id?: number; action?: string; body?: string };
  if (!id) return NextResponse.json({ ok: false, error: "bad request" }, { status: 400 });

  const now = new Date().toISOString();
  const patch: Record<string, unknown> =
    action === "approve" ? { status: "approved", reviewed_at: now }
    : action === "skip" ? { status: "skipped", reviewed_at: now }
    : action === "sent" ? { status: "sent", sent_at: now }
    : action === "save" ? { body: body ?? "" }
    : {};
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ ok: false, error: "unknown action" }, { status: 400 });
  }
  const res = await fetch(`${url}/rest/v1/outbound?id=eq.${id}`, {
    method: "PATCH",
    headers: {
      apikey: key, Authorization: `Bearer ${key}`,
      "Content-Type": "application/json", Prefer: "return=minimal",
    },
    body: JSON.stringify(patch),
  });
  return NextResponse.json({ ok: res.ok });
}
