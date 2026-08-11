import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import { readVaultFile, isGithubVault, VAULT_PATH, commitVaultFile } from "../../../../lib/vaultSource";
import { readProspectsLive, sendsTodayHonest, parseSnapshotAsOf } from "../../../../lib/liveTruth";

// ───────────────────────────────────────────────────────────────────────────
// THE BOSS — live "Recheck" endpoint (POST).
//
// Re-runs, right now, the subset of the watchdog's checks the server can
// actually verify live, and returns fresh results. It NEVER fabricates: every
// status comes from a live fetch or a fresh re-read of the vault state files.
//
// Scope with an optional { target } in the body:
//   "all" (default) | "urls" | "freshness" | "outreach" | "heartbeats"
//
// Checks:
//   urls        - pull URLs flagged 404/broken out of watchdog.md PROBLEMS and
//                 the health board, fetch each live (follow redirects), report
//                 the current HTTP status. A now-200 URL is RESOLVED (and we
//                 also scan the body for the known build-note leak marker so a
//                 reachable-but-still-broken page never shows a false green).
//   freshness   - re-read business/outreach/health snapshots, recompute age
//                 from updated:/_Last updated_ fields, report fresh vs stale.
//   outreach    - re-read outreach-snapshot for sent-today + ready pool, judge
//                 against thresholds (0 sent after 11am weekday = problem,
//                 pool < 20 = problem).
//   heartbeats  - scheduled-task run state; LOCAL DISK ONLY. On Vercel this
//                 sub-check returns "needs-pc" gracefully.
//
// Writing: if (and only if) running locally with write access, this route may
// update wiki/state/watchdog.md to reflect URL problem blocks that are now
// fully clean (move them to RESOLVED, decrement OVERALL, restamp updated:).
// On Vercel (read-only GitHub vault) it NEVER attempts a write and simply
// returns the fresh results for the UI to overlay. Writability is detected
// safely; a read-only vault never throws.
//
// This route never writes secrets and keeps watchdog.md's format identical to
// what the watchdog-heartbeat task produces.
// ───────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const WATCHDOG_REL = "wiki/state/watchdog.md";
const SCHEDULED_DIR = "C:\\Users\\wjack\\.claude\\scheduled-tasks";

// Only these hosts are ever fetched. Live-client domains + Jack's own OS host.
const ALLOWED_URL_HOSTS = ["jacksonroofingco.com", "renewalhealth.life"];

// Build-note / scaffolding leak markers. If a fetched page body still contains
// ANY of these, it is reachable but NOT fixed — it can never count as a green.
// This is the honesty guard for "2xx AND clean": we scan for the exact Jackson
// leak paragraph plus the generic build-note/placeholder markers it was built
// from. Erring toward "still leaking" is the safe direction — it can only keep
// a page red, never falsely green it.
const BUILD_NOTE_MARKERS: RegExp[] = [
  /image_todo/i, // the literal leaked ledger key
  /NOTE:\s*image_todo/i, // the leaked paragraph opener
  /fetch_images\.py/i, // the leaked build-script reference
  /used-images\.json/i, // the leaked ledger filename
  /\b(TODO|FIXME)\b/, // generic scaffolding placeholders
];
function bodyHasLeak(body: string): boolean {
  return BUILD_NOTE_MARKERS.some((re) => re.test(body));
}
// The scheduled push script that syncs the local vault to the cloud GitHub copy.
const PUSH_VAULT_PS1 = "C:\\Users\\wjack\\ghl-cli\\push_vault.ps1";
const WATCHDOG_ABS = () => path.resolve(VAULT_PATH, WATCHDOG_REL);

