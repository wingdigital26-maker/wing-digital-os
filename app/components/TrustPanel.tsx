"use client";
import { useEffect, useState } from "react";

const STATE_STYLE: Record<string, { c: string; label: string }> = {
  autonomous: { c: "var(--green)", label: "AUTONOMOUS" },
  supervised: { c: "var(--orange)", label: "SUPERVISED" },
  suspended: { c: "var(--red)", label: "SUSPENDED" },
};

export default function TrustPanel() {
  const [data, setData] = useState<any>(null);

  useEffect(() => {
    const load = () =>
      fetch("/api/agents/trust")
        .then(r => r.json())
        .then(setData)
        .catch(() => {});
    load();
    const id = setInterval(load, 5 * 60 * 1000);
    return () => clearInterval(id);
  }, []);

  if (!data) return (
    <div style={{
      background: "linear-gradient(180deg, var(--bg-card), rgba(12,15,26,0.85))",
      border: "1px solid var(--border)", borderRadius: 16, padding: 20, marginBottom: 18,
    }} aria-label="Loading trust data">
      <div className="skel" style={{ height: 12, width: 160, marginBottom: 16 }} />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 14, marginBottom: 16 }}>
        {[0, 1].map(i => <div key={i} className="skel" style={{ height: 26 }} />)}
      </div>
      {[0, 1, 2].map(i => <div key={i} className="skel" style={{ height: 18, marginBottom: 8 }} />)}
    </div>
  );
  const { tasks, budget } = data;
  const L = budget.limits;
  const costPct = Math.min(100, (budget.cost / L.max_cost_total) * 100);
  const runPct = Math.min(100, (budget.totalRuns / L.max_runs_total) * 100);

  return (
    <div style={{
      background: "linear-gradient(180deg, var(--bg-card), rgba(12,15,26,0.85))",
      border: "1px solid var(--border)", borderRadius: 16, padding: 20,
      boxShadow: "0 8px 24px rgba(0,0,0,0.25), inset 0 1px 0 rgba(255,255,255,0.04)",
      marginBottom: 18,
    }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10, marginBottom: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--accent-2)", boxShadow: "0 0 8px #a78bfa" }} />
          <p style={{ fontSize: 12, fontWeight: 700, color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.07em" }}>
            Trust &amp; Budget
          </p>
        </div>
        <p style={{ fontSize: 11, color: "var(--text-muted)" }}>
          agents earn autonomy: 20 runs at 95% · any fail demotes · 3 straight fails suspends
        </p>
      </div>

      {/* Budget bars */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 14, marginBottom: 16 }}>
        {[
          { label: `Est. cost today $${budget.cost.toFixed(2)} / $${L.max_cost_total.toFixed(0)}`, pct: costPct },
          { label: `Runs today ${budget.totalRuns} / ${L.max_runs_total}`, pct: runPct },
        ].map(b => (
          <div key={b.label}>
            <p style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 5 }}>{b.label}</p>
            <div style={{ height: 7, borderRadius: 99, background: "rgba(255,255,255,0.06)", overflow: "hidden" }}>
              <div style={{
                width: `${b.pct}%`, height: "100%", borderRadius: 99,
                background: b.pct > 85 ? "var(--red)" : b.pct > 60 ? "var(--orange)" : "var(--green)",
                transition: "width .3s",
              }} />
            </div>
          </div>
        ))}
      </div>

      {budget.denials.length > 0 && (
        <p style={{ fontSize: 11.5, color: "var(--red)", fontWeight: 600, marginBottom: 12 }}>
          ⚠ {budget.denials.length} budget denial{budget.denials.length > 1 ? "s" : ""} today — last: {budget.denials[budget.denials.length - 1].why}
        </p>
      )}

      {/* Trust table */}
      {tasks.length === 0 ? (
        <p style={{ fontSize: 12.5, color: "var(--text-muted)" }}>
          No tracked tasks yet — every agent task starts supervised and appears here after its first verified run.
        </p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column" }}>
          {tasks.map((t: any, i: number) => {
            const st = STATE_STYLE[t.state] ?? STATE_STYLE.supervised;
            return (
              <div key={`${t.agent}:${t.task}`} style={{
                display: "flex", alignItems: "center", gap: 12, padding: "8px 10px",
                borderRadius: 8, background: i % 2 ? "rgba(255,255,255,0.025)" : "transparent",
                flexWrap: "wrap",
              }}>
                <span style={{ fontSize: 13, fontWeight: 700, minWidth: 90 }}>{t.agent}</span>
                <span style={{ fontSize: 12, color: "var(--text-muted)", flex: 1, minWidth: 120 }}>{t.task}</span>
                <span style={{ fontSize: 11.5, color: "var(--text-muted)", whiteSpace: "nowrap" }}>
                  {t.runs} runs · {Math.round(t.passRate * 100)}% last {t.windowSize}
                </span>
                {t.consecFails > 0 && (
                  <span style={{ fontSize: 11, color: "var(--red)", fontWeight: 700 }}>{t.consecFails}✗</span>
                )}
                <span style={{
                  fontSize: 10, fontWeight: 800, letterSpacing: "0.05em", padding: "3px 10px",
                  borderRadius: 999, color: st.c, background: `${st.c}14`, border: `1px solid ${st.c}44`,
                  whiteSpace: "nowrap",
                }}>{st.label}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
