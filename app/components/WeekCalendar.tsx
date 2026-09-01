"use client";
import { useState } from "react";

// One thing on the week grid. Every field past `startTime` is optional so the
// same grid can draw a Google Calendar event, a scheduled call-back and a
// payment due date without any of them being padded with invented values.
export interface Appointment {
  id: string;
  title: string;
  contactName?: string;
  contactId?: string;
  startTime: string;
  endTime?: string | null;
  status?: string | null;
  /** Real link back to the source record. Never invented. */
  url?: string | null;
  /** True when the link leaves the OS and needs target=_blank. */
  external?: boolean;
  /** Which feed this came from, used for the colour key. */
  source?: string;
  /** Secondary line: who it is with, or what it is worth. */
  detail?: string | null;
  /** All-day items sit in the band above the hour grid, not inside it. */
  allDay?: boolean;
  /** Explicit colour token; wins over the source colour (block categories). */
  color?: string | null;
}

const HOURS = Array.from({ length: 13 }, (_, i) => i + 7); // 7am - 7pm
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const SOURCE_COLOR: Record<string, string> = {
  google: "var(--accent)",
  callbacks: "var(--orange)",
  payments: "var(--green)",
  // Classes get their own colour so school reads apart from work at a glance.
  school: "var(--accent-2)",
  // Stripe money markers; Jack's own manual blocks colour per-category instead
  // (each block event carries its own `color`), so "blocks" here is a fallback.
  stripe: "var(--accent-dim)",
  blocks: "var(--accent)",
};
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

// A date string from the feed to a real local Date. A plain YYYY-MM-DD is
// built field by field, because handing it to Date() would read it as UTC
// midnight and render the day before in every US timezone.
export function toLocal(value: string): Date {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (d) return new Date(Number(d[1]), Number(d[2]) - 1, Number(d[3]));
  return new Date(value);
}

function fmt12(date: Date) {
  let h = date.getHours(), m = date.getMinutes();
  const ampm = h >= 12 ? "pm" : "am";
  h = h % 12 || 12;
  return `${h}:${m.toString().padStart(2, "0")}${ampm}`;
}

export default function WeekCalendar({
  appointments,
  emptyNote,
  onEdit,
}: {
  appointments: Appointment[];
  /** Shown instead of a count when there is nothing to draw. Must say what is
   *  actually missing; it is never a placeholder for hidden data. */
  emptyNote?: string;
  /** When set, an editable item (a manual time-block) gets an Edit button in
   *  the detail panel. Called with the appointment's id. */
  onEdit?: (a: Appointment) => void;
}) {
  const [weekOffset, setWeekOffset] = useState(0);
  const [selected, setSelected] = useState<Appointment | null>(null);
  const days = getWeekDays(weekOffset);
  const today = new Date();

  function sameDay(a: Date, day: Date) {
    return (
      a.getFullYear() === day.getFullYear() &&
      a.getMonth() === day.getMonth() &&
      a.getDate() === day.getDate()
    );
  }

  // Map events to their day slot. All-day items are kept out of the hour grid;
  // they have no hour to sit at and would otherwise pile onto 12am.
  function apptForDay(day: Date) {
    return appointments.filter(
      (a) => a.startTime && !a.allDay && sameDay(toLocal(a.startTime), day)
    );
  }
  function allDayForDay(day: Date) {
    return appointments.filter(
      (a) => a.startTime && a.allDay && sameDay(toLocal(a.startTime), day)
    );
  }

  const inWeek = appointments.filter(
    (a) => a.startTime && days.some((d) => sameDay(toLocal(a.startTime), d))
  ).length;

  function colorFor(a: Appointment) {
    return (
      a.color ??
      (a.source ? SOURCE_COLOR[a.source] : undefined) ??
      (a.status ? STATUS_COLOR[a.status.toLowerCase()] : undefined) ??
      "var(--accent)"
    );
  }

  function topPct(date: Date) {
    const h = date.getHours() + date.getMinutes() / 60;
    return Math.max(0, ((h - 7) / 13) * 100);
  }

  function heightPct(start: Date, end: Date) {
    const dur = (end.getTime() - start.getTime()) / (1000 * 60 * 60);
    return Math.max(2, (dur / 13) * 100);
  }

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
          <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
            {inWeek > 0
              ? `${inWeek} ${inWeek === 1 ? "event" : "events"} this week`
              : emptyNote ?? "nothing scheduled this week"}
          </span>
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

      {/* All-day band — payment due dates and all-day calendar events. Only
          drawn when the week actually has some. */}
      {days.some((d) => allDayForDay(d).length > 0) && (
        <div style={{ display: "grid", gridTemplateColumns: "48px repeat(7, 1fr)", borderBottom: "1px solid var(--border)" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", paddingRight: 8 }}>
            <span style={{ fontSize: 9, color: "var(--text-muted)", textTransform: "uppercase" }}>all day</span>
          </div>
          {days.map((day, i) => (
            <div key={i} style={{ borderLeft: "1px solid var(--border)", padding: 3, display: "grid", gap: 3 }}>
              {allDayForDay(day).map((a) => {
                const color = colorFor(a);
                return (
                  <button
                    key={a.id}
                    onClick={() => setSelected(a)}
                    style={{
                      background: color + "22", border: `1px solid ${color}`, borderLeft: `3px solid ${color}`,
                      borderRadius: 6, padding: "2px 5px", cursor: "pointer", textAlign: "left",
                      font: "inherit", color: "var(--text-primary)", fontSize: 10, fontWeight: 600,
                      overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                    }}
                  >
                    {a.title}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}

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
                const start = toLocal(a.startTime);
                const end = a.endTime ? toLocal(a.endTime) : new Date(start.getTime() + 60 * 60 * 1000);
                const top = topPct(start);
                const height = heightPct(start, end);
                const color = colorFor(a);
                return (
                  <div key={a.id} onClick={() => setSelected(a)} style={{
                    position: "absolute",
                    top: `${top}%`, height: `${height}%`,
                    left: 2, right: 2,
                    background: color + "22",
                    // Manual time-blocks read apart from feed events: dashed edge.
                    border: `1px ${a.source === "blocks" ? "dashed" : "solid"} ${color}`,
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
              {[
                selected.contactName || selected.detail,
                selected.allDay
                  ? "all day"
                  : selected.startTime
                  ? `${fmt12(toLocal(selected.startTime))}${
                      selected.endTime ? ` to ${fmt12(toLocal(selected.endTime))}` : ""
                    }`
                  : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
            {selected.status ? (
              <span style={{ fontSize: 10, color: colorFor(selected), fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em" }}>
                {selected.status}
              </span>
            ) : null}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            {onEdit && selected.source === "blocks" ? (
              <button
                onClick={() => { onEdit(selected); setSelected(null); }}
                style={{ fontSize: 12, color: "var(--accent)", background: "var(--accent-glow)", border: "1px solid var(--accent)", borderRadius: 8, padding: "6px 12px", cursor: "pointer" }}
              >
                Edit block
              </button>
            ) : null}
            {/* Only a link the feed actually gave us. No link is shown for an
                event whose source record has no address. */}
            {selected.url ? (
              <a
                href={selected.url}
                {...(selected.external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
                style={{ fontSize: 12, color: "var(--accent)", background: "var(--accent-glow)", border: "1px solid var(--accent)", borderRadius: 8, padding: "6px 12px", textDecoration: "none" }}
              >
                {selected.source === "school"
                  ? "Open schedule app"
                  : selected.external
                  ? "Open in Google Calendar"
                  : "Open source"}
              </a>
            ) : null}
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