// ── redaction: never echo credential-looking strings ───────────────────────
const SECRET_PATTERNS: RegExp[] = [
  /\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/g,
  /\bsk-ant-[A-Za-z0-9_-]{10,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /\bAKIA[A-Z0-9]{16}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAIza[A-Za-z0-9_-]{30,}\b/g,
  /\b(api[_-]?key|token|secret|password|passphrase)\s*[:=]\s*['"]?[A-Za-z0-9_\-./+]{12,}['"]?/gi,
  /\b[A-Fa-f0-9]{40,}\b/g,
];
function redact(s: string): string {
  let out = s;
  for (const re of SECRET_PATTERNS) out = out.replace(re, "[REDACTED]");
  return out;
}

// ── types ──────────────────────────────────────────────────────────────────
type CheckStatus = "ok" | "problem" | "resolved" | "needs-pc";
interface CheckItem {
  label: string;
  status: CheckStatus;
  line: string;
  url?: string | null;
  http?: number | null;
}
interface CheckResult {
  id: string;
  label: string;
  status: CheckStatus;
  line: string;
  items?: CheckItem[];
}

// ── writability detection (safe, never throws) ─────────────────────────────
function vaultWritable(): boolean {
  if (isGithubVault()) return false;
  try {
    fs.accessSync(VAULT_PATH, fs.constants.W_OK);
    const abs = path.resolve(VAULT_PATH, WATCHDOG_REL);
    // Only writable if the file itself exists and is writable.
    fs.accessSync(abs, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

// ── watchdog.md problem-block parsing (block-level, keeps URLs together) ─────
interface ProblemBlock {
  index: number; // 1-based problem number as written
  raw: string; // the exact source lines of this block (for removal)
  text: string; // flattened text
  urls: string[]; // http links inside this block
  flaggedBroken: boolean; // text implies a 404/broken/down/unreachable flag
}

function extractAllowedUrls(text: string): string[] {
  const out: string[] = [];
  for (const m of text.match(/https?:\/\/[^\s|,)\]"'<>]+/g) ?? []) {
    const u = m.replace(/[.,;:>]+$/, "");
    if (!ALLOWED_URL_HOSTS.some((h) => u.includes(h))) continue;
    if (!out.includes(u)) out.push(u);
  }
  return out;
}

// Split the PROBLEMS section into numbered blocks. Returns the section bounds
// so a writer can splice precisely.
function parseProblemBlocks(raw: string): {
  blocks: ProblemBlock[];
  sectionStart: number; // line index of "## PROBLEMS"
  sectionEnd: number; // line index of the next "## " header (exclusive)
  lines: string[];
} {
  const lines = raw.split(/\r?\n/);
  let sectionStart = -1;
  let sectionEnd = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (/^#{1,4}\s*PROBLEMS\b/i.test(lines[i].trim()) && !/OVERALL/i.test(lines[i])) {
      sectionStart = i;
      break;
    }
  }
  const blocks: ProblemBlock[] = [];
  if (sectionStart === -1) return { blocks, sectionStart, sectionEnd, lines };
  for (let i = sectionStart + 1; i < lines.length; i++) {
    if (/^#{1,4}\s/.test(lines[i].trim())) {
      sectionEnd = i;
      break;
    }
  }
  let cur: { index: number; start: number } | null = null;
  const flush = (end: number) => {
    if (!cur) return;
    const blockLines = lines.slice(cur.start, end);
    const text = blockLines.join("\n");
    blocks.push({
      index: cur.index,
      raw: text,
      text,
      urls: extractAllowedUrls(text),
      flaggedBroken: /\b(404|broken|down|unreachable|dead|not found|5\d\d)\b/i.test(text),
    });
    cur = null;
  };
  for (let i = sectionStart + 1; i < sectionEnd; i++) {
    const m = lines[i].match(/^(\d+)\.\s+/);
    if (m) {
      flush(i);
      cur = { index: Number(m[1]), start: i };
    }
  }
  flush(sectionEnd);
  return { blocks, sectionStart, sectionEnd, lines };
}

// ── live URL fetch ──────────────────────────────────────────────────────────
async function fetchUrl(url: string): Promise<{ status: number | null; leak: boolean; err: string | null }> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 12000);
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: ctrl.signal,
      headers: { "User-Agent": "wing-os-boss-recheck/1.0" },
      cache: "no-store",
    });
    let leak = false;
    if (res.ok) {
      try {
        const body = await res.text();
        leak = bodyHasLeak(body);
      } catch {
        /* body unreadable: treat as no leak, status still authoritative */
      }
    }
    clearTimeout(t);
    return { status: res.status, leak, err: null };
  } catch (e: unknown) {
    return { status: null, leak: false, err: e instanceof Error ? e.name : "fetch failed" };
  }
}

