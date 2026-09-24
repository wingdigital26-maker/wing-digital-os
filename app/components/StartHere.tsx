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
  { icon: Note, name: "CRM", blurb: "Every email going out, the replies back, and who to call", view: "email" },
  { icon: Call, name: "Call Room", blurb: "Dial the lead list and log what happened", href: "/calls" },
  { icon: Route, name: "Automations", blurb: "When something happens, do these things, with nobody at the keyboard", href: "/automations" },
  { icon: Calendar, name: "Calendar", blurb: "Invoices and payments, on the day each one lands", view: "calendar" },
  { icon: Cpu, name: "Agents", blurb: "What the automated agents are doing", view: "agent" },
];

export function goToView(id: string) {
  sfx.play("nav");
  window.dispatchEvent(new CustomEvent("os:navigate", { detail: id }));
}

// ── How this OS works: a plain-English guide for someone with zero context ──
const GUIDE_KEY = "wingos.guideCollapsed";

function readGuideCollapsed(): boolean {
  try { return window.localStorage.getItem(GUIDE_KEY) === "1"; } catch { return false; }
}
function writeGuideCollapsed(v: boolean) {
  try {
    if (v) window.localStorage.setItem(GUIDE_KEY, "1");
    else window.localStorage.removeItem(GUIDE_KEY);
  } catch { /* storage blocked: the choice just does not persist */ }
}

function ViewLink({ view, children }: { view: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={() => goToView(view)}
      style={{
        background: "none", border: "none", padding: 0, minHeight: 0, cursor: "pointer",
        font: "inherit", fontWeight: 700, color: "var(--accent)", textDecoration: "underline",
      }}
    >
      {children}
    </button>
  );
}

const GUIDE_SECTIONS: { name: string; blurb: string; view?: string; href?: string }[] = [
  { view: "clients", name: "Clients", blurb: "who pays us and how their sites are doing." },
  { view: "email", name: "CRM", blurb: "every email going out, every reply back, and the people in line for one." },
  { href: "/automations", name: "Automations", blurb: "the robots; they draft, you approve." },
  { view: "agent", name: "Agents", blurb: "what ran overnight and whether it worked." },
];

function HowItWorks() {
  const [collapsed, setCollapsed] = useState<boolean | null>(null);
  useEffect(() => { setCollapsed(readGuideCollapsed()); }, []);
  if (collapsed === null) return null;

  const rowText: React.CSSProperties = { fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.55 };

  return (
    <div style={{ marginTop: 14, borderTop: "1px solid var(--border)", paddingTop: 10 }}>
      <button
        type="button"
        aria-expanded={!collapsed}
        onClick={() => { const next = !collapsed; writeGuideCollapsed(next); setCollapsed(next); }}
        style={{
          background: "none", border: "none", padding: 0, minHeight: 0, cursor: "pointer",
          display: "flex", alignItems: "center", gap: 6,
          fontSize: 12, fontWeight: 700, color: "var(--text-primary)",
        }}
      >
        <span aria-hidden style={{ fontSize: 10, color: "var(--text-muted)" }}>{collapsed ? "▸" : "▾"}</span>
        How this OS works
      </button>

      {!collapsed && (
        <div style={{ marginTop: 8, display: "grid", gap: 8 }}>
          <p style={rowText}>
            Wing Digital runs marketing for its clients. This OS is the one screen where all of that
            gets watched and approved: what the clients are getting, who we are talking to, and what
            the automated helpers did while nobody was looking.
          </p>

          <ul style={{ ...rowText, margin: 0, paddingLeft: 18, display: "grid", gap: 3 }}>
            {GUIDE_SECTIONS.map((g) => (
              <li key={g.name}>
                {g.view ? (
                  <ViewLink view={g.view}>{g.name}</ViewLink>
                ) : (
                  <a href={g.href} style={{ fontWeight: 700, color: "var(--accent)", textDecoration: "underline" }}>{g.name}</a>
                )}
                : {g.blurb}
              </li>
            ))}
          </ul>

          <p style={rowText}>
            <strong style={{ color: "var(--text-primary)" }}>Safety:</strong> no robot sends anything to a real
            person unless Jack arms it; automations only make drafts. The one exception is you:
            hitting Send on an email yourself sends it for real, right away.
          </p>

          <p style={rowText}>
            <strong style={{ color: "var(--text-primary)" }}>Three things to check daily:</strong>{" "}
            the <ViewLink view="today">Today board</ViewLink>, the{" "}
            <ViewLink view="replies">Reply Inbox</ViewLink>, and the{" "}
            <ViewLink view="clients">health board</ViewLink>.
          </p>

          <p style={{ ...rowText, color: "var(--text-muted)" }}>
            Tip: press Ctrl+K to jump anywhere.
          </p>
        </div>
      )}
    </div>
  );
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
    <section className="start-here v2-card" aria-label="Start here" style={{
      padding: "18px 20px",
    }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
        <div style={{ minWidth: 0 }}>
          <h2 className="v2-h" style={{ fontSize: 16 }}>Start here</h2>
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
            padding: "12px 14px", cursor: "pointer", border: "none",
            color: "inherit", textDecoration: "none", width: "100%", minHeight: 44,
          };
          return typeof t.view === "string" ? (
            <button key={t.name} type="button" className="start-here-tile v2-inner v2-lift" style={style} onClick={() => goToView(t.view as string)}>{inner}</button>
          ) : (
            <a key={t.name} href={t.href ?? "#"} className="start-here-tile v2-inner v2-lift" style={style}>{inner}</a>
          );
        })}
      </div>

      <HowItWorks />
    </section>
  );
}

