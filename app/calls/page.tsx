"use client";
import { useCallback, useEffect, useState } from "react";

// The Today screen: the first thing anyone sees when they open Outbound. Its
// only job is to answer "what do I do right now" with real numbers. Every
// empty section says what is missing rather than showing a zero that looks
// like a measurement.
//
// Page chrome (header, nav, sign-out, container) belongs to app/calls/layout.tsx.

type Lead = {
  id: string;
  company: string;
  contact_name: string | null;
  title: string | null;
  phone: string | null;
  city: string | null;
  state: string | null;
  vertical: string | null;
  score: number | null;
  signals: string | null;
  status: string;
  next_action_at: string | null;
  claimed_by_email: string | null;
  overdue?: boolean;
};

type Activity = {
  id: number;
  user_email: string | null;
  outcome: string;
  notes: string | null;
  created_at: string;
  company: string | null;
};

type Stats = {
  me: { email: string; role: string; isAdmin: boolean };
  dialable: number;
  excluded: number | null;
  funnel: Record<string, number>;
  next: Lead[];
  callbacks: Lead[];
  activity: Activity[];
  today: {
    since: string;
    calls: number;
    booked: number;
    people: { email: string; calls: number; booked: number }[];
  };
};

const STAGES: { key: string; label: string; tone: string }[] = [
  { key: "new", label: "Not called yet", tone: "#22d3ee" },
  { key: "contacted", label: "Spoken to", tone: "#38bdf8" },
  { key: "callback", label: "Call backs", tone: "#eab308" },
  { key: "booked", label: "Booked", tone: "#22c55e" },
  { key: "not_interested", label: "Not interested", tone: "#f97316" },
  { key: "bad_number", label: "Bad number", tone: "#a78bfa" },
  { key: "dnc", label: "Do not call", tone: "#ef4444" },
];

const OUTCOME_LABEL: Record<string, string> = {
  booked: "Booked a call",
  callback: "Call back later",
  contacted: "Spoke, no yes",
  no_answer: "No answer",
  not_interested: "Not interested",
  bad_number: "Bad number",
  dnc: "Do not call",
};
const OUTCOME_TONE: Record<string, string> = {
  booked: "#22c55e",
  callback: "#eab308",
  contacted: "#38bdf8",
  no_answer: "#94a3b8",
  not_interested: "#f97316",
  bad_number: "#a78bfa",
  dnc: "#ef4444",
};

