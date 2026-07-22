import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";

// ───────────────────────────────────────────────────────────────────────────
// Agent Activity API
//
// Gives Jack real visibility into his 4 "keeper" agents: whether they ran, when,
// and what they produced. Every field below is read from actual files on disk —
// no placeholders. Missing data degrades gracefully to status "never run".
//
// Data sources (all real, discovered on disk):
//   dispatch   → C:\Users\wjack\ghl-cli\agent_runs\dispatch-*.json  (rich run records
//                written by agent_log.py) + agent_runs\logs\dispatch-*.log (tail)
//   outreach   → C:\Users\wjack\ghl-cli\outreach_logs\daily_outreach_YYYY-MM-DD.log
//                (bracketed-timestamp lines with QA PASS/FAIL results)
//   chronicler → C:\Users\wjack\ghl-cli\chronicler_state.json (watermark, if advanced)
//                falling back to the mtime of the vault inbox it appends to
//   prospector → agent_runs\prospector-*.json / prospector logs (none yet → never run)
// ───────────────────────────────────────────────────────────────────────────

const GHL = "C:\\Users\\wjack\\ghl-cli";
const RUNS_DIR = path.join(GHL, "agent_runs");
const LOGS_DIR = path.join(RUNS_DIR, "logs");
const OUTREACH_DIR = path.join(GHL, "outreach_logs");
const CHRONICLER_STATE = path.join(GHL, "chronicler_state.json");
const VAULT_INBOX =
  "C:\\Users\\wjack\\OneDrive\\Documentos\\Obsidian 2.0\\Jacks Ai Brain 2.0\\wiki\\chronicler-inbox.md";

type RunDot = { ok: boolean; time: string; status: "ok" | "fail" | "skipped"; summary: string };
type Agent = {
  key: string;
  name: string;
  icon: string;
  description: string;
  cadence: string; // human label of expected rhythm
  lastRun: string | null; // ISO
  status: "ran today" | "ran this week" | "idle" | "never run";
  lastResult: string;
  nextExpected: string; // human label
  nextExpectedAt: string | null; // ISO
  history: RunDot[]; // most-recent-last, up to 5
};

async function safeReadDir(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch {
    return [];
  }
}
async function safeRead(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, "utf-8");
  } catch {
    return null;
  }
}
async function safeStatMtime(file: string): Promise<Date | null> {
  try {
    return (await fs.stat(file)).mtime;
  } catch {
    return null;
  }
}

// classify recency into the four requested buckets
function classify(lastRun: Date | null): Agent["status"] {
  if (!lastRun) return "never run";
  const now = new Date();
  if (lastRun.toDateString() === now.toDateString()) return "ran today";
  const days = (now.getTime() - lastRun.getTime()) / 86400000;
  if (days <= 7) return "ran this week";
  return "idle";
}

// ── Next-expected helpers ───────────────────────────────────────────────────
function nextDailyAt(hour: number, minute: number): Date {
  const d = new Date();
  d.setSeconds(0, 0);
  d.setHours(hour, minute, 0, 0);
  if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
  return d;
}
function nextTopOfHour(): Date {
  const d = new Date();
  d.setHours(d.getHours() + 1, 0, 0, 0);
  return d;
}
function nextOutreach(): Date {
  const now = new Date();
  const h = now.getHours();
  // send window 8am–8pm, every 15 min
  if (h >= 8 && h < 20) {
    const d = new Date(now);
    d.setSeconds(0, 0);
    d.setMinutes(Math.floor(now.getMinutes() / 15) * 15 + 15, 0, 0);
    if (d.getHours() < 20) return d;
  }
  // otherwise first slot tomorrow (or later today) at 8:00am
  const d = new Date(now);
  d.setSeconds(0, 0);
  d.setHours(8, 0, 0, 0);
  if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
  return d;
}
function nextSunday(hour: number): Date {
  const d = new Date();
  d.setSeconds(0, 0);
  d.setHours(hour, 0, 0, 0);
  const daysUntilSun = (7 - d.getDay()) % 7 || 7;
  d.setDate(d.getDate() + daysUntilSun);
  return d;
}
function fmtNext(d: Date): string {
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const tmrw = new Date(now);
  tmrw.setDate(now.getDate() + 1);
  const isTmrw = d.toDateString() === tmrw.toDateString();
  const t = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  if (sameDay) return `Today ${t}`;
  if (isTmrw) return `Tomorrow ${t}`;
  return d.toLocaleDateString("en-US", { weekday: "short" }) + " " + t;
}

