import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import { readVaultFile, isGithubVault, VAULT_PATH, commitVaultFile } from "../../../../lib/vaultSource";
import { readOutreachLive, sendsTodayHonest, parseSnapshotAsOf } from "../../../../lib/liveTruth";
import { EXPECTED_HEARTBEATS, inPcWindow } from "../../../../lib/watchdogExpected";

// ───────────────────────────────────────────────────────────────────────────
// WHAT JACK READS (2026-09-04 rewrite of the result shape)
//
// The response now carries three plain lists on top of the legacy `checks`:
//   problems      real failures verified live just now. Each one links to the
//                 thing that is broken. This is the ONLY list that counts.
//   couldNotCheck checks that cannot run in this environment (the cloud has no
//                 PC disk, no prospects.db, no Windows task scheduler). Never a
//                 problem, never a green: a one-line reason plus the last result
//                 the PC reported through its heartbeat, when there is one.
//   fine          everything that ran and came back clean, with what was
//                 measured, so Jack can see the check is actually working.
//
// Before this rewrite the UI summed "problem" statuses across checks and then
// printed the write-back note "Live check only, report not updated - needs
// PC" under it, which read as if "live check only" were the problem. It was
// never a check; it only said the vault file was not rewritten.
// ───────────────────────────────────────────────────────────────────────────

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

// Public sites the cloud verifies from anywhere: the OS itself plus every
// active client site. Same list as .github/workflows/watchdog.yml (keep the two
// in step; a dropped client comes off both the day they leave). WATCHDOG_SITES
// (comma-separated URLs) overrides without a code change.
const DEFAULT_SITES = [
  "https://wing-digital-os.vercel.app/manifest.json",
  "https://herosjunkremovaltx.com",
  "https://renewalhealth.life",
];
function siteList(): string[] {
  const env = (process.env.WATCHDOG_SITES ?? "").split(",").map((s) => s.trim()).filter((s) => /^https?:\/\//.test(s));
  return env.length ? env : DEFAULT_SITES;
}
function hostOf(u: string): string {
  try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return u; }
}
// Only these hosts are ever fetched for flagged-page rechecks: the site list
// hosts. Nothing in a vault file can make this route fetch an arbitrary URL.
const ALLOWED_URL_HOSTS = (): string[] => siteList().map(hostOf);
// Where the cloud jobs live, for the self-check link.
const ACTIONS_URL = process.env.OS_ACTIONS_URL || "https://github.com/wingdigital26-maker/wing-digital-os/actions";

// Build-note / scaffolding leak markers. If a fetched page body still contains
// ANY of these, it is reachable but NOT fixed — it can never count as a green.
// This is the honesty guard for "2xx AND clean": we scan for the exact leak
// paragraph a past build shipped plus the generic build-note/placeholder
// markers it was built from. Erring toward "still leaking" is the safe direction — it can only keep
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

// LOCAL ground-truth probe: the SAME script the hardened watchdog SKILL runs.
// Prints current-state KEY=VALUE facts so the recheck can resolve/keep each
// PROBLEM against reality instead of re-reading yesterday's report.
const WATCHDOG_PROBE_PY = "C:\\Users\\wjack\\ghl-cli\\watchdog_probe.py";
const GHL_CLI_DIR = "C:\\Users\\wjack\\ghl-cli";
// Thresholds mirrored from watchdog-heartbeat/SKILL.md so the route agrees with
// the scheduled watchdog to the letter.
const POOL_FLOOR = 20; // ELIGIBLE_POOL below this = "nothing to send / pool low"
const CADENCE_WINDOW_DAYS = 4; // 2 blogs/week; stale only past this window

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

// ── Findings: the plain-English result ─────────────────────────────────────
// link forms: an absolute URL, an OS path ("/automations/runs"), or
// "view:<tab>" for a tab of the home screen (crm, email, text, calendar,
// knowledge, agent). The UI turns view: links into a tab switch.
export interface Finding {
  id: string;
  title: string; // one plain sentence
  detail: string; // what was measured, with the numbers and the time
  link: string | null;
  linkLabel?: string;
}
interface Findings {
  problems: Finding[];
  couldNotCheck: Finding[];
  fine: Finding[];
}
function emptyFindings(): Findings {
  return { problems: [], couldNotCheck: [], fine: [] };
}
function merge(into: Findings, from: Findings): void {
  into.problems.push(...from.problems);
  into.couldNotCheck.push(...from.couldNotCheck);
  into.fine.push(...from.fine);
}
const nowClock = (): string =>
  new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/Chicago" });
function isoAgo(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}
function minutesAgo(iso: string): number {
  return Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
}
function agoWords(iso: string | null | undefined): string {
  if (!iso) return "never";
  const m = minutesAgo(iso);
  if (m < 60) return `${m} min ago`;
  if (m < 48 * 60) return `${Math.round(m / 60)}h ago`;
  return `${Math.round(m / 1440)}d ago`;
}

// ── Supabase GET that tells us WHY it failed (sbSelect hides that) ──────────
// [] from a failed request must never read as "no problems", so every check
// below goes through this and treats a non-OK answer as "could not check".
interface SbAnswer<T> { ok: boolean; status: number | null; rows: T[]; err: string | null }
async function restGet<T>(base: string | undefined, key: string | undefined, pathAndQuery: string): Promise<SbAnswer<T>> {
  if (!base || !key) return { ok: false, status: null, rows: [], err: "not configured on this host" };
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10000);
    const res = await fetch(`${base}/rest/v1/${pathAndQuery}`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
      cache: "no-store",
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (!res.ok) {
      try { await res.text(); } catch { /* ignore */ }
      return { ok: false, status: res.status, rows: [], err: `HTTP ${res.status}` };
    }
    const rows = (await res.json()) as T[];
    return { ok: true, status: res.status, rows: Array.isArray(rows) ? rows : [], err: null };
  } catch (e: unknown) {
    return { ok: false, status: null, rows: [], err: e instanceof Error ? e.name : "fetch failed" };
  }
}
const osGet = <T,>(q: string) => restGet<T>(process.env.OS_SUPABASE_URL, process.env.OS_SUPABASE_SERVICE_KEY, q);
const sonarGet = <T,>(q: string) => restGet<T>(process.env.SONAR_SUPABASE_URL, process.env.SONAR_SUPABASE_SERVICE_KEY, q);

