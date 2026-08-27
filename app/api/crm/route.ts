import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import { listVaultFiles, readVaultFile } from "@/lib/vaultSource";
import { getRevenueTruth, BASIS_LABEL, type RevenueBasis } from "@/lib/revenue";

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

// ── Pagination ──────────────────────────────────────────────────────────────
// PostgREST caps an unbounded select at 1000 rows and says nothing about it.
// That bug already bit this codebase: Content-Range reported 1036 while the
// select returned 1000, and 36 rows were silently never processed. So ask for
// the authoritative total first, page until we have it, and return BOTH numbers
// so a short read is visible in the payload instead of being discovered later.
export type ScanMeta = {
  contentRangeTotal: number | null;
  rowsRead: number;
  complete: boolean;
  pages: number;
  note: string | null;
};

const PAGE = 500;

async function scanOutbound(columns: string): Promise<{ rows: OutRow[]; meta: ScanMeta }> {
  const head = await sb("outbound?select=id&limit=1", { Prefer: "count=exact", Range: "0-0" });
  const parsed = Number((head.headers.get("content-range") || "").split("/").pop());
  const total = Number.isFinite(parsed) ? parsed : null;
  const rows: OutRow[] = [];
  if (total == null) {
    return { rows, meta: {
      contentRangeTotal: null, rowsRead: 0, complete: false, pages: 0,
      note: "PostgREST returned no Content-Range total for outbound, so the true " +
            "row count is unknown and nothing was scanned. Do not read the empty " +
            "result as an empty table.",
    } };
  }
  let pages = 0;
  for (let offset = 0; offset < total; offset += PAGE) {
    const res = await sb(`outbound?select=${columns}&order=id.asc&offset=${offset}&limit=${PAGE}`);
    pages++;
    if (!res.ok) {
      return { rows, meta: {
        contentRangeTotal: total, rowsRead: rows.length, complete: false, pages,
        note: `Page ${pages} failed with HTTP ${res.status}, so this scan read ` +
              `${rows.length} of ${total} rows. Every count below is a floor.`,
      } };
    }
    const batch = (await res.json()) as OutRow[];
    if (!batch.length) break;
    rows.push(...batch);
  }
  const complete = rows.length === total;
  return { rows, meta: {
    contentRangeTotal: total, rowsRead: rows.length, complete, pages,
    note: complete ? null
      : `Read ${rows.length} rows but Content-Range says outbound holds ${total}. ` +
        `${total - rows.length} rows were NOT scanned, so every per-client count ` +
        `is a floor, not a total.`,
  } };
}

// ── Outbound message shaping ────────────────────────────────────────────────
// Every column the drafters write. Named explicitly so a new column upstream is
// a deliberate change here rather than a silently widened payload.
const OUTBOUND_COLUMNS = [
  "id", "client", "channel", "direction", "recipient", "recipient_handle",
  "recipient_url", "subject", "body", "personalization", "evidence_url",
  "status", "tier", "created_at", "reviewed_at", "sent_at",
] as const;

type OutRow = Record<string, unknown>;

const s = (v: unknown): string | null =>
  typeof v === "string" && v.trim() !== "" ? v.trim() : null;

function filledVal(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === "string") return v.trim() !== "";
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v as object).length > 0;
  return true;
}

// Tiers arrive from three different emitters and mean three different things.
// Flattening them into a coloured dot is how a same-day job ends up sorted
// below a marketing row.
const TIER_MEANING: Record<string, { label: string; meaning: string; rank: number }> = {
  hire:   { label: "HIRE — someone is trying to pay for this work right now",
            meaning: "A live posting from a person asking to hire. Highest value, and it expires. Same-day.",
            rank: 1 },
  event:  { label: "EVENT — a dated cleanout with a deadline",
            meaning: "A dated event whose leftovers have to leave when it ends. Call before the end date.",
            rank: 2 },
  signal: { label: "SIGNAL — a marketing-list row, not a job",
            meaning: "Someone giving away something bulky. Nobody is hiring here. Do not work it like a job.",
            rank: 4 },
  A:      { label: "A — strongest pain evidence",
            meaning: "The prospect publicly exhibits the pain this client removes, scored 55+.",
            rank: 1 },
  B:      { label: "B — real pain evidence, weaker",
            meaning: "Pain evidence exists and is quoted, but scored below the A threshold.",
            rank: 2 },
  C:      { label: "C — a single weak signal",
            meaning: "One low-weight signal (often a funding/launch item). Fit, barely pain.",
            rank: 3 },
  tier1:  { label: "Tier 1 — direct demand",
            meaning: "Someone asking for this service in public.", rank: 1 },
  tier2:  { label: "Tier 2 — indirect signal",
            meaning: "A signal that demand exists, not a request for it.", rank: 3 },
  reply:  { label: "Reply — a response to an existing thread",
            meaning: "A drafted reply into a conversation already underway, not a cold first touch.",
            rank: 2 },
};