// ── check: URL red flags ────────────────────────────────────────────────────
// Returns the check result plus the set of URLs that came back clean-200, so
// the (local-only) writer can clear fully-resolved blocks.
async function checkUrls(watchdogRaw: string | null, healthRaw: string | null): Promise<{
  result: CheckResult;
  cleanUrls: Set<string>;
}> {
  const cleanUrls = new Set<string>();
  const candidates = new Set<string>();

  // From watchdog PROBLEMS blocks: prefer blocks that read like an availability
  // flag, but always include the URLs (a now-200 page is what Jack wants to see
  // flip green). We still content-scan so a reachable-but-broken page stays red.
  if (watchdogRaw) {
    const { blocks } = parseProblemBlocks(watchdogRaw);
    for (const b of blocks) for (const u of b.urls) candidates.add(u);
  }
  // From the health board red-flag lines that carry a real link.
  if (healthRaw) {
    for (const line of healthRaw.split(/\r?\n/)) {
      if (!/\b(404|broken|down|unreachable|dead|not found)\b/i.test(line)) continue;
      for (const u of extractAllowedUrls(line)) candidates.add(u);
    }
  }

  const urls = [...candidates];
  if (urls.length === 0) {
    return {
      result: {
        id: "urls",
        label: "Flagged pages",
        status: "ok",
        line: "No flagged URLs to recheck. Nothing in the report points at a broken page.",
        items: [],
      },
      cleanUrls,
    };
  }

  const items: CheckItem[] = [];
  const results = await Promise.all(urls.map((u) => fetchUrl(u)));
  urls.forEach((u, i) => {
    const r = results[i];
    if (r.status === null) {
      items.push({ label: u, status: "problem", line: `Still unreachable (${r.err}).`, url: u, http: null });
    } else if (r.status >= 400) {
      items.push({ label: u, status: "problem", line: `Still failing, HTTP ${r.status}.`, url: u, http: r.status });
    } else if (r.leak) {
      items.push({
        label: u,
        status: "problem",
        line: `Reachable (HTTP ${r.status}) but still leaking build notes (NOTE: image_todo present).`,
        url: u,
        http: r.status,
      });
    } else {
      cleanUrls.add(u);
      items.push({ label: u, status: "resolved", line: `Now HTTP ${r.status}, clean. Resolved.`, url: u, http: r.status });
    }
  });

  const anyProblem = items.some((i) => i.status === "problem");
  const anyResolved = items.some((i) => i.status === "resolved");
  const status: CheckStatus = anyProblem ? "problem" : anyResolved ? "resolved" : "ok";
  const resolvedN = items.filter((i) => i.status === "resolved").length;
  const problemN = items.filter((i) => i.status === "problem").length;
  const line = anyProblem
    ? `${problemN} of ${items.length} flagged page${items.length === 1 ? "" : "s"} still broken` +
      (resolvedN ? `, ${resolvedN} now resolved.` : ".")
    : `All ${items.length} flagged page${items.length === 1 ? "" : "s"} now return 200. Resolved.`;
  return { result: { id: "urls", label: "Flagged pages", status, line, items }, cleanUrls };
}

// ── age helpers ─────────────────────────────────────────────────────────────
function parseUpdated(raw: string): { updated: string | null; ageHours: number | null } {
  const updated =
    raw.match(/_Last updated:\s*([^_]+)_/)?.[1]?.trim() ??
    raw.match(/^updated:\s*["']?([^"'\r\n]+)["']?\s*$/m)?.[1]?.trim() ??
    null;
  if (!updated) return { updated: null, ageHours: null };
  let d = new Date(updated);
  if (isNaN(d.getTime())) {
    const m = updated.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T\s]+(\d{2}):(\d{2}))?/);
    if (!m) return { updated, ageHours: null };
    d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 12), Number(m[5] ?? 0));
  }
  const ageHours = Math.max(0, (Date.now() - d.getTime()) / 3600000);
  return { updated, ageHours };
}
function ageWords(h: number | null): string {
  if (h === null) return "unknown age";
  if (h < 1) return `${Math.round(h * 60)}m old`;
  if (h < 48) return `${h.toFixed(1)}h old`;
  return `${(h / 24).toFixed(1)}d old`;
}

