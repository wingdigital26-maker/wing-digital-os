"use client";
import { useCallback, useEffect, useMemo, useState } from "react";

type Lead = {
  id: string;
  company: string;
  contact_name: string | null;
  title: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  linkedin: string | null;
  city: string | null;
  vertical: string | null;
  employees: number | null;
  revenue: number | null;
  score: number | null;
  signals: string | null;
  status: string;
  claim: "free" | "mine" | "taken";
  claimed_by_email: string | null;
  last_outcome: string | null;
  last_called_at: string | null;
  call_count: number;
  next_action_at: string | null;
  excluded: boolean | null;
  excluded_reason: string | null;
  assigned_to_email: string | null;
};

// "maddox@wingdigital.co" -> "Maddox's sheet". Names come from the data, never
// a hardcoded list.
const sheetLabel = (email: string) => {
  const n = email.split("@")[0] || email;
  return `${n.charAt(0).toUpperCase()}${n.slice(1)}'s sheet`;
};

type Activity = {
  id: number;
  user_email: string | null;
  outcome: string;
  notes: string | null;
  created_at: string;
};

const OUTCOMES: { key: string; label: string; tone: string }[] = [
  { key: "booked", label: "Booked a call", tone: "#22c55e" },
  { key: "callback", label: "Call back later", tone: "#eab308" },
  { key: "contacted", label: "Spoke, no yes", tone: "#38bdf8" },
  { key: "no_answer", label: "No answer", tone: "#94a3b8" },
  { key: "not_interested", label: "Not interested", tone: "#f97316" },
  { key: "bad_number", label: "Bad number", tone: "#a78bfa" },
  { key: "dnc", label: "Do not call", tone: "#ef4444" },
];

const FILTERS = [
  { key: "new", label: "Not called yet" },
  { key: "callback", label: "Call backs" },
  { key: "contacted", label: "Spoken to" },
  { key: "booked", label: "Booked" },
  { key: "all", label: "Everything" },
];

const statusColor = (s: string) =>
  OUTCOMES.find((o) => o.key === s)?.tone ?? "#64748b";