export type OutboundEvidence = {
  /** A verbatim quote from the prospect, if the personalization carries one. */
  quote: string | null;
  /** A page reachable in one click. WHICH page depends on sourceKind. */
  sourceUrl: string | null;
  /**
   * "evidence": sourceUrl is the page the claim was actually read from.
   * "recipient_only": no evidence_url was saved, so this is merely the
   * prospect's own page — a starting point for checking, NOT proof of the
   * claim. Collapsing the two would let an unevidenced row borrow the look of
   * an evidenced one.
   */
  sourceKind: "evidence" | "recipient_only" | "none";
  strength: "quoted_with_source" | "quoted_no_source" | "stated_no_quote" | "flagged_unverified" | "none";
  label: string;
  detail: string;
};

function outboundEvidence(r: OutRow): OutboundEvidence {
  const p = s(r.personalization);
  const evidenceUrl = s(r.evidence_url);
  const sourceUrl = evidenceUrl ?? s(r.recipient_url);
  const hasEvidenceUrl = Boolean(evidenceUrl);
  const sourceKind: OutboundEvidence["sourceKind"] =
    evidenceUrl ? "evidence" : sourceUrl ? "recipient_only" : "none";

  if (!p) {
    return {
      quote: null, sourceUrl, sourceKind, strength: "none",
      label: "No personalization recorded",
      detail:
        "This draft carries no record of what it was personalized on, so there is " +
        "nothing to check it against. Read the body before approving — an " +
        "unevidenced claim about a stranger's business is the one thing that must " +
        "never go out.",
    };
  }
  // The drafters flag their own doubts in the personalization text. Those flags
  // are the most important thing on the row and must not be buried in a
  // paragraph the reviewer skims past.
  if (/NEEDS LOCATION CHECK|NEEDS VERIFICATION|unverified/i.test(p)) {
    return {
      quote: null, sourceUrl, sourceKind, strength: "flagged_unverified",
      label: "FLAGGED by the drafter — verify before approving",
      detail:
        `The drafter itself flagged this row as unverified: "${p.slice(0, 240)}". ` +
        `It is not asking for a rubber stamp. Confirm the flagged point by hand ` +
        `first; approving it as-is is how a wrong-region or wrong-company message ` +
        `goes out under Wing's name.`,
    };
  }
  // The verbatim quote is not always in `personalization`. The B2B drafter puts
  // the prospect's own words in the SUBJECT line (`A customer said your product
  // "..."`) and leaves personalization as a category note. Looking only at
  // personalization reported 0 quoted rows on a board full of quoted rows —
  // check both, and say which field the quote was actually read from.
  const fromP = p.match(/[""]([^""]{8,})[""]/);
  const subject = s(r.subject);
  const fromS = subject?.match(/[""]([^""]{8,})[""]/) ?? null;
  const quoted = fromP ?? fromS;
  if (quoted) {
    const where = fromP ? "the personalization note" : "the subject line";
    return {
      quote: quoted[1],
      sourceUrl, sourceKind,
      strength: hasEvidenceUrl ? "quoted_with_source" : "quoted_no_source",
      label: hasEvidenceUrl
        ? "Quoted from the prospect, with the page it came from"
        : "Quoted from the prospect, but the source page was not recorded",
      detail: hasEvidenceUrl
        ? `The message quotes the prospect's own words (read from ${where}) and the ` +
          `page carrying them is one click away. This is the strongest kind of row ` +
          `on the board.`
        : `The message quotes the prospect's own words (read from ${where}), but no ` +
          `evidence_url was saved, so the quote cannot be checked before sending. ` +
          `Verify it or cut it — an unverifiable quote is worse than no quote.`,
    };
  }
  // e.g. "category: balm, no complaint quoted" — the drafter is telling you it
  // had nothing specific to work with.
  const admitsNothing = /no complaint quoted|no pain quoted|no quote|generic/i.test(p);
  return {
    quote: null, sourceUrl, sourceKind,
    strength: "stated_no_quote",
    label: admitsNothing
      ? "Generic — the drafter found nothing specific to say"
      : "Personalized on a stated fact, not a direct quote",
    detail: admitsNothing
      ? `The drafter recorded: "${p.slice(0, 200)}". It had no quoted fact to ` +
        `build on, so this message is close to a template. Expect template ` +
        `results from it.`
      : `Personalized on: "${p.slice(0, 200)}"` +
        (hasEvidenceUrl
          ? ", with a source page attached."
          : ". No source page was recorded, so the claim cannot be checked."),
  };
}

