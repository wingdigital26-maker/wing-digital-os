"use client";
import { useCallback, useEffect, useMemo, useState } from "react";

// The follow-up queue. Every lead sitting at status='callback', soonest first,
// bucketed by how urgent it is. A caller can work the queue right here: same
// claim -> dial -> log-outcome loop the dial list uses, so there is only one
// interaction pattern in the section.

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
  score: number | null;
  signals: string | null;
  status: string;
  claim: "free" | "mine" | "taken";
  claimed_by_email: string | null;
  last_outcome: string | null;
  last_called_at: string | null;
  call_count: number;
  next_action_at: string | null;
  excluded?: boolean | null;
  excluded_reason?: string | null;
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

const statusColor = (s: string) => OUTCOMES.find((o) => o.key === s)?.tone ?? "#64748b";

type BucketKey = "overdue" | "today" | "week" | "later" | "undated";

const BUCKETS: { key: BucketKey; label: string; tone: string; blurb: string }[] = [
  { key: "overdue", label: "Overdue", tone: "#ef4444", blurb: "The promised time has passed." },
  { key: "today", label: "Today", tone: "#eab308", blurb: "Due before the day is out." },
  { key: "week", label: "This week", tone: "#38bdf8", blurb: "Due in the next seven days." },
  { key: "later", label: "Later", tone: "#94a3b8", blurb: "Further out than a week." },
  { key: "undated", label: "No date set", tone: "#a78bfa", blurb: "Nobody said when to ring back." },
];

function bucketOf(iso: string | null, now: Date): BucketKey {
  if (!iso) return "undated";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "undated";
  if (t < now.getTime()) return "overdue";
  const endOfToday = new Date(now);
  endOfToday.setHours(23, 59, 59, 999);
  if (t <= endOfToday.getTime()) return "today";
  if (t <= endOfToday.getTime() + 6 * 86_400_000) return "week";
  return "later";
}

function dueLabel(iso: string | null, now: Date) {
  if (!iso) return "no callback time recorded";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "no callback time recorded";
  const when = new Date(t).toLocaleString(undefined, {
    weekday: "short", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit",
  });
  const diff = t - now.getTime();
  const mins = Math.round(Math.abs(diff) / 60000);
  const rel =
    mins < 60 ? `${mins} min` :
    mins < 1440 ? `${Math.round(mins / 60)} hr` :
    `${Math.round(mins / 1440)} day${Math.round(mins / 1440) === 1 ? "" : "s"}`;
  return diff < 0 ? `${when} · ${rel} late` : `${when} · in ${rel}`;
}

