"use client";
import { useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import WeekCalendar, { SOURCE_COLOR, toLocal, type Appointment } from "./WeekCalendar";

const InvoicesBoard = dynamic(() => import("./InvoicesBoard"), { ssr: false });

// ───────────────────────────────────────────────────────────────────────────
// Calendar — the section's primary surface.
//
// Month grid and week grid over the SAME real feed (/api/calendar): Google
// Calendar read through its private iCal address, scheduled call-backs from
// the Cold Call Room, invoice due dates, and Jack's class schedule expanded
// live from the published schedule app. Every event links back to the record
// it came from, and only when that record actually has an address.
//
// Nothing is ever synthesized. A feed with no credential is named out loud in
// the lane strip so an empty calendar is never mistaken for a free week.
//
// Invoices are not gone: they live on as the second tab and keep every board,
// total and payment calendar they had before.
// ───────────────────────────────────────────────────────────────────────────

type CalendarSource = "google" | "callbacks" | "payments" | "school";

type ApiEvent = {
  id: string;
  source: CalendarSource;
  title: string;
  start: string;
  end: string | null;
  allDay: boolean;
  detail: string | null;
  url: string | null;
  external: boolean;
  status: string | null;
};

type Lane = {
  source: CalendarSource;
  label: string;
  configured: boolean;
  missing: string | null;
  error: string | null;
  count: number;
};

type Payload = { events: ApiEvent[]; lanes: Lane[]; today: string };

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const num: React.CSSProperties = { fontVariantNumeric: "tabular-nums" };

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}

function time12(value: string): string {
  const d = toLocal(value);
  let h = d.getHours();
  const m = d.getMinutes();
  const ampm = h >= 12 ? "pm" : "am";
  h = h % 12 || 12;
  return m ? `${h}:${String(m).padStart(2, "0")}${ampm}` : `${h}${ampm}`;
}

export type CalendarSectionProps = {
  /** Which tab opens first. Defaults to the calendar. */
  initialTab?: "calendar" | "invoices";
  /** Which calendar layout opens first. Defaults to the month grid. */
  initialView?: "month" | "week";
};

