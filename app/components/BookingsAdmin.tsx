"use client";
import { useEffect, useState } from "react";

// ───────────────────────────────────────────────────────────────────────────
// BookingsAdmin — the small staff board behind the public /book link.
//
// Upcoming bookings from /api/booking?admin=1 (staff-gated), one row each,
// with the three status buttons and a copyable public link. Honest states:
// an empty board says "no bookings yet", a broken read says what broke.
// ───────────────────────────────────────────────────────────────────────────

type BookingRow = {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  starts_at: string;
  ends_at: string;
  status: string;
  source: string;
  client_slug: string | null;
  notes: string | null;
  created_at: string;
};

const STATUS_COLOR: Record<string, string> = {
  confirmed: "var(--green)",
  completed: "var(--accent)",
  cancelled: "var(--text-muted)",
  no_show: "var(--red)",
};

function fmt(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/Chicago",
    timeZoneName: "short",
  });
}

export default function BookingsAdmin() {
  const [rows, setRows] = useState<BookingRow[] | null>(null);
  const [err, setErr] = useState("");
  const [busyId, setBusyId] = useState("");
  const [copied, setCopied] = useState(false);

  async function load() {
    try {
      const r = await fetch("/api/booking?admin=1");
      const d = await r.json();
      if (!r.ok) {
        setErr(d?.message || `Bookings read failed (HTTP ${r.status}).`);
        return;
      }
      setRows(d.bookings as BookingRow[]);
      setErr("");
    } catch (e) {
      setErr(String(e));
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function setStatus(id: string, status: string) {
    setBusyId(id);
    try {
      const r = await fetch("/api/booking", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, status }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        setErr(d?.message || `Update failed (HTTP ${r.status}).`);
        return;
      }
      await load();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusyId("");
    }
  }

  async function copyLink() {
    const link = `${window.location.origin}/book`;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard blocked: show the link so it can be copied by hand.
      setErr(`Copy blocked by the browser. The link is: ${link}`);
    }
  }

  return (
    <section style={{ ...card, display: "grid", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <strong style={{ fontSize: 14 }}>Bookings</strong>
        <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
          from the public booking link
        </span>
        <button
          type="button"
          onClick={copyLink}
          style={{ ...btn, marginLeft: "auto", borderColor: "var(--accent)", color: "var(--accent)" }}
        >
          {copied ? "Copied" : "Copy public link (/book)"}
        </button>
      </div>

      {err ? <p style={{ margin: 0, fontSize: 12, color: "var(--red)" }}>{err}</p> : null}
      {!rows && !err ? (
        <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)" }}>Loading…</p>
      ) : null}
      {rows && rows.length === 0 ? (
        <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)" }}>
          No upcoming bookings yet. Share the public link to get the first one.
        </p>
      ) : null}

      {(rows ?? []).map((b) => {
        const color = STATUS_COLOR[b.status] ?? "var(--text-muted)";
        const cancelled = b.status === "cancelled";
        return (
          <div
            key={b.id}
            style={{
              border: "1px solid var(--border)",
              borderLeft: `3px solid ${color}`,
              borderRadius: 10,
              padding: 10,
              display: "flex",
              gap: 10,
              alignItems: "center",
              flexWrap: "wrap",
              background: "var(--bg-secondary)",
              // Cancelled rows stay visible (so Restore works) but dimmed.
              opacity: cancelled ? 0.55 : 1,
            }}
          >
            <div style={{ display: "grid", gap: 2, minWidth: 160 }}>
              <span style={{ fontSize: 13, color: "var(--text-primary)", fontWeight: 600 }}>{b.name}</span>
              <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
                {[b.email, b.phone].filter(Boolean).join(" · ")}
              </span>
            </div>
            <span style={{ fontSize: 12, color: "var(--text-secondary)", fontVariantNumeric: "tabular-nums" }}>
              {fmt(b.starts_at)}
            </span>
            <span style={{ fontSize: 10, color, textTransform: "uppercase", letterSpacing: "0.06em" }}>
              {b.status.replace("_", " ")}
            </span>
            {b.notes ? (
              <span style={{ fontSize: 12, color: "var(--text-muted)", flexBasis: "100%" }}>{b.notes}</span>
            ) : null}
            <div style={{ display: "flex", gap: 6, marginLeft: "auto" }}>
              {b.status !== "completed" ? (
                <button
                  type="button"
                  disabled={busyId === b.id}
                  onClick={() => setStatus(b.id, "completed")}
                  style={{ ...btn, borderColor: "var(--green)", color: "var(--green)" }}
                >
                  Completed
                </button>
              ) : null}
              {b.status !== "no_show" ? (
                <button
                  type="button"
                  disabled={busyId === b.id}
                  onClick={() => setStatus(b.id, "no_show")}
                  style={{ ...btn, borderColor: "var(--orange)", color: "var(--orange)" }}
                >
                  No show
                </button>
              ) : null}
              {b.status !== "cancelled" ? (
                <button
                  type="button"
                  disabled={busyId === b.id}
                  onClick={() => setStatus(b.id, "cancelled")}
                  style={{ ...btn, borderColor: "var(--red)", color: "var(--red)" }}
                >
                  Cancel
                </button>
              ) : (
                <button
                  type="button"
                  disabled={busyId === b.id}
                  onClick={() => setStatus(b.id, "confirmed")}
                  style={btn}
                >
                  Restore
                </button>
              )}
            </div>
          </div>
        );
      })}
    </section>
  );
}

const card: React.CSSProperties = {
  background: "var(--bg-card)",
  border: "1px solid var(--border)",
  borderRadius: 14,
  padding: 16,
};

const btn: React.CSSProperties = {
  font: "inherit",
  background: "var(--bg-card)",
  border: "1px solid var(--border)",
  borderRadius: 8,
  color: "var(--text-secondary)",
  padding: "5px 10px",
  fontSize: 12,
  cursor: "pointer",
};
