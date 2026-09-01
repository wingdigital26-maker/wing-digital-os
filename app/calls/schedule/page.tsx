"use client";
import { useCallback, useEffect, useMemo, useState } from "react";

// Team Schedule — one shared week calendar for Jack, Grant, and Maddox.
// Everyone in the call room can see it and add to it; booked sales calls are
// overlaid automatically so nobody has to text call times around.
//
// Page chrome (header, nav, container) belongs to app/calls/layout.tsx.

type Ev = {
  id: string;
  kind: "block" | "call" | "booking";
  title: string;
  person: string;
  date: string;   // YYYY-MM-DD
  start: string;  // HH:MM
  end: string | null;
  category: string | null;
  weekly: boolean;
  detail: string | null;
  blockId: string | null;
};

type Feed = {
  from: string;
  to: string;
  events: Ev[];
  problems: string[];
  me: { email: string; person: string | null };
};

const PERSON_COLOR: Record<string, string> = {
  jack: "#22d3ee",
  grant: "#a78bfa",
  maddox: "#22c55e",
  team: "#94a3b8",
};
const PERSON_LABEL: Record<string, string> = {
  jack: "Jack",
  grant: "Grant",
  maddox: "Maddox",
  team: "Team",
};
const CALL_COLOR = "#f97316"; // loud accent for booked calls

const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}

function mondayOf(d: Date): Date {
  const m = new Date(d);
  m.setHours(0, 0, 0, 0);
  m.setDate(m.getDate() - ((m.getDay() + 6) % 7));
  return m;
}

function fmt12(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  const ap = h >= 12 ? "pm" : "am";
  const hh = h % 12 || 12;
  return m ? `${hh}:${String(m).padStart(2, "0")}${ap}` : `${hh}${ap}`;
}

