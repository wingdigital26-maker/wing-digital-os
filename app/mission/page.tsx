"use client";

// WING OS — MISSION CONTROL
// Read-only monitoring screen for every agent in the fleet. It shows, it never
// triggers. Polls /api/mission every 30s. Fully clickable: agents, systems,
// client health dots, and feed lines all open detail panels. Shared pieces
// live in app/components/MissionControlCore.tsx (also used by MissionOps).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  MissionData, Selection, Dot, Pill, MissionStyles, OpsMap, AgentTile,
  FeedTicker, ClientHealthStrip, MissionPanels, StatTiles, NextUpStrip,
  WatchdogBanner,
} from "../components/MissionControlCore";
import SfxMuteButton from "../components/SfxMuteButton";

const STATUS_COLOR: Record<string, string> = {
  green: "var(--green)",
  yellow: "var(--orange)",
  red: "var(--red)",
};

function fmtTime(d: Date): string {
  return d.toLocaleTimeString("en-US", { hour12: false });
}

export default function MissionControl() {
  const [data, setData] = useState<MissionData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState<Date>(new Date());
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
    const clock = setInterval(() => setNow(new Date()), 1000);
    return () => { aliveRef.current = false; clearInterval(poll); clearInterval(clock); };
  }, [load]);

  const overallColor = STATUS_COLOR[data?.overall ?? "green"];
  const scheduled = useMemo(() => data?.agents.filter((a) => a.kind === "scheduled") ?? [], [data]);
  const crew = useMemo(() => data?.agents.filter((a) => a.kind === "crew") ?? [], [data]);

  return (
    <div style={{ height: "100vh", overflowY: "auto", padding: "18px 22px 40px" }}>
      <MissionStyles />
      {/* Watchdog problems banner — always the very first thing on screen */}
      {data && (
        <div style={{ marginBottom: 14 }}>
          <WatchdogBanner watchdog={data.watchdog} onRechecked={load} />
        </div>
      )}
      <style>{`
        .mc-feed::-webkit-scrollbar { width: 6px; }
        .mc-feed::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
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
          <SfxMuteButton />
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
          {/* Stats row — every tile clicks through to its breakdown panel */}
          {data.stats.tiles.length > 0 && (
            <div style={{ marginBottom: 16 }}>
              <StatTiles tiles={data.stats.tiles} onSelect={setSelection} />
            </div>
          )}

          {/* What fires in the next 24 hours, in order */}
          <div style={{ marginBottom: 16 }}>
            <NextUpStrip agents={data.agents} onSelect={setSelection} />
          </div>

          {/* Client health strip — click a dot for the full pillar breakdown */}
          {data.health && (
            <div style={{ marginBottom: 16 }}>
              <ClientHealthStrip health={data.health} sourcesOk={!!data.sources.health} onSelect={setSelection} />
            </div>
          )}

          {/* Ops map — click agents and systems */}
          <div style={{ marginBottom: 16 }}>
            <OpsMap agents={data.agents} volumes={data.volumes} watchdog={data.watchdog} onSelect={setSelection} />
          </div>

          {/* Main grid: agents + focus | feed */}
          <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.6fr) minmax(300px, 1fr)", gap: 16, alignItems: "start" }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 20, minWidth: 0 }}>
              <section>
                <h2 style={{ fontSize: 11, letterSpacing: "0.14em", color: "var(--text-muted)", marginBottom: 8 }}>SCHEDULED AGENTS</h2>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 10 }}>
                  {scheduled.map((a) => <AgentTile key={a.key} a={a} onSelect={setSelection} />)}
                </div>
              </section>

              <section>
                <h2 style={{ fontSize: 11, letterSpacing: "0.14em", color: "var(--text-muted)", marginBottom: 8 }}>ON-DEMAND CREW</h2>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 10 }}>
                  {crew.map((a) => <AgentTile key={a.key} a={a} onSelect={setSelection} />)}
                </div>
              </section>

              {/* Current focus */}
              {data.focus && (
                <section style={{ background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 12, padding: 16 }}>
                  <h2 style={{ fontSize: 11, letterSpacing: "0.14em", color: "var(--text-muted)", marginBottom: 10 }}>
                    CURRENT FOCUS {data.focus.updated ? <span style={{ color: "var(--text-muted)" }}>· {data.focus.updated}</span> : null}
                  </h2>
                  {!data.sources.hot && <div style={{ fontSize: 12, color: "var(--text-muted)" }}>hot.md unavailable</div>}
                  <div style={{ fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.55, marginBottom: 12 }}>
                    {data.focus.currentFocus.slice(0, 3).map((l, i) => <p key={i} style={{ marginBottom: 4 }}>{l}</p>)}
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 14 }}>
                    <div>
                      <div style={{ fontSize: 10, letterSpacing: "0.1em", color: "var(--accent-2)", marginBottom: 6 }}>OPEN QUESTIONS</div>
                      {data.focus.openQuestions.slice(0, 3).map((q, i) => (
                        <div key={i} style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 4 }}>? {q}</div>
                      ))}
                    </div>
                    <div>
                      <div style={{ fontSize: 10, letterSpacing: "0.1em", color: "var(--green)", marginBottom: 6 }}>RECENT DECISIONS</div>
                      {data.focus.recentDecisions.slice(0, 3).map((q, i) => (
                        <div key={i} style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 4 }}>&#10003; {q}</div>
                      ))}
                    </div>
                  </div>
                </section>
              )}
            </div>

            {/* Live activity feed — click a line to expand the full entry */}
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
                <Dot color="var(--green)" pulse /> ACTIVITY
                <span style={{ marginLeft: "auto", marginRight: 14, fontFamily: "'JetBrains Mono', monospace", fontSize: 10 }}>
                  refresh 30s
                </span>
              </h2>
              <div className="mc-feed" style={{ maxHeight: "calc(100vh - 140px)", overflowY: "auto", paddingRight: 10 }}>
                <FeedTicker feed={data.feed} />
              </div>
            </section>
          </div>
        </>
      )}

      <MissionPanels selection={selection} data={data} onSelect={setSelection} onRechecked={load} />
    </div>
  );
}
