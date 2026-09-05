"use client";
import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";

// CUSTOMERS -- the surface a client's review / text / email campaign runs from.
//
// Staff pick a client, import that client's PAST customers (paste CSV), see the
// client's customer list, select some or all, and queue a REVIEW REQUEST to
// them. Draft-safe: queuing a review request only records the intent to ask.
// NOTHING sends from this screen -- a separate armed sender delivers, and only
// when the OS send switch is on.
//
// Talks to:
//   GET  /api/clients               -> populate the client dropdown
//   POST /api/crm/import            -> { ok, added, updated, skipped, total }
//   GET  /api/crm/customers         -> this client's contacts
//   POST /api/reviews               -> queue one review request per selected contact

type ClientOpt = { slug: string; name: string };

type Customer = {
  id: number;
  business_name: string | null;
  contact_name: string | null;
  email: string | null;
  phone: string | null;
  city: string | null;
  source: string | null;
  do_not_contact: boolean | null;
  created_at: string;
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

function formatPhone(p: string): string {
  const digits = p.replace(/[^\d]/g, "");
  const m = digits.match(/^1?(\d{3})(\d{3})(\d{4})$/);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : p;
}

export default function CustomersBoard() {
  const [clients, setClients] = useState<ClientOpt[] | null>(null);
  const [clientsErr, setClientsErr] = useState("");
  const [slug, setSlug] = useState("");

  const [rows, setRows] = useState<Customer[] | null>(null);
  const [loadErr, setLoadErr] = useState("");
  const [reason, setReason] = useState(""); // schema-missing explanation from the API
  const [capped, setCapped] = useState(false);
  const [q, setQ] = useState("");

  const [showImport, setShowImport] = useState(false);
  const [csv, setCsv] = useState("");
  const [importing, setImporting] = useState(false);
  const [importErr, setImportErr] = useState("");
  const [importResult, setImportResult] = useState<{ added: number; updated: number; skipped: number; total: number } | null>(null);

  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [queueing, setQueueing] = useState(false);
  const [queueMsg, setQueueMsg] = useState("");
  const [queueErr, setQueueErr] = useState("");

  // Load the client roster once.
  useEffect(() => {
    (async () => {
      try {
        const r = await fetch("/api/clients");
        const d = await r.json();
        if (!r.ok) { setClientsErr(d.error || d.message || `HTTP ${r.status}`); return; }
        const opts: ClientOpt[] = (d.clients || [])
          .filter((c: { slug?: string; name?: string }) => c.slug)
          .map((c: { slug: string; name: string }) => ({ slug: c.slug, name: c.name || c.slug }));
        setClients(opts);
      } catch (e) {
        setClientsErr(e instanceof Error ? e.message : String(e));
      }
    })();
  }, []);

  const load = useCallback(async () => {
    if (!slug) { setRows(null); return; }
    const qs = new URLSearchParams({ client_slug: slug });
    if (q.trim()) qs.set("q", q.trim());
    try {
      const r = await fetch(`/api/crm/customers?${qs}`);
      const d = await r.json();
      if (!r.ok) { setLoadErr(d.message || d.error || `HTTP ${r.status}`); setReason(""); return; }
      if (d.available === false) {
        setRows([]);
        setReason(d.reason || "This client's customers are not available yet.");
        setCapped(false);
        setLoadErr("");
        return;
      }
      setRows(d.customers || []);
      setReason("");
      setCapped(!!d.capped);
      setLoadErr("");
    } catch (e) {
      setLoadErr(e instanceof Error ? e.message : String(e));
    }
  }, [slug, q]);

  useEffect(() => { load(); }, [load]);

  // Clear selection + transient messages whenever the client changes.
  useEffect(() => {
    setSelected(new Set());
    setQueueMsg("");
    setQueueErr("");
    setImportResult(null);
    setImportErr("");
  }, [slug]);

  const selectable = useMemo(() => (rows || []).filter((r) => r.do_not_contact !== true), [rows]);
  const allSelected = selectable.length > 0 && selectable.every((r) => selected.has(r.id));

  function toggle(id: number) {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  function toggleAll() {
    setSelected(() => (allSelected ? new Set() : new Set(selectable.map((r) => r.id))));
  }

  async function runImport() {
    const body = csv.trim();
    if (!slug || !body || importing) return;
    setImporting(true);
    setImportErr("");
    setImportResult(null);
    try {
      const r = await fetch("/api/crm/import", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_slug: slug, csv: body }),
      });
      const d = await r.json();
      if (!r.ok || d.ok === false) {
        setImportErr(d.message || d.error || `HTTP ${r.status}`);
        return;
      }
      setImportResult({
        added: Number(d.added) || 0,
        updated: Number(d.updated) || 0,
        skipped: Number(d.skipped) || 0,
        total: Number(d.total) || 0,
      });
      setCsv("");
      load();
    } catch (e) {
      setImportErr(e instanceof Error ? e.message : String(e));
    } finally {
      setImporting(false);
    }
  }

  async function queueReviews() {
    if (!slug || selected.size === 0 || queueing) return;
    setQueueing(true);
    setQueueMsg("");
    setQueueErr("");
    const targets = selectable.filter((r) => selected.has(r.id));
    let ok = 0;
    const failures: string[] = [];
    for (const c of targets) {
      const channel = c.phone ? "sms" : "email";
      try {
        const r = await fetch("/api/reviews", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ client_slug: slug, contact_id: c.id, channel }),
        });
        const d = await r.json();
        if (!r.ok || d.ok === false || d.missingTable) {
          failures.push(d.message || d.error || `HTTP ${r.status}`);
        } else {
          ok += 1;
        }
      } catch (e) {
        failures.push(e instanceof Error ? e.message : String(e));
      }
    }
    setQueueing(false);
    if (ok > 0) {
      setQueueMsg(`Queued ${ok} review request${ok === 1 ? "" : "s"}. They stay drafts until the OS send switch is on.`);
      setSelected(new Set());
    }
    if (failures.length) {
      // Show the first distinct failure so the message stays honest and short.
      setQueueErr(`${failures.length} could not be queued: ${failures[0]}`);
    }
  }

  const total = rows?.length ?? 0;
  const dncCount = (rows || []).filter((r) => r.do_not_contact === true).length;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <header style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
        <h2 style={{ margin: 0, fontSize: 18, letterSpacing: "-0.01em" }}>Customers</h2>
        <span style={{ fontSize: 12.5, color: "var(--text-muted)" }}>
          Pick a client, import their past customers, then queue review requests. Nothing sends from here.
        </span>
      </header>

      {/* Client picker */}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        {clientsErr ? (
          <span style={{ fontSize: 12.5, color: "var(--red)" }}>Clients could not be loaded: {clientsErr}</span>
        ) : clients === null ? (
          <span style={{ fontSize: 12.5, color: "var(--text-muted)" }}>Loading clients...</span>
        ) : (
          <select
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            aria-label="Client"
            style={{ ...input, minWidth: 240, fontSize: 14 }}
          >
            <option value="">Pick a client...</option>
            {clients.map((c) => <option key={c.slug} value={c.slug}>{c.name}</option>)}
          </select>
        )}
        {slug && (
          <button type="button" onClick={() => setShowImport((v) => !v)} style={btn}>
            {showImport ? "Hide import" : "Import past customers"}
          </button>
        )}
      </div>

      {/* No client picked */}
      {!slug && (
        <p style={{ fontSize: 13.5, color: "var(--text-muted)", padding: "24px 0", textAlign: "center" }}>
          Pick a client above to see their customers and run a review campaign.
        </p>
      )}

      {/* Import box */}
      {slug && showImport && (
        <div style={{ background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 14, padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ fontSize: 13.5, fontWeight: 600 }}>Import past customers</div>
          <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>
            Paste a CSV of this client's past customers. A header row with columns like
            business_name, contact_name, email, phone, city is expected. Rows are tagged to this client.
          </div>
          <textarea
            value={csv}
            onChange={(e) => setCsv(e.target.value)}
            placeholder={"business_name,contact_name,email,phone,city\nAcme Co,Jane Doe,jane@acme.com,555-123-4567,Plano"}
            rows={6}
            disabled={importing}
            style={{ ...input, fontSize: 12.5, fontFamily: "ui-monospace, monospace", resize: "vertical", width: "100%", boxSizing: "border-box" }}
          />
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <button type="button" disabled={importing || !csv.trim()} onClick={runImport} style={{ ...primary, opacity: importing || !csv.trim() ? 0.6 : 1 }}>
              {importing ? "Importing..." : "Import"}
            </button>
            {importResult && (
              <span style={{ fontSize: 12.5, color: "var(--green)" }}>
                Added {importResult.added}, updated {importResult.updated}, skipped {importResult.skipped} of {importResult.total} rows.
              </span>
            )}
            {importErr && <span style={{ fontSize: 12.5, color: "var(--red)" }}>{importErr}</span>}
          </div>
        </div>
      )}

      {/* Persistent draft-safe note */}
      {slug && (
        <div style={{ fontSize: 12, color: "var(--text-secondary)", background: "var(--bg-secondary)", border: "1px solid var(--border)", borderRadius: 10, padding: "8px 12px" }}>
          Review requests are queued only. They do not go out from this screen. A separate armed sender delivers them, and only when the OS send switch is on.
        </div>
      )}

      {/* Search + select-all + queue action */}
      {slug && (
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          {selectable.length > 0 && (
            <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12.5, color: "var(--text-secondary)", cursor: "pointer" }}>
              <input type="checkbox" checked={allSelected} onChange={toggleAll} />
              Select all ({selectable.length})
            </label>
          )}
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search name, email, phone"
            style={{ ...input, padding: "5px 10px", fontSize: 12.5, minWidth: 180 }}
          />
          <button
            type="button"
            disabled={queueing || selected.size === 0}
            onClick={queueReviews}
            style={{ ...primary, marginLeft: "auto", opacity: queueing || selected.size === 0 ? 0.6 : 1 }}
          >
            {queueing ? "Queuing..." : `Request a review from selected (${selected.size})`}
          </button>
        </div>
      )}

      {(queueMsg || queueErr) && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {queueMsg && <p style={{ margin: 0, fontSize: 12.5, color: "var(--green)" }}>{queueMsg}</p>}
          {queueErr && <p style={{ margin: 0, fontSize: 12.5, color: "var(--red)" }}>{queueErr}</p>}
        </div>
      )}

      {/* List / states */}
      {slug && loadErr && (
        <div style={{ border: "1px solid var(--border)", borderRadius: 14, padding: 16, background: "var(--bg-card)", display: "grid", gap: 8, maxWidth: 560 }}>
          <div style={{ fontSize: 14, fontWeight: 600 }}>Customers could not be loaded</div>
          <div style={{ fontSize: 13, color: "var(--red)", lineHeight: 1.5 }}>{loadErr}</div>
          <div><button type="button" onClick={load} style={btn}>Retry</button></div>
        </div>
      )}

      {slug && !loadErr && reason && (
        <div style={{ border: "1px solid var(--orange)", borderRadius: 14, padding: 16, background: "var(--bg-card)", fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.55, maxWidth: 620 }}>
          {reason}
        </div>
      )}

      {slug && !loadErr && !reason && rows === null && (
        <div style={{ display: "grid", gap: 8 }} aria-label="Loading customers">
          {[0, 1, 2].map((i) => <div key={i} className="skel" style={{ height: 44, borderRadius: 10 }} />)}
        </div>
      )}

      {slug && !loadErr && !reason && rows !== null && rows.length === 0 && (
        <p style={{ fontSize: 13.5, color: "var(--text-muted)", padding: "24px 0", textAlign: "center" }}>
          {q ? "No customers match that search." : "No customers imported yet. Paste their past-customer list above."}
        </p>
      )}

      {slug && !loadErr && !reason && rows && rows.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
            {total} customer{total === 1 ? "" : "s"}
            {dncCount > 0 ? ` (${dncCount} opted out and cannot be selected)` : ""}
            {capped ? ". Showing the first 500." : ""}
          </div>
          <div style={{ border: "1px solid var(--border)", borderRadius: 14, overflow: "hidden" }}>
            {rows.map((c, i) => {
              const dnc = c.do_not_contact === true;
              const on = selected.has(c.id);
              const name = c.business_name || c.contact_name || c.email || c.phone || `Contact #${c.id}`;
              const sub = [c.contact_name && c.business_name ? c.contact_name : null, c.city].filter(Boolean).join(" - ");
              return (
                <div
                  key={c.id}
                  style={{
                    display: "flex", gap: 12, alignItems: "center", padding: "10px 14px",
                    borderTop: i === 0 ? "none" : "1px solid var(--border)",
                    background: on ? "var(--accent-glow)" : "transparent",
                    opacity: dnc ? 0.6 : 1,
                  }}
                >
                  <input
                    type="checkbox"
                    checked={on}
                    disabled={dnc}
                    onChange={() => toggle(c.id)}
                    aria-label={`Select ${name}`}
                    style={{ flexShrink: 0 }}
                  />
                  <div style={{ minWidth: 0, flex: "1 1 200px" }}>
                    <div style={{ fontSize: 13.5, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {name}
                      {dnc && (
                        <span style={{ fontSize: 10.5, fontWeight: 700, color: "var(--red)", border: "1px solid var(--red)", padding: "1px 7px", borderRadius: 999, marginLeft: 8 }}>
                          Do not contact
                        </span>
                      )}
                    </div>
                    {sub && <div style={{ fontSize: 11.5, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{sub}</div>}
                  </div>
                  <div style={{ display: "flex", gap: 14, flexWrap: "wrap", fontSize: 12, color: "var(--text-secondary)", flex: "1 1 220px", minWidth: 0 }}>
                    {c.phone && <span>{formatPhone(c.phone)}</span>}
                    {c.email && <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{c.email}</span>}
                    {c.source && <span style={{ color: "var(--text-muted)" }}>{c.source}</span>}
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