export default function TeamSchedule() {
  const [weekStart, setWeekStart] = useState<Date>(() => mondayOf(new Date()));
  const [feed, setFeed] = useState<Feed | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [formOpen, setFormOpen] = useState(false);

  // Add form
  const [title, setTitle] = useState("");
  const [person, setPerson] = useState("");
  const [day, setDay] = useState(ymd(new Date()));
  const [start, setStart] = useState("09:00");
  const [end, setEnd] = useState("10:00");
  const [weekly, setWeekly] = useState(false);
  const [category, setCategory] = useState("work");

  const from = ymd(weekStart);
  const to = useMemo(() => {
    const t = new Date(weekStart);
    t.setDate(t.getDate() + 6);
    return ymd(t);
  }, [weekStart]);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/calls/schedule?from=${from}&to=${to}`, { cache: "no-store" });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) {
        setError(body.error ?? `Could not load the schedule (HTTP ${r.status})`);
        setFeed(null);
      } else {
        setFeed(body as Feed);
        setError(null);
        if (!person && (body as Feed).me?.person) setPerson((body as Feed).me.person as string);
      }
    } catch {
      setError("Could not reach the server.");
    }
    setLoading(false);
  }, [from, to, person]);

  useEffect(() => {
    setLoading(true);
    load();
  }, [load]);

  const days = useMemo(() => {
    const out: { key: string; label: string; date: Date }[] = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(weekStart);
      d.setDate(d.getDate() + i);
      out.push({ key: ymd(d), label: `${DAY_NAMES[i]} ${d.getMonth() + 1}/${d.getDate()}`, date: d });
    }
    return out;
  }, [weekStart]);

  const byDay = useMemo(() => {
    const m: Record<string, Ev[]> = {};
    for (const e of feed?.events ?? []) (m[e.date] ??= []).push(e);
    return m;
  }, [feed]);

  const todayKey = ymd(new Date());

  async function addBlock() {
    if (!title.trim()) {
      setError("Give the block a title.");
      return;
    }
    if (!person) {
      setError("Pick whose time this is.");
      return;
    }
    setBusy(true);
    try {
      const r = await fetch("/api/calls/schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: title.trim(), person, date: day, start, end, weekly, category }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) setError(body.error ?? "Could not save the block.");
      else {
        setError(null);
        setTitle("");
        setFormOpen(false);
        await load();
      }
    } catch {
      setError("Could not reach the server.");
    }
    setBusy(false);
  }

  async function removeBlock(e: Ev) {
    if (!e.blockId) return;
    const msg = e.weekly
      ? `Delete "${e.title}"? It repeats weekly — this removes every week of it.`
      : `Delete "${e.title}"?`;
    if (!window.confirm(msg)) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/calls/schedule?id=${e.blockId}`, { method: "DELETE" });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) setError(body.error ?? "Could not delete the block.");
      else {
        setError(null);
        await load();
      }
    } catch {
      setError("Could not reach the server.");
    }
    setBusy(false);
  }

  function shiftWeek(n: number) {
    const d = new Date(weekStart);
    d.setDate(d.getDate() + n * 7);
    setWeekStart(d);
  }

  return (
    <div>
      {/* Header row */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 14 }}>
        <h1 style={{ fontSize: 19, fontWeight: 800, margin: 0 }}>Team schedule</h1>
        <span style={{ fontSize: 12.5, color: "var(--text-muted)" }}>
          {from} → {to}
        </span>
        <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
          <button onClick={() => shiftWeek(-1)} style={btn} disabled={busy}>← Prev</button>
          <button onClick={() => setWeekStart(mondayOf(new Date()))} style={btn} disabled={busy}>Today</button>
          <button onClick={() => shiftWeek(1)} style={btn} disabled={busy}>Next →</button>
          <button
            onClick={() => setFormOpen((v) => !v)}
            style={{ ...btn, background: "#22d3ee", color: "#04222a", border: "1px solid #22d3ee" }}
            disabled={busy}
          >
            {formOpen ? "Close" : "+ Add"}
          </button>
        </div>
      </div>

      {/* Legend */}
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 14, fontSize: 12.5 }}>
        {Object.keys(PERSON_LABEL).map((p) => (
          <span key={p} style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <span style={{ width: 10, height: 10, borderRadius: 3, background: PERSON_COLOR[p] }} />
            {PERSON_LABEL[p]}
          </span>
        ))}
        <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <span style={{ width: 10, height: 10, borderRadius: 3, background: CALL_COLOR }} />
          Booked call
        </span>
      </div>

      {error && (
        <div style={{ padding: "10px 14px", borderRadius: 10, border: "1px solid #ef4444", color: "#ef4444", fontSize: 13, marginBottom: 12 }}>
          {error}
        </div>
      )}
      {feed?.problems?.map((p) => (
        <div key={p} style={{ padding: "8px 12px", borderRadius: 10, border: "1px solid #eab308", color: "#eab308", fontSize: 12.5, marginBottom: 10 }}>
          {p}
        </div>
      ))}

      {/* Add form */}
      {formOpen && (
        <div
          style={{
            border: "1px solid var(--border)", borderRadius: 12, padding: 14, marginBottom: 16,
            display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end",
            background: "var(--bg-hover)",
          }}
        >
          <label style={lab}>
            What
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Practice, Work shift" style={inp} />
          </label>
          <label style={lab}>
            Who
            <select value={person} onChange={(e) => setPerson(e.target.value)} style={inp}>
              <option value="">Pick…</option>
              <option value="jack">Jack</option>
              <option value="grant">Grant</option>
              <option value="maddox">Maddox</option>
              <option value="team">Whole team</option>
            </select>
          </label>
          <label style={lab}>
            Day
            <input type="date" value={day} onChange={(e) => setDay(e.target.value)} style={inp} />
          </label>
          <label style={lab}>
            Start
            <input type="time" value={start} onChange={(e) => setStart(e.target.value)} style={inp} />
          </label>
          <label style={lab}>
            End
            <input type="time" value={end} onChange={(e) => setEnd(e.target.value)} style={inp} />
          </label>
          <label style={lab}>
            Type
            <select value={category} onChange={(e) => setCategory(e.target.value)} style={inp}>
              <option value="work">Work</option>
              <option value="study">Class / study</option>
              <option value="call">Calls</option>
              <option value="personal">Personal</option>
              <option value="other">Other</option>
            </select>
          </label>
          <label style={{ ...lab, flexDirection: "row", alignItems: "center", gap: 7 }}>
            <input type="checkbox" checked={weekly} onChange={(e) => setWeekly(e.target.checked)} />
            Repeats every week
          </label>
          <button onClick={addBlock} disabled={busy} style={{ ...btn, background: "#22c55e", color: "#03210f", border: "1px solid #22c55e" }}>
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      )}

      {/* Week grid — columns on desktop, stacked days on phones */}
      {loading ? (
        <div style={{ color: "var(--text-muted)", fontSize: 13 }}>Loading the week…</div>
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
            gap: 8,
          }}
        >
          {days.map((d) => {
            const evs = byDay[d.key] ?? [];
            const isToday = d.key === todayKey;
            return (
              <div
                key={d.key}
                style={{
                  border: `1px solid ${isToday ? "#22d3ee" : "var(--border)"}`,
                  borderRadius: 12,
                  padding: 8,
                  minHeight: 90,
                  background: isToday ? "color-mix(in srgb, #22d3ee 6%, transparent)" : "transparent",
                }}
              >
                <div style={{ fontSize: 12, fontWeight: 800, marginBottom: 6, color: isToday ? "#22d3ee" : "var(--text-muted)" }}>
                  {d.label}
                  {isToday ? " · today" : ""}
                </div>
                {evs.length === 0 && (
                  <div style={{ fontSize: 11.5, color: "var(--text-muted)" }}>Free</div>
                )}
                {evs.map((e) => {
                  const isCall = e.kind !== "block";
                  const tone = isCall ? CALL_COLOR : PERSON_COLOR[e.person] ?? PERSON_COLOR.team;
                  return (
                    <div
                      key={e.id}
                      style={{
                        borderLeft: `3px solid ${tone}`,
                        border: isCall ? `1.5px solid ${tone}` : undefined,
                        borderLeftWidth: 3,
                        borderRadius: 8,
                        padding: "5px 7px",
                        marginBottom: 5,
                        background: `color-mix(in srgb, ${tone} ${isCall ? 16 : 9}%, transparent)`,
                        fontSize: 12,
                      }}
                    >
                      <div style={{ display: "flex", gap: 5, alignItems: "baseline" }}>
                        <span style={{ fontWeight: isCall ? 800 : 700, flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>
                          {e.title}
                        </span>
                        {e.blockId && (
                          <button
                            onClick={() => removeBlock(e)}
                            disabled={busy}
                            title="Delete this block"
                            style={{
                              border: "none", background: "transparent", color: "var(--text-muted)",
                              cursor: "pointer", fontSize: 12, lineHeight: 1, padding: 2,
                            }}
                          >
                            ✕
                          </button>
                        )}
                      </div>
                      <div style={{ color: "var(--text-muted)", fontSize: 11 }}>
                        {fmt12(e.start)}
                        {e.end ? `–${fmt12(e.end)}` : ""} · {isCall ? "sales call" : PERSON_LABEL[e.person] ?? e.person}
                        {e.weekly ? " · weekly" : ""}
                      </div>
                      {e.detail && (
                        <div style={{ color: "var(--text-muted)", fontSize: 10.5, overflowWrap: "anywhere" }}>{e.detail}</div>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}

      <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 16 }}>
        Everyone on the team sees the same board. Booked sales calls appear here on their own —
        no need to text call times. Click ✕ on a block to delete it.
      </p>
    </div>
  );
}

const btn: React.CSSProperties = {
  padding: "7px 12px",
  borderRadius: 9,
  border: "1px solid var(--border)",
  background: "var(--bg-hover)",
  color: "var(--text-primary)",
  fontSize: 12.5,
  fontWeight: 600,
  cursor: "pointer",
  whiteSpace: "nowrap",
};

const lab: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  fontSize: 11.5,
  fontWeight: 700,
  color: "var(--text-muted)",
};

const inp: React.CSSProperties = {
  padding: "7px 9px",
  borderRadius: 8,
  border: "1px solid var(--border)",
  background: "var(--bg-primary)",
  color: "var(--text-primary)",
  fontSize: 13,
  minWidth: 110,
};