export default function CallRoom() {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [me, setMe] = useState<{ email: string; role: string; isAdmin: boolean } | null>(null);
  const [filter, setFilter] = useState("new");
  const [assigned, setAssigned] = useState("all");
  const [assignedEmails, setAssignedEmails] = useState<string[]>([]);
  const [q, setQ] = useState("");
  const [active, setActive] = useState<Lead | null>(null);
  const [history, setHistory] = useState<Activity[]>([]);
  const [notes, setNotes] = useState("");
  const [callbackAt, setCallbackAt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const p = new URLSearchParams({ status: filter });
    if (assigned !== "all") p.set("assigned", assigned);
    if (q.trim()) p.set("q", q.trim());
    const r = await fetch(`/api/calls/leads?${p}`, { cache: "no-store" });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      setError(d.error ?? "Could not load leads");
      setLoading(false);
      return;
    }
    const d = await r.json();
    // Leads that failed the quality audit are filtered out server-side by
    // /api/calls/leads (it appends excluded=is.false unless ?includeExcluded=1),
    // so both the rows AND the counts here are already dialable-only. Nothing
    // to correct client-side.
    const rows: Lead[] = d.leads ?? [];
    setLeads(rows);
    setCounts(d.counts ?? {});
    setAssignedEmails(d.assignedEmails ?? []);
    setMe(d.me ?? null);
    setError(null);
    setLoading(false);
  }, [filter, assigned, q]);

  useEffect(() => {
    load();
  }, [load]);

  // Refresh while idle so a caller sees what teammates are claiming in near
  // real time. Paused while a lead is open so the list cannot shuffle mid-call.
  useEffect(() => {
    if (active) return;
    const t = setInterval(load, 20000);
    return () => clearInterval(t);
  }, [active, load]);

  async function openLead(lead: Lead) {
    setError(null);
    setNotes("");
    setCallbackAt("");
    setBusy(true);
    const r = await fetch("/api/calls/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ leadId: lead.id }),
    });
    setBusy(false);
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      setError(d.error ?? "Could not open that lead");
      load();
      return;
    }
    setActive(lead);
    // Shared-password sessions get no lock. Say so instead of implying a hold.
    if (d.locked === false && d.note) setError(d.note);
    const h = await fetch(`/api/calls/disposition?leadId=${lead.id}`, { cache: "no-store" });
    setHistory(h.ok ? (await h.json()).activity ?? [] : []);
  }

  async function closeLead(release = true) {
    if (active && release) {
      await fetch("/api/calls/claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ leadId: active.id, release: true }),
      });
    }
    setActive(null);
    setHistory([]);
    load();
  }

  async function disposition(outcome: string) {
    if (!active) return;
    setBusy(true);
    setError(null);
    const r = await fetch("/api/calls/disposition", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        leadId: active.id,
        outcome,
        notes: notes.trim() || undefined,
        nextActionAt: callbackAt ? new Date(callbackAt).toISOString() : undefined,
      }),
    });
    setBusy(false);
    const d = await r.json().catch(() => ({}));
    if (!r.ok && r.status !== 207) {
      setError(d.error ?? "Could not save that");
      return;
    }
    if (d.warning) setError(d.warning);
    setFlash(`${active.company}: ${OUTCOMES.find((o) => o.key === outcome)?.label ?? outcome}`);
    setTimeout(() => setFlash(null), 3500);
    setActive(null);
    setHistory([]);
    load();
  }

  const shown = useMemo(() => leads, [leads]);

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg-primary)", color: "var(--text-primary)" }}>
      <div style={{ maxWidth: 1180, margin: "0 auto", padding: "28px 20px 80px" }}>
        {/* header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
          <div>
            <h1 style={{ fontSize: 26, fontWeight: 800, letterSpacing: -0.5 }}>Cold Call Room</h1>
            <p style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 4 }}>
              {me ? `Signed in as ${me.email}` : "Shared leads. Claim one, dial it, log what happened."}
            </p>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            {me?.isAdmin && (
              <a href="/calls/team" style={btnGhost}>Manage callers</a>
            )}
            <a href="/api/logout" style={btnGhost}>Sign out</a>
          </div>
        </div>

        {flash && (
          <div style={{ ...banner, background: "rgba(34,197,94,0.12)", borderColor: "rgba(34,197,94,0.4)", color: "#4ade80" }}>
            Logged — {flash}
          </div>
        )}
        {error && (
          <div style={{ ...banner, background: "rgba(239,68,68,0.12)", borderColor: "rgba(239,68,68,0.4)", color: "#f87171" }}>
            {error}
          </div>
        )}

        {/* filters */}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 20, alignItems: "center" }}>
          {FILTERS.map((f) => {
            const on = filter === f.key;
            const n = f.key === "all" ? Object.values(counts).reduce((a, b) => a + b, 0) : counts[f.key] ?? 0;
            return (
              <button key={f.key} onClick={() => setFilter(f.key)} style={{
                ...chip,
                background: on ? "linear-gradient(135deg,#22d3ee,#0e7490)" : "var(--bg-card)",
                borderColor: on ? "transparent" : "var(--border)",
                color: on ? "#fff" : "var(--text-muted)",
                fontWeight: on ? 700 : 500,
              }}>
                {f.label} {n > 0 && <span style={{ opacity: 0.75 }}>{n}</span>}
              </button>
            );
          })}
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search company, contact, city"
            style={{
              marginLeft: "auto", minWidth: 220, background: "var(--bg-hover)",
              border: "1px solid var(--border)", borderRadius: 10, padding: "9px 12px",
              color: "var(--text-primary)", fontSize: 13, outline: "none",
            }}
          />
        </div>

        {/* assignment filter -- only shown once at least one lead carries an
            assigned sheet. A view narrower, never a wall: everyone can pick any pill. */}
        {assignedEmails.length > 0 && (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10, alignItems: "center" }}>
            <span style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.6, color: "var(--text-muted)", fontWeight: 700 }}>
              Sheet
            </span>
            {[
              { key: "all", label: "All" },
              ...assignedEmails.map((e) => ({ key: e, label: sheetLabel(e) })),
              { key: "unassigned", label: "Unassigned" },
            ].map((f) => {
              const on = assigned === f.key;
              return (
                <button key={f.key} onClick={() => setAssigned(f.key)} title={f.key !== "all" && f.key !== "unassigned" ? f.key : undefined} style={{
                  ...chip,
                  background: on ? "linear-gradient(135deg,#a78bfa,#6d28d9)" : "var(--bg-card)",
                  borderColor: on ? "transparent" : "var(--border)",
                  color: on ? "#fff" : "var(--text-muted)",
                  fontWeight: on ? 700 : 500,
                }}>
                  {f.label}
                </button>
              );
            })}
          </div>
        )}

        {/* list */}
        <div style={{ marginTop: 18, display: "flex", flexDirection: "column", gap: 10 }}>
          {loading && <p style={{ color: "var(--text-muted)", fontSize: 13 }}>Loading leads…</p>}
          {!loading && shown.length === 0 && (
            <div style={{ ...card, textAlign: "center", padding: 40, color: "var(--text-muted)" }}>
              <p style={{ fontSize: 15, fontWeight: 600 }}>Nothing here</p>
              <p style={{ fontSize: 13, marginTop: 6 }}>
                {filter === "new"
                  ? "Every lead in this list has been called. Try another filter."
                  : "No leads match this filter yet."}
              </p>
            </div>
          )}
          {shown.map((l) => (
            <div key={l.id} style={{ ...card, display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}>
              <div style={{
                width: 44, height: 44, borderRadius: 11, flexShrink: 0,
                display: "flex", alignItems: "center", justifyContent: "center",
                background: "var(--bg-hover)", border: "1px solid var(--border)",
                fontSize: 14, fontWeight: 800, color: (l.score ?? 0) >= 65 ? "#4ade80" : "var(--text-muted)",
              }}>{l.score ?? 0}</div>

              <div style={{ flex: "1 1 260px", minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 15, fontWeight: 700 }}>{l.company}</span>
                  <span style={{ ...pill, borderColor: statusColor(l.status), color: statusColor(l.status) }}>
                    {OUTCOMES.find((o) => o.key === l.status)?.label ?? "Not called yet"}
                  </span>
                  {l.claim === "taken" && (
                    <span style={{ ...pill, borderColor: "#f97316", color: "#f97316" }}>
                      on a call with {l.claimed_by_email ?? "someone"}
                    </span>
                  )}
                </div>
                <p style={{ fontSize: 12.5, color: "var(--text-muted)", marginTop: 4 }}>
                  {[l.contact_name, l.title, l.city, l.vertical, l.employees ? `${l.employees} emp` : null]
                    .filter(Boolean).join(" · ")}
                </p>
                {l.signals && (
                  <p style={{ fontSize: 12, color: "#7dd3fc", marginTop: 5, lineHeight: 1.45 }}>{l.signals}</p>
                )}
                {l.call_count > 0 && (
                  <p style={{ fontSize: 11.5, color: "var(--text-muted)", marginTop: 4 }}>
                    {l.call_count} previous {l.call_count === 1 ? "attempt" : "attempts"}
                    {l.last_called_at ? ` · last ${new Date(l.last_called_at).toLocaleDateString()}` : ""}
                  </p>
                )}
              </div>

              <div style={{ display: "flex", gap: 8, alignItems: "center", flexShrink: 0 }}>
                {l.phone ? (
                  <a href={`tel:${l.phone.replace(/[^+\d]/g, "")}`} style={{ ...btnGhost, fontVariantNumeric: "tabular-nums" }}>
                    {l.phone}
                  </a>
                ) : (
                  <span style={{ ...btnGhost, opacity: 0.5, cursor: "default" }}>no phone</span>
                )}
                <button
                  onClick={() => openLead(l)}
                  disabled={busy || l.claim === "taken"}
                  style={{
                    ...btnPrimary,
                    opacity: busy || l.claim === "taken" ? 0.45 : 1,
                    cursor: l.claim === "taken" ? "not-allowed" : "pointer",
                  }}
                >
                  {l.claim === "taken" ? "In use" : "Call"}
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* call panel */}
      {active && (
        <div
          onClick={(e) => e.target === e.currentTarget && closeLead()}
          style={{
            position: "fixed", inset: 0, background: "rgba(0,0,0,0.65)",
            display: "flex", alignItems: "flex-end", justifyContent: "center", zIndex: 50,
            backdropFilter: "blur(3px)",
          }}
        >
          <div style={{
            width: "min(680px, 100%)", maxHeight: "92vh", overflowY: "auto",
            background: "var(--bg-card)", border: "1px solid var(--border)",
            borderRadius: "20px 20px 0 0", padding: 24,
            boxShadow: "0 -20px 60px rgba(0,0,0,0.6)",
          }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
              <div>
                <h2 style={{ fontSize: 20, fontWeight: 800 }}>{active.company}</h2>
                <p style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 3 }}>
                  {[active.contact_name, active.title].filter(Boolean).join(" · ") || "No named contact"}
                </p>
              </div>
              <button onClick={() => closeLead()} style={btnGhost}>Close</button>
            </div>

            {active.signals && (
              <div style={{
                marginTop: 14, padding: 12, borderRadius: 10,
                background: "rgba(56,189,248,0.08)", border: "1px solid rgba(56,189,248,0.25)",
              }}>
                <p style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.6, color: "#7dd3fc", fontWeight: 700 }}>
                  Why they are worth calling
                </p>
                <p style={{ fontSize: 13, marginTop: 5, lineHeight: 1.5 }}>{active.signals}</p>
              </div>
            )}

            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 14 }}>
              {active.phone && (
                <a href={`tel:${active.phone.replace(/[^+\d]/g, "")}`} style={{ ...btnPrimary, textDecoration: "none" }}>
                  Call {active.phone}
                </a>
              )}
              {active.website && <a href={active.website} target="_blank" rel="noreferrer" style={btnGhost}>Website</a>}
              {active.linkedin && <a href={active.linkedin} target="_blank" rel="noreferrer" style={btnGhost}>LinkedIn</a>}
              {active.email && <a href={`mailto:${active.email}`} style={btnGhost}>{active.email}</a>}
            </div>

            {history.length > 0 && (
              <div style={{ marginTop: 18 }}>
                <p style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.6, color: "var(--text-muted)", fontWeight: 700 }}>
                  What already happened
                </p>
                <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 8 }}>
                  {history.map((h) => (
                    <div key={h.id} style={{ fontSize: 12.5, padding: 10, borderRadius: 8, background: "var(--bg-hover)" }}>
                      <span style={{ color: statusColor(h.outcome), fontWeight: 700 }}>
                        {OUTCOMES.find((o) => o.key === h.outcome)?.label ?? h.outcome}
                      </span>
                      <span style={{ color: "var(--text-muted)" }}>
                        {" "}· {h.user_email ?? "unknown"} · {new Date(h.created_at).toLocaleString()}
                      </span>
                      {h.notes && <p style={{ marginTop: 4, lineHeight: 1.45 }}>{h.notes}</p>}
                    </div>
                  ))}
                </div>
              </div>
            )}

            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="What did they say? (optional, but the next caller will thank you)"
              rows={3}
              style={{
                width: "100%", marginTop: 16, background: "var(--bg-hover)",
                border: "1px solid var(--border)", borderRadius: 10, padding: 12,
                color: "var(--text-primary)", fontSize: 13, outline: "none",
                resize: "vertical", fontFamily: "inherit",
              }}
            />

            <div style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <label style={{ fontSize: 12, color: "var(--text-muted)" }}>Call back on</label>
              <input
                type="datetime-local"
                value={callbackAt}
                onChange={(e) => setCallbackAt(e.target.value)}
                style={{
                  background: "var(--bg-hover)", border: "1px solid var(--border)",
                  borderRadius: 8, padding: "7px 10px", color: "var(--text-primary)", fontSize: 12.5,
                }}
              />
            </div>

            <p style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.6, color: "var(--text-muted)", fontWeight: 700, marginTop: 18 }}>
              How did it go?
            </p>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 8, marginTop: 8 }}>
              {OUTCOMES.map((o) => (
                <button
                  key={o.key}
                  disabled={busy}
                  onClick={() => disposition(o.key)}
                  style={{
                    padding: "11px 12px", borderRadius: 10, cursor: busy ? "wait" : "pointer",
                    border: `1px solid ${o.tone}55`, background: `${o.tone}18`,
                    color: o.tone, fontSize: 13, fontWeight: 700, opacity: busy ? 0.6 : 1,
                  }}
                >
                  {o.label}
                </button>
              ))}
            </div>
            <p style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 12, lineHeight: 1.5 }}>
              This lead is held for you for 20 minutes so nobody double-dials it. Logging an
              outcome releases it automatically.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

