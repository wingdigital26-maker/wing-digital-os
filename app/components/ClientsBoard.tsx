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

  // Contacts and deals live in the OS CRM (crm_contacts, crm_deals). There is
  // no per-client filter on that view yet, so each card links there generically
  // instead of showing a count it cannot vouch for.

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
  const paying = all.filter((c: any) => c.revenue?.countsTowardMrr);
  // Roster clients only. `all` is every markdown page in wiki/clients/, most of
  // which are prospects, reports and playbooks — listing those here rendered
  // "37", the exact number that used to make the OS claim 37 clients when there
  // were 4. A page the roster does not recognise is not shown as a client at all.
  const notPaying = all.filter(
    (c: any) => c.isClient !== false && !c.revenue?.countsTowardMrr
  );
  // MRR and the client count come straight from the API, which gets them from
  // lib/revenue.ts. This component used to re-sum the rows itself, which is how
  // a screen ends up quietly disagreeing with the tile next to it — so there is
  // deliberately no arithmetic here any more.
  const payingMrr = data.mrr ?? 0;
  const activeCount = data.activeClients ?? paying.length;
  const pipelineTotal = data.pipelineTotal ?? 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      {/* Summary */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12 }}>
        {[
          // Active clients is the ROSTER count, not "clients who happen to have
          // a figure on file" — those are different questions and were being
          // answered with the same number.
          { label: "Active clients", v: activeCount, c: "var(--green)" },
          { label: "MRR", v: `$${payingMrr.toLocaleString()}`, c: "var(--accent)" },
          { label: "Pipeline (not revenue)", v: `$${pipelineTotal.toLocaleString()}`, c: "var(--orange)" },
        ].map(s => (
          <div key={s.label} style={{
            background: `radial-gradient(ellipse 90% 70% at 50% -20%, ${s.c}14, transparent 60%), linear-gradient(180deg, var(--bg-card), var(--bg-card))`,
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
        Paying Clients
      </p>
      {paying.length === 0 && (
        <p style={{ fontSize: 13, color: "var(--text-muted)" }}>No paying clients yet.</p>
      )}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 12 }}>
        {paying.map((c: any) => {
          const icon = INDUSTRY_ICON[(c.industry || "").toLowerCase()] ?? "🏢";
          return (
            <div key={c.file}
              // The whole card opens the client's live dashboard in a new tab
              // (Jack, 2026-09-04). Only when one exists for this slug; the
              // health check moved to its own button below.
              role={c.dashboardUrl ? "link" : undefined}
              tabIndex={c.dashboardUrl ? 0 : undefined}
              onClick={() => { if (!c.dashboardUrl) return; sfx.play("nav"); window.open(c.dashboardUrl, "_blank", "noopener"); }}
              onKeyDown={(e) => { if (c.dashboardUrl && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); window.open(c.dashboardUrl, "_blank", "noopener"); } }}
              title={c.dashboardUrl ? "Open this client's dashboard" : "No dashboard yet"}
              style={{
                background: "radial-gradient(ellipse 90% 70% at 50% -20%, rgba(52,211,153,0.12), transparent 60%), linear-gradient(180deg, var(--bg-card), var(--bg-card))",
                border: "1px solid rgba(52,211,153,0.35)",
                borderRadius: 14, padding: "16px 18px", cursor: c.dashboardUrl ? "pointer" : "default",
              }}>
              <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
                <div style={{ display: "flex", gap: 10, alignItems: "center", minWidth: 0 }}>
                  <span style={{ fontSize: 20 }}>{icon}</span>
                  <div style={{ minWidth: 0 }}>
                    {/* Wraps rather than truncating: the term note beside it
                        squeezed "Hero's Junk Removal" down to "Hero's ...". */}
                    <p style={{ fontSize: 14, fontWeight: 700, overflowWrap: "anywhere", lineHeight: 1.25 }}>{c.name}</p>
                    <p style={{ fontSize: 11.5, color: "var(--text-muted)" }}>{c.owner || c.industry}</p>
                  </div>
                </div>
                <span style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                  <span style={{ fontSize: 15, fontWeight: 800, color: "var(--green)" }}>
                    ${c.mrr.toLocaleString()}<span style={{ fontSize: 10, fontWeight: 500, opacity: 0.7 }}>/mo</span>
                  </span>
                  {/* A fixed-term retainer looks identical to an open-ended one
                      unless the card says when it stops. */}
                  {c.revenue?.term && (
                    <span style={{ display: "block", fontSize: 10, color: "var(--orange)", fontWeight: 600, marginTop: 2 }}>
                      {c.revenue.term.monthsRemaining} mo left · ends {c.revenue.term.end}
                    </span>
                  )}
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
              {/* No per-client CRM filter exists yet, so this is one generic
                  link into the CRM rather than a count that would be a guess. */}
              <div style={{ marginTop: 12, paddingTop: 10, borderTop: "1px solid var(--border)", display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                {c.dashboardUrl ? (
                  <a href={c.dashboardUrl} target="_blank" rel="noopener noreferrer"
                    onClick={(e) => { e.stopPropagation(); sfx.play("nav"); }}
                    style={{
                      display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 12px", borderRadius: 9,
                      fontSize: 12, fontWeight: 700, textDecoration: "none",
                      background: "var(--accent)", color: "var(--bg-primary)", border: "1px solid var(--accent)",
                    }}>
                    Open dashboard <span aria-hidden="true">↗</span>
                  </a>
                ) : (
                  <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-muted)", padding: "6px 0" }}>
                    No dashboard yet
                  </span>
                )}
                <button type="button"
                  onClick={(e) => { e.stopPropagation(); sfx.play("blip"); setHealthClient(c.name); }}
                  style={{
                    padding: "6px 12px", borderRadius: 9, fontSize: 12, fontWeight: 600, cursor: "pointer",
                    background: "transparent", border: "1px solid var(--border)", color: "var(--text-secondary)", minHeight: 0,
                  }}>
                  Health check
                </button>
                <button type="button"
                  onClick={(e) => { e.stopPropagation(); sfx.play("nav"); window.dispatchEvent(new CustomEvent("os:navigate", { detail: "crm" })); }}
                  style={{ background: "none", border: "none", padding: 0, minHeight: 0, cursor: "pointer", fontSize: 11, color: "var(--accent)", textDecoration: "underline" }}>
                  Contacts and deals live in the CRM
                </button>
              </div>
              {(c.email || c.phone) && (
                <div style={{ borderTop: "1px solid var(--border)", marginTop: 12, paddingTop: 10, display: "flex", flexDirection: "column", gap: 4 }}>
                  {c.email && <a href={`mailto:${c.email}`} onClick={(e) => e.stopPropagation()} style={{ fontSize: 11.5, color: "var(--text-secondary)", textDecoration: "none", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>✉ {c.email}</a>}
                  {c.phone && <a href={`tel:${c.phone.replace(/\D/g, "")}`} onClick={(e) => e.stopPropagation()} style={{ fontSize: 11.5, color: "var(--text-secondary)", textDecoration: "none" }}>☎ {c.phone}</a>}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Pipeline (not yet paying) — collapsed by default */}
      {notPaying.length > 0 && (
        <div>
          <button onClick={() => setShowPipeline(v => !v)} style={{
            display: "flex", alignItems: "center", gap: 8, background: "none", border: "none", cursor: "pointer",
            fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em", padding: 0,
          }}>
            Not paying yet ({notPaying.length}) <span>{showPipeline ? "▲" : "▼"}</span>
          </button>
          {showPipeline && (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 10, marginTop: 12, opacity: 0.75 }}>
              {notPaying.map((c: any) => {
                const icon = INDUSTRY_ICON[(c.industry || "").toLowerCase()] ?? "🏢";
                return (
                  <div key={c.file}
                    onClick={() => { sfx.play("blip"); setHealthClient(c.name); }}
                    title="Click for client health"
                    style={{
                      background: "linear-gradient(180deg, var(--bg-card), var(--bg-card))",
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
