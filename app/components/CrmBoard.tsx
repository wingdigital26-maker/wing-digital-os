"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { sfx } from "../lib/sounds";
import CrmClientSummary, {
  CHANNEL_LABEL, type ChannelRoll, type ClientProfile, type Scraper,
} from "./CrmClientSummary";
import CrmContentFeed, { type ContentFeed } from "./CrmContentFeed";
import CrmScraperHealth, { type Watch } from "./CrmScraperHealth";

// CRM — everything happening for a client, compartmentalized by client.
//
// Left rail lists each client. Picking one shows a summary of their key facts,
// their scraper's hunting instructions, lanes for each channel (email, social
// replies, SMS), the messages in that lane, and the content Wing actually
// published for them. Reads /api/crm (Sonar Supabase + the vault + the content
// engine's state file). Nothing here transmits — it keeps the work checked.

type ClientRollup = {
  client: string; total: number; draft: number; approved: number; sent: number;
  channels: string[]; byChannel: ChannelRoll[]; scraper: Scraper | null;
  profile: ClientProfile | null; watch?: Watch;
};

// The left rail needs the health state at a glance too, so a client whose
// scraper is dead is visible before you click into them.
const RAIL: Record<string, { mark: string; color: string; text: string }> = {
  WORKING:           { mark: "●", color: "var(--green)",      text: "scraper working" },
  RAN_FOUND_NOTHING: { mark: "◐", color: "var(--orange)",     text: "ran, found nothing" },
  NEVER_RUN:         { mark: "○", color: "var(--red)",        text: "never run" },
  NOT_CONFIGURED:    { mark: "⊘", color: "var(--red)",        text: "not configured" },
  UNKNOWN:           { mark: "?", color: "var(--text-muted)", text: "run state unknown" },
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
  content?: ContentFeed;
};

const STATUS_COLOR: Record<string, string> = {
  draft: "var(--text-muted)",
  approved: "var(--green)",
  sent: "var(--accent)",
  skipped: "var(--red)",
};

// Which raw `channel` values belong to which lane.
const SOCIAL = ["nextdoor", "reddit", "facebook", "instagram", "tiktok", "linkedin"];
const SMS = ["sms", "text"];
type Lane = "email" | "social" | "sms";
const LANES: { id: Lane; label: string; match: (ch: string) => boolean }[] = [
  { id: "email", label: "Email", match: (ch) => ch === "email" },
  { id: "social", label: "Social replies", match: (ch) => SOCIAL.includes(ch) },
  { id: "sms", label: "SMS / texting", match: (ch) => SMS.includes(ch) },
];