// ── (a) public sites: 200 AND a real page ───────────────────────────────────
// A 200 with a "Not found" title, an empty body, or (for the OS manifest) a
// body that is not the manifest is a soft failure and counts as down.
const SOFT_404 = /\b(404|not found|page not found|access denied|forbidden|untitled|error)\b/i;
async function checkSites(urls: string[]): Promise<Findings> {
  const out = emptyFindings();
  const results = await Promise.all(urls.map(async (u) => {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 15000);
      const res = await fetch(u, { redirect: "follow", signal: ctrl.signal, cache: "no-store", headers: { "User-Agent": "wing-os-boss-recheck/1.0" } });
      const body = await res.text().catch(() => "");
      clearTimeout(t);
      return { u, status: res.status, body, err: null as string | null };
    } catch (e: unknown) {
      return { u, status: null as number | null, body: "", err: e instanceof Error ? e.name : "fetch failed" };
    }
  }));
  for (const r of results) {
    const host = hostOf(r.u);
    const id = `site:${host}${r.u.endsWith("manifest.json") ? ":manifest" : ""}`;
    if (r.status === null) {
      out.problems.push({ id, title: `${host} is unreachable`, detail: `Fetch failed (${r.err}) at ${nowClock()}.`, link: r.u, linkLabel: "Open the site" });
      continue;
    }
    if (r.status >= 400) {
      let isHome = true;
      try { const u = new URL(r.u); isHome = u.pathname === "/" || u.pathname === ""; } catch { /* keep */ }
      out.problems.push({
        id,
        title: isHome ? `${host} is down: HTTP ${r.status}` : `A page on ${host} returns HTTP ${r.status}`,
        detail: `Fetched ${r.u} live at ${nowClock()} and got HTTP ${r.status}.`,
        link: r.u, linkLabel: "Open the page",
      });
      continue;
    }
    if (r.u.endsWith("manifest.json")) {
      let name: string | null = null;
      try { name = String((JSON.parse(r.body) as { name?: string }).name ?? "") || null; } catch { /* not json */ }
      if (!name) {
        out.problems.push({ id, title: `${host} answered but not with the OS manifest`, detail: `HTTP ${r.status} but the body is not the app manifest. The OS may be serving an error page.`, link: r.u, linkLabel: "Open" });
      } else {
        out.fine.push({ id, title: `OS app (${host}) is up`, detail: `HTTP ${r.status}, manifest name "${name}", checked ${nowClock()}.`, link: r.u });
      }
      continue;
    }
    const title = (r.body.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").replace(/\s+/g, " ").trim();
    if (!title) {
      out.problems.push({ id, title: `${host} loads but has no page title`, detail: `HTTP ${r.status}, ${r.body.length} bytes, no <title>. Looks like a broken or placeholder page.`, link: r.u, linkLabel: "Open the site" });
    } else if (SOFT_404.test(title)) {
      out.problems.push({ id, title: `${host} is showing an error page`, detail: `HTTP ${r.status} but the title reads "${title.slice(0, 80)}".`, link: r.u, linkLabel: "Open the site" });
    } else if (r.body.length < 500) {
      out.problems.push({ id, title: `${host} is nearly empty`, detail: `HTTP ${r.status}, title "${title.slice(0, 60)}", only ${r.body.length} bytes of HTML.`, link: r.u, linkLabel: "Open the site" });
    } else if (bodyHasLeak(r.body)) {
      out.problems.push({ id, title: `${host} is leaking build notes`, detail: `HTTP ${r.status} but the page body still contains build scaffolding text.`, link: r.u, linkLabel: "Open the site" });
    } else {
      out.fine.push({ id, title: `${host} is up`, detail: `HTTP ${r.status}, title "${title.slice(0, 70)}", checked ${nowClock()}.`, link: r.u });
    }
  }
  return out;
}

