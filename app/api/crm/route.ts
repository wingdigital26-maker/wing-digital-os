import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import { listVaultFiles, readVaultFile } from "@/lib/vaultSource";

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

// ── Client profile (MRR + status) ──────────────────────────────────────────
// Same vault source /api/clients reads: wiki/clients/*.md frontmatter. Read
// directly rather than over HTTP so this works in the same request.
export type ClientProfile = {
  file: string; name: string; owner: string; industry: string;
  status: string; mrr: number | null; updated: string;
};
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

function frontmatter(text: string): Record<string, string> {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const out: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
    if (kv) out[kv[1].toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

async function clientProfiles(): Promise<ClientProfile[]> {
  try {
    const files = (await listVaultFiles()).filter(
      (f) => f.startsWith("wiki/clients/") && f.endsWith(".md") &&
             f.split("/").length === 3 && !f.includes("_TEMPLATE")
    );
    const out: ClientProfile[] = [];
    for (const rel of files) {
      const text = await readVaultFile(rel);
      if (!text) continue;
      const fm = frontmatter(text);
      const slug = rel.split("/").pop()!.replace(/\.md$/, "");
      const mrr = fm.mrr != null && fm.mrr !== "" ? Number(fm.mrr) : NaN;
      out.push({
        file: rel,
        name: fm.client_name || slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
        owner: fm.owner || "",
        industry: fm.industry || "",
        status: (fm.status || "active").toLowerCase(),
        mrr: Number.isFinite(mrr) ? mrr : null,
        updated: fm.updated || fm.date || "",
      });
    }
    return out;
  } catch {
    return [];
  }
}

// ── Content / posting activity ─────────────────────────────────────────────
// The ONLY structured per-client publish record that exists today is the
// content engine's state file on Jack's PC. Anything else gets an honest
// empty state naming exactly what is missing — never invented posts.
export type ContentItem = {
  date: string; type: string; title: string; status: string; url: string | null;
};
export type ContentFeed = {
  available: boolean; source: string | null; reason: string | null; items: ContentItem[];
};

const CONTENT_STATE_FILES: Record<string, string> = {
  "jackson-roofing": "jackson-content-state.json",
};

function logDirs(): string[] {
  return [
    path.join("C:", "Users", "wjack", "ghl-cli", "outreach_logs"),
    path.join(process.cwd(), "..", "ghl-cli", "outreach_logs"),
  ];
}

async function contentFor(slug: string | null, name: string): Promise<ContentFeed> {
  const none = (reason: string): ContentFeed =>
    ({ available: false, source: null, reason, items: [] });
  if (!slug) {
    return none(
      `${name} has no row in crm_clients, so there is no slug to look up a content record with. ` +
      `Add the client to crm_clients to wire posting activity in.`
    );
  }
  const fileName = CONTENT_STATE_FILES[slug] ?? `${slug}-content-state.json`;
  let raw: string | null = null;
  let found = "";
  let dirSeen = false;
  for (const dir of logDirs()) {
    try { await fs.access(dir); dirSeen = true; } catch { continue; }
    const p = path.join(dir, fileName);
    try { raw = await fs.readFile(p, "utf8"); found = p; break; } catch { /* next */ }
  }
  if (raw == null) {
    if (!dirSeen) {
      return none(
        `Publishing records live in ghl-cli/outreach_logs on Jack's PC, which this server cannot reach ` +
        `right now. Nothing is being hidden — the source is offline.`
      );
    }
    return none(
      `No content engine has ever written a publish record for ${name}. Expected ` +
      `outreach_logs/${fileName}; it does not exist. Only Jackson Roofing's content engine writes one today.`
    );
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch {
    return none(`Found ${fileName} but it is not valid JSON, so nothing can be shown from it.`);
  }
  const items: ContentItem[] = [];
  const byDate = (parsed ?? {}) as Record<string, unknown>;
  for (const [date, rows] of Object.entries(byDate)) {
    if (!Array.isArray(rows)) continue;
    for (const r of rows as Record<string, unknown>[]) {
      items.push({
        date,
        type: String(r.type ?? ""),
        title: String(r.title ?? ""),
        status: String(r.status ?? ""),
        url: typeof r.url === "string" ? r.url : null,
      });
    }
  }
  items.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return {
    available: true,
    source: found.replace(/\\/g, "/").split("/").slice(-2).join("/"),
    reason: items.length ? null : `${fileName} exists but records no posts yet.`,
    items: items.slice(0, 60),
  };
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
    type ChannelRoll = { channel: string; total: number; draft: number; approved: number; sent: number };
    type Roll = {
      client: string; total: number; draft: number; approved: number; sent: number;
      channels: Set<string>; byChannel: Record<string, ChannelRoll>;
    };
    const blank = (client: string): Roll => ({
      client, total: 0, draft: 0, approved: 0, sent: 0, channels: new Set(), byChannel: {},
    });
    const byClient: Record<string, Roll> = {};
    for (const r of all) {
      const c = (byClient[r.client] ||= blank(r.client));
      const ch = r.channel || "unknown";
      const cc = (c.byChannel[ch] ||= { channel: ch, total: 0, draft: 0, approved: 0, sent: 0 });
      c.total++; cc.total++;
      if (r.status === "draft") { c.draft++; cc.draft++; }
      else if (r.status === "approved") { c.approved++; cc.approved++; }
      else if (r.status === "sent") { c.sent++; cc.sent++; }
      if (r.channel) c.channels.add(r.channel);
    }
    // Per-client scraper config — the hunting instructions the watcher runs on.
    const cfgRes = await sb("crm_clients?select=slug,name,channels,scrape_niche,scrape_cities,scrape_terms,active");
    const cfgs = cfgRes.ok ? ((await cfgRes.json()) as {
      slug: string; name: string; channels: string | null; scrape_niche: string | null;
      scrape_cities: string | null; scrape_terms: string | null; active: boolean;
    }[]) : [];
    // A configured client with no outbound yet still belongs on the board.
    for (const cfg of cfgs) byClient[cfg.name] ||= blank(cfg.name);
    const cfgByName = Object.fromEntries(cfgs.map((c) => [c.name, c]));

    // Key facts (MRR, status) come from the vault client pages, matched by name.
    const profiles = await clientProfiles();
    const profByName = new Map(profiles.map((p) => [norm(p.name), p]));

    const clients = Object.values(byClient)
      .map((c) => ({
        ...c,
        channels: Array.from(c.channels).sort(),
        byChannel: Object.values(c.byChannel).sort((a, b) => b.total - a.total),
        scraper: cfgByName[c.client] ?? null,
        profile: profByName.get(norm(c.client)) ?? null,
      }))
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

    // Delivery-side activity for whichever client is open.
    const selected = client || clients[0]?.client || "";
    const content = selected
      ? await contentFor(cfgByName[selected]?.slug ?? null, selected)
      : { available: false, source: null, reason: "No client selected.", items: [] };

    return NextResponse.json({ configured: true, clients, items, totals, content });
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

  // Scraper config save — updates the hunting instructions the watcher reads.
  if (action === "config") {
    const { slug, scrape_niche, scrape_cities, scrape_terms, channels, active } = b as {
      slug?: string; scrape_niche?: string; scrape_cities?: string;
      scrape_terms?: string; channels?: string; active?: boolean;
    };
    if (!slug) return NextResponse.json({ ok: false, error: "missing slug" }, { status: 400 });
    const res = await fetch(`${url}/rest/v1/crm_clients?slug=eq.${encodeURIComponent(slug)}`, {
      method: "PATCH",
      headers: { apikey: key, Authorization: `Bearer ${key}`,
                 "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ scrape_niche, scrape_cities, scrape_terms, channels, active }),
    });
    return NextResponse.json({ ok: res.ok });
  }

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