export default function CrmBoard() {
  const [data, setData] = useState<Payload | null>(null);
  const [err, setErr] = useState("");
  const [client, setClient] = useState<string>("");
  const [status, setStatus] = useState<string>("draft");
  const [lane, setLane] = useState<Lane>("email");
  const [lanePicked, setLanePicked] = useState(false);
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

  const current = useMemo(
    () => data?.clients.find((x) => x.client === client) ?? null,
    [data?.clients, client]
  );

  // Reseed the editable scraper form when the compartment changes — done during
  // render (React's sanctioned reset pattern) so in-progress edits survive a
  // background refresh but never leak from one client onto another.
  const [cfgFor, setCfgFor] = useState<string | null>(null);
  if (current && cfgFor !== current.client) {
    setCfgFor(current.client);
    setCfg(current.scraper ? { ...current.scraper } : null);
    setLanePicked(false);
  }

  // Counts per lane come from the client's full rollup, so a lane's tab is
  // honest about having zero even when the current status filter hides it.
  const laneCounts = useMemo(() => {
    const out: Record<Lane, number> = { email: 0, social: 0, sms: 0 };
    for (const c of current?.byChannel ?? []) {
      const l = LANES.find((x) => x.match(c.channel));
      if (l) out[l.id] += c.total;
    }
    return out;
  }, [current]);

  // Until Jack picks a lane, default to one that actually has something. Once
  // he clicks, his choice sticks even if that lane is empty.
  const active: Lane = lanePicked
    ? lane
    : (LANES.find((l) => laneCounts[l.id] > 0)?.id ?? lane);

  const visible = useMemo(() => {
    const m = LANES.find((l) => l.id === active)!.match;
    return (data?.items ?? []).filter((i) => i.client === client && m(i.channel || ""));
  }, [data?.items, client, active]);

  const unlaned = useMemo(() => {
    const known = (ch: string) => LANES.some((l) => l.match(ch));
    return (current?.byChannel ?? []).filter((c) => !known(c.channel));
  }, [current]);

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
      <div style={{ padding: 18, border: "1px solid var(--border)", borderRadius: 14 }}>
        <h3 style={{ margin: "0 0 6px", fontSize: 15 }}>CRM not connected</h3>
        <p style={{ margin: 0, fontSize: 13, color: "var(--text-secondary)" }}>
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
        <span style={{ fontSize: 12.5, color: "var(--text-secondary)" }}>
          Everything happening for each client. Nothing sends from here — you keep it checked.
        </span>
      </header>

      {t && (
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          {([["Total", t.total, null], ["Drafts", t.draft, null],
             ["Approved", t.approved, "var(--green)"], ["Sent", t.sent, "var(--accent)"]] as
            [string, number, string | null][]).map(([label, val, color]) => (
            <div key={label} style={{
              border: "1px solid var(--border)", borderRadius: 12, padding: "8px 14px",
              background: "var(--bg-card)", minWidth: 92,
            }}>
              <div style={{ fontSize: 20, fontWeight: 700, color: color || "var(--text-primary)", fontVariantNumeric: "tabular-nums" }}>{val}</div>
              <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>{label}</div>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "minmax(180px,220px) 1fr", gap: 16, alignItems: "start" }}>
        {/* Client compartments */}
        <nav style={{ display: "flex", flexDirection: "column", gap: 6 }} aria-label="Clients">
          {data.clients.length === 0 && (
            <p style={{ fontSize: 12.5, color: "var(--text-secondary)" }}>No clients configured yet.</p>
          )}
          {data.clients.map((c) => {
            const on = c.client === client;
            return (
              <button key={c.client} onClick={() => setClient(c.client)} style={{
                textAlign: "left", cursor: "pointer", borderRadius: 12, padding: "10px 12px",
                border: `1px solid ${on ? "var(--accent)" : "var(--border)"}`,
                background: on ? "var(--accent-glow)" : "var(--bg-card)",
                color: "var(--text-primary)",
              }}>
                <div style={{ fontSize: 13.5, fontWeight: 600 }}>{c.client}</div>
                <div style={{ fontSize: 11, color: "var(--text-secondary)", marginTop: 3 }}>
                  {c.draft} draft · {c.approved} ok · {c.sent} sent
                </div>
                <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 2 }}>
                  {c.channels.length
                    ? c.channels.map((ch) => CHANNEL_LABEL[ch] || ch).join(" · ")
                    : "no messages yet"}
                </div>
                {(() => {
                  if (!c.watch || !RAIL[c.watch.state]) return null;
                  const zeroQ = c.watch.state === "RAN_FOUND_NOTHING" &&
                                c.watch.run != null && c.watch.run.queries === 0;
                  const r = zeroQ
                    ? { mark: "◌", color: "var(--red)", text: "ran, searched nothing" }
                    : RAIL[c.watch.state];
                  return (
                    <div style={{ fontSize: 10, marginTop: 4, fontWeight: 600, color: r.color }}>
                      <span aria-hidden>{r.mark}</span> {r.text}
                    </div>
                  );
                })()}
              </button>
            );
          })}
        </nav>

        {/* Everything for the selected client */}
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>

          {current && (
            <CrmClientSummary
              name={current.client}
              profile={current.profile}
              scraper={current.scraper}
              counts={{ draft: current.draft, approved: current.approved, sent: current.sent, total: current.total }}
              byChannel={current.byChannel}
            />
          )}

          {/* Is this client's scraper actually working? Sits directly above the
              settings that control it, so a broken state and the knobs that fix
              it are in the same glance. */}
          {current?.watch && <CrmScraperHealth watch={current.watch} name={current.client} />}

          {/* This client's own scraper: what it hunts, where, on which
              platforms. The watcher reads exactly these fields on every run,
              so editing here retargets the next run. */}
          {cfg && (
            <section style={{
              border: "1px solid var(--border)", borderRadius: 14,
              padding: "13px 16px", background: "var(--accent-glow)",
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

          {/* Channel lanes */}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center",
                        borderBottom: "1px solid var(--border)", paddingBottom: 9 }}>
            {LANES.map((l) => {
              const on = active === l.id;
              return (
                <button key={l.id} onClick={() => { setLane(l.id); setLanePicked(true); }} style={{
                  fontSize: 12.5, padding: "5px 13px", borderRadius: 9, cursor: "pointer",
                  fontWeight: on ? 650 : 500,
                  border: `1px solid ${on ? "var(--accent)" : "var(--border)"}`,
                  background: on ? "var(--accent-glow)" : "transparent",
                  color: on ? "var(--accent)" : "var(--text-secondary)",
                }}>
                  {l.label}
                  <span style={{ marginLeft: 7, color: "var(--text-muted)", fontVariantNumeric: "tabular-nums" }}>
                    {laneCounts[l.id]}
                  </span>
                </button>
              );
            })}
            {unlaned.length > 0 && (
              <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                + {unlaned.map((c) => `${CHANNEL_LABEL[c.channel] || c.channel} (${c.total})`).join(", ")} on
                {" "}channels with no lane
              </span>
            )}
          </div>

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {["draft", "approved", "sent", "skipped", ""].map((s) => (
              <button key={s || "all"} onClick={() => setStatus(s)} style={{
                fontSize: 12, padding: "4px 12px", borderRadius: 20, cursor: "pointer",
                border: `1px solid ${status === s ? "var(--accent)" : "var(--border)"}`,
                background: status === s ? "var(--accent-glow)" : "transparent",
                color: "var(--text-primary)",
              }}>{s || "all"}</button>
            ))}
          </div>

          {active === "sms" && laneCounts.sms === 0 ? (
            <div style={{
              border: "1px dashed var(--border)", borderRadius: 12, padding: "13px 15px",
            }}>
              <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--orange)" }}>
                No SMS lane wired yet
              </div>
              <p style={{ margin: "5px 0 0", fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.55 }}>
                Nothing writes rows with <code>channel = &quot;sms&quot;</code> to the <code>outbound</code> table,
                and Wing has no texting provider connected since GHL was retired. This lane will fill in on
                its own once a sender starts drafting texts — nothing is being hidden.
              </p>
            </div>
          ) : visible.length === 0 ? (
            <p style={{ fontSize: 13, color: "var(--text-secondary)" }}>
              Nothing {status || ""} on {LANES.find((l) => l.id === active)!.label.toLowerCase()} for
              {" "}{client || "this client"}.
            </p>
          ) : visible.map((it) => (
            <article key={it.id} style={{
              border: "1px solid var(--border)", borderRadius: 14, padding: "14px 16px",
              background: "var(--bg-card)", display: "flex", flexDirection: "column", gap: 9,
            }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
                <div>
                  <span style={{
                    fontSize: 10.5, textTransform: "uppercase", letterSpacing: ".08em",
                    color: "var(--accent)", fontWeight: 700,
                  }}>{CHANNEL_LABEL[it.channel] || it.channel}{it.tier ? ` · ${it.tier}` : ""}</span>
                  <div style={{ fontSize: 14.5, fontWeight: 650, marginTop: 3 }}>
                    {it.recipient || "(recipient)"}
                  </div>
                </div>
                <span style={{ fontSize: 11, fontWeight: 600, color: STATUS_COLOR[it.status] || "var(--text-primary)" }}>
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
                  fontSize: 12, fontStyle: "italic", color: "var(--text-secondary)",
                  borderLeft: "2px solid var(--accent-dim)", paddingLeft: 8,
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
                  background: "var(--bg-secondary)", color: "var(--text-primary)",
                  border: "1px solid var(--border)", boxSizing: "border-box",
                }}
              />

              <div style={{ display: "flex", gap: 7, flexWrap: "wrap", alignItems: "center" }}>
                {(it.recipient_url || it.evidence_url) && (
                  <a href={it.evidence_url || it.recipient_url || "#"} target="_blank" rel="noopener"
                    style={{ fontSize: 11.5, color: "var(--accent)", textDecoration: "none" }}>open ↗</a>
                )}
                <button onClick={() => copy(it)} style={btn}>{copied === it.id ? "copied" : "copy"}</button>
                <span style={{ flex: 1 }} />
                <button onClick={() => act(it, "approve")} style={{ ...btn, borderColor: "var(--green)", color: "var(--green)" }}>approve</button>
                <button onClick={() => act(it, "sent")} style={{ ...btn, borderColor: "var(--accent)", color: "var(--accent)" }}>mark sent</button>
                <button onClick={() => act(it, "skip")} style={btn}>skip</button>
              </div>
            </article>
          ))}

          {/* Delivery work: what Wing actually published for this client. */}
          {client && data.content && (
            <CrmContentFeed feed={data.content} client={client} />
          )}
        </div>
      </div>
    </div>
  );
}

const btn: React.CSSProperties = {
  fontSize: 11.5, padding: "4px 11px", borderRadius: 8, cursor: "pointer",
  border: "1px solid var(--border)", background: "transparent", color: "var(--text-primary)",
};
