"use client";
import { useState, useEffect, useCallback } from "react";

const STATUSES = ["no-answer", "voicemail", "callback", "booked", "emailed", "not-interested", "closed"];

const STATUS_COLORS: Record<string, string> = {
  "new": "var(--accent)",
  "no-answer": "var(--orange)",
  "voicemail": "var(--orange)",
  "callback": "var(--accent-2)",
  "emailed": "var(--accent)",
  "booked": "var(--green)",
  "not-interested": "var(--muted, #6b7280)",
  "closed": "var(--muted, #6b7280)",
};

const TIER_LABELS: Record<number, string> = { 1: "Tier 1", 2: "Tier 2", 3: "Tier 3" };

export default function ColdCallBoard({ onSendToAI }: { onSendToAI: (ctx: string) => void }) {
  const [prospects, setProspects] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<string>("all");
  const [tierFilter, setTierFilter] = useState<number | 0>(0);
  const [search, setSearch] = useState("");
  const [logging, setLogging] = useState<number | null>(null);
  const [toast, setToast] = useState("");
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [session, setSession] = useState(false);
  const [sessionIdx, setSessionIdx] = useState(0);
  const [sessionQueue, setSessionQueue] = useState<number[]>([]);
  const [sessionStats, setSessionStats] = useState({ dials: 0, booked: 0 });

  const load = useCallback(() => {
    fetch("/api/prospects")
      .then(r => r.json())
      .then(d => { setProspects(d.prospects ?? []); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  function showToast(msg: string) { setToast(msg); setTimeout(() => setToast(""), 3000); }

  async function logCall(id: number, status: string, notes?: string) {
    setLogging(id);
    const res = await fetch("/api/prospects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, status, notes }),
    });
    setLogging(null);
    if (res.ok) {
      setProspects(prev => prev.map(p => p.id === id ? { ...p, status } : p));
      showToast(`#${id} → ${status}`);
    } else {
      showToast("Failed to log call");
    }
  }

  // "enriching" = staging: scraped but not yet verified/enriched -- hidden until promoted to "new"
  const active = prospects.filter(p => p.status !== "closed" && p.status !== "enriching");
  const enriching = prospects.filter(p => p.status === "enriching").length;
  const counts: Record<string, number> = {};
  prospects.forEach(p => { const s = p.status || "new"; counts[s] = (counts[s] ?? 0) + 1; });

  const fresh = counts["new"] ?? 0;
  const booked = counts["booked"] ?? 0;
  const followup = (counts["no-answer"] ?? 0) + (counts["voicemail"] ?? 0) + (counts["callback"] ?? 0);
  const dialed = prospects.length - fresh - (counts["closed"] ?? 0);

  const STAT_CARDS = [
    { label: "Active Leads", value: active.length, color: "var(--accent)" },
    { label: "Not Yet Called", value: fresh, color: "var(--accent)" },
    { label: "Follow-Up Queue", value: followup, color: "var(--orange)" },
    { label: "Booked", value: booked, color: "var(--green)" },
    { label: "Dialed", value: dialed, color: "var(--accent-2)" },
  ];

  const filtered = active.filter(p => {
    if (filter === "followup" && !["no-answer", "voicemail", "callback"].includes(p.status)) return false;
    else if (filter !== "all" && filter !== "followup" && (p.status || "new") !== filter) return false;
    if (tierFilter && p.tier !== tierFilter) return false;
    if (search && !`${p.name} ${p.city}`.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  const projected3 = Math.round(active.length * 0.03) * 2000;
  const projected5 = Math.round(active.length * 0.05) * 2000;

  function startSession() {
    // Snapshot the queue at start: callbacks first, then fresh leads in tier order
    const ids = [
      ...active.filter(p => p.status === "callback"),
      ...active.filter(p => (p.status || "new") === "new"),
    ].map(p => p.id);
    if (ids.length === 0) return;
    setSessionQueue(ids);
    setSessionIdx(0);
    setSessionStats({ dials: 0, booked: 0 });
    setSession(true);
  }

  const current = session ? prospects.find(p => p.id === sessionQueue[sessionIdx]) : null;

  async function sessionLog(status: string) {
    if (!current) return;
    await logCall(current.id, status);
    setSessionStats(s => ({ dials: s.dials + 1, booked: s.booked + (status === "booked" ? 1 : 0) }));
    if (sessionIdx + 1 >= sessionQueue.length) setSession(false);
    else setSessionIdx(i => i + 1);
  }

  function sessionSkip() {
    if (sessionIdx + 1 >= sessionQueue.length) setSession(false);
    else setSessionIdx(i => i + 1);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      {toast && <div style={{ position: "fixed", bottom: 24, right: 24, background: "var(--green)", color: "var(--on-accent, #07080f)", padding: "10px 18px", borderRadius: 10, fontWeight: 700, fontSize: 13, zIndex: 200 }}>{toast}</div>}

      {/* Call Session Mode — full screen */}
      {session && current && (
        <div style={{ position: "fixed", inset: 0, zIndex: 300, background: "var(--bg-primary)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 24 }}>
          <div style={{ position: "absolute", top: 20, left: 24, right: 24, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontSize: 12, color: "var(--text-muted)", fontWeight: 600 }}>
              Call {sessionIdx + 1} of {sessionQueue.length} · {sessionStats.dials} logged · {sessionStats.booked} booked
            </span>
            <button onClick={() => setSession(false)} style={{ background: "transparent", border: "1px solid var(--border)", borderRadius: 8, color: "var(--text-muted)", cursor: "pointer", fontSize: 12, padding: "6px 14px" }}>
              End Session ✕
            </button>
          </div>

          <div style={{ maxWidth: 640, width: "100%", display: "flex", flexDirection: "column", gap: 20, textAlign: "center" }}>
            <div>
              <p style={{ fontSize: 12, color: current.status === "callback" ? "var(--accent-2)" : "var(--text-muted)", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8 }}>
                {current.status === "callback" ? "⏰ Scheduled callback" : `Tier ${current.tier} · ${current.google_reviews ?? "~"} reviews${current.google_rating ? ` · ${current.google_rating}★` : ""}`}
              </p>
              <h1 style={{ fontSize: 34, fontWeight: 800, fontFamily: "'Space Grotesk', sans-serif", lineHeight: 1.15 }}>{current.name}</h1>
              <p style={{ fontSize: 14, color: "var(--text-muted)", marginTop: 6 }}>
                {current.city}{current.owner_name ? ` · Ask for ${current.owner_name}` : ""}
              </p>
              {current.phone && (
                <a href={`tel:${current.phone}`} style={{ display: "inline-block", marginTop: 14, fontSize: 28, fontWeight: 800, color: "var(--accent)", textDecoration: "none", fontFamily: "'Space Grotesk', sans-serif", textShadow: "0 0 24px rgba(96,165,250,0.4)" }}>
                  {current.phone}
                </a>
              )}
              <div style={{ marginTop: 10 }}>
                <a href={`/api/audit?name=${encodeURIComponent(current.name)}`} target="_blank" rel="noreferrer"
                  style={{
                    display: "inline-block", padding: "8px 22px", borderRadius: 999, fontSize: 12.5, fontWeight: 700,
                    background: "rgba(34,211,238,0.08)", border: "1px solid rgba(34,211,238,0.4)",
                    color: "var(--accent)", textDecoration: "none",
                  }}>
                  📄 View Audit PDF
                </a>
              </div>
            </div>

            {current.call_hook && (
              <div style={{
                background: "linear-gradient(120deg, rgba(34,211,238,0.08), rgba(167,139,250,0.06))",
                border: "1px solid rgba(34,211,238,0.25)", borderRadius: 16, padding: "20px 24px",
                fontSize: 16, lineHeight: 1.7, color: "var(--text-primary)", textAlign: "left",
              }}>
                <span style={{ color: "var(--accent)", fontWeight: 700, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.08em", display: "block", marginBottom: 8 }}>The hook</span>
                {current.call_hook}
              </div>
            )}
            {current.call_notes && (
              <p style={{ fontSize: 12, color: "var(--text-muted)", textAlign: "left", whiteSpace: "pre-wrap" }}>{current.call_notes.split("\n").slice(-2).join("\n")}</p>
            )}

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: 10, marginTop: 6 }}>
              {[
                { s: "no-answer", label: "No Answer", c: "var(--orange)" },
                { s: "voicemail", label: "Voicemail", c: "var(--orange)" },
                { s: "callback", label: "Callback", c: "var(--accent-2)" },
                { s: "booked", label: "Booked 🎯", c: "var(--green)" },
                { s: "not-interested", label: "Not Interested", c: "var(--muted, #6b7280)" },
              ].map(b => (
                <button key={b.s} onClick={() => sessionLog(b.s)} disabled={logging !== null} style={{
                  padding: "16px 0", borderRadius: 14, fontSize: 14, fontWeight: 700, cursor: "pointer",
                  background: `${b.c}14`, border: `1px solid ${b.c}55`, color: b.c,
                  opacity: logging !== null ? 0.5 : 1,
                }}>{b.label}</button>
              ))}
            </div>
            <button onClick={sessionSkip} style={{ background: "transparent", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 13 }}>
              Skip without logging →
            </button>
          </div>
        </div>
      )}

      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
        <div>
          <h2 style={{ fontSize: 16, fontWeight: 700 }}>Roofing Cold Call Campaign</h2>
          <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2 }}>
            Live from prospects.db · {prospects.length} total records{enriching > 0 ? ` · ${enriching} in enrichment (hidden)` : ""} · logs write back to the call sheet
          </p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={startSession} disabled={loading} style={{
            padding: "8px 20px", borderRadius: 999, fontSize: 12.5, cursor: "pointer", fontWeight: 700,
            border: "none", background: "linear-gradient(135deg, var(--green-bright, #34d399), var(--cyan, #22d3ee))",
            color: "var(--on-accent, #07080f)", boxShadow: "0 4px 16px rgba(52,211,153,0.3)",
          }}>
            ▶ Start Call Session
          </button>
          <button onClick={load} disabled={loading} style={{
            padding: "6px 14px", borderRadius: 8, fontSize: 12, cursor: "pointer",
            border: "1px solid var(--border)", background: "var(--bg-card)",
            color: "var(--text-muted)", opacity: loading ? 0.5 : 1,
          }}>
            {loading ? "Syncing..." : "⟳ Refresh"}
          </button>
        </div>
      </div>

      {/* Stat cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12 }}>
        {STAT_CARDS.map(s => (
          <div key={s.label} style={{
            background: `radial-gradient(ellipse 90% 80% at 50% -30%, ${s.color}14, transparent 60%), linear-gradient(180deg, var(--bg-card), var(--bg-card))`,
            border: "1px solid var(--border)", borderRadius: 14, padding: "14px 18px",
            boxShadow: "0 8px 24px rgba(0,0,0,0.25), inset 0 1px 0 rgba(255,255,255,0.04)",
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
              <span style={{ width: 5, height: 5, borderRadius: "50%", background: s.color, boxShadow: `0 0 7px ${s.color}` }} />
              <p style={{ fontSize: 10.5, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 600 }}>{s.label}</p>
            </div>
            <p style={{ fontSize: 24, fontWeight: 800, color: s.color, fontFamily: "'Space Grotesk', sans-serif", textShadow: `0 0 18px ${s.color}44`, lineHeight: 1 }}>{loading ? "..." : s.value}</p>
          </div>
        ))}
      </div>

      {/* Revenue math banner */}
      {!loading && (
        <div style={{
          background: "linear-gradient(120deg, rgba(52,211,153,0.08), rgba(34,211,238,0.06) 60%, transparent)",
          border: "1px solid rgba(52,211,153,0.25)", borderRadius: 14, padding: "13px 18px",
          fontSize: 12.5, color: "var(--text-secondary)", display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center",
        }}>
          <span style={{ fontWeight: 700, color: "var(--green)" }}>The math:</span>
          <span>{active.length} leads × 3% close = <b style={{ color: "var(--green)" }}>${projected3.toLocaleString()}/mo recurring</b></span>
          <span style={{ opacity: 0.6 }}>·</span>
          <span>at 5% it&apos;s <b style={{ color: "var(--green)" }}>${projected5.toLocaleString()}/mo</b></span>
          <button onClick={() => onSendToAI(`My roofing cold call campaign: ${active.length} active leads, ${fresh} not yet called, ${followup} in follow-up, ${booked} booked. Price point $2,000/mo. What should I focus on in today's call session?`)}
            style={{ marginLeft: "auto", fontSize: 11.5, fontWeight: 600, color: "var(--claude-orange, #E8692A)", background: "transparent", border: "none", cursor: "pointer" }}>
            ✦ Ask Claude →
          </button>
        </div>
      )}

      {/* Filters */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search company or city..."
          style={{ background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 8, padding: "7px 12px", color: "var(--text-primary)", fontSize: 12, outline: "none", width: 200 }} />
        {[
          { id: "all", label: `All (${active.length})` },
          { id: "new", label: `Fresh (${fresh})` },
          { id: "followup", label: `Follow-up (${followup})` },
          { id: "booked", label: `Booked (${booked})` },
        ].map(f => (
          <button key={f.id} onClick={() => setFilter(f.id)} style={{
            padding: "6px 14px", borderRadius: 999, fontSize: 11.5, cursor: "pointer", fontWeight: 600,
            border: filter === f.id ? "1px solid var(--accent)" : "1px solid var(--border)",
            background: filter === f.id ? "var(--accent-glow)" : "transparent",
            color: filter === f.id ? "var(--accent)" : "var(--text-muted)",
          }}>{f.label}</button>
        ))}
        <select value={tierFilter} onChange={e => setTierFilter(Number(e.target.value))}
          style={{ background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 8, padding: "6px 10px", color: "var(--text-secondary)", fontSize: 12, cursor: "pointer" }}>
          <option value={0}>All tiers</option>
          <option value={1}>Tier 1</option>
          <option value={2}>Tier 2</option>
          <option value={3}>Tier 3</option>
        </select>
      </div>

      {/* Lead list */}
      {loading ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }} aria-label="Loading prospects">
          {[0, 1, 2, 3, 4, 5].map(i => <div key={i} className="skel" style={{ height: 52, borderRadius: 12 }} />)}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {filtered.slice(0, 60).map(p => {
            const sc = STATUS_COLORS[p.status || "new"] ?? "var(--muted, #6b7280)";
            const expanded = expandedId === p.id;
            return (
              <div key={p.id} style={{
                background: "linear-gradient(180deg, var(--bg-card), var(--bg-card))",
                border: "1px solid var(--border)",
                borderLeft: `3px solid ${sc}`,
                borderRadius: 12, padding: "12px 16px",
                opacity: logging === p.id ? 0.4 : 1, transition: "opacity 0.15s",
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 11, color: "var(--text-muted)", fontWeight: 600, width: 30 }}>#{p.id}</span>
                  <div style={{ flex: 1, minWidth: 160, cursor: "pointer" }} onClick={() => setExpandedId(expanded ? null : p.id)}>
                    <p style={{ fontSize: 13.5, fontWeight: 700 }}>{p.name}</p>
                    <p style={{ fontSize: 11, color: "var(--text-muted)" }}>
                      {p.city} · {p.google_reviews ?? "~"} reviews{p.google_rating ? ` · ${p.google_rating}★` : ""} · {TIER_LABELS[p.tier] ?? `Tier ${p.tier}`}
                      {p.owner_name ? ` · ${p.owner_name}` : ""}
                    </p>
                  </div>
                  {p.phone && (
                    <a href={`tel:${p.phone}`} style={{ fontSize: 12.5, color: "var(--accent)", fontWeight: 700, textDecoration: "none", whiteSpace: "nowrap" }}>{p.phone}</a>
                  )}
                  <span style={{ background: sc + "1e", color: sc, fontSize: 10.5, fontWeight: 700, padding: "3px 10px", borderRadius: 999, border: `1px solid ${sc}44`, whiteSpace: "nowrap" }}>
                    {p.status || "new"}
                  </span>
                  <select value="" onChange={e => { if (e.target.value) logCall(p.id, e.target.value); }}
                    style={{ background: "rgba(0,0,0,0.3)", border: "1px solid var(--border)", borderRadius: 8, padding: "5px 8px", color: "var(--text-secondary)", fontSize: 11, cursor: "pointer" }}>
                    <option value="">Log call...</option>
                    {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
                {expanded && (
                  <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--border)" }}>
                    {p.call_hook && (
                      <p style={{ fontSize: 12.5, color: "var(--text-secondary)", lineHeight: 1.6, marginBottom: 8 }}>
                        <span style={{ color: "var(--accent)", fontWeight: 700 }}>Hook: </span>{p.call_hook}
                      </p>
                    )}
                    {p.bbb_rating && (
                      <p style={{ fontSize: 11.5, color: "var(--text-muted)", marginBottom: 8 }}>
                        BBB: {p.bbb_rating}{p.bbb_complaints ? ` · ⚠ ${p.bbb_complaints} complaints` : ""}
                      </p>
                    )}
                    {p.call_notes && (
                      <pre style={{ fontSize: 11, color: "var(--text-muted)", whiteSpace: "pre-wrap", fontFamily: "inherit", background: "rgba(0,0,0,0.25)", borderRadius: 8, padding: "8px 12px", marginBottom: 8 }}>{p.call_notes}</pre>
                    )}
                    <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
                      <button onClick={() => onSendToAI(`Roofing prospect from my cold call list:\nCompany: ${p.name} (${p.city})\nReviews: ${p.google_reviews ?? "unknown"} at ${p.google_rating ?? "?"}★\nStatus: ${p.status || "new"}\nHook: ${p.call_hook ?? "none"}\nNotes: ${p.call_notes ?? "none"}\n\nCoach me on the best angle for this call.`)}
                        style={{ fontSize: 11, color: "var(--claude-orange, #E8692A)", background: "transparent", border: "none", cursor: "pointer", padding: 0, fontWeight: 600 }}>
                        ✦ Ask Claude to coach this call →
                      </button>
                      <a href={`/api/audit?name=${encodeURIComponent(p.name)}`} target="_blank" rel="noreferrer"
                        style={{ fontSize: 11, color: "var(--accent)", textDecoration: "none", fontWeight: 600 }}>
                        📄 View audit PDF →
                      </a>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
          {filtered.length > 60 && (
            <p style={{ fontSize: 11.5, color: "var(--text-muted)", textAlign: "center", padding: "8px 0" }}>
              Showing 60 of {filtered.length} — narrow with search or filters
            </p>
          )}
          {filtered.length === 0 && (
            <p style={{ color: "var(--text-muted)", fontSize: 13, textAlign: "center", padding: "24px 0" }}>No leads match this filter</p>
          )}
        </div>
      )}
    </div>
  );
}
