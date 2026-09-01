"use client";
import { useCallback, useEffect, useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";

// /sequences/people — everyone enrolled on any sequence: which email they are
// waiting on, when it goes out, one-click Pause / Resume / Remove. Plus the
// manual "Add person" form. Enrollment is manual-only in this round.

type Enrollment = {
  id: string;
  sequence_id: string;
  email: string;
  name: string | null;
  company: string | null;
  current_step: number;
  status: string;
  next_send_at: string | null;
  sequences: { name: string; status: string } | null;
};

type SeqOption = { id: string; name: string; status: string; stepCount: number };

function PeopleInner() {
  const search = useSearchParams();
  const filterSeq = search?.get("sequence_id") ?? null;

  const [rows, setRows] = useState<Enrollment[] | null>(null);
  const [seqs, setSeqs] = useState<SeqOption[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ sequence_id: "", email: "", name: "", company: "" });

  const load = useCallback(async () => {
    try {
      const qs = filterSeq ? `?sequence_id=${encodeURIComponent(filterSeq)}` : "";
      const [er, sr] = await Promise.all([
        fetch(`/api/sequences/enrollments${qs}`, { cache: "no-store" }),
        fetch("/api/sequences", { cache: "no-store" }),
      ]);
      const ed = await er.json();
      const sd = await sr.json();
      if (!er.ok) throw new Error(ed?.message || ed?.error || `HTTP ${er.status}`);
      if (!sr.ok) throw new Error(sd?.message || sd?.error || `HTTP ${sr.status}`);
      setRows(ed.enrollments);
      setSeqs(sd.sequences);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [filterSeq]);

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

  const addPerson = async () => {
    const ok = await call(() =>
      fetch("/api/sequences/enrollments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      })
    );
    if (ok) setForm({ ...form, email: "", name: "", company: "" });
  };

  const act = (id: string, action: "pause" | "resume") =>
    call(() =>
      fetch("/api/sequences/enrollments", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, action }),
      })
    );

  const remove = (id: string, email: string) => {
    if (!window.confirm(`Remove ${email} from this sequence? They will get no further emails from it.`)) return;
    call(() => fetch(`/api/sequences/enrollments?id=${encodeURIComponent(id)}`, { method: "DELETE" }));
  };

  const filterName = filterSeq ? seqs.find((s) => s.id === filterSeq)?.name : null;

  return (
    <div>
      <h1 style={{ fontFamily: "'Space Grotesk',sans-serif", fontSize: 24, fontWeight: 700, margin: "0 0 4px" }}>
        People on sequences
      </h1>
      <div style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 18 }}>
        {filterName ? (
          <>
            Showing only people on <strong>{filterName}</strong>.{" "}
            <a href="/sequences/people" style={{ color: "inherit" }}>Show everyone</a>
          </>
        ) : (
          "Who is on which sequence, which email they get next, and when."
        )}
      </div>

      <div style={{ ...card, marginBottom: 18 }}>
        <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 10 }}>Add a person</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <select
            value={form.sequence_id}
            onChange={(e) => setForm({ ...form, sequence_id: e.target.value })}
            style={{ ...input, minWidth: 200 }}
          >
            <option value="">Pick a sequence...</option>
            {seqs.map((s) => (
              <option key={s.id} value={s.id} disabled={s.stepCount === 0}>
                {s.name}
                {s.stepCount === 0 ? " (no emails yet)" : ""}
              </option>
            ))}
          </select>
          <input
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
            placeholder="Email address (required)"
            style={{ ...input, minWidth: 220 }}
          />
          <input
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="Name (for {{first_name}})"
            style={{ ...input, minWidth: 170 }}
          />
          <input
            value={form.company}
            onChange={(e) => setForm({ ...form, company: e.target.value })}
            placeholder="Company (for {{company}})"
            style={{ ...input, minWidth: 170 }}
          />
          <button onClick={addPerson} disabled={busy || !form.sequence_id || !form.email.trim()} style={btnPrimary}>
            Add person
          </button>
        </div>
        <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 8 }}>
          Adding someone schedules their first email; nothing is sent from this dashboard. Adding people is
          manual for now. Pulling people in from prospect lists automatically is a later step.
        </div>
      </div>

      {notice && <div style={{ ...card, borderColor: "var(--orange)", marginBottom: 14, fontSize: 13 }}>{notice}</div>}
      {error && (
        <div style={{ ...card, borderColor: "var(--red)", marginBottom: 14, fontSize: 13 }}>
          Could not load people: {error}
        </div>
      )}
      {rows === null && !error && <div style={{ color: "var(--text-muted)", fontSize: 13 }}>Loading...</div>}

      {rows?.length === 0 && (
        <div style={{ ...card, textAlign: "center", padding: 40, color: "var(--text-secondary)", fontSize: 14 }}>
          Nobody is on {filterName ? "this sequence" : "any sequence"} yet. Add someone above.
        </div>
      )}

      <div style={{ display: "grid", gap: 8 }}>
        {rows?.map((r) => (
          <div key={r.id} style={{ ...card, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <div style={{ flex: "1 1 240px" }}>
              <div style={{ fontWeight: 700, fontSize: 14 }}>
                {r.name || r.email}
                {r.company ? <span style={{ fontWeight: 500, color: "var(--text-muted)" }}> · {r.company}</span> : null}
              </div>
              <div style={{ fontSize: 12.5, color: "var(--text-muted)", marginTop: 2 }}>
                {r.email} · on {r.sequences?.name ?? "unknown sequence"}
              </div>
            </div>
            <div style={{ fontSize: 12.5, color: "var(--text-secondary)", flex: "1 1 220px" }}>
              {describeState(r, seqs.find((s) => s.id === r.sequence_id)?.stepCount)}
            </div>
            <StatusPill status={r.status} />
            {r.status === "active" && (
              <button onClick={() => act(r.id, "pause")} disabled={busy} style={btnSmall}>Pause</button>
            )}
            {r.status === "paused" && (
              <button onClick={() => act(r.id, "resume")} disabled={busy} style={btnSmall}>Resume</button>
            )}
            <button onClick={() => remove(r.id, r.email)} disabled={busy} style={{ ...btnSmall, color: "var(--red)" }}>
              Remove
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function PeoplePage() {
  return (
    <Suspense fallback={<div style={{ color: "var(--text-muted)", fontSize: 13 }}>Loading...</div>}>
      <PeopleInner />
    </Suspense>
  );
}

// "Email 2 of 3 goes out Thursday" — friendly, no timestamps unless needed.
function friendlyWhen(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "on an unknown date";
  const now = new Date();
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOfDay(d) - startOfDay(now)) / 86400000);
  if (days <= 0) return "the next time the sender runs";
  if (days === 1) return "tomorrow";
  if (days < 7) return d.toLocaleDateString(undefined, { weekday: "long" });
  return `on ${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
}

function describeState(r: Enrollment, totalSteps?: number): string {
  const ofTotal = totalSteps ? ` of ${totalSteps}` : "";
  if (r.status === "completed") return `Got every email. All done.`;
  if (r.status === "replied") return `Replied after email ${r.current_step}${ofTotal}, so the rest are stopped.`;
  if (r.status === "unsubscribed") return `Unsubscribed after email ${r.current_step}${ofTotal}. No more emails.`;
  if (r.status === "bounced") return `Their address bounced. No more emails.`;
  if (r.status !== "active" && r.status !== "paused")
    return `Stopped (${r.status}) after ${r.current_step} email${r.current_step === 1 ? "" : "s"}.`;
  const nextNum = r.current_step + 1;
  if (r.status === "paused") return `Paused before email ${nextNum}${ofTotal}. Resume to continue.`;
  const when = r.next_send_at ? friendlyWhen(r.next_send_at) : "once a send date is set";
  const held = r.sequences?.status !== "active" ? " Held for now because the sequence is not active." : "";
  return `Email ${nextNum}${ofTotal} goes out ${when}.${held}`;
}

function StatusPill({ status }: { status: string }) {
  const color =
    status === "active" ? "var(--green)"
    : status === "paused" ? "var(--orange)"
    : status === "completed" ? "var(--text-muted)"
    : "var(--red)";
  const label =
    status === "active" ? "Getting emails"
    : status === "paused" ? "Paused"
    : status === "completed" ? "Finished"
    : status === "replied" ? "Replied"
    : status === "unsubscribed" ? "Unsubscribed"
    : status === "bounced" ? "Bounced"
    : status;
  return (
    <span style={{ fontSize: 12, fontWeight: 700, color, border: `1px solid ${color}`, borderRadius: 999, padding: "3px 10px" }}>
      {label}
    </span>
  );
}

const card: React.CSSProperties = {
  background: "var(--bg-card)",
  border: "1px solid var(--border)",
  borderRadius: 12,
  padding: 14,
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
};
