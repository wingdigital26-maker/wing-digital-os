"use client";
import { useCallback, useEffect, useState } from "react";
import { sfx } from "../lib/sounds";

// SONAR — the free social + web lead engine, surfaced in the OS.
//
// Reads /api/sonar, which talks to Sonar's own Supabase project (not the OS
// one), so this screen works with the PC off. The engine runs itself daily via
// GitHub Actions; this is where the output gets worked.
//
// Approve / Skip write straight back to the same rows the local review queue
// (queue/serve.py) uses, so both front ends stay in sync. Nothing here sends a
// message to anyone; approving marks a row and copies the draft for Jack.

type Lead = {
  id: number;
  title: string | null;
  place_name: string | null;
  category: string | null;
  source: string | null;
  url: string | null;
  website: string | null;
  phone: string | null;
  need_score: number | null;
  gmb_rating: number | null;
  gmb_reviews: number | null;
  seo_rank: number | null;
  audit_gaps: string[] | null;
  draft_reply: string | null;
};

type Totals = {
  total: number; awaiting: number; highNeed: number;
  unaudited: number; withPhone: number; approved: number;
};

type Payload = {
  configured: boolean;
  error?: string;
  totals: Totals | null;
  cities?: string[];
  leads: Lead[];
  fetchedAt?: string;
};

const SOURCE_ICON: Record<string, string> = {
  instagram: "IG", tiktok: "TT", linkedin: "LI", facebook: "FB",
  reddit: "RD", youtube: "YT", social: "··",
};

function needColor(n: number | null): string {
  if (n == null) return "var(--muted, #94a3b8)";
  if (n >= 0.7) return "var(--red, #fb7185)";
  if (n >= 0.5) return "var(--orange, #fbbf24)";
  return "var(--green, #4ade80)";
}

