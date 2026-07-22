"use client";
import { useState, useEffect, useCallback } from "react";

// ───────────────────────────────────────────────────────────────────────────
// Agent Activity — Jack's window into his 4 real agents.
// Shows for each: whether it ran, when, what it produced, next expected run,
// a "Run now" button, and a clickable run-history list where each row opens the
// full run summary. Reads /api/agent-activity (real logs), triggers via
// /api/agents/run. The 6 deleted agents never appear here.
// ───────────────────────────────────────────────────────────────────────────

const ACCENT = "#10C0F0";

type RunDot = { ok: boolean; time: string; status: "ok" | "fail" | "skipped"; summary: string };
type Agent = {
  key: string;
  name: string;
  icon: string;
  description: string;
  cadence: string;
  lastRun: string | null;
  status: "ran today" | "ran this week" | "idle" | "never run";
  lastResult: string;
  nextExpected: string;
  nextExpectedAt: string | null;
  history: RunDot[];
};

const STATUS_PILL: Record<Agent["status"], { bg: string; fg: string; label: string }> = {
  "ran today": { bg: "rgba(52,211,153,0.14)", fg: "#34d399", label: "Ran today" },
  "ran this week": { bg: "rgba(96,165,250,0.14)", fg: "#60a5fa", label: "Ran this week" },
  idle: { bg: "rgba(251,191,36,0.14)", fg: "#fbbf24", label: "Idle" },
  "never run": { bg: "rgba(107,114,128,0.16)", fg: "#9ca3af", label: "Never run" },
};

const DOT_COLOR: Record<RunDot["status"], string> = {
  ok: "#34d399",
  fail: "#f87171",
  skipped: "#fbbf24",
};

// agents that support a safe --dry-run
const DRY_RUN_CAPABLE = new Set(["outreach", "chronicler"]);

