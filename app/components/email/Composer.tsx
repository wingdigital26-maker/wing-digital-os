"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Note, label, selectStyle } from "./ui";

// ───────────────────────────────────────────────────────────────────────────
// Composer — write one email, inside the email screen.
//
// Two jobs that must never blur into each other, same split the standalone
// /email page has always drawn:
//   * Send now (1:1)   -> POST /api/email/send. A real SMTP send the instant
//     the server says ok.
//   * Add to campaign  -> POST /api/email/campaign. This does NOT send. It
//     drops the prospect into the cold sequence, which sends on its own
//     warmed schedule, and the server's own note says so.
//
// THE SEND GATE IS THE SERVER'S, AND IT IS NOT TOUCHED HERE. /api/email/send
// fails closed on its own: no SMTP env, no send; copy with an em dash or an
// unfilled {token}, no send; a suppressed address, no send; a row it cannot
// log first, no send. This component only mirrors the copy rule locally so
// the rejection arrives as a note instead of a surprise 400, and shows the
// server's exact error when it refuses. It cannot bypass anything.
//
// Templates are real: /api/email/templates returns the live steps of the live
// campaigns, never invented sample copy. If that read fails the picker says
// why and stays empty.
//
// Scheduling is deliberately absent, not stubbed. Nothing in the OS holds a
// send for later, so a "schedule" control here would be a button that lies.
// ───────────────────────────────────────────────────────────────────────────

const EM_DASH = "—";
const EN_DASH = "–";

/** Mirrors copyViolation() in lib/email.ts so the note is instant. */
function copyProblem(...parts: (string | undefined)[]): string | null {
  const text = parts.filter(Boolean).join("\n");
  if (text.includes(EM_DASH)) return `Remove the em dash (${EM_DASH}). Use a comma, a period, or the word "to".`;
  if (text.includes(EN_DASH)) return `Remove the en dash (${EN_DASH}). Use a hyphen or the word "to".`;
  // Both shapes the senders use: {token} and the handlebars {{token}}. The
  // outer braces are matched too so the note quotes the whole thing back.
  const token = text.match(/\{\{?[^{}]+\}\}?/);
  if (token) return `The placeholder ${token[0]} was left unfilled. Replace it with real text before sending.`;
  return null;
}

function isEmail(v: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());
}

type Template = { id: string; name: string; campaign: string; step: number; subject: string; body: string };
type TemplatePayload = {
  templates: Template[]; available: boolean; reason: string | null;
  note?: string | null; emptyNote?: string | null;
};

type SendResult =
  | { ok: true; messageId?: string; providerMessageId?: string; from?: string; ledgerNote?: string }
  | { ok: false; error?: string };

type CampaignResult =
  | { ok: true; messageId?: string; instantlyLeadId?: string; campaign?: string; note?: string }
  | { ok: false; error?: string };

const field: React.CSSProperties = {
  width: "100%", padding: "9px 12px", borderRadius: 9,
  border: "1px solid var(--border)", background: "var(--bg-card)",
  color: "var(--text-primary)", fontSize: 13.5, fontFamily: "inherit",
  boxSizing: "border-box",
};

function Field({ name, value, onChange, placeholder, textarea, rows, type }: {
  name: string; value: string; onChange: (v: string) => void;
  placeholder?: string; textarea?: boolean; rows?: number; type?: string;
}) {
  return (
    <label style={{ display: "block" }}>
      <span style={{ ...label, display: "block", marginBottom: 5 }}>{name}</span>
      {textarea ? (
        <textarea
          value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder}
          rows={rows ?? 8} style={{ ...field, resize: "vertical", lineHeight: 1.55 }}
        />
      ) : (
        <input
          type={type ?? "text"} value={value} onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder} style={field}
        />
      )}
    </label>
  );
}

