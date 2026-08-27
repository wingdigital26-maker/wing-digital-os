"use client";
import { useState, useEffect, useCallback, useRef } from "react";
import dynamic from "next/dynamic";
import { motion, MotionConfig } from "motion/react";
import { Bolt, Users, Cpu, Bulb, Calendar, Note, Sparkles } from "reicon-react";
import { staggerContainer, riseItem, hoverSpring, cardHover, cardHoverPassive, cardTap } from "./components/motion";
import { Sparkline, Delta, buildDailySeries } from "./components/Charts";
import { StatTiles, MissionPanels, MissionStyles, Selection, StatTile, WatchdogBanner, WatchdogData, MissionData } from "./components/MissionControlCore";
import { sfx } from "./lib/sounds";
import SfxMuteButton from "./components/SfxMuteButton";

type IconType = React.ComponentType<{ size?: number; color?: string }>;

const VaultGraph = dynamic(() => import("./components/VaultGraph"), { ssr: false });
const Search = dynamic(() => import("./components/Search"), { ssr: false });
const ActivityLog = dynamic(() => import("./components/ActivityLog"), { ssr: false });
const WeekCalendar = dynamic(() => import("./components/WeekCalendar"), { ssr: false });
const MissionOps = dynamic(() => import("./components/MissionOps"), { ssr: false });
const ClientsBoard = dynamic(() => import("./components/ClientsBoard"), { ssr: false });
const SonarBoard = dynamic(() => import("./components/SonarBoard"), { ssr: false });
const CrmBoard = dynamic(() => import("./components/CrmBoard"), { ssr: false });
const InvoicesBoard = dynamic(() => import("./components/InvoicesBoard"), { ssr: false });
const CompetitorIntel = dynamic(() => import("./components/CompetitorIntel"), { ssr: false });

type NavGroup = {
  id: string; label: string; icon: IconType;
  subs: { id: string; label: string }[];
};

const NAV: NavGroup[] = [
  {
    id: "command", label: "Command Center", icon: Bolt,
    subs: [
      { id: "command", label: "Overview" },
      { id: "personal", label: "Personal" },
    ],
  },
  {
    id: "clients", label: "Clients", icon: Users,
    subs: [
      { id: "clients", label: "Clients" },
      { id: "sonar", label: "Sonar Leads" },
    ],
  },
  {
    id: "crm", label: "CRM", icon: Note,
    subs: [{ id: "crm", label: "Outbound" }],
  },
  {
    id: "money", label: "Money", icon: Calendar,
    subs: [{ id: "invoices", label: "Invoices & Payments" }],
  },
  {
    id: "agent", label: "Agents", icon: Cpu,
    subs: [{ id: "agent", label: "Mission Control" }],
  },
  {
    id: "intel", label: "Intel", icon: Bulb,
    subs: [
      { id: "knowledge", label: "Knowledge Base" },
      { id: "competitors", label: "Competitor Intel" },
      { id: "log", label: "Activity Log" },
    ],
  },
];

// which group owns a given view id
function groupOf(viewId: string): NavGroup {
  return NAV.find(g => g.subs.some(s => s.id === viewId)) ?? NAV[0];
}

