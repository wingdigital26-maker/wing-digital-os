"use client";

// WING OS — MISSION CONTROL
// Read-only monitoring screen for every agent in the fleet. It shows, it never
// triggers. Polls /api/mission every 30s.

import { useEffect, useMemo, useState } from "react";

// ── types (mirror of /api/mission payload) ─────────────────────────────────
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
interface ClientHealth {
  client: string;
  phase: string;
  overall: "green" | "yellow" | "red";
  pillars: string[];
  redFlags: { text: string; link: string | null }[];
}
interface StatTile { label: string; value: string; sub: string | null }
interface MissionData {
  generatedAt: string;
  cloud: boolean;
  sources: Record<string, boolean>;
  overall: "green" | "yellow" | "red";
  agents: AgentCard[];
  feed: FeedEntry[];
  focus: {
    currentFocus: string[];
    openQuestions: string[];
    recentDecisions: string[];
    lastOperations: string[];
    updated: string | null;
  };
  health: { runDate: string | null; clients: ClientHealth[] };
  stats: { tiles: StatTile[]; updated: string | null };
}

const STATUS_COLOR: Record<string, string> = {
  green: "var(--green)",
  yellow: "var(--orange)",
  red: "var(--red)",
};

const TYPE_COLOR: Record<string, string> = {
  ingest: "var(--accent)",
  query: "var(--accent-2)",
  build: "var(--green)",
  security: "var(--red)",
  lint: "var(--orange)",
};

