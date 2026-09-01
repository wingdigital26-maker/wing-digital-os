import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { readVaultFile, isGithubVault, VAULT_PATH } from "../../../lib/vaultSource";
import { sbSelect } from "../../../lib/osSupabase";
import {
  readOutreachLive,
  sendsTodayHonest,
  parseSnapshotAsOf,
  isStale,
  provenanceLine,
  STALE_HOURS,
  type LiveOutreach,
  type MetricSource,
} from "../../../lib/liveTruth";
import { getRevenueTruth, BASIS_LABEL as BASIS_LABEL_MISSION, type RevenueTruth } from "../../../lib/revenue";

// ───────────────────────────────────────────────────────────────────────────
// Mission Control API (READ-ONLY)
//
// Aggregates everything the agents are doing into one payload:
//   - scheduled agents (C:\Users\wjack\.claude\scheduled-tasks, local disk only)
//   - on-demand crew (static roster + last-seen line from wiki/log.md)
//   - activity feed (tail of wiki/log.md)
//   - current focus (wiki/hot.md sections)
//   - client health (wiki/state/health-board.md)
//   - business stats (wiki/state/business-snapshot.md, outreach-snapshot.md)
//
// Vault reads go through lib/vaultSource so the same route works locally
// (filesystem) and on Vercel (wing-os-vault GitHub repo). The scheduled-tasks
// directory is local-only; in cloud mode those cards show pcNeeded=true.
// This route never writes anything anywhere.
// ───────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";

const SCHEDULED_DIR = "C:\\Users\\wjack\\.claude\\scheduled-tasks";

// ── Redaction: never render credential-looking strings ─────────────────────
const SECRET_PATTERNS: RegExp[] = [
  /\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/g, // OpenAI/Stripe style
  /\bsk-ant-[A-Za-z0-9_-]{10,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, // JWT
  /\bAKIA[A-Z0-9]{16}\b/g, // AWS
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, // Slack
  /\bAIza[A-Za-z0-9_-]{30,}\b/g, // Google API
  /\b(api[_-]?key|token|secret|password|passphrase)\s*[:=]\s*['"]?[A-Za-z0-9_\-./+]{12,}['"]?/gi,
  /\b[A-Fa-f0-9]{40,}\b/g, // long hex blobs
];
function redact(s: string): string {
  let out = s;
  for (const re of SECRET_PATTERNS) out = out.replace(re, "[REDACTED]");
  return out;
}

// ── Scheduled agent metadata (fallback when no live state exists) ──────────
interface ScheduledMeta {
  key: string;
  name: string;
  role: string;
  schedule: string; // human label
  enabled: boolean;
  match: RegExp; // how this agent shows up in log.md
  next: () => Date | null;
}

function nextDaily(hour: number, minute: number): Date {
  const d = new Date();
  d.setHours(hour, minute, 0, 0);
  if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
  return d;
}
function nextWeekly(dow: number, hour: number, minute: number): Date {
  const d = new Date();
  d.setHours(hour, minute, 0, 0);
  let delta = (dow - d.getDay() + 7) % 7;
  if (delta === 0 && d.getTime() <= Date.now()) delta = 7;
  d.setDate(d.getDate() + delta);
  return d;
}
// cron "*/30 8-19 * * *": next :00/:30 boundary between 8:00 and 19:30, else 8:00 tomorrow.
function nextEvery30(): Date {
  const d = new Date();
  d.setSeconds(0, 0);
  // advance to the next 30-minute boundary strictly after now
  d.setMinutes(d.getMinutes() < 30 ? 30 : 60, 0, 0);
  if (d.getHours() < 8) { d.setHours(8, 0, 0, 0); }
  else if (d.getHours() > 19 || (d.getHours() === 19 && d.getMinutes() > 30)) {
    d.setDate(d.getDate() + 1);
    d.setHours(8, 0, 0, 0);
  }
  return d;
}

const SCHEDULED: ScheduledMeta[] = [
  { key: "sentinel-daily", name: "Sentinel", role: "Per-client health monitor, 5-pillar daily checkup", schedule: "Daily 7:00am", enabled: true, match: /\bsentinel\b/i, next: () => nextDaily(7, 0) },
  { key: "chronicler-end-of-day", name: "Chronicler", role: "End-of-day vault historian, digests chats into the brain", schedule: "Daily 9:52pm", enabled: true, match: /\bchronicler\b/i, next: () => nextDaily(21, 52) },
  { key: "content-engine-weekly", name: "Content Engine", role: "Jackson Roofing weekly SEO content producer", schedule: "Mon 7:10am", enabled: true, match: /content[- ]engine|jackson.*(blog|content|post)/i, next: () => nextWeekly(1, 7, 10) },
  { key: "renewal-content-weekly", name: "Renewal Engine", role: "Renewal Health weekly content, health-gated publishing", schedule: "Mon 7:44am", enabled: true, match: /\brenewal\b/i, next: () => nextWeekly(1, 7, 44) },
  { key: "b2b-outreach-engine", name: "Outreach", role: "B2B cold email sender, LIVE since 8/6 — window + cap check, dry-run, then live send", schedule: "Every 30 min, 8am-8pm", enabled: true, match: /outreach|cold email|b2b/i, next: nextEvery30 },
  { key: "b2b-prospector-daily", name: "Prospector", role: "Daily B2B lead scout — refills the pipeline so outreach never runs dry", schedule: "Daily 6:15am", enabled: true, match: /prospector|lead scan|lead-find|b2b lead/i, next: () => nextDaily(6, 15) },
  // TRIAL agents (closer, call-prep, client-report) removed 2026-08-22 on Jack's
  // call — he does not want them anymore. Their scheduled tasks were deleted too.
];

// Retired: superseded Apollo-era relics that still exist on disk. A DISABLED task
// in this set stays dimmed "retired"; a DISABLED task NOT in this set is a live
// "trial". wing-digital-daily-outreach / wing-audit-roofing-batch are also absent
// from SCHEDULED entirely so they can never be confused with the live tasks.
const RETIRED = new Set<string>(["wing-digital-daily-outreach", "wing-audit-roofing-batch"]);
// A disabled task is a "trial" (amber, Run-now) unless it is a retired relic.
const isTrial = (key: string, enabled: boolean) => !enabled && !RETIRED.has(key);

// On-demand crew: static roster, last-seen resolved from log.md.
const CREW = [
  { key: "dispatch", name: "Dispatch", role: "Morning briefing, orders the day's dial list", match: /dispatch/i },
  { key: "reply-triage", name: "Reply-Triage", role: "Classifies inbound replies HOT/WARM/COLD", match: /reply-triage|triage/i },
  { key: "builder", name: "Builder", role: "Retired — was the GoHighLevel onboarding runner; no replacement yet", match: /builder|onboard/i },
];

// ── Scheduled-tasks disk state (local only) ────────────────────────────────
function readScheduledDisk(): { present: Set<string>; state: Map<string, any> } {
  const present = new Set<string>();
  const state = new Map<string, any>();
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(SCHEDULED_DIR, { withFileTypes: true });
  } catch {
    return { present, state };
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      present.add(e.name);
      // look for json state inside the task folder (one level)
      try {
        for (const f of fs.readdirSync(path.join(SCHEDULED_DIR, e.name))) {
          if (!f.endsWith(".json")) continue;
          try {
            const j = JSON.parse(fs.readFileSync(path.join(SCHEDULED_DIR, e.name, f), "utf-8"));
            if (j && (j.lastRunAt || j.nextRunAt || j.lastRun)) state.set(e.name, j);
          } catch { /* skip malformed */ }
        }
      } catch { /* skip */ }
    } else if (e.name.endsWith(".json")) {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(SCHEDULED_DIR, e.name), "utf-8"));
        const k = e.name.replace(/\.json$/, "");
        if (j && (j.lastRunAt || j.nextRunAt || j.lastRun)) state.set(k, j);
      } catch { /* skip */ }
    }
  }
  return { present, state };
}

// ── log.md parsing ─────────────────────────────────────────────────────────
interface FeedEntry {
  date: string;
  type: string;
  title: string;
  lines: string[];
}

function parseLog(raw: string): FeedEntry[] {
  const entries: FeedEntry[] = [];
  let cur: FeedEntry | null = null;
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^##\s*\[(\d{4}-\d{2}-\d{2})\]\s*(\S+)\s*\|\s*(.+)$/);
    if (m) {
      cur = { date: m[1], type: m[2].toLowerCase(), title: redact(m[3].trim()), lines: [] };
      entries.push(cur);
    } else if (cur && line.trim() && !line.startsWith("---") && !line.startsWith("#")) {
      if (cur.lines.length < 12) cur.lines.push(redact(line.trim()));
    }
  }
  return entries;
}

