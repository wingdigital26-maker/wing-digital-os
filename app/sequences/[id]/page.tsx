"use client";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

// /sequences/[id] — the editor. Each step reads as one plain-English sentence:
// "Wait N days, then send this email." Add, edit, delete, reorder. Merge tags
// {{first_name}} {{company}} {{city}} are explained inline.

type Seq = { id: string; name: string; status: string; description: string | null };
type Step = {
  id: string;
  step_order: number;
  wait_days: number;
  subject: string | null;
  body: string;
};
type Enrollment = { id: string; email: string; status: string };

export default function SequenceEditorPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id;

  const [seq, setSeq] = useState<Seq | null>(null);
  const [steps, setSteps] = useState<Step[]>([]);
  const [enrollments, setEnrollments] = useState<Enrollment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [form, setForm] = useState({ wait_days: "0", subject: "", body: "" });

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const r = await fetch(`/api/sequences?id=${encodeURIComponent(id)}`, { cache: "no-store" });
      const d = await r.json();
      if (!r.ok) throw new Error(d?.message || d?.error || `HTTP ${r.status}`);
      setSeq(d.sequence);
      setSteps(d.steps);
      setEnrollments(d.enrollments);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const call = async (fn: () => Promise<Response>) => {
    setBusy(true);
    setNotice(null);
    try {
      const r = await fn();
      const d = await r.json().catch(() => null);
      if (!r.ok) throw new Error(d?.message || `HTTP ${r.status}`);
      await load();
      return true;
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const saveStep = async () => {
    const payload = {
      wait_days: Number(form.wait_days),
      subject: form.subject,
      body: form.body,
    };
    const ok =
      editing === "new"
        ? await call(() =>
            fetch("/api/sequences/steps", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ sequence_id: id, ...payload }),
            })
          )
        : await call(() =>
            fetch("/api/sequences/steps", {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ id: editing, ...payload }),
            })
          );
    if (ok) setEditing(null);
  };

  const move = (stepId: string, dir: "up" | "down") =>
    call(() =>
      fetch("/api/sequences/steps", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: stepId, move: dir }),
      })
    );

  const removeStep = (stepId: string) => {
    if (!window.confirm("Delete this email from the sequence?")) return;
    call(() => fetch(`/api/sequences/steps?id=${encodeURIComponent(stepId)}`, { method: "DELETE" }));
  };

  const setStatus = (status: string) =>
    call(() =>
      fetch("/api/sequences", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, status }),
      })
    );

  const rename = () => {
    const name = window.prompt("Rename this sequence:", seq?.name ?? "");
    if (!name?.trim()) return;
    call(() =>
      fetch("/api/sequences", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, name: name.trim() }),
      })
    );
  };

  const removeSequence = async () => {
    if (!window.confirm("Delete this whole sequence and everyone enrolled on it? This cannot be undone.")) return;
    const ok = await call(() => fetch(`/api/sequences?id=${encodeURIComponent(id)}`, { method: "DELETE" }));
    if (ok) window.location.href = "/sequences";
  };

  if (error) {
    return <div style={{ ...card, borderColor: "var(--red)", fontSize: 13 }}>Could not load this sequence: {error}</div>;
  }
  if (!seq) return <div style={{ color: "var(--text-muted)", fontSize: 13 }}>Loading...</div>;

  const activeEnrolled = enrollments.filter((e) => e.status === "active").length;

  return (
    <div>
      <a href="/sequences" style={{ fontSize: 13, color: "var(--text-muted)", textDecoration: "none" }}>
        &larr; All sequences
      </a>

      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", margin: "10px 0 4px" }}>
        <h1 style={{ fontFamily: "'Space Grotesk',sans-serif", fontSize: 24, fontWeight: 700, margin: 0 }}>
          {seq.name}
        </h1>
        <span
          style={{
            fontSize: 12, fontWeight: 700, borderRadius: 999, padding: "3px 10px",
            color: seq.status === "active" ? "var(--green)" : seq.status === "paused" ? "var(--orange)" : "var(--text-muted)",
            border: `1px solid ${seq.status === "active" ? "var(--green)" : seq.status === "paused" ? "var(--orange)" : "var(--text-muted)"}`,
          }}
        >
          {seq.status === "active" ? "Active" : seq.status === "paused" ? "Paused" : "Draft"}
        </span>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          {seq.status === "active" ? (
            <button onClick={() => setStatus("paused")} disabled={busy} style={btn}>Pause</button>
          ) : (
            <button
              onClick={() => setStatus("active")}
              disabled={busy || steps.length === 0}
              title={steps.length === 0 ? "Add at least one email first" : undefined}
              style={btnPrimary}
            >
              Activate
            </button>
          )}
          <button onClick={rename} disabled={busy} style={btn}>Rename</button>
          <button onClick={removeSequence} disabled={busy} style={{ ...btn, color: "var(--red)" }}>Delete</button>
        </div>
      </div>
      <div style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 18 }}>
        {enrollments.length === 0 ? (
          <>Nobody is enrolled yet. <a href="/sequences/people" style={{ color: "inherit" }}>Add people on the People tab.</a></>
        ) : (
          <a href={`/sequences/people?sequence_id=${seq.id}`} style={{ color: "inherit" }}>
            {activeEnrolled} of {enrollments.length} enrolled people active. View them on the People tab.
          </a>
        )}
      </div>

      {notice && <div style={{ ...card, borderColor: "var(--orange)", marginBottom: 14, fontSize: 13 }}>{notice}</div>}

      {steps.length === 0 && editing !== "new" && (
        <div style={{ ...card, textAlign: "center", padding: 34, color: "var(--text-secondary)", fontSize: 14 }}>
          No emails in this sequence yet. Add the first one below.
        </div>
      )}

      <div style={{ display: "grid", gap: 10 }}>
        {steps.map((s, i) =>
          editing === s.id ? (
            <StepForm
              key={s.id}
              form={form}
              setForm={setForm}
              onSave={saveStep}
              onCancel={() => setEditing(null)}
              busy={busy}
              isFirst={i === 0}
            />
          ) : (
            <div key={s.id} style={card}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <span style={{ fontSize: 14, fontWeight: 700 }}>
                  {i === 0
                    ? s.wait_days === 0
                      ? "Right away, send this email"
                      : `Wait ${s.wait_days} day${s.wait_days === 1 ? "" : "s"} after enrolling, then send this email`
                    : s.wait_days === 0
                    ? "Immediately after the previous email, send this"
                    : `Wait ${s.wait_days} day${s.wait_days === 1 ? "" : "s"}, then send this email`}
                </span>
                <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
                  <button onClick={() => move(s.id, "up")} disabled={busy || i === 0} style={btnSmall}>Move up</button>
                  <button onClick={() => move(s.id, "down")} disabled={busy || i === steps.length - 1} style={btnSmall}>Move down</button>
                  <button
                    onClick={() => {
                      setForm({ wait_days: String(s.wait_days), subject: s.subject ?? "", body: s.body });
                      setEditing(s.id);
                    }}
                    disabled={busy}
                    style={btnSmall}
                  >
                    Edit
                  </button>
                  <button onClick={() => removeStep(s.id)} disabled={busy} style={{ ...btnSmall, color: "var(--red)" }}>
                    Delete
                  </button>
                </div>
              </div>
              <div style={{ marginTop: 10, fontSize: 13 }}>
                <div style={{ fontWeight: 600, marginBottom: 6 }}>
                  Subject: <span style={{ fontWeight: 500 }}>{s.subject || <em style={{ color: "var(--text-muted)" }}>no subject</em>}</span>
                </div>
                <pre
                  style={{
                    margin: 0, whiteSpace: "pre-wrap", fontFamily: "inherit",
                    color: "var(--text-secondary)", fontSize: 13, lineHeight: 1.5,
                  }}
                >
                  {s.body}
                </pre>
              </div>
            </div>
          )
        )}

        {editing === "new" ? (
          <StepForm
            form={form}
            setForm={setForm}
            onSave={saveStep}
            onCancel={() => setEditing(null)}
            busy={busy}
            isFirst={steps.length === 0}
          />
        ) : (
          <button
            onClick={() => {
              setForm({ wait_days: steps.length === 0 ? "0" : "2", subject: "", body: "" });
              setEditing("new");
            }}
            disabled={busy}
            style={{ ...btnPrimary, justifySelf: "start" }}
          >
            + Add an email
          </button>
        )}
      </div>

      <div style={{ ...card, marginTop: 20, fontSize: 12.5, color: "var(--text-secondary)" }}>
        <strong>Personalization tags:</strong> type these anywhere in a subject or body and they fill in per
        person when the email goes out: <code>{"{{first_name}}"}</code> (their first name, falls back to
        &quot;there&quot;), <code>{"{{company}}"}</code> (their company), <code>{"{{city}}"}</code> (their city).
        If a person is missing the data for a tag, that email is held instead of going out half-filled.
      </div>
    </div>
  );
}