// ── Today strip ────────────────────────────────────────────────────────────
type Summary = {
  as_of?: string;
  tasks_due_today: number | null;
  tasks_overdue: number | null;
  new_leads_7d: number | null;
  automations_active: number | null;
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
  const tiles: (TodayTile & { variant: "amber" | "blue" | "violet" })[] = [
    { label: "Tasks due today", value: s.tasks_due_today, hint: overdue ? `${overdue} overdue` : null, href: "/automations/tasks", variant: "amber" },
    { label: "New leads this week", value: s.new_leads_7d, href: "/automations/runs", variant: "blue" },
    { label: "Automations running", value: s.automations_active, href: "/automations", variant: "violet" },
    // 2026-09-22: "Calls booked, next 7 days", "Open deals" and "Unread texts"
    // were removed. Each pointed at a surface deleted the same day -- the
    // booking calendar, the deals grid inside Contacts, and the texting tab.
    // A tile that counts something you can no longer go and look at is worse
    // than no tile: it invites a click that lands somewhere unrelated.
  ];

  return (
    <section aria-label="Today">
      <p style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8 }}>Today</p>
      <div className="today-grid">
        {tiles.map((t) => {
          const known = typeof t.value === "number";
          const inner = (
            <>
              <div className="v2-icon-chip" aria-hidden="true" style={{ width: 32, height: 32 }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 3" /></svg>
              </div>
              <span className="v2-tile__num" style={{
                fontSize: known ? 24 : 13, color: known ? "var(--text-primary)" : "var(--text-muted)",
              }}>
                {known ? t.value!.toLocaleString() : "not available"}
              </span>
              <span className="v2-tile__label" style={{ color: "var(--text-secondary)" }}>
                {t.label}{t.hint ? <span style={{ color: "var(--orange)" }}> · {t.hint}</span> : null}
              </span>
            </>
          );
          const style: React.CSSProperties = {
            display: "flex", flexDirection: "column", gap: 6, textAlign: "left", cursor: "pointer",
            color: "inherit", textDecoration: "none", width: "100%",
          };
          return typeof t.view === "string" ? (
            <button key={t.label} type="button" className={`v2-tile v2-tile--${t.variant} v2-lift`} style={style} title={`Open ${t.label.toLowerCase()}`} onClick={() => goToView(t.view as string)}>{inner}</button>
          ) : (
            <a key={t.label} href={t.href ?? "#"} className={`v2-tile v2-tile--${t.variant} v2-lift`} style={style} title={`Open ${t.label.toLowerCase()}`}>{inner}</a>
          );
        })}
      </div>
    </section>
  );
}
