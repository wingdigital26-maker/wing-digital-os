"use client";
import { useCallback, useEffect, useState } from "react";

type Caller = {
  id: string;
  name: string | null;
  role: string;
  email: string | null;
  created_at: string;
  calls: number;
  booked: number;
};

type Activity = {
  id: number;
  lead_id: string;
  company: string;
  phone: string | null;
  lead_status: string | null;
  outcome: string;
  notes: string | null;
  duration_sec: number | null;
  next_action_at: string | null;
  created_at: string;
};

type Feed = {
  activity: Activity[];
  summary: { dialsToday: number; dialsWeek: number; bookedWeek: number };
};

// Plain-English outcome labels, matching the call room.
const OUTCOME_LABELS: Record<string, { label: string; tone: string }> = {
  booked: { label: "Booked a call", tone: "#22c55e" },
  callback: { label: "Call back later", tone: "#eab308" },
  contacted: { label: "Spoke, no yes", tone: "#38bdf8" },
  no_answer: { label: "No answer", tone: "#94a3b8" },
  not_interested: { label: "Not interested", tone: "#f97316" },
  bad_number: { label: "Bad number", tone: "#a78bfa" },
  dnc: { label: "Do not call", tone: "#ef4444" },
};

const fmtDuration = (s: number | null) => {
  if (!s || s <= 0) return null;
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
};