// ── check: snapshot freshness ───────────────────────────────────────────────
async function checkFreshness(): Promise<CheckResult> {
  const files: { rel: string; label: string; staleH: number }[] = [
    { rel: "wiki/state/business-snapshot.md", label: "business-snapshot", staleH: 24 },
    { rel: "wiki/state/outreach-snapshot.md", label: "outreach-snapshot", staleH: 24 },
    { rel: "wiki/state/health-board.md", label: "health-board", staleH: 24 },
  ];
  const items: CheckItem[] = [];
  for (const f of files) {
    const raw = await readVaultFile(f.rel);
    if (!raw) {
      items.push({ label: f.label, status: "problem", line: "File missing from the vault." });
      continue;
    }
    const { updated, ageHours } = parseUpdated(raw);
    if (ageHours === null) {
      items.push({ label: f.label, status: "problem", line: `No parseable updated timestamp (${updated ?? "none"}).` });
    } else if (ageHours > f.staleH) {
      items.push({ label: f.label, status: "problem", line: `Stale: ${ageWords(ageHours)} (over ${f.staleH}h). Updated ${updated}.` });
    } else {
      items.push({ label: f.label, status: "ok", line: `Fresh: ${ageWords(ageHours)}. Updated ${updated}.` });
    }
  }
  const anyStale = items.some((i) => i.status === "problem");
  const staleN = items.filter((i) => i.status === "problem").length;
  return {
    id: "freshness",
    label: "Data freshness",
    status: anyStale ? "problem" : "ok",
    line: anyStale ? `${staleN} of ${items.length} snapshots stale.` : `All ${items.length} snapshots fresh.`,
    items,
  };
}

// ── check: outreach vitals ──────────────────────────────────────────────────
async function checkOutreach(): Promise<CheckResult> {
  const raw = await readVaultFile("wiki/state/outreach-snapshot.md");
  if (!raw) {
    return { id: "outreach", label: "Outreach vitals", status: "problem", line: "outreach-snapshot.md missing.", items: [] };
  }
  const num = (re: RegExp): number | null => {
    const m = raw.match(re);
    return m ? Number(m[1].replace(/,/g, "")) : null;
  };
  // Sends-today truth: prefer the live prospects.db (local PC). Only fall back
  // to the snapshot when the DB is unreachable — and never let a prior-day
  // snapshot count read as today's (that is the exact bug we are killing).
  const live = await readProspectsLive();
  const st = sendsTodayHonest(live, raw, parseSnapshotAsOf(raw));
  const sentToday = st.value; // number | null, honest (0 on prior-day snapshot)
  const sentSourceLabel = live ? "live from prospects.db" : st.stale ? `snapshot, ${st.display}` : "snapshot";
  // "Ready/armed" pool: prefer an explicit ready/armed/campaign_ready count if
  // the snapshot carries one, else fall back to the new+enriching remaining
  // pool (and say so). The true send-ready count lives in prospects.db (PC).
  const readyExplicit =
    num(/\*\*(?:Ready|Armed|Campaign[_ ]?ready|Send[_ ]?ready)[^:]*:\*\*\s*([\d,]+)/i);
  const remaining = num(/\*\*Remaining[^:]*:\*\*\s*([\d,]+)/i);
  // Live armed count (intent-scored, not emailed) is the truest ready pool.
  const pool = live ? live.armed : (readyExplicit ?? remaining);
  const poolIsExplicit = live ? true : readyExplicit !== null;
  const { ageHours } = parseUpdated(raw);

  const now = new Date();
  const dow = now.getDay(); // 0 Sun .. 6 Sat
  const isWeekday = dow >= 1 && dow <= 5;
  const afterEleven = now.getHours() >= 11;

  const items: CheckItem[] = [];

  // sent-today judgement — from live DB when available, honest snapshot otherwise.
  if (sentToday === null) {
    items.push({ label: "Sent today", status: "problem", line: `Sent-today count unknown (${sentSourceLabel}). Connect the PC to confirm.` });
  } else if (sentToday === 0 && isWeekday && afterEleven) {
    items.push({
      label: "Sent today",
      status: "problem",
      line: live
        ? "0 sent, and it is a weekday past 11am. Confirmed live from prospects.db — the sender is not sending (paused or broken)."
        : `0 sent today (${sentSourceLabel}), a weekday past 11am. Real fault; live DB confirmation needs PC.`,
    });
  } else {
    items.push({
      label: "Sent today",
      status: "ok",
      line: live
        ? `${sentToday} sent today, counted live from prospects.db.`
        : `${sentToday} sent today per the snapshot (${ageWords(ageHours)}).`,
    });
  }

  // pool judgement
  if (pool === null) {
    items.push({ label: "Ready pool", status: "problem", line: "No ready/armed pool figure available." });
  } else if (pool < 20) {
    items.push({
      label: "Ready pool",
      status: "problem",
      line: `Pool is ${pool}, under the 20 line${live ? " (live armed count from prospects.db)" : poolIsExplicit ? "" : " (using new+enriching remaining; true armed count needs PC)"}.`,
    });
  } else {
    items.push({
      label: "Ready pool",
      status: "ok",
      line: `Pool is ${pool}${live ? " (live armed count)" : poolIsExplicit ? "" : " (new+enriching remaining)"}, over the 20 line.`,
    });
  }

  const anyProblem = items.some((i) => i.status === "problem");
  return {
    id: "outreach",
    label: "Outreach vitals",
    status: anyProblem ? "problem" : "ok",
    line: anyProblem ? "Outreach vitals off target." : "Outreach vitals within thresholds.",
    items,
  };
}

