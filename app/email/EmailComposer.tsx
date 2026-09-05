"use client";
import { useMemo, useState } from "react";

// ───────────────────────────────────────────────────────────────────────────
// EmailComposer — two separate email jobs, never blurred together.
//
//  * "Send now (1:1)"  → POST /api/email/send. An instant SMTP send. The
//    moment the server says ok, the mail is on its way.
//  * "Add to cold campaign" → POST /api/email/campaign. This does NOT send.
//    It enqueues the prospect into the Instantly cold campaign, which sends
//    on its own warmed schedule. We show the server's own `note` so nobody
//    thinks a message just went out.
//
// Honesty rules (same as the rest of the OS): a pending state while the
// request is in flight (never optimistic), the real response on success
// (message id / instantly lead id / the note), and the server's exact
// `error` string on failure — never a generic "something went wrong".
// ───────────────────────────────────────────────────────────────────────────

// Shared visual language, colors only through var(--token) so it works in
// light and dark. Mirrors app/automations/_ui and MessagesBoard.
const card: React.CSSProperties = {
  background: "var(--bg-card)",
  border: "1px solid var(--border)",
  borderRadius: 12,
  padding: 18,
};
const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: 12,
  fontWeight: 600,
  color: "var(--text-secondary)",
  marginBottom: 5,
};
const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "9px 12px",
  borderRadius: 9,
  border: "1px solid var(--border)",
  background: "var(--bg-card)",
  color: "var(--text-primary)",
  fontSize: 13.5,
  boxSizing: "border-box",
  fontFamily: "inherit",
};

type Mode = "send" | "campaign";

// The server rejects em dashes, en dashes, and unrendered {tokens}. Mirror
// that here so the user gets a friendly inline note instead of a surprise 400.
const EM_DASH = "—";
const EN_DASH = "–";
function copyProblem(...parts: (string | undefined)[]): string | null {
  const text = parts.filter(Boolean).join("\n");
  if (text.includes(EM_DASH)) return "Remove the em dash (—). Use a comma, period, or the word \"to\" instead.";
  if (text.includes(EN_DASH)) return "Remove the en dash (–). Use a hyphen or the word \"to\" instead.";
  const token = text.match(/\{[^}]+\}/);
  if (token) return `The placeholder ${token[0]} was left unfilled. Replace it with real text before sending.`;
  return null;
}

function isEmail(v: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());
}

function tab(active: boolean): React.CSSProperties {
  return {
    padding: "8px 16px",
    borderRadius: 999,
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
    border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
    color: active ? "#fff" : "var(--text-secondary)",
    background: active ? "var(--accent)" : "transparent",
  };
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  type = "text",
  textarea,
  rows,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  textarea?: boolean;
  rows?: number;
}) {
  return (
    <label style={{ display: "block" }}>
      <span style={labelStyle}>{label}</span>
      {textarea ? (
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          rows={rows ?? 6}
          style={{ ...inputStyle, resize: "vertical", lineHeight: 1.55 }}
        />
      ) : (
        <input
          type={type}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          style={inputStyle}
        />
      )}
    </label>
  );
}

