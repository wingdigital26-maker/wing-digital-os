"use client";
import { useCallback, useState } from "react";
import {
  api,
  btn,
  btnPrimary,
  btnSmall,
  card,
  EmptyState,
  ErrorBox,
  errText,
  fmtWhen,
  h1,
  input,
  jsonInit,
  label,
  muted,
  Notice,
  pickList,
  StatusPill,
  useLoad,
  useOrigin,
} from "../_ui";

// /automations/phone: which Twilio number belongs to which client, where it
// forwards, and the recent call ledger in plain English.

type VoiceNumber = {
  number: string;
  client_slug: string | null;
  forward_to: string | null;
  greeting: string | null;
  ring_seconds: number;
  created_at?: string;
};

type PhoneCall = {
  id: number;
  direction: string;
  from_number: string | null;
  to_number: string | null;
  status: string;
  duration_sec: number | null;
  started_at: string;
  client_slug?: string | null;
  contact_id?: number | null;
};

function callStatus(s: string): { key: string; text: string } {
  switch (s) {
    case "missed":
    case "no-answer":
    case "busy":
    case "voicemail":
      return { key: "missed", text: s === "voicemail" ? "Voicemail" : "Missed" };
    case "completed":
    case "in-progress":
      return { key: "answered", text: s === "in-progress" ? "On the line" : "Answered" };
    case "failed":
      return { key: "failed", text: "Failed" };
    case "ringing":
      return { key: "running", text: "Ringing" };
    default:
      return { key: "unknown", text: s || "Unknown" };
  }
}

const EMPTY = { number: "", forward_to: "", greeting: "", ring_seconds: "20", client_slug: "" };