// ── check: scheduled-task heartbeats (LOCAL DISK ONLY) ──────────────────────
function checkHeartbeats(cloud: boolean): CheckResult {
  if (cloud) {
    return {
      id: "heartbeats",
      label: "Task heartbeats",
      status: "needs-pc",
      line: "Scheduled-task heartbeats live on Jack's PC disk. Cannot verify from the cloud.",
      items: [],
    };
  }
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(SCHEDULED_DIR, { withFileTypes: true });
  } catch {
    return {
      id: "heartbeats",
      label: "Task heartbeats",
      status: "needs-pc",
      line: "Scheduled-tasks directory not reachable on this host.",
      items: [],
    };
  }
  const items: CheckItem[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    let state: Record<string, unknown> | null = null;
    try {
      for (const f of fs.readdirSync(path.join(SCHEDULED_DIR, e.name))) {
        if (!f.endsWith(".json")) continue;
        try {
          const j = JSON.parse(fs.readFileSync(path.join(SCHEDULED_DIR, e.name, f), "utf-8"));
          if (j && (j.lastRunAt || j.nextRunAt || j.lastRun)) state = j;
        } catch { /* skip malformed */ }
      }
    } catch { /* skip */ }
    if (!state) continue;
    const lastRun = (state.lastRunAt ?? state.lastRun) as string | undefined;
    if (!lastRun) {
      items.push({ label: e.name, status: "ok", line: "Scheduled, no run recorded yet." });
      continue;
    }
    const ageH = Math.max(0, (Date.now() - new Date(lastRun).getTime()) / 3600000);
    // A daily-or-more-frequent task quiet for over 26h reads as a miss.
    if (ageH > 26) {
      items.push({ label: e.name, status: "problem", line: `Last run ${ageWords(ageH)} — looks overdue.` });
    } else {
      items.push({ label: e.name, status: "ok", line: `Last run ${ageWords(ageH)}.` });
    }
  }
  if (items.length === 0) {
    return { id: "heartbeats", label: "Task heartbeats", status: "ok", line: "No task run-state files found on disk yet.", items };
  }
  const anyProblem = items.some((i) => i.status === "problem");
  const problemN = items.filter((i) => i.status === "problem").length;
  return {
    id: "heartbeats",
    label: "Task heartbeats",
    status: anyProblem ? "problem" : "ok",
    line: anyProblem ? `${problemN} task${problemN === 1 ? "" : "s"} look overdue.` : `${items.length} tasks reporting on time.`,
    items,
  };
}