function typeColor(t: string): string {
  return TYPE_COLOR[t] ?? "var(--text-secondary)";
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

function fmtTime(d: Date): string {
  return d.toLocaleTimeString("en-US", { hour12: false });
}

// ── small components ───────────────────────────────────────────────────────
function Dot({ color, pulse }: { color: string; pulse?: boolean }) {
  return (
    <span
      className={pulse ? "mc-pulse" : undefined}
      style={{
        display: "inline-block",
        width: 9,
        height: 9,
        borderRadius: "50%",
        background: color,
        boxShadow: `0 0 8px ${color}`,
        flexShrink: 0,
      }}
    />
  );
}

function Pill({ text, color }: { text: string; color: string }) {
  return (
    <span
      style={{
        fontSize: 10,
        fontFamily: "'JetBrains Mono', monospace",
        letterSpacing: "0.08em",
        padding: "2px 8px",
        borderRadius: 99,
        border: `1px solid ${color}`,
        color,
        whiteSpace: "nowrap",
      }}
    >
      {text}
    </span>
  );
}

function AgentTile({ a }: { a: AgentCard }) {
  let pill = { text: "IDLE", color: "var(--text-muted)" };
  let pulse = false;
  if (!a.enabled) pill = { text: "DISABLED", color: "var(--text-muted)" };
  else if (a.pcNeeded && a.kind === "scheduled") pill = { text: "PC NEEDED", color: "var(--orange)" };
  else if (a.nextRunAt) { pill = { text: `NEXT ${fmtCountdown(a.nextRunAt)}`.toUpperCase(), color: "var(--accent)" }; pulse = true; }
  else if (a.lastLogDate) { pill = { text: "ACTIVE", color: "var(--green)" }; pulse = true; }

  return (
    <div
      style={{
        background: "var(--bg-card)",
        border: "1px solid var(--border)",
        borderRadius: 12,
        padding: "12px 14px",
        display: "flex",
        flexDirection: "column",
        gap: 6,
        opacity: a.enabled ? 1 : 0.55,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          <Dot color={a.enabled ? (pill.color === "var(--text-muted)" ? "var(--text-muted)" : pill.color) : "var(--text-muted)"} pulse={pulse} />
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
        <div
          style={{
            fontSize: 11,
            color: "var(--text-secondary)",
            fontFamily: "'JetBrains Mono', monospace",
            background: "var(--bg-secondary)",
            border: "1px solid var(--border)",
            borderRadius: 6,
            padding: "5px 8px",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
          title={a.lastLogLine}
        >
          <span style={{ color: "var(--text-muted)" }}>{a.lastLogDate} </span>
          {a.lastLogLine}
        </div>
      )}
    </div>
  );
}

// ── page ───────────────────────────────────────────────────────────────────
export default function MissionControl() {
  const [data, setData] = useState<MissionData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState<Date>(new Date());

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
    const clock = setInterval(() => setNow(new Date()), 1000);
    return () => { alive = false; clearInterval(poll); clearInterval(clock); };
  }, []);

  const overallColor = STATUS_COLOR[data?.overall ?? "green"];
  const scheduled = useMemo(() => data?.agents.filter((a) => a.kind === "scheduled") ?? [], [data]);
  const crew = useMemo(() => data?.agents.filter((a) => a.kind === "crew") ?? [], [data]);

  return (
    <div style={{ height: "100vh", overflowY: "auto", padding: "18px 22px 40px" }}>
      <style>{`
        .mc-pulse { animation: mcPulse 2s ease-in-out infinite; }
        @keyframes mcPulse { 0%,100% { opacity: 1; } 50% { opacity: 0.35; } }
        .mc-feed::-webkit-scrollbar { width: 6px; }
        .mc-feed::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
        .mc-tip { position: relative; }
        .mc-tip .mc-tipbox { display: none; }
        .mc-tip:hover .mc-tipbox { display: block; }
      `}</style>

      {/* Header */}
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 18, flexWrap: "wrap", gap: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <Dot color={overallColor} pulse />
          <h1 style={{ fontSize: 22, letterSpacing: "0.14em", fontWeight: 700 }}>
            WING OS <span style={{ color: "var(--accent)" }}>MISSION CONTROL</span>
          </h1>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          {data?.cloud && <Pill text="CLOUD MODE" color="var(--accent-2)" />}
          {error && <Pill text={`FEED ERROR ${error}`} color="var(--red)" />}
          <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 18, color: "var(--accent)", letterSpacing: "0.1em" }}>
            {fmtTime(now)}
          </span>
        </div>
      </header>

      {!data && !error && (
        <div style={{ color: "var(--text-muted)", fontFamily: "'JetBrains Mono', monospace" }}>Establishing uplink...</div>
      )}

      {data && (
        <>
          {/* Stats row */}
          {data.stats.tiles.length > 0 && (
            <div style={{ display: "grid", gridTemplateColumns: `repeat(auto-fit, minmax(150px, 1fr))`, gap: 12, marginBottom: 16 }}>
              {data.stats.tiles.map((t) => (
                <div key={t.label} style={{ background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 12, padding: "12px 16px" }}>
                  <div style={{ fontSize: 10, letterSpacing: "0.12em", color: "var(--text-muted)", textTransform: "uppercase" }}>{t.label}</div>
                  <div style={{ fontSize: 26, fontWeight: 700, color: "var(--text-primary)", fontFamily: "'Space Grotesk', sans-serif" }}>{t.value}</div>
                  {t.sub && <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>{t.sub}</div>}
                </div>
              ))}
              {data.stats.updated && (
                <div style={{ alignSelf: "end", fontSize: 10, color: "var(--text-muted)", fontFamily: "'JetBrains Mono', monospace", padding: 4 }}>
                  snapshot {data.stats.updated}
                </div>
              )}
            </div>
          )}

          {/* Client health strip */}
          <div style={{ display: "flex", alignItems: "center", gap: 14, background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 12, padding: "10px 16px", marginBottom: 16, flexWrap: "wrap" }}>
            <span style={{ fontSize: 10, letterSpacing: "0.12em", color: "var(--text-muted)" }}>CLIENT HEALTH</span>
            {data.health.clients.length === 0 && (
              <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
                {data.sources.health ? "no clients on the board" : "health board unavailable"}
              </span>
            )}
            {data.health.clients.map((c) => (
              <div key={c.client} className="mc-tip" style={{ display: "flex", alignItems: "center", gap: 7 }}>
                <Dot color={STATUS_COLOR[c.overall]} pulse={c.overall !== "green"} />
                <span style={{ fontSize: 13 }}>{c.client}</span>
                <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{c.pillars.join(" ")}</span>
                <div
                  className="mc-tipbox"
                  style={{
                    position: "absolute",
                    top: "120%",
                    left: 0,
                    zIndex: 30,
                    width: 380,
                    maxWidth: "80vw",
                    background: "var(--bg-secondary)",
                    border: "1px solid var(--border)",
                    borderRadius: 10,
                    padding: 12,
                    boxShadow: "0 8px 30px rgba(0,0,0,0.5)",
                  }}
                >
                  <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 6 }}>
                    {c.phase} · board run {data.health.runDate ?? "?"}
                  </div>
                  {c.redFlags.length === 0 && <div style={{ fontSize: 12, color: "var(--green)" }}>No open flags</div>}
                  {c.redFlags.map((f, i) => (
                    <div key={i} style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 8, lineHeight: 1.4 }}>
                      <span style={{ color: "var(--red)" }}>&#9873; </span>
                      {f.text}
                      {f.link && (
                        <>
                          {" "}
                          <a href={f.link} target="_blank" rel="noreferrer" style={{ color: "var(--accent)" }}>
                            open &#8599;
                          </a>
                        </>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ))}
            {data.health.runDate && (
              <span style={{ marginLeft: "auto", fontSize: 10, color: "var(--text-muted)", fontFamily: "'JetBrains Mono', monospace" }}>
                sentinel run {data.health.runDate}
              </span>
            )}
          </div>

          {/* Main grid: agents + focus | feed */}
          <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.6fr) minmax(300px, 1fr)", gap: 16, alignItems: "start" }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>
              {/* Scheduled agents */}
              <section>
                <h2 style={{ fontSize: 11, letterSpacing: "0.14em", color: "var(--text-muted)", marginBottom: 8 }}>SCHEDULED AGENTS</h2>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))", gap: 10 }}>
                  {scheduled.map((a) => <AgentTile key={a.key} a={a} />)}
                </div>
              </section>

              {/* On-demand crew */}
              <section>
                <h2 style={{ fontSize: 11, letterSpacing: "0.14em", color: "var(--text-muted)", marginBottom: 8 }}>ON-DEMAND CREW</h2>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))", gap: 10 }}>
                  {crew.map((a) => <AgentTile key={a.key} a={a} />)}
                </div>
              </section>

              {/* Current focus */}
              <section style={{ background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 12, padding: 16 }}>
                <h2 style={{ fontSize: 11, letterSpacing: "0.14em", color: "var(--text-muted)", marginBottom: 10 }}>
                  CURRENT FOCUS {data.focus.updated ? <span style={{ color: "var(--text-muted)" }}>· {data.focus.updated}</span> : null}
                </h2>
                {!data.sources.hot && <div style={{ fontSize: 12, color: "var(--text-muted)" }}>hot.md unavailable</div>}
                <div style={{ fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.55, marginBottom: 12 }}>
                  {data.focus.currentFocus.slice(0, 6).map((l, i) => <p key={i} style={{ marginBottom: 4 }}>{l}</p>)}
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 14 }}>
                  <div>
                    <div style={{ fontSize: 10, letterSpacing: "0.1em", color: "var(--accent-2)", marginBottom: 6 }}>OPEN QUESTIONS</div>
                    {data.focus.openQuestions.slice(0, 6).map((q, i) => (
                      <div key={i} style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 4 }}>? {q}</div>
                    ))}
                  </div>
                  <div>
                    <div style={{ fontSize: 10, letterSpacing: "0.1em", color: "var(--green)", marginBottom: 6 }}>RECENT DECISIONS</div>
                    {data.focus.recentDecisions.slice(0, 6).map((q, i) => (
                      <div key={i} style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 4 }}>&#10003; {q}</div>
                    ))}
                  </div>
                </div>
              </section>
            </div>

            {/* Live activity feed */}
            <section
              style={{
                background: "var(--bg-secondary)",
                border: "1px solid var(--border)",
                borderRadius: 12,
                padding: "12px 0 12px 14px",
                position: "sticky",
                top: 0,
              }}
            >
              <h2 style={{ fontSize: 11, letterSpacing: "0.14em", color: "var(--text-muted)", marginBottom: 10, display: "flex", alignItems: "center", gap: 8 }}>
                <Dot color="var(--green)" pulse /> LIVE ACTIVITY
                <span style={{ marginLeft: "auto", marginRight: 14, fontFamily: "'JetBrains Mono', monospace", fontSize: 10 }}>
                  refresh 30s
                </span>
              </h2>
              <div className="mc-feed" style={{ maxHeight: "calc(100vh - 140px)", overflowY: "auto", paddingRight: 10 }}>
                {data.feed.length === 0 && <div style={{ fontSize: 12, color: "var(--text-muted)" }}>log.md unavailable</div>}
                {data.feed.map((e, i) => (
                  <div key={i} style={{ marginBottom: 12, fontFamily: "'JetBrains Mono', monospace" }}>
                    <div style={{ fontSize: 11, display: "flex", gap: 8, alignItems: "baseline" }}>
                      <span style={{ color: "var(--text-muted)" }}>{e.date}</span>
                      <span style={{ color: typeColor(e.type), textTransform: "uppercase", fontSize: 10, letterSpacing: "0.08em" }}>{e.type}</span>
                    </div>
                    <div style={{ fontSize: 12, color: "var(--text-primary)", margin: "2px 0" }}>{e.title}</div>
                    {e.lines.slice(0, 2).map((l, j) => (
                      <div key={j} style={{ fontSize: 11, color: "var(--text-muted)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                        {l}
                      </div>
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
