"use client";
import { useEffect, useState } from "react";
import { ClientHealthSlideOver, MissionStyles } from "./MissionControlCore";
import { sfx } from "../lib/sounds";

const INDUSTRY_ICON: Record<string, string> = {
  roofing: "🏠", "roofing / exteriors": "🏠", paving: "🛣️", electrical: "⚡",
  "home improvement": "🔨", "food & beverage": "🍽️", "pool service": "🏊", cafe: "☕",
};

export default function ClientsBoard() {
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState("");
  const [showPipeline, setShowPipeline] = useState(false);
  const [ghlSnaps, setGhlSnaps] = useState<Record<string, any>>({});
  // Clicking a client card opens the same health slide-over used in Mission
  // Control (overall status, 5 pillars, flags, live site). The card content
  // (GHL stats, contact links) stays visible behind the panel.
  const [healthClient, setHealthClient] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/clients")
      .then(r => r.json())
      .then(d => (d.error ? setErr(d.error) : setData(d)))
      .catch(e => setErr(String(e)));
  }, []);

  // Live GHL snapshot per paying client that has a linked sub-account
  useEffect(() => {
    const payers = (data?.clients ?? []).filter((c: any) => c.mrr && c.ghlLocationId);
    payers.forEach((c: any) => {
      const slug = c.file.replace(/\.md$/, "");
      fetch(`/api/clients/ghl?slug=${encodeURIComponent(slug)}&loc=${encodeURIComponent(c.ghlLocationId)}`)
        .then(r => r.json())
        .then(snap => { if (snap.available) setGhlSnaps(prev => ({ ...prev, [c.file]: snap })); })
        .catch(() => {});
    });
  }, [data]);

  if (err) return <p style={{ color: "var(--red)", fontSize: 13 }}>Clients error: {err}</p>;
  if (!data) return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }} aria-label="Loading clients">
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12 }}>
        {[0, 1, 2].map(i => <div key={i} className="skel" style={{ height: 84, borderRadius: 14 }} />)}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 12 }}>
        {[0, 1].map(i => <div key={i} className="skel" style={{ height: 150, borderRadius: 14 }} />)}
      </div>
    </div>
  );

  const all = [...data.clients].sort((a: any, b: any) => (b.mrr ?? 0) - (a.mrr ?? 0));
  // Active = actually paying. Everyone else is pipeline / onboarding, not an active client.
  const paying = all.filter((c: any) => c.mrr && c.mrr > 0);
  const pipeline = all.filter((c: any) => !c.mrr || c.mrr <= 0);
  const payingMrr = paying.reduce((s: number, c: any) => s + (c.mrr ?? 0), 0);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      {/* Summary */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12 }}>
        {[
          { label: "Active clients", v: paying.length, c: "var(--green)" },
          { label: "Monthly recurring", v: `$${payingMrr.toLocaleString()}`, c: "var(--accent)" },
          { label: "In pipeline", v: pipeline.length, c: "var(--orange)" },
        ].map(s => (
          <div key={s.label} style={{
            background: `radial-gradient(ellipse 90% 70% at 50% -20%, ${s.c}14, transparent 60%), linear-gradient(180deg, var(--bg-card), rgba(12,15,26,0.85))`,
            border: "1px solid var(--border)", borderRadius: 14, padding: "14px 18px",
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
              <span style={{ width: 6, height: 6, borderRadius: "50%", background: s.c, boxShadow: `0 0 8px ${s.c}` }} />
              <p style={{ fontSize: 10.5, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 600 }}>{s.label}</p>
            </div>
            <p style={{ fontSize: 26, fontWeight: 800, color: s.c, fontFamily: "'Space Grotesk', sans-serif", lineHeight: 1 }}>{s.v}</p>
          </div>
        ))}
      </div>

      {/* Active (paying) clients */}
      <p style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em" }}>
        Active Clients
      </p>
      {paying.length === 0 && (
        <p style={{ fontSize: 13, color: "var(--text-muted)" }}>No paying clients yet.</p>
      )}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 12 }}>
        {paying.map((c: any) => {
          const icon = INDUSTRY_ICON[(c.industry || "").toLowerCase()] ?? "🏢";
          return (
            <div key={c.file}
              onClick={() => { sfx.play("blip"); setHealthClient(c.name); }}
              title="Click for client health"
              style={{
                background: "radial-gradient(ellipse 90% 70% at 50% -20%, rgba(52,211,153,0.12), transparent 60%), linear-gradient(180deg, var(--bg-card), rgba(12,15,26,0.85))",
                border: "1px solid rgba(52,211,153,0.35)",
                borderRadius: 14, padding: "16px 18px", cursor: "pointer",
              }}>
              <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
                <div style={{ display: "flex", gap: 10, alignItems: "center", minWidth: 0 }}>
                  <span style={{ fontSize: 20 }}>{icon}</span>
                  <div style={{ minWidth: 0 }}>
                    <p style={{ fontSize: 14, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.name}</p>
                    <p style={{ fontSize: 11.5, color: "var(--text-muted)" }}>{c.owner || c.industry}</p>
                  </div>
                </div>
                <span style={{ fontSize: 15, fontWeight: 800, color: "var(--green)", whiteSpace: "nowrap" }}>
                  ${c.mrr.toLocaleString()}<span style={{ fontSize: 10, fontWeight: 500, opacity: 0.7 }}>/mo</span>
                </span>
              </div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 10 }}>
                {c.industry && (
                  <span style={{ fontSize: 10, fontWeight: 600, color: "var(--accent)", background: "rgba(96,165,250,0.1)", padding: "2px 9px", borderRadius: 999 }}>{c.industry}</span>
                )}
                {c.location && (
                  <span style={{ fontSize: 10, fontWeight: 600, color: "var(--text-muted)", background: "rgba(255,255,255,0.05)", padding: "2px 9px", borderRadius: 999 }}>{c.location}</span>
                )}
                <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 9px", borderRadius: 999, color: "var(--green)", background: "rgba(52,211,153,0.1)" }}>active</span>
              </div>
              {ghlSnaps[c.file] && (
                <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginTop: 12, paddingTop: 10, borderTop: "1px solid var(--border)" }}>
                  {[
                    { l: "contacts", v: ghlSnaps[c.file].contacts },
                    { l: "open deals", v: ghlSnaps[c.file].openDeals },
                    { l: "appts 30d", v: ghlSnaps[c.file].upcomingAppts },
                    { l: "convos", v: ghlSnaps[c.file].conversations },
                  ].map(s => (
                    <div key={s.l}>
                      <p style={{ fontSize: 16, fontWeight: 800, color: "var(--accent)", fontFamily: "'Space Grotesk', sans-serif", lineHeight: 1 }}>{s.v}</p>
                      <p style={{ fontSize: 9.5, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.05em", marginTop: 3 }}>{s.l}</p>
                    </div>
                  ))}
                  <span style={{ marginLeft: "auto", alignSelf: "flex-start", fontSize: 9, fontWeight: 600, color: "var(--accent)", background: "rgba(34,211,238,0.1)", padding: "2px 8px", borderRadius: 999 }}>● live GHL</span>
                </div>
              )}
              {(c.email || c.phone || c.ghlLocationId) && (
                <div style={{ borderTop: "1px solid var(--border)", marginTop: 12, paddingTop: 10, display: "flex", flexDirection: "column", gap: 4 }}>
                  {c.email && <a href={`mailto:${c.email}`} onClick={(e) => e.stopPropagation()} style={{ fontSize: 11.5, color: "var(--text-secondary)", textDecoration: "none", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>✉ {c.email}</a>}
                  {c.phone && <a href={`tel:${c.phone.replace(/\D/g, "")}`} onClick={(e) => e.stopPropagation()} style={{ fontSize: 11.5, color: "var(--text-secondary)", textDecoration: "none" }}>☎ {c.phone}</a>}
                  {c.ghlLocationId && (
                    <a href={`https://app.gohighlevel.com/v2/location/${c.ghlLocationId}/`} target="_blank" rel="noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      style={{
                        marginTop: 6, display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6,
                        fontSize: 11.5, fontWeight: 700, color: "#07080f", textDecoration: "none",
                        background: "linear-gradient(135deg, #34d399, #22d3ee)", padding: "8px 14px", borderRadius: 8,
                      }}>
                      Open GHL account →
                    </a>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Pipeline (not yet paying) — collapsed by default */}
      {pipeline.length > 0 && (
        <div>
          <button onClick={() => setShowPipeline(v => !v)} style={{
            display: "flex", alignItems: "center", gap: 8, background: "none", border: "none", cursor: "pointer",
            fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em", padding: 0,
          }}>
            Pipeline · not yet paying ({pipeline.length}) <span>{showPipeline ? "▲" : "▼"}</span>
          </button>
          {showPipeline && (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 10, marginTop: 12, opacity: 0.75 }}>
              {pipeline.map((c: any) => {
                const icon = INDUSTRY_ICON[(c.industry || "").toLowerCase()] ?? "🏢";
                return (
                  <div key={c.file}
                    onClick={() => { sfx.play("blip"); setHealthClient(c.name); }}
                    title="Click for client health"
                    style={{
                      background: "linear-gradient(180deg, var(--bg-card), rgba(12,15,26,0.85))",
                      border: "1px solid var(--border)", borderRadius: 12, padding: "12px 14px", cursor: "pointer",
                    }}>
                    <div style={{ display: "flex", gap: 9, alignItems: "center", minWidth: 0 }}>
                      <span style={{ fontSize: 16 }}>{icon}</span>
                      <div style={{ minWidth: 0 }}>
                        <p style={{ fontSize: 13, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.name}</p>
                        <p style={{ fontSize: 11, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.owner || c.industry}</p>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {healthClient && (
        <>
          <MissionStyles />
          <ClientHealthSlideOver clientName={healthClient} onClose={() => setHealthClient(null)} />
        </>
      )}
    </div>
  );
}