// ── classifier: which PROBLEM blocks did the recheck TRULY verify as fixed ──
// The recheck may only clear a block on a signal that actually tested it. Every
// other block — especially anything needing PC-only state (log.md appends,
// task heartbeats, cron/lastRunAt, code-line fixes) — is left exactly as-is.
//
// Verifiable clears:
//   URL block       -> has allowed-host URLs AND every one came back clean-2xx
//                      (2xx AND no build-note leak in the body).
//   Freshness block -> is purely about snapshot staleness AND every named
//                      snapshot is now fresh. Never cleared if it also mentions
//                      heartbeat/cron/never-run/log.md (that needs the PC).
//   Outreach block  -> the specific outreach dimension it complains about
//                      (sending, or ready-pool >= 20) now reads healthy from a
//                      FRESH outreach snapshot. A stale snapshot never clears it.
interface ResolvedMark {
  index: number;
  bullet: string;
}
// PC-only / deeper-state signals that forbid an automatic clear no matter what.
const PC_ONLY = /\b(log\.md|append|heartbeat|lastRunAt|last run|never run|cron|nextRunAt|STOP_WING|\.py:\d+|flag)\b/i;
const FRESHNESS_HINT = /\b(stale|aging|ages?|\d+(\.\d+)?h old|hours? old|snapshot.*old|keep aging)\b/i;
const SNAPSHOT_NAME = /(business-snapshot|outreach-snapshot|health-board)/i;
const OUTREACH_SENDING_HINT = /\b(sends?|sending|sender|no-?op|emailed today|0 sent)\b/i;
const OUTREACH_POOL_HINT = /\b(pool|send-?ready|campaign[_ ]?ready|armed)\b/i;

function itemStatus(result: CheckResult | null, labelRe: RegExp): CheckStatus | null {
  if (!result) return null;
  const it = (result.items ?? []).find((i) => labelRe.test(i.label));
  return it ? it.status : null;
}

function classifyResolved(
  blocks: ProblemBlock[],
  cleanUrls: Set<string>,
  freshness: CheckResult | null,
  outreach: CheckResult | null,
  outreachSnapshotFresh: boolean
): ResolvedMark[] {
  const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
  const marks: ResolvedMark[] = [];
  for (const b of blocks) {
    // 1) URL blocks — the primary, strongest signal.
    if (b.urls.length > 0) {
      if (b.urls.every((u) => cleanUrls.has(u))) {
        marks.push({
          index: b.index,
          bullet: `- **Cleared by manual recheck ${stamp}.** ${b.urls.join(", ")} now HTTP 200 and clean of build-note leaks.`,
        });
      }
      continue; // URL block that is not all-clean stays a live problem, untouched.
    }
    // Never auto-clear anything that hangs on PC-only / deeper local state.
    if (PC_ONLY.test(b.text)) continue;

    // 2) Freshness-only blocks.
    if (FRESHNESS_HINT.test(b.text) && SNAPSHOT_NAME.test(b.text)) {
      const anyStale = (freshness?.items ?? []).some((i) => i.status === "problem");
      if (freshness && !anyStale) {
        marks.push({
          index: b.index,
          bullet: `- **Cleared by manual recheck ${stamp}.** Named snapshots re-read fresh (within threshold).`,
        });
      }
      continue;
    }

    // 3) Outreach blocks — only on a FRESH outreach snapshot.
    if (outreachSnapshotFresh) {
      if (OUTREACH_SENDING_HINT.test(b.text) && itemStatus(outreach, /sent today/i) === "ok") {
        marks.push({
          index: b.index,
          bullet: `- **Cleared by manual recheck ${stamp}.** Outreach is sending again per a fresh snapshot.`,
        });
        continue;
      }
      if (OUTREACH_POOL_HINT.test(b.text) && itemStatus(outreach, /ready pool/i) === "ok") {
        marks.push({
          index: b.index,
          bullet: `- **Cleared by manual recheck ${stamp}.** Ready pool is back over the 20 line per a fresh snapshot.`,
        });
        continue;
      }
    }
  }
  return marks;
}