export default function CalendarSection({
  initialTab = "calendar",
  initialView = "month",
}: CalendarSectionProps) {
  const [tab, setTab] = useState<"calendar" | "invoices">(initialTab);
  const [view, setView] = useState<"month" | "week">(initialView);
  const [data, setData] = useState<Payload | null>(null);
  const [err, setErr] = useState("");
  const [monthOffset, setMonthOffset] = useState(0);
  const [openDay, setOpenDay] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    fetch("/api/calendar")
      .then((r) => r.json())
      .then((d: Payload) => {
        if (!live) return;
        setData(d);
      })
      .catch((e) => live && setErr(String(e)));
    return () => {
      live = false;
    };
  }, []);

  const events = useMemo(() => data?.events ?? [], [data]);

  // Every event bucketed onto its local calendar day. Real rows only; a day
  // with nothing on it stays empty.
  const byDay = useMemo(() => {
    const g: Record<string, ApiEvent[]> = {};
    for (const e of events) {
      if (!e.start) continue;
      (g[dayKey(toLocal(e.start))] ||= []).push(e);
    }
    for (const list of Object.values(g)) {
      list.sort((a, b) => (a.allDay === b.allDay ? (a.start < b.start ? -1 : 1) : a.allDay ? -1 : 1));
    }
    return g;
  }, [events]);

  // The week grid takes the same events through the shared Appointment shape.
  const weekEvents: Appointment[] = useMemo(
    () =>
      events.map((e) => ({
        id: e.id,
        title: e.title,
        startTime: e.start,
        endTime: e.end,
        status: e.status,
        url: e.url,
        external: e.external,
        source: e.source,
        detail: e.detail,
        allDay: e.allDay,
      })),
    [events]
  );

  const now = new Date();
  const viewMonth = new Date(now.getFullYear(), now.getMonth() + monthOffset, 1);
  const todayKey = data?.today ?? dayKey(now);

  const cells = useMemo(() => {
    const y = viewMonth.getFullYear();
    const m = viewMonth.getMonth();
    const firstDow = new Date(y, m, 1).getDay();
    const days = new Date(y, m + 1, 0).getDate();
    const out: ({ day: number; key: string } | null)[] = [];
    for (let i = 0; i < firstDow; i++) out.push(null);
    for (let d = 1; d <= days; d++) out.push({ day: d, key: dayKey(new Date(y, m, d)) });
    return out;
  }, [viewMonth]);

  const lanes = data?.lanes ?? [];
  const unconfigured = lanes.filter((l) => !l.configured);
  // Only lanes whose problem is a missing credential can name one. A lane that
  // failed for another reason (the classes feed being unreachable, say) reports
  // itself through its error line instead of an empty "Missing:".
  const missingCreds = unconfigured.filter((l) => l.missing);
  const laneErrors = lanes.filter((l) => l.error);
  const monthCount = cells.reduce((s, c) => s + (c ? (byDay[c.key]?.length ?? 0) : 0), 0);

  const openEvents = openDay ? byDay[openDay] ?? [] : [];

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <style>{`
        .cal-day:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
        .cal-day:hover { background: var(--bg-hover) !important; }
      `}</style>

      {/* Tabs — calendar first, invoices kept right beside it. */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button type="button" onClick={() => setTab("calendar")} style={tabBtn(tab === "calendar")}>
          Calendar
        </button>
        <button type="button" onClick={() => setTab("invoices")} style={tabBtn(tab === "invoices")}>
          Invoices and payments
        </button>
      </div>

      {tab === "invoices" ? (
        <div id="invoices">
          <InvoicesBoard />
        </div>
      ) : (
        <>
          {/* Which feeds are live, and exactly what is missing when one is not. */}
          <section style={{ ...card, display: "grid", gap: 8 }}>
            <div style={{ display: "flex", gap: 14, flexWrap: "wrap", alignItems: "center" }}>
              {lanes.map((l) => (
                <span key={l.source} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
                  <span
                    style={{
                      width: 9, height: 9, borderRadius: 99,
                      background: l.configured ? SOURCE_COLOR[l.source] : "transparent",
                      border: `1px solid ${l.configured ? SOURCE_COLOR[l.source] : "var(--text-muted)"}`,
                    }}
                  />
                  <span style={{ color: l.configured ? "var(--text-secondary)" : "var(--text-muted)" }}>
                    {l.label}
                  </span>
                  <span style={{ ...num, color: "var(--text-muted)" }}>
                    {l.configured ? l.count : "not connected"}
                  </span>
                </span>
              ))}
              {!data && !err ? <span style={{ fontSize: 12, color: "var(--text-muted)" }}>Loading…</span> : null}
            </div>
            {missingCreds.map((l) => (
              <p key={l.source} style={{ margin: 0, fontSize: 12, color: "var(--text-muted)" }}>
                {l.label} is not connected. Missing: <code style={{ color: "var(--orange)" }}>{l.missing}</code>
              </p>
            ))}
            {laneErrors.map((l) => (
              <p key={`e-${l.source}`} style={{ margin: 0, fontSize: 12, color: "var(--red)" }}>
                {l.error}
              </p>
            ))}
            {err ? <p style={{ margin: 0, fontSize: 12, color: "var(--red)" }}>Calendar: {err}</p> : null}
          </section>

          {/* View switch */}
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <button type="button" onClick={() => setView("month")} style={tabBtn(view === "month")}>
              Month
            </button>
            <button type="button" onClick={() => setView("week")} style={tabBtn(view === "week")}>
              Week
            </button>
          </div>

          {view === "week" ? (
            <WeekCalendar
              appointments={weekEvents}
              emptyNote={
                missingCreds.length
                  ? `nothing scheduled · missing ${missingCreds.map((l) => l.missing).join(", ")}`
                  : "nothing scheduled this week"
              }
            />
          ) : (
            <section style={{ ...card, padding: 0, overflow: "hidden" }}>
              <header
                style={{
                  display: "flex", alignItems: "center", justifyContent: "space-between",
                  padding: "14px 20px", borderBottom: "1px solid var(--border)", gap: 12,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <button onClick={() => setMonthOffset((m) => m - 1)} style={navBtn} aria-label="Previous month">‹</button>
                  <span style={{ fontSize: 14, fontWeight: 700 }}>
                    {MONTHS[viewMonth.getMonth()]} <span style={num}>{viewMonth.getFullYear()}</span>
                  </span>
                  <button onClick={() => setMonthOffset((m) => m + 1)} style={navBtn} aria-label="Next month">›</button>
                  {monthOffset !== 0 ? (
                    <button
                      onClick={() => setMonthOffset(0)}
                      style={{ fontSize: 11, color: "var(--accent)", background: "var(--accent-glow)", border: "1px solid var(--accent)", borderRadius: 6, padding: "3px 10px", cursor: "pointer" }}
                    >
                      Today
                    </button>
                  ) : null}
                </div>
                <span style={{ ...num, fontSize: 12, color: "var(--text-muted)" }}>
                  {monthCount > 0
                    ? `${monthCount} ${monthCount === 1 ? "event" : "events"}`
                    : data
                    ? "nothing scheduled this month"
                    : ""}
                </span>
              </header>

              <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", borderBottom: "1px solid var(--border)" }}>
                {DOW.map((d) => (
                  <div key={d} style={{ padding: "6px 4px", textAlign: "center", fontSize: 10, color: "var(--text-muted)", textTransform: "uppercase" }}>
                    {d}
                  </div>
                ))}
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)" }}>
                {cells.map((c, i) => {
                  if (!c) return <div key={i} style={{ minHeight: 96, borderTop: "1px solid var(--border)", borderLeft: i % 7 ? "1px solid var(--border)" : "none" }} />;
                  const list = byDay[c.key] ?? [];
                  const isToday = c.key === todayKey;
                  const isOpen = openDay === c.key;
                  return (
                    <button
                      key={i}
                      type="button"
                      className="cal-day"
                      aria-expanded={isOpen}
                      aria-label={`${c.key} — ${list.length} event${list.length === 1 ? "" : "s"}`}
                      onClick={() => setOpenDay((cur) => (cur === c.key ? null : c.key))}
                      style={{
                        font: "inherit",
                        minHeight: 96,
                        textAlign: "left",
                        padding: 5,
                        cursor: "pointer",
                        display: "grid",
                        gap: 3,
                        alignContent: "start",
                        borderTop: "1px solid var(--border)",
                        borderLeft: i % 7 ? "1px solid var(--border)" : "none",
                        borderRight: "none",
                        borderBottom: "none",
                        background: isOpen ? "var(--bg-hover)" : isToday ? "rgba(124,106,245,0.06)" : "transparent",
                        color: "var(--text-secondary)",
                        overflow: "hidden",
                      }}
                    >
                      <span
                        style={{
                          ...num, fontSize: 12, fontWeight: isToday ? 700 : 500,
                          color: isToday ? "#fff" : "var(--text-primary)",
                          background: isToday ? "var(--accent)" : "transparent",
                          borderRadius: "50%", width: 22, height: 22,
                          display: "flex", alignItems: "center", justifyContent: "center",
                        }}
                      >
                        {c.day}
                      </span>
                      {list.slice(0, 3).map((e) => {
                        const color = SOURCE_COLOR[e.source] ?? "var(--accent)";
                        return (
                          <span
                            key={e.id}
                            title={[e.title, e.detail].filter(Boolean).join(" · ")}
                            style={{
                              fontSize: 10, lineHeight: 1.3, borderRadius: 4,
                              padding: "1px 4px", background: color + "22",
                              borderLeft: `2px solid ${color}`, color: "var(--text-primary)",
                              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                            }}
                          >
                            {e.allDay ? "" : `${time12(e.start)} `}
                            {e.title}
                          </span>
                        );
                      })}
                      {list.length > 3 ? (
                        <span style={{ fontSize: 10, color: "var(--text-muted)" }}>+{list.length - 3} more</span>
                      ) : null}
                    </button>
                  );
                })}
              </div>

              {/* Day detail — every event on the clicked day, each linked to its
                  real source record when that record has an address. */}
              {openDay ? (
                <div style={{ borderTop: "1px solid var(--border)", padding: "12px 16px", display: "grid", gap: 8 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10 }}>
                    <strong style={{ ...num, fontSize: 13 }}>{openDay}</strong>
                    <button type="button" onClick={() => setOpenDay(null)} style={btn}>Close</button>
                  </div>
                  {openEvents.length === 0 ? (
                    <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)" }}>Nothing on this day.</p>
                  ) : null}
                  {openEvents.map((e) => {
                    const color = SOURCE_COLOR[e.source] ?? "var(--accent)";
                    return (
                      <div
                        key={e.id}
                        style={{
                          border: "1px solid var(--border)", borderLeft: `3px solid ${color}`,
                          borderRadius: 10, padding: 10, background: "var(--bg-secondary)",
                          display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap",
                        }}
                      >
                        <span style={{ ...num, fontSize: 11, color: "var(--text-muted)", minWidth: 62 }}>
                          {e.allDay ? "all day" : time12(e.start)}
                        </span>
                        <span style={{ fontSize: 13, color: "var(--text-primary)" }}>{e.title}</span>
                        {e.detail ? (
                          <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{e.detail}</span>
                        ) : null}
                        <span style={{ fontSize: 10, color, textTransform: "uppercase", letterSpacing: "0.06em" }}>
                          {e.source}
                        </span>
                        {e.url ? (
                          e.external ? (
                            <a
                              href={e.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              style={linkBtn}
                            >
                              {e.source === "school" ? "Open schedule app" : "Open in Google Calendar"}
                            </a>
                          ) : e.url === "#invoices" ? (
                            <button type="button" onClick={() => setTab("invoices")} style={{ ...btn, borderColor: "var(--accent)", color: "var(--accent)" }}>
                              Open invoice
                            </button>
                          ) : (
                            <a href={e.url} style={linkBtn}>Open in call room</a>
                          )
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              ) : null}
            </section>
          )}
        </>
      )}
    </div>
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

const linkBtn: React.CSSProperties = {
  marginLeft: "auto",
  fontSize: 12,
  color: "var(--accent)",
  background: "var(--accent-glow)",
  border: "1px solid var(--accent)",
  borderRadius: 8,
  padding: "5px 10px",
  textDecoration: "none",
};

function tabBtn(active: boolean): React.CSSProperties {
  return {
    ...btn,
    padding: "7px 14px",
    fontSize: 13,
    borderColor: active ? "var(--accent)" : "var(--border)",
    color: active ? "var(--accent)" : "var(--text-secondary)",
    background: active ? "var(--accent-glow)" : "var(--bg-card)",
  };
}

const navBtn: React.CSSProperties = {
  background: "var(--bg-hover)", border: "1px solid var(--border)", borderRadius: 6,
  width: 28, height: 28, cursor: "pointer", color: "var(--text-primary)",
  fontSize: 16, display: "flex", alignItems: "center", justifyContent: "center",
  padding: 0,
};
