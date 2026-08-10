import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { readVaultFile, isGithubVault } from "../../../lib/vaultSource";

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

const SCHEDULED: ScheduledMeta[] = [
  { key: "sentinel-daily", name: "Sentinel", role: "Per-client health monitor, 5-pillar daily checkup", schedule: "Daily 7:00am", enabled: true, match: /\bsentinel\b/i, next: () => nextDaily(7, 0) },
  { key: "chronicler-end-of-day", name: "Chronicler", role: "End-of-day vault historian, digests chats into the brain", schedule: "Daily 9:52pm", enabled: true, match: /\bchronicler\b/i, next: () => nextDaily(21, 52) },
  { key: "content-engine-weekly", name: "Content Engine", role: "Jackson Roofing weekly SEO content producer", schedule: "Mon 7:10am", enabled: true, match: /content[- ]engine|jackson.*(blog|content|post)/i, next: () => nextWeekly(1, 7, 10) },
  { key: "renewal-content-weekly", name: "Renewal Engine", role: "Renewal Health weekly content, health-gated publishing", schedule: "Mon 7:44am", enabled: true, match: /\brenewal\b/i, next: () => nextWeekly(1, 7, 44) },
  { key: "wing-digital-daily-outreach", name: "Daily Outreach Task", role: "Scheduled outreach runner (superseded by the live sender)", schedule: "Disabled", enabled: false, match: /daily outreach/i, next: () => null },
  { key: "wing-audit-roofing-batch", name: "Audit Batch", role: "Batch sales audits for roofing prospects", schedule: "Disabled", enabled: false, match: /\baudit\b/i, next: () => null },
];

