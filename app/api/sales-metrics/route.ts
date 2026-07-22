import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { execFileSync, spawn } from "child_process";

// ── Sales / outreach metrics ──────────────────────────────────────────────────
// Contract (consumed by the dashboard):
//   { sentToday, queuedToday, sentMonth, queuedMonth, opened, emailStats }
//
// Source of truth is now the DAILY OUTREACH pipeline (daily_outreach.py):
//   - prospects.db          status='emailed' + emailed_at (stored as UTC "YYYY-MM-DD HH:MM:SS")
//   - outreach_logs/daily_count.json  {"YYYY-MM-DD": N} authoritative same-day counter
// The old apollo_outreach.py per-contact logs are no longer counted — they double-counted
// day1/3/7 rows and showed a stale "queued" backlog that confused the dashboard.

const OUTREACH_DIR = "C:\\Users\\wjack\\ghl-cli\\outreach_logs";
const PROSPECTS_DB = "C:\\Users\\wjack\\ghl-cli\\prospects.db";
const DAILY_CAP = 100; // mirrors daily_outreach.py cap

// Query prospects.db via Python stdlib sqlite3 (no node sqlite dependency needed).
// emailed_at is UTC; 'localtime' converts to the machine's timezone for day/month buckets.
function dbCounts(): { sentToday: number; sentMonth: number; eligible: number; ok: boolean } {
  const py = `
import sqlite3, json
conn = sqlite3.connect(r"${PROSPECTS_DB}")
c = conn.cursor()
c.execute("SELECT COUNT(*) FROM prospects WHERE emailed_at IS NOT NULL AND date(emailed_at,'localtime')=date('now','localtime')")
sent_today = c.fetchone()[0]
c.execute("SELECT COUNT(*) FROM prospects WHERE emailed_at IS NOT NULL AND strftime('%Y-%m', emailed_at,'localtime')=strftime('%Y-%m','now','localtime')")
sent_month = c.fetchone()[0]
c.execute("SELECT COUNT(*) FROM prospects WHERE status IN ('new','enriching') AND email IS NOT NULL AND email!='' AND owner_name IS NOT NULL AND owner_name!='' AND owner_name NOT LIKE '%Additional%' AND owner_name NOT LIKE '%Contact%'")
eligible = c.fetchone()[0]
conn.close()
print(json.dumps({"sentToday": sent_today, "sentMonth": sent_month, "eligible": eligible}))
`;
  try {
    const out = execFileSync("python", ["-c", py], { timeout: 10_000 }).toString().trim();
    return { ...JSON.parse(out), ok: true };
  } catch {
    // No local prospects.db / python (e.g. serverless cloud host).
    return { sentToday: 0, sentMonth: 0, eligible: 0, ok: false };
  }
}

// ── Real GHL email open stats ─────────────────────────────────────────────────
// Source of truth: ghl-cli\email_stats_live.py walks EVERY email conversation in
// GHL via the public API and records each outbound email's real status
// (delivered / opened / clicked / failed) — the same per-message signal the GHL
// UI shows. It keeps an incremental cache with a precomputed aggregate that this
// route reads instantly; if the aggregate is older than 10 minutes we kick off a
// detached background refresh so the next load is fresh. No numbers are invented:
// if the cache is missing, emailStats is null and the UI shows a pending state.
const GHL_CLI_DIR = "C:\\Users\\wjack\\ghl-cli";
const EMAIL_STATS_CACHE = path.join(GHL_CLI_DIR, "outreach_logs", "email_stats_cache.json");
const EMAIL_STATS_MAX_AGE_MS = 10 * 60 * 1000;
let refreshInFlight = false;

function readEmailStats(): any | null {
  try {
    const cache = JSON.parse(fs.readFileSync(EMAIL_STATS_CACHE, "utf-8"));
    return cache?.aggregate ?? null;
  } catch {
    return null;
  }
}

function kickBackgroundRefresh() {
  if (refreshInFlight) return;
  refreshInFlight = true;
  try {
    const child = spawn("python", ["email_stats_live.py"], {
      cwd: GHL_CLI_DIR,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.on("exit", () => { refreshInFlight = false; });
    child.on("error", () => { refreshInFlight = false; });
    child.unref();
    // Safety valve: never wedge the flag if exit events are lost.
    setTimeout(() => { refreshInFlight = false; }, 5 * 60 * 1000);
  } catch {
    refreshInFlight = false;
  }
}

export async function GET() {
  const now = new Date();

  // ── Real sends from prospects.db (waves 1/2 + every daily_outreach send) ─────
  const { sentToday: dbSentToday, sentMonth, eligible, ok: dbOk } = dbCounts();

  // Cross-check against the daily counter files (authoritative same-day tally).
  // Supports both formats: new daily_outreach.py {"YYYY-MM-DD": N} and
  // old apollo {"date": "YYYY-MM-DD", "count": N}.
  const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(
    now.getDate()
  ).padStart(2, "0")}`;
  let counterToday = 0;
  try {
    for (const f of fs.readdirSync(OUTREACH_DIR)) {
      if (!f.endsWith("daily_count.json")) continue;
      try {
        const data = JSON.parse(fs.readFileSync(path.join(OUTREACH_DIR, f), "utf-8"));
        if (data?.date === todayStr) counterToday += Number(data.count) || 0;
        else if (typeof data?.[todayStr] === "number") counterToday += data[todayStr];
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
  const sentToday = Math.max(dbSentToday, counterToday);

  // ── Queued ──────────────────────────────────────────────────────────────────
  // queuedToday: what can still go out today = cap headroom, bounded by real eligible queue.
  const queuedToday = Math.min(Math.max(0, DAILY_CAP - sentToday), eligible);
  // queuedMonth: the eligible standing queue (prospects with email + owner name not yet sent).
  const queuedMonth = eligible;

  // ── opened / open rate: real per-message GHL statuses via the stats cache ────
  const emailStats = readEmailStats();
  const updatedAt = emailStats?.updatedAt ? Date.parse(emailStats.updatedAt) : 0;
  if (!updatedAt || Date.now() - updatedAt > EMAIL_STATS_MAX_AGE_MS) {
    kickBackgroundRefresh();
  }
  const opened = emailStats?.totals?.opened ?? 0;

  return NextResponse.json({
    sentToday,
    queuedToday,
    sentMonth,
    queuedMonth,
    opened,
    emailStats,
    // "local-db-unavailable" tells the dashboard these outreach numbers come from a
    // local-only source that is absent on the cloud host (show a placeholder, not zeros-as-truth).
    source: dbOk ? "local-db" : "local-db-unavailable",
  });
}