export default function Home() {
  const [active, setActive] = useState("command");
  // Keep-alive: once a section is visited it stays MOUNTED (hidden when not
  // active), so switching back is instant with no refetch or graph rebuild.
  const [visited, setVisited] = useState<Set<string>>(() => new Set(["command"]));
  useEffect(() => {
    setVisited(v => (v.has(active) ? v : new Set(v).add(active)));
  }, [active]);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [revenueData, setRevenueData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [openNotePath, setOpenNotePath] = useState<string | undefined>();
  // No CRM lead feed exists (GHL retired 2026-08-22), so there is no live
  // "new leads" counter. Kept at 0 so the nav badge simply never shows.
  const [newLeadCount, setNewLeadCount] = useState(0);

  // Phone flag: on mobile the secondary Intel views (Competitor Intel, Activity
  // Log) are dropped from the sub-tab strip so the Vault tab opens straight to
  // the graph. Desktop keeps the full set.
  const [isPhone, setIsPhone] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 768px)");
    const on = () => setIsPhone(mq.matches);
    on(); mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  // Views hidden from the phone sub-tab strip (still reachable on desktop).
  const MOBILE_HIDDEN_SUBS = new Set(["competitors", "log"]);

  // ── Pull-to-refresh (phone only, Command + Mission views) ───────────────
  const scrollRef = useRef<HTMLDivElement>(null);
  const pullStart = useRef<number | null>(null);
  const [pullY, setPullY] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const PTR_MAX = 90, PTR_TRIGGER = 64;
  const ptrEligible = () => (active === "command" || active === "agent" || active === "personal");
  const onTouchStart = (e: React.TouchEvent) => {
    const el = scrollRef.current;
    if (!el || refreshing || !ptrEligible() || el.scrollTop > 2) { pullStart.current = null; return; }
    pullStart.current = e.touches[0].clientY;
  };
  const onTouchMove = (e: React.TouchEvent) => {
    if (pullStart.current == null) return;
    const dy = e.touches[0].clientY - pullStart.current;
    if (dy <= 0) { setPullY(0); return; }
    // resistance curve so it feels rubbery, not linear
    setPullY(Math.min(PTR_MAX, dy * 0.5));
  };
  const onTouchEnd = () => {
    if (pullStart.current == null) return;
    pullStart.current = null;
    if (pullY >= PTR_TRIGGER) {
      setRefreshing(true);
      sfx.play("nav");
      try { fetchRevenue(); } catch { /* noop */ }
      window.dispatchEvent(new CustomEvent("os:pull-refresh"));
      setTimeout(() => setRefreshing(false), 900);
    }
    setPullY(0);
  };

  // Panels (e.g. the Active Clients stat breakdown) can ask the shell to jump
  // to a section: window.dispatchEvent(new CustomEvent("os:navigate", { detail: "clients" })).
  useEffect(() => {
    const onNav = (e: Event) => {
      const id = (e as CustomEvent).detail;
      if (typeof id === "string" && NAV.some(g => g.subs.some(s => s.id === id))) setActive(id);
    };
    window.addEventListener("os:navigate", onNav);
    return () => window.removeEventListener("os:navigate", onNav);
  }, []);

  function handleSearchOpenNote(path: string) {
    setActive("knowledge");
    setOpenNotePath(path);
  }

  // Sales section is gone; "ask the AI" now opens the Jarvis panel with the
  // context preloaded (JarvisButton listens for this event globally).
  function sendToAI(context: string) {
    window.dispatchEvent(new CustomEvent("jarvis:ask", { detail: context }));
  }

  // Revenue truth: /api/clients renders lib/revenue.ts (getRevenueTruth), the
  // single source of truth for MRR + client counts. The old /api/ghl fetch is
  // gone — that route is a permanent 410 since GHL was retired 2026-08-22.
  const fetchRevenue = useCallback(() => {
    fetch("/api/clients", { cache: "no-store" })
      .then(r => r.json())
      .then(d => {
        if (d.error) { setRevenueData({ error: d.error }); setLoading(false); return; }
        setRevenueData({
          mrr: d.mrr,
          activeClientCount: d.activeClients,
          nextExpiry: d.nextExpiry ?? null,
          pipelineTotal: d.pipelineTotal ?? 0,
          activeClients: (d.clients ?? [])
            .filter((c: any) => c.status === "active" && c.isClient !== false)
            .map((c: any) => ({
              id: c.slug,
              name: c.name,
              value: c.revenue?.amount ?? null,
              basisLabel: c.revenue?.label ?? "unknown",
              countsTowardMrr: !!c.revenue?.countsTowardMrr,
            })),
        });
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  useEffect(() => {
    fetchRevenue();
    const id = setInterval(fetchRevenue, 5 * 60 * 1000); // every 5 minutes
    return () => clearInterval(id);
  }, [fetchRevenue]);

  return (
    <MotionConfig reducedMotion="user">
    <div className="app-shell" style={{ display: "flex", height: "100vh", background: "var(--bg-primary)" }}>

      {/* Sidebar (desktop side rail; hidden on phone in favor of the bottom tab bar) */}
      <aside className="app-sidebar" style={{
        width: sidebarOpen ? 220 : 60,
        background: "var(--bg-secondary)",
        borderRight: "1px solid var(--border)",
        display: "flex", flexDirection: "column",
        transition: "width 0.2s ease",
        flexShrink: 0, overflow: "hidden",
      }}>
        <div style={{
          padding: "20px 16px", borderBottom: "1px solid var(--border)",
          display: "flex", alignItems: "center", gap: 10,
        }}>
          <div style={{
            width: 32, height: 32, borderRadius: 8,
            background: "linear-gradient(135deg, #22d3ee, #0e7490)",
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 16, flexShrink: 0, fontWeight: 700,
          }}>W</div>
          {sidebarOpen && (
            <span style={{ fontWeight: 700, fontSize: 14, color: "var(--text-primary)", whiteSpace: "nowrap" }}>
              Wing Digital OS
            </span>
          )}
        </div>

        <nav style={{ flex: 1, padding: "12px 8px", display: "flex", flexDirection: "column", gap: 2 }}>
          {NAV.map(item => {
            const isActive = groupOf(active).id === item.id;
            const hasBadge = item.id === "command" && newLeadCount > 0;
            return (
              <button key={item.id} onClick={() => {
                sfx.play("nav");
                setActive(item.subs[0].id);
                if (item.id === "command") setNewLeadCount(0);
              }} style={{
                display: "flex", alignItems: "center", gap: 10,
                padding: "10px 10px", borderRadius: 8, border: "none",
                background: isActive ? "var(--accent-glow)" : "transparent",
                borderLeft: isActive ? "2px solid var(--accent)" : "2px solid transparent",
                color: isActive ? "var(--text-primary)" : "var(--text-secondary)",
                cursor: "pointer", width: "100%", textAlign: "left",
                fontSize: 13, fontWeight: isActive ? 600 : 400,
                transition: "all 0.15s", position: "relative",
              }}>
                <span style={{ display: "inline-flex", flexShrink: 0, position: "relative", color: "currentColor" }}>
                  <item.icon size={16} />
                  {hasBadge && (
                    <span style={{
                      position: "absolute", top: -4, right: -6,
                      background: "var(--red)", color: "#fff",
                      fontSize: 9, fontWeight: 700, borderRadius: 20,
                      padding: "1px 4px", minWidth: 14, textAlign: "center",
                      lineHeight: "14px",
                    }}>{newLeadCount}</span>
                  )}
                </span>
                {sidebarOpen && <span style={{ whiteSpace: "nowrap" }}>{item.label}</span>}
              </button>
            );
          })}
        </nav>

        {/* NOTE: the sidebar Jarvis launcher was removed — it was a second AI
            trigger sitting bottom-left (right by the Da Boss chip), duplicating
            the floating Jarvis FAB (JarvisButton, bottom-right). Jarvis is now
            reached from exactly ONE place per screen: the FAB on desktop and the
            Jarvis tab in the bottom bar on phone. */}

        <button onClick={() => { sfx.play(sidebarOpen ? "toggle-off" : "toggle-on"); setSidebarOpen(!sidebarOpen); }} style={{
          margin: "8px", padding: "8px", borderRadius: 8, border: "none",
          background: "transparent", color: "var(--text-muted)",
          cursor: "pointer", fontSize: 16,
        }}>
          {sidebarOpen ? "◀" : "▶"}
        </button>
      </aside>

      {/* Main */}
      <main className="app-main" style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <header className="app-header" style={{
          padding: "16px 24px", borderBottom: "1px solid var(--border)",
          display: "flex", alignItems: "center", justifyContent: "space-between",
          background: "var(--bg-secondary)", flexShrink: 0,
        }}>
          <div>
            <h1 style={{ fontSize: 18, fontWeight: 700, display: "flex", alignItems: "center", gap: 8 }}>
              {(() => { const Icon = groupOf(active).icon; return <Icon size={18} />; })()}
              {groupOf(active).label}
            </h1>
            <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2 }}>
              {new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}
            </p>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <SfxMuteButton />
            <Search onOpenNote={handleSearchOpenNote} />
            <div className="header-avatar" style={{
              width: 34, height: 34, borderRadius: "50%",
              background: "linear-gradient(135deg, #22d3ee, #0e7490)",
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 14, fontWeight: 700,
            }}>J</div>
          </div>
        </header>

        {/* Sub-tabs for the active group (phone drops the secondary Intel views) */}
        {(() => {
          const subs = groupOf(active).subs.filter(s => !(isPhone && MOBILE_HIDDEN_SUBS.has(s.id)));
          return subs.length > 1 && (
          <div style={{
            display: "flex", gap: 6, padding: "10px 24px 0 24px",
            background: "var(--bg-primary)", flexShrink: 0, flexWrap: "wrap",
          }}>
            {subs.map(sub => (
              <button key={sub.id} onClick={() => { sfx.play("nav"); setActive(sub.id); }} style={{
                padding: "7px 16px", borderRadius: 999, fontSize: 12.5, cursor: "pointer",
                fontWeight: active === sub.id ? 700 : 500,
                border: active === sub.id ? "1px solid var(--accent)" : "1px solid var(--border)",
                background: active === sub.id ? "var(--accent-glow)" : "transparent",
                color: active === sub.id ? "var(--accent)" : "var(--text-secondary)",
                transition: "all 0.15s",
              }}>
                {sub.label}
              </button>
            ))}
          </div>
          );
        })()}

        <div
          ref={scrollRef}
          className="app-scroll"
          style={{ flex: 1, overflow: "auto", padding: "24px" }}
          onTouchStart={onTouchStart}
          onTouchMove={onTouchMove}
          onTouchEnd={onTouchEnd}
        >
          {/* Pull-to-refresh spinner (phone) */}
          <div className={`ptr-indicator${refreshing ? " spinning" : ""}`} aria-hidden="true"
            style={{ height: refreshing ? 44 : pullY, opacity: refreshing ? 1 : Math.min(1, pullY / 64) }}>
            <span className="ptr-spinner" style={{ transform: `rotate(${pullY * 3}deg)` }} />
            <span className="ptr-text">{refreshing ? "Refreshing" : pullY >= 64 ? "Release to refresh" : "Pull to refresh"}</span>
          </div>
          {/* CSS-only section transition: the new view mounts IMMEDIATELY
              (no JS-gated exit animation that can stall in background tabs). */}
          <style>{`@keyframes viewIn { from { transform: translateY(5px); } to { transform: none; } }`}</style>
          {/* Keep-alive views: each visited section stays mounted; only the
              active one is shown. Switching is instant, no reload/refetch. */}
          {visited.has("command") && <div className="app-view" style={{ display: active === "command" ? "block" : "none" }}><CommandCenter data={revenueData} loading={loading} onSendToAI={sendToAI} /></div>}
          {visited.has("clients") && <div className="app-view" style={{ display: active === "clients" ? "block" : "none" }}><ClientsBoard /></div>}
          {visited.has("sonar") && <div className="app-view" style={{ display: active === "sonar" ? "block" : "none" }}><SonarBoard /></div>}
          {visited.has("crm") && <div className="app-view" style={{ display: active === "crm" ? "block" : "none" }}><CrmBoard /></div>}
          {visited.has("invoices") && <div className="app-view" style={{ display: active === "invoices" ? "block" : "none" }}><InvoicesBoard /></div>}
          {visited.has("competitors") && <div className="app-view" style={{ display: active === "competitors" ? "block" : "none" }}><CompetitorIntel onSendToAI={sendToAI} /></div>}
          {visited.has("knowledge") && <div className="app-view" style={{ display: active === "knowledge" ? "block" : "none" }}><KnowledgeBase initialPath={openNotePath} onSendToAI={sendToAI} /></div>}
          {visited.has("agent") && <div className="app-view" style={{ display: active === "agent" ? "block" : "none" }}><MissionOps /></div>}
          {visited.has("log") && <div className="app-view" style={{ display: active === "log" ? "block" : "none" }}><ActivityLog /></div>}
          {visited.has("personal") && <div className="app-view" style={{ display: active === "personal" ? "block" : "none" }}><PersonalSection /></div>}
        </div>
      </main>

      {/* Mobile bottom tab bar — primary nav on phone, replaces the side rail */}
      <MobileNav active={active} onNavigate={(id) => {
        sfx.play("nav");
        setActive(id);
        if (groupOf(id).id === "command") setNewLeadCount(0);
      }} newLeadCount={newLeadCount} />

      {/* Global Da Boss status — visible on every section, like Jarvis */}
      <GlobalDaBoss />
    </div>
    </MotionConfig>
  );
}

// Fixed bottom tab bar shown only on phone (see .mobile-nav in globals.css).
// Icons + short labels for the core sections plus Jarvis, with active highlight,
// safe-area padding for the home indicator, and the nav tick sfx on change.
function MobileNav({ active, onNavigate, newLeadCount }: {
  active: string; onNavigate: (id: string) => void; newLeadCount: number;
}) {
  const activeGroup = groupOf(active).id;
  // The five essentials only. Agents = Mission Control, Vault = the knowledge
  // graph (its folder tree lives INSIDE the vault view as a slide-in drawer, so
  // there is no Competitor Intel / Activity Log / table-of-contents clutter in
  // the bar). Jarvis is the merged assistant; tapping it opens the panel.
  const tabs: { id: string; label: string; icon: IconType; group: string; badge?: number }[] = [
    { id: "command", label: "Command", icon: Bolt, group: "command", badge: newLeadCount },
    { id: "agent", label: "Agents", icon: Cpu, group: "agent" },
    { id: "knowledge", label: "Vault", icon: Bulb, group: "intel" },
    { id: "clients", label: "Clients", icon: Users, group: "clients" },
  ];
  return (
    <nav className="mobile-nav" aria-label="Primary">
      {tabs.map(t => {
        const on = activeGroup === t.group;
        return (
          <button key={t.id} className={`mobile-nav-btn${on ? " on" : ""}`} onClick={() => onNavigate(t.id)}>
            <span className="mobile-nav-ico">
              <t.icon size={21} />
              {!!t.badge && t.badge > 0 && <span className="mobile-nav-badge">{t.badge}</span>}
            </span>
            <span>{t.label}</span>
          </button>
        );
      })}
      {/* Jarvis lives in the bar as the fifth essential; the floating FAB is
          hidden on phone (globals.css) so there is only ever one Jarvis trigger. */}
      <button className="mobile-nav-btn jarvis" onClick={() => { sfx.play("nav"); window.dispatchEvent(new CustomEvent("jarvis:open")); }}>
        <span className="mobile-nav-ico"><Sparkles size={21} /></span>
        <span>Jarvis</span>
      </button>
    </nav>
  );
}

// Persistent, app-wide Da Boss status chip. Reads /api/mission (same payload
// Mission Control uses), shows blue=clear / red=problems / amber=stale, and
// taps open the full WatchdogPanel (portaled bottom sheet) from anywhere.
function GlobalDaBoss() {
  const [data, setData] = useState<MissionData | null>(null);
  const [sel, setSel] = useState<Selection>(null);
  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/mission", { cache: "no-store" });
      if (r.ok) setData(await r.json());
    } catch { /* stay quiet; chip just shows last-known */ }
  }, []);
  useEffect(() => {
    load();
    const id = setInterval(load, 60 * 1000);
    const onPull = () => load();
    window.addEventListener("os:pull-refresh", onPull);
    window.addEventListener("os:mission-refresh", onPull);
    return () => {
      clearInterval(id);
      window.removeEventListener("os:pull-refresh", onPull);
      window.removeEventListener("os:mission-refresh", onPull);
    };
  }, [load]);

  const wd = data?.watchdog;
  const count = wd ? Math.max(wd.problemCount ?? 0, wd.problems?.length ?? 0) : 0;
  const hasProblems = !!wd && (wd.overall === "problems" || count > 0);
  // stale = older than 3h (watchdog runs every 2h)
  let stale = false;
  if (wd?.updated) {
    const ageMin = (Date.now() - new Date(wd.updated).getTime()) / 60000;
    stale = ageMin > 180;
  }
  const state = hasProblems ? "red" : stale ? "amber" : "blue";
  const color = state === "red" ? "var(--red)" : state === "amber" ? "var(--orange)" : "var(--accent)";
  const label = state === "red" ? `${count} problem${count === 1 ? "" : "s"}` : state === "amber" ? "late" : "all clear";

  // Only surface the floating chip when there is something to act on: a real
  // problem COUNT > 0, or the amber stale/late state. We key on the actual count
  // (not watchdog.overall, which can read "problems" with a 0 count) so an
  // all-clear patrol shows no chip at all. Da Boss stays openable from the
  // Agents/Mission view; the report panel still renders if it was opened.
  const showChip = count > 0 || stale;

  return (
    <>
      {showChip && (
      <button
        className={`daboss-chip${state === "red" ? " alert" : ""}`}
        onClick={() => { sfx.play("blip-watchdog"); setSel({ type: "watchdog" }); }}
        aria-label={`Da Boss: ${label}. Open report.`}
        title={`Da Boss: ${label}`}
        style={{
          position: "fixed", zIndex: 9997,
          display: "inline-flex", alignItems: "center", gap: 7,
          padding: "8px 12px", minHeight: 40, borderRadius: 999,
          border: `1px solid ${color}`, background: "var(--bg-card)",
          backdropFilter: "blur(10px)", color, cursor: "pointer",
          fontSize: 12, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace",
          boxShadow: `0 4px 18px ${color}33`,
          transition: "none", // color must reflect state instantly (a transition gets stuck under re-render)
        }}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
        </svg>
        <span className="daboss-dot" style={{ width: 7, height: 7, borderRadius: "50%", background: color, boxShadow: `0 0 8px ${color}` }} />
        <span>{label}</span>
      </button>
      )}
      <style>{`
        /* Desktop: bottom-left corner (opposite the bottom-right Jarvis FAB) */
        .daboss-chip { bottom: 22px; left: 22px; }
        .daboss-chip.alert { animation: dabossPulse 1.8s ease-in-out infinite; }
        @keyframes dabossPulse { 0%,100% { box-shadow: 0 0 0 0 rgba(248,113,113,0.5); } 50% { box-shadow: 0 0 0 8px rgba(248,113,113,0); } }
        /* Phone: dock at bottom-LEFT, above the tab bar and opposite the
           bottom-right Jarvis FAB. This keeps it fully clear of the header
           title/date and the header's search + mute controls, which the old
           top-right placement used to cover. */
        @media (max-width: 768px) {
          .daboss-chip {
            top: auto; right: auto;
            left: 12px;
            bottom: calc(72px + env(safe-area-inset-bottom, 0px));
            padding: 6px 10px !important; font-size: 11px !important;
          }
        }
      `}</style>
      {sel && <MissionPanels selection={sel} data={data} onSelect={setSel} onRechecked={() => { load(); window.dispatchEvent(new CustomEvent("os:mission-refresh")); }} />}
    </>
  );
}

