"use client";

// MISSION CONTROL CORE — shared interactive pieces used by both the embedded
// MissionOps view (main app Agents section) and the standalone /mission page.
// Design principle: the MAIN VIEW stays calm (name + status + one line), and
// ALL detail lives in the click-through panels (progressive disclosure).
// Everything here is read-only.

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { sfx } from "../lib/sounds";

// Da Boss healthy / all-clear accent: a calm blue (not green). Red stays for
// problems, amber for the stale/late state.
const BOSS_CLEAR = "var(--accent)";
const BOSS_CLEAR_RGB = "96, 165, 250";

// ── types (mirror of /api/mission payload) ─────────────────────────────────
export interface AgentCard {
  kind: "scheduled" | "crew";
  key: string;
  name: string;
  role: string;
  schedule: string;
  enabled: boolean;
  trial?: boolean; // disabled but in a trial period (amber), not retired (dimmed)
  pcNeeded: boolean;
  installed: boolean | null;
  lastRunAt: string | null;
  nextRunAt: string | null;
  lastLogDate: string | null;
  lastLogLine: string | null;
  watchdogState?: string | null; // OK | LATE | SILENT | DISABLED per watchdog.md
}
export interface WatchdogProblem { text: string; url: string | null }
export interface WatchdogData {
  available: boolean;
  updated: string | null;
  overall: "ok" | "problems" | "unknown";
  problemCount: number;
  problems: WatchdogProblem[];
  resolved: string[];
  agents: Record<string, string>;
}
export interface FeedEntry { date: string; type: string; title: string; lines: string[] }
export interface ClientHealth {
  client: string;
  phase: string;
  overall: "green" | "yellow" | "red";
  pillars: string[];
  redFlags: { text: string; link: string | null }[];
  site?: string | null;
}
export interface PublishItem { date: string; title: string; url: string | null; note: string | null; client?: string | null }
export interface Publishes { windowDays: number; items: PublishItem[]; lastPriorPublish: string | null }
export interface VaultToday { count: number; source: "git" | "mtime" }
export interface ContentCalItem { client: string; platform: string; color: string; days: number[]; note: string }
export interface RealLink { label: string; url: string }
export type MetricSource = "live-db" | "live-ghl" | "snapshot";
export interface StatTile {
  key: string; label: string; value: string; sub: string | null; updated: string | null;
  source: MetricSource; stale: boolean; provenance: string;
}
export interface StatDetail {
  id: string;
  title: string;
  updated: string | null;
  available: boolean;
  summary: string[];
  items: { label: string; value: string; note: string | null }[];
  note: string | null;
  links?: RealLink[];
  source?: MetricSource;
  stale?: boolean;
  provenance?: string;
}
export interface VolumeBadge { value: string; sub: string | null; source: MetricSource; asOf: string | null; stale: boolean }
export interface Volumes {
  systems: Record<string, VolumeBadge>;
  artifacts: Record<string, VolumeBadge>;
}
export interface MissionData {
  generatedAt: string;
  cloud: boolean;
  sources: Record<string, boolean>;
  overall: "green" | "yellow" | "red";
  agents: AgentCard[];
  feed: FeedEntry[];
  agentFeed?: AgentFeedEntry[];
  focus?: {
    currentFocus: string[];
    openQuestions: string[];
    recentDecisions: string[];
    lastOperations: string[];
    updated: string | null;
  };
  health?: { runDate: string | null; clients: ClientHealth[] };
  stats: { tiles: StatTile[]; updated: string | null };
  volumes?: Volumes;
  publishes?: Publishes;
  watchdog?: WatchdogData;
  vaultToday?: VaultToday | null;
  scheduledContent?: ContentCalItem[];
}
// One result an agent reported through /api/notify. level "push" also went to
// Jack's phone, so it renders louder than a plain feed line.
export interface AgentFeedEntry {
  id: number;
  agent: string;
  title: string;
  body: string | null;
  url: string | null;
  level: string;
  created_at: string;
}
export interface AgentWire { id: string; label: string; direction: "reads" | "writes" | "both" }
export interface AgentDetail {
  key: string;
  name: string;
  kind: "scheduled" | "crew";
  role: string;
  description: string;
  schedule: string;
  scheduleHuman: string;
  enabled: boolean;
  trial?: boolean;
  status: string;
  watchdogState?: string | null;
  installed: boolean | null;
  lastRunAt: string | null;
  nextRunAt: string | null;
  summary?: { what: string; last: string; next: string };
  systems: AgentWire[];
  activity: FeedEntry[];
  olderActivity?: number;
  artifact: { title: string; lines: string[]; distilled?: string[] } | null;
}
export interface ArtifactDetail {
  id: string;
  label: string;
  blurb: string;
  system: string;
  producedBy: string;
  producedByName: string;
  path: string;
  available: boolean;
  updated: string | null;
  lines: string[];
  distilled?: string[];
  links?: RealLink[];
}

// ── shared metadata ────────────────────────────────────────────────────────
// Systems split into precise pieces so the moving parts are visible.
export const SYSTEMS = [
  { id: "vault", label: "VAULT", color: "var(--accent-2)", blurb: "The Obsidian brain: log.md, hot.md, state snapshots, client pages. Most agents write their results here." },
  { id: "ghl-clients", label: "GHL", color: "var(--orange)", blurb: "Client subaccounts in GoHighLevel (Jackson Roofing today, more as clients sign): contacts, pipelines, conversations, calendars." },
  { id: "ghl-wing", label: "GHL WING", color: "var(--orange)", blurb: "Wing Digital's own GoHighLevel account: the outreach CRM, reply inbox, and prospect pipeline." },
  { id: "email", label: "EMAIL", color: "var(--accent)", blurb: "The cold-email path: the autonomous outreach sender and the inbox it feeds." },
  { id: "clients", label: "CLIENTS", color: "var(--green)", blurb: "Live client deliverables: Jackson Roofing, Renewal Health, and the health board that watches them." },
  { id: "scheduler", label: "SCHEDULER", color: "var(--accent)", blurb: "The scheduled-tasks runner on Jack's PC that fires the daily and weekly agents." },
  { id: "website", label: "WEB/SEO", color: "#f472b6", blurb: "The published websites and SEO layer: blog posts, service pages, calendars, rankings." },
];

// Artifact satellites: the concrete files agents produce (client mirror of the
// API registry; content comes from /api/mission?artifact=id).
export const ARTIFACTS = [
  { id: "health-board", label: "health board", system: "clients", producedBy: "sentinel-daily" },
  { id: "business-snapshot", label: "biz snapshot", system: "vault", producedBy: "dispatch" },
  { id: "outreach-snapshot", label: "outreach snap", system: "email", producedBy: "outreach" },
  { id: "content-calendar", label: "content cal", system: "website", producedBy: "content-engine-weekly" },
  { id: "prospects-db", label: "prospects.db", system: "ghl-wing", producedBy: "b2b-prospector-daily" },
  { id: "replies-inbox", label: "replies inbox", system: "ghl-wing", producedBy: "reply-triage" },
];

export const AGENT_WIRES: Record<string, string[]> = {
  "sentinel-daily": ["vault", "clients", "website", "scheduler"],
  "chronicler-end-of-day": ["vault", "scheduler"],
  "content-engine-weekly": ["vault", "clients", "website", "scheduler"],
  "renewal-content-weekly": ["vault", "clients", "website", "scheduler"],
  "b2b-outreach-engine": ["email", "ghl-wing", "scheduler"],
  "b2b-prospector-daily": ["vault", "ghl-wing", "scheduler"],
  closer: ["ghl-wing", "email", "vault", "scheduler"],
  "call-prep": ["vault", "clients", "ghl-wing", "scheduler"],
  "client-report": ["ghl-clients", "clients", "website", "vault", "scheduler"],
  dispatch: ["vault", "ghl-clients", "ghl-wing"],
  "reply-triage": ["vault", "ghl-clients", "ghl-wing", "email"],
  builder: ["ghl-clients", "clients"],
};

// How each agent shows up in log.md (client-side mirror of the API's matchers,
// used to filter feed lines for the system panel).
export const AGENT_MATCH: Record<string, RegExp> = {
  "sentinel-daily": /\bsentinel\b/i,
  "chronicler-end-of-day": /\bchronicler\b/i,
  "content-engine-weekly": /content[- ]engine|jackson.*(blog|content|post)/i,
  "renewal-content-weekly": /\brenewal\b/i,
  "b2b-outreach-engine": /outreach|cold email|b2b/i,
  "b2b-prospector-daily": /prospector|lead scan|lead-find|b2b lead/i,
  closer: /\bcloser\b/i,
  "call-prep": /call[- ]prep/i,
  "client-report": /client[- ]report/i,
  dispatch: /dispatch/i,
  "reply-triage": /reply-triage|triage/i,
  builder: /builder|onboard/i,
};

// The OS is read-only: it never triggers agents. These are the exact phrases
// Jack says to Claude to run one by hand, shown as a hint in agent panels.
export const RUN_PHRASE: Record<string, string> = {
  "sentinel-daily": "run sentinel",
  "chronicler-end-of-day": "run chronicler",
  "content-engine-weekly": "run content-engine",
  "renewal-content-weekly": "run renewal-content-engine",
  "b2b-outreach-engine": "run outreach",
  "b2b-prospector-daily": "find B2B leads",
  closer: "run closer",
  "call-prep": "run call-prep",
  "client-report": "run client-report for [client]",
  dispatch: "run dispatch",
  "reply-triage": "run reply-triage",
  builder: "run builder for [client]",
};

export const PILLAR_NAMES = [
  "SEO foundation",
  "Content quality + brand safety",
  "Website health",
  "CRM / outreach",
  "Onboarding completeness",
];

export const TYPE_COLOR: Record<string, string> = {
  ingest: "var(--accent)",
  query: "var(--accent-2)",
  build: "var(--green)",
  security: "var(--red)",
  lint: "var(--orange)",
};

export const STATUS_COLOR: Record<string, string> = {
  green: "var(--green)",
  yellow: "var(--orange)",
  red: "var(--red)",
};

// ── selection model ────────────────────────────────────────────────────────
export type Selection =
  | { type: "agent"; key: string }
  | { type: "system"; id: string }
  | { type: "artifact"; id: string }
  | { type: "client"; name: string }
  | { type: "stat"; key: string }
  | { type: "watchdog" }
  | null;

// ── helpers ────────────────────────────────────────────────────────────────
export function fmtCountdown(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "due now";
  const min = Math.floor(ms / 60000);
  if (min < 60) return `in ${min}m`;
  const h = Math.floor(min / 60);
  if (h < 48) return `in ${h}h ${min % 60}m`;
  return `in ${Math.floor(h / 24)}d`;
}

// Staleness label for snapshot timestamps like "2026-08-10 13:43": "2h ago".
export function fmtAge(updated: string | null): string | null {
  if (!updated) return null;
  const m = updated.match(/^(\d{4})-(\d{2})-(\d{2})(?:\s+(\d{2}):(\d{2}))?/);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 12), Number(m[5] ?? 0));
  const min = Math.floor((Date.now() - d.getTime()) / 60000);
  if (min < 0) return null;
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// "2026-08-07" -> "Aug 7" (falls back to the raw string).
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function shortDate(iso: string): string {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return iso;
  return `${MONTHS[Number(m[2]) - 1] ?? m[2]} ${Number(m[3])}`;
}

// One short sentence per activity line: strip log-format prefixes, cap ~90 chars.
export function tightLine(s: string, max = 90): string {
  const t = s
    .replace(/^\s*[-*]\s+/, "")
    .replace(/^\[?\d{4}-\d{2}-\d{2}\]?\s*[|:-]?\s*/, "")
    .replace(/^(build|ingest|query|security|lint)\s*\|\s*/i, "")
    .trim();
  return t.length > max ? t.slice(0, max - 1).trimEnd() + "…" : t;
}

export function isRecentlyActive(a: AgentCard): boolean {
  if (a.lastLogDate) {
    const days = (Date.now() - new Date(a.lastLogDate).getTime()) / 86400000;
    if (days <= 2) return true;
  }
  if (a.nextRunAt && new Date(a.nextRunAt).getTime() - Date.now() < 3600_000) return true;
  return false;
}

export function Dot({ color, pulse }: { color: string; pulse?: boolean }) {
  return (
    <span
      className={pulse ? "mo-pulse" : undefined}
      style={{
        display: "inline-block", width: 9, height: 9, borderRadius: "50%",
        background: color, boxShadow: `0 0 8px ${color}`, flexShrink: 0,
      }}
    />
  );
}

export function Pill({ text, color }: { text: string; color: string }) {
  return (
    <span style={{
      fontSize: 10, fontFamily: "'JetBrains Mono', monospace", letterSpacing: "0.08em",
      padding: "2px 8px", borderRadius: 99, border: `1px solid ${color}`, color, whiteSpace: "nowrap",
    }}>{text}</span>
  );
}

// Shared keyframes/styles used by the map and panels.
export function MissionStyles() {
  return (
    <style>{`
      .mo-pulse { animation: moPulse 2s ease-in-out infinite; }
      @keyframes moPulse { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }
      .mo-node-pulse { animation: moNode 2.6s ease-in-out infinite; }
      @keyframes moNode { 0%,100% { stroke-opacity: 1; } 50% { stroke-opacity: 0.4; } }
      .mo-flow { animation: moFlow 1.6s linear infinite; }
      @keyframes moFlow { from { stroke-dashoffset: 36; } to { stroke-dashoffset: 0; } }
      .mo-click { cursor: pointer; }
      .mo-click:hover { filter: brightness(1.25); }
      .mo-panel { animation: moSlideIn 0.22s ease-out; }
      @keyframes moSlideIn { from { transform: translateX(40px); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
      .mo-feedline { cursor: pointer; border-radius: 6px; padding: 2px 4px; margin: 0 -4px; }
      .mo-feedline:hover { background: rgba(255,255,255,0.05); }
    `}</style>
  );
}

// ── Ops map (SVG, hierarchical: agents ring / systems core / artifact satellites)
type Hover =
  | { kind: "agent"; key: string }
  | { kind: "system"; id: string }
  | { kind: "artifact"; id: string }
  | { kind: "watchdog" }
  | null;

// Tiny volume pill rendered inside the SVG map (numbers only, no clutter).
function VolPill({ x, y, text, color, live, stale }: { x: number; y: number; text: string; color: string; live?: boolean; stale?: boolean }) {
  // Stale volumes turn amber and dim; live ones get a small green dot. A
  // confident stale number is never shown as if it were current.
  const stroke = stale ? "var(--orange)" : color;
  const fill = stale ? "var(--orange)" : color;
  const w = text.length * 5.6 + 14 + (live ? 8 : 0);
  return (
    <g style={{ pointerEvents: "none" }} opacity={stale ? 0.7 : 1}>
      <rect x={x - w / 2} y={y - 9} width={w} height={18} rx={9}
        fill="var(--bg-card)" stroke={stroke} strokeOpacity={stale ? 0.9 : 0.7}
        strokeWidth={1} strokeDasharray={stale ? "3 2" : undefined} />
      {live && <circle cx={x - w / 2 + 8} cy={y} r={2.6} fill="var(--green)" />}
      <text x={x + (live ? 4 : 0)} y={y + 3} textAnchor="middle" fill={fill} fontSize="9"
        fontFamily="'JetBrains Mono', monospace">{text}</text>
    </g>
  );
}

