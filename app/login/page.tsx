"use client";
import { useState } from "react";

export default function Login() {
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(false);

  async function submit() {
    setLoading(true);
    setError(false);
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: email.trim(), password: pw }),
    });
    setLoading(false);
    if (res.ok) {
      // Client-role users go straight to their portal (or the bare /portal
      // resolver page if no slug came back) so they never bounce off "/".
      const data = await res.json().catch(() => ({} as any));
      const isStaff =
        data?.role === "admin" || data?.role === "owner" || data?.role === "staff";
      // Callers land straight in the Cold Call Room -- it is the only place
      // they can go, so bouncing them via "/" would just be a wasted redirect.
      if (data?.role === "caller") {
        window.location.href = "/calls";
      } else if (data?.role && !isStaff) {
        window.location.href = data.portal ? `/portal/${data.portal}` : "/portal";
      } else {
        window.location.href = "/";
      }
    } else setError(true);
  }

  return (
    <div className="page-scroll" style={{
      minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center",
      background: "var(--bg-primary)", padding: 16,
    }}>
      <div style={{
        width: "100%",
        maxWidth: 380,
        margin: "0 auto",
        background: "var(--bg-card)",
        border: "1px solid var(--border)", borderRadius: 20, padding: 32,
        boxShadow: "0 24px 60px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.05)",
        display: "flex", flexDirection: "column", gap: 18, textAlign: "center",
      }}>
        <div style={{
          width: 52, height: 52, borderRadius: 14, margin: "0 auto",
          background: "linear-gradient(135deg, #22d3ee, #0e7490)",
          display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: 24, fontWeight: 800, color: "#fff",
        }}>W</div>
        <div>
          <p style={{ fontSize: 18, fontWeight: 700 }}>Wing Digital OS</p>
          <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 4 }}>Sign in to continue</p>
        </div>
        <input
          type="email" value={email} autoFocus autoComplete="username"
          onChange={e => { setEmail(e.target.value); setError(false); }}
          onKeyDown={e => e.key === "Enter" && submit()}
          placeholder="Email"
          style={{
            background: "var(--bg-hover)", border: `1px solid ${error ? "var(--red)" : "var(--border)"}`,
            borderRadius: 10, padding: "12px 14px", color: "var(--text-primary)",
            fontSize: 14, outline: "none", textAlign: "center",
          }}
        />
        <p style={{ fontSize: 11.5, color: "var(--text-muted)", marginTop: -12, lineHeight: 1.4 }}>
          Only have a password? Leave email blank.
        </p>
        <input
          type="password" value={pw} autoComplete="current-password"
          onChange={e => { setPw(e.target.value); setError(false); }}
          onKeyDown={e => e.key === "Enter" && submit()}
          placeholder="Password"
          style={{
            background: "var(--bg-hover)", border: `1px solid ${error ? "var(--red)" : "var(--border)"}`,
            borderRadius: 10, padding: "12px 14px", color: "var(--text-primary)",
            fontSize: 14, outline: "none", textAlign: "center",
          }}
        />
        {error && (
          <p style={{ fontSize: 12.5, color: "var(--red)", lineHeight: 1.5 }}>
            That email and password did not match. Check for typos and try again.
          </p>
        )}
        <button onClick={submit} disabled={loading || !pw} style={{
          padding: "12px 0", borderRadius: 10, border: "none", cursor: "pointer",
          background: "linear-gradient(135deg, #22d3ee, #0e7490)", color: "#fff",
          fontSize: 14, fontWeight: 700, opacity: loading || !pw ? 0.6 : 1,
        }}>
          {loading ? "Checking..." : "Enter"}
        </button>
      </div>
    </div>
  );
}
