"use client";

// MISSION CONTROL CORE — shared interactive pieces used by both the embedded
// MissionOps view (main app Agents section) and the standalone /mission page.
// Everything here is read-only: click an agent, system, client dot, or feed
// line and a detail panel opens showing what is going on with it.

import { useEffect, useState } from "react";

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
}
export interface FeedEntry { date: string; type: string; title: string; lines: string[] }
export interface ClientHealth {
  client: string;
  phase: string;
  overall: "green" | "yellow" | "red";
  pillars: string[];
  redFlags: { text: string; link: string | null }[];
}
export interface StatTile { label: string; value: string; sub: string | null }
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
  installed: boolean | null;
  lastRunAt: string | null;
  nextRunAt: string | null;
  systems: AgentWire[];
  activity: FeedEntry[];
  artifact: { title: string; lines: string[] } | null;
}

// ── shared metadata ────────────────────────────────────────────────────────
export const SYSTEMS = [
  { id: "vault", label: "VAULT", color: "#a78bfa", blurb: "The Obsidian brain: log.md, hot.md, state snapshots, client pages. Most agents write their results here." },
  { id: "ghl", label: "GHL", color: "#fb923c", blurb: "GoHighLevel CRM: contacts, pipelines, conversations, calendars for both accounts." },
  { id: "email", label: "EMAIL", color: "#22d3ee", blurb: "The cold-email path: the outreach sender and the reply inbox it feeds." },
  { id: "clients", label: "CLIENTS", color: "#34d399", blurb: "Live client sites and deliverables: Jackson Roofing, Renewal Health, and the health board that watches them." },
  { id: "schedule", label: "SCHEDULE", color: "#60a5fa", blurb: "The scheduled-tasks runner on Jack's PC that fires the daily and weekly agents." },
];

export const AGENT_WIRES: Record<string, string[]> = {
  "sentinel-daily": ["vault", "clients", "schedule"],
  "chronicler-end-of-day": ["vault", "schedule"],
  "content-engine-weekly": ["vault", "clients", "schedule"],
  "renewal-content-weekly": ["vault", "clients", "schedule"],
  "wing-digital-daily-outreach": ["email", "schedule"],
  "wing-audit-roofing-batch": ["vault", "ghl"],
  dispatch: ["vault", "ghl"],
  prospector: ["vault", "ghl"],
  outreach: ["email", "ghl"],
  "reply-triage": ["vault", "ghl", "email"],
  builder: ["ghl", "clients"],
};

