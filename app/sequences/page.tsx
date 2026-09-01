"use client";
import { useCallback, useEffect, useState } from "react";

// /sequences — the list. Plain English everywhere: a sequence is "a series of
// emails sent on a schedule". One click to Activate or Pause; clicking a row
// opens the editor. Activating never sends anything from the OS — it only
// lets the external sender see this sequence's due people.

type SeqItem = {
  id: string;
  name: string;
  status: string;
  description: string | null;
  client_slug: string | null;
  stepCount: number;
  enrolledTotal: number;
  enrolledActive: number;
};

export default function SequencesPage() {
  const [items, setItems] = useState<SeqItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/sequences", { cache: "no-store" });
      const d = await r.json();
      if (!r.ok) throw new Error(d?.message || d?.error || `HTTP ${r.status}`);
      setItems(d.sequences);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const setStatus = async (id: string, status: string) => {
    setBusy(id);
    try {
      const r = await fetch("/api/sequences", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, status }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d?.message || `HTTP ${r.status}`);
      await load();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const create = async () => {
    const name = newName.trim();
    if (!name) return;
    setBusy("create");
    try {
      const r = await fetch("/api/sequences", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d?.message || `HTTP ${r.status}`);
      window.location.href = `/sequences/${d.sequence.id}`;
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
      setBusy(null);
    }
  };

  const seed = async () => {
    setBusy("seed");
    try {
      const r = await fetch("/api/sequences/seed", { method: "POST" });
      const d = await r.json();
      if (!r.ok) throw new Error(d?.message || `HTTP ${r.status}`);
      setNotice(d.seeded ? "Imported the current cold email cadence as a draft." : d.reason);
      await load();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
        <h1 style={{ fontFamily: "'Space Grotesk',sans-serif", fontSize: 24, fontWeight: 700, margin: 0 }}>
          Email sequences
        </h1>
        <span style={{ fontSize: 13, color: "var(--text-secondary)" }}>
          A sequence is a series of emails sent on a schedule: wait some days, send an email, repeat.
        </span>
      </div>

      <div style={{ display: "flex", gap: 8, margin: "18px 0", flexWrap: "wrap" }}>
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && create()}
          placeholder="Name a new sequence, e.g. Warehouse follow-up"
          style={{ ...input, minWidth: 280, flex: "1 1 280px" }}
        />
        <button onClick={create} disabled={busy === "create" || !newName.trim()} style={btnPrimary}>
          Create sequence
        </button>
        <button onClick={seed} disabled={busy === "seed"} style={btn}>
          Seed from current cadence
        </button>
      </div>

      {notice && (
        <div style={{ ...card, borderColor: "var(--orange)", marginBottom: 14, fontSize: 13 }}>{notice}</div>
      )}
      {error && (
        <div style={{ ...card, borderColor: "var(--red)", marginBottom: 14, fontSize: 13 }}>
          Could not load sequences: {error}
        </div>
      )}

      {items === null && !error && <div style={{ color: "var(--text-muted)", fontSize: 13 }}>Loading...</div>}

      {items?.length === 0 && (
        <div style={{ ...card, textAlign: "center", padding: 40, color: "var(--text-secondary)", fontSize: 14 }}>
          No sequences yet. Create one or click Seed to import your current cold email cadence.
        </div>
      )}

      <div style={{ display: "grid", gap: 10 }}>
        {items?.map((s) => (
          <div key={s.id} style={{ ...card, display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
            <a href={`/sequences/${s.id}`} style={{ textDecoration: "none", color: "inherit", flex: "1 1 260px" }}>
              <div style={{ fontWeight: 700, fontSize: 15 }}>{s.name}</div>
              <div style={{ fontSize: 12.5, color: "var(--text-muted)", marginTop: 3 }}>
                {s.stepCount === 0
                  ? "No emails in it yet"
                  : `${s.stepCount} email${s.stepCount === 1 ? "" : "s"}`}
                {" · "}
                {s.enrolledTotal === 0
                  ? "nobody enrolled"
                  : `${s.enrolledActive} of ${s.enrolledTotal} enrolled and active`}
              </div>
            </a>
            <StatusPill status={s.status} />
            {s.status === "active" ? (
              <button onClick={() => setStatus(s.id, "paused")} disabled={busy === s.id} style={btn}>
                Pause
              </button>
            ) : (
              <button
                onClick={() => setStatus(s.id, "active")}
                disabled={busy === s.id || s.stepCount === 0}
                title={s.stepCount === 0 ? "Add at least one email first" : undefined}
                style={btnPrimary}
              >
                Activate
              </button>
            )}
            <a href={`/sequences/${s.id}`} style={{ ...btn, textDecoration: "none" }}>
              Edit
            </a>
          </div>
        ))}
      </div>

      <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 20 }}>
        This dashboard never sends email. Activating a sequence only lets the separate sending machine pick up
        due emails; pausing hides them again.
      </p>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const color = status === "active" ? "var(--green)" : status === "paused" ? "var(--orange)" : "var(--text-muted)";
  const label = status === "active" ? "Active" : status === "paused" ? "Paused" : "Draft";
  return (
    <span
      style={{
        fontSize: 12, fontWeight: 700, color,
        border: `1px solid ${color}`, borderRadius: 999, padding: "3px 10px",
      }}
    >
      {label}
    </span>
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
const input: React.CSSProperties = {
  padding: "9px 12px",
  borderRadius: 9,
  border: "1px solid var(--border)",
  background: "var(--bg-card)",
  color: "var(--text-primary)",
  fontSize: 13.5,
};