function StepForm({
  form,
  setForm,
  onSave,
  onCancel,
  busy,
  isFirst,
}: {
  form: { wait_days: string; subject: string; body: string };
  setForm: (f: { wait_days: string; subject: string; body: string }) => void;
  onSave: () => void;
  onCancel: () => void;
  busy: boolean;
  isFirst: boolean;
}) {
  return (
    <div style={{ ...card, borderColor: "var(--accent)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", fontSize: 14 }}>
        <span>Wait</span>
        <input
          type="number"
          min={0}
          max={365}
          value={form.wait_days}
          onChange={(e) => setForm({ ...form, wait_days: e.target.value })}
          style={{ ...input, width: 70 }}
        />
        <span>day(s) {isFirst ? "after the person is enrolled" : "after the previous email"}, then send:</span>
      </div>
      <input
        value={form.subject}
        onChange={(e) => setForm({ ...form, subject: e.target.value })}
        placeholder="Subject line, e.g. quick idea for {{company}}"
        style={{ ...input, width: "100%", marginTop: 10 }}
      />
      <textarea
        value={form.body}
        onChange={(e) => setForm({ ...form, body: e.target.value })}
        placeholder={"The email itself. Start with Hi {{first_name}}, if you want it personalized."}
        rows={10}
        style={{ ...input, width: "100%", marginTop: 8, fontFamily: "inherit", lineHeight: 1.5, resize: "vertical" }}
      />
      <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
        <button onClick={onSave} disabled={busy || !form.body.trim()} style={btnPrimary}>Save email</button>
        <button onClick={onCancel} disabled={busy} style={btn}>Cancel</button>
      </div>
    </div>
  );
}

const card: React.CSSProperties = {
  background: "var(--bg-card)",
  border: "1px solid var(--border)",
  borderRadius: 12,
  padding: 16,
};
const btn: React.CSSProperties = {
  padding: "8px 14px",
  borderRadius: 9,
  border: "1px solid var(--border)",
  background: "var(--bg-hover)",
  color: "var(--text-primary)",
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
};
const btnPrimary: React.CSSProperties = {
  ...btn,
  background: "var(--accent)",
  border: "1px solid var(--accent)",
  color: "#fff",
};
const btnSmall: React.CSSProperties = { ...btn, padding: "5px 10px", fontSize: 12 };
const input: React.CSSProperties = {
  padding: "9px 12px",
  borderRadius: 9,
  border: "1px solid var(--border)",
  background: "var(--bg-card)",
  color: "var(--text-primary)",
  fontSize: 13.5,
  boxSizing: "border-box",
};