// ── (b) + (i) agent heartbeats vs their cadence, error reports, cloud jobs ──
interface Beat { agent: string; status: string; message: string | null; last_beat: string }
interface HeartbeatOutcome extends Findings {
  pcLastResult: string | null; // what the PC's own Da Boss last reported, for the could-not-check lines
  configured: boolean;
}
async function checkHeartbeats(): Promise<HeartbeatOutcome> {
  const out: HeartbeatOutcome = { ...emptyFindings(), pcLastResult: null, configured: true };
  const ans = await osGet<Beat>("agent_heartbeats?select=agent,status,message,last_beat&order=last_beat.desc&limit=100");
  if (!ans.ok) {
    out.configured = false;
    out.couldNotCheck.push({ id: "heartbeats", title: "Agent heartbeats", detail: `Could not read agent_heartbeats (${ans.err}).`, link: "/mission" });
    return out;
  }
  const byAgent = new Map(ans.rows.map((b) => [b.agent, b]));
  const inWindow = inPcWindow();

  const local = byAgent.get("local-watchdog");
  if (local) {
    const first = (local.message ?? "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    const count = local.message?.match(/PROBLEMS\s*\((\d+)\)/i)?.[1] ?? null;
    out.pcLastResult = `${local.status}${count ? `, ${count} problem${count === "1" ? "" : "s"}` : ""} at ${agoWords(local.last_beat)}`;
    if (local.status === "error" && count) {
      const items = first.filter((l) => /^\d+\.\s/.test(l)).slice(0, 5).map((l) => l.replace(/^\d+\.\s*/, ""));
      out.problems.push({
        id: "pc:da-boss",
        title: `Da Boss on the PC found ${count} problem${count === "1" ? "" : "s"}`,
        detail: `Reported ${agoWords(local.last_beat)}: ${items.join(" | ").slice(0, 400)}`,
        link: "/mission",
        linkLabel: "Open Mission Control",
      });
    }
  }

  for (const exp of EXPECTED_HEARTBEATS) {
    const b = byAgent.get(exp.agent);
    const id = `heartbeat:${exp.agent}`;
    if (!b) {
      if (exp.agent === "pc-alive") {
        out.problems.push({ id, title: "PC is offline: no heartbeat has ever arrived", detail: "The local agent fleet cannot run without it.", link: "/mission" });
      } else {
        out.couldNotCheck.push({ id, title: `${exp.label} has never reported`, detail: "No heartbeat row yet, so there is nothing to judge.", link: "/mission" });
      }
      continue;
    }
    if (b.status === "disabled") {
      out.fine.push({ id, title: `${exp.label} is switched off on purpose`, detail: `Marked disabled ${agoWords(b.last_beat)}. Not judged.`, link: "/mission" });
      continue;
    }
    const ageMin = minutesAgo(b.last_beat);
    if (exp.windowed && !inWindow) {
      out.fine.push({ id, title: `${exp.label}: outside the PC hours, not judged`, detail: `Last beat ${agoWords(b.last_beat)}. Only judged 6am-10pm Central.`, link: "/mission" });
      continue;
    }
    if (ageMin > exp.staleMin) {
      out.problems.push({
        id,
        title: exp.agent === "pc-alive" ? "PC is offline" : `${exp.label} has gone silent`,
        detail: `Last heartbeat ${agoWords(b.last_beat)}; allowed ${exp.staleMin >= 120 ? `${Math.round(exp.staleMin / 60)}h` : `${exp.staleMin} min`}.`,
        link: "/mission",
        linkLabel: "Open Mission Control",
      });
    } else {
      out.fine.push({ id, title: `${exp.label} is on time`, detail: `Last heartbeat ${agoWords(b.last_beat)} (allowed ${exp.staleMin >= 120 ? `${Math.round(exp.staleMin / 60)}h` : `${exp.staleMin} min`}).`, link: "/mission" });
    }
  }

  // Any agent that reported an error is a real, verified problem (the agent said so).
  for (const b of ans.rows) {
    if (b.status !== "error" || b.agent === "local-watchdog" || b.agent === "cloud-jobs") continue;
    const msg = (b.message ?? "No detail given.").split(/\r?\n/)[0].slice(0, 220);
    out.problems.push({ id: `error:${b.agent}`, title: `${b.agent} reported an error`, detail: `${msg} (reported ${agoWords(b.last_beat)})`, link: "/mission", linkLabel: "Open Mission Control" });
  }

  // (i) the GitHub Actions cloud jobs' own self-check heartbeat.
  const cj = byAgent.get("cloud-jobs");
  if (!cj) {
    out.couldNotCheck.push({ id: "cloud-jobs", title: "Cloud jobs self-check has never reported", detail: "The watchdog workflow's self-check step has not written its heartbeat row yet.", link: ACTIONS_URL, linkLabel: "Open GitHub Actions" });
  } else if (cj.status === "error") {
    const linkInMsg = cj.message?.match(/https?:\/\/\S+/)?.[0] ?? ACTIONS_URL;
    out.problems.push({ id: "cloud-jobs", title: "A cloud job is failing", detail: `${(cj.message ?? "").replace(/https?:\/\/\S+/g, "").trim().slice(0, 300)} (reported ${agoWords(cj.last_beat)})`, link: linkInMsg, linkLabel: "Open GitHub Actions" });
  } else if (minutesAgo(cj.last_beat) > 200) {
    out.problems.push({ id: "cloud-jobs", title: "Cloud jobs self-check has gone quiet", detail: `Last self-check ${agoWords(cj.last_beat)}; it should run every 30 minutes.`, link: ACTIONS_URL, linkLabel: "Open GitHub Actions" });
  } else {
    out.fine.push({ id: "cloud-jobs", title: "Cloud jobs are healthy", detail: `${(cj.message ?? "ok").replace(/https?:\/\/\S+/g, "").trim().slice(0, 160)} (checked ${agoWords(cj.last_beat)})`, link: ACTIONS_URL });
  }
  const su = byAgent.get("site-uptime");
  if (su) {
    out.fine.push({ id: "site-uptime:cron", title: "Cloud uptime patrol is running", detail: `Last patrol ${agoWords(su.last_beat)}: ${(su.message ?? "").slice(0, 120)}`, link: ACTIONS_URL });
  }
  return out;
}

// ── (c) database reachability ───────────────────────────────────────────────
async function checkDatabases(): Promise<Findings> {
  const out = emptyFindings();
  const os = await osGet<{ id: unknown }>("crm_stages?select=id&limit=1");
  if (!process.env.OS_SUPABASE_URL) {
    out.couldNotCheck.push({ id: "db:os", title: "OS database", detail: "OS_SUPABASE_URL is not set on this host.", link: "view:crm" });
  } else if (os.ok) {
    out.fine.push({ id: "db:os", title: "OS database is reachable", detail: `crm_stages answered HTTP ${os.status} at ${nowClock()}.`, link: "view:crm" });
  } else {
    out.problems.push({ id: "db:os", title: "OS database is not answering", detail: `crm_stages select failed (${os.err}) at ${nowClock()}. The CRM, calendar and automations all read from it.`, link: "view:crm", linkLabel: "Open the CRM" });
  }
  const sonar = await sonarGet<{ id: unknown }>("outbound?select=id&limit=1");
  if (!process.env.SONAR_SUPABASE_URL) {
    out.couldNotCheck.push({ id: "db:sonar", title: "Sonar database", detail: "SONAR_SUPABASE_URL is not set on this host.", link: "view:email" });
  } else if (sonar.ok) {
    out.fine.push({ id: "db:sonar", title: "Sonar database is reachable", detail: `outbound answered HTTP ${sonar.status} at ${nowClock()}.`, link: "view:email" });
  } else {
    out.problems.push({ id: "db:sonar", title: "Sonar database is not answering", detail: `outbound select failed (${sonar.err}) at ${nowClock()}. The send queue and client roster live there.`, link: "view:email", linkLabel: "Open the Email tab" });
  }
  return out;
}

// ── (d) + (e) automations engine ────────────────────────────────────────────
async function checkAutomations(): Promise<Findings> {
  const out = emptyFindings();
  const RUNS = "/automations/runs";
  const backlog = await osGet<{ id: number; type: string; created_at: string }>(
    `events?select=id,type,created_at&processed_at=is.null&created_at=lt.${encodeURIComponent(isoAgo(30 * 60000))}&order=created_at.asc&limit=50`
  );
  const stuck = await osGet<{ id: number; started_at: string }>(
    `workflow_runs?select=id,started_at&status=eq.running&started_at=lt.${encodeURIComponent(isoAgo(10 * 60000))}&limit=50`
  );
  const failed = await osGet<{ id: number; error: string | null; started_at: string }>(
    `workflow_runs?select=id,error,started_at&status=eq.failed&started_at=gte.${encodeURIComponent(isoAgo(24 * 3600000))}&order=started_at.desc&limit=50`
  );
  if (!backlog.ok || !stuck.ok) {
    out.couldNotCheck.push({ id: "automations:cron", title: "Automations catch-up", detail: `Could not read events/workflow_runs (${backlog.err ?? stuck.err}).`, link: RUNS });
  } else if (backlog.rows.length > 0) {
    const oldest = backlog.rows[0];
    out.problems.push({
      id: "automations:cron",
      title: `${backlog.rows.length} automation event${backlog.rows.length === 1 ? "" : "s"} waiting over 30 minutes`,
      detail: `Oldest is a "${oldest.type}" event from ${agoWords(oldest.created_at)}. The catch-up cron should clear these every 30 min, so it is not running or not finishing.`,
      link: RUNS, linkLabel: "Open the runs board",
    });
  } else if (stuck.rows.length > 0) {
    out.problems.push({ id: "automations:cron", title: `${stuck.rows.length} automation run${stuck.rows.length === 1 ? "" : "s"} stuck in "running"`, detail: `Started over 10 minutes ago and never finished; oldest ${agoWords(stuck.rows[0].started_at)}.`, link: RUNS, linkLabel: "Open the runs board" });
  } else {
    out.fine.push({ id: "automations:cron", title: "Automations are keeping up", detail: `No events waiting over 30 min and no runs stuck, checked ${nowClock()}.`, link: RUNS });
  }
  if (!failed.ok) {
    out.couldNotCheck.push({ id: "automations:failed", title: "Failed automation runs", detail: `Could not read workflow_runs (${failed.err}).`, link: RUNS });
  } else if (failed.rows.length > 0) {
    const first = failed.rows[0];
    out.problems.push({
      id: "automations:failed",
      title: `${failed.rows.length} automation run${failed.rows.length === 1 ? "" : "s"} failed in the last 24 hours`,
      detail: `Latest ${agoWords(first.started_at)}: ${(first.error ?? "no error text").slice(0, 160)}`,
      link: RUNS, linkLabel: "Open the runs board",
    });
  } else {
    out.fine.push({ id: "automations:failed", title: "No automation runs failed in the last 24 hours", detail: `workflow_runs status=failed since ${isoAgo(24 * 3600000).slice(0, 16).replace("T", " ")} UTC: 0 rows.`, link: RUNS });
  }
  return out;
}

// ── (f) texts that did not get through ──────────────────────────────────────
async function checkSms(): Promise<Findings> {
  const out = emptyFindings();
  const ans = await osGet<{ id: number; status: string; error: string | null; created_at: string }>(
    `messages?select=id,status,error,created_at&channel=eq.sms&status=in.(failed,undelivered)&created_at=gte.${encodeURIComponent(isoAgo(24 * 3600000))}&order=created_at.desc&limit=50`
  );
  if (!ans.ok) {
    out.couldNotCheck.push({ id: "sms:failed", title: "Text delivery", detail: `Could not read the messages ledger (${ans.err}).`, link: "view:text" });
  } else if (ans.rows.length > 0) {
    const f = ans.rows[0];
    out.problems.push({
      id: "sms:failed",
      title: `${ans.rows.length} text${ans.rows.length === 1 ? "" : "s"} failed to deliver in the last 24 hours`,
      detail: `Latest ${agoWords(f.created_at)} is "${f.status}"${f.error ? `: ${f.error.slice(0, 140)}` : ""}.`,
      link: "view:text", linkLabel: "Open the Text tab",
    });
  } else {
    out.fine.push({ id: "sms:failed", title: "Every text in the last 24 hours got through", detail: "messages channel=sms status failed/undelivered: 0 rows.", link: "view:text" });
  }
  return out;
}

// ── (g) bookings in the next 24 hours ───────────────────────────────────────
async function checkBookings(): Promise<Findings> {
  const out = emptyFindings();
  const now = new Date().toISOString();
  const ans = await osGet<{ id: string; name: string | null; status: string; starts_at: string; assigned_to: string | null }>(
    `bookings?select=id,name,status,starts_at,assigned_to&starts_at=gte.${encodeURIComponent(now)}&starts_at=lte.${encodeURIComponent(new Date(Date.now() + 24 * 3600000).toISOString())}&order=starts_at.asc&limit=100`
  );
  if (!ans.ok) {
    out.couldNotCheck.push({ id: "bookings:next24h", title: "Upcoming bookings", detail: `Could not read bookings (${ans.err}).`, link: "view:calendar" });
    return out;
  }
  const cancelled = ans.rows.filter((b) => /cancel/i.test(b.status));
  const unassigned = ans.rows.filter((b) => !/cancel/i.test(b.status) && !(b.assigned_to ?? "").trim());
  const when = (b: { starts_at: string }) => new Date(b.starts_at).toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit", timeZone: "America/Chicago" });
  if (unassigned.length > 0) {
    out.problems.push({
      id: "bookings:unassigned",
      title: `${unassigned.length} booking${unassigned.length === 1 ? "" : "s"} in the next 24 hours ${unassigned.length === 1 ? "has" : "have"} nobody assigned`,
      detail: `First: ${unassigned[0].name ?? "unnamed"} at ${when(unassigned[0])}.`,
      link: "view:calendar", linkLabel: "Open the calendar",
    });
  }
  if (cancelled.length > 0) {
    out.problems.push({
      id: "bookings:cancelled",
      title: `${cancelled.length} booking${cancelled.length === 1 ? "" : "s"} in the next 24 hours ${cancelled.length === 1 ? "is" : "are"} cancelled`,
      detail: `First: ${cancelled[0].name ?? "unnamed"} at ${when(cancelled[0])}. The slot is open again.`,
      link: "view:calendar", linkLabel: "Open the calendar",
    });
  }
  if (unassigned.length === 0 && cancelled.length === 0) {
    out.fine.push({ id: "bookings:next24h", title: `Next 24 hours of bookings look right (${ans.rows.length} booked)`, detail: ans.rows.length ? `All assigned, none cancelled; first at ${when(ans.rows[0])}.` : "No bookings in the window.", link: "view:calendar" });
  }
  return out;
}

// ── (h) the outbound send lane (Sonar project) ──────────────────────────────
async function checkOutbound(): Promise<Findings> {
  const out = emptyFindings();
  const since = encodeURIComponent(isoAgo(24 * 3600000));
  const ans = await sonarGet<{ id: string; recipient: string | null; last_send_error: string | null; last_send_attempt_at: string | null }>(
    `outbound?select=id,recipient,last_send_error,last_send_attempt_at&status=eq.failed&last_send_attempt_at=gte.${since}&order=last_send_attempt_at.desc&limit=50`
  );
  if (!ans.ok) {
    out.couldNotCheck.push({ id: "outbound:failed", title: "Outbound email send lane", detail: `Could not read the outbound table (${ans.err}).`, link: "view:email" });
  } else if (ans.rows.length > 0) {
    const f = ans.rows[0];
    out.problems.push({
      id: "outbound:failed",
      title: `${ans.rows.length} outbound email${ans.rows.length === 1 ? "" : "s"} failed to send in the last 24 hours`,
      detail: `Latest ${agoWords(f.last_send_attempt_at)}${f.last_send_error ? `: ${f.last_send_error.slice(0, 140)}` : ""}.`,
      link: "view:email", linkLabel: "Open the Email tab",
    });
  } else {
    out.fine.push({ id: "outbound:failed", title: "No outbound emails failed in the last 24 hours", detail: "outbound status=failed with a send attempt in 24h: 0 rows.", link: "view:email" });
  }
  return out;
}

// ── sender pause flag (so a deliberate pause is never reported as a fault) ──
interface OutreachState { client: string; paused: boolean; day: string | null; count: number | null; updated_at: string | null }
async function readSenderPause(): Promise<{ known: boolean; paused: boolean; since: string | null }> {
  const ans = await osGet<OutreachState>("outreach_state?select=client,paused,day,count,updated_at&order=updated_at.desc&limit=5");
  if (!ans.ok || ans.rows.length === 0) return { known: false, paused: false, since: null };
  const row = ans.rows[0];
  return { known: true, paused: !!row.paused, since: row.updated_at ?? row.day };
}

// Fold a legacy CheckResult's items into findings with a link, so the older
// checks (flagged pages, snapshot freshness, outreach vitals) speak the same
// language as the new ones.
function foldCheck(c: CheckResult, link: string | null, pcLast: string | null): Findings {
  const out = emptyFindings();
  const items = c.items && c.items.length ? c.items : [{ label: c.label, status: c.status, line: c.line, url: null, http: null }];
  for (const it of items) {
    const id = `${c.id}:${it.label}`;
    const f: Finding = { id, title: it.label === c.label ? c.label : `${c.label}: ${it.label}`, detail: it.line, link: it.url ?? link };
    if (it.status === "problem") out.problems.push(f);
    else if (it.status === "needs-pc") out.couldNotCheck.push({ ...f, detail: `${it.line} This runs on Jack's PC.${pcLast ? ` Last PC result: ${pcLast}.` : ""}` });
    else out.fine.push(f);
  }
  return out;
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
    if (!ALLOWED_URL_HOSTS().some((h) => hostOf(u) === h || hostOf(u).endsWith("." + h))) continue;
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
    return { id: "outreach", label: "Outreach vitals", status: "needs-pc", line: "outreach-snapshot.md is missing from the vault, so the outreach vitals could not be read.", items: [] };
  }
  // A sender Jack paused on purpose is not a fault. The pause flag lives in
  // Supabase outreach_state, so the cloud can verify it too.
  const pause = await readSenderPause();
  const num = (re: RegExp): number | null => {
    const m = raw.match(re);
    return m ? Number(m[1].replace(/,/g, "")) : null;
  };
  // Sends-today truth: prefer the CLOUD (Supabase) — the source of truth now
  // that sending moved off the PC — then the local prospects.db, then the
  // snapshot. Never let a prior-day snapshot count read as today's (that is the
  // exact bug we are killing).
  const live = await readOutreachLive();
  const liveWhere = live ? (live.source === "live-cloud" ? "Supabase (cloud)" : "prospects.db") : "";
  const st = sendsTodayHonest(live, raw, parseSnapshotAsOf(raw));
  const sentToday = st.value; // number | null, honest (0 on prior-day snapshot)
  const sentSourceLabel = live ? `live from ${liveWhere}` : st.stale ? `snapshot, ${st.display}` : "snapshot";
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
    items.push({ label: "Sent today", status: "needs-pc", line: `Sent-today count unknown (${sentSourceLabel}).` });
  } else if (pause.known && pause.paused) {
    items.push({
      label: "Sent today",
      status: "ok",
      line: `${sentToday} sent today, and that is expected: the cold email sender is paused on purpose (pause flag set ${pause.since ? pause.since.slice(0, 10) : "earlier"}).`,
    });
  } else if (sentToday === 0 && isWeekday && afterEleven) {
    items.push({
      label: "Sent today",
      status: "problem",
      line: live
        ? `0 sent, and it is a weekday past 11am. Confirmed live from ${liveWhere} — the sender is not sending (paused or broken).`
        : `0 sent today (${sentSourceLabel}), a weekday past 11am. Real fault; live confirmation needs the cloud or PC.`,
    });
  } else {
    items.push({
      label: "Sent today",
      status: "ok",
      line: live
        ? `${sentToday} sent today, counted live from ${liveWhere}.`
        : `${sentToday} sent today per the snapshot (${ageWords(ageHours)}).`,
    });
  }

  // pool judgement
  if (pool === null) {
    items.push({ label: "Ready pool", status: "needs-pc", line: "No ready/armed pool figure available here." });
  } else if (pool < 20) {
    items.push({
      label: "Ready pool",
      status: "problem",
      line: `Pool is ${pool}, under the 20 line${live ? ` (live armed count from ${liveWhere})` : poolIsExplicit ? "" : " (using new+enriching remaining; true armed count needs the cloud or PC)"}.`,
    });
  } else {
    items.push({
      label: "Ready pool",
      status: "ok",
      line: `Pool is ${pool}${live ? " (live armed count)" : poolIsExplicit ? "" : " (new+enriching remaining)"}, over the 20 line.`,
    });
  }

  const anyProblem = items.some((i) => i.status === "problem");
  const anyNeedsPc = items.some((i) => i.status === "needs-pc");
  return {
    id: "outreach",
    label: "Outreach vitals",
    status: anyProblem ? "problem" : anyNeedsPc ? "needs-pc" : "ok",
    line: anyProblem ? "Outreach vitals off target." : anyNeedsPc ? "Part of the outreach vitals could not be read here." : "Outreach vitals within thresholds.",
    items,
  };
}

