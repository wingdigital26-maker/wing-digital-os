"use client";
import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";

// ───────────────────────────────────────────────────────────────────────────
// ReviewsBoard — after a job closes, ask the client for a review and track it.
//
// Top: a summary strip, one card per client with its average stars and how
// many requests turned into ratings. Middle: queue a new request for a client
// and one of their contacts. Bottom: the list of requests, each with its own
// editable detail pane (mark the ask as sent, record the star rating and the
// review text, pick where it landed, or dismiss it).
//
// NOTHING HERE SENDS. Queuing a request only records that we mean to ask this
// person; the real text or email goes out through the automations pipe, and
// only when Jack arms it. Honesty rules like every OS board: a missing table
// says "run the migration", an empty list says exactly what would fill it, and
// a client with no ratings yet shows "no rating yet", never zero stars.
// ───────────────────────────────────────────────────────────────────────────

type Review = {
  id: number;
  client_slug: string;
  contact_id: number | null;
  channel: string;
  status: "queued" | "requested" | "received" | "dismissed";
  rating: number | null;
  review_text: string | null;
  platform: string | null;
  requested_at: string | null;
  received_at: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

type Summary = {
  client_slug: string;
  requests: number;
  received: number;
  avg_rating: number | null;
};

type Payload = {
  available: boolean;
  tableMissing: boolean;
  reason: string | null;
  reviews: Review[];
  summary: Summary[];
};

const STATUS_LABEL: Record<Review["status"], string> = {
  queued: "Waiting to be asked",
  requested: "Asked",
  received: "Rated",
  dismissed: "Given up on",
};
const STATUS_COLOR: Record<Review["status"], string> = {
  queued: "var(--text-muted)",
  requested: "var(--orange)",
  received: "var(--green)",
  dismissed: "var(--red)",
};

const PLATFORM_LABEL: Record<string, string> = {
  google: "Google", facebook: "Facebook", site: "Their website", other: "Somewhere else",
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

function when(iso: string | null): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const mins = Math.round((Date.now() - t) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return days < 60 ? `${days}d ago` : new Date(t).toLocaleDateString();
}

// Read-only star row. `value` null means we have no rating, which is shown as
// hollow stars plus the words "no rating yet" by the caller, never as 0 stars.
function Stars({ value, size = 15 }: { value: number | null; size?: number }) {
  return (
    <span aria-label={value ? `${value} out of 5 stars` : "no rating yet"} style={{ fontSize: size, letterSpacing: 1, color: "var(--orange)" }}>
      {[1, 2, 3, 4, 5].map((n) => (
        <span key={n} style={{ opacity: value && n <= value ? 1 : 0.25 }}>★</span>
      ))}
    </span>
  );
}

// Clickable stars for recording a rating.
function StarPicker({ value, onPick }: { value: number | null; onPick: (n: number) => void }) {
  return (
    <span style={{ fontSize: 22, letterSpacing: 2, color: "var(--orange)", cursor: "pointer", userSelect: "none" }}>
      {[1, 2, 3, 4, 5].map((n) => (
        <span
          key={n}
          role="button"
          aria-label={`${n} star${n > 1 ? "s" : ""}`}
          onClick={() => onPick(n)}
          style={{ opacity: value && n <= value ? 1 : 0.28 }}
        >
          ★
        </span>
      ))}
    </span>
  );
}

export default function ReviewsBoard() {
  const [data, setData] = useState<Payload | null>(null);
  const [loadErr, setLoadErr] = useState("");
  const [clientFilter, setClientFilter] = useState("");

  const [newClient, setNewClient] = useState("");
  const [newContact, setNewContact] = useState("");
  const [newChannel, setNewChannel] = useState<"sms" | "email">("sms");
  const [queuing, setQueuing] = useState(false);
  const [queueErr, setQueueErr] = useState("");

  const [busyId, setBusyId] = useState<number | null>(null);
  const [rowErr, setRowErr] = useState<Record<number, string>>({});

  const load = useCallback(async () => {
    try {
      const qs = clientFilter ? `?client=${encodeURIComponent(clientFilter)}` : "";
      const r = await fetch(`/api/reviews${qs}`);
      const d = (await r.json()) as Payload & { message?: string; error?: string };
      if (!r.ok) { setLoadErr(d.message || d.error || `HTTP ${r.status}`); return; }
      setData(d);
      setLoadErr("");
    } catch (e) {
      setLoadErr(e instanceof Error ? e.message : String(e));
    }
  }, [clientFilter]);

  useEffect(() => { load(); }, [load]);

  const clients = useMemo(() => (data?.summary ?? []).map((s) => s.client_slug), [data]);

  function patchLocal(id: number, patch: Partial<Review>) {
    setData((d) => (d ? { ...d, reviews: d.reviews.map((r) => (r.id === id ? { ...r, ...patch } : r)) } : d));
  }

  async function queue() {
    const slug = newClient.trim().toLowerCase();
    if (!slug || queuing) return;
    setQueueErr("");
    setQueuing(true);
    try {
      const body: Record<string, unknown> = { client_slug: slug, channel: newChannel };
      if (newContact.trim()) body.contact_id = newContact.trim();
      const r = await fetch("/api/reviews", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const d = await r.json();
      if (!r.ok || !d.review) { setQueueErr(d.message || d.error || `HTTP ${r.status}`); return; }
      setNewContact("");
      load();
    } catch (e) {
      setQueueErr(e instanceof Error ? e.message : String(e));
    } finally {
      setQueuing(false);
    }
  }

  async function save(id: number, patch: Record<string, unknown>) {
    setBusyId(id);
    setRowErr((m) => ({ ...m, [id]: "" }));
    try {
      const r = await fetch("/api/reviews", {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, ...patch }),
      });
      const d = await r.json();
      if (!r.ok || !d.review) { setRowErr((m) => ({ ...m, [id]: d.message || d.error || `HTTP ${r.status}` })); return; }
      patchLocal(id, d.review);
      // A status or rating change moves clients between summary buckets.
      if (patch.status !== undefined || patch.rating !== undefined) load();
    } catch (e) {
      setRowErr((m) => ({ ...m, [id]: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusyId(null);
    }
  }

  async function remove(id: number) {
    if (!window.confirm("Remove this review request? This does not affect the contact.")) return;
    setBusyId(id);
    try {
      const r = await fetch(`/api/reviews?id=${id}`, { method: "DELETE" });
      const d = await r.json();
      if (!r.ok) { setRowErr((m) => ({ ...m, [id]: d.message || d.error || `HTTP ${r.status}` })); return; }
      setData((dd) => (dd ? { ...dd, reviews: dd.reviews.filter((x) => x.id !== id) } : dd));
      load();
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <header style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
        <h2 style={{ margin: 0, fontSize: 18, letterSpacing: "-0.01em" }}>Reviews</h2>
        <span style={{ fontSize: 12.5, color: "var(--text-muted)" }}>
          Ask a happy client for a review and track what comes back. Queuing a request does not send it.
        </span>
      </header>

      {/* Missing table: honest setup note, not a scary failure. */}
      {data && !data.available && data.tableMissing && (
        <div style={{ border: "1px solid var(--orange)", borderRadius: 14, padding: 16, background: "var(--bg-card)", display: "grid", gap: 6, maxWidth: 620 }}>
          <div style={{ fontSize: 14, fontWeight: 600 }}>Reviews are not set up yet</div>
          <div style={{ fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.5 }}>{data.reason}</div>
        </div>
      )}

      {/* Load failure */}
      {loadErr && (
        <div style={{ border: "1px solid var(--border)", borderRadius: 14, padding: 16, background: "var(--bg-card)", display: "grid", gap: 8, maxWidth: 560 }}>
          <div style={{ fontSize: 14, fontWeight: 600 }}>Reviews could not be loaded</div>
          <div style={{ fontSize: 13, color: "var(--red)", lineHeight: 1.5 }}>{loadErr}</div>
          <div><button type="button" onClick={load} style={btn}>Retry</button></div>
        </div>
      )}

      {/* Loading */}
      {!loadErr && data === null && (
        <div style={{ display: "grid", gap: 12 }} aria-label="Loading reviews">
          {[0, 1].map((i) => <div key={i} className="skel" style={{ height: 90, borderRadius: 14 }} />)}
        </div>
      )}

      {data && data.available && (
        <>
          {/* Per-client summary strip */}
          {data.summary.length > 0 && (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 12 }}>
              {data.summary.map((s) => {
                const on = clientFilter === s.client_slug;
                return (
                  <button
                    key={s.client_slug}
                    type="button"
                    onClick={() => setClientFilter(on ? "" : s.client_slug)}
                    style={{
                      textAlign: "left", cursor: "pointer", fontFamily: "inherit",
                      background: "var(--bg-card)", borderRadius: 14, padding: "14px 16px",
                      border: `1px solid ${on ? "var(--accent)" : "var(--border)"}`,
                      display: "flex", flexDirection: "column", gap: 6,
                    }}
                  >
                    <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text-primary)" }}>{s.client_slug}</div>
                    {s.received > 0 ? (
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <Stars value={Math.round(s.avg_rating as number)} />
                        <span style={{ fontSize: 13, color: "var(--text-secondary)", fontWeight: 600 }}>{s.avg_rating}</span>
                      </div>
                    ) : (
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <Stars value={null} />
                        <span style={{ fontSize: 12, color: "var(--text-muted)" }}>no rating yet</span>
                      </div>
                    )}
                    <div style={{ fontSize: 11.5, color: "var(--text-muted)" }}>
                      {s.received} of {s.requests} {s.requests === 1 ? "request" : "requests"} rated
                    </div>
                  </button>
                );
              })}
              {clientFilter && (
                <button type="button" onClick={() => setClientFilter("")} style={{ ...btn, alignSelf: "start" }}>
                  Show all clients
                </button>
              )}
            </div>
          )}

          {/* Queue a request */}
          <form
            onSubmit={(e) => { e.preventDefault(); queue(); }}
            style={{
              display: "flex", gap: 10, flexWrap: "wrap", alignItems: "stretch",
              background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 14, padding: 14,
            }}
          >
            <input
              value={newClient}
              onChange={(e) => setNewClient(e.target.value)}
              placeholder="Client (e.g. heros-junk)"
              list="reviews-client-list"
              autoComplete="off"
              style={{ ...input, flex: "1 1 180px" }}
            />
            <datalist id="reviews-client-list">
              {clients.map((c) => <option key={c} value={c} />)}
            </datalist>
            <input
              value={newContact}
              onChange={(e) => setNewContact(e.target.value)}
              placeholder="Contact id (optional)"
              inputMode="numeric"
              autoComplete="off"
              style={{ ...input, flex: "0 1 160px" }}
            />
            <select value={newChannel} onChange={(e) => setNewChannel(e.target.value as "sms" | "email")} style={{ ...input, flex: "0 1 120px" }} aria-label="Channel">
              <option value="sms">Text</option>
              <option value="email">Email</option>
            </select>
            <button type="submit" disabled={queuing || !newClient.trim()} style={{ ...primary, opacity: queuing || !newClient.trim() ? 0.6 : 1 }}>
              {queuing ? "Queuing..." : "Queue a request"}
            </button>
            <p style={{ flexBasis: "100%", margin: 0, fontSize: 11.5, color: "var(--text-muted)" }}>
              This adds a note to ask this contact. It does not send a text or email.
            </p>
            {queueErr && <p style={{ flexBasis: "100%", margin: 0, fontSize: 12.5, color: "var(--red)" }}>{queueErr}</p>}
          </form>

          {/* Request list */}
          {data.reviews.length === 0 ? (
            <p style={{ fontSize: 13.5, color: "var(--text-muted)", padding: "24px 0", textAlign: "center" }}>
              {clientFilter
                ? `No review requests for ${clientFilter} yet. Queue one above after a job closes.`
                : "No review requests yet. After a job closes, queue one above and it will show here."}
            </p>
          ) : (
            <div style={{ display: "grid", gap: 12 }}>
              {data.reviews.map((r) => (
                <Row
                  key={r.id}
                  row={r}
                  busy={busyId === r.id}
                  err={rowErr[r.id] || ""}
                  onSave={save}
                  onRemove={remove}
                />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Row({ row: r, busy, err, onSave, onRemove }: {
  row: Review;
  busy: boolean;
  err: string;
  onSave: (id: number, patch: Record<string, unknown>) => void;
  onRemove: (id: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(r.review_text || "");
  // Adopt server-side text changes (a refresh, another tab) without an effect.
  const [seenText, setSeenText] = useState(r.review_text);
  if (r.review_text !== seenText) {
    setSeenText(r.review_text);
    setText(r.review_text || "");
  }

  const color = STATUS_COLOR[r.status];

  return (
    <div style={{ background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 14, padding: "14px 16px", display: "flex", flexDirection: "column", gap: 10 }}>
      {/* Header row */}
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
        <div style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 4 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <span style={{ fontSize: 15, fontWeight: 700 }}>{r.client_slug}</span>
            <span style={{ fontSize: 11, fontWeight: 700, color, border: `1px solid ${color}`, padding: "1px 9px", borderRadius: 999 }}>
              {STATUS_LABEL[r.status]}
            </span>
          </div>
          <div style={{ fontSize: 11.5, color: "var(--text-muted)" }}>
            {r.contact_id != null ? `Contact #${r.contact_id}` : "No contact linked"}
            {" · "}{r.channel === "email" ? "Email" : "Text"}
            {r.requested_at ? ` · asked ${when(r.requested_at)}` : ""}
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {r.status === "received" && r.rating != null ? (
            <Stars value={r.rating} />
          ) : (
            <span style={{ fontSize: 12, color: "var(--text-muted)" }}>no rating yet</span>
          )}
          <button type="button" onClick={() => setOpen((o) => !o)} style={{ ...btn, padding: "4px 10px" }}>
            {open ? "Close" : "Update"}
          </button>
        </div>
      </div>

      {/* Existing review text, read-only when collapsed */}
      {!open && r.review_text && (
        <p style={{ margin: 0, fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.55 }}>
          &ldquo;{r.review_text}&rdquo;
          {r.platform ? <span style={{ color: "var(--text-muted)" }}> on {PLATFORM_LABEL[r.platform] || r.platform}</span> : null}
        </p>
      )}

      {/* Editable detail pane */}
      {open && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12, paddingTop: 8, borderTop: "1px solid var(--border)" }}>
          {/* Status actions */}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <span style={{ fontSize: 12, color: "var(--text-muted)", marginRight: 4 }}>Mark as:</span>
            {r.status !== "requested" && (
              <button type="button" disabled={busy} onClick={() => onSave(r.id, { status: "requested" })} style={btn}>Asked</button>
            )}
            {r.status !== "queued" && (
              <button type="button" disabled={busy} onClick={() => onSave(r.id, { status: "queued" })} style={btn}>Waiting to be asked</button>
            )}
            {r.status !== "dismissed" && (
              <button type="button" disabled={busy} onClick={() => onSave(r.id, { status: "dismissed" })} style={{ ...btn, color: "var(--red)" }}>Give up on it</button>
            )}
          </div>

          {/* Rating capture */}
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span style={{ fontSize: 12, color: "var(--text-muted)" }}>Their rating</span>
            <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
              <StarPicker value={r.rating} onPick={(n) => onSave(r.id, { rating: n, status: "received" })} />
              {r.rating != null && (
                <button type="button" disabled={busy} onClick={() => onSave(r.id, { rating: null })} style={{ ...btn, padding: "3px 9px", fontSize: 11.5 }}>
                  Clear rating
                </button>
              )}
            </div>
          </div>

          {/* Review text */}
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onBlur={() => { if ((text || "") !== (r.review_text || "")) onSave(r.id, { review_text: text }); }}
            placeholder="What they said (saved when you click away)"
            rows={2}
            style={{ ...input, fontSize: 12.5, padding: "8px 10px", resize: "vertical", width: "100%", boxSizing: "border-box" }}
          />

          {/* Platform */}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <span style={{ fontSize: 12, color: "var(--text-muted)", marginRight: 4 }}>Left on:</span>
            {(["google", "facebook", "site", "other"] as const).map((p) => {
              const on = r.platform === p;
              return (
                <button
                  key={p}
                  type="button"
                  disabled={busy}
                  onClick={() => onSave(r.id, { platform: on ? null : p })}
                  style={{
                    ...btn, padding: "4px 11px",
                    border: `1px solid ${on ? "var(--accent)" : "var(--border)"}`,
                    color: on ? "var(--accent)" : "var(--text-secondary)",
                  }}
                >
                  {PLATFORM_LABEL[p]}
                </button>
              );
            })}
          </div>

          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button type="button" disabled={busy} onClick={() => onRemove(r.id)} style={{ ...btn, color: "var(--red)", borderColor: "transparent", marginLeft: "auto" }}>
              Remove request
            </button>
          </div>
        </div>
      )}

      {err && <p style={{ margin: 0, fontSize: 12, color: "var(--red)" }}>{err}</p>}
    </div>
  );
}