function ago(iso: string) {
  const ms = Date.now() - Date.parse(iso);
  const m = Math.round(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return new Date(iso).toLocaleDateString();
}

function due(iso: string) {
  const ms = Date.parse(iso) - Date.now();
  const m = Math.round(Math.abs(ms) / 60000);
  const s = m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
  return ms < 0 ? `${s} overdue` : `due in ${s}`;
}

export default function TodayDashboard() {
  const [d, setD] = useState<Stats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/calls/stats", { cache: "no-store" });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) {
        setError(body.error ?? `Could not load the dashboard (HTTP ${r.status})`);
        setD(null);
      } else {
        setD(body as Stats);
        setError(null);
      }
    } catch {
      setError("Could not reach the server.");
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, [load]);

  if (loading) return <p style={muted}>Loading today…</p>;

  if (error) {
    return (
      <div style={{ ...card, borderColor: "rgba(239,68,68,0.4)", background: "rgba(239,68,68,0.10)" }}>
        <p style={{ fontSize: 15, fontWeight: 700, color: "#f87171" }}>Dashboard unavailable</p>
        <p style={{ fontSize: 13, marginTop: 6, color: "var(--text-muted)", lineHeight: 1.5 }}>{error}</p>
      </div>
    );
  }
  if (!d) return null;

  const totalDial = d.dialable;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
      <div>
        <h1 style={{ fontSize: 24, fontWeight: 800, letterSpacing: -0.5 }}>Today</h1>
        <p style={{ ...muted, marginTop: 4 }}>
          {totalDial} dialable {totalDial === 1 ? "lead" : "leads"} in the room
          {d.excluded !== null && d.excluded > 0
            ? ` · ${d.excluded} more failed the quality audit and are held back`
            : ""}
        </p>
      </div>

      {/* today's numbers */}
      <section>
        <h2 style={h2}>Today&rsquo;s numbers</h2>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(170px,1fr))", gap: 10 }}>
          <div style={card}>
            <p style={statNum}>{d.today.calls}</p>
            <p style={statLabel}>calls logged today</p>
          </div>
          <div style={card}>
            <p style={{ ...statNum, color: d.today.booked > 0 ? "#4ade80" : "var(--text-primary)" }}>
              {d.today.booked}
            </p>
            <p style={statLabel}>booked today</p>
          </div>
        </div>
        {d.today.calls === 0 ? (
          <p style={{ ...muted, marginTop: 10 }}>
            Nobody has logged a call today. The first dial of the day is on the list below.
          </p>
        ) : d.today.people.length > 1 ? (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}>
            {d.today.people.map((p) => (
              <span key={p.email} style={{ ...pillSoft }}>
                {p.email} — {p.calls} {p.calls === 1 ? "call" : "calls"}
                {p.booked > 0 ? `, ${p.booked} booked` : ""}
              </span>
            ))}
          </div>
        ) : null}
      </section>

      {/* funnel */}
      <section>
        <h2 style={h2}>Where the pipeline stands</h2>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(140px,1fr))", gap: 10 }}>
          {STAGES.map((s) => {
            const n = d.funnel[s.key] ?? 0;
            return (
              <div key={s.key} style={{ ...card, borderColor: n > 0 ? `${s.tone}55` : "var(--border)" }}>
                <p style={{ ...statNum, fontSize: 24, color: n > 0 ? s.tone : "var(--text-muted)" }}>{n}</p>
                <p style={statLabel}>{s.label}</p>
              </div>
            );
          })}
        </div>
        <p style={{ ...muted, marginTop: 8 }}>
          Counted across the {totalDial} leads that passed the quality audit. Excluded leads are
          never counted here.
        </p>
      </section>

      {/* callbacks due */}
      <section>
        <div style={sectionHead}>
          <h2 style={{ ...h2, marginBottom: 0 }}>Owed a call back right now</h2>
          <a href="/calls/callbacks" style={btnGhost}>All callbacks</a>
        </div>
        {d.callbacks.length === 0 ? (
          <div style={{ ...card, color: "var(--text-muted)", fontSize: 13 }}>
            No callback is due yet. Anything scheduled for later shows up here when its time
            arrives.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {d.callbacks.map((l) => (
              <div
                key={l.id}
                style={{
                  ...card,
                  display: "flex",
                  gap: 12,
                  alignItems: "center",
                  flexWrap: "wrap",
                  borderColor: l.overdue ? "rgba(239,68,68,0.55)" : "rgba(234,179,8,0.45)",
                  background: l.overdue ? "rgba(239,68,68,0.08)" : "var(--bg-card)",
                }}
              >
                <div style={{ flex: "1 1 240px", minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <span style={{ fontSize: 15, fontWeight: 700 }}>{l.company}</span>
                    <span
                      style={{
                        ...pill,
                        borderColor: l.overdue ? "#ef4444" : "#eab308",
                        color: l.overdue ? "#f87171" : "#eab308",
                      }}
                    >
                      {l.next_action_at ? due(l.next_action_at) : "due"}
                    </span>
                  </div>
                  <p style={{ ...muted, marginTop: 4 }}>
                    {[l.contact_name, l.title, l.city].filter(Boolean).join(" · ") || "No named contact"}
                  </p>
                </div>
                {l.phone && (
                  <a href={`tel:${l.phone.replace(/[^+\d]/g, "")}`} style={btnPrimary}>
                    Call {l.phone}
                  </a>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* do these next */}
      <section>
        <div style={sectionHead}>
          <h2 style={{ ...h2, marginBottom: 0 }}>Do these next</h2>
          <a href="/calls/list" style={btnGhost}>Open the dial list</a>
        </div>
        {d.next.length === 0 ? (
          <div style={{ ...card, color: "var(--text-muted)", fontSize: 13 }}>
            Every dialable lead has been called at least once. Nothing is waiting for a first
            attempt — work the callbacks, or load more leads.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {d.next.map((l) => (
              <div key={l.id} style={{ ...card, display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
                <div
                  style={{
                    width: 42, height: 42, borderRadius: 11, flexShrink: 0,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    background: "var(--bg-hover)", border: "1px solid var(--border)",
                    fontSize: 14, fontWeight: 800,
                    color: (l.score ?? 0) >= 65 ? "#4ade80" : "var(--text-muted)",
                  }}
                >
                  {l.score ?? 0}
                </div>
                <div style={{ flex: "1 1 260px", minWidth: 0 }}>
                  <span style={{ fontSize: 15, fontWeight: 700 }}>{l.company}</span>
                  <p style={{ ...muted, marginTop: 4 }}>
                    {[l.contact_name, l.title, l.city, l.vertical].filter(Boolean).join(" · ") ||
                      "No named contact"}
                  </p>
                  {l.signals && (
                    <p style={{ fontSize: 12, color: "#7dd3fc", marginTop: 5, lineHeight: 1.45 }}>
                      {l.signals}
                    </p>
                  )}
                </div>
                {l.phone ? (
                  <a
                    href={`tel:${l.phone.replace(/[^+\d]/g, "")}`}
                    style={{ ...btnPrimary, fontVariantNumeric: "tabular-nums" }}
                  >
                    Call {l.phone}
                  </a>
                ) : (
                  <span style={{ ...btnGhost, opacity: 0.5 }}>no phone on file</span>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* recent activity */}
      <section>
        <h2 style={h2}>What the team just did</h2>
        {d.activity.length === 0 ? (
          <div style={{ ...card, color: "var(--text-muted)", fontSize: 13 }}>
            No calls have been logged yet — this fills in the moment someone dispositions a lead.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {d.activity.map((a) => (
              <div key={a.id} style={{ ...card, padding: "11px 14px" }}>
                <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
                  <span style={{ fontSize: 13.5, fontWeight: 700 }}>
                    {a.company ?? "a lead no longer in the room"}
                  </span>
                  <span
                    style={{
                      ...pill,
                      borderColor: OUTCOME_TONE[a.outcome] ?? "#64748b",
                      color: OUTCOME_TONE[a.outcome] ?? "#94a3b8",
                    }}
                  >
                    {OUTCOME_LABEL[a.outcome] ?? a.outcome}
                  </span>
                  <span style={{ ...muted, marginLeft: "auto" }}>
                    {a.user_email ?? "unknown caller"} · {ago(a.created_at)}
                  </span>
                </div>
                {a.notes && (
                  <p style={{ fontSize: 12.5, marginTop: 5, lineHeight: 1.45, color: "var(--text-muted)" }}>
                    {a.notes}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

const card: React.CSSProperties = {
  background: "var(--bg-card)",
  border: "1px solid var(--border)",
  borderRadius: 14,
  padding: "14px 16px",
};
const muted: React.CSSProperties = { fontSize: 12.5, color: "var(--text-muted)" };
const h2: React.CSSProperties = {
  fontSize: 11,
  textTransform: "uppercase",
  letterSpacing: 0.7,
  color: "var(--text-muted)",
  fontWeight: 700,
  marginBottom: 10,
};
const sectionHead: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 10,
  marginBottom: 10,
  flexWrap: "wrap",
};
const statNum: React.CSSProperties = {
  fontSize: 30,
  fontWeight: 800,
  letterSpacing: -1,
  lineHeight: 1.1,
};
const statLabel: React.CSSProperties = {
  fontSize: 12,
  color: "var(--text-muted)",
  marginTop: 3,
};
const pill: React.CSSProperties = {
  padding: "2px 8px",
  borderRadius: 999,
  border: "1px solid",
  fontSize: 10.5,
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: 0.4,
};
const pillSoft: React.CSSProperties = {
  padding: "6px 11px",
  borderRadius: 999,
  border: "1px solid var(--border)",
  background: "var(--bg-hover)",
  fontSize: 12,
  color: "var(--text-primary)",
};
const btnPrimary: React.CSSProperties = {
  padding: "9px 16px",
  borderRadius: 10,
  border: "none",
  background: "linear-gradient(135deg,#22d3ee,#0e7490)",
  color: "#fff",
  fontSize: 13,
  fontWeight: 700,
  cursor: "pointer",
  textDecoration: "none",
};
const btnGhost: React.CSSProperties = {
  padding: "8px 14px",
  borderRadius: 10,
  border: "1px solid var(--border)",
  background: "var(--bg-hover)",
  color: "var(--text-primary)",
  fontSize: 12.5,
  fontWeight: 600,
  cursor: "pointer",
  textDecoration: "none",
};
