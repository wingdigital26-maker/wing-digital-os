"use client";
import { useState, useEffect, useCallback } from "react";

// The 4 keeper agents. Six others (guardian, radar, tempest, hound, scribe,
// and a per-client outreach agent) were removed from the system — do not
// surface them here.
const AGENTS = [
  { id: "dispatch",   name: "Dispatch",   icon: "🌅", job: "Morning briefing + dial list", schedule: "Daily 6:30am" },
  { id: "prospector", name: "Prospector", icon: "🔭", job: "Lead scan + staged enrichment", schedule: "Sunday night" },
  { id: "outreach",   name: "Outreach",   icon: "✉️", job: "Cold email sender", schedule: "Every 15 min 8a–8p" },
  { id: "chronicler", name: "Chronicler", icon: "📖", job: "Hourly vault updater from chats", schedule: "Hourly" },
];
const KEEPERS = new Set(AGENTS.map(a => a.id));

const STATUS_COLOR: Record<string, string> = {
  "ok": "var(--green)",
  "needs-jack": "var(--orange)",
  "failed": "var(--red)",
  "never": "#6b7280",
};

export default function AgentBoard() {
  const [runs, setRuns] = useState<any[]>([]);
  const [queue, setQueue] = useState<any[]>([]);
  const [resolving, setResolving] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(() => {
    fetch("/api/agents/runs")
      .then(r => r.json())
      .then(d => {
        // only ever surface the 4 keeper agents; dead agents' history is ignored
        setRuns((d.runs ?? []).filter((r: any) => KEEPERS.has(r.agent)));
        setQueue((d.queue ?? []).filter((q: any) => KEEPERS.has(q.agent)));
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, [load]);

  async function resolve(id: string, resolution: string) {
    setResolving(id);
    await fetch("/api/agents/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, resolution }),
    });
    setResolving(null);
    load();
  }

  function lastRun(agentId: string) {
    return runs.find(r => r.agent === agentId);
  }

  function relTime(iso: string) {
    const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18, marginBottom: 28 }}>

      {/* Needs Jack queue */}
      {queue.length > 0 && (
        <div style={{
          background: "radial-gradient(ellipse 90% 60% at 50% -20%, rgba(251,191,36,0.12), transparent 60%), linear-gradient(180deg, var(--bg-card), var(--bg-card))",
          border: "1px solid rgba(251,191,36,0.4)", borderRadius: 16, padding: 18,
          boxShadow: "0 8px 24px var(--bg-hover), 0 0 24px rgba(251,191,36,0.06)",
        }}>
          <p style={{ fontSize: 13, fontWeight: 700, marginBottom: 12 }}>
            ⚠️ Needs Jack <span style={{ background: "rgba(251,191,36,0.2)", color: "var(--orange)", fontSize: 11, padding: "2px 10px", borderRadius: 999, marginLeft: 6 }}>{queue.length}</span>
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {queue.map(item => (
              <div key={item.id} style={{ background: "var(--bg-hover)", borderRadius: 10, padding: "12px 14px", borderLeft: "3px solid #fbbf24" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10, flexWrap: "wrap" }}>
                  <div style={{ flex: 1, minWidth: 200 }}>
                    <p style={{ fontSize: 13, fontWeight: 700 }}>
                      {AGENTS.find(a => a.id === item.agent)?.icon ?? "🤖"} {item.title}
                    </p>
                    <p style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 4, lineHeight: 1.5, whiteSpace: "pre-wrap" }}>{item.body}</p>
                    {item.action && <p style={{ fontSize: 11, color: "var(--orange)", marginTop: 4 }}>Approving = {item.action}</p>}
                  </div>
                  <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                    <button onClick={() => resolve(item.id, "approved")} disabled={resolving === item.id}
                      style={{ padding: "6px 16px", borderRadius: 999, fontSize: 11.5, fontWeight: 700, cursor: "pointer", border: "1px solid rgba(52,211,153,0.5)", background: "rgba(52,211,153,0.12)", color: "var(--green)" }}>
                      Approve ✓
                    </button>
                    <button onClick={() => resolve(item.id, "dismissed")} disabled={resolving === item.id}
                      style={{ padding: "6px 14px", borderRadius: 999, fontSize: 11.5, cursor: "pointer", border: "1px solid var(--border)", background: "transparent", color: "var(--text-muted)" }}>
                      Dismiss
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
          <p style={{ fontSize: 10.5, color: "var(--text-muted)", marginTop: 10 }}>
            Approving marks the item for the agent's next run (or tell Claude "the [agent] item is approved, execute it").
          </p>
        </div>
      )}

      {/* Agent cards */}
      <div>
        <p style={{ fontSize: 12, fontWeight: 700, color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 10 }}>
          Agent Workforce
        </p>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))", gap: 10 }}>
          {AGENTS.map(agent => {
            const run = lastRun(agent.id);
            const status = run?.status ?? "never";
            const color = STATUS_COLOR[status] ?? "#6b7280";
            const isOpen = expanded === agent.id;
            return (
              <div key={agent.id} onClick={() => setExpanded(isOpen ? null : agent.id)} style={{
                background: `radial-gradient(ellipse 90% 70% at 50% -25%, ${color}10, transparent 60%), linear-gradient(180deg, var(--bg-card), var(--bg-card))`,
                border: "1px solid var(--border)", borderRadius: 14, padding: "14px 16px",
                cursor: "pointer", boxShadow: "0 6px 20px rgba(0,0,0,0.2)",
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                  <span style={{ fontSize: 20 }}>{agent.icon}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p style={{ fontSize: 13.5, fontWeight: 700 }}>{agent.name}</p>
                    <p style={{ fontSize: 10.5, color: "var(--text-muted)" }}>{agent.schedule}</p>
                  </div>
                  <span style={{ width: 9, height: 9, borderRadius: "50%", background: color, boxShadow: `0 0 8px ${color}`, flexShrink: 0 }} />
                </div>
                <p style={{ fontSize: 11.5, color: "var(--text-secondary)", marginTop: 8, lineHeight: 1.4 }}>{agent.job}</p>
                <p style={{ fontSize: 11, color: run ? "var(--text-muted)" : "#6b7280", marginTop: 6 }}>
                  {run ? `Last run ${relTime(run.time)}: ${run.summary.slice(0, 60)}${run.summary.length > 60 ? "..." : ""}` : "Never run yet"}
                </p>
                {isOpen && run && (
                  <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--border)" }}>
                    <p style={{ fontSize: 11.5, color: "var(--text-secondary)", whiteSpace: "pre-wrap", lineHeight: 1.5 }}>{run.summary}</p>
                    {run.details && Object.entries(run.details).map(([k, v]: any) => (
                      <p key={k} style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 3 }}>{k}: {v}</p>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
