"use client";
import { useState, useEffect, useCallback, useRef } from "react";
import dynamic from "next/dynamic";
import { motion, MotionConfig } from "motion/react";
import { Bolt, Users, Cpu, Bulb, Plus, Calendar, Note, Sparkles } from "reicon-react";
import { staggerContainer, riseItem, hoverSpring, cardHover, cardTap } from "./components/motion";
import { Sparkline, Delta, buildDailySeries } from "./components/Charts";
import { StatTiles, MissionPanels, MissionStyles, Selection, StatTile } from "./components/MissionControlCore";

type IconType = React.ComponentType<{ size?: number; color?: string }>;

const VaultGraph = dynamic(() => import("./components/VaultGraph"), { ssr: false });
const Search = dynamic(() => import("./components/Search"), { ssr: false });
const ActivityLog = dynamic(() => import("./components/ActivityLog"), { ssr: false });
const WeekCalendar = dynamic(() => import("./components/WeekCalendar"), { ssr: false });
const MissionOps = dynamic(() => import("./components/MissionOps"), { ssr: false });
const ClientsBoard = dynamic(() => import("./components/ClientsBoard"), { ssr: false });

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
  { id: "clients", label: "Clients", icon: Users, subs: [{ id: "clients", label: "Clients" }] },
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
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [ghlData, setGhlData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [openNotePath, setOpenNotePath] = useState<string | undefined>();
  const [newLeadCount, setNewLeadCount] = useState(0);
  const prevLeadCount = useRef(0);

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

  const fetchGhl = useCallback(() => {
    fetch("/api/ghl")
      .then(r => r.json())
      .then(d => {
        setGhlData(d);
        setLoading(false);
        const count = d.recentLeads?.length ?? 0;
        if (prevLeadCount.current > 0 && count > prevLeadCount.current) {
          setNewLeadCount(n => n + (count - prevLeadCount.current));
        }
        prevLeadCount.current = count;
      })
      .catch(() => setLoading(false));
  }, []);

  useEffect(() => {
    fetchGhl();
    const id = setInterval(fetchGhl, 5 * 60 * 1000); // every 5 minutes
    return () => clearInterval(id);
  }, [fetchGhl]);

  return (
    <MotionConfig reducedMotion="user">
    <div style={{ display: "flex", height: "100vh", background: "var(--bg-primary)" }}>

      {/* Sidebar */}
      <aside style={{
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
                      background: "#f87171", color: "#fff",
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

        {/* Jarvis — the one merged assistant (AI brain + voice), opens the panel */}
        <button onClick={() => window.dispatchEvent(new CustomEvent("jarvis:open"))} style={{
          display: "flex", alignItems: "center", gap: 10,
          margin: "0 8px 4px", padding: "10px 10px", borderRadius: 8,
          background: "var(--accent-glow)", border: "1px solid var(--accent)",
          color: "var(--accent)", cursor: "pointer",
          fontSize: 13, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden",
        }}>
          <span style={{ display: "inline-flex", flexShrink: 0 }}><Sparkles size={16} /></span>
          {sidebarOpen && <span>Jarvis</span>}
        </button>

        <button onClick={() => setSidebarOpen(!sidebarOpen)} style={{
          margin: "8px", padding: "8px", borderRadius: 8, border: "none",
          background: "transparent", color: "var(--text-muted)",
          cursor: "pointer", fontSize: 16,
        }}>
          {sidebarOpen ? "◀" : "▶"}
        </button>
      </aside>

      {/* Main */}
      <main style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <header style={{
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
            <Search onOpenNote={handleSearchOpenNote} />
            <div style={{
              width: 34, height: 34, borderRadius: "50%",
              background: "linear-gradient(135deg, #22d3ee, #0e7490)",
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 14, fontWeight: 700,
            }}>J</div>
          </div>
        </header>

        {/* Sub-tabs for the active group */}
        {groupOf(active).subs.length > 1 && (
          <div style={{
            display: "flex", gap: 6, padding: "10px 24px 0 24px",
            background: "var(--bg-primary)", flexShrink: 0, flexWrap: "wrap",
          }}>
            {groupOf(active).subs.map(sub => (
              <button key={sub.id} onClick={() => setActive(sub.id)} style={{
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
        )}

        <div style={{ flex: 1, overflow: "auto", padding: "24px" }}>
          {/* CSS-only section transition: the new view mounts IMMEDIATELY
              (no JS-gated exit animation that can stall in background tabs). */}
          <style>{`@keyframes viewIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }`}</style>
          <div key={active} style={{ animation: "viewIn 0.25s ease-out" }}>
              {active === "command" && <CommandCenter data={ghlData} loading={loading} onSendToAI={sendToAI} />}
              {active === "clients" && <ClientsBoard />}
              {active === "competitors" && <CompetitorIntel onSendToAI={sendToAI} />}
              {active === "knowledge" && <KnowledgeBase initialPath={openNotePath} onSendToAI={sendToAI} />}
              {active === "agent" && <MissionOps />}
              {active === "log" && <ActivityLog />}
              {active === "personal" && <PersonalSection data={ghlData} />}
          </div>
        </div>
      </main>
    </div>
    </MotionConfig>
  );
}

function CommandCenter({ data, loading, onSendToAI }: { data: any; loading: boolean; onSendToAI: (ctx: string) => void }) {
  const [showAddLead, setShowAddLead] = useState(false);
  const [showNewNote, setShowNewNote] = useState(false);
  const [leadForm, setLeadForm] = useState({ firstName: "", lastName: "", email: "", phone: "", tag: "" });
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
  const [statSelection, setStatSelection] = useState<Selection>(null);
  const stats = data?.stats;

  // Command Center absorbs the mission stats row (MRR, active clients,
  // pipeline size, emails sent) — big tiles, zero configuration.
  useEffect(() => {
    const load = () => fetch("/api/mission")
      .then(r => r.json())
      .then(d => { if (d?.stats?.tiles) setMissionStats(d.stats); })
      .catch(() => {});
    load();
    const id = setInterval(load, 5 * 60 * 1000);
    return () => clearInterval(id);
  }, []);

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
  const locationId = data?.locationId ?? "";
  const appointments = data?.appointments ?? [];
  const todayAppts = appointments.filter((a: any) => {
    const d = new Date(a.startTime);
    const now = new Date();
    return d.toDateString() === now.toDateString();
  });

  // Morning briefing: new leads today
  const todayLeads = (data?.recentLeads ?? []).filter((l: any) => {
    if (!l.dateAdded) return false;
    return new Date(l.dateAdded).toDateString() === new Date().toDateString();
  });

  // Hourly calendar refresh
  useEffect(() => {
    if (!showCalendar) return;
    const id = setInterval(() => setCalendarKey(k => k + 1), 60 * 60 * 1000);
    return () => clearInterval(id);
  }, [showCalendar]);

  const ghlBase = `https://app.gohighlevel.com/v2/location/${locationId}`;
  const STATS = [
    { label: "Opened Emails", value: loading ? "..." : (stats?.openedEmails ?? 0), color: "#4ade80", href: `${ghlBase}/conversations` },
    { label: "MRR", value: loading ? "..." : `$${(stats?.mrr ?? 0).toLocaleString()}`, color: "#fb923c" },
    { label: "Appts This Week", value: loading ? "..." : (stats?.apptsThisWeek ?? 0), color: "#60a5fa", onClick: () => setShowCalendar(c => !c) },
  ];

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(""), 3000);
  }

  async function submitLead() {
    setSaving(true);
    const [first, ...rest] = leadForm.firstName.trim().split(" ");
    const res = await fetch("/api/ghl/contact", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        firstName: first,
        lastName: rest.join(" ") || leadForm.lastName,
        email: leadForm.email,
        phone: leadForm.phone,
        tags: leadForm.tag ? [leadForm.tag] : [],
      }),
    });
    setSaving(false);
    if (res.ok) {
      showToast("Lead added to GHL!");
      setShowAddLead(false);
      setLeadForm({ firstName: "", lastName: "", email: "", phone: "", tag: "" });
    } else {
      showToast("Error adding lead. Check GHL API.");
    }
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
      {/* Toast */}
      {toast && (
        <div style={{ position: "fixed", bottom: 24, right: 24, background: "#4ade80", color: "#07080f", padding: "10px 18px", borderRadius: 10, fontWeight: 700, fontSize: 13, zIndex: 200 }}>
          {toast}
        </div>
      )}

      {/* Morning Briefing — skeleton while GHL loads so it never looks blank */}
      {loading && (
        <div style={{
          borderRadius: 20, border: "1px solid rgba(34,211,238,0.15)", padding: "24px 28px",
          background: "linear-gradient(180deg, var(--bg-card), rgba(12,15,26,0.85))",
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
        <motion.div variants={riseItem} style={{
          position: "relative",
          background: "linear-gradient(120deg, rgba(34,211,238,0.10), rgba(167,139,250,0.08) 55%, rgba(16,19,31,0.4))",
          border: "1px solid rgba(34,211,238,0.25)",
          borderRadius: 20, padding: "24px 28px",
          boxShadow: "0 16px 48px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.06)",
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
          <div style={{ display: "flex", gap: 32, flexWrap: "wrap", alignItems: "flex-end" }}>
            <div>
              <div style={{ display: "flex", alignItems: "flex-end", gap: 10 }}>
                <p style={{ fontSize: 36, fontWeight: 800, color: "#22d3ee", lineHeight: 1, textShadow: "0 0 24px rgba(34,211,238,0.35)", fontFamily: "'Space Grotesk', sans-serif" }}><CountUp value={sentToday ?? camp?.by_day?.[new Date().toLocaleDateString("en-CA")] ?? 0} /></p>
                {camp?.by_day && (() => {
                  const s = buildDailySeries(camp.by_day, 10).map(d => d.value);
                  const today = sentToday ?? s[s.length - 1] ?? 0;
                  if (today !== s[s.length - 1]) s[s.length - 1] = today;
                  return (
                    <div style={{ display: "flex", flexDirection: "column", gap: 4, alignItems: "flex-start" }}>
                      <Sparkline data={s} color="#22d3ee" width={84} height={24} />
                      <Delta value={today - (s[s.length - 2] ?? 0)} label="vs yday" />
                    </div>
                  );
                })()}
              </div>
              <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 6 }}>emails sent today</p>
            </div>
            <div>
              <p style={{ fontSize: 36, fontWeight: 800, color: "#4ade80", lineHeight: 1, textShadow: "0 0 24px rgba(74,222,128,0.35)", fontFamily: "'Space Grotesk', sans-serif" }}><CountUp prefix="$" value={stats?.mrr ?? 0} /></p>
              <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 6 }}>MRR · {data?.activeClients?.length ?? 0} active client{(data?.activeClients?.length ?? 0) === 1 ? "" : "s"}</p>
            </div>
            <div>
              <p style={{ fontSize: 36, fontWeight: 800, color: "#34d399", lineHeight: 1, textShadow: "0 0 24px rgba(52,211,153,0.35)", fontFamily: "'Space Grotesk', sans-serif" }}><CountUp value={stats?.responded ?? 0} /></p>
              <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 6 }}>responded to me</p>
            </div>
            <div style={{ cursor: "pointer" }} onClick={() => setShowCalendar(c => !c)}>
              <p style={{ fontSize: 36, fontWeight: 800, color: "#60a5fa", lineHeight: 1, textShadow: "0 0 24px rgba(96,165,250,0.35)", fontFamily: "'Space Grotesk', sans-serif" }}><CountUp value={todayAppts.length} /></p>
              <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 6 }}>appointments {showCalendar ? "▲" : "▼"}</p>
            </div>
            <button onClick={() => onSendToAI(`Today's Wing Digital briefing:\n- Emails sent today: ${sentToday ?? camp?.by_day?.[new Date().toLocaleDateString("en-CA")] ?? 0}\n- MRR: $${stats?.mrr ?? 0}\n- Responded: ${stats?.responded ?? 0}\n- Appointments today: ${todayAppts.length}\n\nWhat should I prioritize today to grow Wing Digital?`)}
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
                <span className="live-dot" style={{ width: 6, height: 6, borderRadius: "50%", background: "#a78bfa", boxShadow: "0 0 8px #a78bfa", display: "inline-block" }} />
                next agent run: <span style={{ color: "#a78bfa", fontWeight: 700, textTransform: "capitalize" }}>{upcoming.name}</span> · {when}
              </p>
            );
          })()}
          {todayAppts.length > 0 && (
            <div style={{ marginTop: 18, display: "flex", flexDirection: "column", gap: 6 }}>
              {todayAppts.slice(0, 3).map((a: any) => (
                <div key={a.id} style={{
                  display: "flex", justifyContent: "space-between", alignItems: "center",
                  padding: "8px 14px", background: "rgba(0,0,0,0.25)", borderRadius: 10,
                  border: "1px solid rgba(255,255,255,0.05)",
                }}>
                  <span style={{ fontSize: 13, fontWeight: 600 }}>{a.contactName || a.title}</span>
                  <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
                    <span style={{ fontSize: 12, color: "#60a5fa", fontWeight: 600 }}>{a.startTime ? new Date(a.startTime).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) : ""}</span>
                    {a.contactId && locationId && (
                      <a href={`https://app.gohighlevel.com/v2/location/${locationId}/contacts/detail/${a.contactId}`} target="_blank" rel="noreferrer"
                        style={{ fontSize: 11, color: "var(--accent)", textDecoration: "none", fontWeight: 600 }}>GHL →</a>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
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
          background: "radial-gradient(ellipse 90% 60% at 50% -20%, rgba(167,139,250,0.10), transparent 60%), linear-gradient(180deg, var(--bg-card), rgba(12,15,26,0.85))",
          border: "1px solid rgba(167,139,250,0.3)", borderRadius: 16, padding: "16px 20px",
          boxShadow: "0 8px 24px rgba(0,0,0,0.25)",
        }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "pointer", flexWrap: "wrap", gap: 8 }}
            onClick={() => setShowBriefing(b => !b)}>
            <p style={{ fontSize: 12.5, fontWeight: 700, color: "#a78bfa" }}>
              🌅 Dispatch Briefing · <span style={{ color: "var(--text-muted)", fontWeight: 600 }}>{brief.date_label}</span>
            </p>
            <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
              {[
                { l: "live", v: brief.stats.live, c: "#60a5fa" },
                { l: "callbacks", v: brief.stats.callbacks, c: "#a78bfa" },
                { l: "redials", v: brief.stats.followup, c: "#fbbf24" },
                { l: "booked", v: brief.stats.booked, c: "#34d399" },
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
                    <span style={{ fontSize: 11, fontWeight: 800, color: d.why.includes("callback") ? "#a78bfa" : d.why === "redial" ? "#fbbf24" : "var(--text-muted)", width: 20, textAlign: "right", fontFamily: "'Space Grotesk', sans-serif" }}>{d.n}</span>
                    <span style={{ fontSize: 13, fontWeight: 700, flex: 1, minWidth: 140, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{d.name}</span>
                    <span style={{ fontSize: 11.5, color: "var(--text-muted)", width: 110, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{d.city}</span>
                    <span style={{
                      fontSize: 10, fontWeight: 700, padding: "2px 9px", borderRadius: 999, whiteSpace: "nowrap",
                      color: d.why.includes("callback") ? "#a78bfa" : d.why === "redial" ? "#fbbf24" : "#22d3ee",
                      background: d.why.includes("callback") ? "rgba(167,139,250,0.12)" : d.why === "redial" ? "rgba(251,191,36,0.10)" : "rgba(34,211,238,0.08)",
                    }}>{d.why}</span>
                    <a href={`tel:${d.phone}`} onClick={e => e.stopPropagation()}
                      style={{ fontSize: 12, fontWeight: 700, color: "#60a5fa", textDecoration: "none", whiteSpace: "nowrap", width: 130, textAlign: "right" }}>
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
        const HC: Record<string, string> = { ok: "#34d399", crashed: "#f87171", idle: "#fbbf24", running: "#60a5fa" };
        const crashed = agentHealth.filter(a => a.health === "crashed").length;
        const running = agentHealth.filter(a => a.state === "Running").length;
        const onBattery = agentHealth.some(a => a.onBatteryBlocked);
        const summary = crashed > 0 ? `${crashed} need attention` : onBattery ? "battery-blocked" : running > 0 ? `${running} running now` : "all healthy";
        const summaryColor = crashed > 0 ? "#f87171" : onBattery ? "#fbbf24" : "#34d399";
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
            background: "linear-gradient(180deg, var(--bg-card), rgba(12,15,26,0.85))",
            border: "1px solid rgba(255,255,255,0.07)", borderRadius: 16, padding: "16px 20px",
            boxShadow: "0 8px 24px rgba(0,0,0,0.25)",
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
                    background: "rgba(255,255,255,0.025)", border: "1px solid rgba(255,255,255,0.05)", borderRadius: 10,
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
              <p style={{ fontSize: 10.5, color: "#fbbf24", marginTop: 12 }}>
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
              <p style={{ fontSize: 30, fontWeight: 700, color: stat.color, fontFamily: "'Space Grotesk', sans-serif", textShadow: `0 0 20px ${stat.color}44`, lineHeight: 1 }}>{stat.value}</p>
              {(stat.onClick || stat.href) && <p style={{ fontSize: 10, color: stat.color, marginTop: 8, opacity: 0.8 }}>Open in GHL →</p>}
            </>
          );
          const baseStyle: React.CSSProperties = {
            position: "relative",
            background: `radial-gradient(ellipse 90% 70% at 50% -20%, ${stat.color}14, transparent 60%), linear-gradient(180deg, var(--bg-card), rgba(12,15,26,0.85))`,
            border: "1px solid rgba(255,255,255,0.07)",
            borderRadius: 16, padding: "18px 20px",
            boxShadow: "0 8px 24px rgba(0,0,0,0.25), inset 0 1px 0 rgba(255,255,255,0.04)",
            cursor: stat.onClick || stat.href ? "pointer" : "default",
            textDecoration: "none", display: "block", overflow: "hidden",
          };
          const interactive = Boolean(stat.onClick || stat.href);
          const hover = interactive ? cardHover : undefined;
          const tap = interactive ? cardTap : undefined;
          if (stat.href) return (
            <motion.a key={stat.label} href={stat.href} target="_blank" rel="noreferrer" style={baseStyle}
              whileHover={hover} whileTap={tap} transition={hoverSpring}>{inner}</motion.a>
          );
          return <motion.div key={stat.label} onClick={stat.onClick} style={baseStyle}
            whileHover={hover} whileTap={tap} transition={hoverSpring}>{inner}</motion.div>;
        })}
      </motion.div>

      {/* Week Calendar -- toggle */}
      {showCalendar && !loading && (
        <WeekCalendar key={calendarKey} appointments={appointments} locationId={locationId} />
      )}

      {/* Quick Actions — floating pill row */}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em", marginRight: 4 }}>Quick</span>
        {[
          { icon: Plus, label: "Add Lead", action: () => setShowAddLead(true), c: "#34d399" },
          { icon: Calendar, label: "Calendar", action: () => setShowCalendar(c => !c), c: "#60a5fa" },
          { icon: Note, label: "New Note", action: () => setShowNewNote(true), c: "#a78bfa" },
          { icon: Sparkles, label: "Ask Claude", action: () => onSendToAI("What should I focus on today for Wing Digital?"), c: "#E8692A" },
        ].map(btn => (
          <motion.button key={btn.label} onClick={btn.action}
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
          background: "linear-gradient(180deg, var(--bg-card), rgba(12,15,26,0.85))",
          border: "1px solid rgba(255,255,255,0.07)", borderRadius: 16, padding: 20,
          boxShadow: "0 8px 24px rgba(0,0,0,0.25), inset 0 1px 0 rgba(255,255,255,0.04)",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
            <span className="live-dot" style={{ width: 6, height: 6, borderRadius: "50%", background: "#22d3ee", boxShadow: "0 0 8px #22d3ee" }} />
            <p style={{ fontSize: 12, fontWeight: 700, color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.07em" }}>Active Clients</p>
          </div>
          {loading ? <Spinner /> : (data?.activeClients?.length ? (
            <motion.div style={{ display: "flex", flexDirection: "column", gap: 8 }}
              variants={staggerContainer} initial="hidden" animate="show">
              {data.activeClients.slice(0, 50).map((client: any) => (
                <motion.div key={client.id} variants={riseItem} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: "1px solid var(--border)" }}>
                  <p style={{ fontSize: 13, fontWeight: 600 }}>{client.name}</p>
                  <span style={{ fontSize: 13, color: "#4ade80", fontWeight: 600 }}>${client.value.toLocaleString()}/mo</span>
                </motion.div>
              ))}
            </motion.div>
          ) : <p style={{ color: "var(--text-muted)", fontSize: 13 }}>No won opportunities yet</p>)}
        </div>
      </motion.div>

      {/* Add Lead Modal */}
      {showAddLead && <Modal title="Add Lead to GHL" onClose={() => setShowAddLead(false)}>
        <ModalField label="Full Name" value={leadForm.firstName} onChange={v => setLeadForm(f => ({ ...f, firstName: v }))} placeholder="John Smith" />
        <ModalField label="Email" value={leadForm.email} onChange={v => setLeadForm(f => ({ ...f, email: v }))} placeholder="john@example.com" type="email" />
        <ModalField label="Phone" value={leadForm.phone} onChange={v => setLeadForm(f => ({ ...f, phone: v }))} placeholder="+1 (555) 000-0000" type="tel" />
        <ModalField label="Industry Tag" value={leadForm.tag} onChange={v => setLeadForm(f => ({ ...f, tag: v }))} placeholder="roofing, HVAC, plumbing..." />
        <ModalActions onCancel={() => setShowAddLead(false)} onSubmit={submitLead} saving={saving} submitLabel="Add to GHL" />
      </Modal>}

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

function CompetitorIntel({ onSendToAI }: { onSendToAI: (ctx: string) => void }) {
  const [status, setStatus] = useState<"idle" | "running" | "done" | "error">("idle");
  const [rawContent, setRawContent] = useState<string>("");
  const [lastUpdated, setLastUpdated] = useState<string>("");
  const [errorMsg, setErrorMsg] = useState("");
  const [toast, setToast] = useState("");
  const [activeCard, setActiveCard] = useState<number | null>(null);
  const [usageStats, setUsageStats] = useState<{ spent: number; runs: number; budget: number; remaining: number } | null>(null);

  function showToast(msg: string) { setToast(msg); setTimeout(() => setToast(""), 3000); }

  // Parse the markdown into sections for display
  const sections = parseCompetitorSections(rawContent);

  useEffect(() => {
    loadContent();
  }, []);

  async function loadContent() {
    try {
      const res = await fetch("/api/agents/competitor-research");
      const data = await res.json();
      if (data.content) setRawContent(data.content);
      if (data.usage) setUsageStats(data.usage);
      const match = data.content?.match(/## Last Updated: (.+)/);
      if (match) setLastUpdated(match[1]);
    } catch { /* no file yet */ }
  }

  async function runResearch() {
    setStatus("running");
    setErrorMsg("");
    try {
      const res = await fetch("/api/agents/competitor-research", { method: "POST" });
      const data = await res.json();
      if (data.ok) {
        setStatus("done");
        showToast(`Intel updated · $${data.spent?.toFixed(3) ?? "?"} used this month`);
        await loadContent();
      } else {
        setStatus("error");
        setErrorMsg(data.error ?? "Unknown error");
      }
    } catch (e: any) {
      setStatus("error");
      setErrorMsg(e.message);
    }
  }

  const analyzePrompt = rawContent
    ? `Here is Wing Digital's current competitor intelligence:\n\n${rawContent}\n\nWing Digital: $1,000/month, done-for-you marketing automation for DFW home service businesses (roofing, HVAC, plumbing, electrical, pool service). We handle GHL CRM, lead gen (Apollo), AI receptionist, review automation, referral automation, and email sequences.\n\nBased on this competitor landscape:\n1. What are competitors NOT offering that we should highlight?\n2. What pricing gaps exist?\n3. What is our strongest differentiator to lead with in sales calls?\n4. Is there anything competitors are doing that we should add?`
    : "";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20, maxWidth: 960 }}>
      {toast && <div style={{ position: "fixed", bottom: 24, right: 24, background: "#4ade80", color: "#07080f", padding: "10px 18px", borderRadius: 10, fontWeight: 700, fontSize: 13, zIndex: 200 }}>{toast}</div>}

      {/* Header */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
        <div>
          <h2 style={{ fontSize: 18, fontWeight: 700 }}>Competitor Intelligence</h2>
          <p style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 4 }}>
            DFW marketing automation agencies — what they offer, what they charge, where Wing Digital wins.
          </p>
          {lastUpdated && (
            <p style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>
              Last updated: {lastUpdated}
            </p>
          )}
          {usageStats && (
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 6 }}>
              <div style={{ width: 120, height: 5, background: "var(--bg-hover)", borderRadius: 10, overflow: "hidden" }}>
                <div style={{
                  height: "100%", borderRadius: 10,
                  width: `${Math.min(100, (usageStats.spent / usageStats.budget) * 100)}%`,
                  background: usageStats.remaining < 0.50 ? "#f87171" : "#4ade80",
                  transition: "width 0.4s",
                }} />
              </div>
              <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                ${usageStats.spent.toFixed(3)} / ${usageStats.budget.toFixed(2)} this month · {usageStats.runs} runs
              </span>
            </div>
          )}
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <button
            onClick={runResearch}
            disabled={status === "running"}
            style={{
              padding: "9px 20px", borderRadius: 10, fontSize: 13, cursor: status === "running" ? "not-allowed" : "pointer",
              background: status === "running" ? "var(--bg-hover)" : "linear-gradient(135deg, #22d3ee, #0e7490)",
              border: "none", color: "#fff", fontWeight: 700,
              opacity: status === "running" ? 0.7 : 1,
              display: "flex", alignItems: "center", gap: 8,
            }}
          >
            {status === "running" ? (
              <><span style={{ display: "inline-block", animation: "spin 1s linear infinite" }}>⟳</span> Researching...</>
            ) : "⟳ Run Research Now"}
          </button>
          <button
            onClick={() => onSendToAI(analyzePrompt)}
            disabled={!rawContent}
            style={{
              padding: "9px 18px", borderRadius: 10, fontSize: 13,
              cursor: rawContent ? "pointer" : "not-allowed",
              background: "var(--accent-glow)", border: "1px solid var(--accent)",
              color: "var(--accent)", fontWeight: 600, opacity: rawContent ? 1 : 0.4,
            }}
          >
            Ask Claude to Analyze →
          </button>
        </div>
      </div>

      {/* Error banner */}
      {errorMsg && (
        <div style={{ background: "#f8717122", border: "1px solid #f87171", borderRadius: 10, padding: "14px 18px" }}>
          <p style={{ fontSize: 13, fontWeight: 700, color: "#f87171", marginBottom: 4 }}>Setup Required</p>
          <p style={{ fontSize: 13, color: "var(--text-primary)" }}>{errorMsg}</p>
          {errorMsg.includes("brave") || errorMsg.includes("BRAVE") ? (
            <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 8 }}>
              1. Go to brave.com/search/api and sign up for free (2,000 queries/month)<br />
              2. Copy your API key<br />
              3. Open <code style={{ background: "var(--bg-hover)", padding: "1px 6px", borderRadius: 4 }}>.env.local</code> and paste it next to <code style={{ background: "var(--bg-hover)", padding: "1px 6px", borderRadius: 4 }}>BRAVE_SEARCH_API_KEY=</code><br />
              4. Restart the dev server, then click Run Research Now
            </p>
          ) : null}
        </div>
      )}

      {/* No content yet */}
      {!rawContent && status !== "running" && !errorMsg && (
        <div style={{ padding: "60px 0", textAlign: "center", color: "var(--text-muted)", background: "var(--bg-card)", borderRadius: 14, border: "1px solid var(--border)" }}>
          <p style={{ fontSize: 36, marginBottom: 12 }}>🔍</p>
          <p style={{ fontSize: 16, fontWeight: 700, color: "var(--text-primary)", marginBottom: 8 }}>No intel yet</p>
          <p style={{ fontSize: 13, marginBottom: 20 }}>Click "Run Research Now" to scan what DFW competitors are doing.</p>
          <div style={{ maxWidth: 400, margin: "0 auto", background: "var(--bg-hover)", borderRadius: 10, padding: 16, textAlign: "left" }}>
            <p style={{ fontSize: 12, fontWeight: 700, color: "var(--text-secondary)", marginBottom: 8 }}>What it researches:</p>
            {["DFW marketing automation agencies", "Competitor pricing and packages", "GoHighLevel resellers in Texas", "Home service marketing positioning", "What they offer vs what Wing Digital offers"].map(item => (
              <p key={item} style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 5 }}>→ {item}</p>
            ))}
          </div>
        </div>
      )}

      {/* Running state */}
      {status === "running" && (
        <div style={{ padding: "40px 0", textAlign: "center", color: "var(--text-muted)", background: "var(--bg-card)", borderRadius: 14, border: "1px solid var(--border)" }}>
          <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
          <p style={{ fontSize: 32, marginBottom: 12, display: "inline-block", animation: "spin 1.2s linear infinite" }}>⟳</p>
          <p style={{ fontSize: 14, fontWeight: 600, color: "var(--text-primary)", marginBottom: 4 }}>Researching competitors...</p>
          <p style={{ fontSize: 12 }}>Searching Brave · Analyzing with Groq · Writing to vault</p>
        </div>
      )}

      {/* Content sections */}
      {rawContent && status !== "running" && sections.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {sections.map((section, i) => (
            <div key={i} style={{
              background: `linear-gradient(90deg, ${INTEL_COLORS[i % INTEL_COLORS.length]}0a, transparent 30%), linear-gradient(180deg, var(--bg-card), rgba(12,15,26,0.85))`,
              border: "1px solid rgba(255,255,255,0.07)",
              borderRadius: 14, overflow: "hidden",
              borderLeft: `3px solid ${INTEL_COLORS[i % INTEL_COLORS.length]}`,
              boxShadow: "0 6px 20px rgba(0,0,0,0.2)",
            }}>
              <button
                onClick={() => setActiveCard(activeCard === i ? null : i)}
                style={{
                  width: "100%", padding: "14px 18px", background: "transparent", border: "none",
                  cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <span style={{ fontSize: 18 }}>{INTEL_ICONS[i % INTEL_ICONS.length]}</span>
                  <span style={{ fontSize: 14, fontWeight: 700, color: "var(--text-primary)", textAlign: "left" }}>{section.title}</span>
                </div>
                <span style={{ fontSize: 14, color: "var(--text-muted)", flexShrink: 0 }}>{activeCard === i ? "▲" : "▼"}</span>
              </button>
              {activeCard === i && (
                <div style={{ padding: "0 18px 16px", borderTop: "1px solid var(--border)" }}>
                  <div style={{ paddingTop: 14, display: "flex", flexDirection: "column", gap: 6 }}>
                    {section.bullets.map((bullet, bi) => (
                      <div key={bi} style={{ display: "flex", gap: 10, padding: "6px 10px", background: "var(--bg-hover)", borderRadius: 8 }}>
                        <span style={{ color: INTEL_COLORS[i % INTEL_COLORS.length], flexShrink: 0, fontWeight: 700, marginTop: 1 }}>→</span>
                        <p style={{ fontSize: 13, color: "var(--text-primary)", lineHeight: 1.6 }}>{bullet}</p>
                      </div>
                    ))}
                  </div>
                  <CompetitorAskBtn section={section} onSendToAI={onSendToAI} />
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Raw view fallback if parsing returns nothing */}
      {rawContent && status !== "running" && sections.length === 0 && (
        <div style={{ background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 12, padding: 20 }}>
          <pre style={{ fontSize: 12, color: "var(--text-primary)", whiteSpace: "pre-wrap", lineHeight: 1.7 }}>{rawContent}</pre>
        </div>
      )}

      {/* Wing Digital vs market summary card */}
      {rawContent && (
        <div style={{
          background: "linear-gradient(120deg, rgba(34,211,238,0.08), rgba(167,139,250,0.07) 60%, rgba(16,19,31,0.4))",
          border: "1px solid rgba(34,211,238,0.25)", borderRadius: 18, padding: 22,
          boxShadow: "0 12px 32px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.05)",
        }}>
          <p style={{
            fontSize: 12, fontWeight: 700, marginBottom: 14, textTransform: "uppercase", letterSpacing: "0.1em",
            background: "linear-gradient(90deg, var(--accent), var(--accent-2))",
            WebkitBackgroundClip: "text", backgroundClip: "text", color: "transparent",
          }}>◈ Wing Digital Positioning</p>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
            <div>
              <p style={{ fontSize: 11, fontWeight: 700, color: "#4ade80", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>Our Advantages</p>
              {["$1,000/mo flat — no hidden fees", "Done-for-you — zero client config", "Home service niche expertise", "Apollo + Claude + GHL pipeline built in", "60s missed-call text-back SLA"].map(item => (
                <p key={item} style={{ fontSize: 12, color: "var(--text-primary)", marginBottom: 5 }}>✓ {item}</p>
              ))}
            </div>
            <div>
              <p style={{ fontSize: 11, fontWeight: 700, color: "#fb923c", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>Watch For</p>
              {["Competitors lowering prices", "New AI features being added", "GHL resellers undercutting", "Agencies targeting same niche", "Any DFW-specific marketing plays"].map(item => (
                <p key={item} style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 5 }}>⚑ {item}</p>
              ))}
            </div>
          </div>
          <button
            onClick={() => onSendToAI("Based on Wing Digital's competitor landscape, write me a 3-sentence elevator pitch that I can use on a cold call to a DFW roofing contractor. Make it specific, confident, and focused on what competitors aren't doing. No em dashes. Under 60 words.")}
            style={{
              marginTop: 16, padding: "9px 20px", borderRadius: 999, fontSize: 12, cursor: "pointer",
              background: "linear-gradient(135deg, #22d3ee, #a78bfa)", border: "none", color: "#07080f", fontWeight: 700,
              boxShadow: "0 4px 16px rgba(34,211,238,0.3)",
            }}
          >
            ✦ Generate Sales Pitch from Intel
          </button>
        </div>
      )}

      {/* Auto-run schedule info */}
      <div style={{
        background: "rgba(255,255,255,0.025)", border: "1px solid rgba(255,255,255,0.06)",
        borderRadius: 14, padding: "14px 18px", display: "flex", alignItems: "center", gap: 14,
      }}>
        <span style={{ fontSize: 22 }}>⏰</span>
        <div>
          <p style={{ fontSize: 13, fontWeight: 600 }}>Scheduled: Every morning at 7:00 AM</p>
          <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2 }}>
            Runs automatically via Windows Task Scheduler while the OS is open. Run <code style={{ background: "var(--bg-hover)", padding: "1px 6px", borderRadius: 4, fontSize: 11 }}>scripts/setup-competitor-cron.ps1</code> as Admin once to activate.
          </p>
        </div>
      </div>
    </div>
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

const INTEL_COLORS = ["#60a5fa", "#fb923c", "#22d3ee", "#4ade80", "#f472b6", "#34d399", "#facc15", "#38bdf8"];
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

function Clients({ data, loading }: { data: any; loading: boolean }) {
  const clients = data?.activeClients ?? [];
  const mrr = data?.stats?.mrr ?? 0;
  const locationId = data?.locationId ?? "";
  const [noteClient, setNoteClient] = useState<string | null>(null);
  const [noteContent, setNoteContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState("");

  function showToast(msg: string) { setToast(msg); setTimeout(() => setToast(""), 3000); }

  async function saveClientNote(clientName: string) {
    setSaving(true);
    const title = `${clientName} - Note ${new Date().toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
    const filePath = `wiki/clients/${clientName.replace(/[^a-zA-Z0-9 ]/g, "").trim()}.md`;
    const res = await fetch("/api/vault/write", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filePath, content: `# ${title}\n\n${noteContent}` }),
    });
    setSaving(false);
    if (res.ok) { showToast("Note saved to vault!"); setNoteClient(null); setNoteContent(""); }
    else showToast("Save failed.");
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      {toast && <div style={{ position: "fixed", bottom: 24, right: 24, background: "#4ade80", color: "#07080f", padding: "10px 18px", borderRadius: 10, fontWeight: 700, fontSize: 13, zIndex: 200 }}>{toast}</div>}
      {noteClient && <Modal title={`Note for ${noteClient}`} onClose={() => setNoteClient(null)}>
        <textarea value={noteContent} onChange={e => setNoteContent(e.target.value)} rows={6} placeholder="Write your note..."
          style={{ background: "var(--bg-hover)", border: "1px solid var(--border)", borderRadius: 8, padding: "10px 12px", color: "var(--text-primary)", fontSize: 13, resize: "vertical", outline: "none", width: "100%" }} />
        <ModalActions onCancel={() => setNoteClient(null)} onSubmit={() => saveClientNote(noteClient)} saving={saving} submitLabel="Save to Vault" />
      </Modal>}
      {/* MRR summary */}
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
        {[
          { label: "Total Clients", value: loading ? "..." : clients.length, color: "#22d3ee" },
          { label: "MRR", value: loading ? "..." : `$${mrr.toLocaleString()}`, color: "#4ade80" },
          { label: "Avg Deal", value: loading || !clients.length ? "..." : `$${Math.round(mrr / clients.length).toLocaleString()}`, color: "#60a5fa" },
        ].map(s => (
          <div key={s.label} style={{
            background: `radial-gradient(ellipse 90% 80% at 50% -30%, ${s.color}14, transparent 60%), linear-gradient(180deg, var(--bg-card), rgba(12,15,26,0.85))`,
            border: "1px solid rgba(255,255,255,0.07)", borderRadius: 14, padding: "16px 22px",
            flex: 1, minWidth: 140,
            boxShadow: "0 8px 24px rgba(0,0,0,0.25), inset 0 1px 0 rgba(255,255,255,0.04)",
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
              <span style={{ width: 5, height: 5, borderRadius: "50%", background: s.color, boxShadow: `0 0 7px ${s.color}` }} />
              <p style={{ fontSize: 10.5, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 600 }}>{s.label}</p>
            </div>
            <p style={{ fontSize: 26, fontWeight: 800, color: s.color, fontFamily: "'Space Grotesk', sans-serif", textShadow: `0 0 18px ${s.color}44`, lineHeight: 1 }}>{s.value}</p>
          </div>
        ))}
      </div>

      {loading ? <Spinner /> : clients.length ? (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 14 }}>
          {clients.map((client: any) => (
            <div key={client.id} style={{
              background: "radial-gradient(ellipse 90% 60% at 50% -20%, rgba(52,211,153,0.1), transparent 60%), linear-gradient(180deg, var(--bg-card), rgba(12,15,26,0.85))",
              border: "1px solid rgba(255,255,255,0.07)",
              borderRadius: 16, padding: 20,
              boxShadow: "0 8px 24px rgba(0,0,0,0.25), inset 0 1px 0 rgba(255,255,255,0.04)",
              display: "flex", flexDirection: "column", gap: 12,
            }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                  <div style={{
                    width: 36, height: 36, borderRadius: 11, flexShrink: 0,
                    background: "linear-gradient(135deg, rgba(52,211,153,0.25), rgba(34,211,238,0.12))",
                    border: "1px solid rgba(52,211,153,0.35)",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    fontSize: 14, fontWeight: 800, color: "#34d399",
                    fontFamily: "'Space Grotesk', sans-serif",
                  }}>{(client.name || "?").charAt(0).toUpperCase()}</div>
                  <div>
                    <p style={{ fontSize: 15, fontWeight: 700 }}>{client.name}</p>
                    <p style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>{client.stage}</p>
                  </div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <p style={{ fontSize: 18, fontWeight: 800, color: "#34d399", fontFamily: "'Space Grotesk', sans-serif", textShadow: "0 0 16px rgba(52,211,153,0.35)" }}>${client.value.toLocaleString()}</p>
                  <p style={{ fontSize: 10, color: "var(--text-muted)" }}>deal value</p>
                </div>
              </div>

              {/* Services placeholder -- will be real when GHL tags are set */}
              <div>
                <p style={{ fontSize: 10, color: "var(--text-muted)", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.06em" }}>Services</p>
                <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                  {(client.tags?.length ? client.tags : ["Active"]).slice(0, 4).map((t: string) => (
                    <span key={t} style={{ fontSize: 10, background: "rgba(52,211,153,0.1)", color: "#34d399", padding: "2px 10px", borderRadius: 999, border: "1px solid rgba(52,211,153,0.3)", fontWeight: 600 }}>{t}</span>
                  ))}
                </div>
              </div>

              <div style={{ display: "flex", gap: 8 }}>
                {locationId && client.contactId ? (
                  <a href={`https://app.gohighlevel.com/v2/location/${locationId}/contacts/detail/${client.contactId}`}
                    target="_blank" rel="noreferrer" style={{
                      flex: 1, padding: "7px 0", borderRadius: 999, fontSize: 12, cursor: "pointer",
                      background: "transparent", border: "1px solid rgba(255,255,255,0.1)", color: "var(--text-secondary)",
                      textDecoration: "none", textAlign: "center", fontWeight: 500,
                    }}>View in GHL →</a>
                ) : (
                  <a href={`https://app.gohighlevel.com/v2/location/${locationId}/opportunities/list`}
                    target="_blank" rel="noreferrer" style={{
                      flex: 1, padding: "7px 0", borderRadius: 999, fontSize: 12,
                      background: "transparent", border: "1px solid rgba(255,255,255,0.1)", color: "var(--text-secondary)",
                      textDecoration: "none", textAlign: "center", fontWeight: 500,
                    }}>View in GHL →</a>
                )}
                <button onClick={() => { setNoteClient(client.name); setNoteContent(""); }} style={{
                  flex: 1, padding: "7px 0", borderRadius: 999, fontSize: 12, cursor: "pointer",
                  background: "rgba(34,211,238,0.08)", border: "1px solid rgba(34,211,238,0.4)", color: "var(--accent)", fontWeight: 600,
                }}>+ Note</button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div style={{ padding: "60px 0", textAlign: "center", color: "var(--text-muted)" }}>
          <p style={{ fontSize: 32, marginBottom: 10 }}>👥</p>
          <p style={{ fontSize: 15, fontWeight: 600, marginBottom: 6 }}>No clients yet</p>
          <p style={{ fontSize: 13 }}>Mark opportunities as "Won" in GHL and they'll appear here with their value and tags.</p>
          <div style={{ marginTop: 24, padding: 20, background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 12, maxWidth: 460, margin: "24px auto 0", textAlign: "left" }}>
            <p style={{ fontSize: 13, fontWeight: 600, marginBottom: 10, color: "var(--text-primary)" }}>When you land clients, each card will show:</p>
            {["Deal value and MRR contribution", "Active services (via GHL tags)", "Quick link to GHL contact", "Note-taking shortcut"].map(item => (
              <p key={item} style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 6 }}>✓ {item}</p>
            ))}
          </div>
        </div>
      )}
    </div>
  );
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
  const [expanded, setExpanded] = useState<Set<string>>(new Set(["wiki"]));

  useEffect(() => {
    fetch("/api/vault").then(r => r.json()).then(d => setTree(d.tree ?? []));
  }, []);

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
      next.has(p) ? next.delete(p) : next.add(p);
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
                {expanded.has(node.path) && node.children && (
                  <FileTree nodes={node.children} depth={depth + 1} />
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
    <div style={{ display: "flex", height: "calc(100vh - 130px)", margin: "-24px", overflow: "hidden" }}>

      {/* Left: File tree */}
      <div style={{ width: 230, flexShrink: 0, borderRight: "1px solid rgba(255,255,255,0.05)", overflow: "auto", padding: "16px 0", background: "rgba(11,13,23,0.6)", backdropFilter: "blur(10px)" }}>
        <p style={{
          fontSize: 11, fontWeight: 700, padding: "0 14px 12px",
          textTransform: "uppercase", letterSpacing: "0.1em",
          background: "linear-gradient(90deg, var(--accent), var(--accent-2))",
          WebkitBackgroundClip: "text", backgroundClip: "text", color: "transparent",
        }}>
          ◈ Vault
        </p>
        <FileTree nodes={tree} />
      </div>

      {/* Middle: Graph always visible */}
      <div style={{ flex: 1, position: "relative", minWidth: 0 }}>
        <VaultGraph onSelectNode={(p) => openFile(p)} />
      </div>

      {/* Toast */}
      {toast && (
        <div style={{ position: "fixed", bottom: 24, right: 24, background: "#4ade80", color: "#07080f", padding: "10px 18px", borderRadius: 10, fontWeight: 700, fontSize: 13, zIndex: 200 }}>
          {toast}
        </div>
      )}

    </div>
  );
}

function PersonalSection({ data }: { data: any }) {
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

  // Lead follow-up tracker -- leads with no recent activity
  const leads = data?.recentLeads ?? [];
  const staleLeads = leads.filter((l: any) => {
    if (!l.dateAdded) return false;
    const days = (Date.now() - new Date(l.dateAdded).getTime()) / 86400000;
    return days > 3;
  }).slice(0, 8);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24, maxWidth: 900 }}>

      {/* Top row: Tasks + Goals */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 16 }}>

        {/* Daily Tasks */}
        <div style={{ background: "linear-gradient(180deg, var(--bg-card), rgba(12,15,26,0.85))", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 16, padding: 20, boxShadow: "0 8px 24px rgba(0,0,0,0.25), inset 0 1px 0 rgba(255,255,255,0.04)" }}>
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
        <div style={{ background: "linear-gradient(180deg, var(--bg-card), rgba(12,15,26,0.85))", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 16, padding: 20, boxShadow: "0 8px 24px rgba(0,0,0,0.25), inset 0 1px 0 rgba(255,255,255,0.04)" }}>
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
                <input type="checkbox" checked={g.done} onChange={() => toggleGoal(g.id)} style={{ cursor: "pointer", width: 16, height: 16, accentColor: "#4ade80" }} />
                <span style={{ flex: 1, fontSize: 13, color: g.done ? "var(--text-muted)" : "var(--text-primary)", textDecoration: g.done ? "line-through" : "none" }}>{g.text}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* CLEP Bio Tracker */}
      <div style={{ background: "linear-gradient(180deg, var(--bg-card), rgba(12,15,26,0.85))", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 16, padding: 20, boxShadow: "0 8px 24px rgba(0,0,0,0.25), inset 0 1px 0 rgba(255,255,255,0.04)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <p style={{ fontSize: 13, fontWeight: 700 }}>📚 CLEP Bio Study Tracker</p>
          <span style={{ fontSize: 12, color: daysLeft < 14 ? "#f87171" : "var(--text-muted)" }}>{daysLeft} days until exam</span>
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
        <div style={{ background: "rgba(0,0,0,0.35)", borderRadius: 20, height: 12, overflow: "hidden", border: "1px solid rgba(255,255,255,0.05)" }}>
          <div style={{
            height: "100%", width: `${clepPct}%`,
            background: clepPct >= 100 ? "linear-gradient(90deg, #34d399, #22d3ee)" : "linear-gradient(90deg, #22d3ee, #a78bfa)",
            borderRadius: 20, transition: "width 0.4s ease",
            boxShadow: "0 0 12px rgba(34,211,238,0.5)",
          }} />
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6 }}>
          <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{clep.studied}h / {clep.target}h</span>
          <span style={{ fontSize: 11, fontWeight: 700, color: clepPct >= 100 ? "#4ade80" : "var(--accent)" }}>{clepPct}% complete</span>
        </div>
        {daysLeft > 0 && clep.studied < clep.target && (
          <p style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 8 }}>
            Need ~{Math.ceil((clep.target - clep.studied) / daysLeft * 10) / 10}h/day to hit your target by exam day.
          </p>
        )}
      </div>

      {/* Lead Follow-up Tracker */}
      {staleLeads.length > 0 && (
        <div style={{
          background: "radial-gradient(ellipse 90% 60% at 50% -20%, rgba(251,113,133,0.1), transparent 60%), linear-gradient(180deg, var(--bg-card), rgba(12,15,26,0.85))",
          border: "1px solid rgba(251,113,133,0.35)", borderRadius: 16, padding: 20,
          boxShadow: "0 8px 24px rgba(0,0,0,0.25), 0 0 24px rgba(251,113,133,0.06)",
        }}>
          <p style={{ fontSize: 13, fontWeight: 700, marginBottom: 4 }}>⚠️ Follow-up Needed</p>
          <p style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 14 }}>These leads haven't been touched in 3+ days</p>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {staleLeads.map((lead: any) => {
              const days = Math.floor((Date.now() - new Date(lead.dateAdded).getTime()) / 86400000);
              return (
                <div key={lead.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 14px", background: "var(--bg-hover)", borderRadius: 10, borderLeft: "3px solid #f87171" }}>
                  <div>
                    <p style={{ fontSize: 13, fontWeight: 600 }}>{lead.name || "—"}</p>
                    <p style={{ fontSize: 11, color: "var(--text-muted)" }}>{lead.email} {lead.tags?.slice(0, 1).map((t: string) => `· ${t}`).join("")}</p>
                  </div>
                  <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                    <span style={{ fontSize: 11, color: "#f87171", fontWeight: 700 }}>{days}d ago</span>
                    {data?.locationId && lead.id && (
                      <a href={`https://app.gohighlevel.com/v2/location/${data.locationId}/contacts/detail/${lead.id}`}
                        target="_blank" rel="noreferrer"
                        style={{ fontSize: 11, color: "var(--accent)", textDecoration: "none", background: "var(--accent-glow)", border: "1px solid var(--accent)", borderRadius: 6, padding: "3px 10px" }}>
                        GHL →
                      </a>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
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
