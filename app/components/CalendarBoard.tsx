"use client";
import { useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import WeekCalendar, { SOURCE_COLOR, toLocal, type Appointment } from "./WeekCalendar";

const InvoicesBoard = dynamic(() => import("./InvoicesBoard"), { ssr: false });
const BookingsAdmin = dynamic(() => import("./BookingsAdmin"), { ssr: false });

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

type CalendarSource = "google" | "callbacks" | "payments" | "school" | "blocks" | "stripe" | "bookings";

// Lane-strip colour for sources WeekCalendar's SOURCE_COLOR does not know yet.
// Bookings events carry their own explicit color token from the API.
function laneColor(source: CalendarSource): string {
  return SOURCE_COLOR[source] ?? "var(--accent-2)";
}

// One row of Jack's own calendar_blocks table, carried on each block event so
// the UI can open it straight into the edit form.
type BlockRow = {
  id: string;
  title: string;
  date: string;
  start_time: string;
  end_time: string;
  category: string;
  notes: string | null;
  recurrence: string | null;
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

// What the block form is editing. `id` empty = creating a new block.
type BlockDraft = {
  id: string;
  title: string;
  date: string;
  start_time: string;
  end_time: string;
  category: string;
  notes: string;
  weekly: boolean;
};

// New blocks default to the next round hour so the form is usually ready to
// save with just a title.
function nextRoundHour(): { start: string; end: string } {
  const h = Math.min(new Date().getHours() + 1, 22);
  const p = (n: number) => String(n).padStart(2, "0");
  return { start: `${p(h)}:00`, end: `${p(Math.min(h + 1, 23))}:00` };
}

function emptyDraft(date: string): BlockDraft {
  const t = nextRoundHour();
  return { id: "", title: "", date, start_time: t.start, end_time: t.end, category: "work", notes: "", weekly: false };
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
  // Jack wants the week grid first — time blocks laid out like a class
  // schedule — with the month grid one toggle away.
  initialView = "week",
}: CalendarSectionProps) {
  const [tab, setTab] = useState<"calendar" | "invoices">(initialTab);
  const [view, setView] = useState<"month" | "week">(initialView);
  const [data, setData] = useState<Payload | null>(null);
  const [err, setErr] = useState("");
  const [monthOffset, setMonthOffset] = useState(0);
  const [openDay, setOpenDay] = useState<string | null>(null);

  // The block form: null = closed; a draft with no id = creating.
  const [draft, setDraft] = useState<BlockDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [formErr, setFormErr] = useState("");

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
      .then((d: Payload) => {
        if (!live) return;
        setData(d);
      })
      .catch((e) => live && setErr(String(e)));
    return () => {
      live = false;
    };
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
      };
      const res = await fetch("/api/blocks", {
        method: draft.id ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) {
        setFormErr(out?.error || `Save failed (HTTP ${res.status})`);
        return;
      }
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
      if (!res.ok) {
        setFormErr(out?.error || `Delete failed (HTTP ${res.status})`);
        return;
      }
      setDraft(null);
      await load();
    } catch (e) {
      setFormErr(String(e));
    } finally {
      setSaving(false);
    }
  }

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
        color: e.color ?? null,
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
              {lanes.filter((l) => l.configured).map((l) => (
                <span key={l.source} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
                  <span
                    style={{
                      width: 9, height: 9, borderRadius: 99,
                      background: laneColor(l.source),
                      border: `1px solid ${laneColor(l.source)}`,
                    }}
                  />
                  <span style={{ color: "var(--text-secondary)" }}>{l.label}</span>
                  <span style={{ ...num, color: "var(--text-muted)" }}>{l.count}</span>
                </span>
              ))}
              {!data && !err ? <span style={{ fontSize: 12, color: "var(--text-muted)" }}>Loading…</span> : null}
            </div>
            {/* Everything not connected collapses to one quiet plain-English
                line. The exact missing credential is kept off the screen and
                lives in a hover tooltip on the lane name. */}
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
              <p key={`n-${l.source}`} style={{ margin: 0, fontSize: 12, color: "var(--text-muted)" }}>
                {l.note}
              </p>
            ))}
            {laneErrors.map((l) => (
              <p key={`e-${l.source}`} style={{ margin: 0, fontSize: 12, color: "var(--red)" }}>
                {l.error}
              </p>
            ))}
            {err ? <p style={{ margin: 0, fontSize: 12, color: "var(--red)" }}>Calendar: {err}</p> : null}
          </section>

          {/* View switch + the one write this calendar owns: add a block. */}
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <button type="button" onClick={() => setView("week")} style={tabBtn(view === "week")}>
              Week
            </button>
            <button type="button" onClick={() => setView("month")} style={tabBtn(view === "month")}>
              Month
            </button>
            <button
              type="button"
              onClick={() => { setFormErr(""); setDraft(emptyDraft(todayKey)); }}
              style={{ ...tabBtn(false), marginLeft: "auto", borderColor: "var(--accent)", color: "var(--accent)" }}
            >
              + Add block
            </button>
          </div>

          {draft ? (
            <BlockForm
              draft={draft}
              setDraft={setDraft}
              onSave={saveDraft}
              onDelete={deleteDraft}
              saving={saving}
              error={formErr}
            />
          ) : null}

          {view === "week" ? (
            <WeekCalendar
              appointments={weekEvents}
              onEdit={(a) => {
                const ev = events.find((e) => e.id === a.id);
                if (ev?.block) { setFormErr(""); setDraft(draftFrom(ev.block)); }
              }}
              emptyNote={
                missingCreds.length
                  ? `nothing scheduled · ${missingCreds.map((l) => l.label).join(", ")} not connected yet`
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
                        const color = e.color ?? SOURCE_COLOR[e.source] ?? "var(--accent)";
                        return (
                          <span
                            key={e.id}
                            title={[e.title, e.detail].filter(Boolean).join(" · ")}
                            style={{
                              fontSize: 10, lineHeight: 1.3, borderRadius: 4,
                              padding: "1px 4px", background: color + "22",
                              // Manual blocks read apart from feed events: dashed edge.
                              border: e.source === "blocks" ? `1px dashed ${color}` : "none",
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
                    <div style={{ display: "flex", gap: 8 }}>
                      <button
                        type="button"
                        onClick={() => { setFormErr(""); setDraft(emptyDraft(openDay)); }}
                        style={{ ...btn, borderColor: "var(--accent)", color: "var(--accent)" }}
                      >
                        + Add block here
                      </button>
                      <button type="button" onClick={() => setOpenDay(null)} style={btn}>Close</button>
                    </div>
                  </div>
                  {openEvents.length === 0 ? (
                    <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)" }}>Nothing on this day.</p>
                  ) : null}
                  {openEvents.map((e) => {
                    const color = e.color ?? SOURCE_COLOR[e.source] ?? "var(--accent)";
                    return (
                      <div
                        key={e.id}
                        style={{
                          border: e.source === "blocks" ? `1px dashed ${color}` : "1px solid var(--border)",
                          borderLeft: `3px solid ${color}`,
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
                        {e.block ? (
                          <button
                            type="button"
                            onClick={() => { setFormErr(""); setDraft(draftFrom(e.block as BlockRow)); }}
                            style={{ ...btn, marginLeft: "auto", borderColor: "var(--accent)", color: "var(--accent)" }}
                          >
                            Edit
                          </button>
                        ) : null}
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

          {/* Bookings from the public /book link, managed right where they
              appear on the calendar. */}
          <BookingsAdmin />
        </>
      )}
    </div>
  );
}

// ── Block form ─────────────────────────────────────────────────────────────
// One small card that both creates and edits. Plain inputs, stacked on narrow
// screens via flex-wrap, token colours only.
function BlockForm({
  draft,
  setDraft,
  onSave,
  onDelete,
  saving,
  error,
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
          <input
            value={draft.title}
            onChange={(e) => set({ title: e.target.value })}
            placeholder="Study, calls, deep work…"
            style={{ ...input, minWidth: 180 }}
          />
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
      {/* One-tap category chips instead of a dropdown. */}
      <div style={{ display: "grid", gap: 4 }}>
        <span style={{ ...label, flex: "none" }}>Category</span>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {BLOCK_CATEGORIES.map((c) => {
            const active = draft.category === c;
            return (
              <button
                key={c}
                type="button"
                onClick={() => set({ category: c })}
                aria-pressed={active}
                style={{
                  ...btn,
                  padding: "6px 12px",
                  borderColor: active ? "var(--accent)" : "var(--border)",
                  color: active ? "var(--accent)" : "var(--text-secondary)",
                  background: active ? "var(--accent-glow)" : "var(--bg-card)",
                }}
              >
                {c}
              </button>
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
      {error ? <p style={{ margin: 0, fontSize: 12, color: "var(--red)" }}>{error}</p> : null}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button
          type="button"
          onClick={onSave}
          disabled={saving}
          style={{ ...btn, borderColor: "var(--accent)", color: "var(--accent)", background: "var(--accent-glow)", opacity: saving ? 0.6 : 1 }}
        >
          {saving ? "Saving…" : draft.id ? "Save changes" : "Add block"}
        </button>
        <button type="button" onClick={() => setDraft(null)} disabled={saving} style={btn}>
          Cancel
        </button>
        {draft.id ? (
          <button
            type="button"
            onClick={onDelete}
            disabled={saving}
            style={{ ...btn, marginLeft: "auto", borderColor: "var(--red)", color: "var(--red)" }}
          >
            Delete block
          </button>
        ) : null}
      </div>
    </section>
  );
}

const label: React.CSSProperties = {
  display: "grid",
  gap: 4,
  fontSize: 11,
  color: "var(--text-muted)",
  textTransform: "uppercase",
  letterSpacing: "0.05em",
  flex: "1 1 120px",
};

const input: React.CSSProperties = {
  font: "inherit",
  fontSize: 13,
  color: "var(--text-primary)",
  background: "var(--bg-secondary)",
  border: "1px solid var(--border)",
  borderRadius: 8,
  padding: "7px 10px",
  width: "100%",
};

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