// ── dispatch ────────────────────────────────────────────────────────────────
async function buildDispatch(): Promise<Agent> {
  const files = (await safeReadDir(RUNS_DIR))
    .filter((f) => /^dispatch-\d.*\.json$/.test(f))
    .sort();
  const records: any[] = [];
  for (const f of files) {
    const raw = await safeRead(path.join(RUNS_DIR, f));
    if (!raw) continue;
    try {
      records.push(JSON.parse(raw));
    } catch {
      /* skip malformed */
    }
  }
  records.sort((a, b) => (a.time > b.time ? 1 : -1)); // oldest → newest
  const last = records[records.length - 1] ?? null;
  const lastRun = last ? new Date(last.time) : null;
  let lastResult = last?.summary ?? "";
  if (!lastResult) {
    // fall back to the tail of the newest log file
    const logs = (await safeReadDir(LOGS_DIR)).filter((f) => f.startsWith("dispatch-") && f.endsWith(".log")).sort();
    const tail = logs.length ? await safeRead(path.join(LOGS_DIR, logs[logs.length - 1])) : null;
    if (tail) lastResult = tail.trim().split(/\r?\n/).filter(Boolean).slice(-1)[0] ?? "";
  }
  const history: RunDot[] = records.slice(-10).map((r) => ({
    ok: r.status === "ok",
    time: r.time,
    status: r.status === "ok" ? "ok" : r.status === "needs-jack" ? "skipped" : "fail",
    summary: r.summary ?? "No summary recorded",
  }));
  history.reverse(); // most recent first
  const at = nextDailyAt(6, 30);
  return {
    key: "dispatch",
    name: "Dispatch",
    icon: "🌅",
    description: "Morning briefing — orders your daily dial list at 6:30am",
    cadence: "Daily · 6:30am",
    lastRun: lastRun ? lastRun.toISOString() : null,
    status: classify(lastRun),
    lastResult: lastResult || "No result recorded",
    nextExpected: fmtNext(at),
    nextExpectedAt: at.toISOString(),
    history,
  };
}