export default function Callbacks() {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [active, setActive] = useState<Lead | null>(null);
  const [history, setHistory] = useState<Activity[]>([]);
  const [notes, setNotes] = useState("");
  const [callbackAt, setCallbackAt] = useState("");
  // Last note per lead, so a caller has context without opening the row.
  const [context, setContext] = useState<Record<string, Activity | null>>({});
  const [now, setNow] = useState(() => new Date());

  const load = useCallback(async () => {
    const r = await fetch("/api/calls/leads?status=callback", { cache: "no-store" });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      setError(d.error ?? "Could not load callbacks");
      setLoading(false);
      return;
    }
    const d = await r.json();
    // Leads that failed the quality audit are not callable, so they are not
    // part of the queue either.
    const rows: Lead[] = (d.leads ?? []).filter((l: Lead) => !l.excluded);
    setLeads(rows);
    setError(null);
    setLoading(false);

    // Pull the most recent activity row per callback for at-a-glance context.
    const found = await Promise.all(
      rows.map(async (l) => {
        const h = await fetch(`/api/calls/disposition?leadId=${l.id}`, { cache: "no-store" });
        if (!h.ok) return [l.id, null] as const;
        const act: Activity[] = (await h.json()).activity ?? [];
        const latest = act
          .slice()
          .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0] ?? null;
        return [l.id, latest] as const;
      })
    );
    setContext(Object.fromEntries(found));
  }, []);

  useEffect(() => { load(); }, [load]);

  // Keep the overdue/today split truthful without a reload.
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(t);
  }, []);

  const grouped = useMemo(() => {
    const sorted = leads.slice().sort((a, b) => {
      if (!a.next_action_at && !b.next_action_at) return a.company.localeCompare(b.company);
      if (!a.next_action_at) return 1;
      if (!b.next_action_at) return -1;
      return Date.parse(a.next_action_at) - Date.parse(b.next_action_at);
    });
    const out: Record<BucketKey, Lead[]> = {
      overdue: [], today: [], week: [], later: [], undated: [],
    };
    for (const l of sorted) out[bucketOf(l.next_action_at, now)].push(l);
    return out;
  }, [leads, now]);

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

  const overdue = grouped.overdue.length;

  return (
    <>
      <div>
        <h1 style={{ fontSize: 26, fontWeight: 800, letterSpacing: -0.5 }}>Callbacks</h1>
        <p style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 4 }}>
          {loading
            ? "Loading the follow-up queue…"
            : leads.length === 0
              ? "Nobody is waiting on a call back."
              : `${leads.length} waiting${overdue > 0 ? ` · ${overdue} overdue` : ""}`}
        </p>
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

      {!loading && leads.length === 0 && !error && (
        <div style={{ ...card, textAlign: "center", padding: 40, color: "var(--text-muted)", marginTop: 18 }}>
          <p style={{ fontSize: 15, fontWeight: 600 }}>No callbacks scheduled yet</p>
          <p style={{ fontSize: 13, marginTop: 6, lineHeight: 1.5 }}>
            When someone logs “Call back later” on the dial list, the lead lands here with the
            time it was promised for.
          </p>
        </div>
      )}

      {BUCKETS.map((b) => {
        const rows = grouped[b.key];
        if (rows.length === 0) return null;
        const loud = b.key === "overdue";
        return (
          <section key={b.key} style={{ marginTop: 24 }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
              <h2 style={{ fontSize: 15, fontWeight: 800, color: loud ? "#f87171" : "var(--text-primary)" }}>
                {b.label}
              </h2>
              <span style={{ ...pill, borderColor: b.tone, color: b.tone }}>{rows.length}</span>
              <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{b.blurb}</span>
            </div>

            <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 10 }}>
              {rows.map((l) => {
                const last = context[l.id];
                return (
                  <div
                    key={l.id}
                    style={{
                      ...card,
                      display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap",
                      borderColor: loud ? "rgba(239,68,68,0.55)" : "var(--border)",
                      background: loud ? "rgba(239,68,68,0.07)" : "var(--bg-card)",
                      borderLeft: `4px solid ${b.tone}`,
                    }}
                  >
                    <div style={{ flex: "1 1 280px", minWidth: 0 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                        <span style={{ fontSize: 15, fontWeight: 700 }}>{l.company}</span>
                        <span style={{
                          ...pill,
                          borderColor: b.tone, color: loud ? "#fff" : b.tone,
                          background: loud ? "#ef4444" : "transparent",
                        }}>
                          {loud ? "Overdue" : b.label}
                        </span>
                        {l.claim === "taken" && (
                          <span style={{ ...pill, borderColor: "#f97316", color: "#f97316" }}>
                            on a call with {l.claimed_by_email ?? "someone"}
                          </span>
                        )}
                      </div>

                      <p style={{ fontSize: 12.5, color: "var(--text-muted)", marginTop: 4 }}>
                        {[l.contact_name, l.title, l.city].filter(Boolean).join(" · ") || "No named contact"}
                      </p>

                      <p style={{
                        fontSize: 12.5, marginTop: 5, fontWeight: 700,
                        color: loud ? "#f87171" : b.tone,
                      }}>
                        {dueLabel(l.next_action_at, now)}
                      </p>

                      {last ? (
                        <div style={{
                          marginTop: 8, padding: 10, borderRadius: 9,
                          background: "var(--bg-hover)", border: "1px solid var(--border)",
                        }}>
                          <p style={{ fontSize: 11.5, color: "var(--text-muted)" }}>
                            Set by {last.user_email ?? "unknown"} ·{" "}
                            {new Date(last.created_at).toLocaleString()}
                          </p>
                          {last.notes ? (
                            <p style={{ fontSize: 12.5, marginTop: 4, lineHeight: 1.45 }}>{last.notes}</p>
                          ) : (
                            <p style={{ fontSize: 12.5, marginTop: 4, color: "var(--text-muted)", fontStyle: "italic" }}>
                              No notes were left on that call.
                            </p>
                          )}
                        </div>
                      ) : (
                        <p style={{ fontSize: 11.5, color: "var(--text-muted)", marginTop: 6 }}>
                          No call history recorded for this lead.
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
                );
              })}
            </div>
          </section>
        );
      })}

      {/* call panel — same loop as the dial list */}
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
                <p style={{ fontSize: 12.5, color: "#eab308", marginTop: 4, fontWeight: 700 }}>
                  Call back {dueLabel(active.next_action_at, now)}
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
              placeholder="What did they say this time? (optional, but the next caller will thank you)"
              rows={3}
              style={{
                width: "100%", marginTop: 16, background: "var(--bg-hover)",
                border: "1px solid var(--border)", borderRadius: 10, padding: 12,
                color: "var(--text-primary)", fontSize: 13, outline: "none",
                resize: "vertical", fontFamily: "inherit",
              }}
            />

            <div style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <label style={{ fontSize: 12, color: "var(--text-muted)" }}>Move the call back to</label>
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
    </>
  );
}

const card: React.CSSProperties = {
  background: "var(--bg-card)", border: "1px solid var(--border)",
  borderRadius: 14, padding: "14px 16px",
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