export function OpsMap({ agents, volumes, watchdog, onSelect, hero }: {
  agents: AgentCard[]; volumes?: Volumes; watchdog?: WatchdogData | null; onSelect: (s: Selection) => void;
  hero?: boolean;
}) {
  const [hover, setHover] = useState<Hover>(null);
  const W = 960, H = 500;
  // Extra headroom above the agents arc for the watchdog overseer node.
  // Extra headroom for the oversized boss orb (1.5x the agent nodes).
  const TOP = watchdog?.available ? 100 : 0;
  // Enabled agents plus trial agents (disabled but intentional, shown amber).
  const shown = agents.filter(a => a.enabled || a.trial);
  const agentPos = shown.map((a, i) => {
    const x = (W / (shown.length + 1)) * (i + 1);
    // gentle arc: edges sit a bit lower than the middle
    const t = (i / Math.max(shown.length - 1, 1)) * 2 - 1;
    return { a, x, y: 66 + t * t * 22 };
  });
  const sysPos = SYSTEMS.map((s, i) => ({ s, x: (W / (SYSTEMS.length + 1)) * (i + 1), y: 300 }));
  const sysMap = new Map(sysPos.map(p => [p.s.id, p]));
  // artifact satellites hang below their parent system; spread siblings apart
  const artPos = ARTIFACTS.map(art => {
    const siblings = ARTIFACTS.filter(x => x.system === art.system);
    const idx = siblings.findIndex(x => x.id === art.id);
    const sp = sysMap.get(art.system);
    if (!sp) return null;
    const off = (idx - (siblings.length - 1) / 2) * 74;
    return { art, x: sp.x + off, y: 430, color: sp.s.color, si: idx, sn: siblings.length };
  }).filter(Boolean) as { art: typeof ARTIFACTS[number]; x: number; y: number; color: string; si: number; sn: number }[];

  // hover relationships
  const hoverSystems = new Set<string>();
  const hoverAgents = new Set<string>();
  const hoverArtifacts = new Set<string>();
  if (hover?.kind === "agent") {
    hoverAgents.add(hover.key);
    for (const s of AGENT_WIRES[hover.key] ?? []) hoverSystems.add(s);
    for (const art of ARTIFACTS) if (art.producedBy === hover.key) hoverArtifacts.add(art.id);
  } else if (hover?.kind === "system") {
    hoverSystems.add(hover.id);
    for (const a of shown) if ((AGENT_WIRES[a.key] ?? []).includes(hover.id)) hoverAgents.add(a.key);
    for (const art of ARTIFACTS) if (art.system === hover.id) hoverArtifacts.add(art.id);
  } else if (hover?.kind === "artifact") {
    const art = ARTIFACTS.find(x => x.id === hover.id);
    if (art) {
      hoverArtifacts.add(art.id);
      hoverSystems.add(art.system);
      hoverAgents.add(art.producedBy);
    }
  }

  // Agents the watchdog is currently flagging: any non-OK state (LATE, SILENT,
  // NEVER RUN) or an agent named in a problem line. The overseer node draws
  // animated red alert lines down to exactly these.
  const badState = (st?: string | null) => !!st && st !== "OK" && st !== "DISABLED";
  const implicated = shown.filter(a =>
    badState(a.watchdogState) ||
    (watchdog?.problems ?? []).some(p => AGENT_MATCH[a.key]?.test(p.text))
  );
  if (hover?.kind === "watchdog") for (const a of implicated) hoverAgents.add(a.key);
  const hovering = hover !== null;
  const wdProblems = !!watchdog && (watchdog.overall === "problems" || Math.max(watchdog.problemCount, watchdog.problems.length) > 0);
  const wdColor = wdProblems ? "var(--red)" : BOSS_CLEAR;
  const wdX = W / 2, wdY = -TOP + 44;
  // Boss orb is 1.5x an agent node (agent r=21 -> 31.5), glow kept proportional.
  const wdR = 31.5;

  return (
    <div className={`mo-map${hero ? " mo-map-hero" : ""}`} style={{
      background: "linear-gradient(180deg, var(--bg-card, #0d1117), var(--bg-secondary))",
      border: "1px solid var(--border, var(--border))",
      borderRadius: 14, padding: 8, overflowX: "auto", WebkitOverflowScrolling: "touch",
      ...(hero ? { height: "clamp(440px, 74vh, 900px)", display: "flex" } : {}),
    }}>
      <svg className="mo-map-svg" viewBox={`0 ${-TOP} ${W} ${H + TOP}`}
        preserveAspectRatio={hero ? "xMidYMid meet" : undefined}
        style={{ width: "100%", minWidth: 680, display: "block", ...(hero ? { height: "100%" } : {}) }}>
        <defs>
          <radialGradient id="mo-glow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="rgba(34,211,238,0.25)" />
            <stop offset="100%" stopColor="rgba(34,211,238,0)" />
          </radialGradient>
        </defs>

        {/* faint tier labels */}
        <text x={14} y={40} fill="#374151" fontSize="9" fontFamily="'JetBrains Mono', monospace" letterSpacing="0.2em">AGENTS</text>
        <text x={14} y={286} fill="#374151" fontSize="9" fontFamily="'JetBrains Mono', monospace" letterSpacing="0.2em">SYSTEMS</text>
        <text x={14} y={470} fill="#374151" fontSize="9" fontFamily="'JetBrains Mono', monospace" letterSpacing="0.2em">ARTIFACTS</text>

        {/* agent → system wires */}
        {agentPos.map(({ a, x, y }) =>
          (AGENT_WIRES[a.key] ?? ["vault"]).map(sysId => {
            const sp = sysMap.get(sysId);
            if (!sp) return null;
            const active = isRecentlyActive(a);
            const highlighted = hovering && hoverAgents.has(a.key) && hoverSystems.has(sysId);
            const dimmed = hovering && !highlighted;
            const color = sp.s.color;
            const midY = (y + sp.y) / 2;
            const d = `M ${x} ${y + 24} C ${x} ${midY}, ${sp.x} ${midY}, ${sp.x} ${sp.y - 22}`;
            return (
              <g key={`${a.key}-${sysId}`} opacity={dimmed ? 0.1 : 1}>
                <path d={d} fill="none" stroke={color}
                  strokeOpacity={highlighted ? 0.9 : active ? 0.45 : 0.12}
                  strokeWidth={highlighted ? 2.2 : active ? 1.5 : 1} />
                {(active || highlighted) && (
                  <path d={d} fill="none" stroke={color} strokeWidth={2.2}
                    strokeDasharray="4 14" strokeLinecap="round" className="mo-flow" />
                )}
              </g>
            );
          })
        )}

        {/* system → artifact wires */}
        {artPos.map(({ art, x, y, color }) => {
          const sp = sysMap.get(art.system);
          if (!sp) return null;
          const producer = shown.find(a => a.key === art.producedBy);
          const active = producer ? isRecentlyActive(producer) : false;
          const highlighted = hovering && hoverArtifacts.has(art.id);
          const dimmed = hovering && !highlighted;
          const d = `M ${sp.x} ${sp.y + 22} C ${sp.x} ${(sp.y + y) / 2}, ${x} ${(sp.y + y) / 2}, ${x} ${y - 14}`;
          return (
            <g key={`w-${art.id}`} opacity={dimmed ? 0.1 : 1}>
              <path d={d} fill="none" stroke={color}
                strokeOpacity={highlighted ? 0.9 : active ? 0.4 : 0.14}
                strokeWidth={highlighted ? 2 : 1} strokeDasharray="2 5" />
              {(active || highlighted) && (
                <path d={d} fill="none" stroke={color} strokeWidth={1.8}
                  strokeDasharray="3 12" strokeLinecap="round" className="mo-flow" />
              )}
            </g>
          );
        })}

        {/* watchdog overseer: alert lines down to implicated agents */}
        {watchdog?.available && implicated.map(a => {
          const p = agentPos.find(ap => ap.a.key === a.key);
          if (!p) return null;
          const midY = (wdY + p.y) / 2;
          const d = `M ${wdX} ${wdY + wdR} C ${wdX} ${midY}, ${p.x} ${midY}, ${p.x} ${p.y - 26}`;
          return (
            <g key={`wd-${a.key}`}>
              <path d={d} fill="none" stroke="var(--red)" strokeOpacity={0.5} strokeWidth={1.6} />
              <path d={d} fill="none" stroke="var(--red)" strokeWidth={2.4}
                strokeDasharray="4 14" strokeLinecap="round" className="mo-flow" />
            </g>
          );
        })}

        {/* watchdog overseer node */}
        {watchdog?.available && (
          <g className="mo-click"
            onMouseEnter={() => { sfx.play("hover"); setHover({ kind: "watchdog" }); }}
            onMouseLeave={() => setHover(h => (h?.kind === "watchdog" ? null : h))}
            onClick={() => { sfx.play("blip-watchdog"); onSelect({ type: "watchdog" }); }}>
            {wdProblems && <circle cx={wdX} cy={wdY} r={wdR * 1.9} fill="url(#mo-glow)" />}
            <circle cx={wdX} cy={wdY} r={wdR} fill="var(--bg-card)" stroke={wdColor}
              strokeWidth={3} className={wdProblems ? "mo-node-pulse" : undefined} />
            <circle cx={wdX} cy={wdY - wdR - 7} r={5} fill={wdColor} className={wdProblems ? "mo-pulse" : undefined} />
            <text x={wdX} y={wdY + 4} textAnchor="middle" fill={wdColor} fontSize="11"
              fontFamily="'JetBrains Mono', monospace" letterSpacing="0.06em" fontWeight="700" style={{ pointerEvents: "none" }}>
              DA BOSS
            </text>
            <text x={wdX} y={wdY + wdR + 14} textAnchor="middle" fill={wdProblems ? "var(--red)" : "#6b7280"} fontSize="8.5"
              fontFamily="'JetBrains Mono', monospace" style={{ pointerEvents: "none" }}>
              {wdProblems
                ? `${Math.max(watchdog.problemCount, watchdog.problems.length)} problem${Math.max(watchdog.problemCount, watchdog.problems.length) === 1 ? "" : "s"}`
                : "all clear"}
            </text>
          </g>
        )}

        {/* agent nodes */}
        {agentPos.map(({ a, x, y }) => {
          const active = isRecentlyActive(a);
          const trial = !a.enabled && !!a.trial;
          const highlighted = hovering && hoverAgents.has(a.key);
          const dimmed = hovering && !highlighted;
          const color = trial ? "var(--orange)" : highlighted || active ? "var(--accent)" : "#4b5563";
          return (
            <g key={a.key} className="mo-click" opacity={dimmed ? 0.3 : 1}
              onMouseEnter={() => { sfx.play("hover"); setHover({ kind: "agent", key: a.key }); }}
              onMouseLeave={() => setHover(h => (h?.kind === "agent" && h.key === a.key ? null : h))}
              onClick={() => { sfx.play("blip"); onSelect({ type: "agent", key: a.key }); }}>
              {(active || highlighted) && <circle cx={x} cy={y} r={32} fill="url(#mo-glow)" />}
              <circle cx={x} cy={y} r={21} fill="var(--bg-card)" stroke={color}
                strokeWidth={highlighted ? 2.2 : 1.5}
                strokeDasharray={trial ? "3 3" : undefined}
                className={active ? "mo-node-pulse" : undefined} />
              <circle cx={x} cy={y - 28} r={3.5}
                fill={a.watchdogState === "SILENT" ? "var(--red)" : a.watchdogState === "LATE" ? "var(--orange)" : trial ? "var(--orange)" : active ? "var(--green)" : "#4b5563"}
                className={active || (a.watchdogState && a.watchdogState !== "OK") ? "mo-pulse" : undefined} />
              <text x={x} y={y + 4} textAnchor="middle" fill={trial ? "var(--orange)" : active || highlighted ? "#e5e7eb" : "#9ca3af"}
                fontSize="9.5" fontFamily="'JetBrains Mono', monospace" style={{ pointerEvents: "none" }}>
                {a.name.split(" ")[0].slice(0, 9).toUpperCase()}
              </text>
              <text x={x} y={y + 40} textAnchor="middle" fill={trial ? "var(--orange)" : "#6b7280"} fontSize="8.5"
                fontFamily="'JetBrains Mono', monospace" style={{ pointerEvents: "none" }}>
                {trial ? "TRIAL" : a.nextRunAt ? fmtCountdown(a.nextRunAt) : a.lastLogDate ?? ""}
              </text>
            </g>
          );
        })}

        {/* system nodes */}
        {sysPos.map(({ s, x, y }) => {
          const highlighted = hovering && hoverSystems.has(s.id);
          const dimmed = hovering && !highlighted;
          return (
            <g key={s.id} className="mo-click" opacity={dimmed ? 0.25 : 1}
              onMouseEnter={() => { sfx.play("hover"); setHover({ kind: "system", id: s.id }); }}
              onMouseLeave={() => setHover(h => (h?.kind === "system" && h.id === s.id ? null : h))}
              onClick={() => { sfx.play("blip-system"); onSelect({ type: "system", id: s.id }); }}>
              <rect x={x - 54} y={y - 20} width={108} height={40} rx={10}
                fill="var(--bg-card)" stroke={s.color}
                strokeOpacity={highlighted ? 1 : 0.6} strokeWidth={highlighted ? 2 : 1.4} />
              <circle cx={x - 42} cy={y} r={4} fill={s.color} className="mo-pulse" />
              <text x={x + 5} y={y + 4} textAnchor="middle" fill={s.color} fontSize="10"
                fontFamily="'JetBrains Mono', monospace" letterSpacing="0.08em" style={{ pointerEvents: "none" }}>
                {s.label}
              </text>
            </g>
          );
        })}

        {/* artifact satellite nodes */}
        {artPos.map(({ art, x, y, color }) => {
          const highlighted = hovering && hoverArtifacts.has(art.id);
          const dimmed = hovering && !highlighted;
          return (
            <g key={art.id} className="mo-click" opacity={dimmed ? 0.25 : 1}
              onMouseEnter={() => { sfx.play("hover"); setHover({ kind: "artifact", id: art.id }); }}
              onMouseLeave={() => setHover(h => (h?.kind === "artifact" && h.id === art.id ? null : h))}
              onClick={() => { sfx.play("blip-artifact"); onSelect({ type: "artifact", id: art.id }); }}>
              <rect x={x - 34} y={y - 13} width={68} height={26} rx={7}
                fill="var(--bg-card)" stroke={color}
                strokeOpacity={highlighted ? 0.95 : 0.45} strokeWidth={highlighted ? 1.6 : 1}
                strokeDasharray={highlighted ? undefined : "3 3"} />
              <text x={x} y={y + 3.5} textAnchor="middle" fill={highlighted ? "#e5e7eb" : "#9ca3af"}
                fontSize="8" fontFamily="'JetBrains Mono', monospace" style={{ pointerEvents: "none" }}>
                {art.label}
              </text>
            </g>
          );
        })}

        {/* volume pills: real numbers on the wires/nodes where one exists */}
        {volumes && sysPos.map(({ s, x, y }) => {
          const v = volumes.systems[s.id];
          if (!v) return null;
          const dimmed = hovering && !hoverSystems.has(s.id);
          return (
            <g key={`vol-${s.id}`} opacity={dimmed ? 0.2 : 1}>
              <VolPill x={x} y={y - 32} text={v.sub ? `${v.value} ${v.sub}` : v.value} color={s.color}
                live={v.source === "live-db" || v.source === "live-ghl"} stale={v.stale} />
            </g>
          );
        })}
        {volumes && artPos.map(({ art, x, y, color, si }) => {
          const v = volumes.artifacts[art.id];
          const sp = sysMap.get(art.system);
          if (!v || !sp) return null;
          const dimmed = hovering && !hoverArtifacts.has(art.id);
          // Anchor the pill just above its own artifact node (not the shared
          // wire midpoint) and stagger siblings vertically, so two artifacts on
          // the same system never stack their pills on top of each other.
          const stagger = (si % 2) * 20;
          return (
            <g key={`vola-${art.id}`} opacity={dimmed ? 0.2 : 1}>
              <VolPill x={x} y={y - 26 - stagger}
                text={v.sub ? `${v.value} ${v.sub}` : v.value} color={color}
                live={v.source === "live-db" || v.source === "live-ghl"} stale={v.stale} />
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// ── Watchdog status banner ─────────────────────────────────────────────────
// Sits at the very top of the Command Center and the mission views. Green
// quiet strip when the last watchdog report is clean and fresh; amber when the
// watchdog itself has gone quiet (report older than 3 hours); red prominent
// banner when the report lists problems. Missing file (first run pending) is a
// quiet neutral state, never an error. Clicking toggles the detail list.

// Render a problem line with any URL in it as a clickable link.
function ProblemLine({ p, color }: { p: WatchdogProblem; color: string }) {
  if (!p.url) return <span>{p.text}</span>;
  const i = p.text.indexOf(p.url);
  const before = i >= 0 ? p.text.slice(0, i) : p.text + " ";
  const after = i >= 0 ? p.text.slice(i + p.url.length) : "";
  return (
    <span>
      {before}
      <a href={p.url} target="_blank" rel="noreferrer" style={{ color, textDecoration: "underline" }}
        onClick={(e) => e.stopPropagation()}>
        {i >= 0 ? p.url : "open link"} &#8599;
      </a>
      {after}
    </span>
  );
}

// Age of the watchdog report in minutes (null when unparseable).
function watchdogAgeMin(updated: string | null): number | null {
  if (!updated) return null;
  let d = new Date(updated);
  if (isNaN(d.getTime())) {
    const m = updated.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T\s]+(\d{2}):(\d{2}))?/);
    if (!m) return null;
    d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 12), Number(m[5] ?? 0));
  }
  const min = Math.floor((Date.now() - d.getTime()) / 60000);
  return min >= 0 ? min : 0;
}

function relAge(min: number | null): string {
  if (min === null) return "at an unknown time";
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h}h ${min % 60}m ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// Build the full watchdog report as clean plain text for pasting elsewhere.
function watchdogReportText(w: WatchdogData): string {
  const lines: string[] = [];
  const count = Math.max(w.problemCount, w.problems.length);
  lines.push(
    w.overall === "problems" || count > 0
      ? `DA BOSS REPORT: ${count} problem${count === 1 ? "" : "s"} reported`
      : "DA BOSS REPORT: all systems reporting, no problems"
  );
  if (w.problems.length) {
    lines.push("");
    lines.push("Problems:");
    for (const p of w.problems) lines.push(`- ${p.text}${p.url && !p.text.includes(p.url) ? ` (${p.url})` : ""}`);
  }
  if (w.resolved.length) {
    lines.push("");
    lines.push("Resolved:");
    for (const r of w.resolved) lines.push(`- ${r}`);
  }
  const agentKeys = Object.keys(w.agents ?? {});
  if (agentKeys.length) {
    lines.push("");
    lines.push("Agent states:");
    for (const k of agentKeys) lines.push(`- ${k}: ${w.agents[k]}`);
  }
  lines.push("");
  lines.push(`Last report from Da Boss: ${w.updated ?? "unknown"}`);
  return lines.join("\n");
}

// Small copy-icon button that copies the full watchdog report as plain text.
function WatchdogCopyButton({ watchdog, color }: { watchdog: WatchdogData; color: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      title="Copy the full report from Da Boss"
      aria-label="Copy report from Da Boss"
      onClick={(e) => {
        e.stopPropagation();
        navigator.clipboard?.writeText(watchdogReportText(watchdog)).then(() => {
          sfx.play("send");
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }).catch(() => {});
      }}
      style={{
        background: "none", border: `1px solid ${copied ? "var(--green)" : color}55`,
        color: copied ? "var(--green)" : color, borderRadius: 6, padding: "2px 8px",
        cursor: "pointer", fontSize: 10, display: "inline-flex", alignItems: "center", gap: 5,
        fontFamily: "'JetBrains Mono', monospace", flexShrink: 0,
      }}>
      {copied ? (
        "Copied"
      ) : (
        <>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="9" y="9" width="13" height="13" rx="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </svg>
          copy
        </>
      )}
    </button>
  );
}

// ── Da Boss "Recheck": run live checks on demand ──────────────────────────
// Hits POST /api/boss/recheck and shows the fresh results inline over top of
// the cached report. Resolved lines go green, still-broken stay red, needs-pc
// shows a subtle pill. Honest: it only greens what the server truly verified.
export interface RecheckItem { label: string; status: string; line: string; url?: string | null; http?: number | null }
export interface RecheckCheck { id: string; label: string; status: string; line: string; items?: RecheckItem[] }
export interface RecheckResult {
  ranAt: string; target: string; cloud: boolean;
  persisted?: boolean; mode?: "local" | "cloud-github" | "none";
  pushedToCloud?: boolean | null; commit?: string | null; reason?: string | null;
  resolvedCount?: number; refetchMission?: boolean;
  wrote: boolean; writeNote: string | null; overall: string; checks: RecheckCheck[];
}

const RECHECK_TARGETS: { id: string; label: string }[] = [
  { id: "all", label: "Recheck everything" },
  { id: "urls", label: "Recheck the flagged pages" },
  { id: "freshness", label: "Recheck data freshness" },
  { id: "outreach", label: "Recheck outreach" },
];

const statusColor = (s: string): string =>
  s === "resolved" || s === "ok" ? "var(--green)" : s === "problem" ? "var(--red)" : "#93a4b8";

function StatusMark({ status }: { status: string }) {
  if (status === "resolved" || status === "ok") return <span style={{ color: "var(--green)" }} aria-hidden>&#10003;</span>;
  if (status === "problem") return <span style={{ color: "var(--red)" }} aria-hidden>&#10007;</span>;
  return <Pill text="needs PC" color="#93a4b8" />;
}

export function RecheckButton({ onRechecked, compact }: { onRechecked?: () => void; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<RecheckResult | null>(null);
  const [ranAt, setRanAt] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const mono = "'JetBrains Mono', monospace";

  const run = async (target: string) => {
    setOpen(false);
    setBusy(target);
    setErr(null);
    sfx.play("nav"); // tick on start
    try {
      const res = await fetch("/api/boss/recheck", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target }),
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j: RecheckResult = await res.json();
      setResult(j);
      setRanAt(Date.now());
      const anyResolved = j.checks.some((c) => c.status === "resolved" || (c.items ?? []).some((i) => i.status === "resolved"));
      sfx.play(anyResolved ? "chime" : "blip-watchdog"); // positive chime if anything resolved, else the watchdog tone
      onRechecked?.(); // re-pull /api/mission so banner/agent states/red lines update
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "recheck failed");
      sfx.play("blip-watchdog");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div style={{ position: "relative", display: "inline-flex", flexDirection: "column", alignItems: "stretch", gap: 6 }}
      onClick={(e) => e.stopPropagation()}>
      <div style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
        <button
          title="Recheck now"
          aria-label="Recheck now"
          disabled={!!busy}
          onClick={() => (busy ? undefined : run("all"))}
          style={{
            background: "none", border: "1px solid var(--accent, #22d3ee)55", color: "var(--accent, #22d3ee)",
            borderRadius: 6, padding: compact ? "2px 8px" : "3px 10px", cursor: busy ? "wait" : "pointer",
            fontSize: 10, display: "inline-flex", alignItems: "center", gap: 5, fontFamily: mono, flexShrink: 0,
          }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
            strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
            style={busy ? { animation: "recheckSpin 0.8s linear infinite" } : undefined}>
            <path d="M21 12a9 9 0 1 1-2.64-6.36" />
            <path d="M21 3v6h-6" />
          </svg>
          {busy ? "rechecking" : "recheck"}
        </button>
        <button
          aria-label="Choose what to recheck"
          disabled={!!busy}
          onClick={() => setOpen((o) => !o)}
          style={{
            background: "none", border: "1px solid var(--accent, #22d3ee)55", color: "var(--accent, #22d3ee)",
            borderRadius: 6, padding: "3px 6px", cursor: busy ? "wait" : "pointer", fontSize: 10, fontFamily: mono, flexShrink: 0,
          }}>
          &#9662;
        </button>
      </div>
      <style>{`@keyframes recheckSpin { to { transform: rotate(360deg); } }`}</style>

      {open && (
        <div style={{
          position: "absolute", top: "100%", right: 0, marginTop: 4, zIndex: 30,
          background: "var(--bg-card, #0d1117)", border: "1px solid var(--border, var(--border))",
          borderRadius: 8, padding: 4, minWidth: 190, boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
        }}>
          {RECHECK_TARGETS.map((t) => (
            <button key={t.id} onClick={() => run(t.id)}
              style={{
                display: "block", width: "100%", textAlign: "left", background: "none", border: "none",
                color: "var(--text-secondary, #9ca3af)", fontSize: 11, fontFamily: mono, padding: "6px 8px",
                borderRadius: 6, cursor: "pointer",
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(255,255,255,0.05)")}
              onMouseLeave={(e) => (e.currentTarget.style.background = "none")}>
              {t.label}
            </button>
          ))}
        </div>
      )}

      {err && <div style={{ fontSize: 10.5, color: "var(--red)", fontFamily: mono }}>recheck failed: {err}</div>}

      {result && !busy && (
        <div style={{
          border: `1px solid ${statusColor(result.overall)}55`, borderRadius: 8, padding: "8px 10px",
          background: "rgba(255,255,255,0.02)", display: "flex", flexDirection: "column", gap: 6, minWidth: compact ? undefined : 280,
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 10.5, fontFamily: mono, color: statusColor(result.overall) }}>
            <StatusMark status={result.overall} />
            <span style={{ fontWeight: 700, letterSpacing: "0.08em" }}>
              RECHECKED JUST NOW{result.cloud ? " (cloud)" : ""}
            </span>
            <span style={{ marginLeft: "auto", color: "var(--text-muted, #6b7280)" }}>
              {ranAt ? new Date(ranAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) : ""}
            </span>
          </div>
          {result.checks.map((c) => (
            <div key={c.id} style={{ display: "flex", flexDirection: "column", gap: 3 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: statusColor(c.status), fontFamily: mono }}>
                <StatusMark status={c.status} />
                <span style={{ fontWeight: 600 }}>{c.label}:</span>
                <span style={{ color: "var(--text-secondary, #9ca3af)" }}>{c.line}</span>
              </div>
              {(c.items ?? []).map((it, i) => (
                <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 6, fontSize: 10.5, paddingLeft: 16, color: "var(--text-secondary, #9ca3af)", lineHeight: 1.45 }}>
                  <StatusMark status={it.status} />
                  <span>
                    {it.url ? (
                      <a href={it.url} target="_blank" rel="noreferrer" style={{ color: statusColor(it.status), textDecoration: "underline" }}>
                        {it.url}
                      </a>
                    ) : (
                      <span style={{ color: statusColor(it.status) }}>{it.label}</span>
                    )}
                    {" — "}{it.line}
                  </span>
                </div>
              ))}
            </div>
          ))}
          {(() => {
            const persisted = !!result.persisted;
            const cloud = result.mode === "cloud-github";
            const n = result.resolvedCount ?? 0;
            const col = persisted ? "var(--green)" : "#93a4b8";
            return (
              <div style={{
                display: "flex", alignItems: "center", gap: 6, fontSize: 10, fontFamily: mono,
                color: col, borderTop: "1px solid var(--border)", paddingTop: 6,
              }}>
                {persisted ? (
                  // synced / cloud icon
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    {cloud
                      ? <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z" />
                      : <><path d="M21 12a9 9 0 1 1-2.64-6.36" /><path d="M21 3v6h-6" /></>}
                  </svg>
                ) : (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
                  </svg>
                )}
                <span style={{ fontWeight: 700 }}>
                  {persisted
                    ? `Report updated${n ? `, ${n} resolved` : ""}${cloud ? " (cloud)" : result.pushedToCloud ? " (synced)" : ""}`
                    : "Live check only, report not updated - needs PC"}
                </span>
                {result.writeNote && (
                  <span style={{ color: "var(--text-muted, #6b7280)", fontWeight: 400 }}>· {result.writeNote}</span>
                )}
              </div>
            );
          })()}
        </div>
      )}
    </div>
  );
}

// ── "Run Da Boss": one big finger-friendly tap = full patrol (target "all") ──
// Surfaces the exact same POST /api/boss/recheck {target:"all"} the granular
// RecheckButton runs, as a prominent control. Honest about persisted:false.
export function RunDaBossButton({ onRechecked, block }: { onRechecked?: () => void; block?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<RecheckResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const mono = "'JetBrains Mono', monospace";

  const run = async () => {
    if (busy) return;
    setBusy(true);
    setErr(null);
    sfx.play("blip-watchdog"); // watchdog tone on start
    try {
      const res = await fetch("/api/boss/recheck", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target: "all" }), cache: "no-store",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j: RecheckResult = await res.json();
      setResult(j);
      if ((j.resolvedCount ?? 0) > 0) sfx.play("chime"); // positive chime only if something got fixed
      onRechecked?.(); // refresh banner, agent states, ops-map red lines from the newly written report
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "run failed");
      sfx.play("blip-watchdog");
    } finally {
      setBusy(false);
    }
  };

  const problems = result
    ? result.checks.reduce((n, c) => n + ((c.items ?? []).filter(i => i.status === "problem").length || (c.status === "problem" ? 1 : 0)), 0)
    : 0;
  const persisted = !!result?.persisted;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, width: block ? "100%" : undefined }}
      onClick={(e) => e.stopPropagation()}>
      <button
        onClick={run}
        disabled={busy}
        aria-label="Run Da Boss - full patrol now"
        style={{
          display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 9,
          minHeight: 44, padding: "0 18px", width: block ? "100%" : undefined,
          borderRadius: 12, cursor: busy ? "wait" : "pointer",
          border: "1px solid var(--accent, #22d3ee)",
          background: busy ? "rgba(34,211,238,0.10)" : "linear-gradient(135deg, rgba(34,211,238,0.22), rgba(167,139,250,0.18))",
          color: "var(--accent, #22d3ee)", fontFamily: mono, fontSize: 13, fontWeight: 700, letterSpacing: "0.06em",
          boxShadow: busy ? "none" : "0 4px 18px rgba(34,211,238,0.18)",
        }}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
          strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
          style={busy ? { animation: "recheckSpin 0.8s linear infinite" } : undefined}>
          {busy
            ? <><path d="M21 12a9 9 0 1 1-2.64-6.36" /><path d="M21 3v6h-6" /></>
            : <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />}
        </svg>
        {busy ? "Da Boss is checking..." : "Run Da Boss"}
      </button>
      <style>{`@keyframes recheckSpin { to { transform: rotate(360deg); } }`}</style>

      {err && <div style={{ fontSize: 11, color: "var(--red)", fontFamily: mono }}>Da Boss run failed: {err}</div>}

      {result && !busy && (
        <div style={{
          border: `1px solid ${statusColor(result.overall)}55`, borderRadius: 10, padding: "9px 11px",
          background: "rgba(255,255,255,0.02)", display: "flex", flexDirection: "column", gap: 5,
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11.5, fontFamily: mono, color: statusColor(result.overall) }}>
            <StatusMark status={result.overall} />
            <span style={{ fontWeight: 700, letterSpacing: "0.06em" }}>
              {problems} problem{problems === 1 ? "" : "s"}
              {(result.resolvedCount ?? 0) > 0 ? `, ${result.resolvedCount} resolved this run` : ""}
            </span>
          </div>
          <div style={{ fontSize: 10.5, fontFamily: mono, color: persisted ? "var(--green)" : "#93a4b8" }}>
            {persisted
              ? `Report updated${result.mode === "cloud-github" ? " (cloud)" : result.pushedToCloud ? " (synced)" : ""}`
              : "Live check only, report not updated - needs PC"}
          </div>
        </div>
      )}
    </div>
  );
}

