"use client";

// MISSION CONTROL CORE — shared interactive pieces used by both the embedded
// MissionOps view (main app Agents section) and the standalone /mission page.
// Design principle: the MAIN VIEW stays calm (name + status + one line), and
// ALL detail lives in the click-through panels (progressive disclosure).
// Everything here is read-only.

import { useEffect, useState } from "react";
import { sfx } from "../lib/sounds";

// ── types (mirror of /api/mission payload) ─────────────────────────────────
export interface AgentCard {
  kind: "scheduled" | "crew";
  key: string;
  name: string;
  role: string;
  schedule: string;
  enabled: boolean;
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
export interface PublishItem { date: string; title: string; url: string | null; note: string | null }
export interface Publishes { windowDays: number; items: PublishItem[]; lastPriorPublish: string | null }
export interface RealLink { label: string; url: string }
export interface StatTile { key: string; label: string; value: string; sub: string | null; updated: string | null }
export interface StatDetail {
  id: string;
  title: string;
  updated: string | null;
  available: boolean;
  summary: string[];
  items: { label: string; value: string; note: string | null }[];
  note: string | null;
  links?: RealLink[];
}
export interface VolumeBadge { value: string; sub: string | null }
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
  { id: "vault", label: "VAULT", color: "#a78bfa", blurb: "The Obsidian brain: log.md, hot.md, state snapshots, client pages. Most agents write their results here." },
  { id: "ghl-clients", label: "GHL", color: "#fbbf24", blurb: "Client subaccounts in GoHighLevel (Jackson Roofing today, more as clients sign): contacts, pipelines, conversations, calendars." },
  { id: "ghl-wing", label: "GHL WING", color: "#fb923c", blurb: "Wing Digital's own GoHighLevel account: the outreach CRM, reply inbox, and prospect pipeline." },
  { id: "email", label: "EMAIL", color: "#22d3ee", blurb: "The cold-email path: the autonomous outreach sender and the inbox it feeds." },
  { id: "clients", label: "CLIENTS", color: "#34d399", blurb: "Live client deliverables: Jackson Roofing, Renewal Health, and the health board that watches them." },
  { id: "scheduler", label: "SCHEDULER", color: "#60a5fa", blurb: "The scheduled-tasks runner on Jack's PC that fires the daily and weekly agents." },
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
  ingest: "#22d3ee",
  query: "#a78bfa",
  build: "#34d399",
  security: "#f87171",
  lint: "#fb923c",
};

export const STATUS_COLOR: Record<string, string> = {
  green: "#34d399",
  yellow: "#fb923c",
  red: "#f87171",
};

// ── selection model ────────────────────────────────────────────────────────
export type Selection =
  | { type: "agent"; key: string }
  | { type: "system"; id: string }
  | { type: "artifact"; id: string }
  | { type: "client"; name: string }
  | { type: "stat"; key: string }
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
  | null;

// Tiny volume pill rendered inside the SVG map (numbers only, no clutter).
function VolPill({ x, y, text, color }: { x: number; y: number; text: string; color: string }) {
  const w = text.length * 5.6 + 14;
  return (
    <g style={{ pointerEvents: "none" }}>
      <rect x={x - w / 2} y={y - 9} width={w} height={18} rx={9}
        fill="rgba(13,17,23,0.92)" stroke={color} strokeOpacity={0.7} strokeWidth={1} />
      <text x={x} y={y + 3} textAnchor="middle" fill={color} fontSize="9"
        fontFamily="'JetBrains Mono', monospace">{text}</text>
    </g>
  );
}