// ── outreach ────────────────────────────────────────────────────────────────
async function buildOutreach(): Promise<Agent> {
  const logs = (await safeReadDir(OUTREACH_DIR))
    .filter((f) => /^daily_outreach_\d{4}-\d{2}-\d{2}\.log$/.test(f))
    .sort();
  const newest = logs.length ? logs[logs.length - 1] : null;
  let lastRun: Date | null = null;
  let lastResult = "";
  const history: RunDot[] = [];
  if (newest) {
    const raw = (await safeRead(path.join(OUTREACH_DIR, newest))) ?? "";
    const lines = raw.split(/\r?\n/).filter(Boolean);
    // group into runs: each run begins with a "starting" line
    type Run = { start: string; ok: boolean | null; skipped: boolean; lines: string[] };
    const runs: Run[] = [];
    for (const line of lines) {
      const m = line.match(/^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\]\s*(.*)$/);
      if (!m) continue;
      const [, ts, body] = m;
      if (/starting/i.test(body)) runs.push({ start: ts, ok: null, skipped: false, lines: [body] });
      else if (runs.length) {
        const cur = runs[runs.length - 1];
        cur.lines.push(body);
        if (/QA PASS|complete|sent/i.test(body)) cur.ok = cur.ok === false ? false : true;
        if (/QA FAIL|error|failed/i.test(body)) cur.ok = false;
        if (/outside send window|daily cap|skip/i.test(body)) cur.skipped = true;
      }
    }
    // last real timestamp seen = last run
    const lastTs = lines
      .map((l) => l.match(/^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\]/))
      .filter(Boolean)
      .map((m) => (m as RegExpMatchArray)[1])
      .slice(-1)[0];
    if (lastTs) lastRun = new Date(lastTs.replace(" ", "T"));
    // last result = the meaningful tail of the file
    const tailLines = lines.slice(-3).map((l) => l.replace(/^\[[^\]]+\]\s*/, "").trim());
    lastResult = tailLines.reverse().find((t) => t.length > 0) ?? "";
    // enrich with PASS/FAIL of the last run
    const lastRunObj = runs[runs.length - 1];
    if (lastRunObj) {
      const verdict = lastRunObj.ok === false ? "QA failed" : lastRunObj.ok ? "QA passed" : "started";
      lastResult = `${verdict} — ${lastResult}`;
    }
    for (const r of runs.slice(-10)) {
      const dry = /dry_run=True/i.test(r.lines[0] ?? "");
      const status: RunDot["status"] = r.skipped ? "skipped" : r.ok === false ? "fail" : "ok";
      // full run summary = the meaningful body lines of this run block
      const body = r.lines
        .map((l) => l.trim())
        .filter(Boolean)
        .join("\n");
      const verdict = r.skipped ? "Skipped" : r.ok === false ? "QA failed" : dry ? "Dry run — QA passed" : "Sent";
      history.push({
        ok: r.ok !== false,
        time: r.start.replace(" ", "T"),
        status,
        summary: `${verdict}\n${body}`,
      });
    }
    history.reverse(); // most recent first
  }
  const at = nextOutreach();
  return {
    key: "outreach",
    name: "Outreach",
    icon: "✉️",
    description: "Cold email sender — fires every 15 min, 8am–8pm",
    cadence: "Every 15 min · 8am–8pm",
    lastRun: lastRun ? lastRun.toISOString() : null,
    status: classify(lastRun),
    lastResult: lastResult || "No runs logged today",
    nextExpected: fmtNext(at),
    nextExpectedAt: at.toISOString(),
    history,
  };
}

