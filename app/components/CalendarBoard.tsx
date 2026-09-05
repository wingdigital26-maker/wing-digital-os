"use client";
import { useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import WeekCalendar, { PERSON_LABEL, SOURCE_COLOR, toLocal, type Appointment } from "./WeekCalendar";

const InvoicesBoard = dynamic(() => import("./InvoicesBoard"), { ssr: false });
const BookingsAdmin = dynamic(() => import("./BookingsAdmin"), { ssr: false });

// ───────────────────────────────────────────────────────────────────────────
// Calendar — the section's primary surface.
//
// A normal calendar: a month grid first (Sun to Sat, weeks as rows, today
// marked, every day listing its items as small coloured chips), with Week and
// Day views one tap away and one Today / previous / next control shared by
// all three. Everything is drawn from the SAME real feed (/api/calendar):
// bookings from the public link, call-backs from the Cold Call Room, class and
// study blocks, invoice due dates, Stripe, and Google when it is connected.
// A person filter (Everyone / Jack / Maddox / Grant) narrows to one person's
// items plus anything marked for the whole team.
//
// Nothing is ever synthesized. A feed with no credential is named out loud in
// the lane strip so an empty calendar is never mistaken for a free week.
//
// Two writes live here: manual time blocks (add / edit / delete) and the
// team's booking hours (the Availability panel), which is what the public
// /book link uses to decide which slots to offer.
//
// Invoices are not gone: they live on as the second tab.
// ───────────────────────────────────────────────────────────────────────────

type CalendarSource = "google" | "callbacks" | "payments" | "school" | "blocks" | "stripe" | "bookings";

function laneColor(source: CalendarSource): string {
  return SOURCE_COLOR[source] ?? "var(--accent-2)";
}

type BlockRow = {
  id: string;
  title: string;
  date: string;
  start_time: string;
  end_time: string;
  category: string;
  notes: string | null;
  recurrence: string | null;
  person?: string | null;
};

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
  color?: string | null;
  block?: BlockRow | null;
  person?: string | null;
};

type Lane = {
  source: CalendarSource;
  label: string;
  configured: boolean;
  missing: string | null;
  error: string | null;
  count: number;
  note?: string | null;
};

const BLOCK_CATEGORIES = ["study", "call", "work", "personal", "other"] as const;
const PEOPLE = ["jack", "maddox", "grant"] as const;
type PersonFilter = "all" | (typeof PEOPLE)[number];

type BlockDraft = {
  id: string;
  title: string;
  date: string;
  start_time: string;
  end_time: string;
  category: string;
  notes: string;
  weekly: boolean;
  person: string;
};

function nextRoundHour(): { start: string; end: string } {
  const h = Math.min(new Date().getHours() + 1, 22);
  const p = (n: number) => String(n).padStart(2, "0");
  return { start: `${p(h)}:00`, end: `${p(Math.min(h + 1, 23))}:00` };
}

function emptyDraft(date: string, person: string): BlockDraft {
  const t = nextRoundHour();
  return { id: "", title: "", date, start_time: t.start, end_time: t.end, category: "work", notes: "", weekly: false, person };
}

function draftFrom(b: BlockRow): BlockDraft {
  return {
    id: b.id,
    title: b.title,
    date: b.date,
    start_time: b.start_time.slice(0, 5),
    end_time: b.end_time.slice(0, 5),
    category: b.category,
    notes: b.notes ?? "",
    weekly: b.recurrence === "weekly",
    person: b.person || "jack",
  };
}

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

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function sundayOf(d: Date): Date {
  const x = startOfDay(d);
  x.setDate(x.getDate() - x.getDay());
  return x;
}

function time12(value: string): string {
  const d = toLocal(value);
  let h = d.getHours();
  const m = d.getMinutes();
  const ampm = h >= 12 ? "pm" : "am";
  h = h % 12 || 12;
  return m ? `${h}:${String(m).padStart(2, "0")}${ampm}` : `${h}${ampm}`;
}

// Which person an event belongs to for the filter. The class lane is Jack's
// own schedule; feeds with no person (payments, Stripe, Google, call-backs)
// return null and only show under Everyone.
function personOf(e: ApiEvent): string | null {
  if (e.person) return e.person;
  if (e.source === "school") return "jack";
  return null;
}