function shapeOutbound(r: OutRow) {
  const tier = s(r.tier);
  const t = tier ? TIER_MEANING[tier] : undefined;
  const status = s(r.status);
  return {
    // ── unchanged keys, same names and meanings as before ──
    id: typeof r.id === "number" ? r.id : Number(r.id ?? 0),
    client: s(r.client),
    channel: s(r.channel),
    recipient: s(r.recipient),
    recipient_url: s(r.recipient_url),
    subject: s(r.subject),
    body: s(r.body),
    personalization: s(r.personalization),
    evidence_url: s(r.evidence_url),
    status,
    tier,
    created_at: s(r.created_at),

    // ── additive ──
    direction: s(r.direction),
    recipientHandle: s(r.recipient_handle),
    reviewedAt: s(r.reviewed_at),
    sentAt: s(r.sent_at),
    tierInfo: t ? { tier, ...t } : tier
      ? { tier, label: `Tier "${tier}"`, rank: 5,
          meaning: `No emitter in this codebase declares a tier called "${tier}", so ` +
                   `what it is worth cannot be stated. Treat it as unranked, not as low.` }
      : null,
    evidence: outboundEvidence(r),
    bodyState: s(r.body)
      ? "written"
      : "MISSING — this row has no message body at all, so there is nothing to " +
        "approve. The drafter created the row and never filled it in.",
    // A draft that has never been looked at, and one that was reviewed and left
    // alone, are different situations that must not render the same.
    review: s(r.reviewed_at)
      ? { state: "REVIEWED", at: s(r.reviewed_at), detail: `Reviewed, and left at "${status}".` }
      : status === "draft"
      ? { state: "NEVER_REVIEWED", at: null,
          detail: "Nobody has looked at this draft yet. It is waiting on a human, " +
                  "not on the pipeline." }
      : { state: "NO_REVIEW_RECORDED", at: null,
          detail: `Status is "${status}" but no reviewed_at was ever written, so ` +
                  `when (or whether) a human made that call is not recorded.` },
  };
}

export type Coverage = {
  column: string; filled: number; rows: number; pct: number;
  verdict: "core" | "common" | "sparse" | "rare" | "empty";
};