// How each agent shows up in log.md (client-side mirror of the API's matchers,
// used to filter feed lines for the system panel).
export const AGENT_MATCH: Record<string, RegExp> = {
  "sentinel-daily": /\bsentinel\b/i,
  "chronicler-end-of-day": /\bchronicler\b/i,
  "content-engine-weekly": /content[- ]engine|jackson.*(blog|content|post)/i,
  "renewal-content-weekly": /\brenewal\b/i,
  "wing-digital-daily-outreach": /daily outreach/i,
  "wing-audit-roofing-batch": /\baudit\b/i,
  dispatch: /dispatch/i,
  prospector: /prospector|lead scan|lead-find/i,
  outreach: /outreach|cold email|b2b/i,
  "reply-triage": /reply-triage|triage/i,
  builder: /builder|onboard/i,
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
  | { type: "client"; name: string }
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

// ── Ops map (SVG, clickable + hover highlighting) ──────────────────────────
export function OpsMap({ agents, onSelect }: { agents: AgentCard[]; onSelect: (s: Selection) => void }) {
  const [hover, setHover] = useState<string | null>(null);
  const W = 900, H = 420;
  const shown = agents.filter(a => a.enabled);
  const agentPos = shown.map((a, i) => ({ a, x: (W / (shown.length + 1)) * (i + 1), y: 80 }));
  const sysPos = SYSTEMS.map((s, i) => ({ s, x: (W / (SYSTEMS.length + 1)) * (i + 1), y: H - 70 }));
  const sysMap = new Map(sysPos.map(p => [p.s.id, p]));
  const hoverWires = hover ? new Set(AGENT_WIRES[hover] ?? []) : null;

  return (
    <div style={{
      background: "linear-gradient(180deg, var(--bg-card, #0d1117), rgba(10,12,20,0.9))",
      border: "1px solid var(--border, rgba(255,255,255,0.08))",
      borderRadius: 14, padding: 8, overflowX: "auto",
    }}>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", minWidth: 640, display: "block" }}>
        <defs>
          <radialGradient id="mo-glow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="rgba(34,211,238,0.25)" />
            <stop offset="100%" stopColor="rgba(34,211,238,0)" />
          </radialGradient>
        </defs>

        {/* connection lines */}
        {agentPos.map(({ a, x, y }) =>
          (AGENT_WIRES[a.key] ?? ["vault"]).map(sysId => {
            const sp = sysMap.get(sysId);
            if (!sp) return null;
            const active = isRecentlyActive(a);
            const highlighted = hover === a.key;
            const dimmed = hover !== null && !highlighted;
            const color = sp.s.color;
            const midY = (y + sp.y) / 2;
            const d = `M ${x} ${y + 26} C ${x} ${midY}, ${sp.x} ${midY}, ${sp.x} ${sp.y - 26}`;
            return (
              <g key={`${a.key}-${sysId}`} opacity={dimmed ? 0.12 : 1}>
                <path d={d} fill="none" stroke={color}
                  strokeOpacity={highlighted ? 0.9 : active ? 0.5 : 0.14}
                  strokeWidth={highlighted ? 2.2 : active ? 1.6 : 1} />
                {(active || highlighted) && (
                  <path d={d} fill="none" stroke={color} strokeWidth={2.2}
                    strokeDasharray="4 14" strokeLinecap="round" className="mo-flow" />
                )}
              </g>
            );
          })
        )}

        {/* agent nodes */}
        {agentPos.map(({ a, x, y }) => {
          const active = isRecentlyActive(a);
          const highlighted = hover === a.key;
          const dimmed = hover !== null && !highlighted;
          const color = highlighted ? "#22d3ee" : active ? "#22d3ee" : "#4b5563";
          return (
            <g key={a.key} className="mo-click" opacity={dimmed ? 0.35 : 1}
              onMouseEnter={() => setHover(a.key)}
              onMouseLeave={() => setHover(h => (h === a.key ? null : h))}
              onClick={() => onSelect({ type: "agent", key: a.key })}>
              {(active || highlighted) && <circle cx={x} cy={y} r={34} fill="url(#mo-glow)" />}
              <circle cx={x} cy={y} r={22} fill="rgba(13,17,23,0.95)" stroke={color}
                strokeWidth={highlighted ? 2.2 : 1.5}
                className={active ? "mo-node-pulse" : undefined} />
              <circle cx={x} cy={y - 30} r={4} fill={active ? "#34d399" : "#4b5563"}
                className={active ? "mo-pulse" : undefined} />
              <text x={x} y={y + 4} textAnchor="middle" fill={active || highlighted ? "#e5e7eb" : "#9ca3af"}
                fontSize="10" fontFamily="'JetBrains Mono', monospace" style={{ pointerEvents: "none" }}>
                {a.name.split(" ")[0].slice(0, 9).toUpperCase()}
              </text>
              <text x={x} y={y + 44} textAnchor="middle" fill="#6b7280" fontSize="9"
                fontFamily="'JetBrains Mono', monospace" style={{ pointerEvents: "none" }}>
                {a.nextRunAt ? fmtCountdown(a.nextRunAt) : a.lastLogDate ?? a.schedule}
              </text>
            </g>
          );
        })}

        {/* system nodes */}
        {sysPos.map(({ s, x, y }) => {
          const dimmed = hoverWires !== null && !hoverWires.has(s.id);
          return (
            <g key={s.id} className="mo-click" opacity={dimmed ? 0.3 : 1}
              onClick={() => onSelect({ type: "system", id: s.id })}>
              <rect x={x - 46} y={y - 20} width={92} height={40} rx={10}
                fill="rgba(13,17,23,0.95)" stroke={s.color} strokeOpacity={0.6} strokeWidth={1.4} />
              <circle cx={x - 32} cy={y} r={4} fill={s.color} className="mo-pulse" />
              <text x={x + 6} y={y + 4} textAnchor="middle" fill={s.color} fontSize="11"
                fontFamily="'JetBrains Mono', monospace" letterSpacing="0.1em" style={{ pointerEvents: "none" }}>
                {s.label}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// ── Agent tile (clickable) ─────────────────────────────────────────────────
export function AgentTile({ a, onSelect }: { a: AgentCard; onSelect: (s: Selection) => void }) {
  let pill = { text: "IDLE", color: "var(--text-muted, #6b7280)" };
  let pulse = false;
  if (!a.enabled) pill = { text: "DISABLED", color: "var(--text-muted, #6b7280)" };
  else if (a.pcNeeded && a.kind === "scheduled") pill = { text: "PC NEEDED", color: "#fb923c" };
  else if (a.nextRunAt) { pill = { text: `NEXT ${fmtCountdown(a.nextRunAt)}`.toUpperCase(), color: "#22d3ee" }; pulse = true; }
  else if (a.lastLogDate) { pill = { text: "ACTIVE", color: "#34d399" }; pulse = true; }

  return (
    <div
      onClick={() => onSelect({ type: "agent", key: a.key })}
      className="mo-click"
      style={{
        background: "var(--bg-card, #0d1117)",
        border: "1px solid var(--border, rgba(255,255,255,0.08))",
        borderRadius: 12, padding: "12px 14px",
        display: "flex", flexDirection: "column", gap: 6,
        opacity: a.enabled ? 1 : 0.55,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          <Dot color={a.enabled ? pill.color : "var(--text-muted, #6b7280)"} pulse={pulse} />
          <span style={{ fontWeight: 600, fontSize: 14, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{a.name}</span>
        </div>
        <Pill text={pill.text} color={pill.color} />
      </div>
      <div style={{ fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.35 }}>{a.role}</div>
      <div style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "'JetBrains Mono', monospace" }}>
        {a.schedule}
        {a.lastRunAt ? ` · last run ${new Date(a.lastRunAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}` : ""}
      </div>
      {a.lastLogLine && (
        <div style={{
          fontSize: 11, color: "var(--text-secondary)", fontFamily: "'JetBrains Mono', monospace",
          background: "var(--bg-secondary, #0a0d14)", border: "1px solid var(--border, rgba(255,255,255,0.08))",
          borderRadius: 6, padding: "5px 8px",
          whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
        }} title={a.lastLogLine}>
          <span style={{ color: "var(--text-muted)" }}>{a.lastLogDate} </span>
          {a.lastLogLine}
        </div>
      )}
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
            onClick={() => setOpen(expanded ? null : i)}>
            <div style={{ fontSize: 11, display: "flex", gap: 8, alignItems: "baseline" }}>
              <span style={{ color: "var(--text-muted)" }}>{e.date}</span>
              <span style={{ color: TYPE_COLOR[e.type] ?? "var(--text-secondary)", textTransform: "uppercase", fontSize: 10, letterSpacing: "0.08em" }}>{e.type}</span>
              <span style={{ marginLeft: "auto", color: "var(--text-muted)", fontSize: 10 }}>{expanded ? "collapse" : "expand"}</span>
            </div>
            <div style={{ fontSize: 12, color: "var(--text-primary)", margin: "2px 0" }}>{e.title}</div>
            {(expanded ? e.lines : e.lines.slice(0, 2)).map((l, j) => (
              <div key={j} style={{
                fontSize: 11, color: "var(--text-muted)",
                whiteSpace: expanded ? "normal" : "nowrap",
                overflow: expanded ? "visible" : "hidden",
                textOverflow: "ellipsis",
                lineHeight: 1.5,
              }}>{l}</div>
            ))}
          </div>
        );
      })}
    </>
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
          onClick={() => onSelect({ type: "client", name: c.client })}>
          <Dot color={STATUS_COLOR[c.overall]} pulse={c.overall !== "green"} />
          <span style={{ fontSize: 13 }}>{c.client}</span>
          <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{c.pillars.join(" ")}</span>
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
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 200 }}>
      <div onClick={onClose} style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.55)" }} />
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
          <button onClick={onClose} style={{
            marginLeft: "auto", background: "none", border: "1px solid var(--border, rgba(255,255,255,0.15))",
            color: "var(--text-secondary, #9ca3af)", borderRadius: 8, padding: "4px 10px", cursor: "pointer", fontSize: 12,
          }}>Close</button>
        </div>
        <div style={{ overflowY: "auto", padding: "16px 18px", flex: 1 }}>{children}</div>
      </div>
    </div>
  );
}

function SectionLabel({ text }: { text: string }) {
  return <div style={{ fontSize: 10, letterSpacing: "0.14em", color: "var(--text-muted)", margin: "14px 0 6px", textTransform: "uppercase" }}>{text}</div>;
}

const DIR_ARROW: Record<string, string> = { reads: "reads from", writes: "writes to", both: "reads + writes" };

// ── Agent detail panel (fetches /api/mission?agent=key) ────────────────────
function AgentPanel({ agentKey, onClose }: { agentKey: string; onClose: () => void }) {
  const [detail, setDetail] = useState<AgentDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setDetail(null); setErr(null);
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

  return (
    <SlideOver title={detail ? detail.name.toUpperCase() : "AGENT"} accent={statusColor} onClose={onClose}>
      {!detail && !err && <div style={{ fontSize: 12, color: "var(--text-muted)", fontFamily: "'JetBrains Mono', monospace" }}>Loading agent telemetry...</div>}
      {err && <div style={{ fontSize: 12, color: "#f87171" }}>Could not load agent detail ({err})</div>}
      {detail && (
        <>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 4 }}>
            <Pill text={detail.status.toUpperCase()} color={statusColor} />
            <Pill text={detail.kind === "scheduled" ? "SCHEDULED" : "ON DEMAND"} color="var(--text-muted, #6b7280)" />
            {detail.installed === false && <Pill text="NOT INSTALLED" color="#fb923c" />}
          </div>

          <SectionLabel text="Role" />
          <div style={{ fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.55 }}>{detail.description}</div>

          <SectionLabel text="Schedule" />
          <div style={{ fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.5 }}>{detail.scheduleHuman}</div>
          <div style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "'JetBrains Mono', monospace", marginTop: 4 }}>
            {detail.nextRunAt && <>next run {fmtCountdown(detail.nextRunAt)} ({new Date(detail.nextRunAt).toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit" })})<br /></>}
            {detail.lastRunAt && <>last run {new Date(detail.lastRunAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</>}
            {!detail.nextRunAt && !detail.lastRunAt && "no recorded runs"}
          </div>

          <SectionLabel text="Systems it touches" />
          {detail.systems.map(w => {
            const sys = SYSTEMS.find(s => s.id === w.id);
            return (
              <div key={w.id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, marginBottom: 5 }}>
                <Dot color={sys?.color ?? "#9ca3af"} />
                <span style={{ fontFamily: "'JetBrains Mono', monospace", color: sys?.color ?? "var(--text-secondary)" }}>{w.label}</span>
                <span style={{ color: "var(--text-muted)" }}>{DIR_ARROW[w.direction]}</span>
              </div>
            );
          })}

          {detail.artifact && (
            <>
              <SectionLabel text={detail.artifact.title} />
              <div style={{
                fontSize: 11, fontFamily: "'JetBrains Mono', monospace", color: "var(--text-secondary)",
                background: "var(--bg-card, #0d1117)", border: "1px solid var(--border, rgba(255,255,255,0.08))",
                borderRadius: 8, padding: "8px 10px", lineHeight: 1.6, whiteSpace: "pre-wrap", wordBreak: "break-word",
              }}>
                {detail.artifact.lines.join("\n")}
              </div>
            </>
          )}

          <SectionLabel text={`Recent activity (${detail.activity.length})`} />
          {detail.activity.length === 0 && <div style={{ fontSize: 12, color: "var(--text-muted)" }}>No log entries mention this agent yet.</div>}
          <FeedList feed={detail.activity} />
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
  const matchers = touching.map(a => AGENT_MATCH[a.key]).filter(Boolean);
  const related = data.feed.filter(e =>
    matchers.some(m => m.test(e.title) || m.test(e.type) || e.lines.some(l => m.test(l)))
  ).slice(0, 25);

  return (
    <SlideOver title={sys.label} accent={sys.color} onClose={onClose}>
      <div style={{ fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.55 }}>{sys.blurb}</div>

      <SectionLabel text={`Agents that touch ${sys.label} (${touching.length})`} />
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

      <SectionLabel text={`Recent related activity (${related.length})`} />
      {related.length === 0 && <div style={{ fontSize: 12, color: "var(--text-muted)" }}>Nothing recent in the log for this system.</div>}
      <FeedList feed={related} />
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

      <SectionLabel text="Pillar breakdown" />
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

      <SectionLabel text={`Flags (${c.redFlags.length})`} />
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
    </SlideOver>
  );
}

// ── Selection router: render whichever panel is open ───────────────────────
export function MissionPanels({ selection, data, onSelect }: {
  selection: Selection; data: MissionData | null; onSelect: (s: Selection) => void;
}) {
  if (!selection) return null;
  const close = () => onSelect(null);
  if (selection.type === "agent") return <AgentPanel agentKey={selection.key} onClose={close} />;
  if (!data) return null;
  if (selection.type === "system") return <SystemPanel systemId={selection.id} data={data} onSelect={onSelect} onClose={close} />;
  if (selection.type === "client") return <ClientPanel name={selection.name} data={data} onClose={close} />;
  return null;
}
