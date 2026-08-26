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

// ── Scraper health: did this client's watcher actually run, and do anything? ─
// Two sources, both of which may not exist yet:
//   crm_clients.last_scraped_at — when the watcher last touched this client
//   watch_runs                  — per-run counters (queries/results/kept)
// Neither is assumed. A missing column or a missing table is reported as
// missing, never as a zero, because "ran and found nothing" and "we cannot
// tell whether it ran" are completely different answers.
export type WatchRun = {
  client: string; queries: number | null; results: number | null;
  kept: number | null; rejected: number | null; throttled: number | null;
  ran_at: string | null;
};
export type WatchRuns = {
  available: boolean;
  reason: string | null;
  byKey: Record<string, WatchRun>;
};

async function watchRuns(): Promise<WatchRuns> {
  const none = (reason: string): WatchRuns => ({ available: false, reason, byKey: {} });
  let res: Response;
  try {
    res = await sb("watch_runs?select=client,queries,results,kept,rejected,throttled,ran_at" +
                   "&order=ran_at.desc&limit=500");
  } catch (e) {
    return none(`Could not reach the run log: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (res.status === 404 || res.status === 400) {
    const body = await res.text().catch(() => "");
    if (body.includes("PGRST205") || body.includes("PGRST204") || res.status === 404) {
      return none(
        "The watch_runs table does not exist in the Sonar database yet, so per-run counters " +
        "(queries issued, results returned, drafts kept) have never been recorded for anyone. " +
        "This is a missing pipe, not a quiet week."
      );
    }
    return none(`The run log returned HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  if (!res.ok) return none(`The run log returned HTTP ${res.status}.`);

  const rows = (await res.json()) as WatchRun[];
  // Newest run per client wins; the query already ordered newest-first.
  const byKey: Record<string, WatchRun> = {};
  for (const r of rows) {
    const k = norm(String(r.client ?? ""));
    if (k && !(k in byKey)) byKey[k] = r;
  }
  return {
    available: true,
    reason: rows.length ? null : "The watch_runs table exists but has no rows in it yet.",
    byKey,
  };
}

export type WatchState =
  | "NOT_CONFIGURED" | "UNKNOWN" | "NEVER_RUN" | "RAN_FOUND_NOTHING" | "WORKING";

export type Watch = {
  state: WatchState;
  /** Why this state, in Jack's words. Always populated. */
  detail: string;
  lastRanAt: string | null;
  /** false when crm_clients has no last_scraped_at column at all. */
  lastRanTracked: boolean;
  run: WatchRun | null;
  runsAvailable: boolean;
  runsReason: string | null;
  draftsWaiting: number | null;
  draftsReason: string | null;
};

type Cfg = Record<string, unknown> & { slug?: string; name?: string; active?: boolean };

// "Hero's Junk Removal's scraper" but "Northcomm Technologies' scraper".
const poss = (n: string) => (n.endsWith("s") ? `${n}'` : `${n}'s`);

function isConfigured(cfg: Cfg | null): boolean {
  if (!cfg) return false;
  const filled = (v: unknown) => typeof v === "string" && v.trim() !== "";
  // A watcher needs something to hunt for and somewhere to hunt. Terms alone
  // will not produce a query, and channels alone has nothing to search with.
  return (filled(cfg.scrape_niche) || filled(cfg.scrape_terms)) && filled(cfg.scrape_cities);
}

function buildWatch(
  cfg: Cfg | null, runs: WatchRuns, lastRanTracked: boolean,
  drafts: number | null, draftsReason: string | null, name: string
): Watch {
  const key = norm(String(cfg?.name ?? name));
  const bySlug = cfg?.slug ? runs.byKey[norm(String(cfg.slug))] : undefined;
  const run = runs.byKey[key] ?? bySlug ?? null;
  const lastRaw = lastRanTracked ? (cfg?.last_scraped_at as string | null | undefined) ?? null : null;
  const lastRanAt = typeof lastRaw === "string" && lastRaw ? lastRaw : null;

  const base = {
    lastRanAt, lastRanTracked, run,
    runsAvailable: runs.available, runsReason: runs.reason,
    draftsWaiting: drafts, draftsReason,
  };

  if (!isConfigured(cfg)) {
    return {
      ...base, state: "NOT_CONFIGURED",
      detail: !cfg
        ? `${name} has no row in crm_clients, so no watcher is pointed at them at all. ` +
          `Nothing has ever been searched for on their behalf.`
        : `${poss(name)} scraper has no niche/keywords or no cities set, so every run it takes part in ` +
          `is incapable of producing a single result. Fill the fields in below and the next run will hunt.`,
    };
  }

  if (!lastRanTracked && !runs.available) {
    return {
      ...base, state: "UNKNOWN",
      detail:
        `Nothing in the Sonar database records when ${name}'s watcher last ran. crm_clients has no ` +
        `last_scraped_at column and ${runs.reason ?? "there is no run log"} — so the OS genuinely ` +
        `cannot tell you whether this scraper is working. Do not read the empty panel as healthy.`,
    };
  }

  if (!lastRanAt && !run) {
    return {
      ...base, state: "NEVER_RUN",
      detail:
        `${name} is configured, but no run has ever been recorded against them. Either the watcher ` +
        `has not executed since run tracking was installed, or it is skipping this client.`,
    };
  }

  const results = run?.results ?? null;
  const kept = run?.kept ?? null;
  if (run && results === 0) {
    // Zero results is two different stories. Zero QUERIES means the watcher
    // never actually searched — it counted this client and moved on, which is
    // a broken run, not a quiet one. Do not blur the two together.
    const searched = run.queries == null || run.queries > 0;
    return {
      ...base, state: "RAN_FOUND_NOTHING",
      detail: searched
        ? `The watcher ran and searched for ${name}, but every query came back empty — ` +
          `${run.queries ?? "an unrecorded number of"} queries, 0 results. The scraper executed; ` +
          `it just found nobody. Repeated empty runs usually mean the search terms are too narrow ` +
          `or the source is blocking us.`
        : `The watcher ran and logged ${name}, but issued ZERO queries for them — so it never ` +
          `actually searched. Finding nothing was guaranteed before it started. This is a broken ` +
          `run, not a quiet one: check that the watcher is reading this client's cities and ` +
          `keywords, and that it is not being skipped or rate-limited.`,
    };
  }
  if (run && (results ?? 0) > 0) {
    return {
      ...base, state: "WORKING",
      detail:
        `${run.queries ?? "?"} queries returned ${results} result${results === 1 ? "" : "s"}, ` +
        `${kept ?? "an unrecorded number"} kept as drafts.`,
    };
  }
  // Timestamp exists but no counters for it.
  return {
    ...base, state: "RAN_FOUND_NOTHING",
    detail:
      `${poss(name)} last_scraped_at says a watcher touched them, but no run counters exist for that ` +
      `run (${runs.reason ?? "no matching watch_runs row"}), so how many queries it issued and ` +
      `what it returned is unknown. Nothing was kept.`,
  };
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
    // select=* rather than a column list: a concurrent migration is adding
    // last_scraped_at, and naming a column that does not exist yet would make
    // PostgREST 400 the whole request. Read whatever is there and detect it.
    const cfgRes = await sb("crm_clients?select=*");
    const cfgs = cfgRes.ok ? ((await cfgRes.json()) as Cfg[]) : [];
    // Only true if the column genuinely exists on the returned rows.
    const lastRanTracked = cfgs.some((c) => "last_scraped_at" in c);
    // A configured client with no outbound yet still belongs on the board.
    for (const cfg of cfgs) {
      const n = String(cfg.name ?? "");
      if (n) byClient[n] ||= blank(n);
    }
    const cfgByName: Record<string, Cfg> =
      Object.fromEntries(cfgs.filter((c) => c.name).map((c) => [String(c.name), c]));

    // Per-run counters for every client, from the run log (may not exist yet).
    const runs = await watchRuns();

    // Key facts (MRR, status) come from the vault client pages, matched by name.
    const profiles = await clientProfiles();
    const profByName = new Map(profiles.map((p) => [norm(p.name), p]));

    // The rollup is drawn from one capped page of `outbound`. If that cap was
    // hit, the per-client draft counts are a floor, not a number, and the UI
    // must be told so rather than printing a confident total.
    const ROLLUP_CAP = 5000;
    const truncated = all.length >= ROLLUP_CAP;
    const draftsReason = truncated
      ? `Counted from the newest ${ROLLUP_CAP} outbound rows, which is all this query reads — ` +
        `older drafts for this client are not included.`
      : null;

    const clients = Object.values(byClient)
      .map((c) => {
        const cfg = cfgByName[c.client] ?? null;
        return {
          ...c,
          channels: Array.from(c.channels).sort(),
          byChannel: Object.values(c.byChannel).sort((a, b) => b.total - a.total),
          // Narrow projection: exactly the fields the scraper editor writes back.
          scraper: cfg
            ? {
                slug: String(cfg.slug ?? ""), name: String(cfg.name ?? ""),
                channels: (cfg.channels as string | null) ?? null,
                scrape_niche: (cfg.scrape_niche as string | null) ?? null,
                scrape_cities: (cfg.scrape_cities as string | null) ?? null,
                scrape_terms: (cfg.scrape_terms as string | null) ?? null,
                active: Boolean(cfg.active),
              }
            : null,
          watch: buildWatch(cfg, runs, lastRanTracked, c.draft, draftsReason, c.client),
          profile: profByName.get(norm(c.client)) ?? null,
        };
      })
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
      ? await contentFor((cfgByName[selected]?.slug as string | undefined) ?? null, selected)
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