function normTitle(t: string): string {
  return t.toLowerCase().replace(/\s+/g, " ").trim();
}

function dedupe(list: ApiEvent[]): ApiEvent[] {
  // Group by start + normalized title; within a group, items whose person
  // matches (or is unknown) merge. School wins the chip; the block rides along.
  const groups = new Map<string, ApiEvent[]>();
  for (const e of list) {
    if (!e.start) continue;
    const k = `${e.start}|${normTitle(e.title)}`;
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(e);
  }
  const out: ApiEvent[] = [];
  for (const g of groups.values()) {
    if (g.length === 1) { out.push(g[0]); continue; }
    const merged: ApiEvent[] = [];
    for (const e of g) {
      const p = personOf(e);
      const host = merged.find((m) => {
        const mp = personOf(m);
        return (mp == null || p == null || mp === p) && (m.source === "school" ? e.source === "blocks" : e.source === "school");
      });
      if (!host) { merged.push({ ...e }); continue; }
      const school = host.source === "school" ? host : e;
      const block = host.source === "school" ? e : host;
      const idx = merged.indexOf(host);
      merged[idx] = {
        ...school,
        end: school.end ?? block.end,
        block: block.block ?? null,
        person: personOf(school) ?? personOf(block),
        detail: [school.detail, "also blocked on the calendar"].filter(Boolean).join(" · "),
      };
    }
    out.push(...merged);
  }
  return out.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
}

export type CalendarSectionProps = {
  initialTab?: "calendar" | "invoices";
  initialView?: "month" | "week" | "day";
};