export function WatchdogBanner({ watchdog, onRechecked }: { watchdog?: WatchdogData | null; onRechecked?: () => void }) {
  const [expanded, setExpanded] = useState<boolean | null>(null);
  const mono = "'JetBrains Mono', monospace";

  const base: React.CSSProperties = {
    borderRadius: 12, padding: "9px 16px", fontFamily: mono,
    display: "flex", flexDirection: "column", gap: 6,
  };

  // Not reported yet (file missing): quiet neutral, never an error.
  if (!watchdog || !watchdog.available) {
    return (
      <div style={{ ...base, border: "1px solid var(--border, var(--border))", background: "var(--bg-card, #0d1117)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Dot color="#6b7280" />
          <span style={{ fontSize: 11, letterSpacing: "0.1em", color: "var(--text-muted, #6b7280)" }}>
            DA BOSS - has not reported yet
          </span>
          <span style={{ marginLeft: "auto" }}>
            <RecheckButton onRechecked={onRechecked} compact />
          </span>
        </div>
        <RunDaBossButton onRechecked={onRechecked} block />
      </div>
    );
  }

  const ageMin = watchdogAgeMin(watchdog.updated);
  const stale = ageMin !== null && ageMin > 180; // watchdog runs every 2h; older than 3h means the watcher itself is silent
  const problems = watchdog.problems;
  const count = Math.max(watchdog.problemCount, problems.length);
  const hasProblems = watchdog.overall === "problems" || count > 0;

  // All clear and fresh: green quiet strip.
  if (!hasProblems && !stale) {
    return (
      <div style={{ ...base, border: `1px solid rgba(${BOSS_CLEAR_RGB},0.35)`, background: `rgba(${BOSS_CLEAR_RGB},0.06)` }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Dot color={BOSS_CLEAR} />
          <span style={{ fontSize: 11, letterSpacing: "0.1em", color: BOSS_CLEAR }}>
            ALL SYSTEMS REPORTING - Da Boss checked {relAge(ageMin)}
          </span>
          <span style={{ marginLeft: "auto", display: "inline-flex", alignItems: "flex-start", gap: 8 }}>
            <RecheckButton onRechecked={onRechecked} compact />
            <WatchdogCopyButton watchdog={watchdog} color={BOSS_CLEAR} />
          </span>
        </div>
        <RunDaBossButton onRechecked={onRechecked} block />
      </div>
    );
  }

  // Problems (red) and/or the watchdog itself late (amber).
  const color = hasProblems ? "var(--red)" : "var(--orange)";
  // Always start COLLAPSED. Only an explicit user tap expands it; every load and
  // every recheck/refresh must default to the tight banner, never auto-open.
  const isOpen = expanded ?? false;
  const toggle = () => {
    sfx.play(isOpen ? "toggle-off" : "toggle-on");
    setExpanded(!isOpen);
  };
  const headline = hasProblems
    ? `DA BOSS: ${count} PROBLEM${count === 1 ? "" : "S"} REPORTED`
    : `DA BOSS ITSELF IS LATE (last report ${relAge(ageMin)})`;

  return (
    <div className="mo-click wd-banner" onClick={toggle} role="button" style={{
      ...base,
      border: `1px solid ${color}66`,
      background: hasProblems ? "rgba(248,113,113,0.08)" : "rgba(251,146,60,0.08)",
    }}>
      <style>{`
        .wd-banner { animation: wdPulse 2.4s ease-in-out infinite; }
        @keyframes wdPulse { 0%,100% { box-shadow: 0 0 0 0 ${color}00; } 50% { box-shadow: 0 0 14px 1px ${color}44; } }
      `}</style>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <Dot color={color} pulse />
        <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: "0.1em", color }}>{headline}</span>
        {hasProblems && stale && (
          <span style={{ fontSize: 10, color: "var(--orange)", border: "1px solid #fb923c55", borderRadius: 99, padding: "1px 8px" }}>
            report is also late ({relAge(ageMin)})
          </span>
        )}
        <span style={{ marginLeft: "auto", display: "inline-flex", alignItems: "flex-start", gap: 8 }}>
          <RecheckButton onRechecked={onRechecked} compact />
          <WatchdogCopyButton watchdog={watchdog} color={color} />
          <span style={{ fontSize: 10, color: "var(--text-muted, #6b7280)" }}>
            {isOpen ? "collapse" : "expand"}
          </span>
        </span>
      </div>

      {/* One-tap full patrol, front and center when there are problems */}
      <RunDaBossButton onRechecked={onRechecked} block />

      {/* collapsed: count + worst (first) problem line */}
      {hasProblems && !isOpen && problems.length > 0 && (
        <div style={{ fontSize: 11.5, color: "var(--text-secondary, #9ca3af)", lineHeight: 1.5, paddingLeft: 19 }}>
          <ProblemLine p={problems[0]} color={color} />
          {count > 1 && <span style={{ color: "var(--text-muted, #6b7280)" }}> (+{count - 1} more)</span>}
        </div>
      )}

      {/* expanded: every problem, one line each, with its suggested action */}
      {isOpen && (
        <div style={{ display: "flex", flexDirection: "column", gap: 5, paddingLeft: 19 }}>
          {problems.map((p, i) => (
            <div key={i} style={{ fontSize: 11.5, color: "var(--text-secondary, #9ca3af)", lineHeight: 1.5, borderLeft: `2px solid ${color}55`, paddingLeft: 8 }}>
              <ProblemLine p={p} color={color} />
            </div>
          ))}
          {hasProblems && problems.length === 0 && (
            <div style={{ fontSize: 11.5, color: "var(--text-secondary, #9ca3af)" }}>
              The report counts {count} problem{count === 1 ? "" : "s"} but lists no detail lines.
            </div>
          )}
          {watchdog.resolved.length > 0 && (
            <div style={{ fontSize: 10.5, color: "var(--text-muted, #6b7280)", lineHeight: 1.5 }}>
              resolved: {watchdog.resolved.slice(0, 4).join("; ")}
            </div>
          )}
          {stale && hasProblems && (
            <div style={{ fontSize: 10.5, color: "var(--orange)" }}>
              Da Boss report itself is older than 3 hours - Da Boss being silent is also a problem.
            </div>
          )}
          <div style={{ fontSize: 10, color: "var(--text-muted, #6b7280)" }}>
            last report from Da Boss {relAge(ageMin)}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Agent tile (calm: name + status dot + ONE line) ────────────────────────
export function AgentTile({ a, onSelect }: { a: AgentCard; onSelect: (s: Selection) => void }) {
  let color = "var(--text-muted, #6b7280)";
  let pulse = false;
  let line = a.schedule;
  const trial = !a.enabled && !!a.trial;
  if (trial) { color = "var(--orange)"; line = "TRIAL"; }
  else if (!a.enabled) { line = "disabled"; }
  else if (a.watchdogState === "SILENT") { color = "var(--red)"; pulse = true; line = "SILENT (Da Boss)"; }
  else if (a.watchdogState === "LATE") { color = "var(--orange)"; pulse = true; line = "LATE (Da Boss)"; }
  else if (a.pcNeeded && a.kind === "scheduled") { color = "var(--orange)"; line = "PC needed"; }
  else if (a.nextRunAt) { color = "var(--accent)"; pulse = true; line = `next ${fmtCountdown(a.nextRunAt)}`; }
  else if (a.lastLogDate) { color = "var(--green)"; pulse = true; line = `last seen ${a.lastLogDate}`; }
  else if (a.kind === "crew") { line = "on demand"; }

  return (
    <div
      onClick={() => { sfx.play("blip"); onSelect({ type: "agent", key: a.key }); }}
      className="mo-click"
      style={{
        background: "var(--bg-card, #0d1117)",
        border: "1px solid var(--border, var(--border))",
        borderRadius: 12, padding: "12px 16px",
        display: "flex", alignItems: "center", gap: 10,
        opacity: a.enabled || trial ? 1 : 0.5,
        borderColor: trial ? "rgba(251,146,60,0.4)" : undefined,
      }}
    >
      <Dot color={color} pulse={pulse} />
      <span style={{ fontWeight: 600, fontSize: 14, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{a.name}</span>
      {trial ? (
        <span style={{ marginLeft: "auto" }}><Pill text="TRIAL" color="var(--orange)" /></span>
      ) : (
        <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--text-muted)", fontFamily: "'JetBrains Mono', monospace", whiteSpace: "nowrap" }}>
          {line}
        </span>
      )}
    </div>
  );
}

// ── Stat tiles (clickable: each opens its breakdown panel) ─────────────────
// A tiny freshness affordance shared by tiles and panels: a green pulsing
// "live" dot for live sources, or a muted age label for snapshots. Stale
// snapshots turn amber so a stale value can never read as a confident stat.
export function FreshnessMark({ source, updated, stale }: { source: MetricSource; updated: string | null; stale?: boolean }) {
  const mono = "'JetBrains Mono', monospace";
  if (source === "live-db" || source === "live-ghl") {
    return (
      <span title={source === "live-db" ? "Live from prospects.db, just now" : "Live from the GHL API, just now"}
        style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 9, color: "var(--green)", fontFamily: mono }}>
        <Dot color="var(--green)" pulse /> live
      </span>
    );
  }
  const age = fmtAge(updated);
  const color = stale ? "var(--orange)" : "var(--text-muted, #6b7280)";
  return (
    <span title={stale ? "From a snapshot and past its freshness window — may be stale, needs PC or state-sync" : `From snapshot${age ? `, ${age}` : ""}`}
      style={{ fontSize: 9, color, fontFamily: mono }}>
      {stale ? "stale " : ""}{age ? (source === "snapshot" ? `as of ${age}` : age) : "snapshot"}
    </span>
  );
}

// Legend explaining the live vs snapshot affordance. One quiet line.
export function FreshnessLegend() {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap", fontSize: 10, color: "var(--text-muted)", fontFamily: "'JetBrains Mono', monospace" }}>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}><Dot color="var(--green)" /> live — queried from the source just now</span>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}><Dot color="#6b7280" /> snapshot — shows its real age</span>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 5, color: "var(--orange)" }}><Dot color="var(--orange)" /> stale — past its freshness window, needs PC</span>
    </div>
  );
}

export function StatTiles({ tiles, onSelect }: { tiles: StatTile[]; onSelect: (s: Selection) => void }) {
  if (!tiles.length) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12 }}>
        {tiles.map((t) => {
          const live = t.source === "live-db" || t.source === "live-ghl";
          // Stale snapshot values render muted/amber, never as a bright stat.
          const valueColor = t.stale ? "var(--orange)" : live ? "var(--text-primary)" : "var(--text-secondary, #9ca3af)";
          return (
            <div key={t.label} className="mo-click" onClick={() => { sfx.play("ping"); onSelect({ type: "stat", key: t.key }); }}
              title={t.provenance || "Click for the breakdown"}
              style={{
                background: "var(--bg-card, #0d1117)",
                border: `1px solid ${t.stale ? "rgba(251,146,60,0.4)" : "var(--border, rgba(255,255,255,0.08))"}`,
                borderRadius: 12, padding: "14px 16px", minWidth: 0, overflow: "hidden",
                opacity: t.stale ? 0.85 : 1,
              }}>
              {/* Value + freshness mark share a row so the mark can never sit on
                  top of a wide value; the mark holds its own column and wraps. */}
              <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
                <div style={{ fontSize: 26, fontWeight: 700, color: valueColor, fontFamily: "'Space Grotesk', sans-serif", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.value}</div>
                <span style={{ flexShrink: 0, marginTop: 2, textAlign: "right", maxWidth: "45%" }}>
                  <FreshnessMark source={t.source} updated={t.updated} stale={t.stale} />
                </span>
              </div>
              {/* Label + provenance sub truncate to one line; full text in tooltip. */}
              <div title={t.sub ? `${t.label} · ${t.sub}` : t.label}
                style={{ fontSize: 10, letterSpacing: "0.12em", color: "var(--text-muted)", textTransform: "uppercase", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", marginTop: 2 }}>
                {t.label}{t.sub ? <span style={{ textTransform: "none", letterSpacing: 0 }}> · {t.sub}</span> : null}
              </div>
            </div>
          );
        })}
      </div>
      <FreshnessLegend />
    </div>
  );
}

// ── Next-24h schedule strip: what fires next, in firing order ──────────────
export function NextUpStrip({ agents, onSelect }: { agents: AgentCard[]; onSelect: (s: Selection) => void }) {
  const upcoming = agents
    .filter((a) => a.kind === "scheduled" && a.enabled && a.nextRunAt)
    .filter((a) => new Date(a.nextRunAt as string).getTime() - Date.now() < 24 * 3600_000)
    .sort((a, b) => new Date(a.nextRunAt as string).getTime() - new Date(b.nextRunAt as string).getTime());
  if (!upcoming.length) return null;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", background: "var(--bg-card, #0d1117)", border: "1px solid var(--border, var(--border))", borderRadius: 12, padding: "8px 14px" }}>
      <span style={{ fontSize: 10, letterSpacing: "0.12em", color: "var(--text-muted)" }}>NEXT 24H</span>
      {upcoming.map((a) => (
        <span key={a.key} className="mo-click" onClick={() => { sfx.play("blip"); onSelect({ type: "agent", key: a.key }); }}
          style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11, fontFamily: "'JetBrains Mono', monospace", color: "var(--text-secondary)", border: "1px solid var(--border, var(--border))", borderRadius: 99, padding: "3px 10px" }}>
          <Dot color="var(--accent)" />
          {a.name}
          <span style={{ color: "var(--accent, #22d3ee)" }}>{fmtCountdown(a.nextRunAt as string)}</span>
        </span>
      ))}
    </div>
  );
}

// ── Feed list (click a line to expand the full entry) ──────────────────────
export function FeedList({ feed, limit }: { feed: FeedEntry[]; limit?: number }) {
  const [open, setOpen] = useState<number | null>(null);
  const shown = limit ? feed.slice(0, limit) : feed;
  return (
    <>
      {shown.length === 0 && <div style={{ fontSize: 12, color: "var(--text-muted)" }}>log.md unavailable</div>}
      {shown.map((e, i) => {
        const expanded = open === i;
        return (
          <div key={i} className="mo-feedline" style={{ marginBottom: 12, fontFamily: "'JetBrains Mono', monospace" }}
            onClick={() => { sfx.play("nav"); setOpen(expanded ? null : i); }}>
            <div style={{ fontSize: 11, display: "flex", gap: 8, alignItems: "baseline" }}>
              <span style={{ color: "var(--text-muted)" }}>{shortDate(e.date)}</span>
              <span style={{ color: TYPE_COLOR[e.type] ?? "var(--text-secondary)", textTransform: "uppercase", fontSize: 10, letterSpacing: "0.08em" }}>{e.type}</span>
              <span style={{ marginLeft: "auto", color: "var(--text-muted)", fontSize: 10 }}>{expanded ? "collapse" : "expand"}</span>
            </div>
            <div style={{ fontSize: 12, color: "var(--text-primary)", margin: "2px 0" }}>{expanded ? e.title : tightLine(e.title)}</div>
            {(expanded ? e.lines : []).map((l, j) => (
              <div key={j} style={{ fontSize: 11, color: "var(--text-muted)", lineHeight: 1.5 }}>{l}</div>
            ))}
          </div>
        );
      })}
    </>
  );
}

// ── Feed ticker (calm main-view default: ~6 one-liners + "view all") ───────
export function FeedTicker({ feed }: { feed: FeedEntry[] }) {
  const [all, setAll] = useState(false);
  if (all) {
    return (
      <div>
        <button onClick={() => setAll(false)} style={{
          background: "none", border: "none", color: "var(--accent, #22d3ee)",
          cursor: "pointer", fontSize: 11, padding: 0, marginBottom: 8,
        }}>collapse ticker</button>
        <FeedList feed={feed} limit={40} />
      </div>
    );
  }
  const shown = feed.slice(0, 6);
  return (
    <div>
      {shown.length === 0 && <div style={{ fontSize: 12, color: "var(--text-muted)" }}>log.md unavailable</div>}
      {shown.map((e, i) => (
        <div key={i} style={{
          display: "flex", gap: 8, alignItems: "baseline", marginBottom: 7,
          fontFamily: "'JetBrains Mono', monospace",
        }}>
          <span style={{ fontSize: 10, color: "var(--text-muted)", flexShrink: 0 }}>{shortDate(e.date)}</span>
          <span style={{
            fontSize: 12, color: "var(--text-secondary)",
            whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
          }}>{tightLine(e.title)}</span>
        </div>
      ))}
      {feed.length > 6 && (
        <button onClick={() => setAll(true)} style={{
          background: "none", border: "none", color: "var(--accent, #22d3ee)",
          cursor: "pointer", fontSize: 11, padding: 0,
        }}>view all ({feed.length})</button>
      )}
    </div>
  );
}

// ── Agent feed (os_feed via /api/notify) ───────────────────────────────────
// Relative age for a full ISO timestamp: "12m ago", "3h ago", "2d ago".
function isoAge(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const min = Math.floor((Date.now() - t) / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// What the scheduled agents reported back, newest first. Push-level entries
// (the ones that also hit Jack's phone) carry an accent rail and label.
export function AgentFeed({ entries }: { entries: AgentFeedEntry[] }) {
  const [all, setAll] = useState(false);
  const shown = all ? entries.slice(0, 25) : entries.slice(0, 6);
  return (
    <section style={{ background: "var(--bg-card, #0d1117)", border: "1px solid var(--border, var(--border))", borderRadius: 12, padding: 16 }}>
      <h2 style={{ fontSize: 11, letterSpacing: "0.14em", color: "var(--text-muted)", marginBottom: 10 }}>AGENT FEED</h2>
      {entries.length === 0 && (
        <div style={{ fontSize: 12, color: "var(--text-muted)" }}>no agent reports yet</div>
      )}
      {shown.map((e) => {
        const push = e.level === "push";
        return (
          <div
            key={e.id}
            style={{
              borderLeft: `2px solid ${push ? "var(--accent, #22d3ee)" : "var(--border, rgba(255,255,255,0.08))"}`,
              paddingLeft: 10,
              marginBottom: 10,
            }}
          >
            <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap", fontFamily: "'JetBrains Mono', monospace" }}>
              <span style={{ fontSize: 10, letterSpacing: "0.1em", color: push ? "var(--accent, #22d3ee)" : "var(--accent-2, #a78bfa)" }}>
                {e.agent.toUpperCase()}
              </span>
              {push && <span style={{ fontSize: 9, letterSpacing: "0.1em", color: "var(--accent, #22d3ee)" }}>PUSHED</span>}
              <span style={{ marginLeft: "auto", fontSize: 10, color: "var(--text-muted)" }}>{isoAge(e.created_at)}</span>
            </div>
            <div style={{ fontSize: 13, color: "var(--text-secondary)", marginTop: 3, fontWeight: push ? 600 : 400 }}>
              {e.url ? (
                <a href={e.url} style={{ color: "inherit", textDecoration: "none", borderBottom: "1px dotted var(--border)" }}>{e.title}</a>
              ) : (
                e.title
              )}
            </div>
            {e.body && (
              <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2, lineHeight: 1.45 }}>{e.body}</div>
            )}
          </div>
        );
      })}
      {entries.length > 6 && (
        <button onClick={() => setAll(!all)} style={{
          background: "none", border: "none", color: "var(--accent, #22d3ee)",
          cursor: "pointer", fontSize: 11, padding: 0,
        }}>{all ? "collapse" : `view all (${entries.length})`}</button>
      )}
    </section>
  );
}

// ── Client health strip (clickable dots) ───────────────────────────────────
export function ClientHealthStrip({
  health, sourcesOk, onSelect,
}: {
  health: { runDate: string | null; clients: ClientHealth[] };
  sourcesOk: boolean;
  onSelect: (s: Selection) => void;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 14, background: "var(--bg-card, #0d1117)", border: "1px solid var(--border, var(--border))", borderRadius: 12, padding: "10px 16px", flexWrap: "wrap" }}>
      <span style={{ fontSize: 10, letterSpacing: "0.12em", color: "var(--text-muted)" }}>CLIENT HEALTH</span>
      {health.clients.length === 0 && (
        <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
          {sourcesOk ? "no clients on the board" : "health board unavailable"}
        </span>
      )}
      {health.clients.map((c) => (
        <div key={c.client} className="mo-click" style={{ display: "flex", alignItems: "center", gap: 7 }}
          onClick={() => { sfx.play("blip"); onSelect({ type: "client", name: c.client }); }}>
          <Dot color={STATUS_COLOR[c.overall]} pulse={c.overall !== "green"} />
          <span style={{ fontSize: 13 }}>{c.client}</span>
        </div>
      ))}
      {health.runDate && (
        <span style={{ marginLeft: "auto", fontSize: 10, color: "var(--text-muted)", fontFamily: "'JetBrains Mono', monospace" }}>
          sentinel run {health.runDate}
        </span>
      )}
    </div>
  );
}