export function OpsMap({ agents, volumes, onSelect }: { agents: AgentCard[]; volumes?: Volumes; onSelect: (s: Selection) => void }) {
  const [hover, setHover] = useState<Hover>(null);
  const W = 960, H = 500;
  const shown = agents.filter(a => a.enabled);
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
    return { art, x: sp.x + off, y: 430, color: sp.s.color };
  }).filter(Boolean) as { art: typeof ARTIFACTS[number]; x: number; y: number; color: string }[];

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
  const hovering = hover !== null;

  return (
    <div style={{
      background: "linear-gradient(180deg, var(--bg-card, #0d1117), rgba(10,12,20,0.9))",
      border: "1px solid var(--border, rgba(255,255,255,0.08))",
      borderRadius: 14, padding: 8, overflowX: "auto",
    }}>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", minWidth: 680, display: "block" }}>
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

        {/* agent nodes */}
        {agentPos.map(({ a, x, y }) => {
          const active = isRecentlyActive(a);
          const highlighted = hovering && hoverAgents.has(a.key);
          const dimmed = hovering && !highlighted;
          const color = highlighted || active ? "#22d3ee" : "#4b5563";
          return (
            <g key={a.key} className="mo-click" opacity={dimmed ? 0.3 : 1}
              onMouseEnter={() => { sfx.play("hover"); setHover({ kind: "agent", key: a.key }); }}
              onMouseLeave={() => setHover(h => (h?.kind === "agent" && h.key === a.key ? null : h))}
              onClick={() => { sfx.play("blip"); onSelect({ type: "agent", key: a.key }); }}>
              {(active || highlighted) && <circle cx={x} cy={y} r={32} fill="url(#mo-glow)" />}
              <circle cx={x} cy={y} r={21} fill="rgba(13,17,23,0.95)" stroke={color}
                strokeWidth={highlighted ? 2.2 : 1.5}
                className={active ? "mo-node-pulse" : undefined} />
              <circle cx={x} cy={y - 28} r={3.5}
                fill={a.watchdogState === "SILENT" ? "#f87171" : a.watchdogState === "LATE" ? "#fb923c" : active ? "#34d399" : "#4b5563"}
                className={active || (a.watchdogState && a.watchdogState !== "OK") ? "mo-pulse" : undefined} />
              <text x={x} y={y + 4} textAnchor="middle" fill={active || highlighted ? "#e5e7eb" : "#9ca3af"}
                fontSize="9.5" fontFamily="'JetBrains Mono', monospace" style={{ pointerEvents: "none" }}>
                {a.name.split(" ")[0].slice(0, 9).toUpperCase()}
              </text>
              <text x={x} y={y + 40} textAnchor="middle" fill="#6b7280" fontSize="8.5"
                fontFamily="'JetBrains Mono', monospace" style={{ pointerEvents: "none" }}>
                {a.nextRunAt ? fmtCountdown(a.nextRunAt) : a.lastLogDate ?? ""}
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
                fill="rgba(13,17,23,0.95)" stroke={s.color}
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
                fill="rgba(13,17,23,0.95)" stroke={color}
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
              <VolPill x={x} y={y - 32} text={v.sub ? `${v.value} ${v.sub}` : v.value} color={s.color} />
            </g>
          );
        })}
        {volumes && artPos.map(({ art, x, y, color }) => {
          const v = volumes.artifacts[art.id];
          const sp = sysMap.get(art.system);
          if (!v || !sp) return null;
          const dimmed = hovering && !hoverArtifacts.has(art.id);
          return (
            <g key={`vola-${art.id}`} opacity={dimmed ? 0.2 : 1}>
              <VolPill x={(sp.x + x) / 2} y={(sp.y + 22 + y - 14) / 2}
                text={v.sub ? `${v.value} ${v.sub}` : v.value} color={color} />
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

export function WatchdogBanner({ watchdog }: { watchdog?: WatchdogData | null }) {
  const [expanded, setExpanded] = useState<boolean | null>(null);
  const mono = "'JetBrains Mono', monospace";

  const base: React.CSSProperties = {
    borderRadius: 12, padding: "9px 16px", fontFamily: mono,
    display: "flex", flexDirection: "column", gap: 6,
  };

  // Not reported yet (file missing): quiet neutral, never an error.
  if (!watchdog || !watchdog.available) {
    return (
      <div style={{ ...base, border: "1px solid var(--border, rgba(255,255,255,0.08))", background: "var(--bg-card, #0d1117)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Dot color="#6b7280" />
          <span style={{ fontSize: 11, letterSpacing: "0.1em", color: "var(--text-muted, #6b7280)" }}>
            WATCHDOG - watchdog has not reported yet
          </span>
        </div>
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
      <div style={{ ...base, border: "1px solid rgba(52,211,153,0.35)", background: "rgba(52,211,153,0.06)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Dot color="#34d399" />
          <span style={{ fontSize: 11, letterSpacing: "0.1em", color: "#34d399" }}>
            ALL SYSTEMS REPORTING - watchdog checked {relAge(ageMin)}
          </span>
        </div>
      </div>
    );
  }

  // Problems (red) and/or the watchdog itself late (amber).
  const color = hasProblems ? "#f87171" : "#fb923c";
  const isOpen = expanded ?? (hasProblems ? count <= 2 : false);
  const toggle = () => {
    sfx.play(isOpen ? "toggle-off" : "toggle-on");
    setExpanded(!isOpen);
  };
  const headline = hasProblems
    ? `WATCHDOG: ${count} PROBLEM${count === 1 ? "" : "S"} REPORTED`
    : `WATCHDOG ITSELF IS LATE (last report ${relAge(ageMin)})`;

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
          <span style={{ fontSize: 10, color: "#fb923c", border: "1px solid #fb923c55", borderRadius: 99, padding: "1px 8px" }}>
            report is also late ({relAge(ageMin)})
          </span>
        )}
        <span style={{ marginLeft: "auto", fontSize: 10, color: "var(--text-muted, #6b7280)" }}>
          {isOpen ? "collapse" : "expand"}
        </span>
      </div>

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
            <div style={{ fontSize: 10.5, color: "#fb923c" }}>
              The watchdog report itself is older than 3 hours - the watcher being silent is also a problem.
            </div>
          )}
          <div style={{ fontSize: 10, color: "var(--text-muted, #6b7280)" }}>
            last watchdog report {relAge(ageMin)}
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
  if (!a.enabled) { line = "disabled"; }
  else if (a.watchdogState === "SILENT") { color = "#f87171"; pulse = true; line = "SILENT (watchdog)"; }
  else if (a.watchdogState === "LATE") { color = "#fb923c"; pulse = true; line = "LATE (watchdog)"; }
  else if (a.pcNeeded && a.kind === "scheduled") { color = "#fb923c"; line = "PC needed"; }
  else if (a.nextRunAt) { color = "#22d3ee"; pulse = true; line = `next ${fmtCountdown(a.nextRunAt)}`; }
  else if (a.lastLogDate) { color = "#34d399"; pulse = true; line = `last seen ${a.lastLogDate}`; }
  else if (a.kind === "crew") { line = "on demand"; }

  return (
    <div
      onClick={() => { sfx.play("blip"); onSelect({ type: "agent", key: a.key }); }}
      className="mo-click"
      style={{
        background: "var(--bg-card, #0d1117)",
        border: "1px solid var(--border, rgba(255,255,255,0.06))",
        borderRadius: 12, padding: "12px 16px",
        display: "flex", alignItems: "center", gap: 10,
        opacity: a.enabled ? 1 : 0.5,
      }}
    >
      <Dot color={color} pulse={pulse} />
      <span style={{ fontWeight: 600, fontSize: 14, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{a.name}</span>
      <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--text-muted)", fontFamily: "'JetBrains Mono', monospace", whiteSpace: "nowrap" }}>
        {line}
      </span>
    </div>
  );
}

// ── Stat tiles (clickable: each opens its breakdown panel) ─────────────────
export function StatTiles({ tiles, onSelect }: { tiles: StatTile[]; onSelect: (s: Selection) => void }) {
  if (!tiles.length) return null;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12 }}>
      {tiles.map((t) => {
        const age = fmtAge(t.updated);
        return (
          <div key={t.label} className="mo-click" onClick={() => { sfx.play("ping"); onSelect({ type: "stat", key: t.key }); }}
            title="Click for the breakdown"
            style={{ background: "var(--bg-card, #0d1117)", border: "1px solid var(--border, rgba(255,255,255,0.08))", borderRadius: 12, padding: "14px 16px", position: "relative" }}>
            <div style={{ fontSize: 26, fontWeight: 700, color: "var(--text-primary)", fontFamily: "'Space Grotesk', sans-serif" }}>{t.value}</div>
            <div style={{ fontSize: 10, letterSpacing: "0.12em", color: "var(--text-muted)", textTransform: "uppercase" }}>
              {t.label}{t.sub ? <span style={{ textTransform: "none", letterSpacing: 0 }}> · {t.sub}</span> : null}
            </div>
            {age && (
              <span style={{ position: "absolute", top: 8, right: 10, fontSize: 9, color: "var(--text-muted)", fontFamily: "'JetBrains Mono', monospace" }}>{age}</span>
            )}
          </div>
        );
      })}
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
    <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", background: "var(--bg-card, #0d1117)", border: "1px solid var(--border, rgba(255,255,255,0.08))", borderRadius: 12, padding: "8px 14px" }}>
      <span style={{ fontSize: 10, letterSpacing: "0.12em", color: "var(--text-muted)" }}>NEXT 24H</span>
      {upcoming.map((a) => (
        <span key={a.key} className="mo-click" onClick={() => { sfx.play("blip"); onSelect({ type: "agent", key: a.key }); }}
          style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11, fontFamily: "'JetBrains Mono', monospace", color: "var(--text-secondary)", border: "1px solid var(--border, rgba(255,255,255,0.1))", borderRadius: 99, padding: "3px 10px" }}>
          <Dot color="#22d3ee" />
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

// ── Client health strip (clickable dots) ───────────────────────────────────
export function ClientHealthStrip({
  health, sourcesOk, onSelect,
}: {
  health: { runDate: string | null; clients: ClientHealth[] };
  sourcesOk: boolean;
  onSelect: (s: Selection) => void;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 14, background: "var(--bg-card, #0d1117)", border: "1px solid var(--border, rgba(255,255,255,0.08))", borderRadius: 12, padding: "10px 16px", flexWrap: "wrap" }}>
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
  const close = () => { sfx.play("close"); onClose(); };
  return (
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
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "14px 18px", borderBottom: "1px solid var(--border, rgba(255,255,255,0.08))" }}>
          <Dot color={accent} pulse />
          <span style={{ fontSize: 13, fontWeight: 700, letterSpacing: "0.1em", fontFamily: "'JetBrains Mono', monospace" }}>{title}</span>
          <button onClick={close} style={{
            marginLeft: "auto", background: "none", border: "1px solid var(--border, rgba(255,255,255,0.15))",
            color: "var(--text-secondary, #9ca3af)", borderRadius: 8, padding: "4px 10px", cursor: "pointer", fontSize: 12,
          }}>Close</button>
        </div>
        <div style={{ overflowY: "auto", padding: "16px 18px", flex: 1 }}>{children}</div>
      </div>
    </div>
  );
}

// Collapsible section used inside panels: keeps detail tucked away by default.
function Section({ title, defaultOpen, children }: {
  title: string; defaultOpen?: boolean; children: React.ReactNode;
}) {
  const [open, setOpen] = useState(!!defaultOpen);
  return (
    <div style={{ borderTop: "1px solid var(--border, rgba(255,255,255,0.06))", marginTop: 12, paddingTop: 8 }}>
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
          background: "var(--bg-card, #0d1117)", border: "1px solid var(--border, rgba(255,255,255,0.08))",
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
        style={{ background: "none", border: "1px solid var(--border, rgba(255,255,255,0.15))", color: copied ? "#34d399" : "var(--text-secondary, #9ca3af)", borderRadius: 6, padding: "2px 8px", cursor: "pointer", fontSize: 10, flexShrink: 0 }}>
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
    detail?.status === "active" ? "#34d399" :
    detail?.status === "scheduled" ? "#22d3ee" :
    detail?.status === "disabled" ? "#6b7280" : "#9ca3af";

  const producedArtifacts = ARTIFACTS.filter(a => a.producedBy === agentKey);
  const activity = detail?.activity ?? [];
  const shownActivity = moreActivity ? activity : activity.slice(0, 8);

  return (
    <SlideOver title={detail ? detail.name.toUpperCase() : "AGENT"} accent={statusColor} onClose={onClose}>
      {!detail && !err && <div style={{ fontSize: 12, color: "var(--text-muted)", fontFamily: "'JetBrains Mono', monospace" }}>Loading agent telemetry...</div>}
      {err && <div style={{ fontSize: 12, color: "#f87171" }}>Could not load agent detail ({err})</div>}
      {detail && (
        <>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 4 }}>
            <Pill text={detail.status.toUpperCase()} color={statusColor} />
            <Pill text={detail.kind === "scheduled" ? "SCHEDULED" : "ON DEMAND"} color="var(--text-muted, #6b7280)" />
            {detail.watchdogState === "SILENT" && <Pill text="SILENT (WATCHDOG)" color="#f87171" />}
            {detail.watchdogState === "LATE" && <Pill text="LATE (WATCHDOG)" color="#fb923c" />}
            {detail.watchdogState === "DISABLED" && <Pill text="DISABLED (WATCHDOG)" color="#6b7280" />}
            {detail.installed === false && <Pill text="NOT INSTALLED" color="#fb923c" />}
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
              <div style={{ marginTop: 10, fontSize: 12, color: "var(--text-secondary)", background: "var(--bg-card, #0d1117)", border: "1px solid var(--border, rgba(255,255,255,0.08))", borderRadius: 8, padding: "8px 10px", lineHeight: 1.5 }}>
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
  const accent = sys?.color ?? "#22d3ee";

  return (
    <SlideOver title={detail ? detail.label.toUpperCase() : "ARTIFACT"} accent={accent} onClose={onClose}>
      {!detail && !err && <div style={{ fontSize: 12, color: "var(--text-muted)", fontFamily: "'JetBrains Mono', monospace" }}>Loading artifact...</div>}
      {err && <div style={{ fontSize: 12, color: "#f87171" }}>Could not load artifact ({err})</div>}
      {detail && (
        <>
          <SummaryBlock accent={accent} lines={[
            detail.blurb,
            `Produced by ${detail.producedByName}.`,
            detail.updated ? `Last updated ${detail.updated}.` : detail.available ? "Update date unknown." : "File unavailable from here.",
          ]} />

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "10px 0" }}>
            <span className="mo-click" onClick={() => onSelect({ type: "agent", key: detail.producedBy })}>
              <Pill text={detail.producedByName.toUpperCase()} color="#22d3ee" />
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

  const accent = "#22d3ee";
  const age = fmtAge(detail?.updated ?? null);
  return (
    <SlideOver title={detail ? detail.title.toUpperCase() : "STAT"} accent={accent} onClose={onClose}>
      {!detail && !err && <div style={{ fontSize: 12, color: "var(--text-muted)", fontFamily: "'JetBrains Mono', monospace" }}>Loading breakdown...</div>}
      {err && <div style={{ fontSize: 12, color: "#f87171" }}>Could not load breakdown ({err})</div>}
      {detail && (
        <>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 4 }}>
            {age && <Pill text={`SNAPSHOT ${age.toUpperCase()}`} color="var(--text-muted, #6b7280)" />}
            {!detail.available && <Pill text="SNAPSHOT UNAVAILABLE" color="#fb923c" />}
          </div>
          <SummaryBlock accent={accent} lines={detail.summary} />
          {detail.items.length > 0 && (
            <Section title={`Breakdown (${detail.items.length})`} defaultOpen>
              {detail.items.map((it, i) => (
                <div key={i} style={{ display: "flex", alignItems: "baseline", gap: 10, fontSize: 12.5, marginBottom: 7, borderBottom: "1px solid var(--border, rgba(255,255,255,0.05))", paddingBottom: 6 }}>
                  <span style={{ color: "var(--text-secondary)", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{it.label}</span>
                  <span style={{ fontFamily: "'JetBrains Mono', monospace", color: "var(--text-primary)", flexShrink: 0 }}>{it.value}</span>
                  {it.note && <span style={{ color: "var(--text-muted)", fontSize: 11, flexShrink: 0 }}>{it.note}</span>}
                </div>
              ))}
            </Section>
          )}
          {detail.note && (
            <div style={{ fontSize: 11, color: "var(--text-muted)", lineHeight: 1.5, marginTop: 12, borderLeft: "2px solid var(--border, rgba(255,255,255,0.15))", paddingLeft: 10 }}>
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

  return (
    <SlideOver title={sys.label} accent={sys.color} onClose={onClose}>
      <SummaryBlock accent={sys.color} lines={[
        sys.blurb,
        `${touching.length} agent${touching.length === 1 ? "" : "s"} wired in, ${activeCount} recently active.`,
        related.length ? `Last activity ${shortDate(related[0].date)}: ${tightLine(related[0].title, 80)}` : "No recent log activity for this system.",
      ]} />

      {systemId === "website" && (
        <Section title="Published this week" defaultOpen>
          {(data.publishes?.items ?? []).map((p, i) => (
            <div key={i} style={{ fontSize: 12, marginBottom: 8, lineHeight: 1.5 }}>
              <span style={{ color: "var(--text-muted)", fontFamily: "'JetBrains Mono', monospace", fontSize: 10, marginRight: 8 }}>{shortDate(p.date)}</span>
              {p.url ? (
                <a href={p.url} target="_blank" rel="noreferrer" style={{ color: sys.color, textDecoration: "none" }}>
                  {tightLine(p.title, 110)} &#8599;
                </a>
              ) : (
                <span style={{ color: "var(--text-secondary)" }}>
                  {tightLine(p.title, 110)} <span style={{ color: "var(--text-muted)", fontSize: 10 }}>({p.note ?? "no link logged"})</span>
                </span>
              )}
            </div>
          ))}
          {(data.publishes?.items ?? []).length === 0 && (
            <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
              Nothing published in the last 7 days.
              {data.publishes?.lastPriorPublish ? ` Most recent prior publish: ${shortDate(data.publishes.lastPriorPublish)}.` : ""}
            </div>
          )}
        </Section>
      )}

      <Section title={`Agents (${touching.length})`} defaultOpen>
        {touching.map(a => (
          <div key={a.key} className="mo-click" style={{
            display: "flex", alignItems: "center", gap: 8, fontSize: 12, marginBottom: 6,
            border: "1px solid var(--border, rgba(255,255,255,0.08))", borderRadius: 8, padding: "6px 10px",
          }} onClick={() => onSelect({ type: "agent", key: a.key })}>
            <Dot color={isRecentlyActive(a) ? "#34d399" : "#6b7280"} pulse={isRecentlyActive(a)} />
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
function ClientPanel({ name, data, onClose }: { name: string; data: MissionData; onClose: () => void }) {
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
        {c.redFlags.length === 0 && <div style={{ fontSize: 12, color: "#34d399" }}>No open flags. All clear.</div>}
        {c.redFlags.map((f, i) => (
          <div key={i} style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 10, lineHeight: 1.5 }}>
            <span style={{ color: "#f87171" }}>&#9873; </span>
            {f.text}
            {f.link && (
              <>
                {" "}
                <a href={f.link} target="_blank" rel="noreferrer" style={{ color: "#22d3ee" }}>open &#8599;</a>
              </>
            )}
          </div>
        ))}
      </Section>
    </SlideOver>
  );
}

// ── Selection router: render whichever panel is open ───────────────────────
export function MissionPanels({ selection, data, onSelect }: {
  selection: Selection; data: MissionData | null; onSelect: (s: Selection) => void;
}) {
  if (!selection) return null;
  const close = () => onSelect(null);
  if (selection.type === "agent") return <AgentPanel agentKey={selection.key} onClose={close} onSelect={onSelect} />;
  if (selection.type === "artifact") return <ArtifactPanel artifactId={selection.id} onClose={close} onSelect={onSelect} />;
  if (selection.type === "stat") return <StatPanel statKey={selection.key} onClose={close} onSelect={onSelect} />;
  if (!data) return null;
  if (selection.type === "system") return <SystemPanel systemId={selection.id} data={data} onSelect={onSelect} onClose={close} />;
  if (selection.type === "client") return <ClientPanel name={selection.name} data={data} onClose={close} />;
  return null;
}
