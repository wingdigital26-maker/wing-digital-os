import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { readVaultFile, isGithubVault, VAULT_PATH } from "../../../../lib/vaultSource";

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

// The literal build-note leak the watchdog flagged on the Jackson pages. If a
// page still contains it, it is reachable but NOT fixed — never a green.
const BUILD_NOTE_MARKER = /NOTE:\s*image_todo/i;

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
        leak = BUILD_NOTE_MARKER.test(body);
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
  const sentToday = num(/\*\*Sent today:\*\*\s*([\d,]+)/i);
  // "Ready/armed" pool: prefer an explicit ready/armed/campaign_ready count if
  // the snapshot carries one, else fall back to the new+enriching remaining
  // pool (and say so). The true send-ready count lives in prospects.db (PC).
  const readyExplicit =
    num(/\*\*(?:Ready|Armed|Campaign[_ ]?ready|Send[_ ]?ready)[^:]*:\*\*\s*([\d,]+)/i);
  const remaining = num(/\*\*Remaining[^:]*:\*\*\s*([\d,]+)/i);
  const pool = readyExplicit ?? remaining;
  const poolIsExplicit = readyExplicit !== null;
  const { ageHours } = parseUpdated(raw);

  const now = new Date();
  const dow = now.getDay(); // 0 Sun .. 6 Sat
  const isWeekday = dow >= 1 && dow <= 5;
  const afterEleven = now.getHours() >= 11;

  const items: CheckItem[] = [];

  // sent-today judgement
  if (sentToday === null) {
    items.push({ label: "Sent today", status: "problem", line: "No sent-today figure in the snapshot." });
  } else if (sentToday === 0 && isWeekday && afterEleven) {
    items.push({
      label: "Sent today",
      status: "problem",
      line: `0 sent, and it is a weekday past 11am. That is a real fault (snapshot is ${ageWords(ageHours)}; live DB confirmation needs PC).`,
    });
  } else {
    items.push({
      label: "Sent today",
      status: "ok",
      line: `${sentToday} sent today per the snapshot (${ageWords(ageHours)}).`,
    });
  }

  // pool judgement
  if (pool === null) {
    items.push({ label: "Ready pool", status: "problem", line: "No ready/armed pool figure in the snapshot." });
  } else if (pool < 20) {
    items.push({
      label: "Ready pool",
      status: "problem",
      line: `Pool is ${pool}, under the 20 line${poolIsExplicit ? "" : " (using new+enriching remaining; true armed count needs PC)"}.`,
    });
  } else {
    items.push({
      label: "Ready pool",
      status: "ok",
      line: `Pool is ${pool}${poolIsExplicit ? "" : " (new+enriching remaining)"}, over the 20 line.`,
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

// ── local writer: clear fully-clean URL problem blocks ──────────────────────
// Only runs locally with write access. Removes any PROBLEMS block whose URLs
// ALL came back clean-200, adds a RESOLVED bullet, renumbers the remaining
// problems, decrements the OVERALL count, and restamps updated:. Returns the
// new file text, or null if nothing to do / anything looked unsafe.
function rewriteWatchdog(raw: string, cleanUrls: Set<string>): string | null {
  if (cleanUrls.size === 0) return null;
  const { blocks, sectionStart, sectionEnd, lines } = parseProblemBlocks(raw);
  if (sectionStart === -1 || blocks.length === 0) return null;

  const clearable = blocks.filter(
    (b) => b.urls.length > 0 && b.flaggedBroken && b.urls.every((u) => cleanUrls.has(u))
  );
  if (clearable.length === 0) return null;

  const clearIdx = new Set(clearable.map((b) => b.index));
  const keptBlocks = blocks.filter((b) => !clearIdx.has(b.index));

  // Rebuild the PROBLEMS section body with renumbered kept blocks.
  const renumbered: string[] = [];
  keptBlocks.forEach((b, i) => {
    const newNum = i + 1;
    // replace only the leading "N. " of the block's first line
    const bl = b.raw.split(/\r?\n/);
    bl[0] = bl[0].replace(/^(\d+)\.\s+/, `${newNum}. `);
    renumbered.push(...bl);
  });

  const before = lines.slice(0, sectionStart + 1); // through "## PROBLEMS"
  const after = lines.slice(sectionEnd); // "## RESOLVED" onward

  // Insert resolved bullets at the top of the RESOLVED section.
  const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
  const resolvedBullets = clearable.map(
    (b) => `- **Cleared by manual recheck ${stamp}.** ${b.urls.join(", ")} now HTTP 200 and clean.`
  );
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
    // No RESOLVED section present: append one just after PROBLEMS.
    renumbered.push("", "## RESOLVED", ...resolvedBullets);
  }

  let out = [...before, ...renumbered, "", ...afterWithResolved].join("\n");

  // Decrement / recompute the OVERALL count to match kept problems.
  const keptN = keptBlocks.length;
  out = out.replace(
    /(\*\*OVERALL:\s*)(?:PROBLEMS\s*[:\-]?\s*\d+|OK)([^\n]*)/i,
    keptN > 0 ? `$1PROBLEMS: ${keptN}$2` : `$1OK$2`
  );

  // Restamp the frontmatter updated: field.
  const iso = new Date().toISOString().replace(/\.\d{3}Z$/, "-05:00");
  out = out.replace(/^(updated:\s*)["']?[^"'\r\n]+["']?\s*$/m, `$1${iso}`);

  // collapse any accidental 3+ blank lines the splice created
  out = out.replace(/\n{3,}/g, "\n\n");
  return redact(out);
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
  if (wantAll || target === "freshness") checks.push(await checkFreshness());
  if (wantAll || target === "outreach") checks.push(await checkOutreach());
  if (wantAll || target === "heartbeats") checks.push(checkHeartbeats(cloud));

  // Optional local write-back for fully-clean URL problem blocks.
  let wrote = false;
  let writeNote: string | null = null;
  if ((wantAll || target === "urls") && cleanUrls.size > 0) {
    if (vaultWritable() && watchdogRaw) {
      try {
        const next = rewriteWatchdog(watchdogRaw, cleanUrls);
        if (next && next !== watchdogRaw) {
          const abs = path.resolve(VAULT_PATH, WATCHDOG_REL);
          fs.writeFileSync(abs, next, "utf-8");
          wrote = true;
          writeNote = "watchdog.md updated: resolved URL blocks moved to RESOLVED.";
        } else {
          writeNote = "Nothing to write: no fully-clean flagged block to clear.";
        }
      } catch {
        // Never throw on a write failure; the fresh results still return.
        writeNote = "Write skipped: vault not writable at write time.";
      }
    } else {
      writeNote = cloud
        ? "Read-only cloud vault: results shown live, file not modified."
        : "Vault not writable: results shown live, file not modified.";
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
    wrote,
    writeNote,
    overall,
    checks,
  });
}
