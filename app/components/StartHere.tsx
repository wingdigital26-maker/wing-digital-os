"use client";
// ───────────────────────────────────────────────────────────────────────────
// Start here + Today: the first two things on the home screen.
//
// Built for someone who is not Jack. Start here names the six places a new
// user will actually go and says in one plain sentence what each one is for.
// Today is the handful of numbers that change what you do next, each one a
// click away from the thing it counts. A number the database did not answer
// renders as "not available", never as 0.
// ───────────────────────────────────────────────────────────────────────────
import { useEffect, useState } from "react";
import { Users, Note, Call, Route, Calendar, Cpu } from "reicon-react";
import { sfx } from "../lib/sounds";

type IconType = React.ComponentType<{ size?: number; color?: string }>;

const HIDE_KEY = "wingos.startHereHidden";

function readHidden(): boolean {
  try { return window.localStorage.getItem(HIDE_KEY) === "1"; } catch { return false; }
}
function writeHidden(v: boolean) {
  try {
    if (v) window.localStorage.setItem(HIDE_KEY, "1");
    else window.localStorage.removeItem(HIDE_KEY);
  } catch { /* storage blocked: the choice just does not persist */ }
}

// In-shell destinations switch the mounted view through the shell's
// os:navigate event; routed sections are plain links.
type Tile =
  | { icon: IconType; name: string; blurb: string; view: string; href?: undefined }
  | { icon: IconType; name: string; blurb: string; href: string; view?: undefined };

const TILES: Tile[] = [
  { icon: Users, name: "Clients", blurb: "Who pays you and how their sites are doing", view: "clients" },
  { icon: Note, name: "CRM", blurb: "Every contact, deal, email, text and reply", view: "crm" },
  { icon: Call, name: "Call Room", blurb: "Dial the lead list and log what happened", href: "/calls" },
  { icon: Route, name: "Automations", blurb: "When something happens, do these things, with nobody at the keyboard", href: "/automations" },
  { icon: Calendar, name: "Calendar", blurb: "Bookings, call-backs, classes and payments", view: "calendar" },
  { icon: Cpu, name: "Agents", blurb: "What the automated agents are doing", view: "agent" },
];

export function goToView(id: string) {
  sfx.play("nav");
  window.dispatchEvent(new CustomEvent("os:navigate", { detail: id }));
}