// Admin-only screen for creating and revoking call-room logins.
// Middleware blocks /calls/team for the caller role; the API re-checks.
export default function Team() {
  const [rows, setRows] = useState<Caller[]>([]);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [openId, setOpenId] = useState<string | null>(null);
  const [feed, setFeed] = useState<Feed | null>(null);
  const [feedLoading, setFeedLoading] = useState(false);

  const load = useCallback(async () => {
    const r = await fetch("/api/calls/callers", { cache: "no-store" });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      setError(d.error ?? "Could not load the team");
      setLoading(false);
      return;
    }
    setRows((await r.json()).callers ?? []);
    setError(null);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  function suggestPassword() {
    // Generated in the browser and shown once, so Jack can hand it over. It is
    // never stored anywhere by the OS -- Supabase holds only the hash.
    const a = new Uint8Array(12);
    crypto.getRandomValues(a);
    setPw(
      Array.from(a, (b) => "abcdefghijkmnpqrstuvwxyz23456789ACDEFGHJKLMNPQRSTUVWXYZ"[b % 55]).join("")
    );
  }

  async function create() {
    setBusy(true); setError(null); setOk(null);
    const r = await fetch("/api/calls/callers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: email.trim(), password: pw, name: name.trim() || undefined }),
    });
    setBusy(false);
    const d = await r.json().catch(() => ({}));
    if (!r.ok && r.status !== 207) { setError(d.error ?? "Could not create that account"); return; }
    if (r.status === 207) setError(d.error);
    setOk(`${email.trim()} can now sign in at /login with the password you set. Give it to them now. It is not stored anywhere you can read it back.`);
    setEmail(""); setName(""); setPw("");
    load();
  }

  // Expand a person's row into their recent call feed. Clicking again closes it.
  async function toggleFeed(c: Caller) {
    if (openId === c.id) { setOpenId(null); setFeed(null); return; }
    setOpenId(c.id);
    setFeed(null);
    setFeedLoading(true);
    // Prefer the stable uuid; fall back to email for rows attributed only by email.
    const who = c.id !== "legacy" ? c.id : c.email ?? "";
    const r = await fetch(`/api/calls/callers?activity=${encodeURIComponent(who)}`, { cache: "no-store" });
    setFeedLoading(false);
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      setError(d.error ?? "Could not load that person's calls");
      setOpenId(null);
      return;
    }
    setFeed(await r.json());
  }

  async function setRole(id: string, role: string) {
    setBusy(true); setError(null);
    const r = await fetch("/api/calls/callers", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, role }),
    });
    setBusy(false);
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      setError(d.error ?? "Could not change that role");
      return;
    }
    load();
  }

  return (
    <div style={{ maxWidth: 900, margin: "0 auto" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <div>
            <h1 style={{ fontSize: 24, fontWeight: 800, letterSpacing: -0.4 }}>Call room access</h1>
            <p style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 4 }}>
              Everyone here can see and dial every lead. They cannot see anything else in the OS.
            </p>
          </div>
          <a href="/calls" style={btnGhost}>Back to the room</a>
        </div>

        {error && <div style={{ ...banner, background: "rgba(239,68,68,0.12)", borderColor: "rgba(239,68,68,0.4)", color: "#f87171" }}>{error}</div>}
        {ok && <div style={{ ...banner, background: "rgba(34,197,94,0.12)", borderColor: "rgba(34,197,94,0.4)", color: "#4ade80" }}>{ok}</div>}

        {/* create */}
        <div style={{ ...card, marginTop: 20 }}>
          <p style={{ fontSize: 14, fontWeight: 700 }}>Add a caller</p>
          <p style={{ fontSize: 12.5, color: "var(--text-muted)", marginTop: 4, lineHeight: 1.5 }}>
            A caller login opens the Call Room only: the dial list, callbacks, booked calls, and
            the team schedule. It cannot see clients, money, or anything else in the OS.
          </p>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(190px,1fr))", gap: 10, marginTop: 12 }}>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Their name" style={input} />
            <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="their@email.com" type="email" style={input} />
            <div style={{ display: "flex", gap: 6 }}>
              <input value={pw} onChange={(e) => setPw(e.target.value)} placeholder="Password (10+ chars)" style={{ ...input, flex: 1 }} />
              <button onClick={suggestPassword} style={btnGhost}>Generate</button>
            </div>
          </div>
          <button
            onClick={create}
            disabled={busy || !email.trim() || pw.length < 10}
            style={{ ...btnPrimary, marginTop: 12, opacity: busy || !email.trim() || pw.length < 10 ? 0.5 : 1 }}
          >
            {busy ? "Creating…" : "Create caller login"}
          </button>
          <p style={{ fontSize: 11.5, color: "var(--text-muted)", marginTop: 10, lineHeight: 1.5 }}>
            The account works immediately, no confirmation email. Copy the password before you
            leave this page; it is hashed on save and cannot be shown again.
          </p>
        </div>

        {/* list */}
        <div style={{ marginTop: 20, display: "flex", flexDirection: "column", gap: 10 }}>
          {loading && <p style={{ fontSize: 13, color: "var(--text-muted)" }}>Loading…</p>}
          {!loading && rows.length === 0 && (
            <div style={{ ...card, textAlign: "center", padding: 30, color: "var(--text-muted)", fontSize: 13 }}>
              Nobody has call-room access yet.
            </div>
          )}
          {rows.map((c) => (
            <div key={c.id} style={card}>
              <div
                onClick={() => toggleFeed(c)}
                style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", cursor: "pointer" }}
              >
                <div style={{ flex: "1 1 220px", minWidth: 0 }}>
                  <p style={{ fontSize: 14, fontWeight: 700 }}>
                    {c.name || c.email || c.id.slice(0, 8)}
                    <span style={{
                      marginLeft: 8, padding: "2px 8px", borderRadius: 999, fontSize: 10.5,
                      fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.4,
                      border: `1px solid ${c.role === "caller" ? "#38bdf8" : "#a78bfa"}`,
                      color: c.role === "caller" ? "#38bdf8" : "#a78bfa",
                    }}>{c.role}</span>
                  </p>
                  <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 3 }}>
                    {c.calls} {c.calls === 1 ? "call" : "calls"} logged · {c.booked} booked
                  </p>
                </div>
                <span
                  style={{
                    ...btnGhost,
                    color: "#38bdf8",
                    borderColor: "rgba(56,189,248,0.4)",
                    flexShrink: 0,
                  }}
                >
                  {openId === c.id ? "Hide their calls ▲" : "See their calls ▼"}
                </span>
                {c.role === "caller" && (
                  <button onClick={(e) => { e.stopPropagation(); setRole(c.id, "client"); }} disabled={busy} style={{ ...btnGhost, color: "#f87171", borderColor: "rgba(248,113,113,0.4)" }}>
                    Revoke access
                  </button>
                )}
                {c.role === "client" && (
                  <button onClick={(e) => { e.stopPropagation(); setRole(c.id, "caller"); }} disabled={busy} style={btnGhost}>
                    Grant caller access
                  </button>
                )}
              </div>

              {/* per-person activity feed */}
              {openId === c.id && (
                <div style={{ marginTop: 14, borderTop: "1px solid var(--border)", paddingTop: 14 }}>
                  {feedLoading && <p style={{ fontSize: 12.5, color: "var(--text-muted)" }}>Loading their calls…</p>}
                  {!feedLoading && feed && (
                    <>
                      <div style={{ display: "flex", gap: 18, flexWrap: "wrap" }}>
                        {[
                          { n: feed.summary.dialsToday, label: "dials today" },
                          { n: feed.summary.dialsWeek, label: "dials this week" },
                          { n: feed.summary.bookedWeek, label: "booked this week" },
                        ].map((s) => (
                          <div key={s.label}>
                            <p style={{ fontSize: 20, fontWeight: 800, color: s.label.startsWith("booked") && s.n > 0 ? "#4ade80" : "var(--text-primary)" }}>{s.n}</p>
                            <p style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, color: "var(--text-muted)", fontWeight: 700 }}>{s.label}</p>
                          </div>
                        ))}
                      </div>

                      {feed.activity.length === 0 && (
                        <p style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 12 }}>
                          No calls logged yet.
                        </p>
                      )}
                      {feed.activity.length > 0 && (
                        <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 8, maxHeight: 420, overflowY: "auto" }}>
                          {feed.activity.map((a) => {
                            const o = OUTCOME_LABELS[a.outcome] ?? { label: a.outcome, tone: "#64748b" };
                            const dur = fmtDuration(a.duration_sec);
                            return (
                              <div key={a.id} style={{ fontSize: 12.5, padding: "10px 12px", borderRadius: 9, background: "var(--bg-hover)" }}>
                                <span style={{ fontWeight: 700 }}>{a.company}</span>
                                <span style={{ color: o.tone, fontWeight: 700 }}> · {o.label}</span>
                                <span style={{ color: "var(--text-muted)" }}>
                                  {" "}· {new Date(a.created_at).toLocaleString()}{dur ? ` · ${dur}` : ""}
                                </span>
                                {a.notes && <p style={{ marginTop: 4, lineHeight: 1.45 }}>{a.notes}</p>}
                                {a.next_action_at && (
                                  <p style={{ marginTop: 4, color: "#eab308", fontSize: 12 }}>
                                    Next: call back {new Date(a.next_action_at).toLocaleString()}
                                  </p>
                                )}
                              </div>
                            );
                          })}
                          {feed.activity.length === 100 && (
                            <p style={{ fontSize: 11.5, color: "var(--text-muted)" }}>Showing the most recent 100 calls.</p>
                          )}
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
    </div>
  );
}

const card: React.CSSProperties = {
  background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 14, padding: 18,
};
const input: React.CSSProperties = {
  background: "var(--bg-hover)", border: "1px solid var(--border)", borderRadius: 9,
  padding: "10px 12px", color: "var(--text-primary)", fontSize: 13, outline: "none",
};
const btnPrimary: React.CSSProperties = {
  padding: "10px 18px", borderRadius: 10, border: "none",
  background: "linear-gradient(135deg,#22d3ee,#0e7490)", color: "#fff",
  fontSize: 13, fontWeight: 700, cursor: "pointer",
};
const btnGhost: React.CSSProperties = {
  padding: "8px 14px", borderRadius: 10, border: "1px solid var(--border)",
  background: "var(--bg-hover)", color: "var(--text-primary)",
  fontSize: 12.5, fontWeight: 600, cursor: "pointer", textDecoration: "none",
};
const banner: React.CSSProperties = {
  marginTop: 14, padding: "11px 14px", borderRadius: 10, border: "1px solid",
  fontSize: 13, fontWeight: 600, lineHeight: 1.5,
};
