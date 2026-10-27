"use client";
import { useState } from "react";

const PEOPLE = [
  { id: "jack", name: "Jack" },
  { id: "grant", name: "Grant" },
  { id: "dylan", name: "Dylan" },
];

export default function LoginForm() {
  const [user, setUser] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function go(e: React.FormEvent) {
    e.preventDefault();
    if (!user) return setErr("Tap your name first.");
    setBusy(true);
    setErr(null);
    const r = await fetch("/api/command/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user, code }),
    }).catch(() => null);
    const j = r ? await r.json().catch(() => ({})) : {};
    setBusy(false);
    if (r?.ok && j.ok) window.location.href = "/command";
    else setErr(j.error || "Could not sign in. Check your connection.");
  }

  return (
    <form onSubmit={go} className="cc-card">
      <div className="cc-pick">
        {PEOPLE.map((p) => (
          <button
            key={p.id}
            type="button"
            className={`cc-btn${user === p.id ? " on" : ""}`}
            aria-pressed={user === p.id}
            onClick={() => setUser(p.id)}
          >
            {p.name}
          </button>
        ))}
      </div>
      <label className="cc-field">
        Your code
        <input className="cc-input" type="password" inputMode="text" autoComplete="current-password" value={code} onChange={(e) => setCode(e.target.value)} />
      </label>
      <button className="cc-btn primary block" disabled={busy}>{busy ? "Signing in" : "Sign in"}</button>
      {err ? <p className="cc-msg err">{err}</p> : null}
    </form>
  );
}