// On-demand crew: static roster, last-seen resolved from log.md.
const CREW = [
  { key: "dispatch", name: "Dispatch", role: "Morning briefing, orders the day's dial list", match: /dispatch/i },
  { key: "prospector", name: "Prospector", role: "Lead scout, scans DFW cities for prospects", match: /prospector|lead scan|lead-find/i },
  { key: "outreach", name: "Outreach", role: "B2B cold email sender, LIVE since 8/6", match: /outreach|cold email|b2b/i },
  { key: "reply-triage", name: "Reply-Triage", role: "Classifies inbound replies HOT/WARM/COLD", match: /reply-triage|triage/i },
  { key: "builder", name: "Builder", role: "Client onboarding runner in GHL", match: /builder|onboard/i },
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

// ── stats parsing ──────────────────────────────────────────────────────────
interface StatTile { label: string; value: string; sub: string | null }

function parseStats(biz: string | null, outreach: string | null): { tiles: StatTile[]; updated: string | null } {
  const tiles: StatTile[] = [];
  let updated: string | null = null;
  if (biz) {
    const mrr = biz.match(/\*\*MRR:\*\*\s*\$?([\d,]+)/);
    const active = biz.match(/\*\*Active clients:\*\*\s*(\d+)/);
    if (mrr) tiles.push({ label: "MRR", value: "$" + mrr[1] + "/mo", sub: null });
    if (active) tiles.push({ label: "Active Clients", value: active[1], sub: null });
    updated = biz.match(/_Last updated:\s*([^_]+)_/)?.[1]?.trim() ?? null;
  }
  if (outreach) {
    const pipeline = outreach.match(/\*\*Pipeline:\*\*\s*([\d,]+)/);
    const emailed = outreach.match(/\*\*Emailed:\*\*\s*([\d,]+)/);
    const remaining = outreach.match(/\*\*Remaining[^:]*:\*\*\s*([\d,]+)/);
    const today = outreach.match(/\*\*Sent today:\*\*\s*([\d,]+)/);
    if (pipeline) tiles.push({ label: "Pipeline", value: pipeline[1], sub: "prospects" });
    if (emailed) tiles.push({ label: "Emails Sent", value: emailed[1], sub: today ? `${today[1]} today` : null });
    if (remaining) tiles.push({ label: "Untouched Leads", value: remaining[1], sub: "new + enriching" });
  }
  return { tiles, updated };
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
  "wing-digital-daily-outreach": [
    { id: "email", label: "EMAIL", direction: "writes" },
    { id: "scheduler", label: "SCHEDULER", direction: "reads" },
  ],
  "wing-audit-roofing-batch": [
    { id: "vault", label: "VAULT", direction: "writes" },
    { id: "ghl-wing", label: "GHL WING", direction: "reads" },
  ],
  dispatch: [
    { id: "vault", label: "VAULT", direction: "writes" },
    { id: "ghl-clients", label: "GHL", direction: "reads" },
    { id: "ghl-wing", label: "GHL WING", direction: "reads" },
  ],
  prospector: [
    { id: "vault", label: "VAULT", direction: "writes" },
    { id: "ghl-wing", label: "GHL WING", direction: "reads" },
  ],
  outreach: [
    { id: "email", label: "EMAIL", direction: "writes" },
    { id: "ghl-wing", label: "GHL WING", direction: "both" },
  ],
  "reply-triage": [
    { id: "ghl-clients", label: "GHL", direction: "reads" },
    { id: "ghl-wing", label: "GHL WING", direction: "reads" },
    { id: "email", label: "EMAIL", direction: "reads" },
    { id: "vault", label: "VAULT", direction: "writes" },
  ],
  builder: [
    { id: "ghl-clients", label: "GHL", direction: "writes" },
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
  { id: "outreach-snapshot", label: "Outreach snapshot", system: "email", producedBy: "outreach", path: "wiki/state/outreach-snapshot.md", blurb: "Cold-email pipeline counts and send totals." },
  { id: "content-calendar", label: "Content calendar", system: "website", producedBy: "content-engine-weekly", path: "wiki/campaigns/jackson-social-calendar.md", blurb: "Jackson Roofing's rolling content and social calendar." },
  { id: "prospects-db", label: "prospects.db", system: "ghl-wing", producedBy: "prospector", path: "wiki/automations/prospects-db.md", blurb: "The self-refilling prospect database behind outreach." },
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
  return NextResponse.json({
    id: meta.id,
    label: meta.label,
    blurb: meta.blurb,
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
  "wing-digital-daily-outreach": "Disabled. Superseded by the live outreach sender.",
  "wing-audit-roofing-batch": "Disabled. Runs only when triggered by hand.",
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
  "wing-digital-daily-outreach":
    "Legacy scheduled outreach runner. Superseded by the live outreach sender that runs every 15 minutes during business hours.",
  "wing-audit-roofing-batch":
    "Batch sales-audit generator. Runs Wing Digital audits on roofing prospects and produces a branded one-page PDF per business, wired into the call sheet.",
  dispatch:
    "Morning briefing agent. Regenerates campaign data, orders the day's dial list, checks GHL, and writes a one-page briefing so Jack is call-ready.",
  prospector:
    "Lead scout. Scans new DFW cities for leads, stages them as enriching, runs full enrichment, and produces a ready-to-promote list for Jack's approval.",
  outreach:
    "B2B cold email sender, live since 8/6. Checks the send window and daily cap, dry-runs the outreach script, then fires for real if clean. Logs every run.",
  "reply-triage":
    "Reply triage. Scans both GHL accounts for unread prospect replies, classifies each HOT/WARM/COLD, writes a condensed triage page into the vault, and surfaces HOT replies loudly.",
  builder:
    "Client onboarding runner. When a new client signs, executes the full onboarding SOP in GHL and hands Jack the UI-only checklist.",
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
  if (key === "outreach" || key === "wing-digital-daily-outreach")
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

  const logRaw = await readVaultFile("wiki/log.md");
  // Last ~200 log entries, newest first, filtered to this agent.
  const all = logRaw ? parseLog(logRaw).slice(-200).reverse() : [];
  const activity = all
    .filter((e) => meta.match.test(e.title) || meta.match.test(e.type) || e.lines.some((l) => meta.match.test(l)))
    .slice(0, 40);

  const { present, state } = readScheduledDisk();
  const st = state.get(key);
  const isScheduled = SCHEDULED.some((s) => s.key === key);
  const nextAt = st?.nextRunAt
    ? new Date(st.nextRunAt)
    : meta.enabled && isScheduled ? meta.next() : null;

  const description = readSkillDescription(key) ?? ROLE_LONG[key] ?? meta.role;
  const artifact = await buildArtifact(key);

  let status = "idle";
  if (!meta.enabled) status = "disabled";
  else if (activity.length && (Date.now() - new Date(activity[0].date).getTime()) / 86400000 <= 2) status = "active";
  else if (nextAt) status = "scheduled";

  // Plain-English 3-liner the panel leads with: what / did last / happens next.
  const summary = {
    what: meta.role,
    last: activity.length
      ? `Last seen ${activity[0].date}: ${activity[0].title.slice(0, 90)}`
      : st?.lastRunAt || st?.lastRun
        ? `Last run ${new Date(st.lastRunAt ?? st.lastRun).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}.`
        : "No recorded activity yet.",
    next: !meta.enabled
      ? "Disabled. Nothing scheduled."
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
    status,
    installed: present.size > 0 ? present.has(key) : null,
    lastRunAt: st?.lastRunAt ?? st?.lastRun ?? null,
    nextRunAt: nextAt ? nextAt.toISOString() : null,
    summary,
    systems: AGENT_SYSTEMS[key] ?? [{ id: "vault", label: "VAULT", direction: "both" }],
    activity,
    artifact,
  });
}

// ── main handler ───────────────────────────────────────────────────────────
export async function GET(req: NextRequest) {
  const agentKey = req.nextUrl.searchParams.get("agent");
  if (agentKey) return agentDetail(agentKey);
  const artifactId = req.nextUrl.searchParams.get("artifact");
  if (artifactId) return artifactDetail(artifactId);

  const cloud = isGithubVault();

  const [logRaw, hotRaw, healthRaw, bizRaw, outreachRaw, repliesRaw] = await Promise.all([
    readVaultFile("wiki/log.md"),
    readVaultFile("wiki/hot.md"),
    readVaultFile("wiki/state/health-board.md"),
    readVaultFile("wiki/state/business-snapshot.md"),
    readVaultFile("wiki/state/outreach-snapshot.md"),
    readVaultFile("wiki/state/replies-inbox.md"),
  ]);

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
      pcNeeded: !localDiskOk,
      installed: localDiskOk ? present.has(s.key) : null,
      lastRunAt,
      nextRunAt: nextAt ? nextAt.toISOString() : null,
      lastLogDate: mention?.date ?? null,
      lastLogLine: mention ? clean(mention.title) : null,
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
      pcNeeded: false,
      installed: null,
      lastRunAt: null,
      nextRunAt: null,
      lastLogDate: mention?.date ?? null,
      lastLogLine: mention ? clean(mention.title) : null,
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

  // Client health
  const health = healthRaw ? parseHealthBoard(healthRaw) : { runDate: null, clients: [] };

  // Stats
  const stats = parseStats(bizRaw, outreachRaw);

  // Volume badges for the ops map. Rule: only show where a real number exists.
  interface Vol { value: string; sub: string | null }
  const volumes: { systems: Record<string, Vol>; artifacts: Record<string, Vol> } = {
    systems: {},
    artifacts: {},
  };
  if (outreachRaw) {
    const emailed = outreachRaw.match(/\*\*Emailed:\*\*\s*([\d,]+)/)?.[1];
    const today = outreachRaw.match(/\*\*Sent today:\*\*\s*([\d,]+)/)?.[1];
    const pipeline = outreachRaw.match(/\*\*Pipeline:\*\*\s*([\d,]+)/)?.[1];
    if (today || emailed) {
      volumes.systems["email"] = today && emailed
        ? { value: `${today} today`, sub: `/ ${emailed} sent` }
        : { value: (today ?? emailed) as string, sub: today ? "today" : "sent" };
    }
    if (pipeline) {
      volumes.systems["ghl-wing"] = { value: pipeline, sub: "pipeline" };
      volumes.artifacts["prospects-db"] = { value: pipeline, sub: "prospects" };
    }
  }
  if (bizRaw) {
    const active = bizRaw.match(/\*\*Active clients:\*\*\s*(\d+)/)?.[1];
    if (active) volumes.systems["clients"] = { value: active, sub: "active" };
  }
  // Web/SEO: publishes this week counted from log.md entries mentioning a publish.
  {
    const weekAgo = Date.now() - 7 * 86400000;
    const publishes = feed.filter(
      (e) => new Date(e.date).getTime() >= weekAgo && /publish|posted|went live/i.test(e.title)
    ).length;
    if (publishes > 0) volumes.systems["website"] = { value: String(publishes), sub: "pub/wk" };
  }
  if (repliesRaw) {
    const m = repliesRaw.match(/\*\*(\d+)\s*hot\s*\/\s*(\d+)\s*warm\s*\/\s*(\d+)\s*cold\*\*/i);
    if (m) {
      const total = Number(m[1]) + Number(m[2]) + Number(m[3]);
      volumes.artifacts["replies-inbox"] = { value: String(total), sub: "waiting" };
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
    },
    overall,
    agents: [...scheduledAgents, ...crewAgents],
    feed,
    focus,
    health,
    stats,
    volumes,
  });
}