function relTime(iso: string | null): string {
  if (!iso) return "never";
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function fmtStamp(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) + " " +
    d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

export default function AgentActivity() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState<{ agent: string; run: RunDot } | null>(null);

  const load = useCallback((silent = false) => {
    if (!silent) setLoading(true);
    fetch("/api/agent-activity")
      .then((r) => r.json())
      .then((d) => {
        const KEEPERS = new Set(["dispatch", "prospector", "outreach", "chronicler"]);
        setAgents((d.agents ?? []).filter((a: Agent) => KEEPERS.has(a.key)));
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(() => load(true), 30_000); // auto-refresh every 30s
    return () => clearInterval(id);
  }, [load]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
        <div>
          <p style={{ fontSize: 12, fontWeight: 700, color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.08em" }}>
            Agent Activity
          </p>
          <p style={{ fontSize: 11.5, color: "var(--text-muted)", marginTop: 3 }}>
            Your 4 agents — whether they ran, what they did, and their run history. Auto-refreshes every 30s.
          </p>
        </div>
        <button onClick={() => load()} style={{
          padding: "6px 14px", borderRadius: 999, fontSize: 12, cursor: "pointer",
          border: `1px solid ${ACCENT}44`, background: `${ACCENT}12`, color: ACCENT, fontWeight: 600,
        }}>
          ⟳ Refresh
        </button>
      </div>

      {loading && agents.length === 0 && (
        <p style={{ color: "var(--text-muted)", fontSize: 13, padding: 16 }}>Loading agent activity…</p>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(340px, 1fr))", gap: 14 }}>
        {agents.map((a) => (
          <AgentCard key={a.key} agent={a} onOpenRun={(run) => setModal({ agent: a.name, run })} onRan={() => load(true)} />
        ))}
      </div>

      {modal && <RunModal agentName={modal.agent} run={modal.run} onClose={() => setModal(null)} />}
    </div>
  );
}

function AgentCard({ agent, onOpenRun, onRan }: { agent: Agent; onOpenRun: (r: RunDot) => void; onRan: () => void }) {
  const [running, setRunning] = useState(false);
  const [output, setOutput] = useState<{ ok: boolean; text: string } | null>(null);
  const [dryRun, setDryRun] = useState(true);
  const [showHistory, setShowHistory] = useState(false);
  const pill = STATUS_PILL[agent.status];
  const canDry = DRY_RUN_CAPABLE.has(agent.key);

  async function runNow() {
    setRunning(true);
    setOutput(null);
    try {
      const res = await fetch("/api/agents/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent: agent.key, dryRun: canDry ? dryRun : false }),
      });
      const d = await res.json();
      const text = [d.command ? `$ ${d.command}` : "", d.stdout, d.stderr, d.note]
        .filter(Boolean)
        .join("\n")
        .trim();
      setOutput({ ok: d.ok === true, text: text || (d.error ?? "No output") });
    } catch (e: any) {
      setOutput({ ok: false, text: `Request failed: ${e?.message ?? e}` });
    }
    setRunning(false);
    onRan();
  }

  return (
    <div style={{
      background: `radial-gradient(ellipse 90% 60% at 50% -20%, ${ACCENT}0d, transparent 60%), linear-gradient(180deg, #0f1117, #0a0a0a)`,
      border: "1px solid rgba(255,255,255,0.08)", borderRadius: 16, padding: "16px 18px",
      boxShadow: "0 8px 24px rgba(0,0,0,0.3)", display: "flex", flexDirection: "column", gap: 12,
    }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "flex-start", gap: 11 }}>
        <span style={{ fontSize: 22, lineHeight: 1 }}>{agent.icon}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <p style={{ fontSize: 14.5, fontWeight: 700 }}>{agent.name}</p>
            <span style={{
              fontSize: 10, fontWeight: 700, padding: "2px 9px", borderRadius: 999,
              background: pill.bg, color: pill.fg,
            }}>{pill.label}</span>
          </div>
          <p style={{ fontSize: 11.5, color: "var(--text-secondary)", marginTop: 3, lineHeight: 1.4 }}>{agent.description}</p>
          <p style={{ fontSize: 10.5, color: "var(--text-muted)", marginTop: 3 }}>{agent.cadence}</p>
        </div>
      </div>

      {/* Last result + next expected */}
      <div style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 11.5 }}>
        <div>
          <span style={{ color: "var(--text-muted)" }}>Last run: </span>
          <span style={{ color: "var(--text-secondary)" }}>{relTime(agent.lastRun)}</span>
        </div>
        <div style={{ color: "var(--text-secondary)", lineHeight: 1.5 }}>
          <span style={{ color: "var(--text-muted)" }}>Result: </span>
          {agent.lastResult}
        </div>
        <div>
          <span style={{ color: "var(--text-muted)" }}>Next expected: </span>
          <span style={{ color: ACCENT, fontWeight: 600 }}>{agent.nextExpected}</span>
        </div>
      </div>

      {/* Run controls */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <button onClick={runNow} disabled={running} style={{
          padding: "7px 16px", borderRadius: 999, fontSize: 12, fontWeight: 700, cursor: running ? "default" : "pointer",
          border: `1px solid ${ACCENT}`, background: running ? "rgba(16,192,240,0.08)" : `${ACCENT}1e`, color: ACCENT,
          display: "flex", alignItems: "center", gap: 7,
        }}>
          {running ? <><Spinner /> Running…</> : "▶ Run now"}
        </button>
        {canDry && (
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, color: "var(--text-secondary)", cursor: "pointer" }}>
            <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} style={{ accentColor: ACCENT, cursor: "pointer" }} />
            Dry run (safe test)
          </label>
        )}
      </div>

      {/* Run output inline */}
      {output && (
        <div style={{
          background: "rgba(0,0,0,0.5)", border: `1px solid ${output.ok ? "rgba(52,211,153,0.3)" : "rgba(248,113,113,0.3)"}`,
          borderRadius: 10, padding: "10px 12px", fontSize: 11, fontFamily: "ui-monospace, monospace",
          color: "var(--text-secondary)", whiteSpace: "pre-wrap", maxHeight: 200, overflow: "auto",
        }}>
          <p style={{ color: output.ok ? "#34d399" : "#f87171", fontWeight: 700, marginBottom: 6 }}>
            {output.ok ? "✓ completed" : "✕ finished with errors"}
          </p>
          {output.text}
        </div>
      )}

      {/* Run history */}
      {agent.history.length > 0 && (
        <div>
          <button onClick={() => setShowHistory((s) => !s)} style={{
            background: "transparent", border: "none", color: "var(--text-muted)", cursor: "pointer",
            fontSize: 11, fontWeight: 600, padding: 0, display: "flex", alignItems: "center", gap: 6,
          }}>
            {showHistory ? "▾" : "▸"} Run history ({agent.history.length})
          </button>
          {showHistory && (
            <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 2 }}>
              {agent.history.map((run, i) => (
                <button key={i} onClick={() => onOpenRun(run)} title="Click to read the full run summary" style={{
                  display: "flex", alignItems: "center", gap: 10, padding: "7px 9px", borderRadius: 8,
                  background: "rgba(255,255,255,0.02)", border: "1px solid transparent", cursor: "pointer",
                  textAlign: "left", width: "100%",
                }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(16,192,240,0.08)")}
                  onMouseLeave={(e) => (e.currentTarget.style.background = "rgba(255,255,255,0.02)")}
                >
                  <span style={{ width: 8, height: 8, borderRadius: "50%", background: DOT_COLOR[run.status], boxShadow: `0 0 6px ${DOT_COLOR[run.status]}`, flexShrink: 0 }} />
                  <span style={{ fontSize: 10.5, color: "var(--text-muted)", width: 92, flexShrink: 0, fontFamily: "ui-monospace, monospace" }}>{fmtStamp(run.time)}</span>
                  <span style={{ fontSize: 11.5, color: "var(--text-secondary)", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {run.summary.split("\n")[0]}
                  </span>
                  <span style={{ fontSize: 12, color: "var(--text-muted)", flexShrink: 0 }}>›</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function RunModal({ agentName, run, onClose }: { agentName: string; run: RunDot; onClose: () => void }) {
  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.72)", zIndex: 300,
      display: "flex", alignItems: "center", justifyContent: "center", padding: 20,
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        background: "#0a0a0a", border: `1px solid ${ACCENT}55`, borderRadius: 16,
        width: 560, maxWidth: "100%", maxHeight: "80vh", display: "flex", flexDirection: "column",
        overflow: "hidden", boxShadow: `0 24px 64px rgba(0,0,0,0.6), 0 0 40px ${ACCENT}18`,
      }}>
        <div style={{ padding: "16px 20px", borderBottom: "1px solid rgba(255,255,255,0.08)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ width: 9, height: 9, borderRadius: "50%", background: DOT_COLOR[run.status], boxShadow: `0 0 8px ${DOT_COLOR[run.status]}` }} />
            <div>
              <p style={{ fontSize: 14, fontWeight: 700 }}>{agentName} run</p>
              <p style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>
                {fmtStamp(run.time)} · {run.status.toUpperCase()}
              </p>
            </div>
          </div>
          <button onClick={onClose} style={{
            background: "transparent", border: "1px solid rgba(255,255,255,0.12)", borderRadius: "50%",
            width: 28, height: 28, color: "var(--text-muted)", cursor: "pointer", fontSize: 14, lineHeight: 1,
          }}>×</button>
        </div>
        <div style={{ padding: "18px 20px", overflow: "auto" }}>
          <p style={{ fontSize: 10.5, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 10 }}>
            Full run summary
          </p>
          <p style={{ fontSize: 13, color: "var(--text-primary)", lineHeight: 1.6, whiteSpace: "pre-wrap" }}>
            {run.summary}
          </p>
        </div>
      </div>
    </div>
  );
}

function Spinner() {
  return (
    <span style={{
      width: 12, height: 12, borderRadius: "50%",
      border: `2px solid ${ACCENT}44`, borderTopColor: ACCENT,
      display: "inline-block", animation: "aaspin 0.7s linear infinite",
    }}>
      <style>{`@keyframes aaspin{to{transform:rotate(360deg)}}`}</style>
    </span>
  );
}
