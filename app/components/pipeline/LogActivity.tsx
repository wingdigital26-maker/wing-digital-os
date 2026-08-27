"use client";
import { useState } from "react";

// Log an activity against a contact (and optionally the deal it belongs to).
// This is where dial-sheet call outcomes finally land: pick the kind, pick the
// outcome, type what happened, save. Nothing is sent to anyone by this form; it
// only records what already happened.

const KINDS = ["call", "note", "email", "sms", "meeting"] as const;

// Call outcomes match how Jack actually works a dial list. They are only
// offered for calls, because "no answer" is meaningless on a note.
const CALL_OUTCOMES = [
  "connected",
  "no answer",
  "voicemail",
  "gatekeeper",
  "callback scheduled",
  "not interested",
  "wrong number",
];

export default function LogActivity({
  contactId,
  dealId,
  onSaved,
}: {
  contactId: number | null;
  dealId?: number | null;
  onSaved?: () => void;
}) {
  const [kind, setKind] = useState<string>("call");
  const [outcome, setOutcome] = useState<string>("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [ok, setOk] = useState(false);

  async function save() {
    if (contactId === null && (dealId === null || dealId === undefined)) {
      setErr("Nothing to attach this to: no contact and no deal.");
      return;
    }
    setBusy(true); setErr(""); setOk(false);
    try {
      const res = await fetch("/api/pipeline/activities", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contact_id: contactId,
          deal_id: dealId ?? null,
          kind,
          outcome: kind === "call" && outcome ? outcome : null,
          body: body.trim() ? body.trim() : null,
          source: "os-ui",
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.error) {
        setErr(data?.error || `Save failed (HTTP ${res.status})`);
      } else {
        setOk(true);
        setBody("");
        setOutcome("");
        onSaved?.();
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{
      border: "1px solid var(--border)", borderRadius: 10,
      padding: 12, background: "var(--bg-card)",
    }}>
      <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 8 }}>
        Log an activity
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
        {KINDS.map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => { setKind(k); if (k !== "call") setOutcome(""); }}
            style={{
              padding: "6px 10px", borderRadius: 999, fontSize: 12,
              cursor: "pointer", textTransform: "capitalize",
              border: `1px solid ${kind === k ? "var(--accent)" : "var(--border)"}`,
              color: kind === k ? "var(--accent)" : "var(--text-muted)",
              background: "transparent",
            }}
          >
            {k}
          </button>
        ))}
      </div>

      {kind === "call" && (
        <select
          value={outcome}
          onChange={(e) => setOutcome(e.target.value)}
          style={{
            width: "100%", padding: "8px 10px", marginBottom: 8, fontSize: 14,
            borderRadius: 8, border: "1px solid var(--border)",
            background: "var(--bg-card)", color: "inherit",
          }}
        >
          <option value="">Call outcome (optional)</option>
          {CALL_OUTCOMES.map((o) => (
            <option key={o} value={o}>{o}</option>
          ))}
        </select>
      )}

      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={3}
        placeholder="What happened?"
        style={{
          width: "100%", padding: "8px 10px", fontSize: 14, borderRadius: 8,
          border: "1px solid var(--border)", background: "var(--bg-card)",
          color: "inherit", resize: "vertical", boxSizing: "border-box",
        }}
      />

      <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 8 }}>
        <button
          type="button"
          onClick={save}
          disabled={busy}
          style={{
            padding: "9px 16px", borderRadius: 8, fontSize: 14, fontWeight: 600,
            cursor: busy ? "default" : "pointer",
            border: "1px solid var(--accent)", color: "var(--accent)",
            background: "transparent", opacity: busy ? 0.6 : 1,
          }}
        >
          {busy ? "Saving" : "Save activity"}
        </button>
        {ok && <span style={{ fontSize: 12, color: "var(--green)" }}>Logged</span>}
        {err && <span style={{ fontSize: 12, color: "var(--red)" }}>{err}</span>}
      </div>
    </div>
  );
}