export default function CalendarSection({
  initialTab = "calendar",
  initialView = "month",
}: CalendarSectionProps) {
  const [tab, setTab] = useState<"calendar" | "invoices">(initialTab);
  const [view, setView] = useState<"month" | "week" | "day">(initialView);
  const [anchor, setAnchor] = useState<Date>(() => startOfDay(new Date()));
  const [person, setPerson] = useState<PersonFilter>("all");
  const [data, setData] = useState<Payload | null>(null);
  const [err, setErr] = useState("");
  const [focusBooking, setFocusBooking] = useState<string | null>(null);
  const [showHours, setShowHours] = useState(false);
  const [narrow, setNarrow] = useState(false);

  const [draft, setDraft] = useState<BlockDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [formErr, setFormErr] = useState("");

  // Phone: month cells show dots instead of chips.
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 640px)");
    const apply = () => setNarrow(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);

  async function load() {
    try {
      const d = (await (await fetch("/api/calendar")).json()) as Payload;
      setData(d);
      setErr("");
    } catch (e) {
      setErr(String(e));
    }
  }

  useEffect(() => {
    let live = true;
    fetch("/api/calendar")
      .then((r) => r.json())
      .then((d: Payload) => { if (live) setData(d); })
      .catch((e) => live && setErr(String(e)));
    return () => { live = false; };
  }, []);

  async function saveDraft() {
    if (!draft) return;
    setSaving(true);
    setFormErr("");
    try {
      const body = {
        ...(draft.id ? { id: draft.id } : {}),
        title: draft.title,
        date: draft.date,
        start_time: draft.start_time,
        end_time: draft.end_time,
        category: draft.category,
        notes: draft.notes || null,
        recurrence: draft.weekly ? "weekly" : null,
        person: draft.person,
      };
      const res = await fetch("/api/blocks", {
        method: draft.id ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) { setFormErr(out?.error || `Save failed (HTTP ${res.status})`); return; }
      setDraft(null);
      await load();
    } catch (e) {
      setFormErr(String(e));
    } finally {
      setSaving(false);
    }
  }

  async function deleteDraft() {
    if (!draft?.id) return;
    setSaving(true);
    setFormErr("");
    try {
      const res = await fetch(`/api/blocks?id=${encodeURIComponent(draft.id)}`, { method: "DELETE" });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) { setFormErr(out?.error || `Delete failed (HTTP ${res.status})`); return; }
      setDraft(null);
      await load();
    } catch (e) {
      setFormErr(String(e));
    } finally {
      setSaving(false);
    }
  }

  // Render-time dedupe: Jack's classes arrive twice, once from the published
  // schedule (school lane) and once as a study block. Two items with the same
  // person (or one with none), the same start and the same normalized title
  // collapse into ONE chip that keeps the school colour and carries the
  // block's row so Edit still works. Nothing is deleted from either source.
  const allEvents = useMemo(() => dedupe(data?.events ?? []), [data]);
  const events = useMemo(
    () =>
      person === "all"
        ? allEvents
        : allEvents.filter((e) => {
            const p = personOf(e);
            return p === person || p === "team";
          }),
    [allEvents, person]
  );
  // Legend counts follow what is actually drawn: a merged class counts once,
  // under Classes, and is no longer counted as a separate time block.
  const shownCount = useMemo(() => {
    const c: Record<string, number> = {};
    for (const e of allEvents) c[e.source] = (c[e.source] ?? 0) + 1;
    return c;
  }, [allEvents]);

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

  const gridEvents: Appointment[] = useMemo(
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
        color: e.color ?? null,
        person: personOf(e),
      })),
    [events]
  );

  const todayKey = data?.today ?? dayKey(new Date());
  const anchorKey = dayKey(anchor);
  const viewMonth = new Date(anchor.getFullYear(), anchor.getMonth(), 1);

  // Month grid: leading blanks, the days, trailing blanks to a full week.
  const cells = useMemo(() => {
    const y = viewMonth.getFullYear();
    const m = viewMonth.getMonth();
    const firstDow = new Date(y, m, 1).getDay();
    const days = new Date(y, m + 1, 0).getDate();
    const out: ({ day: number; key: string } | null)[] = [];
    for (let i = 0; i < firstDow; i++) out.push(null);
    for (let d = 1; d <= days; d++) out.push({ day: d, key: dayKey(new Date(y, m, d)) });
    while (out.length % 7) out.push(null);
    return out;
  }, [viewMonth]);

  function shift(n: number) {
    const d = new Date(anchor);
    if (view === "month") d.setMonth(d.getMonth() + n, 1);
    else if (view === "week") d.setDate(d.getDate() + n * 7);
    else d.setDate(d.getDate() + n);
    setAnchor(d);
  }

  const weekStart = sundayOf(anchor);
  const weekEnd = new Date(weekStart); weekEnd.setDate(weekEnd.getDate() + 6);
  const heading =
    view === "month"
      ? `${MONTHS[viewMonth.getMonth()]} ${viewMonth.getFullYear()}`
      : view === "week"
      ? `${weekStart.toLocaleDateString("en-US", { month: "short", day: "numeric" })} to ${weekEnd.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`
      : anchor.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  const isOnToday = todayKey === anchorKey;

  const lanes = data?.lanes ?? [];
  const unconfigured = lanes.filter((l) => !l.configured);
  const missingCreds = unconfigured.filter((l) => l.missing);
  const laneErrors = lanes.filter((l) => l.error);
  const monthCount = cells.reduce((s, c) => s + (c ? (byDay[c.key]?.length ?? 0) : 0), 0);

  function openDay(key: string) {
    setAnchor(toLocal(key));
    setView("day");
  }

  function openEvent(e: ApiEvent) {
    if (e.block) { setFormErr(""); setDraft(draftFrom(e.block)); return; }
    if (e.source === "bookings") { setFocusBooking(e.id.replace(/^booking:/, "")); return; }
    openDay(dayKey(toLocal(e.start)));
  }

  const draftPerson = person === "all" ? "jack" : person;
  const chipMax = 3;

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <style>{`
        .cal-day:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
        .cal-day:hover { background: var(--bg-hover) !important; }
        .cal-chip:hover { filter: brightness(1.15); }
        /* The phone stylesheet collapses inline grids; a month is always 7 wide. */
        .app-view .cal-month-grid { grid-template-columns: repeat(7, minmax(0, 1fr)) !important; }
      `}</style>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button type="button" onClick={() => setTab("calendar")} style={tabBtn(tab === "calendar")}>Calendar</button>
        <button type="button" onClick={() => setTab("invoices")} style={tabBtn(tab === "invoices")}>Invoices and payments</button>
      </div>

      {tab === "invoices" ? (
        <div id="invoices"><InvoicesBoard /></div>
      ) : (
        <>
          {/* Legend: which feeds are live, and what is missing when one is not. */}
          <section style={{ ...card, display: "grid", gap: 8 }}>
            <div style={{ display: "flex", gap: 14, flexWrap: "wrap", alignItems: "center" }}>
              {lanes.filter((l) => l.configured).map((l) => (
                <span key={l.source} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
                  <span style={{ width: 9, height: 9, borderRadius: 99, background: laneColor(l.source), border: `1px solid ${laneColor(l.source)}` }} />
                  <span style={{ color: "var(--text-secondary)" }}>{l.label}</span>
                  <span style={{ ...num, color: "var(--text-muted)" }} title={shownCount[l.source] !== l.count ? `${l.count} in the feed, ${shownCount[l.source] ?? 0} shown after merging duplicates` : undefined}>
                    {data ? shownCount[l.source] ?? 0 : l.count}
                  </span>
                </span>
              ))}
              {!data && !err ? <span style={{ fontSize: 12, color: "var(--text-muted)" }}>Loading…</span> : null}
            </div>
            {unconfigured.length ? (
              <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)" }}>
                {unconfigured.map((l, i) => (
                  <span key={l.source}>
                    {i > 0 ? (i === unconfigured.length - 1 ? " and " : ", ") : ""}
                    <span
                      title={l.missing ? `Needs ${l.missing}` : undefined}
                      style={l.missing ? { textDecoration: "underline dotted", textDecorationColor: "var(--border)" } : undefined}
                    >
                      {l.label}
                    </span>
                  </span>
                ))}
                {unconfigured.length === 1 ? " is" : " are"} not connected yet.
              </p>
            ) : null}
            {lanes.filter((l) => l.note).map((l) => (
              <p key={`n-${l.source}`} style={{ margin: 0, fontSize: 12, color: "var(--text-muted)" }}>{l.note}</p>
            ))}
            {laneErrors.map((l) => (
              <p key={`e-${l.source}`} style={{ margin: 0, fontSize: 12, color: "var(--red)" }}>{l.error}</p>
            ))}
            {err ? <p style={{ margin: 0, fontSize: 12, color: "var(--red)" }}>Calendar: {err}</p> : null}
          </section>

          {/* Toolbar: Today / prev / next, the heading, view switch, person filter. */}
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <button type="button" onClick={() => setAnchor(startOfDay(new Date()))} style={tabBtn(isOnToday)} aria-label="Go to today">Today</button>
            <button type="button" onClick={() => shift(-1)} style={navBtn} aria-label={`Previous ${view}`}>‹</button>
            <button type="button" onClick={() => shift(1)} style={navBtn} aria-label={`Next ${view}`}>›</button>
            <span style={{ fontSize: 14, fontWeight: 700, ...num }}>{heading}</span>
            <div style={{ display: "flex", gap: 4, marginLeft: "auto" }}>
              {(["month", "week", "day"] as const).map((v) => (
                <button key={v} type="button" onClick={() => setView(v)} style={tabBtn(view === v)} aria-pressed={view === v}>
                  {v[0].toUpperCase() + v.slice(1)}
                </button>
              ))}
            </div>
          </div>
          <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ fontSize: 11, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.05em" }}>Show</span>
            {(["all", ...PEOPLE] as PersonFilter[]).map((p) => (
              <button key={p} type="button" onClick={() => setPerson(p)} style={{ ...tabBtn(person === p), padding: "5px 10px", fontSize: 12 }} aria-pressed={person === p}>
                {p === "all" ? "Everyone" : PERSON_LABEL[p]}
              </button>
            ))}
            <button
              type="button"
              onClick={() => { setFormErr(""); setDraft(emptyDraft(view === "month" ? todayKey : anchorKey, draftPerson)); }}
              style={{ ...tabBtn(false), marginLeft: "auto", padding: "5px 10px", fontSize: 12, borderColor: "var(--accent)", color: "var(--accent)" }}
            >
              + Add block
            </button>
            <button type="button" onClick={() => setShowHours((v) => !v)} style={{ ...tabBtn(showHours), padding: "5px 10px", fontSize: 12 }} aria-expanded={showHours}>
              Availability
            </button>
          </div>

          {draft ? (
            <BlockForm draft={draft} setDraft={setDraft} onSave={saveDraft} onDelete={deleteDraft} saving={saving} error={formErr} />
          ) : null}

          {showHours ? <AvailabilityPanel onClose={() => setShowHours(false)} /> : null}

          {view !== "month" ? (
            <WeekCalendar
              appointments={gridEvents}
              startDate={view === "week" ? weekStart : anchor}
              days={view === "week" ? 7 : 1}
              onEdit={(a) => {
                const ev = allEvents.find((e) => e.id === a.id);
                if (ev?.block) { setFormErr(""); setDraft(draftFrom(ev.block)); }
              }}
              onOpenBooking={(a) => setFocusBooking(a.id.replace(/^booking:/, ""))}
              emptyNote={
                missingCreds.length
                  ? `nothing scheduled · ${missingCreds.map((l) => l.label).join(", ")} not connected yet`
                  : view === "day" ? "nothing scheduled this day" : "nothing scheduled this week"
              }
            />
          ) : (
            <section style={{ ...card, padding: 0, overflow: "hidden" }}>
              <div className="cal-month-grid" style={{ display: "grid", gridTemplateColumns: "repeat(7, minmax(0, 1fr))", borderBottom: "1px solid var(--border)" }}>
                {DOW.map((d) => (
                  <div key={d} style={{ padding: "6px 4px", textAlign: "center", fontSize: 10, color: "var(--text-muted)", textTransform: "uppercase" }}>{d}</div>
                ))}
              </div>

              <div className="cal-month-grid" style={{ display: "grid", gridTemplateColumns: "repeat(7, minmax(0, 1fr))" }}>
                {cells.map((c, i) => {
                  if (!c) return <div key={i} style={{ minHeight: narrow ? 56 : 104, borderTop: "1px solid var(--border)", borderLeft: i % 7 ? "1px solid var(--border)" : "none", background: "var(--bg-secondary)", opacity: 0.5 }} />;
                  const list = byDay[c.key] ?? [];
                  const isToday = c.key === todayKey;
                  return (
                    <div
                      key={i}
                      role="button"
                      tabIndex={0}
                      className="cal-day"
                      aria-label={`${c.key}, ${list.length} item${list.length === 1 ? "" : "s"}. Open day.`}
                      onClick={() => openDay(c.key)}
                      onKeyDown={(ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); openDay(c.key); } }}
                      style={{
                        minHeight: narrow ? 56 : 104,
                        padding: narrow ? 4 : 5,
                        cursor: "pointer",
                        display: "grid",
                        gap: 3,
                        alignContent: "start",
                        borderTop: "1px solid var(--border)",
                        borderLeft: i % 7 ? "1px solid var(--border)" : "none",
                        background: isToday ? "var(--accent-glow)" : "transparent",
                        color: "var(--text-secondary)",
                        overflow: "hidden",
                      }}
                    >
                      <span
                        style={{
                          ...num, fontSize: 12, fontWeight: isToday ? 700 : 500,
                          color: isToday ? "var(--bg-card)" : "var(--text-primary)",
                          background: isToday ? "var(--accent)" : "transparent",
                          borderRadius: "50%", width: 22, height: 22,
                          display: "flex", alignItems: "center", justifyContent: "center",
                        }}
                      >
                        {c.day}
                      </span>
                      {narrow ? (
                        list.length ? (
                          <span style={{ display: "flex", gap: 3, flexWrap: "wrap" }} aria-hidden>
                            {list.slice(0, 6).map((e) => (
                              <span key={e.id} style={{ width: 6, height: 6, borderRadius: 99, background: e.color ?? SOURCE_COLOR[e.source] ?? "var(--accent)" }} />
                            ))}
                            {list.length > 6 ? <span style={{ fontSize: 9, color: "var(--text-muted)", lineHeight: "6px" }}>+{list.length - 6}</span> : null}
                          </span>
                        ) : null
                      ) : (
                        <>
                          {list.slice(0, chipMax).map((e) => {
                            const color = e.color ?? SOURCE_COLOR[e.source] ?? "var(--accent)";
                            const who = personOf(e);
                            return (
                              <button
                                key={e.id}
                                type="button"
                                className="cal-chip"
                                title={[e.title, who && who !== "team" ? PERSON_LABEL[who] : null, e.detail].filter(Boolean).join(" · ")}
                                onClick={(ev) => { ev.stopPropagation(); openEvent(e); }}
                                style={{
                                  font: "inherit", textAlign: "left", cursor: "pointer",
                                  fontSize: 10, lineHeight: 1.3, borderRadius: 4,
                                  padding: "1px 4px", background: `color-mix(in srgb, ${color} 14%, transparent)`,
                                  border: e.source === "blocks" ? `1px dashed ${color}` : "1px solid transparent",
                                  borderLeft: `2px solid ${color}`, color: "var(--text-primary)",
                                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                                }}
                              >
                                {e.allDay ? "" : `${time12(e.start)} `}
                                {e.title}
                                {e.source === "bookings" && who ? ` (${PERSON_LABEL[who] ?? who})` : ""}
                              </button>
                            );
                          })}
                          {list.length > chipMax ? (
                            <span style={{ fontSize: 10, color: "var(--text-muted)" }}>+{list.length - chipMax} more</span>
                          ) : null}
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
              <p style={{ margin: 0, padding: "8px 14px", fontSize: 12, color: "var(--text-muted)", borderTop: "1px solid var(--border)", ...num }}>
                {monthCount > 0
                  ? `${monthCount} ${monthCount === 1 ? "item" : "items"} this month${person !== "all" ? ` for ${PERSON_LABEL[person]}` : ""}. Tap a day to open it.`
                  : data
                  ? `Nothing scheduled this month${person !== "all" ? ` for ${PERSON_LABEL[person]}` : ""}.`
                  : ""}
              </p>
            </section>
          )}

          <BookingsAdmin focusId={focusBooking} onFocused={() => setFocusBooking(null)} />
        </>
      )}
    </div>
  );
}

// ── Availability panel ─────────────────────────────────────────────────────
// The hours the public booking link may offer, per person. Plain English,
// HH:MM time inputs, one Save per person. Reads and writes
// /api/calendar/availability (staff only).
type HourRange = [string, string];
type Hours = Partial<Record<string, HourRange[]>>;
type PersonHours = { person: string; label: string; hours: Hours; takes_bookings: boolean; exists: boolean };

const WEEKDAYS: { key: string; label: string }[] = [
  { key: "mon", label: "Monday" }, { key: "tue", label: "Tuesday" }, { key: "wed", label: "Wednesday" },
  { key: "thu", label: "Thursday" }, { key: "fri", label: "Friday" }, { key: "sat", label: "Saturday" }, { key: "sun", label: "Sunday" },
];

function AvailabilityPanel({ onClose }: { onClose: () => void }) {
  const [people, setPeople] = useState<PersonHours[] | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState("");
  const [savedFor, setSavedFor] = useState("");

  useEffect(() => {
    let live = true;
    fetch("/api/calendar/availability")
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (!live) return;
        if (!r.ok) { setErr(d?.message || `Could not read availability (HTTP ${r.status}).`); return; }
        setPeople(d.people as PersonHours[]);
      })
      .catch((e) => live && setErr(String(e)));
    return () => { live = false; };
  }, []);

  function update(person: string, patch: Partial<PersonHours>) {
    setPeople((ps) => (ps ?? []).map((p) => (p.person === person ? { ...p, ...patch } : p)));
  }
  function setRange(person: string, day: string, idx: number, range: HourRange | null) {
    setPeople((ps) =>
      (ps ?? []).map((p) => {
        if (p.person !== person) return p;
        const list = [...(p.hours[day] ?? [])];
        if (range) list[idx] = range; else list.splice(idx, 1);
        return { ...p, hours: { ...p.hours, [day]: list } };
      })
    );
  }

  async function save(p: PersonHours) {
    setBusy(p.person);
    setErr("");
    setSavedFor("");
    try {
      const hours: Hours = {};
      for (const [k, v] of Object.entries(p.hours)) if (v && v.length) hours[k] = v;
      const r = await fetch("/api/calendar/availability", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ person: p.person, hours, takes_bookings: p.takes_bookings }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setErr(d?.message || `Save failed (HTTP ${r.status}).`); return; }
      setSavedFor(p.person);
      update(p.person, { exists: true });
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy("");
    }
  }

  return (
    <section style={{ ...card, display: "grid", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <strong style={{ fontSize: 13 }}>Availability for the booking link</strong>
        <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
          Central Time. A slot is offered when at least one person here is free: inside their hours, no block on the calendar, no other booking.
        </span>
        <button type="button" onClick={onClose} style={{ ...btn, marginLeft: "auto" }}>Close</button>
      </div>
      {err ? <p style={{ margin: 0, fontSize: 12, color: "var(--red)" }}>{err}</p> : null}
      {!people && !err ? <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)" }}>Loading…</p> : null}
      {(people ?? []).map((p) => (
        <div key={p.person} style={{ border: "1px solid var(--border)", borderRadius: 10, padding: 10, display: "grid", gap: 8, background: "var(--bg-secondary)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <strong style={{ fontSize: 13 }}>{p.label}</strong>
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--text-secondary)", cursor: "pointer" }}>
              <input type="checkbox" checked={p.takes_bookings} onChange={(e) => update(p.person, { takes_bookings: e.target.checked })} />
              Takes bookings from the public link
            </label>
            {!p.exists ? <span style={{ fontSize: 11, color: "var(--orange)" }}>No hours saved yet</span> : null}
            <button
              type="button"
              disabled={busy === p.person}
              onClick={() => save(p)}
              style={{ ...btn, marginLeft: "auto", borderColor: "var(--accent)", color: "var(--accent)", background: "var(--accent-glow)" }}
            >
              {busy === p.person ? "Saving…" : savedFor === p.person ? "Saved" : `Save ${p.label}`}
            </button>
          </div>
          <div style={{ display: "grid", gap: 4, opacity: p.takes_bookings ? 1 : 0.6 }}>
            {WEEKDAYS.map((d) => {
              const ranges = p.hours[d.key] ?? [];
              return (
                <div key={d.key} style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", fontSize: 12 }}>
                  <span style={{ width: 80, color: "var(--text-secondary)" }}>{d.label}</span>
                  {ranges.length === 0 ? <span style={{ color: "var(--text-muted)" }}>Off</span> : null}
                  {ranges.map((r, i) => (
                    <span key={i} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                      <input type="time" value={r[0]} onChange={(e) => setRange(p.person, d.key, i, [e.target.value, r[1]])} style={timeInput} />
                      <span style={{ color: "var(--text-muted)" }}>to</span>
                      <input type="time" value={r[1]} onChange={(e) => setRange(p.person, d.key, i, [r[0], e.target.value])} style={timeInput} />
                      <button type="button" onClick={() => setRange(p.person, d.key, i, null)} style={{ ...btn, padding: "2px 7px" }} aria-label={`Remove ${d.label} hours`}>✕</button>
                    </span>
                  ))}
                  <button type="button" onClick={() => setRange(p.person, d.key, ranges.length, ["09:00", "17:00"])} style={{ ...btn, padding: "2px 7px", fontSize: 11 }}>
                    + hours
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </section>
  );
}

// ── Block form ─────────────────────────────────────────────────────────────
function BlockForm({
  draft, setDraft, onSave, onDelete, saving, error,
}: {
  draft: BlockDraft;
  setDraft: (d: BlockDraft | null) => void;
  onSave: () => void;
  onDelete: () => void;
  saving: boolean;
  error: string;
}) {
  const set = (patch: Partial<BlockDraft>) => setDraft({ ...draft, ...patch });
  return (
    <section style={{ ...card, display: "grid", gap: 10 }}>
      <strong style={{ fontSize: 13 }}>{draft.id ? "Edit block" : "New block"}</strong>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <label style={label}>
          Title
          <input value={draft.title} onChange={(e) => set({ title: e.target.value })} placeholder="Study, calls, deep work…" style={{ ...input, minWidth: 180 }} />
        </label>
        <label style={label}>
          Date
          <input type="date" value={draft.date} onChange={(e) => set({ date: e.target.value })} style={input} />
        </label>
        <label style={label}>
          Start
          <input type="time" value={draft.start_time} onChange={(e) => set({ start_time: e.target.value })} style={input} />
        </label>
        <label style={label}>
          End
          <input type="time" value={draft.end_time} onChange={(e) => set({ end_time: e.target.value })} style={input} />
        </label>
      </div>
      <div style={{ display: "grid", gap: 4 }}>
        <span style={{ ...label, flex: "none" }}>Whose time</span>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {[...PEOPLE, "team"].map((p) => {
            const active = draft.person === p;
            return (
              <button key={p} type="button" onClick={() => set({ person: p })} aria-pressed={active} style={chip(active)}>
                {p === "team" ? "Whole team" : PERSON_LABEL[p]}
              </button>
            );
          })}
        </div>
      </div>
      <div style={{ display: "grid", gap: 4 }}>
        <span style={{ ...label, flex: "none" }}>Category</span>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {BLOCK_CATEGORIES.map((c) => {
            const active = draft.category === c;
            return (
              <button key={c} type="button" onClick={() => set({ category: c })} aria-pressed={active} style={chip(active)}>{c}</button>
            );
          })}
        </div>
      </div>
      <label style={{ ...label, width: "100%" }}>
        Notes (optional)
        <input value={draft.notes} onChange={(e) => set({ notes: e.target.value })} style={input} />
      </label>
      <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--text-secondary)", cursor: "pointer" }}>
        <input type="checkbox" checked={draft.weekly} onChange={(e) => set({ weekly: e.target.checked })} />
        Repeat weekly on this weekday
      </label>
      <p style={{ margin: 0, fontSize: 11, color: "var(--text-muted)" }}>
        Blocks also hide that person's booking slots on the public link.
      </p>
      {error ? <p style={{ margin: 0, fontSize: 12, color: "var(--red)" }}>{error}</p> : null}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button type="button" onClick={onSave} disabled={saving} style={{ ...btn, borderColor: "var(--accent)", color: "var(--accent)", background: "var(--accent-glow)", opacity: saving ? 0.6 : 1 }}>
          {saving ? "Saving…" : draft.id ? "Save changes" : "Add block"}
        </button>
        <button type="button" onClick={() => setDraft(null)} disabled={saving} style={btn}>Cancel</button>
        {draft.id ? (
          <button type="button" onClick={onDelete} disabled={saving} style={{ ...btn, marginLeft: "auto", borderColor: "var(--red)", color: "var(--red)" }}>
            Delete block
          </button>
        ) : null}
      </div>
    </section>
  );
}

const label: React.CSSProperties = {
  display: "grid", gap: 4, fontSize: 11, color: "var(--text-muted)",
  textTransform: "uppercase", letterSpacing: "0.05em", flex: "1 1 120px",
};

const input: React.CSSProperties = {
  font: "inherit", fontSize: 13, color: "var(--text-primary)", background: "var(--bg-secondary)",
  border: "1px solid var(--border)", borderRadius: 8, padding: "7px 10px", width: "100%",
};

const timeInput: React.CSSProperties = {
  font: "inherit", fontSize: 12, color: "var(--text-primary)", background: "var(--bg-card)",
  border: "1px solid var(--border)", borderRadius: 6, padding: "3px 6px",
};

const card: React.CSSProperties = {
  background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 14, padding: 16,
};

const btn: React.CSSProperties = {
  font: "inherit", background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 8,
  color: "var(--text-secondary)", padding: "5px 10px", fontSize: 12, cursor: "pointer",
};

function chip(active: boolean): React.CSSProperties {
  return {
    ...btn, padding: "6px 12px",
    borderColor: active ? "var(--accent)" : "var(--border)",
    color: active ? "var(--accent)" : "var(--text-secondary)",
    background: active ? "var(--accent-glow)" : "var(--bg-card)",
  };
}

function tabBtn(active: boolean): React.CSSProperties {
  return {
    ...btn, padding: "7px 14px", fontSize: 13,
    borderColor: active ? "var(--accent)" : "var(--border)",
    color: active ? "var(--accent)" : "var(--text-secondary)",
    background: active ? "var(--accent-glow)" : "var(--bg-card)",
  };
}

const navBtn: React.CSSProperties = {
  background: "var(--bg-hover)", border: "1px solid var(--border)", borderRadius: 6,
  width: 28, height: 28, cursor: "pointer", color: "var(--text-primary)",
  fontSize: 16, display: "flex", alignItems: "center", justifyContent: "center", padding: 0,
};