export default function Composer() {
  const [mode, setMode] = useState<"send" | "campaign">("send");

  // Send-now fields.
  const [to, setTo] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [replyTo, setReplyTo] = useState("");

  // Campaign-enrol fields.
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [company, setCompany] = useState("");
  const [personalization, setPersonalization] = useState("");

  const [busy, setBusy] = useState(false);
  const [sendResult, setSendResult] = useState<SendResult | null>(null);
  const [campResult, setCampResult] = useState<CampaignResult | null>(null);

  const [templates, setTemplates] = useState<TemplatePayload | null>(null);
  const [picked, setPicked] = useState("");

  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        const res = await fetch("/api/email/templates", { cache: "no-store" });
        const j = (await res.json()) as TemplatePayload;
        if (!dead) setTemplates(j);
      } catch (e) {
        if (!dead) {
          setTemplates({
            templates: [], available: false,
            reason: `The saved campaign copy could not be read: ${e instanceof Error ? e.message : String(e)}`,
          });
        }
      }
    })();
    return () => { dead = true; };
  }, []);

  const applyTemplate = useCallback((id: string) => {
    setPicked(id);
    const t = templates?.templates.find((x) => x.id === id);
    if (!t) return;
    setSubject(t.subject);
    setBody(t.body);
  }, [templates]);

  const problem = useMemo(() => copyProblem(subject, body), [subject, body]);
  const canSend = isEmail(to) && subject.trim() !== "" && body.trim() !== "" && !problem && !busy;
  const canEnrol = isEmail(to) && !busy;

  const submitSend = async () => {
    if (!canSend) return;
    setBusy(true); setSendResult(null);
    try {
      const res = await fetch("/api/email/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          to: to.trim(), subject: subject.trim(), body,
          replyTo: replyTo.trim() || undefined,
        }),
      });
      const j = (await res.json().catch(() => null)) as SendResult | null;
      setSendResult(
        !res.ok || !j || !j.ok
          ? { ok: false, error: (j && !j.ok && j.error) || `The server refused it (HTTP ${res.status}).` }
          : j
      );
    } catch (e) {
      setSendResult({ ok: false, error: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const submitEnrol = async () => {
    if (!canEnrol) return;
    setBusy(true); setCampResult(null);
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
      setCampResult(
        !res.ok || !j || !j.ok
          ? { ok: false, error: (j && !j.ok && j.error) || `The server refused it (HTTP ${res.status}).` }
          : j
      );
    } catch (e) {
      setCampResult({ ok: false, error: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const tab = (active: boolean): React.CSSProperties => ({
    padding: "7px 16px", borderRadius: 999, fontSize: 12.5, fontWeight: 600,
    cursor: "pointer", fontFamily: "inherit",
    border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
    color: active ? "var(--accent)" : "var(--text-secondary)",
    background: active ? "var(--accent-glow)" : "transparent",
  });

  const result = mode === "send" ? sendResult : campResult;

  return (
    <div style={{ display: "grid", gap: 14, maxWidth: 720 }}>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <button type="button" style={tab(mode === "send")} onClick={() => setMode("send")}>Send now, one to one</button>
        <button type="button" style={tab(mode === "campaign")} onClick={() => setMode("campaign")}>Add to cold campaign</button>
      </div>

      <p style={{ margin: 0, fontSize: 12.5, color: "var(--text-muted)", lineHeight: 1.55 }}>
        {mode === "send"
          ? "This goes out over SMTP the moment the server accepts it. The server still checks the copy rules, the suppression list, and that it can log the row first, and refuses if any of those fail."
          : "This does not send anything. It drops the prospect into the cold sequence, which sends on its own warmed schedule."}
      </p>

      {mode === "send" && (
        <>
          <div style={{ display: "grid", gap: 5 }}>
            <span style={label}>Start from saved campaign copy</span>
            <select
              value={picked}
              onChange={(e) => applyTemplate(e.target.value)}
              style={{ ...selectStyle, width: "100%", borderRadius: 9 }}
              disabled={!templates?.templates.length}
            >
              <option value="">
                {templates == null
                  ? "Reading the campaigns…"
                  : templates.templates.length
                    ? "Blank email"
                    : "Nothing saved to start from"}
              </option>
              {(templates?.templates ?? []).map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
            {templates && !templates.available && templates.reason && (
              <div style={{ fontSize: 11.5, color: "var(--orange)", lineHeight: 1.5 }}>{templates.reason}</div>
            )}
            {templates?.emptyNote && (
              <div style={{ fontSize: 11.5, color: "var(--text-muted)", lineHeight: 1.5 }}>{templates.emptyNote}</div>
            )}
            {templates?.note && (
              <div style={{ fontSize: 11.5, color: "var(--text-muted)", lineHeight: 1.5 }}>{templates.note}</div>
            )}
          </div>

          <Field name="To" type="email" value={to} onChange={setTo} placeholder="person@company.com" />
          <Field name="Subject" value={subject} onChange={setSubject} placeholder="What this email is about" />
          <Field name="Body" value={body} onChange={setBody} placeholder="Write the message." textarea rows={9} />
          <Field name="Reply to (optional)" type="email" value={replyTo} onChange={setReplyTo}
            placeholder="Where answers should go, if not the sending address" />

          {problem && <Note tone="var(--orange)" text={problem} />}

          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <button
              type="button" onClick={() => { void submitSend(); }} disabled={!canSend}
              style={{
                padding: "9px 20px", borderRadius: 999, fontSize: 13, fontWeight: 700,
                cursor: canSend ? "pointer" : "default", fontFamily: "inherit",
                border: "1px solid var(--accent)",
                color: canSend ? "var(--accent)" : "var(--text-muted)",
                background: "transparent", opacity: canSend ? 1 : 0.55,
              }}
            >
              {busy ? "Sending…" : "Send now"}
            </button>
            <span style={{ fontSize: 11, color: "var(--text-muted)", lineHeight: 1.5, flex: "1 1 240px" }}>
              There is no schedule-for-later here because nothing in the OS holds a send for later. A cold sequence is
              how an email gets sent on a timetable.
            </span>
          </div>
        </>
      )}

      {mode === "campaign" && (
        <>
          <Field name="Their email" type="email" value={to} onChange={setTo} placeholder="person@company.com" />
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <div style={{ flex: "1 1 180px" }}>
              <Field name="First name" value={firstName} onChange={setFirstName} placeholder="optional" />
            </div>
            <div style={{ flex: "1 1 180px" }}>
              <Field name="Last name" value={lastName} onChange={setLastName} placeholder="optional" />
            </div>
          </div>
          <Field name="Company" value={company} onChange={setCompany} placeholder="optional" />
          <Field name="Personalization line" value={personalization} onChange={setPersonalization}
            placeholder="The one specific thing the sequence drops into the first line. Optional." textarea rows={3} />
          <button
            type="button" onClick={() => { void submitEnrol(); }} disabled={!canEnrol}
            style={{
              justifySelf: "start", padding: "9px 20px", borderRadius: 999, fontSize: 13, fontWeight: 700,
              cursor: canEnrol ? "pointer" : "default", fontFamily: "inherit",
              border: "1px solid var(--accent)",
              color: canEnrol ? "var(--accent)" : "var(--text-muted)",
              background: "transparent", opacity: canEnrol ? 1 : 0.55,
            }}
          >
            {busy ? "Adding…" : "Add to campaign"}
          </button>
        </>
      )}

      {result && (
        <div style={{
          border: `1px solid ${result.ok ? "var(--green)" : "var(--red)"}`, borderRadius: 11,
          background: "var(--bg-card)", padding: "12px 14px", display: "grid", gap: 5,
          fontSize: 12.5, lineHeight: 1.55, color: result.ok ? "var(--green)" : "var(--red)",
        }}>
          {!result.ok && <span>{result.error}</span>}
          {result.ok && mode === "send" && (
            <>
              <span>Sent. It is logged in the feed as a one-to-one email.</span>
              {"from" in result && result.from && <span>From {result.from}</span>}
              {"ledgerNote" in result && result.ledgerNote && (
                <span style={{ color: "var(--orange)" }}>{result.ledgerNote}</span>
              )}
            </>
          )}
          {result.ok && mode === "campaign" && (
            <>
              <span>{("note" in result && result.note) || "Added to the campaign. Nothing has been sent yet."}</span>
              {"campaign" in result && result.campaign && <span>Campaign: {result.campaign}</span>}
            </>
          )}
        </div>
      )}
    </div>
  );
}
