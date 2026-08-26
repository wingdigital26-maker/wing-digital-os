"use client";
import { useState } from "react";

interface Appointment {
  id: string;
  title: string;
  contactName: string;
  contactId: string;
  startTime: string;
  endTime: string;
  status: string;
}

const HOURS = Array.from({ length: 13 }, (_, i) => i + 7); // 7am - 7pm
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const STATUS_COLOR: Record<string, string> = {
  confirmed: "var(--green)",
  booked: "var(--accent)",
  showed: "var(--accent)",
  noshow: "var(--red)",
  cancelled: "#6b7280",
};

function getWeekDays(offset = 0): Date[] {
  const now = new Date();
  const sunday = new Date(now);
  sunday.setDate(now.getDate() - now.getDay() + offset * 7);
  sunday.setHours(0, 0, 0, 0);
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(sunday);
    d.setDate(sunday.getDate() + i);
    return d;
  });
}

function fmt12(date: Date) {
  let h = date.getHours(), m = date.getMinutes();
  const ampm = h >= 12 ? "pm" : "am";
  h = h % 12 || 12;
  return `${h}:${m.toString().padStart(2, "0")}${ampm}`;
}

export default function WeekCalendar({ appointments, locationId }: { appointments: Appointment[]; locationId: string }) {
  const [weekOffset, setWeekOffset] = useState(0);
  const [selected, setSelected] = useState<Appointment | null>(null);
  const days = getWeekDays(weekOffset);
  const today = new Date();

  // Map appointments to their day slot
  function apptForDay(day: Date) {
    return appointments.filter(a => {
      if (!a.startTime) return false;
      const d = new Date(a.startTime);
      return d.getFullYear() === day.getFullYear() &&
        d.getMonth() === day.getMonth() &&
        d.getDate() === day.getDate();
    });
  }

  function topPct(date: Date) {
    const h = date.getHours() + date.getMinutes() / 60;
    return Math.max(0, ((h - 7) / 13) * 100);
  }

  function heightPct(start: Date, end: Date) {
    const dur = (end.getTime() - start.getTime()) / (1000 * 60 * 60);
    return Math.max(2, (dur / 13) * 100);
  }

  const ghlBase = `https://app.gohighlevel.com/v2/location/${locationId}`;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 0, background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 14, overflow: "hidden" }}>

      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 20px", borderBottom: "1px solid var(--border)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <button onClick={() => setWeekOffset(w => w - 1)} style={navBtn}>‹</button>
          <span style={{ fontSize: 14, fontWeight: 700 }}>
            {weekOffset === 0 ? "This Week" : weekOffset === 1 ? "Next Week" : weekOffset === -1 ? "Last Week" :
              `${days[0].toLocaleDateString("en-US", { month: "short", day: "numeric" })} – ${days[6].toLocaleDateString("en-US", { month: "short", day: "numeric" })}`}
          </span>
          <button onClick={() => setWeekOffset(w => w + 1)} style={navBtn}>›</button>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {weekOffset !== 0 && (
            <button onClick={() => setWeekOffset(0)} style={{ fontSize: 11, color: "var(--accent)", background: "var(--accent-glow)", border: "1px solid var(--accent)", borderRadius: 6, padding: "3px 10px", cursor: "pointer" }}>
              Today
            </button>
          )}
          <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{appointments.length} appts this week</span>
        </div>
      </div>

      {/* Day headers */}
      <div style={{ display: "grid", gridTemplateColumns: "48px repeat(7, 1fr)", borderBottom: "1px solid var(--border)" }}>
        <div />
        {days.map((day, i) => {
          const isToday = day.toDateString() === today.toDateString();
          return (
            <div key={i} style={{ padding: "8px 4px", textAlign: "center", borderLeft: "1px solid var(--border)" }}>
              <p style={{ fontSize: 10, color: "var(--text-muted)", textTransform: "uppercase" }}>{DAYS[i]}</p>
              <p style={{
                fontSize: 16, fontWeight: 700, marginTop: 2,
                color: isToday ? "#fff" : "var(--text-primary)",
                background: isToday ? "var(--accent)" : "transparent",
                borderRadius: "50%", width: 28, height: 28,
                display: "flex", alignItems: "center", justifyContent: "center",
                margin: "2px auto 0",
              }}>{day.getDate()}</p>
            </div>
          );
        })}
      </div>

      {/* Time grid */}
      <div style={{ display: "grid", gridTemplateColumns: "48px repeat(7, 1fr)", height: 520, overflow: "auto", position: "relative" }}>
        {/* Hour labels */}
        <div style={{ display: "flex", flexDirection: "column" }}>
          {HOURS.map(h => (
            <div key={h} style={{ height: 40, display: "flex", alignItems: "flex-start", justifyContent: "flex-end", paddingRight: 8, paddingTop: 2, flexShrink: 0 }}>
              <span style={{ fontSize: 10, color: "var(--text-muted)" }}>{h > 12 ? `${h - 12}pm` : h === 12 ? "12pm" : `${h}am`}</span>
            </div>
          ))}
        </div>

        {/* Day columns */}
        {days.map((day, di) => {
          const dayAppts = apptForDay(day);
          const isToday = day.toDateString() === today.toDateString();
          return (
            <div key={di} style={{
              position: "relative", borderLeft: "1px solid var(--border)",
              background: isToday ? "rgba(124,106,245,0.03)" : "transparent",
            }}>
              {/* Hour lines */}
              {HOURS.map(h => (
                <div key={h} style={{ height: 40, borderBottom: "1px solid var(--border)", flexShrink: 0 }} />
              ))}
              {/* Appointments */}
              {dayAppts.map(a => {
                const start = new Date(a.startTime);
                const end = a.endTime ? new Date(a.endTime) : new Date(start.getTime() + 60 * 60 * 1000);
                const top = topPct(start);
                const height = heightPct(start, end);
                const color = STATUS_COLOR[a.status?.toLowerCase()] ?? "var(--accent)";
                return (
                  <div key={a.id} onClick={() => setSelected(a)} style={{
                    position: "absolute",
                    top: `${top}%`, height: `${height}%`,
                    left: 2, right: 2,
                    background: color + "22",
                    border: `1px solid ${color}`,
                    borderLeft: `3px solid ${color}`,
                    borderRadius: 6, padding: "3px 6px",
                    cursor: "pointer", overflow: "hidden",
                    zIndex: 1,
                  }}>
                    <p style={{ fontSize: 10, fontWeight: 700, color, lineHeight: 1.3 }}>{fmt12(start)}</p>
                    <p style={{ fontSize: 10, color: "var(--text-primary)", lineHeight: 1.3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.contactName || a.title}</p>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>

      {/* Selected appointment detail */}
      {selected && (
        <div style={{ padding: "14px 20px", borderTop: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
          <div>
            <p style={{ fontSize: 13, fontWeight: 700 }}>{selected.title}</p>
            <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2 }}>
              {selected.contactName} · {selected.startTime ? fmt12(new Date(selected.startTime)) : "—"}
              {selected.endTime ? ` – ${fmt12(new Date(selected.endTime))}` : ""}
            </p>
            <span style={{ fontSize: 10, color: STATUS_COLOR[selected.status?.toLowerCase()] ?? "var(--accent)", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em" }}>
              {selected.status ?? "Booked"}
            </span>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            {selected.contactId && (
              <a href={`${ghlBase}/contacts/detail/${selected.contactId}`} target="_blank" rel="noreferrer"
                style={{ fontSize: 12, color: "var(--accent)", background: "var(--accent-glow)", border: "1px solid var(--accent)", borderRadius: 8, padding: "6px 14px", textDecoration: "none", fontWeight: 600 }}>
                View in GHL →
              </a>
            )}
            <button onClick={() => setSelected(null)} style={{ fontSize: 12, color: "var(--text-muted)", background: "transparent", border: "1px solid var(--border)", borderRadius: 8, padding: "6px 12px", cursor: "pointer" }}>
              Dismiss
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

const navBtn: React.CSSProperties = {
  background: "var(--bg-hover)", border: "1px solid var(--border)", borderRadius: 6,
  width: 28, height: 28, cursor: "pointer", color: "var(--text-primary)",
  fontSize: 16, display: "flex", alignItems: "center", justifyContent: "center",
  padding: 0,
};
