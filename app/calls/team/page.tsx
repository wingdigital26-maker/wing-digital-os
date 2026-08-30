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
    setOk(`${email.trim()} can now sign in at /login with the password you set. Give it to them now — it is not stored anywhere you can read it back.`);
    setEmail(""); setName(""); setPw("");
    load();
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
    <div style={{ minHeight: "100vh", background: "var(--bg-primary)", color: "var(--text-primary)" }}>
      <div style={{ maxWidth: 900, margin: "0 auto", padding: "28px 20px 80px" }}>
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
            The account works immediately — no confirmation email. Copy the password before you
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
            <div key={c.id} style={{ ...card, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
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
              {c.role === "caller" && (
                <button onClick={() => setRole(c.id, "client")} disabled={busy} style={{ ...btnGhost, color: "#f87171", borderColor: "rgba(248,113,113,0.4)" }}>
                  Revoke access
                </button>
              )}
              {c.role === "client" && (
                <button onClick={() => setRole(c.id, "caller")} disabled={busy} style={btnGhost}>
                  Grant caller access
                </button>
              )}
            </div>
          ))}
        </div>
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