export default function SonarBoard() {
  const [data, setData] = useState<Payload | null>(null);
  const [err, setErr] = useState("");
  const [city, setCity] = useState("");
  const [minNeed, setMinNeed] = useState("0.6");
  const [busy, setBusy] = useState<number | null>(null);
  const [copied, setCopied] = useState<number | null>(null);

  const load = useCallback(() => {
    const qs = new URLSearchParams({ minNeed, limit: "60" });
    if (city) qs.set("city", city);
    fetch(`/api/sonar?${qs}`)
      .then((r) => r.json())
      .then((d: Payload) => { setData(d); setErr(d.error || ""); })
      .catch((e) => setErr(String(e)));
  }, [city, minNeed]);

  useEffect(() => { load(); }, [load]);
  // The engine writes on a schedule, so a slow refresh keeps this honest
  // without hammering Supabase.
  useEffect(() => {
    const t = setInterval(load, 120000);
    return () => clearInterval(t);
  }, [load]);

  async function act(id: number, action: "approve" | "reject") {
    setBusy(id);
    try {
      await fetch("/api/sonar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, action }),
      });
      sfx.play("blip");
      setData((d) => (d ? { ...d, leads: d.leads.filter((l) => l.id !== id) } : d));
    } finally {
      setBusy(null);
    }
  }

  function copyDraft(l: Lead) {
    navigator.clipboard?.writeText(l.draft_reply || "");
    setCopied(l.id);
    setTimeout(() => setCopied((c) => (c === l.id ? null : c)), 1500);
  }

  if (err && !data?.leads?.length) {
    return <p style={{ color: "#fb7185", fontSize: 13 }}>Sonar: {err}</p>;
  }
  if (!data) {
    return (
      <div style={{ display: "grid", gap: 12 }} aria-label="Loading Sonar">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 12 }}>
          {[0, 1, 2, 3].map((i) => <div key={i} className="skel" style={{ height: 78, borderRadius: 14 }} />)}
        </div>
        {[0, 1, 2].map((i) => <div key={i} className="skel" style={{ height: 120, borderRadius: 14 }} />)}
      </div>
    );
  }
  if (!data.configured) {
    return (
      <div style={{ padding: 18, border: "1px solid var(--line,#26313a)", borderRadius: 14 }}>
        <h3 style={{ margin: "0 0 6px", fontSize: 15 }}>Sonar is not connected yet</h3>
        <p style={{ margin: 0, fontSize: 13, color: "var(--muted,#94a3b8)" }}>
          Add <code>SONAR_SUPABASE_URL</code> and <code>SONAR_SUPABASE_SERVICE_KEY</code> to the
          environment, then reload. Sonar keeps its leads in a separate Supabase
          project from the OS, so it needs its own credentials.
        </p>
      </div>
    );
  }

  const t = data.totals;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <header style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
        <h2 style={{ margin: 0, fontSize: 18, letterSpacing: "-0.01em" }}>Sonar</h2>
        <span style={{ fontSize: 12.5, color: "var(--muted,#94a3b8)" }}>
          Free social + web lead engine. Runs daily on its own. Nothing here sends.
        </span>
      </header>

      {/* Totals */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 12 }}>
        {t && ([
          ["Prospects found", t.total, null],
          ["Awaiting review", t.awaiting, null],
          ["High need (0.7+)", t.highNeed, "var(--red,#fb7185)"],
          ["Have a phone", t.withPhone, null],
          ["Approved", t.approved, "var(--green,#4ade80)"],
          ["Not yet audited", t.unaudited, t.unaudited > 200 ? "var(--orange,#fbbf24)" : null],
        ] as [string, number, string | null][]).map(([label, value, color]) => (
          <div key={label} style={{
            border: "1px solid var(--line,#26313a)", borderRadius: 14, padding: "12px 14px",
            background: "var(--card,#121a20)",
          }}>
            <div style={{ fontSize: 22, fontWeight: 700, color: color || "inherit", fontVariantNumeric: "tabular-nums" }}>
              {value.toLocaleString()}
            </div>
            <div style={{ fontSize: 11.5, color: "var(--muted,#94a3b8)", marginTop: 2 }}>{label}</div>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        <label style={{ fontSize: 12, color: "var(--muted,#94a3b8)" }}>
          City{" "}
          <select value={city} onChange={(e) => setCity(e.target.value)}
            style={{ background: "var(--card,#121a20)", color: "inherit", border: "1px solid var(--line,#26313a)", borderRadius: 8, padding: "5px 8px", fontSize: 12.5 }}>
            <option value="">All</option>
            {(data.cities || []).map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
        <label style={{ fontSize: 12, color: "var(--muted,#94a3b8)" }}>
          Min need{" "}
          <select value={minNeed} onChange={(e) => setMinNeed(e.target.value)}
            style={{ background: "var(--card,#121a20)", color: "inherit", border: "1px solid var(--line,#26313a)", borderRadius: 8, padding: "5px 8px", fontSize: 12.5 }}>
            {["0.7", "0.6", "0.5", "0"].map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        </label>
        <button onClick={load} style={{
          border: "1px solid var(--line,#26313a)", background: "transparent", color: "inherit",
          borderRadius: 8, padding: "5px 12px", fontSize: 12.5, cursor: "pointer",
        }}>Refresh</button>
        <span style={{ fontSize: 11.5, color: "var(--muted,#94a3b8)" }}>
          {data.leads.length} shown
        </span>
      </div>

      {/* Leads */}
      {data.leads.length === 0 ? (
        <p style={{ fontSize: 13, color: "var(--muted,#94a3b8)" }}>
          Nothing matches that filter. Lower the min need, or wait for tonight's run.
        </p>
      ) : (
        <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fill,minmax(330px,1fr))" }}>
          {data.leads.map((l) => {
            const warns = (l.audit_gaps || []).filter((g) => g.startsWith("WARNING") || g.startsWith("CHECK"));
            const gaps = (l.audit_gaps || []).filter((g) => !warns.includes(g));
            return (
              <article key={l.id} style={{
                border: "1px solid var(--line,#26313a)", borderRadius: 14, padding: "13px 15px 15px",
                background: "var(--card,#121a20)", display: "flex", flexDirection: "column", gap: 9,
              }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "flex-start" }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 650, fontSize: 14.5, lineHeight: 1.25 }}>
                      {l.title || "(untitled)"}
                    </div>
                    <div style={{ fontSize: 11.5, color: "var(--muted,#94a3b8)", marginTop: 2 }}>
                      {[l.place_name, l.category].filter(Boolean).join(" · ")}
                      {l.source ? ` · ${SOURCE_ICON[l.source] || l.source}` : ""}
                    </div>
                  </div>
                  <div style={{ textAlign: "right", flex: "none" }}>
                    <div style={{ fontSize: 17, fontWeight: 700, color: needColor(l.need_score), fontVariantNumeric: "tabular-nums" }}>
                      {l.need_score?.toFixed(2) ?? "—"}
                    </div>
                    <div style={{ fontSize: 10, color: "var(--muted,#94a3b8)" }}>need</div>
                  </div>
                </div>

                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", fontSize: 11 }}>
                  {l.phone && <a href={`tel:${l.phone.replace(/\D/g, "")}`} style={{ color: "var(--green,#4ade80)", textDecoration: "none", fontVariantNumeric: "tabular-nums" }}>{l.phone}</a>}
                  {l.seo_rank != null && <span style={{ color: "var(--muted,#94a3b8)" }}>ranks #{l.seo_rank}</span>}
                  {l.gmb_rating != null && <span style={{ color: "var(--muted,#94a3b8)" }}>{l.gmb_rating}★ {l.gmb_reviews ?? "?"} reviews</span>}
                </div>

                {gaps.length > 0 && (
                  <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexWrap: "wrap", gap: 4 }}>
                    {gaps.slice(0, 4).map((g, i) => (
                      <li key={i} style={{
                        fontSize: 10.5, border: "1px solid var(--line,#26313a)", borderRadius: 20,
                        padding: "2px 8px", color: "var(--muted,#94a3b8)",
                      }}>{g}</li>
                    ))}
                  </ul>
                )}

                {/* Unverified findings are surfaced, never hidden — the engine
                    flags same-name businesses in other states and social
                    accounts it could not confirm. */}
                {warns.length > 0 && (
                  <div style={{
                    fontSize: 11, color: "var(--orange,#fbbf24)",
                    border: "1px solid rgba(251,191,36,.35)", borderRadius: 8, padding: "6px 8px",
                  }}>
                    {warns.map((w, i) => <div key={i}>{w}</div>)}
                  </div>
                )}

                <div style={{ display: "flex", gap: 7, flexWrap: "wrap", marginTop: 2 }}>
                  {(l.website || l.url) && (
                    <a href={l.website || l.url || "#"} target="_blank" rel="noopener"
                      style={{ fontSize: 11.5, color: "var(--accent,#5eead4)", textDecoration: "none" }}>
                      open ↗
                    </a>
                  )}
                  {l.draft_reply && (
                    <button onClick={() => copyDraft(l)} style={btn}>
                      {copied === l.id ? "copied" : "copy draft"}
                    </button>
                  )}
                  <button disabled={busy === l.id} onClick={() => act(l.id, "approve")}
                    style={{ ...btn, borderColor: "rgba(74,222,128,.4)", color: "var(--green,#4ade80)" }}>
                    approve
                  </button>
                  <button disabled={busy === l.id} onClick={() => act(l.id, "reject")} style={btn}>
                    skip
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}

const btn: React.CSSProperties = {
  fontSize: 11.5, padding: "3px 10px", borderRadius: 8, cursor: "pointer",
  border: "1px solid var(--line,#26313a)", background: "transparent", color: "inherit",
};
