"use client";
import { useCallback, useEffect, useState } from "react";
import { sfx } from "../lib/sounds";

// CRM — every outbound message, compartmentalized by the client it is for.
//
// Left rail lists each client with draft/approved/sent counts. Picking one shows
// its messages, each with the real fact it was personalized on, an editable
// body, and approve / skip / copy / mark-sent. Reads /api/crm (Sonar Supabase),
// so it works PC-off. Nothing here transmits — it keeps outbound checked.

type Scraper = {
  slug: string; name: string; channels: string | null; scrape_niche: string | null;
  scrape_cities: string | null; scrape_terms: string | null; active: boolean;
};
type ClientRollup = {
  client: string; total: number; draft: number; approved: number; sent: number;
  channels: string[]; scraper: Scraper | null;
};
type Item = {
  id: number; client: string; channel: string; recipient: string | null;
  recipient_url: string | null; subject: string | null; body: string | null;
  personalization: string | null; evidence_url: string | null;
  status: string; tier: string | null; created_at: string;
};
type Payload = {
  configured: boolean; error?: string;
  clients: ClientRollup[]; items: Item[];
  totals?: { total: number; draft: number; approved: number; sent: number };
};

const CHANNEL_LABEL: Record<string, string> = {
  email: "Email", instagram: "Instagram", tiktok: "TikTok",
  nextdoor: "Nextdoor", facebook: "Facebook", linkedin: "LinkedIn", reddit: "Reddit",
};
const STATUS_COLOR: Record<string, string> = {
  draft: "var(--text-muted,#545d7d)",
  approved: "var(--green,#34d399)",
  sent: "var(--accent,#22d3ee)",
  skipped: "var(--red,#fb7185)",
};