function CommandCenter({ data, loading, onSendToAI }: { data: any; loading: boolean; onSendToAI: (ctx: string) => void }) {
  const [showNewNote, setShowNewNote] = useState(false);
  const [noteForm, setNoteForm] = useState({ title: "", content: "" });
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState("");

  const [showCalendar, setShowCalendar] = useState(false);
  const [calendarKey, setCalendarKey] = useState(0);
  const [coldStats, setColdStats] = useState<{ dialedToday: number; booked: number } | null>(null);
  const [brief, setBrief] = useState<any>(null);
  const [showBriefing, setShowBriefing] = useState(false);
  const [camp, setCamp] = useState<any>(null);
  const [sentToday, setSentToday] = useState<number | null>(null);
  const [agentHealth, setAgentHealth] = useState<any[]>([]);
  const [missionStats, setMissionStats] = useState<{ tiles: StatTile[]; updated: string | null } | null>(null);
  const [watchdog, setWatchdog] = useState<WatchdogData | null | undefined>(undefined);
  const [statSelection, setStatSelection] = useState<Selection>(null);

  // Command Center absorbs the mission stats row (MRR, active clients,
  // pipeline size, emails sent) — big tiles, zero configuration.
  // Da Boss coherence: the banner, the global chip, and the report panel all
  // read the SAME /api/mission watchdog block. Any refresh (Run Da Boss, the
  // granular recheck, pull-to-refresh, or the poll) broadcasts os:mission-refresh
  // so every surface re-pulls together and none is left showing a stale count.
  const loadMission = useCallback(() => {
    fetch("/api/mission", { cache: "no-store" })
      .then(r => r.json())
      .then(d => {
        if (d?.stats?.tiles) setMissionStats(d.stats);
        setWatchdog(d?.watchdog ?? null);
      })
      .catch(() => {});
  }, []);
  useEffect(() => {
    loadMission();
    const id = setInterval(loadMission, 5 * 60 * 1000);
    const onRefresh = () => loadMission();
    window.addEventListener("os:mission-refresh", onRefresh);
    window.addEventListener("os:pull-refresh", onRefresh);
    return () => {
      clearInterval(id);
      window.removeEventListener("os:mission-refresh", onRefresh);
      window.removeEventListener("os:pull-refresh", onRefresh);
    };
  }, [loadMission]);

  useEffect(() => {
    fetch("/api/agents/brief")
      .then(r => r.json())
      .then(d => { if (d.brief) setBrief(d.brief); })
      .catch(() => {});
    fetch("/api/campaign")
      .then(r => r.json())
      .then(d => { if (!d.error) setCamp(d); })
      .catch(() => {});
    fetch("/api/sales-metrics")
      .then(r => r.json())
      .then(d => { if (typeof d.sentToday === "number") setSentToday(d.sentToday); })
      .catch(() => {});
    fetch("/api/agents/health")
      .then(r => r.json())
      .then(d => {
        // only the 4 keeper agents remain in the system; filter out any dead
        // scheduled tasks (guardian, radar, tempest, hound, scribe, jackson-outreach)
        const KEEPERS = new Set(["dispatch", "prospector", "outreach", "chronicler"]);
        if (Array.isArray(d.agents)) setAgentHealth(d.agents.filter((a: any) => KEEPERS.has((a.name || "").toLowerCase())));
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetch("/api/prospects").then(r => r.json()).then(d => {
      const rows = d.prospects ?? [];
      const today = new Date().toDateString();
      const dialedToday = rows.filter((p: any) =>
        p.status && p.status !== "new" && p.status !== "closed" && p.status !== "enriching" &&
        p.updated_at && new Date(p.updated_at).toDateString() === today
      ).length;
      const booked = rows.filter((p: any) => p.status === "booked").length;
      setColdStats({ dialedToday, booked });
    }).catch(() => {});
  }, []);
  // Hourly calendar refresh
  useEffect(() => {
    if (!showCalendar) return;
    const id = setInterval(() => setCalendarKey(k => k + 1), 60 * 60 * 1000);
    return () => clearInterval(id);
  }, [showCalendar]);

  // Stats row. MRR is the only figure with a real source (lib/revenue.ts).
  // Opened emails and appointments have NO data source since GHL was retired
  // 2026-08-22, so they render an explicit no-data state — never a 0 as fact.
  const STATS = [
    { label: "Opened Emails", value: "no data", noSource: true, color: "var(--green)" },
    { label: "MRR", value: loading ? "..." : (typeof data?.mrr === "number" ? `$${data.mrr.toLocaleString()}` : "unavailable"), color: "var(--orange)" },
    { label: "Appts This Week", value: "no data", noSource: true, color: "var(--accent)", onClick: () => setShowCalendar(c => !c) },
  ];

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(""), 3000);
  }

  async function submitNote() {
    if (!noteForm.title.trim()) return;
    setSaving(true);
    const filePath = `wiki/${noteForm.title.trim().replace(/[^a-zA-Z0-9 _-]/g, "")}.md`;
    const content = `# ${noteForm.title}\n\n${noteForm.content}`;
    const res = await fetch("/api/vault/write", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filePath, content }),
    });
    setSaving(false);
    if (res.ok) {
      showToast("Note saved to vault!");
      setShowNewNote(false);
      setNoteForm({ title: "", content: "" });
    } else {
      showToast("Error saving note.");
    }
  }

  return (
    <motion.div style={{ display: "flex", flexDirection: "column", gap: 24 }}
      variants={staggerContainer} initial="hidden" animate="show">
      {/* Watchdog problems banner — always the very first thing on screen.
          onRechecked broadcasts so the banner, chip and copy all re-pull together. */}
      {watchdog !== undefined && (
        <WatchdogBanner
          watchdog={watchdog}
          onRechecked={() => { loadMission(); window.dispatchEvent(new CustomEvent("os:mission-refresh")); }}
        />
      )}

      {/* Toast */}
      {toast && (
        <div style={{ position: "fixed", bottom: 24, right: 24, background: "var(--green)", color: "#07080f", padding: "10px 18px", borderRadius: 10, fontWeight: 700, fontSize: 13, zIndex: 200 }}>
          {toast}
        </div>
      )}

      {/* CRM amputated: GHL was retired 2026-08-22 and nothing replaced it.
          Say so instead of rendering zeroed tiles as fact. */}
      {!loading && (
        <div style={{
          border: "1px solid var(--border)", borderRadius: 12, padding: "12px 16px",
          background: "var(--bg-card)", fontSize: 12.5, color: "var(--text-muted)",
        }}>
          No CRM data source connected. GHL retired 2026-08-22, replacement pending. Lead, pipeline, and appointment data is unavailable until a new CRM is wired in.
        </div>
      )}

      {/* Morning Briefing — skeleton while the dashboard loads so it never looks blank */}
      {loading && (
        <div style={{
          borderRadius: 20, border: "1px solid rgba(34,211,238,0.15)", padding: "24px 28px",
          background: "linear-gradient(180deg, var(--bg-card), var(--bg-card))",
        }}>
          <div className="skel" style={{ height: 12, width: 220, marginBottom: 20 }} />
          <div style={{ display: "flex", gap: 40, flexWrap: "wrap" }}>
            {[0, 1, 2, 3, 4].map(i => (
              <div key={i}>
                <div className="skel" style={{ height: 34, width: 74 }} />
                <div className="skel" style={{ height: 10, width: 92, marginTop: 9 }} />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Morning Briefing — hero banner */}
      {!loading && (
        <motion.div className="briefing-hero" variants={riseItem} style={{
          position: "relative",
          background: "linear-gradient(120deg, rgba(34,211,238,0.10), rgba(167,139,250,0.08) 55%, var(--bg-card))",
          border: "1px solid rgba(34,211,238,0.25)",
          borderRadius: 20, padding: "24px 28px",
          boxShadow: "0 16px 48px var(--bg-hover), inset 0 1px 0 rgba(255,255,255,0.06)",
          overflow: "hidden",
        }}>
          <div style={{
            position: "absolute", top: -60, right: -40, width: 240, height: 240,
            background: "radial-gradient(circle, rgba(34,211,238,0.14), transparent 65%)",
            pointerEvents: "none",
          }} />
          <p style={{
            fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.12em", marginBottom: 16,
            background: "linear-gradient(90deg, var(--accent), var(--accent-2))",
            WebkitBackgroundClip: "text", backgroundClip: "text", color: "transparent",
          }}>
            ⚡ Morning Briefing · {new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}
          </p>
          <div className="briefing-metrics" style={{ display: "flex", gap: 32, flexWrap: "wrap", alignItems: "flex-end" }}>
            <div>
              <div style={{ display: "flex", alignItems: "flex-end", gap: 10 }}>
                <p style={{ fontSize: 36, fontWeight: 800, color: "var(--accent)", lineHeight: 1, textShadow: "0 0 24px rgba(34,211,238,0.35)", fontFamily: "'Space Grotesk', sans-serif" }}><CountUp value={sentToday ?? camp?.by_day?.[new Date().toLocaleDateString("en-CA")] ?? 0} /></p>
                {camp?.by_day && (() => {
                  const s = buildDailySeries(camp.by_day, 10).map(d => d.value);
                  const today = sentToday ?? s[s.length - 1] ?? 0;
                  if (today !== s[s.length - 1]) s[s.length - 1] = today;
                  return (
                    <div style={{ display: "flex", flexDirection: "column", gap: 4, alignItems: "flex-start" }}>
                      <Sparkline data={s} color="var(--accent)" width={84} height={24} />
                      <Delta value={today - (s[s.length - 2] ?? 0)} label="vs yday" />
                    </div>
                  );
                })()}
              </div>
              <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 6 }}>emails sent today</p>
            </div>
            <div>
              {typeof data?.mrr === "number" ? (
                <p style={{ fontSize: 36, fontWeight: 800, color: "var(--green)", lineHeight: 1, textShadow: "0 0 24px rgba(74,222,128,0.35)", fontFamily: "'Space Grotesk', sans-serif" }}><CountUp prefix="$" value={data.mrr} /></p>
              ) : (
                <p style={{ fontSize: 22, fontWeight: 700, color: "var(--text-muted)", lineHeight: 1.4, fontFamily: "'Space Grotesk', sans-serif" }}>unavailable</p>
              )}
              <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 6 }}>
                MRR · {typeof data?.activeClientCount === "number"
                  ? `${data.activeClientCount} active client${data.activeClientCount === 1 ? "" : "s"}`
                  : "client count unavailable"}
              </p>
              {/* A fixed-term deal reads as durable unless the headline says
                  otherwise. Warn while there is still time to renew. */}
              {data?.nextExpiry && (
                <p style={{ fontSize: 11, color: "var(--orange)", marginTop: 4 }}>
                  ${data.nextExpiry.amount.toLocaleString()}/mo of this ends {data.nextExpiry.end}
                  {" "}({data.nextExpiry.monthsRemaining} mo left) unless renewed
                </p>
              )}
              {(data?.pipelineTotal ?? 0) > 0 && (
                // Pipeline sits beside the earned number, never inside it.
                <p style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>
                  + ${data.pipelineTotal.toLocaleString()} pipeline, not earned, not in MRR
                </p>
              )}
            </div>
            <div>
              <p style={{ fontSize: 22, fontWeight: 700, color: "var(--text-muted)", lineHeight: 1.4, fontFamily: "'Space Grotesk', sans-serif" }}>no data</p>
              <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 6 }}>replies · no data source since GHL retired</p>
            </div>
            <div style={{ cursor: "pointer" }} onClick={() => setShowCalendar(c => !c)}>
              <p style={{ fontSize: 22, fontWeight: 700, color: "var(--text-muted)", lineHeight: 1.4, fontFamily: "'Space Grotesk', sans-serif" }}>no data</p>
              <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 6 }}>appointments · no data source {showCalendar ? "▲" : "▼"}</p>
            </div>
            <button onClick={() => onSendToAI(`Today's Wing Digital briefing:\n- Emails sent today: ${sentToday ?? camp?.by_day?.[new Date().toLocaleDateString("en-CA")] ?? 0}\n- MRR: ${typeof data?.mrr === "number" ? `$${data.mrr}` : "unavailable"}\n- Replies and appointments: no data source (GHL retired, no CRM connected)\n\nWhat should I prioritize today to grow Wing Digital?`)}
              style={{
                marginLeft: "auto", fontSize: 12, fontWeight: 600, color: "#fff",
                background: "linear-gradient(135deg, #E8692A, #f59e0b)",
                border: "none", cursor: "pointer", padding: "10px 18px", borderRadius: 999,
                boxShadow: "0 4px 16px rgba(232,105,42,0.35)",
              }}>
              ✦ Ask Claude what to focus on
            </button>
          </div>
          {(() => {
            const upcoming = agentHealth
              .filter((a: any) => a.nextRun && new Date(a.nextRun).getTime() > Date.now())
              .sort((a: any, b: any) => new Date(a.nextRun).getTime() - new Date(b.nextRun).getTime())[0];
            if (!upcoming) return null;
            const d = new Date(upcoming.nextRun);
            const sameDay = d.toDateString() === new Date().toDateString();
            const when = sameDay
              ? d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
              : d.toLocaleDateString("en-US", { weekday: "short" }) + " " + d.toLocaleTimeString("en-US", { hour: "numeric" });
            return (
              <p style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 14, display: "flex", alignItems: "center", gap: 7 }}>
                <span className="live-dot" style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--accent-2)", boxShadow: "0 0 8px #a78bfa", display: "inline-block" }} />
                next agent run: <span style={{ color: "var(--accent-2)", fontWeight: 700, textTransform: "capitalize" }}>{upcoming.name}</span> · {when}
              </p>
            );
          })()}
        </motion.div>
      )}

      {/* Mission stats row — every tile clicks through to its breakdown panel */}
      {missionStats && missionStats.tiles.length > 0 && (
        <motion.div variants={riseItem}>
          <MissionStyles />
          <StatTiles tiles={missionStats.tiles} onSelect={setStatSelection} />
        </motion.div>
      )}
      <MissionPanels selection={statSelection} data={null} onSelect={setStatSelection} />

      {/* Dispatch agent briefing */}
      {brief && (
        <div style={{
          background: "radial-gradient(ellipse 90% 60% at 50% -20%, rgba(167,139,250,0.10), transparent 60%), linear-gradient(180deg, var(--bg-card), var(--bg-card))",
          border: "1px solid rgba(167,139,250,0.3)", borderRadius: 16, padding: "16px 20px",
          boxShadow: "0 8px 24px var(--bg-hover)",
        }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "pointer", flexWrap: "wrap", gap: 8 }}
            onClick={() => setShowBriefing(b => !b)}>
            <p style={{ fontSize: 12.5, fontWeight: 700, color: "var(--accent-2)" }}>
              🌅 Dispatch Briefing · <span style={{ color: "var(--text-muted)", fontWeight: 600 }}>{brief.date_label}</span>
            </p>
            <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
              {[
                { l: "live", v: brief.stats.live, c: "var(--accent)" },
                { l: "callbacks", v: brief.stats.callbacks, c: "var(--accent-2)" },
                { l: "redials", v: brief.stats.followup, c: "var(--orange)" },
                { l: "booked", v: brief.stats.booked, c: "var(--green)" },
                { l: "staged", v: brief.stats.staged, c: "#6b7280" },
              ].map(s => (
                <span key={s.l} style={{ fontSize: 10.5, fontWeight: 700, color: s.c, background: `${s.c}14`, border: `1px solid ${s.c}33`, padding: "3px 10px", borderRadius: 999 }}>
                  {s.v} {s.l}
                </span>
              ))}
              <span style={{ fontSize: 12, color: "var(--text-muted)", marginLeft: 4 }}>{showBriefing ? "▲" : "▼"}</span>
            </div>
          </div>
          {showBriefing && (
            <div style={{ marginTop: 14 }}>
              <p style={{ fontSize: 10.5, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 8 }}>
                Today's dial order
              </p>
              <div style={{ display: "flex", flexDirection: "column" }}>
                {brief.dial_order.map((d: any) => (
                  <div key={d.n} style={{
                    display: "flex", alignItems: "center", gap: 12, padding: "7px 10px",
                    borderRadius: 8, background: d.n % 2 ? "rgba(255,255,255,0.025)" : "transparent",
                  }}>
                    <span style={{ fontSize: 11, fontWeight: 800, color: d.why.includes("callback") ? "var(--accent-2)" : d.why === "redial" ? "var(--orange)" : "var(--text-muted)", width: 20, textAlign: "right", fontFamily: "'Space Grotesk', sans-serif" }}>{d.n}</span>
                    <span style={{ fontSize: 13, fontWeight: 700, flex: 1, minWidth: 140, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{d.name}</span>
                    <span style={{ fontSize: 11.5, color: "var(--text-muted)", width: 110, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{d.city}</span>
                    <span style={{
                      fontSize: 10, fontWeight: 700, padding: "2px 9px", borderRadius: 999, whiteSpace: "nowrap",
                      color: d.why.includes("callback") ? "var(--accent-2)" : d.why === "redial" ? "var(--orange)" : "var(--accent)",
                      background: d.why.includes("callback") ? "rgba(167,139,250,0.12)" : d.why === "redial" ? "rgba(251,191,36,0.10)" : "rgba(34,211,238,0.08)",
                    }}>{d.why}</span>
                    <a href={`tel:${d.phone}`} onClick={e => e.stopPropagation()}
                      style={{ fontSize: 12, fontWeight: 700, color: "var(--accent)", textDecoration: "none", whiteSpace: "nowrap", width: 130, textAlign: "right" }}>
                      {d.phone}
                    </a>
                  </div>
                ))}
              </div>
              <p style={{ fontSize: 10.5, color: "var(--text-muted)", marginTop: 10 }}>
                Best windows 7:00-8:30am · 4:30-6:00pm — log every dial so Dispatch can order tomorrow's list
              </p>
            </div>
          )}
        </div>
      )}

      {/* Agent Workforce health strip */}
      {agentHealth.length > 0 && (() => {
        const HC: Record<string, string> = { ok: "var(--green)", crashed: "var(--red)", idle: "var(--orange)", running: "var(--accent)" };
        const crashed = agentHealth.filter(a => a.health === "crashed").length;
        const running = agentHealth.filter(a => a.state === "Running").length;
        const onBattery = agentHealth.some(a => a.onBatteryBlocked);
        const summary = crashed > 0 ? `${crashed} need attention` : onBattery ? "battery-blocked" : running > 0 ? `${running} running now` : "all healthy";
        const summaryColor = crashed > 0 ? "var(--red)" : onBattery ? "var(--orange)" : "var(--green)";
        function fmtNext(s: string) {
          if (!s) return "—";
          const d = new Date(s), now = new Date();
          const sameDay = d.toDateString() === now.toDateString();
          return sameDay
            ? d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
            : d.toLocaleDateString("en-US", { weekday: "short" }) + " " + d.toLocaleTimeString("en-US", { hour: "numeric" });
        }
        return (
          <motion.div variants={riseItem} style={{
            background: "linear-gradient(180deg, var(--bg-card), var(--bg-card))",
            border: "1px solid var(--border)", borderRadius: 16, padding: "16px 20px",
            boxShadow: "0 8px 24px var(--bg-hover)",
          }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14, flexWrap: "wrap", gap: 8 }}>
              <p style={{ fontSize: 12.5, fontWeight: 700, color: "var(--text)" }}>
                🤖 Agent Workforce
              </p>
              <span style={{ fontSize: 10.5, fontWeight: 700, color: summaryColor, background: `${summaryColor}14`, border: `1px solid ${summaryColor}33`, padding: "3px 12px", borderRadius: 999 }}>
                {agentHealth.length} agents · {summary}
              </span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 8 }}>
              {agentHealth.map((a: any) => {
                const c = HC[a.state === "Running" ? "running" : a.health] ?? "#6b7280";
                return (
                  <div key={a.name} style={{
                    display: "flex", alignItems: "center", gap: 10, padding: "9px 12px",
                    background: "rgba(255,255,255,0.025)", border: "1px solid var(--border)", borderRadius: 10,
                  }}>
                    <span className="live-dot" style={{ width: 8, height: 8, borderRadius: "50%", background: c, boxShadow: `0 0 8px ${c}`, flexShrink: 0 }} />
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <p style={{ fontSize: 12, fontWeight: 700, color: "var(--text)", textTransform: "capitalize", lineHeight: 1.2 }}>{a.name}</p>
                      <p style={{ fontSize: 10, color: "var(--text-muted)", lineHeight: 1.3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {a.state === "Running" ? "running now" : a.health === "crashed" ? "last run failed" : a.health === "idle" ? "not run yet" : `next ${fmtNext(a.nextRun)}`}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
            {onBattery && (
              <p style={{ fontSize: 10.5, color: "var(--orange)", marginTop: 12 }}>
                ⚠ Some agents are blocked from running on battery — they will queue until plugged in.
              </p>
            )}
          </motion.div>
        );
      })()}

      {/* Stats */}
      <motion.div variants={riseItem} style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 14 }}>
        {STATS.map((stat: any) => {
          const inner = (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 10 }}>
                <span className="live-dot" style={{ width: 6, height: 6, borderRadius: "50%", background: stat.color, boxShadow: `0 0 8px ${stat.color}` }} />
                <p style={{ fontSize: 11, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 600 }}>{stat.label}</p>
              </div>
              <p style={{
                fontSize: stat.noSource ? 18 : 30, fontWeight: 700,
                color: stat.noSource ? "var(--text-muted)" : stat.color,
                fontFamily: "'Space Grotesk', sans-serif",
                textShadow: stat.noSource ? "none" : `0 0 20px ${stat.color}44`, lineHeight: 1.2,
              }}>{stat.value}</p>
              {stat.noSource && <p style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 8 }}>No data source connected (GHL retired 2026-08-22)</p>}
            </>
          );
          const baseStyle: React.CSSProperties = {
            position: "relative",
            background: `radial-gradient(ellipse 90% 70% at 50% -20%, ${stat.color}14, transparent 60%), linear-gradient(180deg, var(--bg-card), var(--bg-card))`,
            border: "1px solid var(--border)",
            borderRadius: 16, padding: "18px 20px",
            boxShadow: "0 8px 24px var(--bg-hover), inset 0 1px 0 rgba(255,255,255,0.04)",
            cursor: stat.onClick ? "pointer" : "default",
            textDecoration: "none", display: "block", overflow: "hidden",
          };
          const interactive = Boolean(stat.onClick);
          // Every tile responds; interactive ones respond more.
          const hover = interactive ? cardHover : cardHoverPassive;
          const tap = interactive ? cardTap : undefined;
          return <motion.div key={stat.label} onClick={stat.onClick ? () => { sfx.play("ping"); stat.onClick(); } : undefined} style={baseStyle}
            whileHover={hover} whileTap={tap} transition={hoverSpring}>{inner}</motion.div>;
        })}
      </motion.div>

      {/* Week Calendar -- toggle. No appointment feed exists (GHL retired),
          so the grid renders empty with an explicit no-source note inside. */}
      {showCalendar && !loading && (
        <WeekCalendar key={calendarKey} appointments={[]} />
      )}

      {/* Quick Actions — floating pill row. "Add Lead" is gone: there is no
          CRM to add a lead to, and a form that can only fail is worse than none. */}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em", marginRight: 4 }}>Quick</span>
        {[
          { icon: Calendar, label: "Calendar", action: () => setShowCalendar(c => !c), c: "var(--accent)" },
          { icon: Note, label: "New Note", action: () => setShowNewNote(true), c: "var(--accent-2)" },
          { icon: Sparkles, label: "Ask Claude", action: () => onSendToAI("What should I focus on today for Wing Digital?"), c: "#E8692A" },
        ].map(btn => (
          <motion.button key={btn.label} onClick={() => { sfx.play("blip"); btn.action(); }}
            whileHover={cardHover} whileTap={cardTap} transition={hoverSpring} style={{
            display: "inline-flex", alignItems: "center", gap: 7,
            background: `${btn.c}10`, border: `1px solid ${btn.c}44`,
            borderRadius: 999, padding: "8px 18px", color: "var(--text-primary)",
            fontSize: 12.5, cursor: "pointer", fontWeight: 600,
          }}><btn.icon size={14} color={btn.c} />{btn.label}</motion.button>
        ))}
      </div>

      <motion.div variants={riseItem}>
        {/* Active Clients */}
        <div style={{
          background: "linear-gradient(180deg, var(--bg-card), var(--bg-card))",
          border: "1px solid var(--border)", borderRadius: 16, padding: 20,
          boxShadow: "0 8px 24px var(--bg-hover), inset 0 1px 0 rgba(255,255,255,0.04)",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
            <span className="live-dot" style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--accent)", boxShadow: "0 0 8px #22d3ee" }} />
            <p style={{ fontSize: 12, fontWeight: 700, color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.07em" }}>Active Clients</p>
          </div>
          {loading ? <Spinner /> : (data?.activeClients?.length ? (
            <motion.div style={{ display: "flex", flexDirection: "column", gap: 8 }}
              variants={staggerContainer} initial="hidden" animate="show">
              {data.activeClients.slice(0, 50).map((client: any) => (
                <motion.div key={client.id} variants={riseItem} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: "1px solid var(--border)" }}>
                  <p style={{ fontSize: 13, fontWeight: 600 }}>{client.name}</p>
                  {/* Every row states its basis. This used to print
                      "${value}/mo" in green for EVERY client, so an expected
                      (not-yet-earned) figure and an unverified one both rendered
                      exactly like collected recurring revenue — and a client with
                      no figure crashed on null. Green is reserved for money that
                      actually counts toward MRR; everything else is muted and
                      labelled with what it really is. */}
                  <span style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
                    <span style={{
                      fontSize: 13, fontWeight: 600,
                      color: client.countsTowardMrr ? "var(--green)" : "var(--text-muted)",
                    }}>
                      {client.value == null
                        ? "not recorded"
                        : `$${client.value.toLocaleString()}${client.countsTowardMrr ? "/mo" : ""}`}
                    </span>
                    {!client.countsTowardMrr && (
                      <span style={{ fontSize: 10, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                        {client.value == null ? "unknown" : client.basisLabel}
                      </span>
                    )}
                  </span>
                </motion.div>
              ))}
            </motion.div>
          ) : <p style={{ color: "var(--text-muted)", fontSize: 13 }}>No active clients on the roster</p>)}
        </div>
      </motion.div>

      {/* New Note Modal */}
      {showNewNote && <Modal title="New Vault Note" onClose={() => setShowNewNote(false)}>
        <ModalField label="Title" value={noteForm.title} onChange={v => setNoteForm(f => ({ ...f, title: v }))} placeholder="Note title..." />
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <label style={{ fontSize: 12, color: "var(--text-muted)" }}>Content</label>
          <textarea value={noteForm.content} onChange={e => setNoteForm(f => ({ ...f, content: e.target.value }))}
            placeholder="Write your note..." rows={6}
            style={{ background: "var(--bg-hover)", border: "1px solid var(--border)", borderRadius: 8, padding: "10px 12px", color: "var(--text-primary)", fontSize: 13, resize: "vertical", outline: "none" }} />
        </div>
        <ModalActions onCancel={() => setShowNewNote(false)} onSubmit={submitNote} saving={saving} submitLabel="Save to Vault" />
      </Modal>}
    </motion.div>
  );
}


function CompetitorAskBtn({ section, onSendToAI }: { section: { title: string; bullets: string[] }; onSendToAI: (s: string) => void }) {
  function ask() {
    const prompt = "Wing Digital competitor: " + section.title
      + "\n\nDetails:\n" + section.bullets.join("\n")
      + "\n\nWing Digital: $1,000/month, done-for-you automation for DFW home service businesses."
      + " How should I position Wing Digital against this competitor specifically? What is the best counter-pitch?";
    onSendToAI(prompt);
  }
  return (
    <button onClick={ask} style={{ marginTop: 12, fontSize: 11, color: "#E8692A", background: "transparent", border: "none", cursor: "pointer", padding: 0 }}>
      Ask Claude how to beat this competitor →
    </button>
  );
}

const INTEL_COLORS = ["var(--accent)", "var(--orange)", "var(--accent)", "var(--green)", "#f472b6", "var(--green)", "#facc15", "#38bdf8"];
const INTEL_ICONS = ["🏢", "💰", "📦", "📣", "🎯", "⚡", "🔧", "📊"];

function parseCompetitorSections(content: string): { title: string; bullets: string[] }[] {
  if (!content) return [];
  const sections: { title: string; bullets: string[] }[] = [];

  // Split on lines that start with ### (competitor sections) or ** (bold headers)
  const lines = content.split("\n");
  let current: { title: string; bullets: string[] } | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Skip meta lines
    if (trimmed.startsWith("# ") || trimmed.startsWith("> ") || trimmed.startsWith("---") || trimmed.startsWith("*Generated")) continue;
    if (trimmed.startsWith("## Last Updated") || trimmed.startsWith("## How to Use")) continue;

    // New section header
    if (trimmed.startsWith("### ") || trimmed.startsWith("## ")) {
      if (current && current.bullets.length > 0) sections.push(current);
      current = { title: trimmed.replace(/^#+\s*/, ""), bullets: [] };
      continue;
    }

    // Bold headers as section titles
    if (trimmed.match(/^\*\*[^*]+\*\*:?\s*$/) || trimmed.match(/^\*\*[^*]+\*\*$/)) {
      if (current && current.bullets.length > 0) sections.push(current);
      current = { title: trimmed.replace(/\*\*/g, "").replace(/:$/, ""), bullets: [] };
      continue;
    }

    // Bullet points
    if (trimmed.startsWith("- ") || trimmed.startsWith("* ") || trimmed.startsWith("• ")) {
      if (!current) current = { title: "General Findings", bullets: [] };
      const bullet = trimmed.replace(/^[-*•]\s*/, "").replace(/\*\*/g, "");
      if (bullet) current.bullets.push(bullet);
      continue;
    }

    // Plain text — add as bullet to current section or start a General one
    if (trimmed.length > 20 && !trimmed.startsWith("#")) {
      if (!current) current = { title: "Research Summary", bullets: [] };
      if (!trimmed.startsWith("*")) current.bullets.push(trimmed.replace(/\*\*/g, ""));
    }
  }

  if (current && current.bullets.length > 0) sections.push(current);
  return sections;
}

// Lightweight, dependency-free markdown -> React renderer for the note viewer.
// Handles headings, bold/italic/inline-code/links, bullet + numbered lists,
// fenced code blocks and blank-line paragraphs. Good enough to read a vault note
// without pulling in a markdown library.
function renderInline(text: string, keyBase: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  // links [label](url)
  const parts = text.split(/(\[[^\]]+\]\([^)]+\)|\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*)/g);
  parts.forEach((p, i) => {
    const k = `${keyBase}-${i}`;
    let m: RegExpMatchArray | null;
    if ((m = p.match(/^\[([^\]]+)\]\(([^)]+)\)$/))) {
      out.push(<a key={k} href={m[2]} target="_blank" rel="noopener noreferrer" style={{ color: "var(--accent)", textDecoration: "underline" }}>{m[1]}</a>);
    } else if ((m = p.match(/^\*\*([^*]+)\*\*$/))) {
      out.push(<strong key={k}>{m[1]}</strong>);
    } else if ((m = p.match(/^`([^`]+)`$/))) {
      out.push(<code key={k} style={{ background: "rgba(255,255,255,0.08)", padding: "1px 5px", borderRadius: 4, fontSize: "0.9em" }}>{m[1]}</code>);
    } else if ((m = p.match(/^\*([^*]+)\*$/))) {
      out.push(<em key={k}>{m[1]}</em>);
    } else if (p) {
      out.push(<span key={k}>{p}</span>);
    }
  });
  return out;
}
function renderMarkdown(md: string): React.ReactNode {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const blocks: React.ReactNode[] = [];
  let i = 0, key = 0;
  const hSize: Record<number, number> = { 1: 22, 2: 18, 3: 15.5, 4: 14, 5: 13, 6: 12.5 };
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      const buf: string[] = []; i++;
      while (i < lines.length && !/^```/.test(lines[i])) { buf.push(lines[i]); i++; }
      i++;
      blocks.push(<pre key={key++} style={{ background: "var(--bg-hover)", border: "1px solid var(--border)", borderRadius: 8, padding: 12, overflowX: "auto", fontSize: 12.5, lineHeight: 1.6 }}>{buf.join("\n")}</pre>);
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const lvl = h[1].length;
      blocks.push(<p key={key++} style={{ fontSize: hSize[lvl], fontWeight: 700, margin: "16px 0 6px", color: "var(--text-primary)" }}>{renderInline(h[2], `h${key}`)}</p>);
      i++; continue;
    }
    if (/^\s*([-*])\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*])\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*([-*])\s+/, "")); i++; }
      blocks.push(<ul key={key++} style={{ margin: "6px 0", paddingLeft: 20, lineHeight: 1.7 }}>{items.map((it, j) => <li key={j}>{renderInline(it, `li${key}-${j}`)}</li>)}</ul>);
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*\d+\.\s+/, "")); i++; }
      blocks.push(<ol key={key++} style={{ margin: "6px 0", paddingLeft: 22, lineHeight: 1.7 }}>{items.map((it, j) => <li key={j}>{renderInline(it, `ol${key}-${j}`)}</li>)}</ol>);
      continue;
    }
    if (!line.trim()) { i++; continue; }
    // paragraph: gather until blank
    const buf: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|```|\s*[-*]\s|\s*\d+\.\s)/.test(lines[i])) { buf.push(lines[i]); i++; }
    blocks.push(<p key={key++} style={{ margin: "8px 0", lineHeight: 1.75 }}>{renderInline(buf.join(" "), `p${key}`)}</p>);
  }
  return <>{blocks}</>;
}

function KnowledgeBase({ initialPath, onSendToAI }: { initialPath?: string; onSendToAI: (ctx: string) => void }) {
  const [tree, setTree] = useState<any[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [content, setContent] = useState<string>("");
  const [editContent, setEditContent] = useState<string>("");
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState("");
  const [loadingFile, setLoadingFile] = useState(false);
  const LS_EXPANDED = "wingos-vault-tree-expanded";
  const LS_PANEL = "wingos-vault-tree-panel";
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    try {
      const raw = window.localStorage.getItem(LS_EXPANDED);
      if (raw) return new Set(JSON.parse(raw) as string[]);
    } catch { /* default */ }
    return new Set(["wiki"]);
  });
  const [treeOpen, setTreeOpen] = useState<boolean>(() => {
    try { return window.localStorage.getItem(LS_PANEL) !== "0"; } catch { return true; }
  });
  // Initialize synchronously so the very first render is already correct on a
  // phone (avoids a flash where the tree renders as an in-flow column beside the
  // graph). Update on BOTH matchMedia change and window resize so an orientation
  // change or resize can never leave the drawer stuck in the desktop layout.
  const [isPhone, setIsPhone] = useState<boolean>(() => {
    try { return window.matchMedia("(max-width: 768px)").matches; } catch { return false; }
  });
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 768px)");
    const on = () => setIsPhone(mq.matches);
    on();
    mq.addEventListener("change", on);
    window.addEventListener("resize", on);
    return () => { mq.removeEventListener("change", on); window.removeEventListener("resize", on); };
  }, []);

  useEffect(() => {
    fetch("/api/vault").then(r => r.json()).then(d => setTree(d.tree ?? []));
    // On phone the graph should own the full width by default; tree opens as a drawer.
    try { if (window.matchMedia("(max-width: 768px)").matches) setTreeOpen(false); } catch { /* noop */ }
  }, []);

  const togglePanel = () => {
    setTreeOpen(prev => {
      const next = !prev;
      sfx.play(next ? "tree-open" : "tree-close");
      try { window.localStorage.setItem(LS_PANEL, next ? "1" : "0"); } catch { /* noop */ }
      return next;
    });
  };

  function showToast(msg: string) {
    setToast(msg); setTimeout(() => setToast(""), 3000);
  }

  const openFile = useCallback((filePath: string) => {
    setSelectedFile(filePath);
    setEditing(false);
    setLoadingFile(true);
    fetch(`/api/vault/file?path=${encodeURIComponent(filePath)}`)
      .then(r => r.json())
      .then(d => { setContent(d.content ?? ""); setEditContent(d.content ?? ""); setLoadingFile(false); });
  }, []);

  async function saveFile() {
    if (!selectedFile) return;
    setSaving(true);
    const res = await fetch("/api/vault/write", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filePath: selectedFile, content: editContent }),
    });
    setSaving(false);
    if (res.ok) { setContent(editContent); setEditing(false); showToast("Saved!"); }
    else showToast("Save failed.");
  }

  useEffect(() => {
    if (initialPath) openFile(initialPath);
  }, [initialPath, openFile]);

  const toggleFolder = (p: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      const opening = !next.has(p);
      opening ? next.add(p) : next.delete(p);
      sfx.play(opening ? "tree-open" : "tree-close");
      try { window.localStorage.setItem(LS_EXPANDED, JSON.stringify([...next])); } catch { /* noop */ }
      return next;
    });
  };

  function FileTree({ nodes, depth = 0 }: { nodes: any[]; depth?: number }) {
    return (
      <div>
        {nodes.map(node => (
          <div key={node.path}>
            {node.type === "folder" ? (
              <>
                <button onClick={() => toggleFolder(node.path)} style={{
                  display: "flex", alignItems: "center", gap: 7,
                  width: "100%", textAlign: "left", border: "none", background: "transparent",
                  color: expanded.has(node.path) ? "var(--text-primary)" : "var(--text-secondary)",
                  padding: `6px 8px 6px ${14 + depth * 14}px`,
                  fontSize: 11.5, fontWeight: 700, cursor: "pointer",
                  textTransform: "uppercase", letterSpacing: "0.06em",
                }}>
                  <span style={{
                    display: "inline-block", fontSize: 9, color: "var(--accent)",
                    transform: expanded.has(node.path) ? "rotate(90deg)" : "none",
                    transition: "transform 0.15s ease",
                  }}>▶</span>
                  {node.name}
                </button>
                {node.children && (
                  <div style={{
                    display: "grid",
                    gridTemplateRows: expanded.has(node.path) ? "1fr" : "0fr",
                    transition: "grid-template-rows 0.22s ease",
                  }}>
                    <div style={{ overflow: "hidden", minHeight: 0 }}>
                      <FileTree nodes={node.children} depth={depth + 1} />
                    </div>
                  </div>
                )}
              </>
            ) : (
              <button onClick={() => openFile(node.path)} style={{
                display: "flex", alignItems: "center", gap: 7,
                width: "100%", textAlign: "left", border: "none",
                background: selectedFile === node.path ? "var(--accent-glow)" : "transparent",
                borderLeft: selectedFile === node.path ? "2px solid var(--accent)" : "2px solid transparent",
                color: selectedFile === node.path ? "var(--text-primary)" : "var(--text-secondary)",
                padding: `5px 8px 5px ${14 + depth * 14}px`,
                fontSize: 12.5, cursor: "pointer",
                borderRadius: "0 8px 8px 0",
              }}>
                <span style={{
                  width: 5, height: 5, borderRadius: "50%", flexShrink: 0,
                  background: selectedFile === node.path ? "var(--accent)" : "var(--text-muted)",
                  boxShadow: selectedFile === node.path ? "0 0 5px var(--accent)" : "none",
                }} />
                {node.name}
              </button>
            )}
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className={`kb-root${treeOpen ? " tree-open" : ""}`} style={{ position: "relative", display: "flex", height: "calc(100vh - 130px)", margin: "-24px", overflow: "hidden" }}>

      {/* Left: File tree (collapsible panel on desktop; a slide-in drawer on phone).
          On phone the drawer is positioned with inline styles (React-owned) to
          avoid a stylesheet cascade quirk, and overlays the graph instead of
          squeezing it. */}
      <div className={`kb-tree${isPhone && treeOpen ? " kb-drawer-in" : ""}`} style={isPhone ? {
        position: "absolute", top: 0, bottom: 0, left: 0, zIndex: 40,
        width: "82vw", maxWidth: 300,
        transform: treeOpen ? "translateX(0)" : "translateX(-102%)",
        transition: "none",
        borderRight: "1px solid var(--border)",
        overflow: "hidden", background: "var(--bg-secondary)", backdropFilter: "blur(12px)",
        boxShadow: treeOpen ? "8px 0 30px rgba(0,0,0,0.5)" : "none",
      } : {
        width: treeOpen ? 230 : 0, flexShrink: 0,
        borderRight: treeOpen ? "1px solid rgba(255,255,255,0.05)" : "none",
        overflow: "hidden", background: "var(--bg-secondary)", backdropFilter: "blur(10px)",
        transition: "width 0.25s ease",
      }}>
        <div style={{ width: 230, height: "100%", overflow: "auto", padding: "16px 0" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 14px 12px" }}>
            <p style={{
              fontSize: 11, fontWeight: 700,
              textTransform: "uppercase", letterSpacing: "0.1em",
              background: "linear-gradient(90deg, var(--accent), var(--accent-2))",
              WebkitBackgroundClip: "text", backgroundClip: "text", color: "transparent",
            }}>
              ◈ Vault
            </p>
            <button onClick={togglePanel} aria-label="Collapse vault tree" title="Collapse tree"
              style={{ background: "transparent", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 14, lineHeight: 1, padding: 0 }}>‹</button>
          </div>
          <FileTree nodes={tree} />
        </div>
      </div>
      {!treeOpen && !isPhone && (
        <button onClick={togglePanel} aria-label="Expand vault tree" title="Show tree" style={{
          position: "absolute", top: "50%", left: 0, transform: "translateY(-50%)", zIndex: 5,
          width: 26, height: 92, borderRadius: "0 10px 10px 0", border: "1px solid var(--accent)",
          borderLeft: "none", background: "var(--bg-card)", backdropFilter: "blur(6px)",
          color: "var(--accent)", boxShadow: "0 0 12px rgba(96,165,250,0.35)",
          cursor: "pointer", fontSize: 13, lineHeight: 1.15, display: "flex",
          flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 4,
        }}>
          <span style={{ fontSize: 15 }}>›</span>
          <span style={{ writingMode: "vertical-rl", letterSpacing: 2, fontSize: 10, textTransform: "uppercase" }}>Vault</span>
        </button>
      )}

      {/* Middle: Graph always visible (full width on phone; tree opens over it) */}
      <div className="kb-graph" style={{ flex: 1, position: "relative", minWidth: 0 }}>
        <VaultGraph onSelectNode={(p) => openFile(p)} onToggleTree={isPhone ? togglePanel : undefined} />
      </div>

      {/* Note viewer — clicking a graph node (or tree file) opens the real note
          here. On desktop it's a right-side reading panel; on phone it's a
          bottom-sheet overlaying the graph (never pushes the graph around). */}
      {selectedFile && (
        <>
          {isPhone && (
            <div onClick={() => setSelectedFile(null)} style={{ position: "absolute", inset: 0, zIndex: 45, background: "rgba(0,0,0,0.45)" }} />
          )}
          <div
            className="kb-viewer"
            style={isPhone ? {
              position: "absolute", left: 0, right: 0, bottom: 0, zIndex: 46,
              height: "72%", borderTopLeftRadius: 18, borderTopRightRadius: 18,
              background: "var(--bg-card)", backdropFilter: "blur(14px)",
              borderTop: "1px solid var(--border)", boxShadow: "0 -12px 40px rgba(0,0,0,0.6)",
              display: "flex", flexDirection: "column",
            } : {
              width: 460, flexShrink: 0, height: "100%",
              borderLeft: "1px solid var(--border)",
              background: "var(--bg-card)", backdropFilter: "blur(10px)",
              display: "flex", flexDirection: "column",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "14px 16px", borderBottom: "1px solid var(--border)" }}>
              {isPhone && <span style={{ position: "absolute", top: 6, left: "50%", transform: "translateX(-50%)", width: 36, height: 4, borderRadius: 2, background: "rgba(255,255,255,0.25)" }} />}
              <span style={{ flex: 1, fontSize: 13, fontWeight: 700, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {selectedFile.split("/").pop()}
              </span>
              {!loadingFile && (
                <button onClick={() => { setEditing(e => !e); setEditContent(content); }}
                  style={{ background: "transparent", border: "1px solid var(--border)", borderRadius: 8, color: "var(--text-secondary)", cursor: "pointer", fontSize: 11.5, padding: "5px 10px" }}>
                  {editing ? "Preview" : "Edit"}
                </button>
              )}
              {editing && (
                <button onClick={saveFile} disabled={saving}
                  style={{ background: "linear-gradient(135deg, var(--accent), var(--accent-2))", border: "none", borderRadius: 8, color: "#07080f", cursor: "pointer", fontSize: 11.5, fontWeight: 700, padding: "5px 10px" }}>
                  {saving ? "Saving..." : "Save"}
                </button>
              )}
              <button onClick={() => setSelectedFile(null)} aria-label="Close note"
                style={{ background: "transparent", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 20, lineHeight: 1, padding: "0 2px" }}>×</button>
            </div>
            <div style={{ flex: 1, overflow: "auto", padding: "16px 18px" }}>
              {loadingFile ? (
                <p style={{ color: "var(--text-muted)", fontSize: 13 }}>Opening note...</p>
              ) : editing ? (
                <textarea value={editContent} onChange={e => setEditContent(e.target.value)}
                  style={{ width: "100%", height: "100%", minHeight: 300, resize: "none", background: "rgba(0,0,0,0.3)", border: "1px solid var(--border)", borderRadius: 10, color: "var(--text-primary)", fontSize: 13, lineHeight: 1.7, padding: 12, outline: "none", fontFamily: "ui-monospace, monospace" }} />
              ) : content ? (
                <div style={{ fontSize: 13.5, color: "var(--text-secondary)" }}>{renderMarkdown(content)}</div>
              ) : (
                <p style={{ color: "var(--text-muted)", fontSize: 13 }}>This note is empty.</p>
              )}
            </div>
          </div>
        </>
      )}

      {/* Toast */}
      {toast && (
        <div style={{ position: "fixed", bottom: 24, right: 24, background: "var(--green)", color: "#07080f", padding: "10px 18px", borderRadius: 10, fontWeight: 700, fontSize: 13, zIndex: 200 }}>
          {toast}
        </div>
      )}

    </div>
  );
}

function PersonalSection() {
  const LS_TASKS = "wingos_tasks";
  const LS_GOALS = "wingos_goals";
  const LS_CLEP = "wingos_clep";

  const [tasks, setTasks] = useState<{ id: string; text: string; done: boolean }[]>(() => {
    try { return JSON.parse(localStorage.getItem(LS_TASKS) ?? "[]"); } catch { return []; }
  });
  const [goals, setGoals] = useState<{ id: string; text: string; done: boolean }[]>(() => {
    try { return JSON.parse(localStorage.getItem(LS_GOALS) ?? "[]"); } catch { return []; }
  });
  const [clep, setClep] = useState<{ studied: number; target: number; exam: string }>(() => {
    try { return JSON.parse(localStorage.getItem(LS_CLEP) ?? '{"studied":0,"target":60,"exam":"2026-08-01"}'); } catch { return { studied: 0, target: 60, exam: "2026-08-01" }; }
  });
  const [newTask, setNewTask] = useState("");
  const [newGoal, setNewGoal] = useState("");

  function save<T>(key: string, val: T) { localStorage.setItem(key, JSON.stringify(val)); }

  function addTask() {
    if (!newTask.trim()) return;
    const next = [...tasks, { id: Date.now().toString(), text: newTask.trim(), done: false }];
    setTasks(next); save(LS_TASKS, next); setNewTask("");
  }
  function toggleTask(id: string) {
    const next = tasks.map(t => t.id === id ? { ...t, done: !t.done } : t);
    setTasks(next); save(LS_TASKS, next);
  }
  function removeTask(id: string) {
    const next = tasks.filter(t => t.id !== id);
    setTasks(next); save(LS_TASKS, next);
  }

  function addGoal() {
    if (!newGoal.trim()) return;
    const next = [...goals, { id: Date.now().toString(), text: newGoal.trim(), done: false }];
    setGoals(next); save(LS_GOALS, next); setNewGoal("");
  }
  function toggleGoal(id: string) {
    const next = goals.map(g => g.id === id ? { ...g, done: !g.done } : g);
    setGoals(next); save(LS_GOALS, next);
  }

  function updateClep(field: string, val: string | number) {
    const next = { ...clep, [field]: val };
    setClep(next); save(LS_CLEP, next);
  }

  const clepPct = Math.min(100, Math.round((clep.studied / clep.target) * 100));
  const daysLeft = Math.max(0, Math.ceil((new Date(clep.exam).getTime() - Date.now()) / 86400000));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24, maxWidth: 900 }}>

      {/* Top row: Tasks + Goals */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 16 }}>

        {/* Daily Tasks */}
        <div style={{ background: "linear-gradient(180deg, var(--bg-card), var(--bg-card))", border: "1px solid var(--border)", borderRadius: 16, padding: 20, boxShadow: "0 8px 24px var(--bg-hover), inset 0 1px 0 var(--border)" }}>
          <p style={{ fontSize: 13, fontWeight: 700, marginBottom: 14 }}>📋 Today's Tasks</p>
          <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
            <input value={newTask} onChange={e => setNewTask(e.target.value)}
              onKeyDown={e => e.key === "Enter" && addTask()}
              placeholder="Add a task..." style={{ flex: 1, background: "var(--bg-hover)", border: "1px solid var(--border)", borderRadius: 8, padding: "8px 12px", color: "var(--text-primary)", fontSize: 13, outline: "none" }} />
            <button onClick={addTask} style={{ background: "linear-gradient(135deg, var(--accent), var(--accent-2))", border: "none", borderRadius: 999, width: 34, height: 34, color: "#07080f", cursor: "pointer", fontSize: 16, fontWeight: 800, boxShadow: "0 2px 10px rgba(34,211,238,0.35)" }}>+</button>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {tasks.length === 0 && <p style={{ color: "var(--text-muted)", fontSize: 13 }}>No tasks yet. Add one above.</p>}
            {tasks.map(t => (
              <div key={t.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", background: "var(--bg-hover)", borderRadius: 8 }}>
                <input type="checkbox" checked={t.done} onChange={() => toggleTask(t.id)} style={{ cursor: "pointer", width: 16, height: 16, accentColor: "var(--accent)" }} />
                <span style={{ flex: 1, fontSize: 13, color: t.done ? "var(--text-muted)" : "var(--text-primary)", textDecoration: t.done ? "line-through" : "none" }}>{t.text}</span>
                <button onClick={() => removeTask(t.id)} style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 14, lineHeight: 1 }}>×</button>
              </div>
            ))}
          </div>
          {tasks.some(t => t.done) && (
            <button onClick={() => { const n = tasks.filter(t => !t.done); setTasks(n); save(LS_TASKS, n); }}
              style={{ marginTop: 10, fontSize: 11, color: "var(--text-muted)", background: "none", border: "none", cursor: "pointer" }}>
              Clear completed
            </button>
          )}
        </div>

        {/* Goals */}
        <div style={{ background: "linear-gradient(180deg, var(--bg-card), var(--bg-card))", border: "1px solid var(--border)", borderRadius: 16, padding: 20, boxShadow: "0 8px 24px var(--bg-hover), inset 0 1px 0 var(--border)" }}>
          <p style={{ fontSize: 13, fontWeight: 700, marginBottom: 14 }}>🎯 Goals</p>
          <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
            <input value={newGoal} onChange={e => setNewGoal(e.target.value)}
              onKeyDown={e => e.key === "Enter" && addGoal()}
              placeholder="Add a goal..." style={{ flex: 1, background: "var(--bg-hover)", border: "1px solid var(--border)", borderRadius: 8, padding: "8px 12px", color: "var(--text-primary)", fontSize: 13, outline: "none" }} />
            <button onClick={addGoal} style={{ background: "linear-gradient(135deg, #34d399, #22d3ee)", border: "none", borderRadius: 999, width: 34, height: 34, color: "#07080f", cursor: "pointer", fontSize: 16, fontWeight: 800, boxShadow: "0 2px 10px rgba(52,211,153,0.35)" }}>+</button>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {goals.length === 0 && <p style={{ color: "var(--text-muted)", fontSize: 13 }}>No goals yet. Add one above.</p>}
            {goals.map(g => (
              <div key={g.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", background: "var(--bg-hover)", borderRadius: 8 }}>
                <input type="checkbox" checked={g.done} onChange={() => toggleGoal(g.id)} style={{ cursor: "pointer", width: 16, height: 16, accentColor: "var(--green)" }} />
                <span style={{ flex: 1, fontSize: 13, color: g.done ? "var(--text-muted)" : "var(--text-primary)", textDecoration: g.done ? "line-through" : "none" }}>{g.text}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* CLEP Bio Tracker */}
      <div style={{ background: "linear-gradient(180deg, var(--bg-card), var(--bg-card))", border: "1px solid var(--border)", borderRadius: 16, padding: 20, boxShadow: "0 8px 24px var(--bg-hover), inset 0 1px 0 var(--border)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <p style={{ fontSize: 13, fontWeight: 700 }}>📚 CLEP Bio Study Tracker</p>
          <span style={{ fontSize: 12, color: daysLeft < 14 ? "var(--red)" : "var(--text-muted)" }}>{daysLeft} days until exam</span>
        </div>
        <div style={{ display: "flex", gap: 16, marginBottom: 16, flexWrap: "wrap" }}>
          <div style={{ flex: 1, minWidth: 140 }}>
            <label style={{ fontSize: 11, color: "var(--text-muted)", display: "block", marginBottom: 4 }}>Hours studied</label>
            <input type="number" value={clep.studied} onChange={e => updateClep("studied", Number(e.target.value))} min={0}
              style={{ width: "100%", background: "var(--bg-hover)", border: "1px solid var(--border)", borderRadius: 8, padding: "8px 12px", color: "var(--text-primary)", fontSize: 16, fontWeight: 700, outline: "none" }} />
          </div>
          <div style={{ flex: 1, minWidth: 140 }}>
            <label style={{ fontSize: 11, color: "var(--text-muted)", display: "block", marginBottom: 4 }}>Target hours</label>
            <input type="number" value={clep.target} onChange={e => updateClep("target", Number(e.target.value))} min={1}
              style={{ width: "100%", background: "var(--bg-hover)", border: "1px solid var(--border)", borderRadius: 8, padding: "8px 12px", color: "var(--text-primary)", fontSize: 16, fontWeight: 700, outline: "none" }} />
          </div>
          <div style={{ flex: 1, minWidth: 140 }}>
            <label style={{ fontSize: 11, color: "var(--text-muted)", display: "block", marginBottom: 4 }}>Exam date</label>
            <input type="date" value={clep.exam} onChange={e => updateClep("exam", e.target.value)}
              style={{ width: "100%", background: "var(--bg-hover)", border: "1px solid var(--border)", borderRadius: 8, padding: "8px 12px", color: "var(--text-primary)", fontSize: 13, outline: "none" }} />
          </div>
        </div>
        {/* Progress bar */}
        <div style={{ background: "var(--bg-hover)", borderRadius: 20, height: 12, overflow: "hidden", border: "1px solid var(--border)" }}>
          <div style={{
            height: "100%", width: `${clepPct}%`,
            background: clepPct >= 100 ? "linear-gradient(90deg, #34d399, #22d3ee)" : "linear-gradient(90deg, #22d3ee, #a78bfa)",
            borderRadius: 20, transition: "width 0.4s ease",
            boxShadow: "0 0 12px rgba(34,211,238,0.5)",
          }} />
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6 }}>
          <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{clep.studied}h / {clep.target}h</span>
          <span style={{ fontSize: 11, fontWeight: 700, color: clepPct >= 100 ? "var(--green)" : "var(--accent)" }}>{clepPct}% complete</span>
        </div>
        {daysLeft > 0 && clep.studied < clep.target && (
          <p style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 8 }}>
            Need ~{Math.ceil((clep.target - clep.studied) / daysLeft * 10) / 10}h/day to hit your target by exam day.
          </p>
        )}
      </div>

    </div>
  );
}

function Spinner() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 9, padding: "6px 0" }} aria-label="Loading">
      {[92, 74, 84].map((w, i) => (
        <div key={i} className="skel" style={{ height: 14, width: `${w}%` }} />
      ))}
    </div>
  );
}

// Animated count-up for big stat numbers (eased, ~700ms)
function useCountUp(target: number, duration = 700) {
  const [val, setVal] = useState(target);
  const first = useRef(true);
  useEffect(() => {
    if (!Number.isFinite(target)) { setVal(0); return; }
    const from = first.current ? 0 : val;
    first.current = false;
    if (from === target) { setVal(target); return; }
    let raf: number;
    const start = performance.now();
    const tick = (t: number) => {
      const p = Math.min(1, (t - start) / duration);
      const eased = 1 - Math.pow(1 - p, 3);
      setVal(Math.round(from + (target - from) * eased));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, duration]);
  return val;
}

function CountUp({ value, prefix = "" }: { value: number; prefix?: string }) {
  const v = useCountUp(value);
  return <>{prefix}{v.toLocaleString()}</>;
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 200 }} />
      <div style={{
        position: "fixed", top: "15%", left: "50%", transform: "translateX(-50%)",
        width: "min(500px, 90vw)", zIndex: 201,
        background: "var(--bg-secondary)", border: "1px solid var(--border)",
        borderRadius: 14, padding: 24, display: "flex", flexDirection: "column", gap: 16,
        boxShadow: "0 24px 60px rgba(0,0,0,0.6)",
      }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <p style={{ fontSize: 15, fontWeight: 700 }}>{title}</p>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "var(--text-muted)", fontSize: 18, cursor: "pointer" }}>×</button>
        </div>
        {children}
      </div>
    </>
  );
}

function ModalField({ label, value, onChange, placeholder, type = "text" }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; type?: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <label style={{ fontSize: 12, color: "var(--text-muted)" }}>{label}</label>
      <input type={type} value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder}
        style={{ background: "var(--bg-hover)", border: "1px solid var(--border)", borderRadius: 8, padding: "10px 12px", color: "var(--text-primary)", fontSize: 13, outline: "none" }} />
    </div>
  );
}

function ModalActions({ onCancel, onSubmit, saving, submitLabel }: { onCancel: () => void; onSubmit: () => void; saving: boolean; submitLabel: string }) {
  return (
    <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 4 }}>
      <button onClick={onCancel} style={{ padding: "8px 18px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--bg-card)", color: "var(--text-muted)", cursor: "pointer", fontSize: 13 }}>Cancel</button>
      <button onClick={onSubmit} disabled={saving} style={{ padding: "8px 18px", borderRadius: 8, border: "none", background: "var(--accent)", color: "#fff", cursor: "pointer", fontSize: 13, fontWeight: 700, opacity: saving ? 0.6 : 1 }}>
        {saving ? "Saving..." : submitLabel}
      </button>
    </div>
  );
}

function Placeholder({ label, icon }: { label: string; icon: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "60vh", flexDirection: "column", gap: 16 }}>
      <span style={{ fontSize: 48 }}>{icon}</span>
      <h2 style={{ fontSize: 20, fontWeight: 700 }}>{label}</h2>
      <p style={{ color: "var(--text-muted)", fontSize: 14 }}>Being built next</p>
    </div>
  );
}