// ── check: scheduled-task heartbeats (LOCAL DISK ONLY) ──────────────────────
function checkTaskFiles(cloud: boolean): CheckResult {
  if (cloud) {
    return {
      id: "heartbeats",
      label: "Scheduled task run files",
      status: "needs-pc",
      line: "Windows scheduled-task run files live on the PC disk.",
      items: [],
    };
  }
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(SCHEDULED_DIR, { withFileTypes: true });
  } catch {
    return {
      id: "heartbeats",
      label: "Scheduled task run files",
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
    return { id: "heartbeats", label: "Scheduled task run files", status: "needs-pc", line: "No task run-state files on disk to read, so nothing could be judged.", items };
  }
  const anyProblem = items.some((i) => i.status === "problem");
  const problemN = items.filter((i) => i.status === "problem").length;
  return {
    id: "heartbeats",
    label: "Scheduled task run files",
    status: anyProblem ? "problem" : "ok",
    line: anyProblem ? `${problemN} task${problemN === 1 ? "" : "s"} look overdue.` : `${items.length} tasks reporting on time.`,
    items,
  };
}

// ── LOCAL live probe: watchdog_probe.py KEY=VALUE ground truth ──────────────
// Runs the SAME script the hardened watchdog SKILL runs and parses its facts.
// LOCAL only. Never logs stdout (it is data, not secrets, but we stay quiet).
// Returns null on cloud, on any spawn error, or if python is unavailable.
interface Probe {
  eligiblePool: number | null;
  wrongCompanyUnsentFails: number | null;
  budgetAgentsAtCap: string; // "none" or "agent n/cap;agent2 n/cap"
  lastBlogDate: string | null;
  cadenceStaleDays: number | null;
}
function runProbe(): Promise<Probe | null> {
  return new Promise((resolve) => {
    try {
      execFile(
        "python",
        [WATCHDOG_PROBE_PY],
        { timeout: 30_000, windowsHide: true, cwd: GHL_CLI_DIR },
        (err, stdout) => {
          if (err || !stdout) { resolve(null); return; }
          const map = new Map<string, string>();
          for (const line of String(stdout).split(/\r?\n/)) {
            const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
            if (m) map.set(m[1], m[2].trim());
          }
          if (!map.has("ELIGIBLE_POOL")) { resolve(null); return; }
          const numOrNull = (k: string): number | null => {
            const v = map.get(k);
            if (v == null || v === "" || v === "None" || /ERROR/i.test(v)) return null;
            const n = Number(v);
            return Number.isFinite(n) ? n : null;
          };
          const lbd = map.get("LAST_BLOG_DATE");
          resolve({
            eligiblePool: numOrNull("ELIGIBLE_POOL"),
            wrongCompanyUnsentFails: numOrNull("WRONG_COMPANY_UNSENT_FAILS"),
            budgetAgentsAtCap: (map.get("BUDGET_AGENTS_AT_CAP") || "none").trim(),
            lastBlogDate: lbd && lbd !== "" ? lbd : null,
            cadenceStaleDays: numOrNull("CADENCE_STALE_DAYS"),
          });
        }
      );
    } catch {
      resolve(null);
    }
  });
}