export default function CrmBoard() {
  const [data, setData] = useState<Payload | null>(null);
  const [err, setErr] = useState("");
  const [client, setClient] = useState<string>("");
  const [status, setStatus] = useState<string>("draft");
  const [edits, setEdits] = useState<Record<number, string>>({});
  const [copied, setCopied] = useState<number | null>(null);
  const [cfg, setCfg] = useState<Scraper | null>(null);
  const [cfgSaved, setCfgSaved] = useState(false);

  const load = useCallback(() => {
    const qs = new URLSearchParams();
    if (client) qs.set("client", client);
    if (status) qs.set("status", status);
    fetch(`/api/crm?${qs}`)
      .then((r) => r.json())
      .then((d: Payload) => {
        setData(d); setErr(d.error || "");
        if (!client && d.clients?.length) setClient(d.clients[0].client);
      })
      .catch((e) => setErr(String(e)));
  }, [client, status]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const c = data?.clients.find((x) => x.client === client);
    setCfg(c?.scraper ? { ...c.scraper } : null);
  }, [client, data?.clients]);

  async function saveCfg() {
    if (!cfg) return;
    await fetch("/api/crm", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "config", ...cfg }),
    });
    sfx.play("blip");
    setCfgSaved(true);
    setTimeout(() => setCfgSaved(false), 1600);
  }

  async function act(it: Item, action: "approve" | "skip" | "sent") {
    if (edits[it.id] !== undefined && edits[it.id] !== it.body) {
      await fetch("/api/crm", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: it.id, action: "save", body: edits[it.id] }),
      });
    }
    await fetch("/api/crm", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: it.id, action }),
    });
    sfx.play("blip");
    setData((d) => (d ? { ...d, items: d.items.filter((x) => x.id !== it.id) } : d));
  }

  function copy(it: Item) {
    const text = edits[it.id] ?? it.body ?? "";
    navigator.clipboard?.writeText(
      it.channel === "email" && it.subject ? `Subject: ${it.subject}\n\n${text}` : text
    );
    setCopied(it.id);
    setTimeout(() => setCopied((c) => (c === it.id ? null : c)), 1500);
  }

  if (err && !data?.items?.length) return <p style={{ color: "var(--red)", fontSize: 13 }}>CRM: {err}</p>;
  if (!data) {
    return (
      <div style={{ display: "grid", gridTemplateColumns: "220px 1fr", gap: 16 }} aria-label="Loading CRM">
        <div className="skel" style={{ height: 300, borderRadius: 14 }} />
        <div style={{ display: "grid", gap: 12 }}>
          {[0, 1, 2].map((i) => <div key={i} className="skel" style={{ height: 130, borderRadius: 14 }} />)}
        </div>
      </div>
    );
  }
  if (!data.configured) {
    return (
      <div style={{ padding: 18, border: "1px solid var(--border,#1f2437)", borderRadius: 14 }}>
        <h3 style={{ margin: "0 0 6px", fontSize: 15 }}>CRM not connected</h3>
        <p style={{ margin: 0, fontSize: 13, color: "var(--text-secondary,#9aa3c0)" }}>
          Add <code>SONAR_SUPABASE_URL</code> and <code>SONAR_SUPABASE_SERVICE_KEY</code> to the environment.
        </p>
      </div>
    );
  }

  const t = data.totals;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <header style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
        <h2 style={{ margin: 0, fontSize: 18, letterSpacing: "-0.01em" }}>CRM</h2>
        <span style={{ fontSize: 12.5, color: "var(--text-secondary,#9aa3c0)" }}>
          Every message going out, by client. Nothing sends from here — you keep it checked.
        </span>
      </header>

      {t && (
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          {([["Total", t.total, null], ["Drafts", t.draft, null],
             ["Approved", t.approved, "var(--green,#34d399)"], ["Sent", t.sent, "var(--accent,#22d3ee)"]] as
            [string, number, string | null][]).map(([label, val, color]) => (
            <div key={label} style={{
              border: "1px solid var(--border,#1f2437)", borderRadius: 12, padding: "8px 14px",
              background: "var(--bg-card,#10131f)", minWidth: 92,
            }}>
              <div style={{ fontSize: 20, fontWeight: 700, color: color || "inherit", fontVariantNumeric: "tabular-nums" }}>{val}</div>
              <div style={{ fontSize: 11, color: "var(--text-secondary,#9aa3c0)" }}>{label}</div>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "minmax(180px,220px) 1fr", gap: 16, alignItems: "start" }}>
        {/* Client compartments */}
        <nav style={{ display: "flex", flexDirection: "column", gap: 6 }} aria-label="Clients">
          {data.clients.length === 0 && (
            <p style={{ fontSize: 12.5, color: "var(--text-secondary,#9aa3c0)" }}>No outbound yet.</p>
          )}
          {data.clients.map((c) => {
            const on = c.client === client;
            return (
              <button key={c.client} onClick={() => setClient(c.client)} style={{
                textAlign: "left", cursor: "pointer", borderRadius: 12, padding: "10px 12px",
                border: `1px solid ${on ? "var(--accent,#22d3ee)" : "var(--border,#1f2437)"}`,
                background: on ? "var(--accent-glow,rgba(34,211,238,.12))" : "var(--bg-card,#10131f)",
                color: "inherit",
              }}>
                <div style={{ fontSize: 13.5, fontWeight: 600 }}>{c.client}</div>
                <div style={{ fontSize: 11, color: "var(--text-secondary,#9aa3c0)", marginTop: 3 }}>
                  {c.draft} draft · {c.approved} ok · {c.sent} sent
                </div>
                <div style={{ fontSize: 10, color: "var(--text-muted,#545d7d)", marginTop: 2 }}>
                  {c.channels.map((ch) => CHANNEL_LABEL[ch] || ch).join(" · ")}
                </div>
              </button>
            );
          })}
        </nav>

        {/* Messages for the selected client */}
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>

          {/* This client's own scraper: what it hunts, where, on which
              platforms. The watcher reads exactly these fields on every run,
              so editing here retargets the next run. */}
          {cfg && (
            <section style={{
              border: "1px solid var(--border,#1f2437)", borderRadius: 14,
              padding: "13px 16px", background: "var(--accent-glow,rgba(34,211,238,.08))",
              display: "flex", flexDirection: "column", gap: 8,
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <span style={{
                  fontSize: 10.5, textTransform: "uppercase", letterSpacing: ".1em",
                  fontWeight: 700, color: "var(--accent)",
                }}>◉ {cfg.name}&apos;s scraper</span>
                <span style={{ fontSize: 11.5, color: "var(--text-secondary)" }}>
                  hunts <b style={{ color: "var(--text-primary)" }}>{cfg.scrape_niche || "?"}</b> customers
                  in <b style={{ color: "var(--text-primary)" }}>{cfg.scrape_cities || "?"}</b>
                  {" "}· runs 3x daily, PC off
                </span>
                <span style={{ flex: 1 }} />
                <label style={{ fontSize: 11.5, color: "var(--text-secondary)", display: "flex", alignItems: "center", gap: 5 }}>
                  <input type="checkbox" checked={cfg.active}
                    onChange={(e) => setCfg({ ...cfg, active: e.target.checked })} />
                  active
                </label>
              </div>
              <div style={{ display: "grid", gap: 8, gridTemplateColumns: "repeat(auto-fit,minmax(160px,1fr))" }}>
                {([["what they sell", "scrape_niche", "roofing"],
                   ["cities to watch", "scrape_cities", "Plano,Frisco"],
                   ["extra keywords", "scrape_terms", "roof leak,hail damage"],
                   ["platforms", "channels", "nextdoor,reddit"]] as
                  [string, "scrape_niche" | "scrape_cities" | "scrape_terms" | "channels", string][]
                ).map(([label, key, ph]) => (
                  <label key={key} style={{ fontSize: 10.5, color: "var(--text-muted)", display: "flex", flexDirection: "column", gap: 3 }}>
                    {label}
                    <input value={cfg[key] ?? ""} placeholder={ph}
                      onChange={(e) => setCfg({ ...cfg, [key]: e.target.value })}
                      style={{
                        fontSize: 12.5, padding: "6px 9px", borderRadius: 8,
                        border: "1px solid var(--border)", background: "var(--bg-card)",
                        color: "var(--text-primary)", fontFamily: "inherit",
                      }} />
                  </label>
                ))}
              </div>
              <div>
                <button onClick={saveCfg} style={{
                  fontSize: 11.5, padding: "5px 14px", borderRadius: 8, cursor: "pointer",
                  border: "1px solid var(--accent)", color: "var(--accent)",
                  background: "transparent", fontWeight: 600,
                }}>{cfgSaved ? "saved — next run uses this" : "save scraper settings"}</button>
              </div>
            </section>
          )}

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {["draft", "approved", "sent", "skipped", ""].map((s) => (
              <button key={s || "all"} onClick={() => setStatus(s)} style={{
                fontSize: 12, padding: "4px 12px", borderRadius: 20, cursor: "pointer",
                border: `1px solid ${status === s ? "var(--accent,#22d3ee)" : "var(--border,#1f2437)"}`,
                background: status === s ? "var(--accent-glow,rgba(34,211,238,.12))" : "transparent",
                color: "inherit",
              }}>{s || "all"}</button>
            ))}
          </div>

          {data.items.length === 0 ? (
            <p style={{ fontSize: 13, color: "var(--text-secondary,#9aa3c0)" }}>
              Nothing {status || ""} for {client || "this client"}.
            </p>
          ) : data.items.map((it) => (
            <article key={it.id} style={{
              border: "1px solid var(--border,#1f2437)", borderRadius: 14, padding: "14px 16px",
              background: "var(--bg-card,#10131f)", display: "flex", flexDirection: "column", gap: 9,
            }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
                <div>
                  <span style={{
                    fontSize: 10.5, textTransform: "uppercase", letterSpacing: ".08em",
                    color: "var(--accent,#22d3ee)", fontWeight: 700,
                  }}>{CHANNEL_LABEL[it.channel] || it.channel}{it.tier ? ` · ${it.tier}` : ""}</span>
                  <div style={{ fontSize: 14.5, fontWeight: 650, marginTop: 3 }}>
                    {it.recipient || "(recipient)"}
                  </div>
                </div>
                <span style={{ fontSize: 11, fontWeight: 600, color: STATUS_COLOR[it.status] || "inherit" }}>
                  {it.status}
                </span>
              </div>

              {it.subject && (
                <div style={{ fontSize: 13, fontWeight: 600 }}>{it.subject}</div>
              )}

              {/* The real fact this was personalized on — the thing that keeps
                  it honest and non-generic. */}
              {it.personalization && (
                <div style={{
                  fontSize: 12, fontStyle: "italic", color: "var(--text-secondary,#9aa3c0)",
                  borderLeft: "2px solid var(--accent-dim,#0e7490)", paddingLeft: 8,
                }}>
                  {it.personalization}
                </div>
              )}

              <textarea
                value={edits[it.id] ?? it.body ?? ""}
                onChange={(e) => setEdits((m) => ({ ...m, [it.id]: e.target.value }))}
                style={{
                  width: "100%", minHeight: 120, resize: "vertical", borderRadius: 8, padding: 10,
                  fontSize: 12.5, lineHeight: 1.5, fontFamily: "inherit",
                  background: "var(--bg-secondary,#0b0d17)", color: "inherit",
                  border: "1px solid var(--border,#1f2437)", boxSizing: "border-box",
                }}
              />

              <div style={{ display: "flex", gap: 7, flexWrap: "wrap", alignItems: "center" }}>
                {(it.recipient_url || it.evidence_url) && (
                  <a href={it.evidence_url || it.recipient_url || "#"} target="_blank" rel="noopener"
                    style={{ fontSize: 11.5, color: "var(--accent,#22d3ee)", textDecoration: "none" }}>open ↗</a>
                )}
                <button onClick={() => copy(it)} style={btn}>{copied === it.id ? "copied" : "copy"}</button>
                <span style={{ flex: 1 }} />
                <button onClick={() => act(it, "approve")} style={{ ...btn, borderColor: "rgba(52,211,153,.45)", color: "var(--green,#34d399)" }}>approve</button>
                <button onClick={() => act(it, "sent")} style={{ ...btn, borderColor: "rgba(34,211,238,.45)", color: "var(--accent,#22d3ee)" }}>mark sent</button>
                <button onClick={() => act(it, "skip")} style={btn}>skip</button>
              </div>
            </article>
          ))}
        </div>
      </div>
    </div>
  );
}

const btn: React.CSSProperties = {
  fontSize: 11.5, padding: "4px 11px", borderRadius: 8, cursor: "pointer",
  border: "1px solid var(--border,#1f2437)", background: "transparent", color: "inherit",
};
