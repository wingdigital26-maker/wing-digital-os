"use client";

// MISSION OPS — the OS "Agents" view.
//
// Scope: Wing Digital's OWN internal agents only. Client-delivery work
// (Renewal Health content, Hero's Junk content, Jackson blog publishing,
// per-client outreach) lives in the CRM section instead — the boundary is the
// CLIENT_DELIVERY_AGENTS set in MissionControlCore.tsx.
//
// Layout, top to bottom: watchdog banner, header, next-up strip, the OPS MAP
// as a contained first-class panel (fixed-ish height, its own heading and
// legend), then the scannable roster beside the activity ticker. The map shows
// the wiring at a glance; the roster carries the detail. Shared pieces live in
// MissionControlCore.tsx (also used by /mission). Reuses /api/mission.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  MissionData, Selection, Dot, MissionStyles, OpsMap, FeedTicker,
  MissionPanels, NextUpStrip, WatchdogBanner, AgentCard, FilesChangedChip,
  isInternalAgent, fmtCountdown, fmtAge, shortDate, tightLine,
} from "./MissionControlCore";

const MONO = "'JetBrains Mono', monospace";

/** Status is encoded as colour AND text — never colour alone. */
type AgentStatus = { label: string; color: string; pulse: boolean; tone: "ok" | "warn" | "bad" | "idle" };

function statusOf(a: AgentCard): AgentStatus {
  if (!a.enabled && a.trial) return { label: "Trial", color: "var(--orange)", pulse: false, tone: "warn" };
  if (!a.enabled) return { label: "Disabled", color: "var(--text-muted)", pulse: false, tone: "idle" };
  if (a.watchdogState === "SILENT") return { label: "Silent", color: "var(--red)", pulse: true, tone: "bad" };
  if (a.watchdogState === "LATE") return { label: "Late", color: "var(--orange)", pulse: true, tone: "warn" };
  if (a.pcNeeded && a.kind === "scheduled") return { label: "PC needed", color: "var(--orange)", pulse: false, tone: "warn" };
  if (a.kind === "crew") return { label: "On demand", color: "var(--accent-2)", pulse: false, tone: "idle" };
  return { label: "Healthy", color: "var(--green)", pulse: true, tone: "ok" };
}

function StatusPill({ s }: { s: AgentStatus }) {
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 6,
      fontSize: 11, fontWeight: 600, fontFamily: MONO, letterSpacing: "0.04em",
      padding: "3px 10px 3px 8px", borderRadius: 99,
      border: `1px solid ${s.color}`, color: s.color, whiteSpace: "nowrap",
      background: "var(--bg-secondary)",
    }}>
      <Dot color={s.color} pulse={s.pulse} />
      {s.label}
    </span>
  );
}

/** Shared grid track definition: the section header row and every agent row
 *  use the same columns so the labels line up as one table. */
const ROW_COLUMNS = "minmax(180px, 1.3fr) 118px 92px 100px minmax(0, 1.9fr)";

/** A cell value. The per-cell label is printed ONLY on narrow screens, where the
 *  grid collapses and the column header is hidden; on desktop the single header
 *  row above the list carries the label instead of repeating it on every row. */
function Meta({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div className="agents-cell-label" style={{ fontSize: 9, letterSpacing: "0.14em", color: "var(--text-muted)", textTransform: "uppercase", marginBottom: 3 }}>
        {label}
      </div>
      <div style={{
        fontSize: 12, fontFamily: MONO, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
        color: accent ? "var(--accent)" : "var(--text-secondary)",
      }}>
        {value}
      </div>
    </div>
  );
}

/** One column header per section, instead of the same three micro-labels
 *  repeated on every single row. */
function ColumnHeader() {
  const cell: React.CSSProperties = {
    fontSize: 9, letterSpacing: "0.14em", color: "var(--text-muted)",
    textTransform: "uppercase", whiteSpace: "nowrap",
  };
  return (
    <div
      className="agents-colhead"
      style={{
        display: "grid", gridTemplateColumns: ROW_COLUMNS, gap: 18,
        padding: "0 18px 8px",
      }}
    >
      <div style={cell}>Agent</div>
      <div style={cell}>Status</div>
      <div style={cell}>Last run</div>
      <div style={cell}>Next run</div>
      <div style={cell}>Last result</div>
    </div>
  );
}