function ResultBox({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  const color = ok ? "var(--green)" : "var(--red)";
  return (
    <div
      role="status"
      style={{ ...card, borderColor: color, padding: "12px 14px", fontSize: 12.5, lineHeight: 1.55, color }}
    >
      {children}
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      <span style={{ fontWeight: 700, minWidth: 120 }}>{k}</span>
      <span style={{ wordBreak: "break-word", color: "var(--text-secondary)" }}>{v}</span>
    </div>
  );
}

type SendResult =
  | { ok: true; messageId?: string; providerMessageId?: string; from?: string; ledgerNote?: string }
  | { ok: false; error?: string };

type CampaignResult =
  | { ok: true; messageId?: string; instantlyLeadId?: string; campaign?: string; note?: string; ledgerNote?: string }
  | { ok: false; error?: string };

// ── Send now (1:1) ──────────────────────────────────────────────────────────
function SendNow() {
  const [to, setTo] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [replyTo, setReplyTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SendResult | null>(null);

  const problem = useMemo(() => copyProblem(subject, body), [subject, body]);
  const canSend = isEmail(to) && subject.trim() !== "" && body.trim() !== "" && !problem && !busy;

  const submit = async () => {
    if (!canSend) return;
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch("/api/email/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          to: to.trim(),
          subject: subject.trim(),
          body,
          replyTo: replyTo.trim() || undefined,
        }),
      });
      const j = (await res.json().catch(() => null)) as SendResult | null;
      if (!res.ok || !j || !j.ok) {
        setResult({ ok: false, error: (j && !j.ok && j.error) || `The server said no (HTTP ${res.status}).` });
      } else {
        setResult(j);
      }
    } catch (e) {
      setResult({ ok: false, error: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <p style={{ margin: 0, fontSize: 12.5, color: "var(--text-muted)", lineHeight: 1.55 }}>
        This sends immediately over SMTP the moment you press Send. It is a real 1:1 email, not a cold sequence.
      </p>
      <Field label="To" type="email" value={to} onChange={setTo} placeholder="person@company.com" />
      <Field label="Subject" value={subject} onChange={setSubject} placeholder="What this email is about" />
      <Field label="Body" value={body} onChange={setBody} placeholder="Write the message." textarea rows={8} />
      <Field label="Reply-To (optional)" type="email" value={replyTo} onChange={setReplyTo} placeholder="Where replies should go, if not the sending address" />

      {problem && (
        <div style={{ fontSize: 12.5, color: "var(--orange)", lineHeight: 1.55 }}>{problem}</div>
      )}

      <button
        type="button"
        onClick={() => { void submit(); }}
        disabled={!canSend}
        style={{
          justifySelf: "start",
          padding: "10px 22px",
          borderRadius: 9,
          border: "1px solid var(--accent)",
          background: canSend ? "var(--accent)" : "transparent",
          color: canSend ? "#fff" : "var(--text-muted)",
          fontSize: 13.5,
          fontWeight: 700,
          cursor: canSend ? "pointer" : "default",
          opacity: canSend ? 1 : 0.6,
        }}
      >
        {busy ? "Sending…" : "Send now"}
      </button>

      {result && (result.ok ? (
        <ResultBox ok>
          <div style={{ fontWeight: 700, marginBottom: 6 }}>Sent. The email is on its way.</div>
          <div style={{ display: "grid", gap: 4 }}>
            {result.messageId && <Row k="Message id" v={result.messageId} />}
            {result.providerMessageId && <Row k="Provider id" v={result.providerMessageId} />}
            {result.from && <Row k="From" v={result.from} />}
            {result.ledgerNote && <Row k="Ledger" v={result.ledgerNote} />}
          </div>
        </ResultBox>
      ) : (
        <ResultBox ok={false}>
          <div style={{ fontWeight: 700, marginBottom: 4 }}>Not sent.</div>
          <div>{result.error}</div>
        </ResultBox>
      ))}
    </div>
  );
}

// ── Add to cold campaign ────────────────────────────────────────────────────
function AddToCampaign() {
  const [to, setTo] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [company, setCompany] = useState("");
  const [personalization, setPersonalization] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<CampaignResult | null>(null);

  const problem = useMemo(() => copyProblem(personalization), [personalization]);
  const canAdd = isEmail(to) && !problem && !busy;

  const submit = async () => {
    if (!canAdd) return;
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch("/api/email/campaign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          to: to.trim(),
          first_name: firstName.trim() || undefined,
          last_name: lastName.trim() || undefined,
          company_name: company.trim() || undefined,
          personalization: personalization.trim() || undefined,
        }),
      });
      const j = (await res.json().catch(() => null)) as CampaignResult | null;
      if (!res.ok || !j || !j.ok) {
        setResult({ ok: false, error: (j && !j.ok && j.error) || `The server said no (HTTP ${res.status}).` });
      } else {
        setResult(j);
      }
    } catch (e) {
      setResult({ ok: false, error: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <p style={{ margin: 0, fontSize: 12.5, color: "var(--text-muted)", lineHeight: 1.55 }}>
        This does NOT send an email now. It adds the prospect to the Instantly cold campaign, which sends on its own warmed schedule.
      </p>
      <Field label="To" type="email" value={to} onChange={setTo} placeholder="prospect@company.com" />
      <div style={{ display: "grid", gap: 14, gridTemplateColumns: "1fr 1fr" }}>
        <Field label="First name" value={firstName} onChange={setFirstName} placeholder="First" />
        <Field label="Last name" value={lastName} onChange={setLastName} placeholder="Last" />
      </div>
      <Field label="Company" value={company} onChange={setCompany} placeholder="Company name" />
      <Field
        label="Personalization note (optional)"
        value={personalization}
        onChange={setPersonalization}
        placeholder="A specific detail Instantly can weave into the first line."
        textarea
        rows={4}
      />

      {problem && (
        <div style={{ fontSize: 12.5, color: "var(--orange)", lineHeight: 1.55 }}>{problem}</div>
      )}

      <button
        type="button"
        onClick={() => { void submit(); }}
        disabled={!canAdd}
        style={{
          justifySelf: "start",
          padding: "10px 22px",
          borderRadius: 9,
          border: "1px solid var(--accent)",
          background: canAdd ? "var(--accent)" : "transparent",
          color: canAdd ? "#fff" : "var(--text-muted)",
          fontSize: 13.5,
          fontWeight: 700,
          cursor: canAdd ? "pointer" : "default",
          opacity: canAdd ? 1 : 0.6,
        }}
      >
        {busy ? "Adding…" : "Add to campaign"}
      </button>

      {result && (result.ok ? (
        <ResultBox ok>
          <div style={{ fontWeight: 700, marginBottom: 6 }}>Added to the cold campaign.</div>
          {result.note && <div style={{ marginBottom: 8 }}>{result.note}</div>}
          <div style={{ display: "grid", gap: 4 }}>
            {result.campaign && <Row k="Campaign" v={result.campaign} />}
            {result.instantlyLeadId && <Row k="Instantly lead id" v={result.instantlyLeadId} />}
            {result.messageId && <Row k="Message id" v={result.messageId} />}
            {result.ledgerNote && <Row k="Ledger" v={result.ledgerNote} />}
          </div>
        </ResultBox>
      ) : (
        <ResultBox ok={false}>
          <div style={{ fontWeight: 700, marginBottom: 4 }}>Not added.</div>
          <div>{result.error}</div>
        </ResultBox>
      ))}
    </div>
  );
}

export default function EmailComposer() {
  const [mode, setMode] = useState<Mode>("send");

  return (
    <div style={{ display: "grid", gap: 18 }}>
      <div>
        <h1 style={{ margin: 0, fontFamily: "'Space Grotesk',sans-serif", fontSize: 24, fontWeight: 700 }}>
          Email
        </h1>
        <p style={{ margin: "6px 0 0", fontSize: 13, color: "var(--text-muted)", lineHeight: 1.55 }}>
          Send a real 1:1 email, or drop a prospect into the cold campaign. The two are different jobs.
        </p>
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button type="button" onClick={() => setMode("send")} style={tab(mode === "send")}>
          Send now (1:1)
        </button>
        <button type="button" onClick={() => setMode("campaign")} style={tab(mode === "campaign")}>
          Add to cold campaign
        </button>
      </div>

      <div style={card}>{mode === "send" ? <SendNow /> : <AddToCampaign />}</div>
    </div>
  );
}