// ── writer: move verified-resolved blocks to RESOLVED, renumber, restamp ─────
// Pure text transform (no I/O). Given the resolved marks, removes those PROBLEM
// blocks, renumbers the rest, adds RESOLVED bullets, recomputes OVERALL, and
// restamps updated:. Returns the new file text, or null if nothing changed.
function rewriteWatchdog(raw: string, resolved: ResolvedMark[]): string | null {
  if (resolved.length === 0) return null;
  const { blocks, sectionStart, sectionEnd, lines } = parseProblemBlocks(raw);
  if (sectionStart === -1 || blocks.length === 0) return null;

  const clearIdx = new Set(resolved.map((r) => r.index));
  const clearable = blocks.filter((b) => clearIdx.has(b.index));
  if (clearable.length === 0) return null;
  const keptBlocks = blocks.filter((b) => !clearIdx.has(b.index));

  // Rebuild the PROBLEMS section body with renumbered kept blocks.
  const renumbered: string[] = [];
  keptBlocks.forEach((b, i) => {
    const newNum = i + 1;
    const bl = b.raw.split(/\r?\n/);
    bl[0] = bl[0].replace(/^(\d+)\.\s+/, `${newNum}. `);
    renumbered.push(...bl);
  });

  const before = lines.slice(0, sectionStart + 1); // through "## PROBLEMS"
  const after = lines.slice(sectionEnd); // "## RESOLVED" onward

  const resolvedBullets = resolved.map((r) => r.bullet);
  const afterWithResolved: string[] = [];
  let inserted = false;
  for (const l of after) {
    afterWithResolved.push(l);
    if (!inserted && /^#{1,4}\s*RESOLVED\b/i.test(l.trim())) {
      afterWithResolved.push(...resolvedBullets);
      inserted = true;
    }
  }
  if (!inserted) {
    renumbered.push("", "## RESOLVED", ...resolvedBullets);
  }

  let out = [...before, ...renumbered, "", ...afterWithResolved].join("\n");

  // Recompute OVERALL to match the kept problem count.
  const keptN = keptBlocks.length;
  out = out.replace(
    /(\*\*OVERALL:\s*)(?:PROBLEMS\s*[:\-]?\s*\d+|OK)([^\n]*)/i,
    keptN > 0 ? `$1PROBLEMS: ${keptN}$2` : `$1OK$2`
  );

  // Restamp the frontmatter updated: field to now.
  const iso = new Date().toISOString().replace(/\.\d{3}Z$/, "-05:00");
  out = out.replace(/^(updated:\s*)["']?[^"'\r\n]+["']?\s*$/m, `$1${iso}`);

  // collapse any accidental 3+ blank lines the splice created
  out = out.replace(/\n{3,}/g, "\n\n");
  return redact(out);
}

// ── local push: sync the rewritten vault to the cloud GitHub copy ───────────
// Best-effort. Runs the existing scheduled push script; never throws, never
// logs the command's output (which could echo tokens). Resolves true only on a
// clean exit.
function pushVaultToCloud(): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      execFile(
        "powershell",
        ["-ExecutionPolicy", "Bypass", "-File", PUSH_VAULT_PS1],
        { timeout: 90_000, windowsHide: true },
        (err) => resolve(!err)
      );
    } catch {
      resolve(false);
    }
  });
}