export default function PhonePage() {
  const [numbers, setNumbers] = useState<VoiceNumber[] | null>(null);
  const [calls, setCalls] = useState<PhoneCall[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: "ok" | "warn"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [editing, setEditing] = useState<string | null>(null);
  const origin = useOrigin();

  const load = useCallback(async () => {
    try {
      const d = await api<unknown>("/api/voice/numbers");
      setNumbers(pickList<VoiceNumber>(d, "numbers", "voice_numbers", "items"));
      setCalls(pickList<PhoneCall>(d, "calls", "phone_calls", "recent_calls"));
      setError(null);
    } catch (e) {
      setError(errText(e));
    }
  }, []);

  useLoad(load);

  const save = async () => {
    const number = form.number.trim();
    if (!/^\+\d{8,15}$/.test(number)) {
      setNotice({ kind: "warn", text: "The Twilio number must be in full international form, like +12145550100." });
      return;
    }
    const forward = form.forward_to.trim();
    if (forward && !/^\+\d{8,15}$/.test(forward)) {
      setNotice({ kind: "warn", text: "The forwarding number must be in full international form, like +12145550100." });
      return;
    }
    const ring = Number(form.ring_seconds);
    if (!Number.isInteger(ring) || ring < 5 || ring > 60) {
      setNotice({ kind: "warn", text: "Ring seconds must be a whole number between 5 and 60." });
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      // POST is an upsert keyed on the number, so add and edit are one call.
      await api(
        "/api/voice/numbers",
        jsonInit("POST", {
          number,
          forward_to: forward || null,
          greeting: form.greeting.trim() || null,
          ring_seconds: ring,
          client_slug: form.client_slug.trim() || null,
        })
      );
      setForm(EMPTY);
      setEditing(null);
      setNotice({ kind: "ok", text: `Saved ${number}. Now paste the webhook URL below into Twilio for that number.` });
      await load();
    } catch (e) {
      setNotice({ kind: "warn", text: errText(e) });
    } finally {
      setBusy(false);
    }
  };

  const remove = async (n: VoiceNumber) => {
    if (!window.confirm(`Stop tracking ${n.number}? Calls to it will no longer be answered by the OS.`)) return;
    setBusy(true);
    setNotice(null);
    try {
      await api(`/api/voice/numbers?number=${encodeURIComponent(n.number)}`, { method: "DELETE" });
      await load();
    } catch (e) {
      setNotice({ kind: "warn", text: errText(e) });
    } finally {
      setBusy(false);
    }
  };

  const startEdit = (n: VoiceNumber) => {
    setEditing(n.number);
    setForm({
      number: n.number,
      forward_to: n.forward_to ?? "",
      greeting: n.greeting ?? "",
      ring_seconds: String(n.ring_seconds ?? 20),
      client_slug: n.client_slug ?? "",
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
        <h1 style={h1}>Phone numbers</h1>
        <span style={{ fontSize: 13, color: "var(--text-secondary)" }}>
          A tracked number rings through to the owner&apos;s phone. If nobody picks up, the OS knows, and an automation can text them back.
        </span>
      </div>

      <div style={{ ...card, margin: "18px 0" }}>
        <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 10 }}>{editing ? `Edit ${editing}` : "Add a number"}</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <div style={{ flex: "1 1 170px" }}>
            <span style={label}>Twilio number</span>
            <input value={form.number} onChange={(e) => setForm({ ...form, number: e.target.value })} disabled={!!editing} placeholder="+12145550100" style={{ ...input, width: "100%" }} />
          </div>
          <div style={{ flex: "1 1 170px" }}>
            <span style={label}>Forwards to (owner&apos;s cell)</span>
            <input value={form.forward_to} onChange={(e) => setForm({ ...form, forward_to: e.target.value })} placeholder="+12145550199" style={{ ...input, width: "100%" }} />
          </div>
          <div style={{ flex: "1 1 110px" }}>
            <span style={label}>Ring for (seconds)</span>
            <input type="number" min={5} max={60} value={form.ring_seconds} onChange={(e) => setForm({ ...form, ring_seconds: e.target.value })} style={{ ...input, width: "100%" }} />
          </div>
          <div style={{ flex: "1 1 150px" }}>
            <span style={label}>Client (optional)</span>
            <input value={form.client_slug} onChange={(e) => setForm({ ...form, client_slug: e.target.value })} placeholder="heros-junk" style={{ ...input, width: "100%" }} />
          </div>
          <div style={{ flex: "1 1 100%" }}>
            <span style={label}>Greeting spoken before it rings (optional, blank = ring straight through)</span>
            <input value={form.greeting} onChange={(e) => setForm({ ...form, greeting: e.target.value })} placeholder="Thanks for calling Hero's Junk Removal, one moment." style={{ ...input, width: "100%" }} />
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
          <button onClick={save} disabled={busy || !form.number.trim()} style={btnPrimary}>{editing ? "Save changes" : "Add number"}</button>
          {editing && (
            <button
              onClick={() => {
                setEditing(null);
                setForm(EMPTY);
              }}
              disabled={busy}
              style={btn}
            >
              Cancel
            </button>
          )}
        </div>
      </div>

      <div style={{ ...card, marginBottom: 18, fontSize: 13, color: "var(--text-secondary)" }}>
        <div style={{ fontWeight: 700, color: "var(--text-primary)", marginBottom: 6 }}>Connecting a number in Twilio</div>
        <div>
          In the Twilio console, open the number and under <strong>Voice &amp; Fax</strong> set <em>A call comes in</em> to Webhook, HTTP POST, with this URL:
        </div>
        <pre style={{ margin: "8px 0", padding: 10, borderRadius: 9, border: "1px solid var(--border)", background: "var(--bg-hover)", overflowX: "auto", fontSize: 12 }}>
          {`${origin}/api/voice/inbound?k=YOUR_TWILIO_WEBHOOK_KEY`}
        </pre>
        <div>
          Replace YOUR_TWILIO_WEBHOOK_KEY with the key set on this deployment (ask Jack; it is never shown here). The status callback that reports
          missed and answered calls is set automatically when the OS answers, so there is nothing else to paste.
        </div>
      </div>

      {notice && <Notice kind={notice.kind}>{notice.text}</Notice>}
      {error && <ErrorBox what="phone numbers" error={error} />}
      {numbers === null && !error && <div style={muted}>Loading...</div>}
      {numbers?.length === 0 && <EmptyState>No numbers are tracked yet. Add one above and connect it in Twilio.</EmptyState>}

      <div style={{ display: "grid", gap: 8, marginBottom: 26 }}>
        {numbers?.map((n) => (
          <div key={n.number} style={{ ...card, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <div style={{ flex: "1 1 240px", minWidth: 0 }}>
              <div style={{ fontWeight: 700, fontSize: 15 }}>{n.number}</div>
              <div style={{ ...muted, marginTop: 3 }}>
                {n.forward_to ? `rings ${n.forward_to} for ${n.ring_seconds}s` : "does not forward anywhere yet"}
                {n.client_slug ? ` · for ${n.client_slug}` : " · Wing's own"}
                {n.greeting ? ` · greeting: "${n.greeting}"` : " · no greeting"}
              </div>
            </div>
            <button onClick={() => startEdit(n)} disabled={busy} style={btnSmall}>Edit</button>
            <button onClick={() => remove(n)} disabled={busy} style={{ ...btnSmall, color: "var(--red)" }}>Remove</button>
          </div>
        ))}
      </div>

      <h2 style={{ fontSize: 16, fontWeight: 700, margin: "0 0 10px" }}>Recent calls</h2>
      {numbers !== null && calls.length === 0 && <EmptyState>No calls have come in on a tracked number yet.</EmptyState>}
      {calls.length > 0 && (
        <div style={{ ...card, overflowX: "auto", padding: 0 }}>
          <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 12.5 }}>
            <thead>
              <tr style={{ textAlign: "left", color: "var(--text-muted)" }}>
                <th style={th}>When</th>
                <th style={th}>What happened</th>
                <th style={th}>From</th>
                <th style={th}>To</th>
                <th style={th}>Length</th>
              </tr>
            </thead>
            <tbody>
              {calls.map((c) => {
                const st = callStatus(c.status);
                return (
                  <tr key={c.id} style={{ borderTop: "1px solid var(--border)" }}>
                    <td style={td}>{fmtWhen(c.started_at)}</td>
                    <td style={td}>
                      <StatusPill status={st.key} text={st.text} />
                      {c.direction === "outbound" ? <span style={{ ...muted, marginLeft: 6 }}>outbound</span> : null}
                    </td>
                    <td style={td}>{c.from_number || <span style={muted}>unknown</span>}</td>
                    <td style={td}>{c.to_number || <span style={muted}>unknown</span>}</td>
                    <td style={td}>{typeof c.duration_sec === "number" ? `${c.duration_sec}s` : <span style={muted}>not recorded</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const th: React.CSSProperties = { padding: "8px 12px", fontWeight: 600, whiteSpace: "nowrap" };
const td: React.CSSProperties = { padding: "8px 12px", verticalAlign: "top", whiteSpace: "nowrap" };