// ── classifier: keep a PROBLEM only if LIVE state confirms it is still broken ─
// This is the honesty inversion aligned with the hardened watchdog SKILL: a
// block does NOT survive just because it exists. Every block is verified against
// current reality (live probe on LOCAL, live fetch / snapshot on either host):
//   still-broken  -> KEEP (survives, stays a live problem)
//   healthy now   -> RESOLVE (moved to RESOLVED, dropped from PROBLEMS)
//   unverifiable  -> NEEDS-PC (kept in the file, never resurrected, never
//                    dropped blindly, and never counted as a fresh red)
// The route can therefore only ever REDUCE or CONFIRM problems against reality;
// it never adds a block, so a fixed alarm can never be resurrected.
//
// Honesty rules (mirrors SKILL.md thresholds exactly):
//   URL            -> every allowed-host URL now clean-2xx (no build-note leak).
//   SMTP / Sentinel-> retired false alarm (brief is rerouted to the vault); a
//                     block about SMTP/email delivery is always RESOLVED.
//   wrong-company  -> count UNSENT eligible rows failing the guard; 0 = resolved
//                     (never read historical sends).
//   nothing-to-send-> live ELIGIBLE_POOL; only keep if under the floor (20).
//   budget         -> only keep an agent actually at its per-agent cap
//                     (respecting per_agent overrides via the probe).
//   cadence        -> LAST_BLOG_DATE age; keep only if genuinely stale (> 4d or
//                     missing), never restamp an already-current date.
//   freshness      -> named snapshots re-read fresh clears it.
interface ResolvedMark {
  index: number;
  bullet: string;
}
type BlockCategory =
  | "url" | "smtp" | "wrong_company" | "nothing_to_send"
  | "budget" | "cadence" | "freshness" | "other";