export default function StartHere() {
  // null until mounted so the server render and first client render agree.
  const [hidden, setHidden] = useState<boolean | null>(null);
  useEffect(() => {
    const id = window.requestAnimationFrame(() => setHidden(readHidden()));
    return () => window.cancelAnimationFrame(id);
  }, []);
  if (hidden === null) return null;

  if (hidden) {
    return (
      <button
        onClick={() => { writeHidden(false); setHidden(false); }}
        style={{
          alignSelf: "flex-start", background: "none", border: "none", padding: "2px 0",
          cursor: "pointer", fontSize: 11.5, color: "var(--text-muted)", textDecoration: "underline",
        }}
      >
        Show start here
      </button>
    );
  }

  return (
    <section className="start-here" aria-label="Start here" style={{
      border: "1px solid var(--border)", borderRadius: 16, padding: "18px 20px",
      background: "var(--bg-card)", boxShadow: "0 8px 24px var(--bg-hover)",
    }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
        <div style={{ minWidth: 0 }}>
          <h2 style={{ fontSize: 16, fontWeight: 800, color: "var(--text-primary)" }}>Start here</h2>
          <p style={{ fontSize: 12.5, color: "var(--text-secondary)", marginTop: 3 }}>
            This is your whole business in one place. Tap a section to open it.
          </p>
        </div>
        <button
          onClick={() => { writeHidden(true); setHidden(true); }}
          style={{ background: "none", border: "none", padding: 0, minHeight: 0, flexShrink: 0, cursor: "pointer", fontSize: 11.5, color: "var(--text-muted)", textDecoration: "underline", whiteSpace: "nowrap" }}
        >
          Hide this
        </button>
      </div>

      <div className="start-here-grid" style={{ marginTop: 14 }}>
        {TILES.map((t) => {
          const inner = (
            <>
              <span style={{ display: "inline-flex", color: "var(--accent)", flexShrink: 0, marginTop: 1 }}>
                <t.icon size={18} />
              </span>
              <span style={{ minWidth: 0 }}>
                <span style={{ display: "block", fontSize: 13.5, fontWeight: 700, color: "var(--text-primary)" }}>{t.name}</span>
                <span style={{ display: "block", fontSize: 11.5, color: "var(--text-secondary)", lineHeight: 1.4, marginTop: 2 }}>{t.blurb}</span>
                <span style={{ display: "block", fontSize: 10.5, color: "var(--text-muted)", marginTop: 6 }}>
                  {t.href ? "Opens a page" : "Opens a section"}
                </span>
              </span>
            </>
          );
          const style: React.CSSProperties = {
            display: "flex", gap: 10, alignItems: "flex-start", textAlign: "left",
            padding: "12px 14px", borderRadius: 12, cursor: "pointer",
            border: "1px solid var(--border)", background: "var(--bg-secondary)",
            color: "inherit", textDecoration: "none", width: "100%", minHeight: 0,
          };
          return typeof t.view === "string" ? (
            <button key={t.name} type="button" className="start-here-tile" style={style} onClick={() => goToView(t.view as string)}>{inner}</button>
          ) : (
            <a key={t.name} href={t.href ?? "#"} className="start-here-tile" style={style}>{inner}</a>
          );
        })}
      </div>
    </section>
  );
}

// ── Today strip ────────────────────────────────────────────────────────────
type Summary = {
  as_of?: string;
  tasks_due_today: number | null;
  tasks_overdue: number | null;
  new_leads_7d: number | null;
  bookings_upcoming_7d: number | null;
  open_deals: number | null;
  automations_active: number | null;
  unread_texts: number | null;
};

type TodayTile = { label: string; value: number | null; hint?: string | null } & (
  | { href: string; view?: undefined }
  | { view: string; href?: undefined }
);

export function TodayStrip() {
  const [s, setS] = useState<Summary | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    const load = () => {
      fetch("/api/home/summary", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => { if (alive) setS(d ?? null); })
        .catch(() => { if (alive) setS(null); });
    };
    load();
    const id = setInterval(load, 5 * 60 * 1000);
    const onPull = () => load();
    window.addEventListener("os:pull-refresh", onPull);
    return () => { alive = false; clearInterval(id); window.removeEventListener("os:pull-refresh", onPull); };
  }, []);

  if (s === undefined) {
    return (
      <div className="today-grid" aria-label="Loading today">
        {[0, 1, 2, 3, 4, 5].map((i) => <div key={i} className="skel" style={{ height: 66, borderRadius: 12 }} />)}
      </div>
    );
  }
  if (s === null) {
    return (
      <p style={{ fontSize: 12, color: "var(--text-muted)" }}>
        Today&apos;s numbers are not available right now: the OS database did not answer.
      </p>
    );
  }

  const overdue = s.tasks_overdue;
  const tiles: TodayTile[] = [
    { label: "Tasks due today", value: s.tasks_due_today, hint: overdue ? `${overdue} overdue` : null, href: "/automations/tasks" },
    { label: "New leads this week", value: s.new_leads_7d, href: "/automations/runs" },
    { label: "Calls booked, next 7 days", value: s.bookings_upcoming_7d, view: "calendar" },
    { label: "Open deals", value: s.open_deals, view: "crm" },
    { label: "Automations running", value: s.automations_active, href: "/automations" },
    { label: "Unread texts", value: s.unread_texts, view: "text" },
  ];

  return (
    <section aria-label="Today">
      <p style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8 }}>Today</p>
      <div className="today-grid">
        {tiles.map((t) => {
          const known = typeof t.value === "number";
          const inner = (
            <>
              <span style={{
                display: "block", fontSize: known ? 24 : 12.5, fontWeight: known ? 800 : 600, lineHeight: 1.2,
                color: known ? "var(--text-primary)" : "var(--text-muted)",
                fontFamily: known ? "'Space Grotesk', sans-serif" : undefined,
              }}>
                {known ? t.value!.toLocaleString() : "not available"}
              </span>
              <span style={{ display: "block", fontSize: 11, color: "var(--text-secondary)", marginTop: 4, lineHeight: 1.3 }}>
                {t.label}{t.hint ? <span style={{ color: "var(--orange)" }}> · {t.hint}</span> : null}
              </span>
            </>
          );
          const style: React.CSSProperties = {
            display: "block", textAlign: "left", padding: "12px 14px", borderRadius: 12, cursor: "pointer",
            border: "1px solid var(--border)", background: "var(--bg-card)", color: "inherit",
            textDecoration: "none", width: "100%", minHeight: 0,
          };
          return typeof t.view === "string" ? (
            <button key={t.label} type="button" style={style} title={`Open ${t.label.toLowerCase()}`} onClick={() => goToView(t.view as string)}>{inner}</button>
          ) : (
            <a key={t.label} href={t.href ?? "#"} style={style} title={`Open ${t.label.toLowerCase()}`}>{inner}</a>
          );
        })}
      </div>
    </section>
  );
}