// ── Slide-over panel shell ─────────────────────────────────────────────────
function SlideOver({ title, accent, onClose, children }: {
  title: string; accent: string; onClose: () => void; children: React.ReactNode;
}) {
  // Panel open whoosh once on mount; close plays a fall.
  useEffect(() => { sfx.play("open"); }, []);
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  const close = () => { sfx.play("close"); onClose(); };
  const overlay = (
    <div style={{ position: "fixed", inset: 0, zIndex: 200 }}>
      <div onClick={close} style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.55)" }} />
      <div className="mo-panel" style={{
        position: "absolute", top: 0, right: 0, bottom: 0,
        width: "min(480px, 94vw)",
        background: "var(--bg-secondary, #0a0d14)",
        borderLeft: `1px solid ${accent}55`,
        boxShadow: "-12px 0 40px rgba(0,0,0,0.5)",
        display: "flex", flexDirection: "column",
      }}>
        {/* tap-close handle target (styled as a grab handle on the phone bottom sheet) */}
        <div className="mo-panel-close" onClick={close} aria-label="Close panel" style={{
          display: "flex", alignItems: "center", gap: 10, padding: "14px 18px",
          borderBottom: "1px solid var(--border, var(--border))", cursor: "pointer",
        }}>
          <Dot color={accent} pulse />
          <span style={{ fontSize: 13, fontWeight: 700, letterSpacing: "0.1em", fontFamily: "'JetBrains Mono', monospace" }}>{title}</span>
          <button onClick={close} style={{
            marginLeft: "auto", background: "none", border: "1px solid var(--border, var(--border))",
            color: "var(--text-secondary, #9ca3af)", borderRadius: 8, padding: "8px 14px", cursor: "pointer", fontSize: 12,
          }}>Close</button>
        </div>
        <div style={{ overflowY: "auto", WebkitOverflowScrolling: "touch", padding: "16px 18px", flex: 1 }}>{children}</div>
      </div>
    </div>
  );
  // Portal to <body> so the fixed overlay escapes any transformed ancestor
  // (the view-transition animations create a containing block that would
  // otherwise trap position:fixed and stop the phone bottom sheet from
  // spanning full width).
  return mounted ? createPortal(overlay, document.body) : null;
}