type Verdict = "resolve" | "keep" | "needs-pc";

const FRESHNESS_HINT = /\b(stale|aging|ages?|\d+(\.\d+)?h old|hours? old|snapshot.*old|keep aging)\b/i;
const SNAPSHOT_NAME = /(business-snapshot|outreach-snapshot|health-board)/i;
const AGENT_NAME = /\b(dispatch|prospector|outreach|chronicler|content|renewal|sentinel|builder|reply[- ]?triage)\b/i;

function categorize(b: ProblemBlock): BlockCategory {
  const t = b.text;
  // SMTP / Sentinel-email delivery: retired false alarm, rerouted to the vault.
  if (/\b(smtp|report_smtp_pass|email password|mail password)\b/i.test(t)) return "smtp";
  if (/sentinel/i.test(t) && /(email|smtp|brief|deliver|mail)/i.test(t)) return "smtp";
  // URL availability is the strongest live signal.
  if (b.urls.length > 0) return "url";
  if (/wrong[- ]?company|domain.*(mismatch|company)|company.*mismatch|guard (is )?missing|no guard|domain_company_mismatch/i.test(t)) return "wrong_company";
  // Budget before nothing-to-send so a cap throttle is never read as an empty pool.
  if (/budget|daily cap|per[- ]?agent cap|hit its cap|at its cap|\bat cap\b|max_runs/i.test(t)) return "budget";
  if (/cadence|last[_ ]?blog|blog.*(stale|cadence|overdue)|content.*(stale|cadence)|stamp.*date/i.test(t)) return "cadence";
  if (/nothing to send|empty pool|pool (is )?(empty|low|0|under)|no (send-?ready|eligible|leads|prospects)|out of (leads|prospects)|sender.*(down|stopped)|not sending|0 sent/i.test(t)) return "nothing_to_send";
  if (FRESHNESS_HINT.test(t) && SNAPSHOT_NAME.test(t)) return "freshness";
  return "other";
}

