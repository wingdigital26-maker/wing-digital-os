"use client";
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { sfx } from "../lib/sounds";

// POTENTIAL CLIENTS -- paste a website, the OS reads it and starts a card.
//
// Talks to /api/potential-clients. The research is the OS fetching the public
// site itself (lib/siteResearch.ts): no paid API, no model. Every field the
// site did not state is null and simply not shown. "Add to CRM" creates the
// crm_contacts row and a deal in the first pipeline stage.

type Signals = {
  platform?: string;
  has_contact_form?: boolean;
  has_chat_widget?: boolean;
  has_online_booking?: boolean;
  has_ssl?: boolean;
  mobile_viewport?: boolean;
  title_length?: number | null;
  meta_description_present?: boolean;
  h1_count?: number;
  pages_found?: string[];
  load_ms?: number | null;
};

type Row = {
  id: number;
  domain: string;
  website: string;
  name: string | null;
  phone: string | null;
  email: string | null;
  city: string | null;
  state: string | null;
  trade: string | null;
  services: string[];
  socials: Record<string, string>;
  signals: Signals;
  summary: string | null;
  status: string;
  notes: string | null;
  crm_contact_id: number | null;
  researched_at: string | null;
  research_error: string | null;
  created_at: string;
};

const STATUSES: [string, string][] = [
  ["", "All"], ["new", "New"], ["researched", "Researched"], ["contacted", "Contacted"],
  ["proposal", "Proposal"], ["won", "Won"], ["lost", "Lost"],
];

const STATUS_COLOR: Record<string, string> = {
  new: "var(--text-muted)", researched: "var(--accent)", contacted: "var(--orange)",
  proposal: "var(--orange)", won: "var(--green)", lost: "var(--red)",
};

const PLATFORM_LABEL: Record<string, string> = {
  wordpress: "WordPress", wix: "Wix", squarespace: "Squarespace", gohighlevel: "GoHighLevel",
  duda: "Duda", godaddy: "GoDaddy", webflow: "Webflow", shopify: "Shopify",
};

const SOCIAL_LABEL: Record<string, string> = {
  facebook: "Facebook", instagram: "Instagram", linkedin: "LinkedIn", tiktok: "TikTok",
  youtube: "YouTube", x: "X", google: "Google", yelp: "Yelp", nextdoor: "Nextdoor",
};

const input: CSSProperties = {
  background: "var(--bg-secondary)", color: "var(--text-primary)", border: "1px solid var(--border)",
  borderRadius: 10, padding: "10px 12px", fontSize: 13.5, fontFamily: "inherit",
};
const btn: CSSProperties = {
  border: "1px solid var(--border)", background: "transparent", color: "var(--text-primary)",
  borderRadius: 9, padding: "6px 12px", fontSize: 12.5, cursor: "pointer", fontFamily: "inherit",
};
const primary: CSSProperties = {
  ...btn, border: "1px solid var(--accent)", background: "var(--accent)", color: "var(--bg-primary)", fontWeight: 700,
};

function Chip({ ok, yes, no }: { ok: boolean | undefined; yes: string; no: string }) {
  if (ok === undefined) return null;
  const c = ok ? "var(--green)" : "var(--red)";
  return (
    <span style={{ fontSize: 10.5, fontWeight: 600, color: c, border: `1px solid ${c}`, padding: "1px 8px", borderRadius: 999, opacity: 0.9 }}>
      {ok ? yes : no}
    </span>
  );
}

function formatPhone(p: string): string {
  const m = p.match(/^\+1(\d{3})(\d{3})(\d{4})$/);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : p;
}

