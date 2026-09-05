"use client";
import { useState } from "react";

// One thing on the time grid. Every field past `startTime` is optional so the
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
  /** Whose item: jack | maddox | grant | team. Null = nobody's / unknown. */
  person?: string | null;
}

// 7am to 9pm: late enough that an evening study block still lands on the grid.
const HOURS = Array.from({ length: 15 }, (_, i) => i + 7);
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
  bookings: "var(--accent-2)",
};
const STATUS_COLOR: Record<string, string> = {
  confirmed: "var(--green)",
  booked: "var(--accent)",
  showed: "var(--accent)",
  noshow: "var(--red)",
  cancelled: "var(--text-muted)",
};

export const PERSON_LABEL: Record<string, string> = {
  jack: "Jack",
  maddox: "Maddox",
  grant: "Grant",
  team: "Team",
};

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

function sameDay(a: Date, day: Date) {
  return (
    a.getFullYear() === day.getFullYear() &&
    a.getMonth() === day.getMonth() &&
    a.getDate() === day.getDate()
  );
}

export function colorFor(a: Appointment): string {
  return (
    a.color ??
    (a.source ? SOURCE_COLOR[a.source] : undefined) ??
    (a.status ? STATUS_COLOR[a.status.toLowerCase()] : undefined) ??
    "var(--accent)"
  );
}