// Collapsible section used inside panels: keeps detail tucked away by default.
function Section({ title, defaultOpen, children }: {
  title: string; defaultOpen?: boolean; children: React.ReactNode;
}) {
  const [open, setOpen] = useState(!!defaultOpen);
  return (
    <div style={{ borderTop: "1px solid var(--border, var(--border))", marginTop: 12, paddingTop: 8 }}>
      <div className="mo-click" onClick={() => { sfx.play(open ? "toggle-off" : "toggle-on"); setOpen(o => !o); }}
        style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 10, letterSpacing: "0.14em", color: "var(--text-muted)", textTransform: "uppercase" }}>{title}</span>
        <span style={{ marginLeft: "auto", fontSize: 10, color: "var(--text-muted)" }}>{open ? "−" : "+"}</span>
      </div>
      {open && <div style={{ marginTop: 8 }}>{children}</div>}
    </div>
  );
}

const DIR_ARROW: Record<string, string> = { reads: "reads from", writes: "writes to", both: "reads + writes" };

// Distilled artifact view: headline numbers up front, raw excerpt tucked away.
function DistilledExcerpt({ distilled, raw, accent }: { distilled: string[]; raw: string[]; accent: string }) {
  const [showRaw, setShowRaw] = useState(false);
  const lead = distilled.length ? distilled : raw.slice(0, 8);
  return (
    <>
      <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
        {lead.map((l, i) => (
          <div key={i} style={{
            fontSize: 12, fontFamily: "'JetBrains Mono', monospace",
            color: "var(--text-secondary)", borderLeft: `2px solid ${accent}44`, paddingLeft: 8, lineHeight: 1.45,
          }}>{l}</div>
        ))}
        {lead.length === 0 && <div style={{ fontSize: 12, color: "var(--text-muted)" }}>No content available.</div>}
      </div>
      {raw.length > 0 && (
        <button onClick={() => setShowRaw(r => !r)} style={{
          background: "none", border: "none", color: "var(--accent, #22d3ee)",
          cursor: "pointer", fontSize: 11, padding: 0, marginTop: 8,
        }}>{showRaw ? "hide raw" : "view raw"}</button>
      )}
      {showRaw && (
        <div style={{
          fontSize: 11, fontFamily: "'JetBrains Mono', monospace", color: "var(--text-secondary)",
          background: "var(--bg-card, #0d1117)", border: "1px solid var(--border, var(--border))",
          borderRadius: 8, padding: "8px 10px", lineHeight: 1.6, whiteSpace: "pre-wrap", wordBreak: "break-word", marginTop: 6,
        }}>
          {raw.join("\n")}
        </div>
      )}
    </>
  );
}

// Real outbound links row (opens the actual thing in a new tab).
function LinkRow({ links, accent }: { links: RealLink[]; accent: string }) {
  if (!links.length) return null;
  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}>
      {links.map((l) => (
        <a key={l.url} href={l.url} target="_blank" rel="noreferrer"
          style={{ fontSize: 12, color: accent, textDecoration: "none", border: `1px solid ${accent}55`, borderRadius: 8, padding: "6px 12px", display: "inline-block" }}>
          {l.label} &#8599;
        </a>
      ))}
    </div>
  );
}

// Vault path as copyable text (the browser cannot open Obsidian files, so the
// honest affordance is copy-the-path).
function CopyPath({ path }: { path: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6 }}>
      <span style={{ fontSize: 10, color: "var(--text-muted)", fontFamily: "'JetBrains Mono', monospace", wordBreak: "break-all" }}>{path}</span>
      <button
        onClick={() => {
          navigator.clipboard?.writeText(path).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }).catch(() => {});
        }}
        style={{ background: "none", border: "1px solid var(--border, var(--border))", color: copied ? "var(--green)" : "var(--text-secondary, #9ca3af)", borderRadius: 6, padding: "2px 8px", cursor: "pointer", fontSize: 10, flexShrink: 0 }}>
        {copied ? "copied" : "copy vault path"}
      </button>
    </div>
  );
}

// Plain-English summary block the panels lead with.
function SummaryBlock({ lines, accent }: { lines: string[]; accent: string }) {
  return (
    <div style={{
      borderLeft: `2px solid ${accent}`, paddingLeft: 12, margin: "10px 0 4px",
      display: "flex", flexDirection: "column", gap: 4,
    }}>
      {lines.filter(Boolean).map((l, i) => (
        <div key={i} style={{ fontSize: 13, color: i === 0 ? "var(--text-primary)" : "var(--text-secondary)", lineHeight: 1.5 }}>{l}</div>
      ))}
    </div>
  );
}

// ── Agent detail panel (fetches /api/mission?agent=key) ────────────────────
function AgentPanel({ agentKey, onClose, onSelect }: {
  agentKey: string; onClose: () => void; onSelect: (s: Selection) => void;
}) {
  const [detail, setDetail] = useState<AgentDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [moreActivity, setMoreActivity] = useState(false);

  useEffect(() => {
    let alive = true;
    setDetail(null); setErr(null); setMoreActivity(false);
    fetch(`/api/mission?agent=${encodeURIComponent(agentKey)}`, { cache: "no-store" })
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(j => { if (alive) setDetail(j); })
      .catch(e => { if (alive) setErr(e instanceof Error ? e.message : "fetch failed"); });
    return () => { alive = false; };
  }, [agentKey]);

  const statusColor =
    detail?.status === "active" ? "var(--green)" :
    detail?.status === "scheduled" ? "var(--accent)" :
    detail?.status === "trial" ? "var(--orange)" :
    detail?.status === "disabled" ? "#6b7280" : "#9ca3af";

  const producedArtifacts = ARTIFACTS.filter(a => a.producedBy === agentKey);
  const activity = detail?.activity ?? [];
  const shownActivity = moreActivity ? activity : activity.slice(0, 8);

  return (
    <SlideOver title={detail ? detail.name.toUpperCase() : "AGENT"} accent={statusColor} onClose={onClose}>
      {!detail && !err && <div style={{ fontSize: 12, color: "var(--text-muted)", fontFamily: "'JetBrains Mono', monospace" }}>Loading agent telemetry...</div>}
      {err && <div style={{ fontSize: 12, color: "var(--red)" }}>Could not load agent detail ({err})</div>}
      {detail && (
        <>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 4 }}>
            <Pill text={detail.status.toUpperCase()} color={statusColor} />
            <Pill text={detail.kind === "scheduled" ? "SCHEDULED" : "ON DEMAND"} color="var(--text-muted, #6b7280)" />
            {detail.watchdogState === "SILENT" && <Pill text="SILENT (DA BOSS)" color="var(--red)" />}
            {detail.watchdogState === "LATE" && <Pill text="LATE (DA BOSS)" color="var(--orange)" />}
            {detail.watchdogState === "DISABLED" && <Pill text="DISABLED (DA BOSS)" color="#6b7280" />}
            {detail.installed === false && <Pill text="NOT INSTALLED" color="var(--orange)" />}
          </div>

          {/* lead: what this is / what it did last / what happens next */}
          <SummaryBlock accent={statusColor} lines={[
            detail.summary?.what ?? detail.role,
            detail.summary?.last ?? "",
            detail.summary?.next ?? "",
          ]} />

          <Section title={`Activity (${activity.length})`} defaultOpen>
            {activity.length === 0 && <div style={{ fontSize: 12, color: "var(--text-muted)" }}>No log entries mention this agent yet.</div>}
            <FeedList feed={shownActivity} />
            {activity.length > 8 && !moreActivity && (
              <button onClick={() => setMoreActivity(true)} style={{
                background: "none", border: "none", color: "var(--accent, #22d3ee)",
                cursor: "pointer", fontSize: 11, padding: 0,
              }}>show more ({activity.length - 8})</button>
            )}
            {(detail.olderActivity ?? 0) > 0 && (
              <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 6 }}>
                Showing the last 7 days. Older activity exists ({detail.olderActivity} earlier entr{detail.olderActivity === 1 ? "y" : "ies"} in log.md).
              </div>
            )}
          </Section>

          <Section title="Schedule">
            <div style={{ fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.5 }}>{detail.scheduleHuman}</div>
            <div style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "'JetBrains Mono', monospace", marginTop: 4 }}>
              {detail.nextRunAt && <>next run {fmtCountdown(detail.nextRunAt)} ({new Date(detail.nextRunAt).toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit" })})<br /></>}
              {detail.lastRunAt && <>last run {new Date(detail.lastRunAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</>}
              {!detail.nextRunAt && !detail.lastRunAt && "no recorded runs"}
            </div>
            {RUN_PHRASE[detail.key] && (
              <div style={{ marginTop: 10, fontSize: 12, color: "var(--text-secondary)", background: "var(--bg-card, #0d1117)", border: "1px solid var(--border, var(--border))", borderRadius: 8, padding: "8px 10px", lineHeight: 1.5 }}>
                Run it now: the OS is read-only, so tell Claude{" "}
                <span style={{ fontFamily: "'JetBrains Mono', monospace", color: "var(--accent, #22d3ee)" }}>&quot;{RUN_PHRASE[detail.key]}&quot;</span>
              </div>
            )}
          </Section>

          <Section title="Connections">
            {detail.systems.map(w => {
              const sys = SYSTEMS.find(s => s.id === w.id);
              return (
                <div key={w.id} className="mo-click" style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, marginBottom: 5 }}
                  onClick={() => onSelect({ type: "system", id: w.id })}>
                  <Dot color={sys?.color ?? "#9ca3af"} />
                  <span style={{ fontFamily: "'JetBrains Mono', monospace", color: sys?.color ?? "var(--text-secondary)" }}>{w.label}</span>
                  <span style={{ color: "var(--text-muted)" }}>{DIR_ARROW[w.direction]}</span>
                </div>
              );
            })}
            {producedArtifacts.map(a => (
              <div key={a.id} className="mo-click" style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, marginBottom: 5 }}
                onClick={() => onSelect({ type: "artifact", id: a.id })}>
                <span style={{ color: "var(--text-muted)", fontSize: 11 }}>produces</span>
                <span style={{ fontFamily: "'JetBrains Mono', monospace", color: "var(--accent, #22d3ee)" }}>{a.label}</span>
              </div>
            ))}
          </Section>

          <Section title="Full role">
            <div style={{ fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.55 }}>{detail.description}</div>
          </Section>

          {detail.artifact && (
            <Section title={detail.artifact.title}>
              <DistilledExcerpt
                distilled={detail.artifact.distilled ?? []}
                raw={detail.artifact.lines}
                accent={statusColor}
              />
            </Section>
          )}
        </>
      )}
    </SlideOver>
  );
}

