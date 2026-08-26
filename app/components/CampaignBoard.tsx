"use client";
import { useEffect, useState } from "react";

export default function CampaignBoard() {
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState("");
  const [showQueued, setShowQueued] = useState(false);

  useEffect(() => {
    fetch("/api/campaign")
      .then(r => r.json())
      .then(d => (d.error ? setErr(d.error) : setData(d)))
      .catch(e => setErr(String(e)));
  }, []);

  if (err) return <p style={{ color: "var(--red)", fontSize: 13 }}>Campaign data error: {err}</p>;
  if (!data) return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }} aria-label="Loading campaign">
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12 }}>
        {[0, 1].map(i => <div key={i} className="skel" style={{ height: 88, borderRadius: 14 }} />)}
      </div>
      <div className="skel" style={{ height: 180, borderRadius: 14 }} />
    </div>
  );

  const t = data.totals;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      {/* Header */}
      <h2 style={{ fontSize: 16, fontWeight: 700 }}>Cold Email Campaign — Roofing</h2>

      {/* Stat tiles */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12 }}>
        {[
          { label: "Emails sent", v: t.sent, c: "var(--green)" },
          { label: "Queued to go out", v: t.remaining, c: "var(--accent)" },
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

      {/* Recent sends */}
      <div style={{ background: "linear-gradient(180deg, var(--bg-card), var(--bg-card))", border: "1px solid var(--border)", borderRadius: 14, padding: 18 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
          <p style={{ fontSize: 11.5, fontWeight: 700, color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.07em" }}>
            {showQueued ? `Queued for wave 3 (${data.queued.length})` : `Latest sends (${data.contacts.length})`}
          </p>
          <button onClick={() => setShowQueued(q => !q)} style={{
            fontSize: 11.5, fontWeight: 600, color: "var(--accent)", background: "transparent",
            border: "1px solid var(--accent)", borderRadius: 8, padding: "4px 12px", cursor: "pointer",
          }}>
            {showQueued ? "Show sent" : "Show queued"}
          </button>
        </div>
        <div style={{ display: "flex", flexDirection: "column", maxHeight: 320, overflowY: "auto" }}>
          {(showQueued ? data.queued : data.contacts.slice(0, 40)).map((c: any, i: number) => (
            <div key={c.id} style={{
              display: "flex", alignItems: "center", gap: 12, padding: "7px 10px",
              borderRadius: 8, background: i % 2 ? "rgba(255,255,255,0.02)" : "transparent",
            }}>
              <span style={{ fontSize: 13, fontWeight: 600, flex: 1, minWidth: 150, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.company}</span>
              <span style={{ fontSize: 11.5, color: "var(--text-muted)", width: 110, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.owner}</span>
              <span style={{ fontSize: 11.5, color: "var(--text-muted)", width: 90 }}>{c.city}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