// ── main handler ────────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  let target = "all";
  try {
    const body = await req.json();
    if (body && typeof body.target === "string") target = body.target;
  } catch {
    /* empty body: default to all */
  }
  const valid = new Set(["all", "urls", "freshness", "outreach", "heartbeats"]);
  if (!valid.has(target)) {
    return NextResponse.json({ error: `unknown target '${target}'` }, { status: 400 });
  }

  const cloud = isGithubVault();
  const wantAll = target === "all";

  const [watchdogRaw, healthRaw] = await Promise.all([
    wantAll || target === "urls" ? readVaultFile(WATCHDOG_REL) : Promise.resolve(null),
    wantAll || target === "urls" ? readVaultFile("wiki/state/health-board.md") : Promise.resolve(null),
  ]);

  const checks: CheckResult[] = [];
  let cleanUrls = new Set<string>();

  if (wantAll || target === "urls") {
    const { result, cleanUrls: c } = await checkUrls(watchdogRaw, healthRaw);
    checks.push(result);
    cleanUrls = c;
  }
  let freshnessResult: CheckResult | null = null;
  let outreachResult: CheckResult | null = null;
  if (wantAll || target === "freshness") { freshnessResult = await checkFreshness(); checks.push(freshnessResult); }
  if (wantAll || target === "outreach") { outreachResult = await checkOutreach(); checks.push(outreachResult); }
  if (wantAll || target === "heartbeats") checks.push(checkHeartbeats(cloud));

  // ── Persistence: rewrite watchdog.md honestly, then sync ──────────────────
  // Decide which PROBLEM blocks the recheck TRULY verified, build the rewritten
  // file, and persist it: locally to disk + push to cloud, or on Vercel by
  // committing to the GitHub vault. Never throws; degrades to overlay-only.
  let persisted = false;
  let mode: "local" | "cloud-github" | "none" = "none";
  let pushedToCloud: boolean | null = null;
  let commit: string | null = null;
  let reason: string | null = null;
  let resolvedCount = 0;
  let refetchMission = false;
  let writeNote: string | null = null; // kept for backward-compat with the overlay UI

  if (watchdogRaw) {
    // outreach snapshot freshness gates outreach-block clears (never clear on stale data)
    let outreachSnapshotFresh = false;
    if (outreachResult) {
      outreachSnapshotFresh = itemStatus(freshnessResult, /outreach-snapshot/i) === "ok"
        || (freshnessResult === null && (parseUpdated((await readVaultFile("wiki/state/outreach-snapshot.md")) ?? "").ageHours ?? 999) <= 24);
    }

    const { blocks } = parseProblemBlocks(watchdogRaw);
    const resolvedMarks = classifyResolved(blocks, cleanUrls, freshnessResult, outreachResult, outreachSnapshotFresh);
    resolvedCount = resolvedMarks.length;
    const next = resolvedMarks.length ? rewriteWatchdog(watchdogRaw, resolvedMarks) : null;

    if (next && next !== watchdogRaw) {
      if (cloud) {
        // CLOUD: commit to the GitHub vault via the contents API.
        const res = await commitVaultFile(
          WATCHDOG_REL,
          next,
          `da boss recheck: ${resolvedCount} resolved (manual)`
        );
        if (res.ok) {
          persisted = true; mode = "cloud-github"; commit = res.commit; refetchMission = true;
          writeNote = `Report updated in the cloud vault: ${resolvedCount} moved to RESOLVED.`;
        } else {
          persisted = false; reason = res.reason;
          writeNote = "Live check only, report not updated (cloud write unavailable).";
        }
      } else if (vaultWritable()) {
        // LOCAL: write to disk, then push the vault to the cloud copy.
        try {
          fs.writeFileSync(WATCHDOG_ABS(), next, "utf-8");
          persisted = true; mode = "local"; refetchMission = true;
          pushedToCloud = await pushVaultToCloud();
          writeNote = `Report updated on disk: ${resolvedCount} moved to RESOLVED.`
            + (pushedToCloud ? " Cloud copy synced." : " Cloud sync will catch up on the next scheduled push.");
        } catch {
          persisted = false; reason = "disk write failed"; mode = "none";
          writeNote = "Live check only, report not updated (disk write failed).";
        }
      } else {
        persisted = false; reason = "vault not writable and not cloud-backed";
        writeNote = "Live check only, report not updated - needs PC.";
      }
    } else {
      // Nothing verifiable to clear: overlay-only, and that is honest.
      writeNote = resolvedMarks.length
        ? "No net change to write."
        : "Live check only - nothing verified as newly resolved.";
    }
  }

  // overall roll-up
  const anyProblem = checks.some((c) => c.status === "problem");
  const anyResolved = checks.some((c) => c.status === "resolved");
  const allNeedsPc = checks.length > 0 && checks.every((c) => c.status === "needs-pc");
  const overall: CheckStatus = anyProblem ? "problem" : anyResolved ? "resolved" : allNeedsPc ? "needs-pc" : "ok";

  return NextResponse.json({
    ranAt: new Date().toISOString(),
    target,
    cloud,
    persisted,
    mode,
    pushedToCloud,
    commit,
    reason,
    resolvedCount,
    refetchMission,
    wrote: persisted, // backward-compat
    writeNote,
    overall,
    checks,
  });
}