// ── Artifact panel (fetches /api/mission?artifact=id) ──────────────────────
function ArtifactPanel({ artifactId, onClose, onSelect }: {
  artifactId: string; onClose: () => void; onSelect: (s: Selection) => void;
}) {
  const [detail, setDetail] = useState<ArtifactDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setDetail(null); setErr(null);
    fetch(`/api/mission?artifact=${encodeURIComponent(artifactId)}`, { cache: "no-store" })
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(j => { if (alive) setDetail(j); })
      .catch(e => { if (alive) setErr(e instanceof Error ? e.message : "fetch failed"); });
    return () => { alive = false; };
  }, [artifactId]);

  const sys = detail ? SYSTEMS.find(s => s.id === detail.system) : null;
  const accent = sys?.color ?? "var(--accent)";

  return (
    <SlideOver title={detail ? detail.label.toUpperCase() : "ARTIFACT"} accent={accent} onClose={onClose}>
      {!detail && !err && <div style={{ fontSize: 12, color: "var(--text-muted)", fontFamily: "'JetBrains Mono', monospace" }}>Loading artifact...</div>}
      {err && <div style={{ fontSize: 12, color: "var(--red)" }}>Could not load artifact ({err})</div>}
      {detail && (
        <>
          <SummaryBlock accent={accent} lines={[
            detail.blurb,
            `Produced by ${detail.producedByName}.`,
            detail.updated ? `Last updated ${detail.updated}.` : detail.available ? "Update date unknown." : "File unavailable from here.",
          ]} />

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "10px 0" }}>
            <span className="mo-click" onClick={() => onSelect({ type: "agent", key: detail.producedBy })}>
              <Pill text={detail.producedByName.toUpperCase()} color="var(--accent)" />
            </span>
            {sys && (
              <span className="mo-click" onClick={() => onSelect({ type: "system", id: sys.id })}>
                <Pill text={sys.label} color={sys.color} />
              </span>
            )}
          </div>

          <LinkRow links={detail.links ?? []} accent={accent} />

          <Section title="Content" defaultOpen>
            <DistilledExcerpt distilled={detail.distilled ?? []} raw={detail.lines} accent={accent} />
            <CopyPath path={detail.path} />
          </Section>
        </>
      )}
    </SlideOver>
  );
}

// ── Stat breakdown panel (fetches /api/mission?stat=key) ───────────────────
function StatPanel({ statKey, onClose, onSelect }: {
  statKey: string; onClose: () => void; onSelect: (s: Selection) => void;
}) {
  const [detail, setDetail] = useState<StatDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setDetail(null); setErr(null);
    fetch(`/api/mission?stat=${encodeURIComponent(statKey)}`, { cache: "no-store" })
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(j => { if (alive) setDetail(j); })
      .catch(e => { if (alive) setErr(e instanceof Error ? e.message : "fetch failed"); });
    return () => { alive = false; };
  }, [statKey]);

  const accent = "var(--accent)";
  const age = fmtAge(detail?.updated ?? null);
  return (
    <SlideOver title={detail ? detail.title.toUpperCase() : "STAT"} accent={accent} onClose={onClose}>
      {!detail && !err && <div style={{ fontSize: 12, color: "var(--text-muted)", fontFamily: "'JetBrains Mono', monospace" }}>Loading breakdown...</div>}
      {err && <div style={{ fontSize: 12, color: "var(--red)" }}>Could not load breakdown ({err})</div>}
      {detail && (
        <>
          {/* Every panel states its source line at top: live vs snapshot age. */}
          <div style={{
            display: "flex", alignItems: "center", gap: 8, marginBottom: 8, padding: "6px 10px", borderRadius: 8,
            border: `1px solid ${detail.stale ? "rgba(251,146,60,0.4)" : "var(--border, rgba(255,255,255,0.08))"}`,
            background: detail.stale ? "rgba(251,146,60,0.06)" : "rgba(255,255,255,0.02)",
          }}>
            <FreshnessMark source={detail.source ?? "snapshot"} updated={detail.updated} stale={detail.stale} />
            <span style={{ fontSize: 11, color: detail.stale ? "var(--orange)" : "var(--text-secondary, #9ca3af)", fontFamily: "'JetBrains Mono', monospace" }}>
              {detail.provenance ?? (age ? `From snapshot, ${age}` : "From snapshot")}
            </span>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 4 }}>
            {!detail.available && <Pill text="SNAPSHOT UNAVAILABLE" color="var(--orange)" />}
          </div>
          <SummaryBlock accent={accent} lines={detail.summary} />
          {detail.items.length > 0 && (
            <Section title={`Breakdown (${detail.items.length})`} defaultOpen>
              {detail.items.map((it, i) => (
                <div key={i} style={{ display: "flex", alignItems: "baseline", gap: 10, fontSize: 12.5, marginBottom: 7, borderBottom: "1px solid var(--border, var(--border))", paddingBottom: 6 }}>
                  <span style={{ color: "var(--text-secondary)", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{it.label}</span>
                  <span style={{ fontFamily: "'JetBrains Mono', monospace", color: "var(--text-primary)", flexShrink: 0 }}>{it.value}</span>
                  {it.note && <span style={{ color: "var(--text-muted)", fontSize: 11, flexShrink: 0 }}>{it.note}</span>}
                </div>
              ))}
            </Section>
          )}
          {detail.note && (
            <div style={{ fontSize: 11, color: "var(--text-muted)", lineHeight: 1.5, marginTop: 12, borderLeft: "2px solid var(--border, var(--border))", paddingLeft: 10 }}>
              {detail.note}
            </div>
          )}
          <LinkRow links={detail.links ?? []} accent={accent} />
          {statKey === "clients" && (
            <div style={{ marginTop: 14 }}>
              <a href="/?section=clients" style={{ fontSize: 12, color: accent, textDecoration: "none", border: `1px solid ${accent}55`, borderRadius: 8, padding: "6px 12px", display: "inline-block" }}
                onClick={(e) => {
                  // In the main app, jump to the Clients section in place.
                  if (typeof window !== "undefined" && window.location.pathname === "/") {
                    e.preventDefault();
                    window.dispatchEvent(new CustomEvent("os:navigate", { detail: "clients" }));
                    onClose();
                  }
                }}>
                Open Clients section →
              </a>
            </div>
          )}
          {statKey === "pipeline" && (
            <div style={{ marginTop: 14 }}>
              <span className="mo-click" onClick={() => onSelect({ type: "artifact", id: "outreach-snapshot" })}>
                <Pill text="OUTREACH SNAPSHOT" color={accent} />
              </span>
            </div>
          )}
        </>
      )}
    </SlideOver>
  );
}

// ── Scheduler calendar (the known cron schedule as a week grid + today list)
// Derived from the crons the mission API already knows about. Times are local.
interface CalEntry {
  key: string; // agent key, or "watchdog" for the overseer
  label: string;
  color: string;
  days: number[]; // 0=Mon .. 6=Sun
  time?: string; // "07:00" single daily/weekly fire
  band?: { start: string; end: string; every: string; everyMin: number }; // high-frequency window
}
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
const CAL_ENTRIES: CalEntry[] = [
  { key: "b2b-prospector-daily", label: "Prospector", color: "var(--orange)", days: ALL_DAYS, time: "06:15" },
  { key: "sentinel-daily", label: "Sentinel", color: "var(--green)", days: ALL_DAYS, time: "07:00" },
  { key: "content-engine-weekly", label: "Content Engine", color: "#f472b6", days: [0], time: "07:00" },
  { key: "renewal-content-weekly", label: "Renewal Content", color: "var(--accent-2)", days: [0], time: "07:40" },
  { key: "chronicler-end-of-day", label: "Chronicler", color: "var(--accent)", days: ALL_DAYS, time: "21:47" },
  { key: "b2b-outreach-engine", label: "Outreach", color: "var(--accent)", days: ALL_DAYS, band: { start: "08:00", end: "20:00", every: "every 30 min", everyMin: 30 } },
  { key: "watchdog", label: "Da Boss", color: "var(--red)", days: ALL_DAYS, band: { start: "06:00", end: "22:00", every: "every 2h", everyMin: 120 } },
];
const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
// Green used across the calendar to mark an entry whose scheduled time is in the
// past — i.e. it already ran this week. Upcoming entries stay neutral.
const CAL_RAN_GREEN = "var(--green)";

function hm(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}
function fmtClock(t: string): string {
  const [h, m] = t.split(":").map(Number);
  const hr = ((h + 11) % 12) + 1;
  return `${hr}:${String(m).padStart(2, "0")}${h < 12 ? "am" : "pm"}`;
}
// Monday-based day index for a Date.
function dayIdx(d: Date): number {
  return (d.getDay() + 6) % 7;
}
function startOfWeekMonday(d: Date): Date {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() - dayIdx(x));
  return x;
}
function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}
// A single thing scheduled on a given day: an agent task fire or a content post.
type DayItem =
  | { kind: "agent"; e: CalEntry; when: string; sortMin: number }
  | { kind: "content"; c: ContentCalItem; when: string; sortMin: number };