function verifyBlock(
  b: ProblemBlock,
  cat: BlockCategory,
  probe: Probe | null,
  cleanUrls: Set<string>,
  freshnessStale: boolean
): Verdict {
  switch (cat) {
    case "smtp":
      return "resolve"; // never a live problem anymore
    case "url":
      return b.urls.every((u) => cleanUrls.has(u)) ? "resolve" : "keep";
    case "freshness":
      return freshnessStale ? "keep" : "resolve";
    case "wrong_company":
      if (!probe || probe.wrongCompanyUnsentFails == null) return "needs-pc";
      return probe.wrongCompanyUnsentFails > 0 ? "keep" : "resolve";
    case "nothing_to_send":
      if (!probe || probe.eligiblePool == null) return "needs-pc";
      return probe.eligiblePool < POOL_FLOOR ? "keep" : "resolve";
    case "budget": {
      if (!probe) return "needs-pc";
      const cap = probe.budgetAgentsAtCap;
      if (!cap || cap.toLowerCase() === "none") return "resolve";
      const named = b.text.match(AGENT_NAME)?.[0]?.toLowerCase().replace(/\s|-/g, "");
      if (named && !cap.toLowerCase().replace(/\s|-/g, "").includes(named)) return "resolve";
      return "keep"; // an agent genuinely at its per-agent cap survives
    }
    case "cadence":
      if (!probe) return "needs-pc";
      if (probe.cadenceStaleDays == null) return "keep"; // missing = genuinely stale per SKILL
      return probe.cadenceStaleDays > CADENCE_WINDOW_DAYS ? "keep" : "resolve";
    default:
      // Unknown category: never resurrect, never blind-drop. Keep it, but on
      // cloud (no probe) label it needs-pc so it is not read as a fresh red.
      return probe ? "keep" : "needs-pc";
  }
}

function resolveReason(cat: BlockCategory, b: ProblemBlock, probe: Probe | null, stamp: string): string {
  switch (cat) {
    case "url":
      return `- **Cleared by Run Da Boss ${stamp}.** ${b.urls.join(", ")} now HTTP 200 and clean of build-note leaks.`;
    case "smtp":
      return `- **Cleared by Run Da Boss ${stamp}.** SMTP/email delivery is retired; Sentinel's brief is rerouted to the vault, so this is no longer a problem.`;
    case "freshness":
      return `- **Cleared by Run Da Boss ${stamp}.** Named snapshots re-read fresh (within threshold).`;
    case "wrong_company":
      return `- **Cleared by Run Da Boss ${stamp}.** 0 unsent eligible rows fail the wrong-company guard (checked live, not historical sends).`;
    case "nothing_to_send":
      return `- **Cleared by Run Da Boss ${stamp}.** Live eligible pool is ${probe?.eligiblePool ?? "?"}, at or above the ${POOL_FLOOR} floor.`;
    case "budget":
      return `- **Cleared by Run Da Boss ${stamp}.** No agent is at its per-agent cap right now (live budget check).`;
    case "cadence":
      return `- **Cleared by Run Da Boss ${stamp}.** last_blog_date is ${probe?.lastBlogDate ?? "current"} (${probe?.cadenceStaleDays ?? 0}d), within the cadence window.`;
    default:
      return `- **Cleared by Run Da Boss ${stamp}.** Live check confirms this is no longer broken.`;
  }
}

