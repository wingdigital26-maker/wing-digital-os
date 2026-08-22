"use client";

// WHY AM I BEING NOTIFIED — shows every watchdog alert (the exact things that
// push to the phone) with its reason, when it started, and when it recovered.
// Fed by /api/alerts (watchdog_alerts + agent_heartbeats in Supabase).

import { useEffect, useState } from "react";

type AlertRow = {
  key: string;
  title: string;
  body: string | null;
  first_seen: string;
  last_seen: string;
  last_pushed: string | null;
  resolved_at: string | null;
};

function ago(iso: string | null): string {
  if (!iso) return "";
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 60) return `${m}m ago`;
  if (m < 48 * 60) return `${Math.round(m / 60)}h ago`;
  return `${Math.round(m / 1440)}d ago`;
}

export default function AlertsPanel() {
  const [alerts, setAlerts] = useState<AlertRow[] | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch("/api/alerts", { cache: "no-store" })
        .then((r) => r.json())
        .then((j) => { if (alive) setAlerts(j.alerts ?? []); })
        .catch(() => {});
    load();
    const t = setInterval(load, 60_000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  if (!alerts) return null;
  const open = alerts.filter((a) => !a.resolved_at);
  const recent = alerts.filter((a) => a.resolved_at).slice(0, 5);
  if (open.length === 0 && recent.length === 0) return null;

  return (
    <section style={{ background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 12, padding: 14, marginBottom: 16 }}>
      <h2 style={{ fontSize: 11, letterSpacing: "0.14em", color: "var(--text-muted)", marginBottom: 10 }}>
        NOTIFICATIONS — WHY
      </h2>
      {open.map((a) => (
        <div key={a.key} style={{ marginBottom: 10, paddingLeft: 10, borderLeft: "3px solid var(--red)" }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>🔴 {a.title}</div>
          {a.body && <div style={{ fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.5 }}>{a.body}</div>}
          <div style={{ fontSize: 10, color: "var(--text-muted)", fontFamily: "'JetBrains Mono', monospace" }}>
            since {ago(a.first_seen)}{a.last_pushed ? ` · pushed ${ago(a.last_pushed)}` : " · not pushed yet"}
          </div>
        </div>
      ))}
      {recent.map((a) => (
        <div key={a.key} style={{ marginBottom: 8, paddingLeft: 10, borderLeft: "3px solid var(--green)", opacity: 0.75 }}>
          <div style={{ fontSize: 12 }}>✅ {a.title} <span style={{ color: "var(--text-muted)" }}>— recovered {ago(a.resolved_at)}</span></div>
          {a.body && <div style={{ fontSize: 11, color: "var(--text-muted)", lineHeight: 1.4 }}>{a.body}</div>}
        </div>
      ))}
    </section>
  );
}