export function SchedulerCalendar({ agents, content = [], onSelect }: {
  agents: AgentCard[]; content?: ContentCalItem[]; onSelect: (s: Selection) => void;
}) {
  const byKey = new Map(agents.map(a => [a.key, a]));
  // Only show entries for agents that exist and are enabled (watchdog always shows).
  const entries = CAL_ENTRIES.filter(e => e.key === "watchdog" || (byKey.get(e.key)?.enabled ?? false));
  const now = new Date();

  const [view, setView] = useState<"week" | "month">("week");
  const [offset, setOffset] = useState(0); // weeks (week view) or months (month view)
  const [detail, setDetail] = useState<Date | null>(null); // day whose items are expanded
  const [pickedContent, setPickedContent] = useState<{ c: ContentCalItem; date: Date } | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const switchView = (v: "week" | "month") => { setView(v); setOffset(0); setDetail(null); setPickedContent(null); };

  // Esc closes fullscreen; portal needs a mounted flag for SSR safety.
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  const openFull = () => { sfx.play("open"); setFullscreen(true); };
  const closeFull = () => { sfx.play("close"); setFullscreen(false); };
  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") closeFull(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullscreen]);

  // Everything scheduled on a specific calendar day, time-ordered.
  const itemsOn = (d: Date): DayItem[] => {
    const di = dayIdx(d);
    const out: DayItem[] = [];
    for (const e of entries) {
      if (!e.days.includes(di)) continue;
      const when = e.time ? fmtClock(e.time) : `${fmtClock(e.band!.start)}-${fmtClock(e.band!.end)} ${e.band!.every}`;
      out.push({ kind: "agent", e, when, sortMin: e.time ? hm(e.time) : hm(e.band!.start) });
    }
    for (const c of content) {
      if (!c.days.includes(di)) continue;
      out.push({ kind: "content", c, when: "content post", sortMin: 9 * 60 });
    }
    return out.sort((a, b) => a.sortMin - b.sortMin);
  };

  // True when this item's scheduled fire time on `date` is already in the past
  // (relative to now) — meaning the agent/content already ran. Uses sortMin,
  // which is the fire time in minutes-from-midnight (band entries use start).
  const hasRun = (it: DayItem, date: Date): boolean => {
    const ran = new Date(date);
    ran.setHours(0, it.sortMin, 0, 0);
    return ran.getTime() < now.getTime();
  };

  const openAgent = (e: CalEntry) => {
    sfx.play("blip");
    onSelect(e.key === "watchdog" ? { type: "watchdog" } : { type: "agent", key: e.key });
  };
  const labelFor = (it: DayItem) => it.kind === "agent" ? (byKey.get(it.e.key)?.name ?? it.e.label) : `${it.c.platform}`;
  const colorFor = (it: DayItem) => it.kind === "agent" ? it.e.color : it.c.color;

  const monday = addDays(startOfWeekMonday(now), offset * 7);
  const weekDays = Array.from({ length: 7 }, (_, i) => addDays(monday, i));
  const monthAnchor = new Date(now.getFullYear(), now.getMonth() + offset, 1);

  const navBtn = (dir: -1 | 1, label: string) => (
    <button className="mo-click" onClick={() => { sfx.play("nav"); setOffset(o => o + dir); setDetail(null); setPickedContent(null); }}
      aria-label={label}
      style={{
        background: "var(--bg-card, rgba(255,255,255,0.02))", border: "1px solid var(--border, var(--border))", color: "var(--text-secondary, #9ca3af)",
        borderRadius: 8, padding: "3px 11px", cursor: "pointer", fontSize: 14, fontFamily: "'JetBrains Mono', monospace", lineHeight: 1.3,
      }}>{dir < 0 ? "‹" : "›"}</button>
  );

  const rangeLabel = view === "week"
    ? `${MONTHS[monday.getMonth()]} ${monday.getDate()} – ${MONTHS[weekDays[6].getMonth()]} ${weekDays[6].getDate()}`
    : `${MONTHS[monthAnchor.getMonth()]} ${monthAnchor.getFullYear()}`;

  // Clickable pill/band for one scheduled item (week view + fullscreen month).
  const ItemChip = ({ it, date, big = false }: { it: DayItem; date: Date; big?: boolean }) => {
    const name = labelFor(it);
    const timeTxt = it.kind === "agent" ? (it.e.time ? fmtClock(it.e.time) : it.e.band!.every) : "post";
    const ran = hasRun(it, date);
    // Dot carries the meaning: type color for upcoming, green once it has run.
    const dotColor = ran ? CAL_RAN_GREEN : colorFor(it);
    const onClick = it.kind === "agent"
      ? () => openAgent(it.e)
      : () => { sfx.play("blip-artifact"); setPickedContent({ c: it.c, date }); };
    return (
      <div className="mo-click mo-cal-chip" onClick={onClick} title={`${name} — ${it.when}${ran ? " (ran)" : ""}`}
        style={{
          display: "flex", alignItems: "center", gap: 7, fontSize: big ? 11.5 : 10.5, marginBottom: 4,
          padding: big ? "3px 8px" : "3px 7px", borderRadius: 6, minWidth: 0,
          background: "var(--bg-card, rgba(255,255,255,0.03))",
          border: "1px solid var(--border, var(--border))",
          borderLeft: ran ? `2px solid ${CAL_RAN_GREEN}` : "1px solid var(--border, rgba(255,255,255,0.08))",
        }}>
        <span style={{ width: 6, height: 6, borderRadius: it.kind === "agent" ? "50%" : 2, background: dotColor, flexShrink: 0 }} />
        <span style={{ color: "var(--text-secondary)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 }}>{name}</span>
        <span style={{ marginLeft: "auto", color: ran ? CAL_RAN_GREEN : "var(--text-muted)", fontFamily: "'JetBrains Mono', monospace", fontSize: big ? 9.5 : 8.5, flexShrink: 0, whiteSpace: "nowrap" }}>{ran ? `✓ ${timeTxt}` : timeTxt}</span>
      </div>
    );
  };

  // The whole calendar body; `big` scales it up for the fullscreen overlay.
  const body = (big: boolean) => (
    <div className="mo-cal">
      {/* nav header: prev/next + range + week/month toggle + expand */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: big ? 16 : 10, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {navBtn(-1, "previous")}
          <span style={{ fontSize: big ? 15 : 12, fontWeight: 600, minWidth: big ? 190 : 130, textAlign: "center", fontFamily: "'JetBrains Mono', monospace", letterSpacing: "0.02em" }}>{rangeLabel}</span>
          {navBtn(1, "next")}
        </div>
        {offset !== 0 && (
          <button className="mo-click" onClick={() => { sfx.play("nav"); setOffset(0); setDetail(null); }}
            style={{ background: "none", border: "1px solid var(--border, var(--border))", color: "var(--text-muted)", borderRadius: 8, padding: "3px 9px", cursor: "pointer", fontSize: 10, fontFamily: "'JetBrains Mono', monospace" }}>today</button>
        )}
        <div style={{ marginLeft: "auto", display: "inline-flex", gap: 8, alignItems: "center" }}>
          <div style={{ display: "inline-flex", border: "1px solid var(--border, var(--border))", borderRadius: 8, overflow: "hidden" }}>
            {(["week", "month"] as const).map(v => (
              <button key={v} className="mo-click" onClick={() => switchView(v)}
                style={{ background: view === v ? "var(--accent, #22d3ee)22" : "none", border: "none", color: view === v ? "var(--accent, #22d3ee)" : "var(--text-muted)", padding: big ? "5px 14px" : "4px 11px", cursor: "pointer", fontSize: 10.5, fontFamily: "'JetBrains Mono', monospace", textTransform: "uppercase", letterSpacing: "0.06em" }}>{v}</button>
            ))}
          </div>
          <button className="mo-click" onClick={big ? closeFull : openFull} aria-label={big ? "exit full screen" : "full screen"}
            title={big ? "Exit full screen (Esc)" : "Full screen"}
            style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: big ? 34 : 28, height: big ? 34 : 28, background: "var(--bg-card, rgba(255,255,255,0.02))", border: "1px solid var(--border, var(--border))", color: "var(--text-secondary, #9ca3af)", borderRadius: 8, cursor: "pointer" }}>
            {big ? (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M8 3v4a1 1 0 0 1-1 1H3M21 8h-4a1 1 0 0 1-1-1V3M16 21v-4a1 1 0 0 1 1-1h4M3 16h4a1 1 0 0 1 1 1v4" /></svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" /></svg>
            )}
          </button>
        </div>
      </div>

      {view === "week" ? (
        <div className="mo-cal-grid" style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: big ? 6 : 4 }}>
          {weekDays.map((d, di) => {
            const isToday = sameDay(d, now);
            const items = itemsOn(d);
            return (
              <div key={di}>
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 3, marginBottom: 6 }}>
                  <span style={{ fontSize: big ? 9.5 : 8.5, letterSpacing: "0.1em", fontFamily: "'JetBrains Mono', monospace", color: "var(--text-muted)" }}>
                    {DAY_LABELS[di].toUpperCase()}
                  </span>
                  <span style={{
                    display: "inline-flex", alignItems: "center", justifyContent: "center",
                    width: big ? 26 : 22, height: big ? 26 : 22, borderRadius: "50%",
                    background: isToday ? "var(--accent, #22d3ee)" : "transparent",
                    color: isToday ? "#04121a" : "var(--text-secondary)",
                    fontWeight: isToday ? 700 : 500, fontSize: big ? 13 : 11, fontFamily: "'JetBrains Mono', monospace",
                  }}>{d.getDate()}</span>
                </div>
                <div style={{
                  minHeight: big ? 260 : 124, borderRadius: 8, padding: 5,
                  background: "var(--bg-card, rgba(255,255,255,0.02))",
                  border: "1px solid var(--border, var(--border))",
                }}>
                  {items.length === 0 && <div style={{ fontSize: 10, color: "var(--text-muted)", textAlign: "center", marginTop: 10, opacity: 0.5 }}>·</div>}
                  {items.map((it, i) => <ItemChip key={i} it={it} date={d} big={big} />)}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <MonthGrid anchor={monthAnchor} now={now} itemsOn={itemsOn} labelFor={labelFor} colorFor={colorFor} hasRun={hasRun} big={big}
          onPick={(d) => { sfx.play("blip"); setDetail(dt => dt && sameDay(dt, d) ? null : d); setPickedContent(null); }}
          onOpen={(it, d) => { if (it.kind === "agent") openAgent(it.e); else { sfx.play("blip-artifact"); setPickedContent({ c: it.c, date: d }); } }}
          detail={detail} />
      )}

      {/* selected-day detail (month view) */}
      {view === "month" && detail && (
        <div style={{ marginTop: 14, borderTop: "1px solid var(--border, var(--border))", paddingTop: 12 }}>
          <div style={{ fontSize: 10, letterSpacing: "0.14em", color: "var(--text-muted)", textTransform: "uppercase", marginBottom: 8 }}>
            {DAY_LABELS[dayIdx(detail)]}, {MONTHS[detail.getMonth()]} {detail.getDate()}
          </div>
          {itemsOn(detail).length === 0 && <div style={{ fontSize: 12, color: "var(--text-muted)" }}>Nothing scheduled.</div>}
          {itemsOn(detail).map((it, i) => {
            const ran = hasRun(it, detail);
            const dotColor = ran ? CAL_RAN_GREEN : colorFor(it);
            return it.kind === "agent" ? (
              <div key={i} className="mo-click" onClick={() => openAgent(it.e)} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, marginBottom: 7 }}>
                <span style={{ width: 9, height: 9, borderRadius: "50%", background: dotColor, flexShrink: 0 }} />
                <span style={{ fontWeight: 600 }}>{byKey.get(it.e.key)?.name ?? it.e.label}</span>
                <span style={{ marginLeft: "auto", color: ran ? CAL_RAN_GREEN : "var(--text-muted)", fontFamily: "'JetBrains Mono', monospace", fontSize: 10.5 }}>{ran ? `✓ ${it.when}` : it.when}</span>
              </div>
            ) : (
              <div key={i} className="mo-click" onClick={() => setPickedContent({ c: it.c, date: detail })} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, marginBottom: 7 }}>
                <span style={{ width: 9, height: 9, borderRadius: 2, background: dotColor, flexShrink: 0 }} />
                <span style={{ fontWeight: 600 }}>{it.c.platform} post</span>
                <span style={{ marginLeft: "auto", color: "var(--text-muted)", fontSize: 10.5 }}>{it.c.client}</span>
              </div>
            );
          })}
        </div>
      )}

      {/* content-post detail popover */}
      {pickedContent && (
        <div style={{ marginTop: 12, border: "1px solid var(--border, var(--border))", borderRadius: 8, padding: "10px 12px", background: "var(--bg-card, var(--border))" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
            <span style={{ width: 9, height: 9, borderRadius: 2, background: pickedContent.c.color }} />
            <span style={{ fontWeight: 700, fontSize: 13 }}>{pickedContent.c.platform} post</span>
            <button className="mo-click" onClick={() => setPickedContent(null)} style={{ marginLeft: "auto", background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 14 }} aria-label="close">×</button>
          </div>
          <div style={{ fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.5 }}>
            {pickedContent.c.client} · {DAY_LABELS[dayIdx(pickedContent.date)]} {MONTHS[pickedContent.date.getMonth()]} {pickedContent.date.getDate()}
          </div>
          <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 6, lineHeight: 1.5 }}>{pickedContent.c.note}</div>
        </div>
      )}

      {/* legend */}
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 14, paddingTop: 10, borderTop: "1px solid var(--border, var(--border))" }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 10, color: "var(--text-secondary)", fontFamily: "'JetBrains Mono', monospace" }}>
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: CAL_RAN_GREEN, flexShrink: 0 }} />
          ran
        </span>
        {entries.map(e => (
          <span key={e.key} className="mo-click" onClick={() => openAgent(e)}
            style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 10, color: "var(--text-secondary)", fontFamily: "'JetBrains Mono', monospace" }}>
            <span style={{ width: 8, height: 8, borderRadius: "50%", background: e.color, flexShrink: 0 }} />
            {e.label}
          </span>
        ))}
        {content.map((c, i) => (
          <span key={`c-${i}`} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 10, color: "var(--text-secondary)", fontFamily: "'JetBrains Mono', monospace" }}>
            <span style={{ width: 8, height: 8, borderRadius: 2, background: c.color, flexShrink: 0 }} />
            {c.platform}
          </span>
        ))}
      </div>
    </div>
  );

  const overlay = (
    <div style={{ position: "fixed", inset: 0, zIndex: 240 }}>
      <div onClick={closeFull} style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.72)", backdropFilter: "blur(3px)" }} />
      <div style={{
        position: "absolute", inset: 0, display: "flex", flexDirection: "column",
        padding: "max(env(safe-area-inset-top), 14px) max(env(safe-area-inset-right), 14px) max(env(safe-area-inset-bottom), 14px) max(env(safe-area-inset-left), 14px)",
      }}>
        <div style={{
          margin: "auto", width: "100%", maxWidth: 1100, maxHeight: "100%",
          background: "var(--bg-secondary, #0a0d14)", border: "1px solid var(--border, var(--border))",
          borderRadius: 14, boxShadow: "0 24px 80px rgba(0,0,0,0.6)",
          display: "flex", flexDirection: "column", overflow: "hidden",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "13px 18px", borderBottom: "1px solid var(--border, var(--border))" }}>
            <span style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--accent, #22d3ee)", flexShrink: 0 }} />
            <span style={{ fontSize: 13, fontWeight: 700, letterSpacing: "0.1em", fontFamily: "'JetBrains Mono', monospace" }}>SCHEDULER</span>
            <button className="mo-click" onClick={closeFull} aria-label="close" style={{ marginLeft: "auto", background: "none", border: "1px solid var(--border, var(--border))", color: "var(--text-secondary, #9ca3af)", borderRadius: 8, padding: "7px 14px", cursor: "pointer", fontSize: 12 }}>Close</button>
          </div>
          <div style={{ overflow: "auto", WebkitOverflowScrolling: "touch", padding: "18px 20px", flex: 1 }}>
            {body(true)}
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <>
      {body(false)}
      {fullscreen && mounted && createPortal(overlay, document.body)}
    </>
  );
}

