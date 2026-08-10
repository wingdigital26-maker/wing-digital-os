"use client";

// MISSION OPS — embedded mission-control view for the main OS Agents section.
// Same design language as /mission (dark glass, neon, pulsing dots) plus an
// operations MAP: every agent drawn as a node wired to the systems it touches
// (Vault, GHL, Email, Clients, Schedule) with animated flow lines when the
// agent has recent activity. Reuses /api/mission — no duplicated backend logic.

import { useEffect, useMemo, useState } from "react";

interface AgentCard {
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
interface FeedEntry { date: string; type: string; title: string; lines: string[] }
interface StatTile { label: string; value: string; sub: string | null }
interface MissionData {
  generatedAt: string;
  cloud: boolean;
  sources: Record<string, boolean>;
  overall: "green" | "yellow" | "red";
  agents: AgentCard[];
  feed: FeedEntry[];
  stats: { tiles: StatTile[]; updated: string | null };
}

// Which systems each agent touches — powers the map wiring.
const SYSTEMS = [
  { id: "vault", label: "VAULT", color: "#a78bfa" },
  { id: "ghl", label: "GHL", color: "#fb923c" },
  { id: "email", label: "EMAIL", color: "#22d3ee" },
  { id: "clients", label: "CLIENTS", color: "#34d399" },
  { id: "schedule", label: "SCHEDULE", color: "#60a5fa" },
];

const AGENT_WIRES: Record<string, string[]> = {
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

const TYPE_COLOR: Record<string, string> = {
  ingest: "#22d3ee",
  query: "#a78bfa",
  build: "#34d399",
  security: "#f87171",
  lint: "#fb923c",
};

function isRecentlyActive(a: AgentCard): boolean {
  if (a.lastLogDate) {
    const days = (Date.now() - new Date(a.lastLogDate).getTime()) / 86400000;
    if (days <= 2) return true;
  }
  if (a.nextRunAt && new Date(a.nextRunAt).getTime() - Date.now() < 3600_000) return true;
  return false;
}

function fmtCountdown(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "due now";
  const min = Math.floor(ms / 60000);
  if (min < 60) return `in ${min}m`;
  const h = Math.floor(min / 60);
  if (h < 48) return `in ${h}h ${min % 60}m`;
  return `in ${Math.floor(h / 24)}d`;
}

function Dot({ color, pulse }: { color: string; pulse?: boolean }) {
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

// ── Ops map (SVG) ──────────────────────────────────────────────────────────
function OpsMap({ agents }: { agents: AgentCard[] }) {
  const W = 900, H = 420;
  const shown = agents.filter(a => a.enabled);
  // Agents spread across the top, systems across the bottom.
  const agentPos = shown.map((a, i) => ({
    a,
    x: (W / (shown.length + 1)) * (i + 1),
    y: 80,
  }));
  const sysPos = SYSTEMS.map((s, i) => ({
    s,
    x: (W / (SYSTEMS.length + 1)) * (i + 1),
    y: H - 70,
  }));
  const sysMap = new Map(sysPos.map(p => [p.s.id, p]));

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
            const color = sp.s.color;
            const midY = (y + sp.y) / 2;
            const d = `M ${x} ${y + 26} C ${x} ${midY}, ${sp.x} ${midY}, ${sp.x} ${sp.y - 26}`;
            return (
              <g key={`${a.key}-${sysId}`}>
                <path d={d} fill="none" stroke={color} strokeOpacity={active ? 0.5 : 0.14} strokeWidth={active ? 1.6 : 1} />
                {active && (
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
          const color = active ? "#22d3ee" : "#4b5563";
          return (
            <g key={a.key}>
              {active && <circle cx={x} cy={y} r={34} fill="url(#mo-glow)" />}
              <circle cx={x} cy={y} r={22} fill="rgba(13,17,23,0.95)" stroke={color} strokeWidth={1.5}
                className={active ? "mo-node-pulse" : undefined} />
              <circle cx={x} cy={y - 30} r={4} fill={active ? "#34d399" : "#4b5563"}
                className={active ? "mo-pulse" : undefined} />
              <text x={x} y={y + 4} textAnchor="middle" fill={active ? "#e5e7eb" : "#9ca3af"}
                fontSize="10" fontFamily="'JetBrains Mono', monospace">
                {a.name.split(" ")[0].slice(0, 9).toUpperCase()}
              </text>
              <text x={x} y={y + 44} textAnchor="middle" fill="#6b7280" fontSize="9"
                fontFamily="'JetBrains Mono', monospace">
                {a.nextRunAt ? fmtCountdown(a.nextRunAt) : a.lastLogDate ?? a.schedule}
              </text>
            </g>
          );
        })}

        {/* system nodes */}
        {sysPos.map(({ s, x, y }) => (
          <g key={s.id}>
            <rect x={x - 46} y={y - 20} width={92} height={40} rx={10}
              fill="rgba(13,17,23,0.95)" stroke={s.color} strokeOpacity={0.6} strokeWidth={1.4} />
            <circle cx={x - 32} cy={y} r={4} fill={s.color} className="mo-pulse" />
            <text x={x + 6} y={y + 4} textAnchor="middle" fill={s.color} fontSize="11"
              fontFamily="'JetBrains Mono', monospace" letterSpacing="0.1em">
              {s.label}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────
export default function MissionOps() {
  const [data, setData] = useState<MissionData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch("/api/mission", { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const j = await res.json();
        if (alive) { setData(j); setError(null); }
      } catch (e: unknown) {
        if (alive) setError(e instanceof Error ? e.message : "fetch failed");
      }
    };
    load();
    const poll = setInterval(load, 30_000);
    return () => { alive = false; clearInterval(poll); };
  }, []);

  const scheduled = useMemo(() => data?.agents.filter(a => a.kind === "scheduled") ?? [], [data]);
  const crew = useMemo(() => data?.agents.filter(a => a.kind === "crew") ?? [], [data]);
  const overallColor = data?.overall === "red" ? "#f87171" : data?.overall === "yellow" ? "#fb923c" : "#34d399";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <style>{`
        .mo-pulse { animation: moPulse 2s ease-in-out infinite; }
        @keyframes moPulse { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }
        .mo-node-pulse { animation: moNode 2.6s ease-in-out infinite; }
        @keyframes moNode { 0%,100% { stroke-opacity: 1; } 50% { stroke-opacity: 0.4; } }
        .mo-flow { animation: moFlow 1.6s linear infinite; }
        @keyframes moFlow { from { stroke-dashoffset: 36; } to { stroke-dashoffset: 0; } }
      `}</style>

      {/* header row */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <Dot color={overallColor} pulse />
        <span style={{ fontSize: 13, fontWeight: 700, letterSpacing: "0.12em", fontFamily: "'JetBrains Mono', monospace" }}>
          AGENT MISSION CONTROL
        </span>
        {data?.cloud && (
          <span style={{ fontSize: 10, color: "#a78bfa", border: "1px solid #a78bfa55", borderRadius: 99, padding: "2px 8px", fontFamily: "'JetBrains Mono', monospace" }}>
            CLOUD MODE
          </span>
        )}
        {error && (
          <span style={{ fontSize: 10, color: "#f87171", border: "1px solid #f8717155", borderRadius: 99, padding: "2px 8px", fontFamily: "'JetBrains Mono', monospace" }}>
            FEED ERROR {error}
          </span>
        )}
        <a href="/mission" target="_blank" rel="noreferrer" style={{
          marginLeft: "auto", fontSize: 11, color: "var(--accent, #22d3ee)", textDecoration: "none",
          border: "1px solid var(--accent, #22d3ee)", borderRadius: 99, padding: "4px 12px", fontWeight: 600,
        }}>
          Open full Mission Control
        </a>
      </div>

      {!data && !error && (
        <div style={{ color: "var(--text-muted, #6b7280)", fontFamily: "'JetBrains Mono', monospace", fontSize: 12 }}>
          Establishing uplink...
        </div>
      )}

      {data && (
        <>
          {/* Ops map: every agent wired to what it touches */}
          <OpsMap agents={data.agents} />

          <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.6fr) minmax(280px, 1fr)", gap: 16, alignItems: "start" }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>
              {/* Scheduled agent tiles */}
              <section>
                <h2 style={{ fontSize: 11, letterSpacing: "0.14em", color: "var(--text-muted)", marginBottom: 8 }}>SCHEDULED AGENTS</h2>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 10 }}>
                  {scheduled.map(a => <Tile key={a.key} a={a} />)}
                </div>
              </section>
              <section>
                <h2 style={{ fontSize: 11, letterSpacing: "0.14em", color: "var(--text-muted)", marginBottom: 8 }}>ON-DEMAND CREW</h2>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 10 }}>
                  {crew.map(a => <Tile key={a.key} a={a} />)}
                </div>
              </section>
            </div>

            {/* Live feed */}
            <section style={{
              background: "var(--bg-secondary, #0d1117)",
              border: "1px solid var(--border, rgba(255,255,255,0.08))",
              borderRadius: 12, padding: "12px 14px",
            }}>
              <h2 style={{ fontSize: 11, letterSpacing: "0.14em", color: "var(--text-muted)", marginBottom: 10, display: "flex", alignItems: "center", gap: 8 }}>
                <Dot color="#34d399" pulse /> LIVE ACTIVITY
                <span style={{ marginLeft: "auto", fontFamily: "'JetBrains Mono', monospace", fontSize: 10 }}>refresh 30s</span>
              </h2>
              <div style={{ maxHeight: 520, overflowY: "auto", paddingRight: 6 }}>
                {data.feed.length === 0 && <div style={{ fontSize: 12, color: "var(--text-muted)" }}>log.md unavailable</div>}
                {data.feed.slice(0, 30).map((e, i) => (
                  <div key={i} style={{ marginBottom: 12, fontFamily: "'JetBrains Mono', monospace" }}>
                    <div style={{ fontSize: 11, display: "flex", gap: 8, alignItems: "baseline" }}>
                      <span style={{ color: "var(--text-muted)" }}>{e.date}</span>
                      <span style={{ color: TYPE_COLOR[e.type] ?? "var(--text-secondary)", textTransform: "uppercase", fontSize: 10, letterSpacing: "0.08em" }}>{e.type}</span>
                    </div>
                    <div style={{ fontSize: 12, color: "var(--text-primary)", margin: "2px 0" }}>{e.title}</div>
                    {e.lines.slice(0, 2).map((l, j) => (
                      <div key={j} style={{ fontSize: 11, color: "var(--text-muted)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{l}</div>
                    ))}
                  </div>
                ))}
              </div>
            </section>
          </div>
        </>
      )}
    </div>
  );
}

function Tile({ a }: { a: AgentCard }) {
  let pill = { text: "IDLE", color: "var(--text-muted, #6b7280)" };
  let pulse = false;
  if (!a.enabled) pill = { text: "DISABLED", color: "var(--text-muted, #6b7280)" };
  else if (a.pcNeeded && a.kind === "scheduled") pill = { text: "PC NEEDED", color: "#fb923c" };
  else if (a.nextRunAt) { pill = { text: `NEXT ${fmtCountdown(a.nextRunAt)}`.toUpperCase(), color: "#22d3ee" }; pulse = true; }
  else if (a.lastLogDate) { pill = { text: "ACTIVE", color: "#34d399" }; pulse = true; }

  return (
    <div style={{
      background: "var(--bg-card, #0d1117)",
      border: "1px solid var(--border, rgba(255,255,255,0.08))",
      borderRadius: 12, padding: "12px 14px",
      display: "flex", flexDirection: "column", gap: 6,
      opacity: a.enabled ? 1 : 0.55,
    }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          <Dot color={a.enabled ? pill.color : "var(--text-muted, #6b7280)"} pulse={pulse} />
          <span style={{ fontWeight: 600, fontSize: 14, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{a.name}</span>
        </div>
        <span style={{
          fontSize: 10, fontFamily: "'JetBrains Mono', monospace", letterSpacing: "0.08em",
          padding: "2px 8px", borderRadius: 99, border: `1px solid ${pill.color}`, color: pill.color, whiteSpace: "nowrap",
        }}>{pill.text}</span>
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