function coverageOf(rows: OutRow[]): Coverage[] {
  if (!rows.length) return [];
  const cols = new Set<string>();
  for (const r of rows) for (const k of Object.keys(r)) cols.add(k);
  return [...cols]
    .map((column) => {
      const filled = rows.reduce((n, r) => n + (filledVal(r[column]) ? 1 : 0), 0);
      const pct = Math.round((filled / rows.length) * 1000) / 10;
      const verdict: Coverage["verdict"] =
        pct === 0 ? "empty" : pct < 5 ? "rare" : pct < 25 ? "sparse" : pct < 75 ? "common" : "core";
      return { column, filled, rows: rows.length, pct, verdict };
    })
    .sort((a, b) => b.filled - a.filled);
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

// ── Client profile (revenue + status) ──────────────────────────────────────
// Revenue is NOT computed here. It comes from lib/revenue.ts, the one source of
// truth every surface derives from, so the figure this route shows for a client
// is byte-identical to the one /api/clients, /api/ghl and the mission tiles show.
//
// `mrr` keeps its original meaning and is deliberately narrow: it is ONLY a
// confirmed recurring retainer. A client whose amount is one-time, expected, or
// of unconfirmed recurrence has mrr === null and renders as "not recorded",
// because printing $1,250 under a label that says MRR when nobody has confirmed
// it recurs is precisely the inconsistency this work exists to kill.
// The honest full picture rides alongside in `revenue`.
export type ClientProfile = {
  file: string; name: string; owner: string; industry: string;
  status: string; mrr: number | null; updated: string;
  revenue: {
    amount: number | null;   // null = unknown, never means zero
    basis: RevenueBasis;
    label: string;           // "MRR" | "one-time" | "expected (not yet earned)" | ...
    note: string | null;
    question: string | null;
    countsTowardMrr: boolean;
  };
};
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

async function clientProfiles(): Promise<ClientProfile[]> {
  try {
    const truth = await getRevenueTruth();
    // Vault detail (owner/industry/updated) that the revenue truth does not carry.
    const detail = new Map<string, Record<string, string>>();
    try {
      for (const rel of (await listVaultFiles()).filter(
        (f) => f.startsWith("wiki/clients/") && f.endsWith(".md") &&
               f.split("/").length === 3 && !f.split("/").pop()!.startsWith("_")
      )) {
        const text = await readVaultFile(rel);
        if (!text) continue;
        const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
        const fm: Record<string, string> = { __file: rel };
        if (m) {
          for (const line of m[1].split(/\r?\n/)) {
            const kv = line.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
            if (kv) fm[kv[1].toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, "");
          }
        }
        detail.set(rel.split("/").pop()!.replace(/\.md$/, ""), fm);
      }
    } catch { /* detail is optional; revenue truth still stands */ }

    return truth.allPages.map((c) => {
      const fm = detail.get(c.slug) ?? {};
      return {
        file: fm.__file ?? "",
        name: c.name,
        owner: fm.owner || "",
        industry: fm.industry || "",
        status: c.status,
        mrr: c.basis === "monthly" || c.basis === "term" ? c.amount : null,
        updated: fm.updated || fm.date || "",
        revenue: {
          amount: c.amount,
          basis: c.basis,
          label: BASIS_LABEL[c.basis],
          note: c.note,
          question: c.question,
          countsTowardMrr: c.basis === "monthly" || c.basis === "term",
          term: c.term,
          evidence: c.evidence,
          evidenceBacked: c.evidenceBacked,
        },
      };
    });
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
    // Read via real pagination against the Content-Range total, NOT a single
    // capped select — see scanOutbound for why that distinction is load-bearing.
    const scanned = await scanOutbound(OUTBOUND_COLUMNS.filter((c) => c !== "body").join(","));
    const all = scanned.rows.map((r) => ({
      client: String(r.client ?? ""),
      status: String(r.status ?? ""),
      channel: String(r.channel ?? ""),
    }));
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

    // The rollup pages through the whole table and checks itself against the
    // Content-Range total. If that check failed, the per-client draft counts are
    // a floor, not a number, and the UI must be told so rather than printing a
    // confident total on top of a short read.
    const draftsReason = scanned.meta.complete ? null : scanned.meta.note;

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
      `select=${OUTBOUND_COLUMNS.join(",")}`,
    ].filter(Boolean).join("&");
    const res = await sb(`outbound?${filters}`);
    const rawItems = res.ok ? ((await res.json()) as OutRow[]) : [];
    // Best-evidence first WITHIN the existing newest-first order is wrong — the
    // caller asked for newest. Keep the order the query returned and let the UI
    // sort; the rank is shipped on each row so it can.
    const items = rawItems.map(shapeOutbound);

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

    // What the drafters actually fill in, per column, over the whole table. A
    // column at 0% is a pipe nobody connected; a column at 35% is a field the UI
    // must be prepared to show as absent. Shipping the number is how the board
    // can refuse to draw a panel that would mislead.
    const coverage = coverageOf(scanned.rows);

    // Evidence mix across every drafted message — the honest answer to "how much
    // of this outbound is actually personalized?"
    const shapedAll = scanned.rows.map(shapeOutbound);
    const byStrength: Record<string, number> = {};
    for (const it of shapedAll) {
      byStrength[it.evidence.strength] = (byStrength[it.evidence.strength] ?? 0) + 1;
    }
    // `body` is deliberately excluded from the scan (it is the largest column and
    // the scan exists to count fill rates, not to move text). So the count of
    // body-less rows CANNOT come from the scan — deriving it from rows that never
    // carried the column reported every single row as body-less. It comes from a
    // targeted count instead, which is the only honest way to ask the question.
    const missingBody = await countWhere("body=is.null");
    const withBody = Math.max(0, scanned.meta.contentRangeTotal ?? all.length) - missingBody;
    const evidence = {
      counts: byStrength,
      flaggedUnverified: byStrength.flagged_unverified ?? 0,
      missingBody,
      detail:
        `Of ${shapedAll.length} outbound rows, ` +
        `${byStrength.quoted_with_source ?? 0} quote the prospect AND carry the page ` +
        `the quote came from, ${byStrength.quoted_no_source ?? 0} quote without a ` +
        `checkable source, ${byStrength.stated_no_quote ?? 0} were personalized on a ` +
        `stated fact rather than a quote, ${byStrength.flagged_unverified ?? 0} were ` +
        `flagged unverified by the drafter itself, and ${byStrength.none ?? 0} record ` +
        `no personalization at all. ` +
        (missingBody
          ? `${missingBody} row${missingBody === 1 ? " has" : "s have"} no message body at ` +
            `all — the drafter created the row and never wrote the message, so there is ` +
            `nothing there to approve.`
          : `Every row has a message body.`) +
        (scanned.meta.complete ? "" : ` NOTE: ${scanned.meta.note}`),
    };

    // `body` is not in the scan, so its fill rate is measured directly rather
    // than being left out of the table (a missing row reads as "not collected").
    const totalRows = scanned.meta.contentRangeTotal ?? all.length;
    if (totalRows > 0) {
      const pct = Math.round((withBody / totalRows) * 1000) / 10;
      coverage.push({
        column: "body", filled: withBody, rows: totalRows, pct,
        verdict: pct === 0 ? "empty" : pct < 5 ? "rare" : pct < 25 ? "sparse"
                 : pct < 75 ? "common" : "core",
      });
      coverage.sort((a, b) => b.filled - a.filled);
    }

    return NextResponse.json({
      configured: true, clients, items, totals, content,
      evidence, coverage, scan: scanned.meta,
    });
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
