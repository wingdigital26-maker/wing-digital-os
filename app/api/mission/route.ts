import { NextResponse } from "next/server";
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
      if (cur.lines.length < 6) cur.lines.push(redact(line.trim()));
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

// ── main handler ───────────────────────────────────────────────────────────
export async function GET() {
  const cloud = isGithubVault();

  const [logRaw, hotRaw, healthRaw, bizRaw, outreachRaw] = await Promise.all([
    readVaultFile("wiki/log.md"),
    readVaultFile("wiki/hot.md"),
    readVaultFile("wiki/state/health-board.md"),
    readVaultFile("wiki/state/business-snapshot.md"),
    readVaultFile("wiki/state/outreach-snapshot.md"),
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
  });
}