// ── hot.md parsing ─────────────────────────────────────────────────────────
function parseHot(raw: string): Record<string, string[]> {
  const sections: Record<string, string[]> = {};
  let cur: string | null = null;
  for (const line of raw.split(/\r?\n/)) {
    const h = line.match(/^###\s+(.+)$/);
    if (h) {
      cur = h[1].trim();
      sections[cur] = [];
      continue;
    }
    if (cur && line.trim()) sections[cur].push(redact(line));
  }
  return sections;
}

// Strip obsidian [[wiki|links]] and markdown noise for display
function clean(s: string): string {
  return s
    .replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, "$2")
    .replace(/\[\[([^\]]*)\]\]/g, "$1")
    .replace(/\*\*/g, "")
    .replace(/`/g, "")
    .replace(/—/g, "-")
    .trim();
}

// ── health-board.md parsing ────────────────────────────────────────────────
interface ClientHealth {
  client: string;
  phase: string;
  overall: "green" | "yellow" | "red";
  pillars: string[]; // emoji per pillar
  redFlags: { text: string; link: string | null }[];
  site?: string | null; // live-site origin derived from real board links
}

function emojiToStatus(e: string): "green" | "yellow" | "red" {
  if (e.includes("\u{1F534}")) return "red";
  if (e.includes("\u{1F7E1}")) return "yellow";
  return "green";
}

function parseHealthBoard(raw: string): { runDate: string | null; clients: ClientHealth[] } {
  const clients: ClientHealth[] = [];
  const runDate = raw.match(/\*\*Run date:\*\*\s*([\d-]+)/)?.[1] ?? null;
  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    // table rows: | [[page|Name]] | phase | p1..p5 | count | overall |
    const m = line.match(/^\|\s*\[\[[^\]|]*\|([^\]]+)\]\]\s*\|([^|]+)\|([^|]+)\|([^|]+)\|([^|]+)\|([^|]+)\|([^|]+)\|[^|]*\|([^|]+)\|/);
    if (m) {
      clients.push({
        client: m[1].trim(),
        phase: m[2].trim(),
        overall: emojiToStatus(m[8]),
        pillars: [m[3], m[4], m[5], m[6], m[7]].map((p) => p.trim()),
        redFlags: [],
        site: null,
      });
    }
  }
  // red flag sections: "## <Client> — N red flags" followed by numbered items,
  // each possibly ending with a "→ <link>" line.
  let curClient: ClientHealth | null = null;
  let curFlag: { text: string; link: string | null } | null = null;
  for (const line of lines) {
    const h = line.match(/^##\s+(.+?)\s+[—-]+\s+\d+\s+red flag/i);
    if (h) {
      curClient = clients.find((c) => c.client === h[1].trim()) ?? null;
      curFlag = null;
      continue;
    }
    if (line.match(/^##\s/) && !h) { curClient = null; curFlag = null; }
    if (!curClient) continue;
    const item = line.match(/^\d+\.\s+(.+)$/);
    if (item) {
      const struck = /^~~/.test(item[1].trim());
      curFlag = { text: clean(redact(item[1].replace(/~~/g, ""))).slice(0, 260) + (struck ? " (fixed)" : ""), link: null };
      curClient.redFlags.push(curFlag);
      continue;
    }
    const arrow = line.match(/^\s*(?:→|->)\s*(\S+)/);
    if (arrow && curFlag) {
      const l = arrow[1];
      curFlag.link = l.startsWith("http") ? l : null; // only clickable web links
      if (!curFlag.link) curFlag.text += ` [${l}]`;
      curFlag = null;
    }
  }
  return { runDate, clients };
}

// ── watchdog.md parsing ────────────────────────────────────────────────────
// A scheduled Watchdog task overwrites wiki/state/watchdog.md every 2 hours:
// frontmatter (updated:), an OVERALL line (OK / PROBLEMS: n), a PROBLEMS
// section (one line per problem), a RESOLVED section, and an ALL CLEAR line
// listing each agent with state OK/LATE/SILENT/DISABLED. The file may not
// exist yet (first run pending) — that is a normal, non-error state.
interface WatchdogProblem { text: string; url: string | null }
interface Watchdog {
  available: boolean;
  updated: string | null;
  overall: "ok" | "problems" | "unknown";
  problemCount: number;
  problems: WatchdogProblem[];
  resolved: string[];
  agents: Record<string, string>; // agent name -> OK | LATE | SILENT | DISABLED
}

function parseWatchdog(raw: string | null): Watchdog {
  const wd: Watchdog = {
    available: false, updated: null, overall: "unknown",
    problemCount: 0, problems: [], resolved: [], agents: {},
  };
  if (!raw) return wd;
  wd.available = true;
  wd.updated =
    raw.match(/^updated:\s*["']?([^"'\r\n]+)["']?\s*$/m)?.[1]?.trim() ?? null;
  const ov = raw.match(/OVERALL\W*[:\-]?\s*(OK\b|PROBLEMS\s*[:\-]?\s*(\d+))/i);
  if (ov) {
    if (/^OK/i.test(ov[1])) wd.overall = "ok";
    else { wd.overall = "problems"; wd.problemCount = Number(ov[2] ?? 0) || 0; }
  }
  let section: "problems" | "resolved" | "allclear" | null = null;
  let curProblem: WatchdogProblem | null = null;
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    if (/^(#{1,4}\s*|\*\*)?PROBLEMS\b/i.test(t) && !/OVERALL/i.test(t)) { section = "problems"; curProblem = null; continue; }
    if (/^(#{1,4}\s*|\*\*)?RESOLVED\b/i.test(t)) { section = "resolved"; curProblem = null; continue; }
    if (/^(#{1,4}\s*|\*\*)?ALL\s*CLEAR\b/i.test(t)) { section = "allclear"; curProblem = null; continue; }
    if (/^#{1,4}\s/.test(t)) { section = null; curProblem = null; continue; }

    if (section === "allclear") {
      // "- sentinel-daily: OK (detail)"; names can be comma-separated.
      const m = t.match(/^[-*]?\s*(.+?)\s*:\s*(OK|LATE|SILENT|DISABLED|NEVER RUN)\b/i);
      if (m) {
        for (const nm of m[1].split(/\s*,\s*/)) {
          const name = nm.replace(/^[-*\s]+/, "").trim();
          if (name && name.length <= 48) wd.agents[name] = m[2].toUpperCase();
        }
      }
      continue;
    }

    const item = t.match(/^(?:[-*]|\d+\.)\s+(.+)$/);
    if (section === "problems") {
      if (item) {
        curProblem = { text: clean(redact(item[1])).slice(0, 400), url: null };
        wd.problems.push(curProblem);
      } else if (curProblem) {
        // continuation lines: keep the suggested action, grab arrow links
        const arrow = t.match(/^(?:→|->)\s*(\S+)/);
        if (arrow && !curProblem.url && arrow[1].startsWith("http")) {
          curProblem.url = arrow[1].replace(/[.,;:]+$/, "");
        } else if (/^Action\s*:/i.test(t)) {
          curProblem.text = (curProblem.text + " " + clean(redact(t))).slice(0, 500);
        }
      }
    } else if (section === "resolved" && item) {
      wd.resolved.push(clean(redact(item[1])).slice(0, 300));
    }
  }
  if (wd.overall === "unknown" && wd.problems.length) wd.overall = "problems";
  if (wd.overall === "problems" && !wd.problemCount) wd.problemCount = wd.problems.length;
  if (wd.overall === "problems" && wd.problemCount < wd.problems.length) wd.problemCount = wd.problems.length;
  return wd;
}

// Match a watchdog agent name against our roster (name or key, loose).
function watchdogStateFor(wd: Watchdog, key: string, name: string): string | null {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const nk = norm(key), nn = norm(name);
  for (const [wname, state] of Object.entries(wd.agents)) {
    const w = norm(wname);
    if (!w) continue;
    if (w === nk || w === nn || nk.includes(w) || w.includes(nn) || nn.includes(w)) return state;
  }
  return null;
}

// ── Real-world links ───────────────────────────────────────────────────────
// GoHighLevel was fully retired 2026-08-22 — its deep links are dead (401) and
// were removed. Outreach/CRM data now lives in the OS's own CRM (Supabase),
// reachable from the CRM tab of the OS itself.

// Live-site domains the OS is allowed to link to as publish targets. Links are
// only ever rendered when a real URL on one of these hosts appears in the
// vault text (or, for Jackson, when a real WP post id is logged).
const LIVE_HOSTS = ["jacksonroofingco.com", "renewalhealth.life", "herosjunkremovaltx.com"];

interface PublishItem { date: string; title: string; url: string | null; note: string | null; client: string | null }

// A human client/company label derived from a live post URL's host. Known Wing
// clients map to their brand name; any other host falls back to its registrable
// domain (e.g. "example.com") so a new client is still legible before it's named.
function clientFromUrl(url: string | null): string | null {
  if (!url) return null;
  let host: string;
  try { host = new URL(url).hostname.toLowerCase().replace(/^www\./, ""); }
  catch { return null; }
  if (host.includes("jacksonroofingco.com")) return "Jackson Roofing";
  if (host.includes("renewalhealth.life") || host.includes("renewalhealth")) return "Renewal Health";
  if (host.includes("herosjunkremovaltx.com")) return "Hero's Junk Removal";
  // Registrable domain: last two labels (good enough for the common .com case).
  const parts = host.split(".").filter(Boolean);
  return parts.length >= 2 ? parts.slice(-2).join(".") : host;
}

// Pull live post URLs out of a blob of vault text: only whitelisted hosts,
// never wp-admin or preview links, never localhost.
function extractLiveUrls(text: string): string[] {
  const out: string[] = [];
  const re = /https?:\/\/[^\s|,)\]"']+/g;
  for (const m of text.match(re) ?? []) {
    let u = m.replace(/[.,;:]+$/, "");
    if (!LIVE_HOSTS.some((h) => u.includes(h))) continue;
    if (/wp-admin|preview=true|action=edit/.test(u)) continue;
    if (!out.includes(u)) out.push(u);
  }
  return out;
}

// A clean, human title from a live post/page URL: the last path segment,
// de-slugged and title-cased. ".../window-replacement/" -> "Window Replacement".
function titleFromUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.searchParams.get("p")) return `Post ${u.searchParams.get("p")}`;
    const seg = u.pathname.split("/").filter(Boolean).pop() ?? "";
    if (!seg) return u.hostname;
    return seg.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  } catch {
    return url;
  }
}

// Publish events from log.md in the rolling window, plus the health board's
// "Published since last run" lines which carry real live URLs.
function parsePublishes(feed: FeedEntry[], healthRaw: string | null): {
  windowDays: number;
  items: PublishItem[];
  lastPriorPublish: string | null;
} {
  const weekAgo = Date.now() - 14 * 86400000;
  // A WEB publish, not a GHL workflow/template/campaign publish and not a
  // draft-only or rolled-back run. Title carries the verb, or a body line
  // explicitly says blogs/posts/pages were published.
  const NEGATION = /PULLED|rolled back|unpublish|nothing published|not published|draft[- ]only/i;
  const NON_WEB = /workflow|send path|cold email|outreach|x-ray|template/i;
  const isPublish = (e: FeedEntry) => {
    if (NEGATION.test(e.title) || NON_WEB.test(e.title)) return false;
    if (/\b(published|publishes|went live|posted live|now live)\b/i.test(e.title)) return true;
    return e.lines.some((l) =>
      /\b(blogs?|posts?|pages?)\b[^.]{0,40}\bpublished\b|\bpublished\b[^.]{0,40}\b(live|blogs?|posts?|pages?)\b/i.test(l)
    );
  };
  // Agent status/report lines (Sentinel, Watchdog, health, refiner, client-report,
  // etc.) are NOT publish events — this panel must stay publish-only. But those
  // lines often carry the real live URL of a page that was published. So we still
  // HARVEST any live URL out of a noise line, yet we render it as a clean row with
  // a title derived from the URL slug — never the raw sentinel/watchdog sentence.
  const NOISE = /^\s*(sentinel|watchdog|health|refine|refiner|client[- ]report|dispatch|reply[- ]?triage|closer|call[- ]prep|chronicler|prospector|da boss|boss)\b/i;
  const seen = new Set<string>();
  const publishEntries = feed.filter(isPublish);
  const items: PublishItem[] = [];

  for (const e of publishEntries) {
    if (new Date(e.date).getTime() < weekAgo) continue;
    const noise = NOISE.test(e.title);
    const text = e.title + "\n" + e.lines.join("\n");
    const urls = extractLiveUrls(text);
    if (urls.length) {
      for (const url of urls) {
        if (seen.has(url)) continue;
        seen.add(url);
        // Clean title: slug-derived for noise lines, the log title otherwise.
        items.push({ date: e.date, title: noise ? titleFromUrl(url) : clean(redact(e.title)), url, note: null, client: clientFromUrl(url) });
      }
      continue;
    }
    // A noise line with no URL is pure agent-activity — drop it entirely so the
    // panel never shows a Sentinel/Watchdog sentence with "no link logged".
    if (noise) continue;
    // Jackson WP posts logged by id only: ?p=<id> is WordPress's canonical
    // query permalink, built from the real post id in the publish line itself.
    if (/jackson/i.test(text)) {
      const ids = [...text.matchAll(/\bpublish\w*\b[^\n]{0,120}?\bposts?\s+(\d{4,6})(?:\s+and\s+(\d{4,6}))?/gi)]
        .flatMap((m) => [m[1], m[2]])
        .filter(Boolean) as string[];
      if (ids.length) {
        for (const id of [...new Set(ids)]) {
          const url = `https://jacksonroofingco.com/?p=${id}`;
          if (seen.has(url)) continue;
          seen.add(url);
          items.push({ date: e.date, title: `${clean(redact(e.title))} (post ${id})`, url, note: null, client: clientFromUrl(url) });
        }
        continue;
      }
    }
    items.push({ date: e.date, title: clean(redact(e.title)), url: null, note: "no link logged", client: null });
  }

  // Health board: "- Title — https://..." under "Published since last run".
  if (healthRaw) {
    const runDate = healthRaw.match(/\*\*Run date:\*\*\s*([\d-]+)/)?.[1] ?? null;
    if (runDate && new Date(runDate).getTime() >= weekAgo) {
      const sect = healthRaw.split(/\*\*Published since last run/i)[1];
      if (sect) {
        for (const line of sect.split(/\r?\n/).slice(0, 12)) {
          const m = line.match(/^-\s+(.+?)\s+[—-]+\s+(https?:\/\/\S+)/);
          if (m) {
            const url = m[2].replace(/[.,;:]+$/, "");
            if (LIVE_HOSTS.some((h) => url.includes(h)) && !seen.has(url)) {
              seen.add(url);
              items.push({ date: runDate, title: clean(redact(m[1])), url, note: null, client: clientFromUrl(url) });
            }
          }
        }
      }
    }
  }

  items.sort((a, b) => (a.date < b.date ? 1 : -1));
  const lastPriorPublish = items.length
    ? null
    : publishEntries.length ? publishEntries[0].date : null;
  return { windowDays: 14, items, lastPriorPublish };
}

