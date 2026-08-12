"use client";

// MISSION OPS — embedded mission-control view for the main OS Agents section.
// Interactive: click any agent node/tile, system node, or feed line and a
// slide-over panel shows everything going on with it. Shared pieces live in
// MissionControlCore.tsx (also used by /mission). Reuses /api/mission.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  MissionData, Selection, Dot, MissionStyles, OpsMap, AgentTile, FeedTicker,
  MissionPanels, NextUpStrip, WatchdogBanner,
} from "./MissionControlCore";

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

  const scheduled = useMemo(() => data?.agents.filter(a => a.kind === "scheduled") ?? [], [data]);
  const crew = useMemo(() => data?.agents.filter(a => a.kind === "crew") ?? [], [data]);
  const overallColor = data?.overall === "red" ? "#f87171" : data?.overall === "yellow" ? "#fb923c" : "#34d399";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <MissionStyles />

      {/* Watchdog problems banner — always the very first thing on screen */}
      {data && <WatchdogBanner watchdog={data.watchdog} onRechecked={load} />}

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
          {/* HERO: the ops map is the primary presented thing — full width and
              tall, filling the viewport so the moving parts are legible. The
              scheduled/on-demand lists, next-up strip, and activity live below. */}
          <OpsMap agents={data.agents} volumes={data.volumes} watchdog={data.watchdog} onSelect={setSelection} hero />

          {/* What fires in the next 24 hours, in order (secondary, below the map) */}
          <NextUpStrip agents={data.agents} onSelect={setSelection} />

          <div className="mission-ops-grid" style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.6fr) minmax(280px, 1fr)", gap: 20, alignItems: "start" }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 20, minWidth: 0 }}>
              <section>
                <h2 style={{ fontSize: 11, letterSpacing: "0.14em", color: "var(--text-muted)", marginBottom: 8 }}>SCHEDULED AGENTS</h2>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 10 }}>
                  {scheduled.map(a => <AgentTile key={a.key} a={a} onSelect={setSelection} />)}
                </div>
              </section>
              <section>
                <h2 style={{ fontSize: 11, letterSpacing: "0.14em", color: "var(--text-muted)", marginBottom: 8 }}>ON-DEMAND CREW</h2>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 10 }}>
                  {crew.map(a => <AgentTile key={a.key} a={a} onSelect={setSelection} />)}
                </div>
              </section>
            </div>

            {/* Compact activity ticker; "view all" expands to the full feed */}
            <section style={{
              background: "var(--bg-secondary, #0d1117)",
              border: "1px solid var(--border, rgba(255,255,255,0.06))",
              borderRadius: 12, padding: "12px 14px",
            }}>
              <h2 style={{ fontSize: 11, letterSpacing: "0.14em", color: "var(--text-muted)", marginBottom: 10, display: "flex", alignItems: "center", gap: 8 }}>
                <Dot color="#34d399" pulse /> ACTIVITY
                <span style={{ marginLeft: "auto", fontFamily: "'JetBrains Mono', monospace", fontSize: 10 }}>refresh 30s</span>
              </h2>
              <div style={{ maxHeight: 520, overflowY: "auto", paddingRight: 6 }}>
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