// The hour grid. Draws `days` consecutive days starting at `startDate` (7 for
// a week, 1 for a single day). Navigation lives in the parent so the month,
// week and day views share one Today / previous / next control.
export default function WeekCalendar({
  appointments,
  startDate,
  days = 7,
  emptyNote,
  onEdit,
  onOpenBooking,
}: {
  appointments: Appointment[];
  /** First day drawn (local midnight). */
  startDate: Date;
  /** How many days to draw from startDate: 7 = week, 1 = day. */
  days?: number;
  /** Shown instead of a count when there is nothing to draw. Must say what is
   *  actually missing; it is never a placeholder for hidden data. */
  emptyNote?: string;
  /** When set, an editable item (a manual time-block) gets an Edit button in
   *  the detail panel. */
  onEdit?: (a: Appointment) => void;
  /** When set, a booking gets a "Manage booking" button in the detail panel. */
  onOpenBooking?: (a: Appointment) => void;
}) {
  const [selected, setSelected] = useState<Appointment | null>(null);
  const today = new Date();
  const cols = Array.from({ length: days }, (_, i) => {
    const d = new Date(startDate);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + i);
    return d;
  });

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

  const inRange = appointments.filter(
    (a) => a.startTime && cols.some((d) => sameDay(toLocal(a.startTime), d))
  ).length;

  const span = HOURS.length;
  function topPct(date: Date) {
    const h = date.getHours() + date.getMinutes() / 60;
    return Math.max(0, ((h - HOURS[0]) / span) * 100);
  }
  function heightPct(start: Date, end: Date) {
    const dur = (end.getTime() - start.getTime()) / (1000 * 60 * 60);
    return Math.max(2, (dur / span) * 100);
  }

  const gridCols = `48px repeat(${days}, minmax(0, 1fr))`;
  // The phone stylesheet collapses inline grid-template-columns to one or two
  // tracks; the class + CSS variable below wins it back for these grids.
  const gridVars = { "--cal-cols": String(days) } as React.CSSProperties;

  // Items that overlap in time share the column side by side instead of
  // stacking on top of each other (two people's classes at the same hour).
  function layout(list: Appointment[]): Map<string, { col: number; cols: number }> {
    const items = list
      .map((a) => {
        const s = toLocal(a.startTime).getTime();
        const e = a.endTime ? toLocal(a.endTime).getTime() : s + 60 * 60 * 1000;
        return { id: a.id, s, e };
      })
      .sort((x, y) => x.s - y.s || x.e - y.e);
    const out = new Map<string, { col: number; cols: number }>();
    let cluster: { id: string; s: number; e: number; col: number }[] = [];
    let clusterEnd = -1;
    const flush = () => {
      const cols = Math.max(1, ...cluster.map((c) => c.col + 1));
      for (const c of cluster) out.set(c.id, { col: c.col, cols });
      cluster = [];
    };
    for (const it of items) {
      if (cluster.length && it.s >= clusterEnd) flush();
      const taken = new Set(cluster.filter((c) => c.e > it.s).map((c) => c.col));
      let col = 0;
      while (taken.has(col)) col++;
      cluster.push({ ...it, col });
      clusterEnd = Math.max(clusterEnd, it.e);
    }
    if (cluster.length) flush();
    return out;
  }

  return (
    <div className="cal-time" style={{ display: "flex", flexDirection: "column", gap: 0, background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 14, overflow: "hidden" }}>
      <style>{`
        .app-view .cal-time-row { grid-template-columns: 48px repeat(var(--cal-cols, 7), minmax(0, 1fr)) !important; }
        @media (max-width: 768px) {
          .cal-time { overflow-x: auto; -webkit-overflow-scrolling: touch; }
          .cal-time-row[data-days="7"] { min-width: 640px; }
          .app-view .cal-time-row { grid-template-columns: 40px repeat(var(--cal-cols, 7), minmax(0, 1fr)) !important; }
        }
      `}</style>

      {/* Day headers */}
      <div className="cal-time-row" data-days={days} style={{ ...gridVars, display: "grid", gridTemplateColumns: gridCols, borderBottom: "1px solid var(--border)" }}>
        <div />
        {cols.map((day, i) => {
          const isToday = sameDay(day, today);
          return (
            <div key={i} style={{ padding: "8px 4px", textAlign: "center", borderLeft: "1px solid var(--border)" }}>
              <p style={{ fontSize: 10, color: "var(--text-muted)", textTransform: "uppercase", margin: 0 }}>
                {DAYS[day.getDay()]}
                {days === 1 ? ` · ${day.toLocaleDateString("en-US", { month: "short" })}` : ""}
              </p>
              <p style={{
                fontSize: 16, fontWeight: 700, marginTop: 2,
                color: isToday ? "var(--bg-card)" : "var(--text-primary)",
                background: isToday ? "var(--accent)" : "transparent",
                borderRadius: "50%", width: 28, height: 28,
                display: "flex", alignItems: "center", justifyContent: "center",
                margin: "2px auto 0",
              }}>{day.getDate()}</p>
            </div>
          );
        })}
      </div>

      {inRange === 0 ? (
        <p style={{ margin: 0, padding: "8px 14px", fontSize: 12, color: "var(--text-muted)", borderBottom: "1px solid var(--border)" }}>
          {emptyNote ?? (days === 1 ? "nothing scheduled this day" : "nothing scheduled this week")}
        </p>
      ) : null}

      {/* All-day band, only when the range actually has some. */}
      {cols.some((d) => allDayForDay(d).length > 0) && (
        <div className="cal-time-row" data-days={days} style={{ ...gridVars, display: "grid", gridTemplateColumns: gridCols, borderBottom: "1px solid var(--border)" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", paddingRight: 8 }}>
            <span style={{ fontSize: 9, color: "var(--text-muted)", textTransform: "uppercase" }}>all day</span>
          </div>
          {cols.map((day, i) => (
            <div key={i} style={{ borderLeft: "1px solid var(--border)", padding: 3, display: "grid", gap: 3 }}>
              {allDayForDay(day).map((a) => {
                const color = colorFor(a);
                return (
                  <button
                    key={a.id}
                    onClick={() => setSelected(a)}
                    style={{
                      background: `color-mix(in srgb, ${color} 14%, transparent)`, border: `1px solid ${color}`, borderLeft: `3px solid ${color}`,
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
      <div className="cal-time-row" data-days={days} style={{ ...gridVars, display: "grid", gridTemplateColumns: gridCols, height: 520, overflow: "auto", position: "relative" }}>
        <div style={{ display: "flex", flexDirection: "column" }}>
          {HOURS.map(h => (
            <div key={h} style={{ height: 40, display: "flex", alignItems: "flex-start", justifyContent: "flex-end", paddingRight: 8, paddingTop: 2, flexShrink: 0 }}>
              <span style={{ fontSize: 10, color: "var(--text-muted)" }}>{h > 12 ? `${h - 12}pm` : h === 12 ? "12pm" : `${h}am`}</span>
            </div>
          ))}
        </div>

        {cols.map((day, di) => {
          const dayAppts = apptForDay(day);
          const isToday = sameDay(day, today);
          const pos = layout(dayAppts);
          return (
            <div key={di} style={{
              position: "relative", borderLeft: "1px solid var(--border)",
              background: isToday ? "var(--accent-glow)" : "transparent",
            }}>
              {HOURS.map(h => (
                <div key={h} style={{ height: 40, borderBottom: "1px solid var(--border)", flexShrink: 0 }} />
              ))}
              {dayAppts.map(a => {
                const start = toLocal(a.startTime);
                const end = a.endTime ? toLocal(a.endTime) : new Date(start.getTime() + 60 * 60 * 1000);
                const top = topPct(start);
                const height = heightPct(start, end);
                const color = colorFor(a);
                const who = a.person && a.person !== "team" ? PERSON_LABEL[a.person] ?? a.person : null;
                const p = pos.get(a.id) ?? { col: 0, cols: 1 };
                return (
                  <div key={a.id} onClick={() => setSelected(a)} title={[a.title, who, a.detail].filter(Boolean).join(" · ")} style={{
                    position: "absolute",
                    top: `${top}%`, height: `${height}%`,
                    left: `calc(${(p.col / p.cols) * 100}% + 2px)`,
                    width: `calc(${(1 / p.cols) * 100}% - 4px)`,
                    background: `color-mix(in srgb, ${color} 14%, transparent)`,
                    // Manual time-blocks read apart from feed events: dashed edge.
                    border: `1px ${a.source === "blocks" ? "dashed" : "solid"} ${color}`,
                    borderLeft: `3px solid ${color}`,
                    borderRadius: 6, padding: "3px 6px",
                    cursor: "pointer", overflow: "hidden",
                    zIndex: 1,
                  }}>
                    <p style={{ fontSize: 10, fontWeight: 700, color, lineHeight: 1.3, margin: 0 }}>
                      {fmt12(start)}{who && days === 1 ? ` · ${who}` : ""}
                    </p>
                    <p style={{ fontSize: 10, color: "var(--text-primary)", lineHeight: 1.3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", margin: 0 }}>
                      {a.contactName || a.title}
                    </p>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>

      {/* Selected appointment detail */}
      {selected && (
        <div style={{ padding: "14px 20px", borderTop: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
          <div>
            <p style={{ fontSize: 13, fontWeight: 700, margin: 0 }}>{selected.title}</p>
            <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2, marginBottom: 0 }}>
              {[
                selected.person && selected.person !== "team" ? PERSON_LABEL[selected.person] ?? selected.person : null,
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
                {selected.status.replace("_", " ")}
              </span>
            ) : null}
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {onEdit && selected.source === "blocks" ? (
              <button onClick={() => { onEdit(selected); setSelected(null); }} style={accentBtn}>
                Edit block
              </button>
            ) : null}
            {onOpenBooking && selected.source === "bookings" ? (
              <button onClick={() => { onOpenBooking(selected); setSelected(null); }} style={accentBtn}>
                Manage booking
              </button>
            ) : null}
            {/* Only a link the feed actually gave us. No link is shown for an
                event whose source record has no address. */}
            {selected.url ? (
              <a
                href={selected.url}
                {...(selected.external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
                style={{ ...accentBtn, textDecoration: "none" }}
              >
                {selected.source === "school"
                  ? "Open schedule app"
                  : selected.external
                  ? "Open in Google Calendar"
                  : "Open source"}
              </a>
            ) : null}
            <button onClick={() => setSelected(null)} style={{ font: "inherit", fontSize: 12, color: "var(--text-muted)", background: "transparent", border: "1px solid var(--border)", borderRadius: 8, padding: "6px 12px", cursor: "pointer" }}>
              Dismiss
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

const accentBtn: React.CSSProperties = {
  font: "inherit",
  fontSize: 12,
  color: "var(--accent)",
  background: "var(--accent-glow)",
  border: "1px solid var(--accent)",
  borderRadius: 8,
  padding: "6px 12px",
  cursor: "pointer",
};