// ── chronicler ──────────────────────────────────────────────────────────────
async function buildChronicler(): Promise<Agent> {
  let lastRun: Date | null = null;
  let lastResult = "";
  const history: RunDot[] = [];

  // 0) prefer real run records written by agent_log.py (richest per-run summaries)
  const jsonFiles = (await safeReadDir(RUNS_DIR)).filter((f) => /^chronicler-\d.*\.json$/.test(f)).sort();
  const jsonRecords: any[] = [];
  for (const f of jsonFiles) {
    const raw = await safeRead(path.join(RUNS_DIR, f));
    if (!raw) continue;
    try {
      jsonRecords.push(JSON.parse(raw));
    } catch {
      /* skip */
    }
  }
  jsonRecords.sort((a, b) => (a.time > b.time ? 1 : -1));
  if (jsonRecords.length) {
    const last = jsonRecords[jsonRecords.length - 1];
    lastRun = new Date(last.time);
    lastResult = last.summary ?? "";
    for (const r of jsonRecords.slice(-10)) {
      history.push({
        ok: r.status === "ok",
        time: r.time,
        status: r.status === "ok" ? "ok" : r.status === "needs-jack" ? "skipped" : "fail",
        summary: r.summary ?? "No summary recorded",
      });
    }
    history.reverse();
  }

  // 1) prefer the watermark state file if it has been advanced (non-dry runs)
  const stateRaw = await safeRead(CHRONICLER_STATE);
  if (stateRaw && stateRaw.trim()) {
    try {
      const st = JSON.parse(stateRaw);
      if (!lastRun && st.generated) lastRun = new Date(st.generated);
      const wm = st.watermarks ? Object.values(st.watermarks) : [];
      if (!lastRun && wm.length) {
        const newest = (wm as string[]).sort().slice(-1)[0];
        if (newest) lastRun = new Date(newest);
      }
    } catch {
      /* ignore */
    }
  }
  // 2) fall back to the mtime of the inbox it appends to (its real output)
  const inboxMtime = await safeStatMtime(VAULT_INBOX);
  if (!lastRun && inboxMtime) lastRun = inboxMtime;
  // last result = the newest dated section header in the inbox
  const inbox = await safeRead(VAULT_INBOX);
  if (inbox && !lastResult) {
    const headers = inbox.split(/\r?\n/).filter((l) => /^#{1,3}\s/.test(l));
    const lastHeader = headers[headers.length - 1]?.replace(/^#+\s*/, "").trim();
    if (lastHeader) lastResult = `Vault inbox updated — latest: ${lastHeader}`;
    else lastResult = "Vault inbox digest appended";
  }
  const at = nextTopOfHour();
  return {
    key: "chronicler",
    name: "Chronicler",
    icon: "📖",
    description: "Hourly vault updater — digests new chats into your brain",
    cadence: "Hourly",
    lastRun: lastRun ? lastRun.toISOString() : null,
    status: classify(lastRun),
    lastResult: lastResult || "No inbox activity found",
    nextExpected: fmtNext(at),
    nextExpectedAt: at.toISOString(),
    history: history.length
      ? history
      : lastRun
      ? [{ ok: true, time: lastRun.toISOString(), status: "ok" as const, summary: lastResult || "Vault inbox digest appended" }]
      : [],
  };
}

// ── prospector ──────────────────────────────────────────────────────────────
async function buildProspector(): Promise<Agent> {
  // look for run records or logs the same way the others log
  const jsonRuns = (await safeReadDir(RUNS_DIR)).filter((f) => /^prospector-\d.*\.json$/.test(f)).sort();
  const logRuns = (await safeReadDir(LOGS_DIR)).filter((f) => f.startsWith("prospector-") && f.endsWith(".log")).sort();
  let lastRun: Date | null = null;
  let lastResult = "";
  const history: RunDot[] = [];
  for (const f of jsonRuns) {
    const raw = await safeRead(path.join(RUNS_DIR, f));
    if (!raw) continue;
    try {
      const r = JSON.parse(raw);
      history.push({
        ok: r.status === "ok",
        time: r.time,
        status: r.status === "ok" ? "ok" : r.status === "needs-jack" ? "skipped" : "fail",
        summary: r.summary ?? "No summary recorded",
      });
      lastRun = new Date(r.time);
      lastResult = r.summary ?? lastResult;
    } catch {
      /* skip */
    }
  }
  if (!lastRun && logRuns.length) {
    const m = await safeStatMtime(path.join(LOGS_DIR, logRuns[logRuns.length - 1]));
    if (m) lastRun = m;
  }
  const at = nextSunday(20);
  return {
    key: "prospector",
    name: "Prospector",
    icon: "🔭",
    description: "Weekly lead scout — scans new DFW cities for roofing prospects",
    cadence: "Weekly · Sunday night",
    lastRun: lastRun ? lastRun.toISOString() : null,
    status: classify(lastRun),
    lastResult: lastRun ? lastResult || "Ran — no summary recorded" : "Has not run yet — no logs on disk",
    nextExpected: fmtNext(at),
    nextExpectedAt: at.toISOString(),
    history: history.slice(-10).reverse(),
  };
}

// ── Day-by-day history ──────────────────────────────────────────────────────
// Groups everything the keeper agents actually produced, one row per agent per
// day, most-recent day first. Sources: agent_runs\*.json run records, the dated
// agent_runs\logs\*.log files, and the per-day outreach logs.
const KEEPER_KEYS = new Set(["dispatch", "prospector", "outreach", "chronicler"]);
const AGENT_ICON: Record<string, string> = {
  dispatch: "🌅",
  prospector: "🔭",
  outreach: "✉️",
  chronicler: "📖",
};

type DayAgentRow = { agent: string; icon: string; runs: number; result: string; ok: boolean };
type DaySection = { date: string; label: string; rows: DayAgentRow[] };

function dayKey(d: Date): string {
  return d.toLocaleDateString("en-CA"); // YYYY-MM-DD, local
}
function dayLabel(key: string): string {
  const d = new Date(key + "T12:00:00");
  const today = dayKey(new Date());
  const yest = dayKey(new Date(Date.now() - 86400000));
  if (key === today) return "Today";
  if (key === yest) return "Yesterday";
  return d.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
}

async function buildHistory(): Promise<DaySection[]> {
  // map: dayKey -> agent -> {runs, lastResult, ok}
  const map = new Map<string, Map<string, { runs: number; result: string; ok: boolean }>>();
  const bump = (day: string, agent: string, result: string, ok: boolean) => {
    if (!map.has(day)) map.set(day, new Map());
    const inner = map.get(day)!;
    const cur = inner.get(agent) ?? { runs: 0, result: "", ok: true };
    cur.runs += 1;
    if (result) cur.result = result; // keep latest-seen result of the day
    cur.ok = cur.ok && ok;
    inner.set(agent, cur);
  };

  // 1) agent_runs\*.json  (dispatch, prospector, and any keeper that logs via agent_log.py)
  for (const f of await safeReadDir(RUNS_DIR)) {
    const m = f.match(/^([a-z]+)-\d.*\.json$/);
    if (!m || !KEEPER_KEYS.has(m[1])) continue;
    const raw = await safeRead(path.join(RUNS_DIR, f));
    if (!raw) continue;
    try {
      const r = JSON.parse(raw);
      if (!r.time) continue;
      bump(dayKey(new Date(r.time)), m[1], r.summary ?? "", r.status === "ok");
    } catch {
      /* skip */
    }
  }

  // 2) agent_runs\logs\*.log  (dated per-run logs; pick up agents without json)
  for (const f of await safeReadDir(LOGS_DIR)) {
    const m = f.match(/^([a-z]+)-(\d{8})-\d{6}\.log$/);
    if (!m || !KEEPER_KEYS.has(m[1])) continue;
    // if json already recorded this agent+day, don't double count
    const key = `${m[2].slice(0, 4)}-${m[2].slice(4, 6)}-${m[2].slice(6, 8)}`;
    if (map.get(key)?.has(m[1])) continue;
    const raw = await safeRead(path.join(LOGS_DIR, f));
    const line = raw ? raw.trim().split(/\r?\n/).filter(Boolean).slice(-1)[0]?.replace(/[*#]/g, "").trim() : "";
    bump(key, m[1], line ?? "", true);
  }

  // 3) outreach per-day logs → one row per day with run count + emails/QA summary
  for (const f of await safeReadDir(OUTREACH_DIR)) {
    const m = f.match(/^daily_outreach_(\d{4}-\d{2}-\d{2})\.log$/);
    if (!m) continue;
    const raw = (await safeRead(path.join(OUTREACH_DIR, f))) ?? "";
    const lines = raw.split(/\r?\n/).filter(Boolean);
    const starts = lines.filter((l) => /starting/i.test(l)).length;
    const passes = lines.filter((l) => /QA PASS/i.test(l)).length;
    const fails = lines.filter((l) => /QA FAIL/i.test(l)).length;
    const sent = lines.filter((l) => /sent for real|✅ sent| SENT /i.test(l)).length;
    if (starts === 0 && lines.length === 0) continue;
    const day = map.get(m[1]) ?? new Map();
    const summary = sent > 0
      ? `${sent} email${sent === 1 ? "" : "s"} sent · ${starts} runs`
      : `${starts} runs · ${passes} QA pass, ${fails} QA fail (dry-run)`;
    day.set("outreach", { runs: starts || 1, result: summary, ok: fails === 0 || passes > 0 });
    map.set(m[1], day);
  }

  const sections: DaySection[] = [];
  for (const [date, inner] of map) {
    const rows: DayAgentRow[] = [];
    for (const [agent, v] of inner) {
      rows.push({ agent, icon: AGENT_ICON[agent] ?? "🤖", runs: v.runs, result: v.result || "ran", ok: v.ok });
    }
    rows.sort((a, b) => a.agent.localeCompare(b.agent));
    sections.push({ date, label: dayLabel(date), rows });
  }
  sections.sort((a, b) => (a.date < b.date ? 1 : -1)); // newest day first
  return sections;
}

export async function GET() {
  try {
    const [agents, history] = await Promise.all([
      Promise.all([buildDispatch(), buildProspector(), buildOutreach(), buildChronicler()]),
      buildHistory(),
    ]);
    return NextResponse.json({ agents, history, generatedAt: new Date().toISOString() });
  } catch (e: any) {
    return NextResponse.json({ agents: [], error: e?.message ?? "agent-activity read failed" });
  }
}