// Derive each client's live-site origin from real links already on the board
// (flag deep links, publish lines) — never invented.
function deriveClientSites(clients: ClientHealth[], healthRaw: string | null): Record<string, string> {
  const sites: Record<string, string> = {};
  if (!healthRaw) return sites;
  for (const c of clients) {
    // scan this client's section of the board for whitelisted live hosts
    const sect = healthRaw.split(new RegExp(`^##\\s+${c.client.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "m"))[1] ?? healthRaw;
    const urls = extractLiveUrls(sect);
    if (urls.length) {
      try { sites[c.client] = new URL(urls[0]).origin; } catch { /* skip */ }
    }
  }
  return sites;
}

// ── stats parsing ──────────────────────────────────────────────────────────
// Each tile carries a stable key so the UI can open the matching breakdown
// panel (/api/mission?stat=key), plus the snapshot timestamp it came from.
// Every tile carries provenance: value, source, asOf (when it was actually
// true), and stale. Never a bare number with no timestamp.
interface StatTile {
  key: string;
  label: string;
  value: string;
  sub: string | null;
  updated: string | null; // asOf: ISO (live) or snapshot "_Last updated_" string
  source: MetricSource;
  stale: boolean;
  provenance: string; // human "Live from prospects.db, just now" / "From snapshot, 20h old"
}

function buildStats(
  biz: string | null,
  outreach: string | null,
  live: LiveOutreach | null,
  revenue: RevenueTruth | null,
): { tiles: StatTile[]; updated: string | null } {
  const tiles: StatTile[] = [];
  let updated: string | null = null;
  const bizUpdated = parseSnapshotAsOf(biz);
  const outUpdated = parseSnapshotAsOf(outreach);
  const nowIso = new Date().toISOString();

  // MRR / active clients.
  //
  // These used to be regexed out of wiki/state/business-snapshot.md — a file a
  // python script rewrites on a schedule. So this tile showed whatever was true
  // the last time state-sync ran, while the client screen recomputed live from
  // the vault, and the two silently drifted apart. Now both come from
  // lib/revenue.ts, computed live, so every surface prints the same number.
  if (revenue) {
    const prov = `Live from the client roster (${revenue.rosterSource}) + vault revenue fields, just now`;
    const base = { key: "clients" as const, updated: revenue.asOf, source: "live-db" as MetricSource, stale: false, provenance: prov };
    tiles.push({
      ...base,
      label: "MRR",
      value: "$" + revenue.mrr.toLocaleString() + "/mo",
      // The sub-line makes the measure honest at a glance: it names what is
      // deliberately NOT in this number rather than letting the tile imply
      // it is everything Wing Digital earns.
      sub: revenue.mrrClients.length
        ? `confirmed recurring · ${revenue.mrrClients.map((c) => c.name).join(", ")}`
        : "no confirmed recurring retainer on file",
    });
    tiles.push({ ...base, label: "Active Clients", value: String(revenue.activeClients), sub: `roster: ${revenue.rosterSource}` });
    // A fixed-term deal expiring is a thing Jack needs to see coming rather than
    // discover when the money stops.
    if (revenue.nextExpiry) {
      const e = revenue.nextExpiry;
      tiles.push({
        ...base,
        label: "MRR expiring",
        value: "$" + e.amount.toLocaleString() + "/mo",
        sub: `${e.name} — ${e.monthsRemaining} month${e.monthsRemaining === 1 ? "" : "s"} left, ends ${e.end} unless renewed`,
      });
    }
    if (revenue.unconfirmedTotal > 0) {
      tiles.push({ ...base, label: "Basis unconfirmed", value: "$" + revenue.unconfirmedTotal.toLocaleString(), sub: "no invoice evidence — held out of MRR until confirmed" });
    }
    // Pipeline sits beside the earned number, never inside it.
    if (revenue.pipelineTotal > 0) {
      tiles.push({ ...base, label: "Pipeline", value: "$" + revenue.pipelineTotal.toLocaleString(), sub: "NOT earned — expected/probable only, never added to MRR" });
    }
    updated = revenue.asOf;
  } else if (biz) {
    // Revenue truth unavailable. Fall back to the snapshot, but label it as the
    // stale snapshot it is — never as a live figure.
    const mrr = biz.match(/\*\*MRR:\*\*\s*\$?([\d,]+)/);
    const active = biz.match(/\*\*Active clients:\*\*\s*(\d+)/);
    const bizStale = isStale(bizUpdated, STALE_HOURS.clients);
    const prov = provenanceLine({ source: "snapshot", asOf: bizUpdated, stale: bizStale });
    if (mrr) tiles.push({ key: "clients", label: "MRR", value: "$" + mrr[1] + "/mo", sub: "from snapshot — live roster unreachable", updated: bizUpdated, source: "snapshot", stale: bizStale, provenance: prov });
    if (active) tiles.push({ key: "clients", label: "Active Clients", value: active[1], sub: "from snapshot — live roster unreachable", updated: bizUpdated, source: "snapshot", stale: bizStale, provenance: prov });
    updated = bizUpdated;
  }

  // Sends-today: the single honest answer (live DB, else honest snapshot).
  const st = sendsTodayHonest(live, outreach, outUpdated);

  if (live) {
    // LIVE mode: pipeline / emailed / untouched come straight from the live
    // source (Supabase cloud, else local prospects.db) — labeled per live.source.
    const liveProv = provenanceLine({ source: live.source, asOf: live.asOf, stale: false });
    tiles.push({ key: "pipeline", label: "Pipeline", value: String(live.pipeline), sub: "prospects", updated: live.asOf, source: live.source, stale: false, provenance: liveProv });
    tiles.push({ key: "emails", label: "Emails Sent", value: String(live.emailed), sub: st.display, updated: live.asOf, source: live.source, stale: false, provenance: liveProv });
    tiles.push({ key: "untouched", label: "Untouched Leads", value: String(live.untouched), sub: "new + enriching", updated: live.asOf, source: live.source, stale: false, provenance: liveProv });
  } else if (outreach) {
    // CLOUD / degraded: prospects.db unreachable — snapshot with real staleness.
    const outStale = isStale(outUpdated, STALE_HOURS.pipeline);
    const outProv = provenanceLine({ source: "snapshot", asOf: outUpdated, stale: outStale });
    const pipeline = outreach.match(/\*\*Pipeline:\*\*\s*([\d,]+)/);
    const emailed = outreach.match(/\*\*Emailed:\*\*\s*([\d,]+)/);
    const remaining = outreach.match(/\*\*Remaining[^:]*:\*\*\s*([\d,]+)/);
    if (pipeline) tiles.push({ key: "pipeline", label: "Pipeline", value: pipeline[1], sub: "prospects", updated: outUpdated, source: "snapshot", stale: outStale, provenance: outProv });
    if (emailed) tiles.push({ key: "emails", label: "Emails Sent", value: emailed[1], sub: st.display, updated: st.asOf ?? outUpdated, source: "snapshot", stale: st.stale, provenance: st.stale ? provenanceLine({ source: "snapshot", asOf: st.asOf, stale: true }) : outProv });
    if (remaining) tiles.push({ key: "untouched", label: "Untouched Leads", value: remaining[1], sub: "new + enriching", updated: outUpdated, source: "snapshot", stale: outStale, provenance: outProv });
  }
  void nowIso;
  return { tiles, updated };
}

// ── Stat breakdown panels (?stat=key) ──────────────────────────────────────
// Everything shown is parsed from the real snapshots. Where per-item data is
// not derivable from the snapshot, the panel says so instead of faking rows.

// Rows of the "Last 15 Companies Emailed" table: | Company | City | 2026-08-10 18:31 |
function parseEmailedRows(outreach: string): { company: string; city: string; when: string }[] {
  const rows: { company: string; city: string; when: string }[] = [];
  for (const line of outreach.split(/\r?\n/)) {
    const m = line.match(/^\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*(\d{4}-\d{2}-\d{2}[^|]*?)\s*\|/);
    if (m && !/^-+$/.test(m[1]) && !/^Company$/i.test(m[1])) {
      rows.push({ company: redact(m[1]), city: redact(m[2]), when: m[3].trim() });
    }
  }
  return rows;
}

async function statDetail(id: string) {
  const [biz, outreach, live, rev] = await Promise.all([
    readVaultFile("wiki/state/business-snapshot.md"),
    readVaultFile("wiki/state/outreach-snapshot.md"),
    readOutreachLive(),
    getRevenueTruth().catch(() => null),
  ]);
  const outUpdated = parseSnapshotAsOf(outreach);
  const bizUpdated = parseSnapshotAsOf(biz);
  const num = (src: string | null, re: RegExp) => src?.match(re)?.[1] ?? null;
  // The source line the panel leads with, so every panel states its provenance.
  const outSource: MetricSource = live ? live.source : "snapshot";
  const outAsOf = live ? live.asOf : outUpdated;
  const outStale = live ? false : isStale(outUpdated, STALE_HOURS.pipeline);
  const outProvenance = provenanceLine({ source: outSource, asOf: outAsOf, stale: outStale }, "outreach snapshot");
  const st = sendsTodayHonest(live, outreach, outUpdated);

  if (id === "pipeline") {
    const p = live ? live.pipeline : Number((num(outreach, /\*\*Pipeline:\*\*\s*([\d,]+)/) ?? "0").replace(/,/g, ""));
    const e = live ? live.emailed : Number((num(outreach, /\*\*Emailed:\*\*\s*([\d,]+)/) ?? "0").replace(/,/g, ""));
    const r = live ? live.untouched : Number((num(outreach, /\*\*Remaining[^:]*:\*\*\s*([\d,]+)/) ?? "0").replace(/,/g, ""));
    const other = p - e - r;
    return NextResponse.json({
      id, title: "Pipeline breakdown", updated: outAsOf, available: live ? true : !!outreach,
      source: outSource, stale: outStale, provenance: outProvenance,
      summary: [
        `${p} prospects total in prospects.db.`,
        live ? "Counted live from prospects.db just now." : "From the outreach snapshot; live totals need the PC.",
      ],
      items: (live || outreach) ? [
        { label: "Emailed", value: String(e), note: `${st.display}` },
        { label: "Untouched (new + enriching)", value: String(r), note: "staged, not yet armed" },
        ...(live ? [{ label: "Armed (intent-scored, not emailed)", value: String(live.armed), note: "ready to send" }] : []),
        ...(other > 0 ? [{ label: "Other statuses (ready / closed / dead)", value: String(other), note: "derived: total minus emailed minus untouched" }] : []),
      ] : [],
      note: live ? null : "Per-status detail lives in prospects.db on Jack's PC; the snapshot publishes totals only.",
    });
  }

  if (id === "emails") {
    // Live: today's real rows from the DB. Snapshot: only trustworthy if same-day.
    const todayRows = live
      ? live.recentToday.map((r) => ({ company: redact(r.name), city: redact(r.city), when: r.when }))
      : (st.value === 0 ? [] : parseEmailedRows(outreach ?? "").filter((r) => r.when.startsWith((outUpdated ?? "").slice(0, 10))));
    return NextResponse.json({
      id, title: "Emails sent today", updated: outAsOf, available: live ? true : !!outreach,
      source: outSource, stale: st.stale, provenance: outProvenance,
      summary: [
        live
          ? `${st.value} sends today, counted live from prospects.db.`
          : st.value === 0
            ? st.display + "."
            : `${st.value} sends today per the outreach snapshot.`,
        live && st.value === 0
          ? "The sender has logged no sends today (paused or outside the window)."
          : todayRows.length ? "Recipient businesses and send times below." : "No send rows to show.",
      ],
      items: todayRows.map((r) => ({ label: r.company, value: (r.when.slice(11) || r.when).trim(), note: r.city })),
      note: st.note ?? "Per-contact detail lives in the OS CRM (CRM tab) — search the company name there.",
    });
  }

  if (id === "untouched") {
    const remaining = live ? String(live.untouched) : num(outreach, /\*\*Remaining[^:]*:\*\*\s*([\d,]+)/);
    return NextResponse.json({
      id, title: "Untouched leads", updated: outAsOf, available: live ? true : !!outreach,
      source: outSource, stale: outStale, provenance: outProvenance,
      summary: [
        `${remaining ?? "?"} prospects staged but not yet emailed.`,
        "These sit at status new (just scraped) or enriching (contact + QA pass in progress). They only become sends after rank, QA, and activation.",
      ],
      items: live ? [
        { label: "Untouched (new + enriching)", value: String(live.untouched), note: null },
        { label: "Armed (intent-scored, not emailed)", value: String(live.armed), note: "ready pool" },
      ] : [],
      note: live ? null : "The new-vs-enriching split lives in prospects.db on Jack's PC; the snapshot publishes the combined count.",
    });
  }

  if (id === "clients") {
    const items: { label: string; value: string; note: string | null }[] = [];
    if (rev) {
      // Live per-client rows. Every figure states its basis, so a one-time or
      // expected amount can never be mistaken for a monthly retainer, and an
      // unknown renders as "not recorded" rather than as $0.
      for (const c of rev.clients) {
        items.push({
          label: redact(c.name),
          value: c.amount == null ? "not recorded" : "$" + c.amount.toLocaleString() + (c.basis === "monthly" || c.basis === "term" ? "/mo" : ""),
          note:
            c.amount == null
              ? "no figure on file — unknown, not zero"
              : c.term
                ? `fixed term, ${c.term.monthsRemaining} mo left, ends ${c.term.end}`
                : BASIS_LABEL_MISSION[c.basis] ?? c.basis,
        });
      }
      // Pipeline deals listed after the clients, explicitly marked not-revenue.
      for (const d of rev.pipelineDeals) {
        items.push({
          label: redact(d.name),
          value: d.amount == null ? "amount unknown" : "$" + d.amount.toLocaleString(),
          note: `PIPELINE — ${d.stage}, not earned${d.expectedClose ? `, expected ${d.expectedClose}` : ""}`,
        });
      }
    } else if (biz) {
      for (const line of biz.split(/\r?\n/)) {
        const m = line.match(/^\|\s*([^|*]+?)\s*\|\s*\$?([\d,]+)\s*\|\s*([^|]+?)\s*\|/);
        if (m && !/^Client$/i.test(m[1]) && !/^-+$/.test(m[1])) {
          items.push({ label: redact(m[1]), value: "$" + m[2] + "/mo", note: m[3].trim() });
        }
      }
    }
    const bizStale = isStale(bizUpdated, STALE_HOURS.clients);
    return NextResponse.json({
      id, title: "Active clients",
      updated: rev ? rev.asOf : bizUpdated,
      available: rev ? true : !!biz,
      source: (rev ? "live-db" : "snapshot") as MetricSource,
      stale: rev ? false : bizStale,
      provenance: rev
        ? `Live from the client roster (${rev.rosterSource}) + vault revenue fields, just now`
        : provenanceLine({ source: "snapshot", asOf: bizUpdated, stale: bizStale }, "business snapshot"),
      // Everything only Jack can settle, surfaced where he is looking at the money.
      questions: rev ? rev.questions : [],
      summary: [
        // Derived from the live revenue truth, not regexed out of the snapshot,
        // so this line always agrees with the MRR tile above it.
        rev
          ? `${rev.activeClients} active client${rev.activeClients === 1 ? "" : "s"}. ${rev.mrrBasisLine}`
          : `${num(biz, /\*\*Active clients:\*\*\s*(\d+)/) ?? items.length} active client${items.length === 1 ? "" : "s"}, $${num(biz, /\*\*MRR:\*\*\s*\$?([\d,]+)/) ?? "?"}/mo MRR (from snapshot — live roster unreachable).`,
        "Full client detail lives in the Clients section of the OS.",
      ],
      items,
      note: null,
    });
  }

  return NextResponse.json({ error: `unknown stat '${id}'` }, { status: 404 });
}

// ── Per-agent detail data ──────────────────────────────────────────────────
// Systems each agent touches, with the direction data flows.
// System ids match SYSTEMS in MissionControlCore.tsx (the split map).
interface Wire { id: string; label: string; direction: "reads" | "writes" | "both" }
const AGENT_SYSTEMS: Record<string, Wire[]> = {
  "sentinel-daily": [
    { id: "clients", label: "CLIENTS", direction: "reads" },
    { id: "website", label: "WEB/SEO", direction: "reads" },
    { id: "vault", label: "VAULT", direction: "writes" },
    { id: "scheduler", label: "SCHEDULER", direction: "reads" },
  ],
  "chronicler-end-of-day": [
    { id: "vault", label: "VAULT", direction: "writes" },
    { id: "scheduler", label: "SCHEDULER", direction: "reads" },
  ],
  "content-engine-weekly": [
    { id: "vault", label: "VAULT", direction: "both" },
    { id: "website", label: "WEB/SEO", direction: "writes" },
    { id: "clients", label: "CLIENTS", direction: "writes" },
    { id: "scheduler", label: "SCHEDULER", direction: "reads" },
  ],
  "renewal-content-weekly": [
    { id: "vault", label: "VAULT", direction: "both" },
    { id: "website", label: "WEB/SEO", direction: "writes" },
    { id: "clients", label: "CLIENTS", direction: "writes" },
    { id: "scheduler", label: "SCHEDULER", direction: "reads" },
  ],
  "b2b-outreach-engine": [
    { id: "email", label: "EMAIL", direction: "writes" },
    { id: "ghl-wing", label: "OS CRM", direction: "both" },
    { id: "scheduler", label: "SCHEDULER", direction: "reads" },
  ],
  "b2b-prospector-daily": [
    { id: "vault", label: "VAULT", direction: "writes" },
    { id: "ghl-wing", label: "OS CRM", direction: "reads" },
    { id: "scheduler", label: "SCHEDULER", direction: "reads" },
  ],
  closer: [
    { id: "ghl-wing", label: "OS CRM", direction: "both" },
    { id: "email", label: "EMAIL", direction: "reads" },
    { id: "vault", label: "VAULT", direction: "writes" },
    { id: "scheduler", label: "SCHEDULER", direction: "reads" },
  ],
  "call-prep": [
    { id: "vault", label: "VAULT", direction: "both" },
    { id: "clients", label: "CLIENTS", direction: "reads" },
    { id: "ghl-wing", label: "OS CRM", direction: "reads" },
    { id: "scheduler", label: "SCHEDULER", direction: "reads" },
  ],
  "client-report": [
    { id: "ghl-clients", label: "CLIENT CRM", direction: "reads" },
    { id: "clients", label: "CLIENTS", direction: "reads" },
    { id: "website", label: "WEB/SEO", direction: "reads" },
    { id: "vault", label: "VAULT", direction: "writes" },
    { id: "scheduler", label: "SCHEDULER", direction: "reads" },
  ],
  dispatch: [
    { id: "vault", label: "VAULT", direction: "writes" },
    { id: "ghl-clients", label: "CLIENT CRM", direction: "reads" },
    { id: "ghl-wing", label: "OS CRM", direction: "reads" },
  ],
  "reply-triage": [
    { id: "ghl-clients", label: "CLIENT CRM", direction: "reads" },
    { id: "ghl-wing", label: "OS CRM", direction: "reads" },
    { id: "email", label: "EMAIL", direction: "reads" },
    { id: "vault", label: "VAULT", direction: "writes" },
  ],
  builder: [
    { id: "ghl-clients", label: "CLIENT CRM", direction: "writes" },
    { id: "clients", label: "CLIENTS", direction: "writes" },
  ],
};

// ── Artifact registry ──────────────────────────────────────────────────────
// The concrete files agents produce. These show up as satellite nodes on the
// map; clicking one opens a panel with just that artifact's excerpt.
interface ArtifactMeta {
  id: string;
  label: string;
  system: string; // parent system node on the map
  producedBy: string; // agent key
  path: string; // vault-relative path
  blurb: string;
}
const ARTIFACTS: ArtifactMeta[] = [
  { id: "health-board", label: "Health board", system: "clients", producedBy: "sentinel-daily", path: "wiki/state/health-board.md", blurb: "Sentinel's master per-client health table with red flags." },
  { id: "business-snapshot", label: "Biz snapshot", system: "vault", producedBy: "dispatch", path: "wiki/state/business-snapshot.md", blurb: "The live business state: MRR, active clients, pipeline." },
  { id: "outreach-snapshot", label: "Outreach snapshot", system: "email", producedBy: "b2b-outreach-engine", path: "wiki/state/outreach-snapshot.md", blurb: "Cold-email pipeline counts and send totals." },
  { id: "content-calendar", label: "Content calendar", system: "website", producedBy: "content-engine-weekly", path: "wiki/campaigns/jackson-social-calendar.md", blurb: "Jackson Roofing's rolling content and social calendar." },
  { id: "prospects-db", label: "prospects.db", system: "ghl-wing", producedBy: "b2b-prospector-daily", path: "wiki/automations/prospects-db.md", blurb: "The self-refilling prospect database behind outreach (Supabase + local prospects.db)." },
  { id: "replies-inbox", label: "Replies inbox", system: "ghl-wing", producedBy: "reply-triage", path: "wiki/state/replies-inbox.md", blurb: "Triage page of inbound replies, HOT flagged loudly." },
];

// Distill a markdown state file to its headline numbers/key-value lines.
// "**Pipeline:** 1364 prospects  •  **Emailed:** 184" becomes separate short
// lines. Max 8 lines, each short. Raw excerpt stays available separately.
function distill(raw: string): string[] {
  const out: string[] = [];
  const push = (s: string) => {
    const c = clean(redact(s))
      .replace(/[\u{1F000}-\u{1FBFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}]/gu, "")
      .replace(/^\W+/, "")
      .replace(/\s+/g, " ")
      .trim();
    if (c && out.length < 8) out.push(c.length > 70 ? c.slice(0, 69) + "…" : c);
  };
  for (const line of raw.split(/\r?\n/)) {
    if (out.length >= 8) break;
    const t = line.trim();
    // skip structure: frontmatter, headings, tables, callouts, footers
    if (!t || t.startsWith("---") || t.startsWith("#") || t.startsWith(">") || t.startsWith("|")) continue;
    if (/^(title|tags|updated):/.test(t) || /^_.*_$/.test(t) || /^-\s*$/.test(t)) continue;
    // keep only headline lines: bold key-value stats, "Key: 123" lines, or
    // numbered items. Wrapped prose continuation lines are dropped.
    const isStat = /\*\*[^*]+:\*\*/.test(t);
    const isNumbered = /^\d+\.\s/.test(t);
    const isKv = /^[*_]{0,2}[A-Za-z][^:]{0,40}:[*_]{0,2}\s.*\d/.test(t);
    if (!isStat && !isNumbered && !isKv) continue;
    if (/^[*_\s]*legend/i.test(t)) continue;
    // split "A • B • C" stat rows into separate short lines
    for (const seg of t.split(/\s+[•·]\s+/)) {
      if (isStat && !/\d/.test(seg) && !/:/.test(seg)) continue;
      push(seg);
    }
  }
  return out;
}

async function artifactDetail(id: string) {
  const meta = ARTIFACTS.find((a) => a.id === id);
  if (!meta) return NextResponse.json({ error: `unknown artifact '${id}'` }, { status: 404 });
  const raw = await readVaultFile(meta.path);
  const producer = [...SCHEDULED, ...CREW].find((a) => a.key === meta.producedBy);
  let updated: string | null = null;
  let lines: string[] = [];
  let distilled: string[] = [];
  if (raw) {
    distilled = distill(raw);
    updated =
      raw.match(/\*\*Run date:\*\*\s*([\d-]+)/)?.[1] ??
      raw.match(/_Last updated:\s*([^_]+)_/)?.[1]?.trim() ??
      raw.match(/^updated:\s*(\S+)/m)?.[1] ??
      null;
    lines = raw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("---"))
      .slice(0, 20)
      .map((l) => clean(redact(l)).slice(0, 200));
  }
  // Real outbound links for artifacts that mirror a live system. Only URL
  // patterns constructible from real data (documented GHL location ids).
  // GoHighLevel deep links removed 2026-08-22 (GHL retired, links dead). The
  // live data now lives in the OS's own CRM tab, same app — no external link.
  const links: { label: string; url: string }[] = [];
  return NextResponse.json({
    id: meta.id,
    label: meta.label,
    blurb: meta.blurb,
    links,
    system: meta.system,
    producedBy: meta.producedBy,
    producedByName: producer?.name ?? meta.producedBy,
    path: meta.path,
    available: !!raw,
    updated,
    lines,
    distilled,
  });
}

// Cron schedules in plain words (per agent key).
const CRON_HUMAN: Record<string, string> = {
  "sentinel-daily": "Runs every day at 7:00 in the morning, right after Dispatch.",
  "chronicler-end-of-day": "Runs every day at 9:52 at night, after the workday ends.",
  "content-engine-weekly": "Runs every Monday morning at 7:10.",
  "renewal-content-weekly": "Runs every Monday morning at 7:44.",
  "b2b-outreach-engine": "Runs every 30 minutes from 8 in the morning to 8 at night, every day. Each run checks the send window and daily cap, dry-runs, then fires for real if clean.",
  "b2b-prospector-daily": "Runs every day at 6:15 in the morning, before the outreach window opens, to refill the lead pipeline.",
  closer: "In trial, currently disabled in the scheduler. When armed it would run every 30 to 60 minutes during business hours (8am to 6pm). For now, run it by hand: say \"run closer\".",
  "call-prep": "In trial, currently disabled in the scheduler. When armed it would run early each morning right after Dispatch. For now, run it by hand: say \"run call-prep\".",
  "client-report": "In trial, currently disabled in the scheduler. When armed it would run on the 1st of each month for each paying client. For now, run it by hand: say \"run client-report for [client]\".",
};

// Concise role text used when no SKILL.md is on disk (cloud mode, crew agents).
const ROLE_LONG: Record<string, string> = {
  "sentinel-daily":
    "Per-client health monitor. Every day it runs a fixed 5-pillar checklist per client (SEO foundation, content quality and brand safety, website health, CRM/outreach, onboarding completeness), scores each pillar green/yellow/red, writes one condensed health page per client plus the master health board, and surfaces red flags loudly. Report-only: it checks and recommends, never fixes.",
  "chronicler-end-of-day":
    "End-of-day vault historian. Reads new Claude Code conversation content since its last run, sorts it into facts and ideas, scrubs secrets, appends a digest to the vault inbox, files ideas onto the idea backlog, and updates log.md and hot.md for high-confidence facts.",
  "content-engine-weekly":
    "Jackson Roofing weekly SEO content producer. Refreshes the live content calendar, writes the week's 2 blog drafts plus the Google Business post copy and the Wednesday rotation outline. Never produces insurance content.",
  "renewal-content-weekly":
    "Renewal Health (Lynette Wing) weekly content engine. Mirror of Jackson's content engine adapted for her static site and health/YMYL rules: 2 blog posts and a service page, Pexels images, health-claim gate, then publishes via the static-site publisher. No diagnose/treat/cure claims, ever.",
  "b2b-outreach-engine":
    "Wing Digital's live B2B cold-email campaign, approved live by Jack on 2026-08-06. Every 30 minutes between 8am and 8pm it checks the send window and daily cap, dry-runs the outreach script, and only fires real sends when the dry run is clean. Never exceeds the daily cap, never touches client accounts, and stops loudly if anything looks broken.",
  "b2b-prospector-daily":
    "Daily 6:15am lead scout. Runs b2b-lead-find to scan DFW for high-value B2B, warehouse, and commercial-ops leads using the free scrapers (Google Maps + OpenStreetMap) and stages them in prospects.db so the outreach engine never runs dry. Finds and stages only, never sends.",
  closer:
    "Closer agent, in trial (disabled). Turns HOT and WARM cold-email replies from Wing Digital's own B2B outreach into booked 15-minute calls. Reads each prospect's full reply thread in the OS CRM, drafts a personalized, human, non-salesy reply that drives to the booking link, and queues it. Draft-only by default: it never sends to a real prospect without the closer:reply autonomy grant. Surfaces HOT drafts loudly so no hot lead rots.",
  "call-prep":
    "Call-Prep agent, in trial (disabled). Consumes Dispatch's ordered dial list and, for each prospect, produces a skimmable one-page brief: overview, the online-presence gaps Wing fixes, the decision-maker, a tailored opener, and the single strongest value hook, so Jack walks into every call informed.",
  "client-report":
    "Client-Report agent, in trial (disabled). On the 1st of each month, for each paying client, it pulls the month's real numbers (new leads, appointments, opportunities, content published with live links, GSC rankings and traffic, wins), computes month-over-month deltas, and assembles a branded, client-facing value report. Honest: zeros and declines are shown with context, never faked. Never auto-sends; it builds the deliverable and surfaces it for Jack to review and send.",
  dispatch:
    "Morning briefing agent. Regenerates campaign data, orders the day's dial list, checks the OS CRM, and writes a one-page briefing so Jack is call-ready.",
  prospector:
    "Lead scout. Scans new DFW cities for leads, stages them as enriching, runs full enrichment, and produces a ready-to-promote list for Jack's approval.",
  outreach:
    "B2B cold email sender, live since 8/6. Checks the send window and daily cap, dry-runs the outreach script, then fires for real if clean. Logs every run.",
  "reply-triage":
    "Reply triage. Scans the outreach reply inbox for unread prospect replies, classifies each HOT/WARM/COLD, writes a condensed triage page into the vault, and surfaces HOT replies loudly.",
  builder:
    "Retired. This was the GoHighLevel onboarding runner; GHL was fully retired 2026-08-22 and client onboarding has no automated replacement yet — onboarding is run by hand (say \"onboard [client]\").",
};

// Read the agent's SKILL.md description from the local scheduled-tasks dir.
function readSkillDescription(key: string): string | null {
  try {
    const p = path.join(SCHEDULED_DIR, key, "SKILL.md");
    const raw = fs.readFileSync(p, "utf-8");
    // frontmatter description: field, else first non-heading paragraph
    const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (fm) {
      const m = fm[1].match(/^description:\s*([\s\S]*?)(?=\n\w[\w_-]*:|$)/m);
      if (m) {
        const d = m[1].replace(/^[>|]-?\s*/, "").replace(/\s+/g, " ").trim();
        if (d) return redact(d).slice(0, 900);
      }
    }
    const body = fm ? raw.slice(fm[0].length) : raw;
    const para = body
      .split(/\r?\n\r?\n/)
      .map((s) => s.trim())
      .find((s) => s && !s.startsWith("#"));
    return para ? redact(para.replace(/\s+/g, " ")).slice(0, 900) : null;
  } catch {
    return null;
  }
}

// Artifacts: what this agent most recently produced, when we know where to look.
async function buildArtifact(key: string): Promise<{ title: string; lines: string[] } | null> {
  const pick = async (rel: string, title: string, max = 14) => {
    const raw = await readVaultFile(rel);
    if (!raw) return null;
    const lines = raw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("---"))
      .slice(0, max)
      .map((l) => clean(redact(l)).slice(0, 200));
    return lines.length ? { title, lines, distilled: distill(raw) } : null;
  };
  if (key === "sentinel-daily") return pick("wiki/state/health-board.md", "Latest health board", 18);
  if (key === "b2b-outreach-engine" || key === "b2b-prospector-daily")
    return pick("wiki/state/outreach-snapshot.md", "Outreach snapshot");
  if (key === "dispatch") return pick("wiki/state/business-snapshot.md", "Business snapshot");
  if (key === "reply-triage") return pick("wiki/state/reply-triage.md", "Latest triage page");
  return null;
}

async function agentDetail(key: string) {
  const meta =
    SCHEDULED.find((s) => s.key === key) ??
    CREW.map((c) => ({
      key: c.key, name: c.name, role: c.role, schedule: "On demand",
      enabled: true, match: c.match, next: () => null as Date | null,
    })).find((s) => s.key === key);
  if (!meta) {
    return NextResponse.json({ error: `unknown agent '${key}'` }, { status: 404 });
  }

  const [logRaw, wdRaw, heartbeats] = await Promise.all([
    readVaultFile("wiki/log.md"),
    readVaultFile("wiki/state/watchdog.md"),
    readHeartbeats(),
  ]);
  const filesFacts = filesFactsOf(heartbeatFor(heartbeats, key, meta?.name ?? key));
  const watchdogState = watchdogStateFor(parseWatchdog(wdRaw), meta.key, meta.name);
  // Last ~200 log entries, newest first, filtered to this agent.
  const all = logRaw ? parseLog(logRaw).slice(-200).reverse() : [];
  const mine = all
    .filter((e) => meta.match.test(e.title) || meta.match.test(e.type) || e.lines.some((l) => meta.match.test(l)));
  // Rolling 7-day window: older history adds noise; the panel notes it exists.
  const weekAgo = Date.now() - 7 * 86400000;
  const activity = mine.filter((e) => new Date(e.date).getTime() >= weekAgo).slice(0, 40);
  const olderActivity = mine.length - activity.length;

  const { present, state } = readScheduledDisk();
  const st = state.get(key);
  const isScheduled = SCHEDULED.some((s) => s.key === key);
  const nextAt = st?.nextRunAt
    ? new Date(st.nextRunAt)
    : meta.enabled && isScheduled ? meta.next() : null;

  const description = readSkillDescription(key) ?? ROLE_LONG[key] ?? meta.role;
  const artifact = await buildArtifact(key);

  const trial = isTrial(meta.key, meta.enabled);
  let status = "idle";
  if (!meta.enabled) status = trial ? "trial" : "disabled";
  else if (activity.length && (Date.now() - new Date(activity[0].date).getTime()) / 86400000 <= 2) status = "active";
  else if (nextAt) status = "scheduled";

  // Plain-English 3-liner the panel leads with: what / did last / happens next.
  const summary = {
    what:
      watchdogState && watchdogState !== "OK"
        ? `${watchdogState} per the latest report from The Boss. ${meta.role}`
        : meta.role,
    last: activity.length
      ? `Last seen ${activity[0].date}: ${activity[0].title.slice(0, 90)}`
      : st?.lastRunAt || st?.lastRun
        ? `Last run ${new Date(st.lastRunAt ?? st.lastRun).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}.`
        : "No recorded activity yet.",
    next: !meta.enabled
      ? trial
        ? "In trial, disabled in the scheduler. Run it now: tell Claude to run it by hand."
        : "Disabled. Nothing scheduled."
      : nextAt
        ? `Next run ${nextAt.toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit" })}.`
        : isScheduled
          ? "Waiting on the scheduler."
          : "Runs on demand, when Jack asks.",
  };

  return NextResponse.json({
    key,
    name: meta.name,
    kind: isScheduled ? "scheduled" : "crew",
    role: meta.role,
    description,
    schedule: meta.schedule,
    scheduleHuman: isScheduled ? CRON_HUMAN[key] ?? meta.schedule : "Runs on demand, when Jack asks for it.",
    enabled: meta.enabled,
    trial,
    status,
    watchdogState,
    installed: present.size > 0 ? present.has(key) : null,
    lastRunAt: st?.lastRunAt ?? st?.lastRun ?? null,
    nextRunAt: nextAt ? nextAt.toISOString() : null,
    summary,
    systems: AGENT_SYSTEMS[key] ?? [{ id: "vault", label: "VAULT", direction: "both" }],
    filesFacts,
    activity,
    olderActivity,
    artifact,
  });
}

// ── Vault files updated today ──────────────────────────────────────────────
// Best source: the vault git history (the vault is a git repo synced to
// wing-os-vault). Count DISTINCT files touched in commits dated today. If git
// is unavailable (e.g. cloud/GitHub-read mode has no local checkout), fall back
// to scanning file mtimes under the vault. Returns null when neither works.
function countVaultFilesToday(): { count: number; source: "git" | "mtime" } | null {
  // Local git first.
  if (!isGithubVault()) {
    try {
      const out = execSync(
        'git log --since="midnight" --name-only --pretty=format:',
        { cwd: VAULT_PATH, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 8000 }
      );
      const files = new Set(
        out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
      );
      return { count: files.size, source: "git" };
    } catch {
      /* git missing or not a repo — fall through to mtime scan */
    }
    // mtime fallback: count .md files under the vault modified since midnight.
    try {
      const start = new Date();
      start.setHours(0, 0, 0, 0);
      const startMs = start.getTime();
      let count = 0;
      const walk = (dir: string) => {
        let entries: fs.Dirent[] = [];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          if (e.name.startsWith(".") || e.name === "node_modules") continue;
          const full = path.join(dir, e.name);
          if (e.isDirectory()) walk(full);
          else {
            try { if (fs.statSync(full).mtimeMs >= startMs) count++; } catch { /* skip */ }
          }
        }
      };
      walk(VAULT_PATH);
      return { count, source: "mtime" };
    } catch {
      return null;
    }
  }
  return null;
}

// ── Scheduled content posts (from the content calendar cadence) ─────────────
// The Jackson social calendar documents a real recurring cadence, e.g.
// "Facebook 3x/week (Mon/Wed/Fri), Nextdoor 2x/week (Tue/Sat), Google Business
// Profile 1x/week (Thu)". We surface that documented cadence as recurring
// content-calendar entries so the scheduler shows planned posts alongside agent
// task fires. Days are Monday-based indices (0=Mon..6=Sun). Never fabricated:
// if the cadence line is absent, no content entries are returned.
const DAY_TOKEN: Record<string, number> = {
  mon: 0, tue: 1, tues: 1, wed: 2, weds: 2, thu: 3, thur: 3, thurs: 3,
  fri: 4, sat: 5, sun: 6,
};
const PLATFORM_COLOR: Record<string, string> = {
  facebook: "#60a5fa", nextdoor: "#34d399", "google business": "#fbbf24",
  "google business profile": "#fbbf24", instagram: "#f472b6",
};
interface ContentCalItem { client: string; platform: string; color: string; days: number[]; note: string }

function parseContentSchedule(calendarRaw: string | null): ContentCalItem[] {
  if (!calendarRaw) return [];
  const cadence = calendarRaw.match(/Cadence baseline:\s*([^\n]+)/i)?.[1];
  if (!cadence) return [];
  const items: ContentCalItem[] = [];
  // Match "Facebook 3x/week (Mon/Wed/Fri)" style groups.
  const re = /([A-Za-z][A-Za-z ]*?)\s*\d*\s*x?\s*\/\s*week\s*\(([^)]+)\)/gi;
  for (const m of cadence.matchAll(re)) {
    const platform = m[1].trim().replace(/\s+/g, " ");
    const days = m[2]
      .split(/[\/,]/)
      .map((d) => DAY_TOKEN[d.trim().toLowerCase().slice(0, 5)] ?? DAY_TOKEN[d.trim().toLowerCase().slice(0, 4)] ?? DAY_TOKEN[d.trim().toLowerCase().slice(0, 3)])
      .filter((n) => n !== undefined) as number[];
    if (!days.length) continue;
    const key = platform.toLowerCase();
    items.push({
      client: "Jackson Roofing",
      platform,
      color: PLATFORM_COLOR[key] ?? "#a78bfa",
      days: [...new Set(days)],
      note: redact(cadence.trim()).slice(0, 200),
    });
  }
  return items;
}

// ── agent feed (os_feed) ───────────────────────────────────────────────────
// What the scheduled agents reported through /api/notify. Read here with the
// service key so the browser never sees the ingest key. Degrades to [] when
// Supabase is unreachable or the table has not been created yet.
interface AgentFeedRow {
  id: number;
  agent: string;
  title: string;
  body: string | null;
  url: string | null;
  level: string;
  created_at: string;
  meta?: { files_changed?: number; files?: string[] } | null;
  filesChanged?: number | null;
  files?: string[];
}

async function readAgentFeed(): Promise<AgentFeedRow[]> {
  const rows = await sbSelect<AgentFeedRow>({
    table: "os_feed",
    select: "id,agent,title,body,url,level,created_at,meta",
    service: true,
    query: "order=created_at.desc&limit=25",
  });
  return rows.map((r) => ({
    ...r,
    agent: clean(redact(r.agent)).slice(0, 80),
    title: clean(redact(r.title)).slice(0, 120),
    body: r.body ? clean(redact(r.body)).slice(0, 500) : null,
    // Honest surface: only present when the run actually reported a count.
    filesChanged: typeof r.meta?.files_changed === "number" ? r.meta.files_changed : null,
    files: Array.isArray(r.meta?.files) ? r.meta!.files!.slice(0, 25).map((f) => redact(String(f)).slice(0, 300)) : undefined,
    meta: undefined,
  }));
}

// ── agent heartbeats (agent_heartbeats via /api/heartbeat) ─────────────────
// Local + cloud runners upsert one row per agent; meta may carry the run's
// files_changed count and short file list. Read with the service key here so
// the browser never needs the ingest key. Degrades to [] when unreachable.
interface HeartbeatRow {
  agent: string;
  status: string;
  message: string | null;
  last_beat: string;
  meta?: { files_changed?: number; files_changed_at?: string; files?: string[] } | null;
}

async function readHeartbeats(): Promise<HeartbeatRow[]> {
  return sbSelect<HeartbeatRow>({
    table: "agent_heartbeats",
    select: "agent,status,message,last_beat,meta",
    service: true,
    query: "order=last_beat.desc&limit=50",
  });
}

// Loose match a heartbeat agent name to a roster key/name (same spirit as
// watchdogStateFor): "renewal-content" beats match the renewal-content-weekly
// card, "outreach" beats match the outreach engine.
function heartbeatFor(rows: HeartbeatRow[], key: string, name: string): HeartbeatRow | null {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const nk = norm(key), nn = norm(name);
  for (const r of rows) {
    const w = norm(r.agent);
    if (!w) continue;
    if (w === nk || w === nn || nk.includes(w) || w.includes(nn) || nn.includes(w)) return r;
  }
  return null;
}

// The files-changed facts a card/panel renders, or null when never reported.
function filesFactsOf(hb: HeartbeatRow | null): { filesChanged: number; filesChangedAt: string | null; files: string[] } | null {
  if (!hb || typeof hb.meta?.files_changed !== "number") return null;
  return {
    filesChanged: hb.meta.files_changed,
    filesChangedAt: hb.meta.files_changed_at ?? hb.last_beat ?? null,
    files: Array.isArray(hb.meta.files) ? hb.meta.files.slice(0, 25).map((f) => redact(String(f)).slice(0, 300)) : [],
  };
}

// ── main handler ───────────────────────────────────────────────────────────
export async function GET(req: NextRequest) {
  const agentKey = req.nextUrl.searchParams.get("agent");
  if (agentKey) return agentDetail(agentKey);
  const artifactId = req.nextUrl.searchParams.get("artifact");
  if (artifactId) return artifactDetail(artifactId);
  const statId = req.nextUrl.searchParams.get("stat");
  if (statId) return statDetail(statId);

  const cloud = isGithubVault();

  const [logRaw, hotRaw, healthRaw, bizRaw, outreachRaw, repliesRaw, watchdogRaw, contentCalRaw, live] = await Promise.all([
    readVaultFile("wiki/log.md"),
    readVaultFile("wiki/hot.md"),
    readVaultFile("wiki/state/health-board.md"),
    readVaultFile("wiki/state/business-snapshot.md"),
    readVaultFile("wiki/state/outreach-snapshot.md"),
    readVaultFile("wiki/state/replies-inbox.md"),
    readVaultFile("wiki/state/watchdog.md"),
    readVaultFile("wiki/campaigns/jackson-social-calendar.md"),
    readOutreachLive(),
  ]);

  // What the agents reported through /api/notify since the last look, plus
  // the latest heartbeat per agent (which may carry files-changed facts).
  const [agentFeed, heartbeats] = await Promise.all([readAgentFeed(), readHeartbeats()]);

  // Vault activity today (git-first, mtime fallback) + scheduled content posts.
  const vaultToday = countVaultFilesToday();
  const scheduledContent = parseContentSchedule(contentCalRaw);

  const watchdog = parseWatchdog(watchdogRaw);

  // Activity feed: last 50 entries, newest first
  const feed = logRaw ? parseLog(logRaw).slice(-50).reverse() : [];

  // Scheduled agents
  const { present, state } = readScheduledDisk();
  const localDiskOk = present.size > 0;
  const lastMention = (re: RegExp): FeedEntry | undefined =>
    feed.find((e) => re.test(e.title) || e.lines.some((l) => re.test(l)));

  const scheduledAgents = SCHEDULED.map((s) => {
    const st = state.get(s.key);
    const nextAt = st?.nextRunAt ? new Date(st.nextRunAt) : s.enabled ? s.next() : null;
    const lastRunAt = st?.lastRunAt ?? st?.lastRun ?? null;
    const mention = lastMention(s.match);
    return {
      kind: "scheduled" as const,
      key: s.key,
      name: s.name,
      role: s.role,
      schedule: s.schedule,
      enabled: s.enabled,
      trial: isTrial(s.key, s.enabled),
      pcNeeded: !localDiskOk,
      installed: localDiskOk ? present.has(s.key) : null,
      lastRunAt,
      nextRunAt: nextAt ? nextAt.toISOString() : null,
      lastLogDate: mention?.date ?? null,
      lastLogLine: mention ? clean(mention.title) : null,
      watchdogState: watchdogStateFor(watchdog, s.key, s.name),
      filesFacts: filesFactsOf(heartbeatFor(heartbeats, s.key, s.name)),
    };
  });

  const crewAgents = CREW.map((c) => {
    const mention = feed.find((e) => c.match.test(e.title) || c.match.test(e.type));
    return {
      kind: "crew" as const,
      key: c.key,
      name: c.name,
      role: c.role,
      schedule: "On demand",
      enabled: true,
      trial: false,
      pcNeeded: false,
      installed: null,
      lastRunAt: null,
      nextRunAt: null,
      lastLogDate: mention?.date ?? null,
      lastLogLine: mention ? clean(mention.title) : null,
      watchdogState: watchdogStateFor(watchdog, c.key, c.name),
      filesFacts: filesFactsOf(heartbeatFor(heartbeats, c.key, c.name)),
    };
  });

  // Current focus
  const hot = hotRaw ? parseHot(hotRaw) : {};
  const focus = {
    currentFocus: (hot["Current Focus"] ?? []).map(clean).slice(0, 14),
    openQuestions: (hot["Open Questions"] ?? []).filter((l) => l.trim().startsWith("-")).map((l) => clean(l.replace(/^\s*-\s*/, ""))).slice(0, 10),
    recentDecisions: (hot["Recent Decisions"] ?? []).filter((l) => l.trim().startsWith("-")).map((l) => clean(l.replace(/^\s*-\s*/, ""))).slice(0, 8),
    lastOperations: (hot["Last Operations"] ?? []).map(clean).slice(0, 10),
    updated: hotRaw?.match(/^updated:\s*(\S+)/m)?.[1] ?? null,
  };

  // Client health (each client gets its live-site origin, derived from real
  // links already on the board)
  const health = healthRaw ? parseHealthBoard(healthRaw) : { runDate: null, clients: [] };
  const clientSites = deriveClientSites(health.clients, healthRaw);
  for (const c of health.clients) c.site = clientSites[c.client] ?? null;

  // Published this week (rolling 7-day window) for the Web/SEO panel
  const publishes = parsePublishes(feed, healthRaw);

  // Stats
  // Revenue truth is computed live; if it fails, buildStats degrades to the
  // labelled snapshot rather than showing nothing or a fabricated figure.
  const revenueTruth = await getRevenueTruth().catch(() => null);
  const stats = buildStats(bizRaw, outreachRaw, live, revenueTruth);

  // Volume badges for the ops map. Every badge carries the same provenance as
  // the tiles: source + asOf + stale, so no confident stale number ever shows.
  const outAsOf = live ? live.asOf : parseSnapshotAsOf(outreachRaw);
  const bizAsOf = parseSnapshotAsOf(bizRaw);
  interface Vol { value: string; sub: string | null; source: MetricSource; asOf: string | null; stale: boolean }
  const volumes: { systems: Record<string, Vol>; artifacts: Record<string, Vol> } = {
    systems: {},
    artifacts: {},
  };
  {
    const st = sendsTodayHonest(live, outreachRaw, parseSnapshotAsOf(outreachRaw));
    const emailed = live ? String(live.emailed) : outreachRaw?.match(/\*\*Emailed:\*\*\s*([\d,]+)/)?.[1];
    const pipeline = live ? String(live.pipeline) : outreachRaw?.match(/\*\*Pipeline:\*\*\s*([\d,]+)/)?.[1];
    const outStale = live ? false : isStale(parseSnapshotAsOf(outreachRaw), STALE_HOURS.pipeline);
    const src: MetricSource = live ? live.source : "snapshot";
    // EMAIL badge shows sends-today honestly (0 today, not yesterday's count).
    if (st.value != null || emailed) {
      volumes.systems["email"] = {
        value: st.display, sub: emailed ? `/ ${emailed} sent` : null,
        source: st.source, asOf: st.asOf, stale: st.stale,
      };
    }
    if (pipeline) {
      volumes.systems["ghl-wing"] = { value: pipeline, sub: "pipeline", source: src, asOf: outAsOf, stale: outStale };
      volumes.artifacts["prospects-db"] = { value: pipeline, sub: "prospects", source: src, asOf: outAsOf, stale: outStale };
    }
  }
  if (bizRaw) {
    const active = bizRaw.match(/\*\*Active clients:\*\*\s*(\d+)/)?.[1];
    const bizStale = isStale(bizAsOf, STALE_HOURS.clients);
    if (active) volumes.systems["clients"] = { value: active, sub: "active", source: "snapshot", asOf: bizAsOf, stale: bizStale };
  }
  // Web/SEO: publishes this week counted from log.md entries mentioning a publish.
  {
    const weekAgo = Date.now() - 7 * 86400000;
    const publishes = feed.filter(
      (e) => new Date(e.date).getTime() >= weekAgo && /publish|posted|went live/i.test(e.title)
    ).length;
    // Rolling 7-day count from log.md — not time-critical, marked snapshot.
    if (publishes > 0) volumes.systems["website"] = { value: String(publishes), sub: "pub/wk", source: "snapshot", asOf: null, stale: false };
  }
  if (repliesRaw) {
    const m = repliesRaw.match(/\*\*(\d+)\s*hot\s*\/\s*(\d+)\s*warm\s*\/\s*(\d+)\s*cold\*\*/i);
    if (m) {
      const total = Number(m[1]) + Number(m[2]) + Number(m[3]);
      const repAsOf = parseSnapshotAsOf(repliesRaw);
      volumes.artifacts["replies-inbox"] = { value: String(total), sub: "waiting", source: "snapshot", asOf: repAsOf, stale: isStale(repAsOf, STALE_HOURS.outreach) };
    }
  }

  // Overall system light: red if any client red or any expected feed silence
  const anyRed = health.clients.some((c) => c.overall === "red");
  const anyYellow = health.clients.some((c) => c.overall === "yellow");
  const overall: "green" | "yellow" | "red" = anyRed ? "red" : anyYellow ? "yellow" : "green";

  return NextResponse.json({
    generatedAt: new Date().toISOString(),
    cloud,
    sources: {
      log: !!logRaw,
      hot: !!hotRaw,
      health: !!healthRaw,
      business: !!bizRaw,
      outreach: !!outreachRaw,
      scheduledDisk: localDiskOk,
      watchdog: watchdog.available,
      prospectsDb: !!live, // live outreach truth reachable vs snapshot-only
      // Where the live outreach vitals came from this request: Supabase cloud
      // (source of truth now that sending moved off the PC), the local
      // prospects.db, or the honest snapshot fallback.
      outreachSource: (live ? live.source : "snapshot") as MetricSource,
    },
    overall,
    watchdog,
    agents: [...scheduledAgents, ...crewAgents],
    feed,
    agentFeed,
    focus,
    health,
    stats,
    volumes,
    publishes,
    vaultToday,
    scheduledContent,
  });
}