// Month grid for the scheduler: 6 rows x 7 days. Compact mode shows colored
// dots + a "+N" overflow count; fullscreen (`big`) shows titled entry pills.
function MonthGrid({ anchor, now, itemsOn, labelFor, colorFor, hasRun, onPick, onOpen, detail, big }: {
  anchor: Date; now: Date;
  itemsOn: (d: Date) => DayItem[];
  labelFor: (it: DayItem) => string;
  colorFor: (it: DayItem) => string;
  hasRun: (it: DayItem, d: Date) => boolean;
  onPick: (d: Date) => void;
  onOpen: (it: DayItem, d: Date) => void;
  detail: Date | null; big: boolean;
}) {
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const gridStart = addDays(first, -dayIdx(first));
  const cells = Array.from({ length: 42 }, (_, i) => addDays(gridStart, i));
  const maxPills = big ? 4 : 0; // compact mode uses dots, not pills
  const maxDots = 5;
  return (
    <div style={{ overflowX: "auto", WebkitOverflowScrolling: "touch" }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: big ? 5 : 3, minWidth: big ? 0 : 300 }}>
        {DAY_LABELS.map(dl => (
          <div key={dl} style={{ fontSize: big ? 10 : 8.5, letterSpacing: "0.08em", textAlign: "center", color: "var(--text-muted)", fontFamily: "'JetBrains Mono', monospace", marginBottom: 4, paddingBottom: 4, borderBottom: "1px solid var(--border, var(--border))" }}>{dl.toUpperCase()}</div>
        ))}
        {cells.map((d, i) => {
          const inMonth = d.getMonth() === anchor.getMonth();
          const isToday = sameDay(d, now);
          const isSel = detail && sameDay(detail, d);
          const items = itemsOn(d);
          // Dot color per item: green once it has run, otherwise its type color.
          const dots = [...new Set(items.map(it => hasRun(it, d) ? CAL_RAN_GREEN : colorFor(it)))].slice(0, maxDots);
          return (
            <div key={i} className="mo-click" onClick={() => onPick(d)}
              style={{
                minHeight: big ? 118 : 52, borderRadius: 7, padding: big ? "5px 6px" : "3px 4px",
                display: "flex", flexDirection: "column",
                opacity: inMonth ? 1 : 0.32,
                background: isSel ? "rgba(34,211,238,0.10)" : "var(--bg-card, rgba(255,255,255,0.02))",
                border: `1px solid ${isSel ? "rgba(34,211,238,0.5)" : "var(--border, rgba(255,255,255,0.06))"}`,
              }}>
              <div style={{
                fontSize: big ? 12 : 10, lineHeight: 1.1,
                fontFamily: "'JetBrains Mono', monospace",
                display: "flex", justifyContent: big ? "flex-start" : "flex-end", alignItems: "center", gap: 5,
              }}>
                <span style={{
                  display: "inline-flex", alignItems: "center", justifyContent: "center",
                  minWidth: big ? 20 : 17, height: big ? 20 : 17, borderRadius: "50%",
                  background: isToday ? "var(--accent, #22d3ee)" : "transparent",
                  color: isToday ? "#04121a" : inMonth ? "var(--text-secondary)" : "var(--text-muted)",
                  fontWeight: isToday ? 700 : 500,
                }}>{d.getDate()}</span>
              </div>

              {big ? (
                <div style={{ marginTop: 5, display: "flex", flexDirection: "column", gap: 3, minWidth: 0 }}>
                  {items.slice(0, maxPills).map((it, k) => {
                    const ran = hasRun(it, d);
                    const dotColor = ran ? CAL_RAN_GREEN : colorFor(it);
                    return (
                      <div key={k} className="mo-click mo-cal-chip" onClick={(ev) => { ev.stopPropagation(); onOpen(it, d); }} title={labelFor(it) + (ran ? " (ran)" : "")}
                        style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 10, padding: "2px 6px", borderRadius: 5, minWidth: 0, background: "var(--bg-card, rgba(255,255,255,0.03))", border: "1px solid var(--border, var(--border))", borderLeft: ran ? `2px solid ${CAL_RAN_GREEN}` : "1px solid var(--border, rgba(255,255,255,0.08))" }}>
                        <span style={{ width: 5, height: 5, borderRadius: it.kind === "agent" ? "50%" : 2, background: dotColor, flexShrink: 0 }} />
                        <span style={{ color: "var(--text-secondary)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 }}>{labelFor(it)}</span>
                      </div>
                    );
                  })}
                  {items.length > maxPills && (
                    <div style={{ fontSize: 9.5, color: "var(--text-muted)", fontFamily: "'JetBrains Mono', monospace", paddingLeft: 2 }}>+{items.length - maxPills} more</div>
                  )}
                </div>
              ) : (
                <div style={{ display: "flex", gap: 3, flexWrap: "wrap", marginTop: "auto", alignItems: "center" }}>
                  {dots.map((c, di) => <span key={di} style={{ width: 5, height: 5, borderRadius: "50%", background: c }} />)}
                  {items.length > dots.length && <span style={{ fontSize: 8, color: "var(--text-muted)", fontFamily: "'JetBrains Mono', monospace" }}>+{items.length - dots.length}</span>}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── System panel (computed client-side from the main payload) ──────────────
function SystemPanel({ systemId, data, onSelect, onClose }: {
  systemId: string; data: MissionData; onSelect: (s: Selection) => void; onClose: () => void;
}) {
  const sys = SYSTEMS.find(s => s.id === systemId);
  if (!sys) return null;
  const touching = data.agents.filter(a => (AGENT_WIRES[a.key] ?? []).includes(systemId));
  const artifacts = ARTIFACTS.filter(a => a.system === systemId);
  const matchers = touching.map(a => AGENT_MATCH[a.key]).filter(Boolean);
  const related = data.feed.filter(e =>
    matchers.some(m => m.test(e.title) || m.test(e.type) || e.lines.some(l => m.test(l)))
  ).slice(0, 25);
  const activeCount = touching.filter(isRecentlyActive).length;
  const isWebsite = systemId === "website";
  const publishItems = data.publishes?.items ?? [];
  const windowDays = data.publishes?.windowDays ?? 14;

  // Web/SEO panel is PUBLISH-ONLY: it shows nothing but published blog posts and
  // service pages (each a clickable link to the live URL). No Sentinel/Watchdog/
  // health/agent-activity noise — those live on their own nodes.
  if (isWebsite) {
    const withLinks = publishItems.filter((p) => p.url).length;
    return (
      <SlideOver title={sys.label} accent={sys.color} onClose={onClose}>
        <SummaryBlock accent={sys.color} lines={[
          "Published blog posts and service pages, each linking to the live URL.",
          publishItems.length
            ? `${publishItems.length} publish${publishItems.length === 1 ? "" : "es"} in the last ${windowDays} days${withLinks ? `, ${withLinks} with a live link` : ""}.`
            : `Nothing published in the last ${windowDays} days.`,
        ]} />
        <Section title={`Published (last ${windowDays} days)`} defaultOpen>
          {publishItems.map((p, i) => (
            <div key={i} style={{ fontSize: 12.5, marginBottom: 11, lineHeight: 1.5, display: "flex", gap: 8 }}>
              <span style={{ color: "var(--text-muted)", fontFamily: "'JetBrains Mono', monospace", fontSize: 10, flexShrink: 0, marginTop: 2 }}>{shortDate(p.date)}</span>
              <div style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 3 }}>
                {p.client && (
                  <span style={{
                    alignSelf: "flex-start", display: "inline-flex", alignItems: "center", gap: 5,
                    fontSize: 9.5, fontFamily: "'JetBrains Mono', monospace", letterSpacing: "0.04em",
                    color: sys.color, background: `${sys.color}18`, border: `1px solid ${sys.color}44`,
                    borderRadius: 5, padding: "1px 7px", textTransform: "uppercase", whiteSpace: "nowrap",
                  }}>
                    <span style={{ width: 5, height: 5, borderRadius: "50%", background: sys.color, flexShrink: 0 }} />
                    {p.client}
                  </span>
                )}
                {p.url ? (
                  <a href={p.url} target="_blank" rel="noreferrer" style={{ color: sys.color, textDecoration: "underline" }}>
                    {tightLine(p.title, 110)} &#8599;
                  </a>
                ) : (
                  <span style={{ color: "var(--text-secondary)" }}>
                    {tightLine(p.title, 110)} <span style={{ color: "var(--text-muted)", fontSize: 10 }}>({p.note ?? "no link logged"})</span>
                  </span>
                )}
              </div>
            </div>
          ))}
          {publishItems.length === 0 && (
            <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
              Nothing published in the last {windowDays} days.
              {data.publishes?.lastPriorPublish ? ` Most recent prior publish: ${shortDate(data.publishes.lastPriorPublish)}.` : ""}
            </div>
          )}
        </Section>
      </SlideOver>
    );
  }

  return (
    <SlideOver title={sys.label} accent={sys.color} onClose={onClose}>
      <SummaryBlock accent={sys.color} lines={[
        sys.blurb,
        `${touching.length} agent${touching.length === 1 ? "" : "s"} wired in, ${activeCount} recently active.`,
        related.length ? `Last activity ${shortDate(related[0].date)}: ${tightLine(related[0].title, 80)}` : "No recent log activity for this system.",
      ]} />

      {systemId === "vault" && data.vaultToday && (
        <Section title="Vault activity" defaultOpen>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
            <span style={{ fontSize: 28, fontFamily: "'JetBrains Mono', monospace", color: sys.color, fontWeight: 700 }}>
              {data.vaultToday.count}
            </span>
            <span style={{ fontSize: 13, color: "var(--text-secondary)" }}>
              file{data.vaultToday.count === 1 ? "" : "s"} updated today
            </span>
          </div>
          <div style={{ fontSize: 10.5, color: "var(--text-muted)", fontFamily: "'JetBrains Mono', monospace", marginTop: 4 }}>
            {data.vaultToday.source === "git" ? "counted from vault git commits dated today" : "counted from vault file timestamps (git unavailable)"}
          </div>
        </Section>
      )}

      {systemId === "scheduler" && (
        <Section title="Calendar" defaultOpen>
          <SchedulerCalendar agents={data.agents} content={data.scheduledContent ?? []} onSelect={onSelect} />
        </Section>
      )}

      <Section title={`Agents (${touching.length})`} defaultOpen>
        {touching.map(a => (
          <div key={a.key} className="mo-click" style={{
            display: "flex", alignItems: "center", gap: 8, fontSize: 12, marginBottom: 6,
            border: "1px solid var(--border, var(--border))", borderRadius: 8, padding: "6px 10px",
          }} onClick={() => onSelect({ type: "agent", key: a.key })}>
            <Dot color={isRecentlyActive(a) ? "var(--green)" : "#6b7280"} pulse={isRecentlyActive(a)} />
            <span style={{ fontWeight: 600 }}>{a.name}</span>
            <span style={{ color: "var(--text-muted)", marginLeft: "auto", fontFamily: "'JetBrains Mono', monospace", fontSize: 10 }}>
              {a.enabled ? a.schedule : "disabled"}
            </span>
          </div>
        ))}
      </Section>

      {artifacts.length > 0 && (
        <Section title={`Artifacts (${artifacts.length})`} defaultOpen>
          {artifacts.map(a => (
            <div key={a.id} className="mo-click" style={{
              display: "flex", alignItems: "center", gap: 8, fontSize: 12, marginBottom: 6,
              border: `1px dashed ${sys.color}55`, borderRadius: 8, padding: "6px 10px",
            }} onClick={() => onSelect({ type: "artifact", id: a.id })}>
              <span style={{ fontFamily: "'JetBrains Mono', monospace" }}>{a.label}</span>
              <span style={{ color: "var(--text-muted)", marginLeft: "auto", fontSize: 10 }}>open</span>
            </div>
          ))}
        </Section>
      )}

      <Section title={`Recent activity (${related.length})`}>
        {related.length === 0 && <div style={{ fontSize: 12, color: "var(--text-muted)" }}>Nothing recent in the log for this system.</div>}
        <FeedList feed={related.slice(0, 8)} />
      </Section>
    </SlideOver>
  );
}

// ── Client health panel ────────────────────────────────────────────────────
// Exported so the main app's Clients section reuses the exact same panel.
export function ClientPanel({ name, data, onClose }: { name: string; data: MissionData; onClose: () => void }) {
  const c = data.health?.clients.find(x => x.client === name);
  if (!c) return null;
  const accent = STATUS_COLOR[c.overall];
  const emojiStatus = (e: string) => e.includes("\u{1F534}") ? "red" : e.includes("\u{1F7E1}") ? "yellow" : "green";
  return (
    <SlideOver title={c.client.toUpperCase()} accent={accent} onClose={onClose}>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <Pill text={c.overall.toUpperCase()} color={accent} />
        <Pill text={c.phase.toUpperCase()} color="var(--text-muted, #6b7280)" />
        {data.health?.runDate && <Pill text={`BOARD RUN ${data.health.runDate}`} color="var(--text-muted, #6b7280)" />}
      </div>

      <SummaryBlock accent={accent} lines={[
        `${c.client} is ${c.overall.toUpperCase()} overall, in the ${c.phase} phase.`,
        c.redFlags.length ? `${c.redFlags.length} open flag${c.redFlags.length === 1 ? "" : "s"} on the board.` : "No open flags. All clear.",
      ]} />

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}>
        {c.site && (
          <a href={c.site} target="_blank" rel="noreferrer"
            style={{ fontSize: 12, color: accent, textDecoration: "none", border: `1px solid ${accent}55`, borderRadius: 8, padding: "6px 12px", display: "inline-block" }}>
            Open live site ({c.site.replace(/^https?:\/\//, "")}) &#8599;
          </a>
        )}
        <a href="/?section=clients"
          style={{ fontSize: 12, color: accent, textDecoration: "none", border: `1px solid ${accent}55`, borderRadius: 8, padding: "6px 12px", display: "inline-block" }}
          onClick={(e) => {
            // In the main app, jump to the Clients section in place. On /mission
            // this lands on the Command Center (the main app has no ?section=
            // deep link yet).
            if (typeof window !== "undefined" && window.location.pathname === "/") {
              e.preventDefault();
              window.dispatchEvent(new CustomEvent("os:navigate", { detail: "clients" }));
              onClose();
            }
          }}>
          Open in Clients section &#8594;
        </a>
      </div>

      <Section title="Pillar breakdown" defaultOpen>
        {c.pillars.map((p, i) => {
          const st = emojiStatus(p);
          return (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13, marginBottom: 7 }}>
              <Dot color={STATUS_COLOR[st]} pulse={st !== "green"} />
              <span style={{ color: "var(--text-secondary)" }}>{PILLAR_NAMES[i] ?? `Pillar ${i + 1}`}</span>
              <span style={{ marginLeft: "auto", fontSize: 12 }}>{p}</span>
            </div>
          );
        })}
      </Section>

      <Section title={`Flags (${c.redFlags.length})`} defaultOpen={c.redFlags.length > 0}>
        {c.redFlags.length === 0 && <div style={{ fontSize: 12, color: "var(--green)" }}>No open flags. All clear.</div>}
        {c.redFlags.map((f, i) => (
          <div key={i} style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 10, lineHeight: 1.5 }}>
            <span style={{ color: "var(--red)" }}>&#9873; </span>
            {f.text}
            {f.link && (
              <>
                {" "}
                <a href={f.link} target="_blank" rel="noreferrer" style={{ color: "var(--accent)" }}>open &#8599;</a>
              </>
            )}
          </div>
        ))}
      </Section>
    </SlideOver>
  );
}

// ── Watchdog report panel (opened from the overseer node on the map) ───────
function WatchdogPanel({ watchdog, onClose, onRechecked }: { watchdog?: WatchdogData | null; onClose: () => void; onRechecked?: () => void }) {
  const hasProblems = !!watchdog && (watchdog.overall === "problems" || Math.max(watchdog.problemCount, watchdog.problems.length) > 0);
  const accent = hasProblems ? "var(--red)" : BOSS_CLEAR;
  const ageMin = watchdog ? watchdogAgeMin(watchdog.updated) : null;
  return (
    <SlideOver title="DA BOSS" accent={accent} onClose={onClose}>
      {/* One-tap full patrol at the top of the report; granular Recheck stays below */}
      <div style={{ marginBottom: 10 }}>
        <RunDaBossButton onRechecked={onRechecked} block />
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 4 }}>
        <RecheckButton onRechecked={onRechecked} />
      </div>
      {(!watchdog || !watchdog.available) && (
        <div style={{ fontSize: 12.5, color: "var(--text-secondary)" }}>Da Boss has not reported yet.</div>
      )}
      {watchdog?.available && (
        <>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <Pill text={hasProblems ? `${Math.max(watchdog.problemCount, watchdog.problems.length)} PROBLEMS` : "ALL CLEAR"} color={accent} />
            <Pill text={`REPORT ${relAge(ageMin).toUpperCase()}`} color="var(--text-muted, #6b7280)" />
            <span style={{ marginLeft: "auto" }}>
              <WatchdogCopyButton watchdog={watchdog} color={accent} />
            </span>
          </div>

          <SummaryBlock accent={accent} lines={[
            hasProblems
              ? `Da Boss is reporting ${Math.max(watchdog.problemCount, watchdog.problems.length)} open problem${Math.max(watchdog.problemCount, watchdog.problems.length) === 1 ? "" : "s"}.`
              : "Every agent is reporting on schedule. Nothing needs attention.",
            `Last report from Da Boss ${relAge(ageMin)}.`,
          ]} />

          <Section title={`Problems (${watchdog.problems.length})`} defaultOpen={hasProblems}>
            {watchdog.problems.length === 0 && <div style={{ fontSize: 12, color: "var(--green)" }}>No problems listed.</div>}
            {watchdog.problems.map((p, i) => (
              <div key={i} style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 8, lineHeight: 1.5, borderLeft: `2px solid ${accent}55`, paddingLeft: 8 }}>
                <ProblemLine p={p} color={accent} />
              </div>
            ))}
          </Section>

          {watchdog.resolved.length > 0 && (
            <Section title={`Resolved (${watchdog.resolved.length})`}>
              {watchdog.resolved.map((r, i) => (
                <div key={i} style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 6, lineHeight: 1.5 }}>{r}</div>
              ))}
            </Section>
          )}

          <Section title={`Agent states (${Object.keys(watchdog.agents ?? {}).length})`} defaultOpen>
            {Object.entries(watchdog.agents ?? {}).map(([k, v]) => (
              <div key={k} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, marginBottom: 6 }}>
                <Dot color={v === "SILENT" ? "var(--red)" : v === "LATE" ? "var(--orange)" : v === "DISABLED" ? "#6b7280" : "var(--green)"} />
                <span style={{ fontFamily: "'JetBrains Mono', monospace" }}>{k}</span>
                <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--text-muted)", fontFamily: "'JetBrains Mono', monospace" }}>{v}</span>
              </div>
            ))}
            {Object.keys(watchdog.agents ?? {}).length === 0 && (
              <div style={{ fontSize: 12, color: "var(--text-muted)" }}>No per-agent states in the report.</div>
            )}
          </Section>
        </>
      )}
    </SlideOver>
  );
}

// ── Standalone client health slide-over ────────────────────────────────────
// Fetches mission data on demand and opens the SAME ClientPanel used in
// Mission Control. Used by the main app's Clients section, where the mission
// payload is not already loaded. Matches the health-board client name against
// the given client name loosely (substring, either direction).
export function ClientHealthSlideOver({ clientName, onClose }: { clientName: string; onClose: () => void }) {
  const [data, setData] = useState<MissionData | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/mission", { cache: "no-store" })
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(j => { if (alive) setData(j); })
      .catch(e => { if (alive) setErr(e instanceof Error ? e.message : "fetch failed"); });
    return () => { alive = false; };
  }, []);

  const match = data?.health?.clients.find(c => {
    const a = c.client.toLowerCase().trim();
    const b = clientName.toLowerCase().trim();
    return a === b || a.includes(b) || b.includes(a);
  });

  if (data && match) return <ClientPanel name={match.client} data={data} onClose={onClose} />;

  return (
    <SlideOver title={clientName.toUpperCase()} accent="var(--accent)" onClose={onClose}>
      {!data && !err && (
        <div style={{ fontSize: 12, color: "var(--text-muted)", fontFamily: "'JetBrains Mono', monospace" }}>Loading client health...</div>
      )}
      {err && <div style={{ fontSize: 12, color: "var(--red)" }}>Could not load client health ({err})</div>}
      {data && !match && (
        <div style={{ fontSize: 12.5, color: "var(--text-secondary)", lineHeight: 1.6 }}>
          No health-board entry for this client yet. Sentinel adds one on its next run
          once the client is on the board.
        </div>
      )}
    </SlideOver>
  );
}

// ── Selection router: render whichever panel is open ───────────────────────
export function MissionPanels({ selection, data, onSelect, onRechecked }: {
  selection: Selection; data: MissionData | null; onSelect: (s: Selection) => void; onRechecked?: () => void;
}) {
  if (!selection) return null;
  const close = () => onSelect(null);
  if (selection.type === "agent") return <AgentPanel agentKey={selection.key} onClose={close} onSelect={onSelect} />;
  if (selection.type === "artifact") return <ArtifactPanel artifactId={selection.id} onClose={close} onSelect={onSelect} />;
  if (selection.type === "stat") return <StatPanel statKey={selection.key} onClose={close} onSelect={onSelect} />;
  if (!data) return null;
  if (selection.type === "system") return <SystemPanel systemId={selection.id} data={data} onSelect={onSelect} onClose={close} />;
  if (selection.type === "client") return <ClientPanel name={selection.name} data={data} onClose={close} />;
  if (selection.type === "watchdog") return <WatchdogPanel watchdog={data.watchdog} onClose={close} onRechecked={onRechecked} />;
  return null;
}
