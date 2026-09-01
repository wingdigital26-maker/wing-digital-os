"use client";
import { useEffect, useMemo, useState } from "react";

// ───────────────────────────────────────────────────────────────────────────
// /book — the PUBLIC self-serve booking page (GHL calendar replacement).
//
// No login. A prospect opens the link, picks a day, picks a 30-minute slot
// (Mon-Fri 9am-5pm Central), types name/email, and confirms. The row lands in
// public.bookings via /api/booking and shows up on the OS calendar's
// "Bookings" lane and the staff bookings board.
//
// All availability comes from the API; nothing here invents free time. Slot
// labels are Central Time on both sides by design: the API computes CT slots
// and this page shows the API's own labels, with the timezone named out loud.
// ───────────────────────────────────────────────────────────────────────────

type Slot = { starts_at: string; ends_at: string; label: string; available: boolean };
type Day = { date: string; slots: Slot[] };
type Payload = { timezone: string; from: string; to: string; days: Day[] };

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function dayLabel(ymd: string): { dow: string; date: string } {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return { dow: DOW[dt.getDay()], date: `${MONTHS[m - 1]} ${d}` };
}

export default function BookPage() {
  const [data, setData] = useState<Payload | null>(null);
  const [loadErr, setLoadErr] = useState("");
  const [pickedDay, setPickedDay] = useState<string | null>(null);
  const [pickedSlot, setPickedSlot] = useState<Slot | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [notes, setNotes] = useState("");
  const [sending, setSending] = useState(false);
  const [formErr, setFormErr] = useState("");
  const [done, setDone] = useState<{ label: string; date: string } | null>(null);

  async function load() {
    try {
      const r = await fetch("/api/booking");
      const d = await r.json();
      if (!r.ok) {
        setLoadErr(d?.message || `Could not load availability (HTTP ${r.status}).`);
        return;
      }
      setData(d as Payload);
      setLoadErr("");
    } catch (e) {
      setLoadErr(String(e));
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const days = useMemo(
    () => (data?.days ?? []).filter((d) => d.slots.length > 0),
    [data]
  );
  const openDay = days.find((d) => d.date === pickedDay) ?? null;

  // One less tap on a phone: the first day with an open slot starts selected.
  useEffect(() => {
    if (pickedDay || days.length === 0) return;
    const first = days.find((d) => d.slots.some((s) => s.available));
    if (first) setPickedDay(first.date);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days]);

  async function confirm() {
    if (!pickedSlot) return;
    setSending(true);
    setFormErr("");
    try {
      const r = await fetch("/api/booking", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          email,
          phone: phone || undefined,
          notes: notes || undefined,
          starts_at: pickedSlot.starts_at,
        }),
      });
      const out = await r.json().catch(() => ({}));
      if (!r.ok) {
        setFormErr(out?.message || `Booking failed (HTTP ${r.status}).`);
        if (r.status === 409 || r.status >= 500) {
          // Slot taken (409) or the save failed on the server (5xx, which can
          // also mean someone else won the slot): refresh availability and
          // have them re-pick so nobody keeps retrying a dead slot.
          setPickedSlot(null);
          await load();
        }
        return;
      }
      setDone({ label: pickedSlot.label, date: pickedDay ?? "" });
    } catch (e) {
      setFormErr(String(e));
    } finally {
      setSending(false);
    }
  }

  return (
    <main
      className="page-scroll"
      style={{
        minHeight: "100vh",
        background: "var(--bg-primary, #0d0e12)",
        color: "var(--text-primary, #eee)",
        padding: "24px 16px 60px",
        display: "flex",
        justifyContent: "center",
      }}
    >
      <div style={{ width: "100%", maxWidth: 560, display: "grid", gap: 16 }}>
        {/* Brand header */}
        <header style={{ textAlign: "center", display: "grid", gap: 6, padding: "12px 0" }}>
          <span style={{ fontSize: 12, letterSpacing: "0.18em", textTransform: "uppercase", color: "var(--accent)" }}>
            Wing Digital
          </span>
          <h1 style={{ margin: 0, fontSize: 24, fontWeight: 800 }}>Book a call</h1>
          <p style={{ margin: 0, fontSize: 13, color: "var(--text-secondary)" }}>
            Pick a day and a 30-minute slot. Monday to Friday, 9am to 5pm Central Time.
          </p>
        </header>

        {done ? (
          <section style={{ ...card, textAlign: "center", display: "grid", gap: 10, padding: 28 }}>
            <span style={{ fontSize: 34 }}>✓</span>
            <h2 style={{ margin: 0, fontSize: 18 }}>You are booked</h2>
            <p style={{ margin: 0, fontSize: 14, color: "var(--text-secondary)" }}>
              {dayLabel(done.date).dow}, {dayLabel(done.date).date} at {done.label} Central Time.
            </p>
            <p style={{ margin: 0, fontSize: 13, color: "var(--text-muted)" }}>
              Your spot is saved under {email}. We will reach out before the call. Need a different time? Reply to any message from us and we will move it.
            </p>
          </section>
        ) : (
          <>
            {loadErr ? (
              <section style={{ ...card, borderColor: "var(--red)" }}>
                <p style={{ margin: 0, fontSize: 13, color: "var(--red)" }}>{loadErr}</p>
              </section>
            ) : null}
            {!data && !loadErr ? (
              <section style={card}>
                <p style={{ margin: 0, fontSize: 13, color: "var(--text-muted)" }}>Loading available times…</p>
              </section>
            ) : null}

            {data && days.length === 0 && !loadErr ? (
              <section style={card}>
                <p style={{ margin: 0, fontSize: 13, color: "var(--text-muted)" }}>
                  No open slots in the next two weeks. Please check back soon.
                </p>
              </section>
            ) : null}

            {/* Step 1: day strip */}
            {days.length > 0 ? (
              <section style={{ ...card, display: "grid", gap: 10 }}>
                <strong style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--text-muted)" }}>
                  1. Pick a day
                </strong>
                <div style={{ display: "flex", gap: 8, overflowX: "auto", paddingBottom: 4 }}>
                  {days.map((d) => {
                    const l = dayLabel(d.date);
                    const free = d.slots.filter((s) => s.available).length;
                    const active = pickedDay === d.date;
                    return (
                      <button
                        key={d.date}
                        type="button"
                        onClick={() => {
                          setPickedDay(d.date);
                          setPickedSlot(null);
                        }}
                        disabled={free === 0}
                        style={{
                          font: "inherit",
                          minWidth: 76,
                          display: "grid",
                          gap: 2,
                          padding: "10px 8px",
                          borderRadius: 10,
                          cursor: free === 0 ? "not-allowed" : "pointer",
                          border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
                          background: active ? "var(--accent-glow, rgba(124,106,245,0.12))" : "var(--bg-card)",
                          color: free === 0 ? "var(--text-muted)" : "var(--text-primary)",
                          textAlign: "center",
                          opacity: free === 0 ? 0.5 : 1,
                        }}
                      >
                        <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{l.dow}</span>
                        <span style={{ fontSize: 14, fontWeight: 700 }}>{l.date}</span>
                        <span style={{ fontSize: 10, color: free ? "var(--green)" : "var(--text-muted)" }}>
                          {free ? `${free} open` : "full"}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </section>
            ) : null}

            {/* Step 2: slot grid */}
            {openDay ? (
              <section style={{ ...card, display: "grid", gap: 10 }}>
                <strong style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--text-muted)" }}>
                  2. Pick a time (Central)
                </strong>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(90px, 1fr))", gap: 8 }}>
                  {openDay.slots.map((s) => {
                    const active = pickedSlot?.starts_at === s.starts_at;
                    return (
                      <button
                        key={s.starts_at}
                        type="button"
                        disabled={!s.available}
                        onClick={() => setPickedSlot(s)}
                        style={{
                          font: "inherit",
                          padding: "9px 4px",
                          borderRadius: 8,
                          fontSize: 13,
                          cursor: s.available ? "pointer" : "not-allowed",
                          border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
                          background: active
                            ? "var(--accent)"
                            : s.available
                            ? "var(--bg-card)"
                            : "var(--bg-secondary, transparent)",
                          color: active ? "#fff" : s.available ? "var(--text-primary)" : "var(--text-muted)",
                          textDecoration: s.available ? "none" : "line-through",
                        }}
                      >
                        {s.label}
                      </button>
                    );
                  })}
                </div>
              </section>
            ) : null}

            {/* Step 3: details + confirm */}
            {pickedSlot && pickedDay ? (
              <section style={{ ...card, display: "grid", gap: 10 }}>
                <strong style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--text-muted)" }}>
                  3. Your details
                </strong>
                <label style={label}>
                  Name
                  <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" style={input} />
                </label>
                <label style={label}>
                  Email
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@company.com"
                    style={input}
                  />
                </label>
                <label style={label}>
                  Phone (optional)
                  <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="(555) 555-5555" style={input} />
                </label>
                <label style={label}>
                  Anything we should know? (optional)
                  <textarea
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    rows={3}
                    style={{ ...input, resize: "vertical" }}
                  />
                </label>
                {formErr ? <p style={{ margin: 0, fontSize: 12, color: "var(--red)" }}>{formErr}</p> : null}
                <button
                  type="button"
                  onClick={confirm}
                  disabled={sending || !name.trim() || !email.trim()}
                  style={{
                    font: "inherit",
                    padding: "12px 16px",
                    borderRadius: 10,
                    fontSize: 15,
                    fontWeight: 700,
                    border: "1px solid var(--accent)",
                    background: "var(--accent)",
                    color: "#fff",
                    cursor: sending ? "wait" : "pointer",
                    opacity: sending || !name.trim() || !email.trim() ? 0.6 : 1,
                  }}
                >
                  {sending
                    ? "Booking…"
                    : `Confirm ${dayLabel(pickedDay).dow} ${dayLabel(pickedDay).date} at ${pickedSlot.label} CT`}
                </button>
              </section>
            ) : null}
          </>
        )}

        <footer style={{ textAlign: "center", fontSize: 11, color: "var(--text-muted)" }}>
          Wing Digital · All times shown in Central Time
        </footer>
      </div>
    </main>
  );
}

const card: React.CSSProperties = {
  background: "var(--bg-card)",
  border: "1px solid var(--border)",
  borderRadius: 14,
  padding: 16,
};

const label: React.CSSProperties = {
  display: "grid",
  gap: 4,
  fontSize: 11,
  color: "var(--text-muted)",
  textTransform: "uppercase",
  letterSpacing: "0.05em",
};

const input: React.CSSProperties = {
  font: "inherit",
  fontSize: 14,
  color: "var(--text-primary)",
  background: "var(--bg-secondary, transparent)",
  border: "1px solid var(--border)",
  borderRadius: 8,
  padding: "10px 12px",
  width: "100%",
};