export default function PotentialClientsBoard() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [loadErr, setLoadErr] = useState("");
  const [status, setStatus] = useState("");
  const [q, setQ] = useState("");
  const [url, setUrl] = useState("");
  const [researching, setResearching] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [addErr, setAddErr] = useState("");
  const [busyId, setBusyId] = useState<number | null>(null);
  const [rowErr, setRowErr] = useState<Record<number, string>>({});
  const [highlight, setHighlight] = useState<number | null>(null);
  const urlRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const qs = new URLSearchParams();
    if (status) qs.set("status", status);
    if (q.trim()) qs.set("q", q.trim());
    try {
      const r = await fetch(`/api/potential-clients?${qs}`);
      const d = await r.json();
      if (!r.ok) { setLoadErr(d.message || d.error || `HTTP ${r.status}`); return; }
      setRows(d.rows);
      setCounts(d.counts || {});
      setLoadErr("");
    } catch (e) {
      setLoadErr(e instanceof Error ? e.message : String(e));
    }
  }, [status, q]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!researching) { setElapsed(0); return; }
    const started = Date.now();
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 250);
    return () => clearInterval(t);
  }, [researching]);

  function upsert(row: Row) {
    setRows((rs) => {
      const list = rs ? rs.filter((r) => r.id !== row.id) : [];
      return [row, ...list];
    });
  }
  function patchLocal(id: number, patch: Partial<Row>) {
    setRows((rs) => (rs ? rs.map((r) => (r.id === id ? { ...r, ...patch } : r)) : rs));
  }

  async function add() {
    const v = url.trim();
    if (!v || researching) return;
    setAddErr("");
    setResearching(true);
    try {
      const r = await fetch("/api/potential-clients", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: v }),
      });
      const d = await r.json();
      if (r.status === 409 && d.row) {
        upsert(d.row);
        setHighlight(d.row.id);
        setAddErr(d.message || "Already on the list.");
        setStatus("");
        setUrl("");
        sfx.play("blip");
        return;
      }
      if (!r.ok || !d.row) {
        setAddErr(d.message || d.error || `HTTP ${r.status}`);
        return;
      }
      upsert(d.row);
      setHighlight(d.row.id);
      setStatus("");
      setUrl("");
      sfx.play("blip");
      load();
    } catch (e) {
      setAddErr(e instanceof Error ? e.message : String(e));
    } finally {
      setResearching(false);
    }
  }

  async function act(id: number, action: "research" | "convert") {
    setBusyId(id);
    setRowErr((m) => ({ ...m, [id]: "" }));
    try {
      const r = await fetch("/api/potential-clients", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, action }),
      });
      const d = await r.json();
      if (d.row) upsert(d.row);
      if (!r.ok && r.status !== 409) setRowErr((m) => ({ ...m, [id]: d.message || d.error || `HTTP ${r.status}` }));
      else if (d.deal_error) setRowErr((m) => ({ ...m, [id]: `Contact added, but the deal was not: ${d.deal_error}` }));
      else sfx.play("blip");
      load();
    } catch (e) {
      setRowErr((m) => ({ ...m, [id]: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusyId(null);
    }
  }

  async function save(id: number, patch: Record<string, unknown>) {
    setRowErr((m) => ({ ...m, [id]: "" }));
    try {
      const r = await fetch("/api/potential-clients", {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, ...patch }),
      });
      const d = await r.json();
      if (!r.ok) { setRowErr((m) => ({ ...m, [id]: d.message || d.error || `HTTP ${r.status}` })); return; }
      patchLocal(id, d.row);
      if (patch.status !== undefined) load();
    } catch (e) {
      setRowErr((m) => ({ ...m, [id]: e instanceof Error ? e.message : String(e) }));
    }
  }

  async function remove(id: number) {
    if (!window.confirm("Remove this potential client from the list? The CRM contact, if any, stays.")) return;
    setBusyId(id);
    try {
      const r = await fetch(`/api/potential-clients?id=${id}`, { method: "DELETE" });
      const d = await r.json();
      if (!r.ok) { setRowErr((m) => ({ ...m, [id]: d.message || d.error || `HTTP ${r.status}` })); return; }
      setRows((rs) => (rs ? rs.filter((x) => x.id !== id) : rs));
      load();
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <header style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
        <h2 style={{ margin: 0, fontSize: 18, letterSpacing: "-0.01em" }}>Potential clients</h2>
        <span style={{ fontSize: 12.5, color: "var(--text-muted)" }}>
          Paste a website. The OS reads it and starts a card. Nothing here sends anything.
        </span>
      </header>

      {/* Intake */}
      <form
        onSubmit={(e) => { e.preventDefault(); add(); }}
        style={{
          display: "flex", gap: 10, flexWrap: "wrap", alignItems: "stretch",
          background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 14, padding: 14,
        }}
      >
        <input
          ref={urlRef}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="Drop a website here, e.g. acmeroofing.com"
          disabled={researching}
          inputMode="url"
          autoComplete="off"
          style={{ ...input, flex: "1 1 260px", fontSize: 15, padding: "12px 14px" }}
        />
        <button type="submit" disabled={researching || !url.trim()} style={{ ...primary, padding: "10px 18px", fontSize: 14, opacity: researching || !url.trim() ? 0.6 : 1 }}>
          {researching ? `Reading their site... ${elapsed}s` : "Research it"}
        </button>
        {addErr && (
          <p style={{ flexBasis: "100%", margin: 0, fontSize: 12.5, color: addErr.startsWith("Already") ? "var(--orange)" : "var(--red)" }}>{addErr}</p>
        )}
      </form>

      {/* Filters */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        {STATUSES.map(([key, label]) => {
          const n = key ? counts[key] : counts.all;
          const on = status === key;
          return (
            <button key={key} type="button" onClick={() => setStatus(key)} style={{
              ...btn, padding: "4px 11px", fontSize: 12,
              border: `1px solid ${on ? "var(--accent)" : "var(--border)"}`,
              color: on ? "var(--accent)" : "var(--text-secondary)",
              background: on ? "var(--accent-glow)" : "transparent",
            }}>
              {label}{typeof n === "number" ? <span style={{ opacity: 0.7, marginLeft: 6 }}>{n}</span> : null}
            </button>
          );
        })}
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search name, city, trade"
          style={{ ...input, padding: "5px 10px", fontSize: 12.5, marginLeft: "auto", minWidth: 180 }}
        />
      </div>

      {/* List */}
      {loadErr && (
        <div style={{ border: "1px solid var(--border)", borderRadius: 14, padding: 16, background: "var(--bg-card)", display: "grid", gap: 8, maxWidth: 560 }}>
          <div style={{ fontSize: 14, fontWeight: 600 }}>Potential clients could not be loaded</div>
          <div style={{ fontSize: 13, color: "var(--red)", lineHeight: 1.5 }}>{loadErr}</div>
          <div><button type="button" onClick={load} style={btn}>Retry</button></div>
        </div>
      )}
      {!loadErr && rows === null && (
        <div style={{ display: "grid", gap: 12 }} aria-label="Loading potential clients">
          {[0, 1].map((i) => <div key={i} className="skel" style={{ height: 160, borderRadius: 14 }} />)}
        </div>
      )}
      {!loadErr && rows !== null && rows.length === 0 && (
        <p style={{ fontSize: 13.5, color: "var(--text-muted)", padding: "24px 0", textAlign: "center" }}>
          {status || q ? "Nothing matches that filter." : "No potential clients yet. Paste a website above to start one."}
        </p>
      )}
      {!loadErr && rows && rows.length > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(340px, 1fr))", gap: 12 }}>
          {rows.map((r) => (
            <Card
              key={r.id}
              row={r}
              busy={busyId === r.id}
              err={rowErr[r.id] || ""}
              highlighted={highlight === r.id}
              onAct={act}
              onSave={save}
              onRemove={remove}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function Card({ row: r, busy, err, highlighted, onAct, onSave, onRemove }: {
  row: Row;
  busy: boolean;
  err: string;
  highlighted: boolean;
  onAct: (id: number, a: "research" | "convert") => void;
  onSave: (id: number, patch: Record<string, unknown>) => void;
  onRemove: (id: number) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const [notes, setNotes] = useState(r.notes || "");
  // When the server hands back new notes (a refresh, another tab), adopt them
  // without an effect: this is the render-time "derive from prop change" form.
  const [seenNotes, setSeenNotes] = useState(r.notes);
  if (r.notes !== seenNotes) {
    setSeenNotes(r.notes);
    setNotes(r.notes || "");
  }

  const s = r.signals || {};
  const services = Array.isArray(r.services) ? r.services : [];
  const socials = r.socials && typeof r.socials === "object" ? Object.entries(r.socials) : [];
  const shown = showAll ? services : services.slice(0, 6);
  const sub = [r.trade, [r.city, r.state].filter(Boolean).join(", ")].filter(Boolean).join(" in ");
  const inCrm = r.crm_contact_id != null;
  const color = STATUS_COLOR[r.status] || "var(--text-muted)";

  return (
    <div style={{
      background: highlighted
        ? "radial-gradient(ellipse 90% 70% at 50% -20%, var(--accent-glow), transparent 60%), linear-gradient(180deg, var(--bg-card), var(--bg-card))"
        : "var(--bg-card)",
      border: `1px solid ${highlighted ? "var(--accent)" : "var(--border)"}`,
      borderRadius: 14, padding: "16px 18px", display: "flex", flexDirection: "column", gap: 10, minWidth: 0,
    }}>
      {/* Title row */}
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "flex-start" }}>
        <div style={{ minWidth: 0 }}>
          <p style={{ margin: 0, fontSize: 15, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {r.name || r.domain}
          </p>
          <p style={{ margin: 0, fontSize: 11.5, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {sub || r.domain}
          </p>
        </div>
        <select
          value={r.status}
          onChange={(e) => onSave(r.id, { status: e.target.value })}
          style={{ ...input, padding: "3px 6px", fontSize: 11.5, fontWeight: 700, color, borderColor: color, flexShrink: 0 }}
          aria-label="Status"
        >
          {STATUSES.filter(([k]) => k).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
      </div>

      {/* Contact */}
      {(r.phone || r.email) && (
        <div style={{ display: "flex", gap: 14, flexWrap: "wrap", fontSize: 12.5 }}>
          {r.phone && <a href={`tel:${r.phone}`} style={{ color: "var(--text-secondary)", textDecoration: "none" }}>{formatPhone(r.phone)}</a>}
          {r.email && <a href={`mailto:${r.email}`} style={{ color: "var(--text-secondary)", textDecoration: "none", overflow: "hidden", textOverflow: "ellipsis" }}>{r.email}</a>}
        </div>
      )}

      {/* Summary or error */}
      {r.research_error ? (
        <p style={{ margin: 0, fontSize: 12.5, color: "var(--red)", lineHeight: 1.5 }}>
          Could not read the site: {r.research_error}
        </p>
      ) : r.summary ? (
        <p style={{ margin: 0, fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.55 }}>{r.summary}</p>
      ) : !r.researched_at ? (
        <p style={{ margin: 0, fontSize: 12.5, color: "var(--text-muted)" }}>Not researched yet.</p>
      ) : null}

      {/* Signals */}
      {r.researched_at && !r.research_error && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <Chip ok={s.has_chat_widget} yes="Has chat" no="No chat" />
          <Chip ok={s.has_online_booking} yes="Online booking" no="No booking" />
          <Chip ok={s.has_contact_form} yes="Contact form" no="No form" />
          {s.has_ssl === false && <Chip ok={false} yes="" no="No SSL" />}
          {s.mobile_viewport === false && <Chip ok={false} yes="" no="Not mobile ready" />}
          {s.platform && s.platform !== "unknown" && (
            <span style={{ fontSize: 10.5, fontWeight: 600, color: "var(--text-secondary)", border: "1px solid var(--border)", padding: "1px 8px", borderRadius: 999 }}>
              {PLATFORM_LABEL[s.platform] || s.platform}
            </span>
          )}
        </div>
      )}

      {/* Socials */}
      {socials.length > 0 && (
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", fontSize: 11.5 }}>
          {socials.map(([k, href]) => (
            <a key={k} href={href} target="_blank" rel="noopener noreferrer" style={{ color: "var(--accent)", textDecoration: "none" }}>
              {SOCIAL_LABEL[k] || k}
            </a>
          ))}
        </div>
      )}

      {/* Services */}
      {services.length > 0 && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {shown.map((sv) => (
            <span key={sv} style={{ fontSize: 10.5, color: "var(--text-secondary)", background: "var(--bg-secondary)", padding: "2px 8px", borderRadius: 999 }}>{sv}</span>
          ))}
          {!showAll && services.length > 6 && (
            <button type="button" onClick={() => setShowAll(true)} style={{ ...btn, padding: "1px 8px", fontSize: 10.5, borderRadius: 999, color: "var(--accent)" }}>
              +{services.length - 6} more
            </button>
          )}
        </div>
      )}

      {/* Notes */}
      <textarea
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        onBlur={() => { if ((notes || "") !== (r.notes || "")) onSave(r.id, { notes }); }}
        placeholder="Notes (saved when you click away)"
        rows={2}
        style={{ ...input, fontSize: 12.5, padding: "7px 10px", resize: "vertical", width: "100%", boxSizing: "border-box" }}
      />

      {err && <p style={{ margin: 0, fontSize: 12, color: "var(--red)" }}>{err}</p>}

      {/* Actions */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", paddingTop: 6, borderTop: "1px solid var(--border)" }}>
        <a href={r.website} target="_blank" rel="noopener noreferrer" style={{ ...btn, textDecoration: "none", display: "inline-block" }}>Open site</a>
        <button type="button" disabled={busy} onClick={() => onAct(r.id, "research")} style={{ ...btn, opacity: busy ? 0.6 : 1 }}>
          {busy ? "Working..." : "Research again"}
        </button>
        <button
          type="button"
          disabled={busy || inCrm}
          onClick={() => onAct(r.id, "convert")}
          title={inCrm ? `CRM contact #${r.crm_contact_id}` : "Create a CRM contact and a deal in the first stage"}
          style={{ ...(inCrm ? btn : primary), opacity: busy || inCrm ? 0.6 : 1, cursor: inCrm ? "default" : "pointer" }}
        >
          {inCrm ? "In the CRM" : "Add to CRM"}
        </button>
        <button type="button" disabled={busy} onClick={() => onRemove(r.id)} style={{ ...btn, marginLeft: "auto", color: "var(--red)", borderColor: "transparent" }}>
          Remove
        </button>
      </div>
    </div>
  );
}
