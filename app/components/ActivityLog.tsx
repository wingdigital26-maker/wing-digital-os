"use client";
import { useState, useEffect } from "react";

interface LogEvent {
  id: string;
  type: "lead" | "appointment" | "ai_claude" | "ai_hermes" | "vault" | "pipeline" | "coldcall";
  title: string;
  detail: string;
  time: Date;
}

const TYPE_META: Record<LogEvent["type"], { icon: string; color: string; label: string }> = {
  lead:        { icon: "👤", color: "var(--green)", label: "New Lead" },
  appointment: { icon: "📅", color: "var(--accent)", label: "Appointment" },
  ai_claude:   { icon: "🟠", color: "#E8692A", label: "Claude" },
  ai_hermes:   { icon: "⚙️", color: "#6b7280", label: "Groq" },
  vault:       { icon: "📄", color: "var(--accent)", label: "Vault" },
  pipeline:    { icon: "🎯", color: "var(--orange)", label: "Pipeline" },
  coldcall:    { icon: "📞", color: "var(--accent-2)", label: "Cold Call" },
};

function relativeTime(date: Date): string {
  const diff = Math.floor((Date.now() - date.getTime()) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function loadAiEvents(): LogEvent[] {
  if (typeof window === "undefined") return [];
  const raw = localStorage.getItem("wingos_activity");
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return parsed.map((e: any) => ({ ...e, time: new Date(e.time) }));
  } catch { return []; }
}

export function logAiEvent(type: "ai_claude" | "ai_hermes", userMsg: string, reply: string) {
  if (typeof window === "undefined") return;
  const events: any[] = JSON.parse(localStorage.getItem("wingos_activity") ?? "[]");
  events.unshift({
    id: `${Date.now()}`,
    type,
    title: userMsg.slice(0, 60) + (userMsg.length > 60 ? "..." : ""),
    detail: reply.slice(0, 100) + (reply.length > 100 ? "..." : ""),
    time: new Date().toISOString(),
  });
  // Keep last 50 events
  localStorage.setItem("wingos_activity", JSON.stringify(events.slice(0, 50)));
}

export function logVaultEvent(action: string, path: string) {
  if (typeof window === "undefined") return;
  const events: any[] = JSON.parse(localStorage.getItem("wingos_activity") ?? "[]");
  events.unshift({
    id: `${Date.now()}`,
    type: "vault",
    title: action,
    detail: path,
    time: new Date().toISOString(),
  });
  localStorage.setItem("wingos_activity", JSON.stringify(events.slice(0, 50)));
}

// lead / appointment / pipeline chips removed: those events came from GHL,
// which was retired 2026-08-22 with no replacement CRM connected yet.
const FILTER_OPTIONS = ["ai_claude", "ai_hermes", "vault", "coldcall"] as const;
const DATE_RANGES = ["today", "week", "month", "all_time"] as const;
type DateRange = typeof DATE_RANGES[number];

function dateRangeLabel(r: DateRange) {
  return { today: "Today", week: "This Week", month: "This Month", all_time: "All Time" }[r];
}

function inRange(date: Date, range: DateRange): boolean {
  const now = new Date();
  if (range === "today") return isToday(date);
  if (range === "week") {
    const weekStart = new Date(now); weekStart.setDate(now.getDate() - now.getDay()); weekStart.setHours(0,0,0,0);
    return date >= weekStart;
  }
  if (range === "month") {
    return date.getMonth() === now.getMonth() && date.getFullYear() === now.getFullYear();
  }
  return true;
}

export default function ActivityLog() {
  const [sourceEvents, setSourceEvents] = useState<LogEvent[]>([]);
  const [aiEvents, setAiEvents] = useState<LogEvent[]>([]);
  const [filter, setFilter] = useState<LogEvent["type"] | null>(null);
  const [dateRange, setDateRange] = useState<DateRange>("week");
  const [refreshing, setRefreshing] = useState(false);

  // No CRM event source: GHL was retired 2026-08-22 (this used to fetch
  // /api/ghl for leads, appointments, and pipeline moves) and no replacement
  // is connected yet. Cold call activity still comes from prospects.db.
  async function fetchEvents() {
    setRefreshing(true);
    try {
      const events: LogEvent[] = [];

      // Cold call activity from prospects.db
      try {
        const pRes = await fetch("/api/prospects");
        const pData = await pRes.json();
        (pData.prospects ?? [])
          .filter((p: any) => p.status && p.status !== "new" && p.status !== "enriching" && p.updated_at)
          .slice(0, 30)
          .forEach((p: any) => {
            const lastNote = (p.call_notes ?? "").trim().split("\n").pop() ?? "";
            events.push({
              id: `coldcall-${p.id}`,
              type: "coldcall",
              title: `${p.name} → ${p.status}`,
              detail: lastNote || `${p.city ?? ""}`,
              time: new Date(p.updated_at),
            });
          });
      } catch { }

      setSourceEvents(events);
    } catch { }
    setRefreshing(false);
  }

  useEffect(() => {
    fetchEvents();
    setAiEvents(loadAiEvents());
    const id = setInterval(() => setAiEvents(loadAiEvents()), 5000);
    return () => clearInterval(id);
  }, []);

  const all: LogEvent[] = [...sourceEvents, ...aiEvents]
    .sort((a, b) => b.time.getTime() - a.time.getTime());

  const filtered = all
    .filter(e => filter === null || e.type === filter)
    .filter(e => inRange(e.time, dateRange));

  // Group by day
  const grouped: { label: string; events: LogEvent[] }[] = [];
  for (const event of filtered) {
    const label = isToday(event.time) ? "Today" : isYesterday(event.time)
      ? "Yesterday"
      : event.time.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
    const last = grouped[grouped.length - 1];
    if (last?.label === label) { last.events.push(event); }
    else { grouped.push({ label, events: [event] }); }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20, maxWidth: 760 }}>

      {/* Header + controls */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
        <div>
          <h2 style={{ fontSize: 16, fontWeight: 700 }}>Activity Log</h2>
          <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2 }}>
            {all.length} events across AI agents, vault, and cold calls. No CRM event source connected (GHL retired, replacement pending).
          </p>
        </div>
        <button onClick={fetchEvents} disabled={refreshing} style={{
          background: "var(--bg-card)", border: "1px solid var(--border)",
          borderRadius: 8, padding: "7px 14px", fontSize: 12, color: "var(--text-muted)", cursor: "pointer",
          opacity: refreshing ? 0.5 : 1,
        }}>
          {refreshing ? "Refreshing..." : "↺ Refresh"}
        </button>
      </div>

      {/* Filters row */}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {/* Type chips */}
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {FILTER_OPTIONS.map(f => {
            const c = TYPE_META[f as LogEvent["type"]]?.color ?? "var(--accent)";
            const on = filter === f;
            return (
              <button key={f} onClick={() => setFilter(prev => prev === f ? null : f as LogEvent["type"])} style={{
                padding: "5px 14px", borderRadius: 999, fontSize: 12, cursor: "pointer",
                border: `1px solid ${on ? c : "rgba(255,255,255,0.09)"}`,
                background: on ? `${c}18` : "rgba(255,255,255,0.03)",
                color: on ? c : "var(--text-muted)",
                fontWeight: on ? 700 : 500,
                boxShadow: on ? `0 0 12px ${c}22` : "none",
              }}>
                {TYPE_META[f as LogEvent["type"]]?.label ?? f}
              </button>
            );
          })}
        </div>
        {/* Date range */}
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <span style={{ fontSize: 11, color: "var(--text-muted)", marginRight: 2 }}>Range:</span>
          {DATE_RANGES.map(r => (
            <button key={r} onClick={() => setDateRange(r)} style={{
              padding: "4px 12px", borderRadius: 999, fontSize: 11, cursor: "pointer",
              border: `1px solid ${dateRange === r ? "rgba(96,165,250,0.5)" : "rgba(255,255,255,0.09)"}`,
              background: dateRange === r ? "rgba(96,165,250,0.12)" : "rgba(255,255,255,0.03)",
              color: dateRange === r ? "var(--accent)" : "var(--text-muted)",
              fontWeight: dateRange === r ? 700 : 500,
            }}>
              {dateRangeLabel(r)}
            </button>
          ))}
        </div>
      </div>

      {/* Timeline */}
      {grouped.length === 0 ? (
        <div style={{ padding: "48px 0", textAlign: "center", color: "var(--text-muted)" }}>
          <p style={{ fontSize: 32, marginBottom: 8 }}>📋</p>
          <p>No CRM event source connected. GHL retired, replacement pending. AI chats, vault edits, and cold call activity will appear here.</p>
        </div>
      ) : grouped.map(group => (
        <div key={group.label}>
          <p style={{
            fontSize: 11, fontWeight: 700, color: "var(--text-muted)",
            textTransform: "uppercase", letterSpacing: "0.08em",
            marginBottom: 10, paddingBottom: 6, borderBottom: "1px solid var(--border)",
          }}>
            {group.label}
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            {group.events.map(event => {
              const meta = TYPE_META[event.type];
              return (
                <div key={event.id} style={{
                  display: "flex", alignItems: "flex-start", gap: 12,
                  padding: "11px 15px", borderRadius: 12,
                  background: `linear-gradient(90deg, ${meta.color}08, transparent 25%), rgba(255,255,255,0.03)`,
                  border: "1px solid var(--border)",
                  borderLeft: `3px solid ${meta.color}`,
                }}>
                  <span style={{
                    fontSize: 15, flexShrink: 0, width: 32, height: 32,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    background: `${meta.color}14`, border: `1px solid ${meta.color}33`,
                    borderRadius: 10,
                  }}>{meta.icon}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                      <p style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {event.title}
                      </p>
                      <span style={{ fontSize: 11, color: "var(--text-muted)", flexShrink: 0 }}>
                        {relativeTime(event.time)}
                      </span>
                    </div>
                    {event.detail && (
                      <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {event.detail}
                      </p>
                    )}
                    <span style={{ fontSize: 10, color: meta.color, fontWeight: 600, marginTop: 2, display: "inline-block" }}>
                      {meta.label}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

function isToday(d: Date) {
  const now = new Date();
  return d.getDate() === now.getDate() && d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
}
function isYesterday(d: Date) {
  const y = new Date(); y.setDate(y.getDate() - 1);
  return d.getDate() === y.getDate() && d.getMonth() === y.getMonth() && d.getFullYear() === y.getFullYear();
}