function AgentRow({ a, onSelect }: { a: AgentCard; onSelect: (s: Selection) => void }) {
  const s = statusOf(a);
  const [hover, setHover] = useState(false);
  const lastRun = a.lastRunAt
    ? (fmtAge(a.lastRunAt.replace("T", " ").slice(0, 16)) ?? shortDate(a.lastRunAt))
    : a.lastLogDate ? shortDate(a.lastLogDate) : "no record";
  const nextRun = a.enabled && a.nextRunAt ? fmtCountdown(a.nextRunAt) : a.kind === "crew" ? "manual" : "not scheduled";

  return (
    <div
      className="mo-click agents-row"
      onClick={() => onSelect({ type: "agent", key: a.key })}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "grid",
        gridTemplateColumns: ROW_COLUMNS,
        gap: 18, alignItems: "center",
        padding: "12px 18px",
        borderTop: "1px solid var(--border)",
        background: hover ? "var(--bg-hover)" : "transparent",
        opacity: a.enabled || a.trial ? 1 : 0.55,
        transition: "background 120ms ease",
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 650, color: "var(--text-primary)", letterSpacing: "-0.01em" }}>{a.name}</div>
        <div style={{
          fontSize: 12, color: "var(--text-muted)", marginTop: 2, lineHeight: 1.4,
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>{a.role}</div>
      </div>
      <div><StatusPill s={s} /></div>
      <Meta label="Last run" value={lastRun} />
      <Meta label="Next run" value={nextRun} accent={Boolean(a.enabled && a.nextRunAt)} />
      <div style={{ minWidth: 0 }}>
        <div className="agents-cell-label" style={{ fontSize: 9, letterSpacing: "0.14em", color: "var(--text-muted)", textTransform: "uppercase", marginBottom: 3 }}>
          Last result
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          <span style={{ fontSize: 12, color: "var(--text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
            {a.lastLogLine ? tightLine(a.lastLogLine, 70) : <span style={{ color: "var(--text-muted)" }}>none logged</span>}
          </span>
          {/* Only when the run reported a count — unreported runs show nothing. */}
          <FilesChangedChip facts={a.filesFacts} />
        </div>
      </div>
    </div>
  );
}

/** How many rows a roster section shows before it collapses behind a count.
 *  Keeps the bottom of the page a fixed, scannable height as agents are added. */
const ROW_CAP = 8;

function RosterSection({ title, note, empty, agents, onSelect }: {
  title: string; note: string; empty: string;
  agents: AgentCard[]; onSelect: (s: Selection) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const hidden = Math.max(0, agents.length - ROW_CAP);
  const shown = expanded ? agents : agents.slice(0, ROW_CAP);

  return (
    <section style={{
      background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 14, overflow: "hidden",
    }}>
      <header style={{ padding: "14px 18px 10px", display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
        <h2 style={{ fontSize: 12, fontWeight: 700, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--text-primary)", margin: 0 }}>
          {title}
        </h2>
        <span style={{ fontSize: 11, fontFamily: MONO, color: "var(--text-muted)" }}>{agents.length}</span>
        <span style={{ fontSize: 11, color: "var(--text-muted)", marginLeft: "auto" }}>{note}</span>
      </header>

      {agents.length > 0 && <ColumnHeader />}
      {shown.map(a => <AgentRow key={a.key} a={a} onSelect={onSelect} />)}

      {agents.length === 0 && (
        <div style={{ padding: "16px 18px", fontSize: 12, color: "var(--text-muted)", borderTop: "1px solid var(--border)" }}>
          {empty}
        </div>
      )}

      {hidden > 0 && (
        <button
          onClick={() => setExpanded(v => !v)}
          style={{
            width: "100%", background: "none", border: "none", borderTop: "1px solid var(--border)",
            padding: "10px 18px", textAlign: "left", cursor: "pointer",
            fontSize: 11, fontFamily: MONO, color: "var(--accent)",
          }}
        >
          {expanded ? "show fewer" : `show ${hidden} more`}
        </button>
      )}
    </section>
  );
}

/** Legend for the ops map. Colour is never the only cue — each chip is named. */
function LegendChip({ color, label, dashed }: { color: string; label: string; dashed?: boolean }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--text-secondary)", whiteSpace: "nowrap" }}>
      <span style={{
        width: 10, height: 10, borderRadius: "50%",
        border: `1.5px ${dashed ? "dashed" : "solid"} ${color}`,
        background: "var(--bg-card)", flexShrink: 0,
      }} />
      {label}
    </span>
  );
}

export default function MissionOps() {
  const [data, setData] = useState<MissionData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection>(null);

  const aliveRef = useRef(true);
  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/mission", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      if (aliveRef.current) { setData(j); setError(null); }
    } catch (e: unknown) {
      if (aliveRef.current) setError(e instanceof Error ? e.message : "fetch failed");
    }
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    load();
    const poll = setInterval(load, 30_000);
    // Pull-to-refresh (phone) dispatches this to re-fetch /api/mission.
    const onPull = () => load();
    window.addEventListener("os:pull-refresh", onPull);
    return () => { aliveRef.current = false; clearInterval(poll); window.removeEventListener("os:pull-refresh", onPull); };
  }, [load]);

  // SCOPE GUARD: client-delivery agents are filtered out of the Agents tab.
  const internal = useMemo(() => (data?.agents ?? []).filter(isInternalAgent), [data]);
  const scheduled = useMemo(() => internal.filter(a => a.kind === "scheduled"), [internal]);
  const crew = useMemo(() => internal.filter(a => a.kind === "crew"), [internal]);
  const attention = useMemo(
    () => internal.filter(a => { const t = statusOf(a).tone; return t === "bad" || t === "warn"; }).length,
    [internal],
  );

  const overallColor = data?.overall === "red" ? "var(--red)" : data?.overall === "yellow" ? "var(--orange)" : "var(--green)";
  const overallText = data?.overall === "red" ? "Problems" : data?.overall === "yellow" ? "Degraded" : "All systems nominal";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <MissionStyles />
      <style>{`
        /* Desktop: one column header per section, so the same three micro-labels
           are not reprinted on every row. */
        @media (min-width: 901px) {
          .agents-cell-label { display: none; }
        }
        /* Narrow: the grid collapses, the column header goes away and each cell
           carries its own label again. */
        @media (max-width: 900px) {
          .agents-colhead { display: none !important; }
          .agents-row { grid-template-columns: minmax(0, 1fr) auto !important; row-gap: 10px !important; }
          .agents-row > *:nth-child(n+3) { grid-column: span 2; }
        }
      `}</style>

      {/* Watchdog problems banner — always the very first thing on screen */}
      {data && <WatchdogBanner watchdog={data.watchdog} onRechecked={load} />}

      {/* Page header */}
      <header style={{ display: "flex", alignItems: "flex-start", gap: 14, flexWrap: "wrap" }}>
        <div style={{ minWidth: 0 }}>
          <h1 style={{ fontSize: 22, fontWeight: 700, letterSpacing: "-0.02em", margin: 0, color: "var(--text-primary)" }}>
            Agents
          </h1>
          <p style={{ fontSize: 13, color: "var(--text-muted)", margin: "5px 0 0", maxWidth: 620, lineHeight: 1.5 }}>
            Wing Digital&apos;s own internal agents. Client-delivery work lives under CRM.
          </p>
        </div>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 7, fontSize: 12, color: "var(--text-secondary)" }}>
            <Dot color={overallColor} pulse />
            {overallText}
            {attention > 0 && (
              <span style={{ color: "var(--orange)", fontFamily: MONO, fontSize: 11 }}>
                · {attention} need{attention === 1 ? "s" : ""} attention
              </span>
            )}
          </span>
          {data?.cloud && (
            <span style={{ fontSize: 10, color: "var(--accent-2)", border: "1px solid var(--accent-2)", borderRadius: 99, padding: "2px 9px", fontFamily: MONO }}>
              CLOUD MODE
            </span>
          )}
          {error && (
            <span style={{ fontSize: 10, color: "var(--red)", border: "1px solid var(--red)", borderRadius: 99, padding: "2px 9px", fontFamily: MONO }}>
              FEED ERROR {error}
            </span>
          )}
          <a href="/mission" target="_blank" rel="noreferrer" style={{
            fontSize: 12, color: "var(--accent)", textDecoration: "none",
            border: "1px solid var(--accent)", borderRadius: 99, padding: "5px 13px", fontWeight: 600,
          }}>
            Full Mission Control
          </a>
        </div>
      </header>

      {!data && !error && (
        <div style={{ color: "var(--text-muted)", fontFamily: MONO, fontSize: 12 }}>Establishing uplink…</div>
      )}

      {data && (
        <>
          {/* What fires in the next 24 hours, in order */}
          <NextUpStrip agents={internal} onSelect={setSelection} />

          {/* Ops map — first-class, always visible, but contained: a card with
              its own heading + legend and a bounded height so it never takes
              over the page. Same Wing-only agent list as the roster below. */}
          <section style={{
            background: "var(--bg-card)", border: "1px solid var(--border)",
            borderRadius: 14, overflow: "hidden",
          }}>
            <header style={{
              padding: "14px 18px 12px", display: "flex", alignItems: "baseline",
              gap: 10, flexWrap: "wrap",
            }}>
              <h2 style={{ fontSize: 12, fontWeight: 700, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--text-primary)", margin: 0 }}>
                Ops map
              </h2>
              <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                how the internal agents wire into systems and the files they produce
              </span>
              <span style={{ display: "flex", alignItems: "center", gap: 14, marginLeft: "auto", flexWrap: "wrap" }}>
                <LegendChip color="var(--accent)" label="Active" />
                <LegendChip color="var(--map-idle)" label="Idle" />
                <LegendChip color="var(--orange)" label="Trial" dashed />
                <LegendChip color="var(--red)" label="Flagged" />
              </span>
            </header>
            <div style={{ borderTop: "1px solid var(--border)", padding: 10 }}>
              <OpsMap agents={internal} volumes={data.volumes} watchdog={data.watchdog} onSelect={setSelection} />
            </div>
            <div style={{ padding: "0 18px 13px", fontSize: 11, color: "var(--text-muted)" }}>
              Hover a node to isolate its wiring · click anything to open its detail panel
            </div>
          </section>

          <div className="mission-ops-grid" style={{ display: "grid", gridTemplateColumns: "minmax(0, 2fr) minmax(280px, 1fr)", gap: 20, alignItems: "start" }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 20, minWidth: 0 }}>
              <RosterSection
                title="Scheduled"
                note="runs on a cron, unattended"
                empty="No scheduled internal agents."
                agents={scheduled}
                onSelect={setSelection}
              />

              <RosterSection
                title="On demand"
                note="you invoke these by name"
                empty="No on-demand agents."
                agents={crew}
                onSelect={setSelection}
              />
            </div>

            {/* Compact activity ticker */}
            <section style={{
              background: "var(--bg-card)", border: "1px solid var(--border)",
              borderRadius: 14, padding: "14px 16px",
            }}>
              <h2 style={{ fontSize: 12, fontWeight: 700, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--text-primary)", margin: "0 0 12px", display: "flex", alignItems: "center", gap: 8 }}>
                <Dot color="var(--green)" pulse /> Activity
                <span style={{ marginLeft: "auto", fontFamily: MONO, fontSize: 10, fontWeight: 400, color: "var(--text-muted)", letterSpacing: 0 }}>
                  refresh 30s
                </span>
              </h2>
              <div style={{ maxHeight: 560, overflowY: "auto", paddingRight: 6 }}>
                {/* 14 lines instead of 6: the ticker sat well short of the
                    roster beside it and left the bottom-right corner empty. */}
                <FeedTicker feed={data.feed} initial={14} />
              </div>
            </section>
          </div>

        </>
      )}

      <MissionPanels selection={selection} data={data} onSelect={setSelection} onRechecked={load} />
    </div>
  );
}