const card: React.CSSProperties = {
  background: "var(--bg-card)", border: "1px solid var(--border)",
  borderRadius: 14, padding: "14px 16px",
};
const chip: React.CSSProperties = {
  padding: "7px 13px", borderRadius: 999, border: "1px solid", fontSize: 12.5, cursor: "pointer",
};
const pill: React.CSSProperties = {
  padding: "2px 8px", borderRadius: 999, border: "1px solid", fontSize: 10.5, fontWeight: 700,
  textTransform: "uppercase", letterSpacing: 0.4,
};
const btnPrimary: React.CSSProperties = {
  padding: "9px 16px", borderRadius: 10, border: "none",
  background: "linear-gradient(135deg,#22d3ee,#0e7490)", color: "#fff",
  fontSize: 13, fontWeight: 700, cursor: "pointer",
};
const btnGhost: React.CSSProperties = {
  padding: "8px 14px", borderRadius: 10, border: "1px solid var(--border)",
  background: "var(--bg-hover)", color: "var(--text-primary)",
  fontSize: 12.5, fontWeight: 600, cursor: "pointer", textDecoration: "none",
};
const banner: React.CSSProperties = {
  marginTop: 14, padding: "11px 14px", borderRadius: 10,
  border: "1px solid", fontSize: 13, fontWeight: 600,
};