// Classify every block, returning the RESOLVE marks (verdict === "resolve") plus
// the per-block verdicts for the JSON overlay. KEEP and NEEDS-PC stay in the file.
function classifyBlocks(
  blocks: ProblemBlock[],
  cleanUrls: Set<string>,
  freshness: CheckResult | null,
  probe: Probe | null
): { marks: ResolvedMark[]; verdicts: { index: number; category: BlockCategory; verdict: Verdict }[] } {
  const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
  const freshnessStale = (freshness?.items ?? []).some((i) => i.status === "problem");
  const marks: ResolvedMark[] = [];
  const verdicts: { index: number; category: BlockCategory; verdict: Verdict }[] = [];
  for (const b of blocks) {
    const cat = categorize(b);
    const verdict = verifyBlock(b, cat, probe, cleanUrls, freshnessStale);
    verdicts.push({ index: b.index, category: cat, verdict });
    if (verdict === "resolve") {
      marks.push({ index: b.index, bullet: resolveReason(cat, b, probe, stamp) });
    }
  }
  return { marks, verdicts };
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

  // Development-only test hook: ?testUrl=<url> adds one more site to the
  // uptime check so a deliberately broken URL can prove the check catches it.
  // Ignored outside development, so production can never be pointed at an
  // arbitrary host.
  const testUrl = process.env.NODE_ENV === "development" ? req.nextUrl.searchParams.get("testUrl") : null;
  const sites = testUrl && /^https?:\/\//.test(testUrl) ? [...siteList(), testUrl] : siteList();

  const [watchdogRaw, healthRaw] = await Promise.all([
    wantAll || target === "urls" ? readVaultFile(WATCHDOG_REL) : Promise.resolve(null),
    wantAll || target === "urls" ? readVaultFile("wiki/state/health-board.md") : Promise.resolve(null),
  ]);

  const checks: CheckResult[] = [];
  const findings = emptyFindings();
  let cleanUrls = new Set<string>();

  // Live checks the cloud can run from anywhere. Heartbeats go first because
  // the PC's own last report feeds the "could not check here" lines.
  const hb = wantAll || target === "heartbeats" ? await checkHeartbeats() : null;
  const pcLast = hb?.pcLastResult ?? null;
  if (hb) merge(findings, hb);

  if (wantAll || target === "urls") {
    const [siteFindings, flagged] = await Promise.all([checkSites(sites), checkUrls(watchdogRaw, healthRaw)]);
    merge(findings, siteFindings);
    checks.push(flagged.result);
    cleanUrls = flagged.cleanUrls;
    if (flagged.result.items && flagged.result.items.length) merge(findings, foldCheck(flagged.result, null, pcLast));
    else findings.fine.push({ id: "urls", title: "No pages are flagged as broken in the last report", detail: flagged.result.line, link: null });
  }
  if (wantAll) {
    const [db, auto, sms, bookings, outbound] = await Promise.all([checkDatabases(), checkAutomations(), checkSms(), checkBookings(), checkOutbound()]);
    for (const f of [db, auto, sms, bookings, outbound]) merge(findings, f);
  }

  let freshnessResult: CheckResult | null = null;
  let outreachResult: CheckResult | null = null;
  if (wantAll || target === "freshness") {
    freshnessResult = await checkFreshness();
    checks.push(freshnessResult);
    merge(findings, foldCheck(freshnessResult, "view:knowledge", pcLast));
  }
  if (wantAll || target === "outreach") {
    outreachResult = await checkOutreach();
    checks.push(outreachResult);
    merge(findings, foldCheck(outreachResult, "view:email", pcLast));
  }
  if (wantAll || target === "heartbeats") {
    const tasks = checkTaskFiles(cloud);
    checks.push(tasks);
    merge(findings, foldCheck(tasks, "/mission", pcLast));
  }

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
  let needsPcCount = 0;

  if (watchdogRaw) {
    // Ground truth: on LOCAL run the same probe the hardened watchdog SKILL uses
    // so outreach/budget/cadence/wrong-company blocks are verified against the
    // live DB/files, not carried forward blindly. On CLOUD the probe is null and
    // those categories fall to needs-pc (kept, never resurrected as red).
    const probe = cloud ? null : await runProbe();

    // The probe's facts are live checks in their own right (local only).
    const probeLink = "view:email";
    if (!probe) {
      findings.couldNotCheck.push({
        id: "probe",
        title: "PC-only checks: ready pool, wrong-company guard, agent budget caps, blog cadence",
        detail: `${cloud ? "These read prospects.db and files on Jack's PC, which the cloud cannot reach." : "The local probe (watchdog_probe.py) could not run on this host."}${pcLast ? ` Last PC result: ${pcLast}.` : ""}`,
        link: "/mission",
      });
    } else {
      if (probe.eligiblePool == null) findings.couldNotCheck.push({ id: "probe:pool", title: "Eligible send pool", detail: "The probe could not count the pool.", link: probeLink });
      else if (probe.eligiblePool < POOL_FLOOR) findings.problems.push({ id: "probe:pool", title: `Eligible send pool is low: ${probe.eligiblePool}`, detail: `Under the ${POOL_FLOOR} floor, measured live from prospects.db.`, link: probeLink, linkLabel: "Open the Email tab" });
      else findings.fine.push({ id: "probe:pool", title: `Eligible send pool is ${probe.eligiblePool}`, detail: `At or above the ${POOL_FLOOR} floor, measured live from prospects.db.`, link: probeLink });
      if (probe.wrongCompanyUnsentFails == null) findings.couldNotCheck.push({ id: "probe:guard", title: "Wrong-company guard", detail: "The probe could not evaluate the guard.", link: probeLink });
      else if (probe.wrongCompanyUnsentFails > 0) findings.problems.push({ id: "probe:guard", title: `Wrong-company guard is holding back ${probe.wrongCompanyUnsentFails} unsent row${probe.wrongCompanyUnsentFails === 1 ? "" : "s"}`, detail: "Counted live on the unsent pool. Clean the rows or add a carve-out; do not disable the guard.", link: probeLink, linkLabel: "Open the Email tab" });
      else findings.fine.push({ id: "probe:guard", title: "Wrong-company guard: 0 unsent rows held", detail: "Counted live on the unsent pool.", link: probeLink });
      if (probe.budgetAgentsAtCap && probe.budgetAgentsAtCap.toLowerCase() !== "none") findings.problems.push({ id: "probe:budget", title: `Agent at its daily cap: ${probe.budgetAgentsAtCap}`, detail: "Live per-agent budget check.", link: "/mission", linkLabel: "Open Mission Control" });
      else findings.fine.push({ id: "probe:budget", title: "No agent is at its daily cap", detail: "Live per-agent budget check.", link: "/mission" });
      if (probe.cadenceStaleDays == null) findings.couldNotCheck.push({ id: "probe:cadence", title: "Blog cadence", detail: `The probe could not find a last blog date (LAST_BLOG_DATE=${probe.lastBlogDate ?? "missing"}), so the cadence was not judged.`, link: "/mission" });
      else if (probe.cadenceStaleDays > CADENCE_WINDOW_DAYS) findings.problems.push({ id: "probe:cadence", title: `Last blog was ${probe.cadenceStaleDays} days ago`, detail: `Over the ${CADENCE_WINDOW_DAYS}-day window (last_blog_date ${probe.lastBlogDate ?? "unknown"}).`, link: "/mission" });
      else findings.fine.push({ id: "probe:cadence", title: `Last blog was ${probe.cadenceStaleDays} day${probe.cadenceStaleDays === 1 ? "" : "s"} ago`, detail: `Within the ${CADENCE_WINDOW_DAYS}-day window (last_blog_date ${probe.lastBlogDate ?? "unknown"}).`, link: "/mission" });
    }

    const { blocks } = parseProblemBlocks(watchdogRaw);
    const { marks: resolvedMarks, verdicts } = classifyBlocks(blocks, cleanUrls, freshnessResult, probe);
    resolvedCount = resolvedMarks.length;
    needsPcCount = verdicts.filter((v) => v.verdict === "needs-pc").length;
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
          writeNote = `Report updated in the cloud vault: ${resolvedCount} moved to resolved.`;
        } else {
          persisted = false; reason = res.reason;
          writeNote = "The report file could not be updated from the cloud, so the fixed items stay listed until the PC rewrites it.";
        }
      } else if (vaultWritable()) {
        // LOCAL: write to disk, then push the vault to the cloud copy.
        try {
          fs.writeFileSync(WATCHDOG_ABS(), next, "utf-8");
          persisted = true; mode = "local"; refetchMission = true;
          pushedToCloud = await pushVaultToCloud();
          writeNote = `Report updated on disk: ${resolvedCount} moved to resolved.`
            + (pushedToCloud ? " Cloud copy synced." : " Cloud sync will catch up on the next scheduled push.");
        } catch {
          persisted = false; reason = "disk write failed"; mode = "none";
          writeNote = "The report file on disk could not be written.";
        }
      } else {
        persisted = false; reason = "vault not writable and not cloud-backed";
        writeNote = "The report file can only be rewritten on the PC.";
      }
    } else {
      // Nothing verifiable to clear: the report file stays as it is, and that
      // is honest. This is NOT a problem and is never counted as one.
      writeNote = resolvedMarks.length ? "No net change to write to the report file." : null;
    }
  }

  // overall roll-up: ONLY verified problems count. A check that could not run
  // here is neither red nor green.
  const anyResolved = checks.some((c) => c.status === "resolved");
  const overall: CheckStatus = findings.problems.length > 0 ? "problem" : anyResolved ? "resolved" : "ok";

  // Stable ordering: problems first by id, could-not-check, then fine.
  const byId = (a: Finding, b: Finding) => a.id.localeCompare(b.id);
  findings.problems.sort(byId);
  findings.couldNotCheck.sort(byId);
  findings.fine.sort(byId);

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
    needsPcCount,
    refetchMission,
    wrote: persisted, // backward-compat
    writeNote,
    overall,
    // What Jack reads.
    problems: findings.problems,
    couldNotCheck: findings.couldNotCheck,
    fine: findings.fine,
    summary: {
      problems: findings.problems.length,
      couldNotCheck: findings.couldNotCheck.length,
      fine: findings.fine.length,
      pcLastResult: pcLast,
    },
    // Legacy per-check shape, still returned for older callers.
    checks,
  });
}
