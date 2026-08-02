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
    if (res.ok) window.location.href = "/";
    else setError(true);
  }

  return (
    <div style={{
      height: "100vh", display: "flex", alignItems: "center", justifyContent: "center",
      background: "var(--bg-primary)",
    }}>
      <div style={{
        width: "min(380px, 90vw)",
        background: "linear-gradient(180deg, var(--bg-card), rgba(12,15,26,0.85))",
        border: "1px solid rgba(255,255,255,0.08)", borderRadius: 20, padding: 32,
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
          placeholder="Email (leave blank for password-only)"
          style={{
            background: "var(--bg-hover)", border: `1px solid ${error ? "#f87171" : "var(--border)"}`,
            borderRadius: 10, padding: "12px 14px", color: "var(--text-primary)",
            fontSize: 14, outline: "none", textAlign: "center",
          }}
        />
        <input
          type="password" value={pw} autoComplete="current-password"
          onChange={e => { setPw(e.target.value); setError(false); }}
          onKeyDown={e => e.key === "Enter" && submit()}
          placeholder="Password"
          style={{
            background: "var(--bg-hover)", border: `1px solid ${error ? "#f87171" : "var(--border)"}`,
            borderRadius: 10, padding: "12px 14px", color: "var(--text-primary)",
            fontSize: 14, outline: "none", textAlign: "center",
          }}
        />
        {error && <p style={{ fontSize: 12, color: "#f87171" }}>Wrong email or password</p>}
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
