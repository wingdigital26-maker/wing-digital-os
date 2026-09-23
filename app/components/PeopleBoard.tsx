"use client";
import { useEffect, useMemo, useState, type CSSProperties } from "react";

// CRM > PEOPLE -- who is potentially going to get an email.
//
// Added 2026-09-22 when Jack cut Activity and Contacts out of the CRM: "This
// should be like the call room, basically: call room plus people that are
// potentially going to email." So this is deliberately the call room's
// ergonomics, not the old everything-grid -- a dense scannable list you read
// top to bottom, with the one fact that matters per row (can we actually reach
// this address) sitting where the dial outcome sits in the call room.
//
// Reads /api/people (prospects.db, email-bearing rows only). Nothing on this
// screen sends. Arming, not status, is what makes a lead sendable, so the
// header says how many are armed rather than implying the list is queued.

type Person = {
  id: number;
  name: string;
  contact_name: string | null;
  contact_title: string | null;
  email: string;
  email_status: string | null;
  email_reason: string | null;
  phone: string | null;
  website: string | null;
  city: string | null;
  state: string | null;
  trade: string | null;
  vertical: string | null;
  tier: string | null;
  status: string | null;
  google_reviews: number | null;
  google_rating: number | null;
  intent_score: number | null;
  owner_name: string | null;
  emailed_at: string | null;
  called_at: string | null;
  updated_at: string | null;
};

type Feed = {
  people: Person[];
  total: number | null;
  armed?: number;
  emailed?: number;
  shown?: number;
  source?: string;
  error?: string;
  message?: string;
};

// Address quality, straight from the enricher. "ok" is the only one worth
// sending to blind; the rest are shown as they are rather than hidden, because
// a risky address you can see is a decision and one you cannot is a surprise.
const QUALITY: Record<string, { label: string; color: string }> = {
  ok: { label: "deliverable", color: "var(--green)" },
  "site-scrape": { label: "off their site", color: "var(--accent)" },
  risky: { label: "risky", color: "#eab308" },
  bad: { label: "bad", color: "#f87171" },
};

const FILTERS = [
  { id: "all", label: "Everyone" },
  { id: "ok", label: "Deliverable" },
  { id: "risky", label: "Risky" },
  { id: "armed", label: "Armed to send" },
  { id: "emailed", label: "Already emailed" },
  { id: "untouched", label: "Never emailed" },
] as const;
type FilterId = (typeof FILTERS)[number]["id"];

const pill = (on: boolean): CSSProperties => ({
  border: `1px solid ${on ? "var(--accent)" : "var(--border)"}`,
  background: on ? "var(--accent)" : "transparent",
  color: on ? "var(--bg-primary)" : "var(--text-muted)",
  borderRadius: 999, padding: "5px 12px", fontSize: 12, fontWeight: on ? 700 : 600,
  cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap",
});

function relative(iso: string | null): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const days = Math.floor((Date.now() - then) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

export default function PeopleBoard() {
  const [feed, setFeed] = useState<Feed | null>(null);
  const [err, setErr] = useState("");
  const [filter, setFilter] = useState<FilterId>("all");
  const [q, setQ] = useState("");

  useEffect(() => {
    let live = true;
    fetch("/api/people", { cache: "no-store" })
      .then(r => r.json())
      .then((d: Feed) => { if (live) setFeed(d); })
      .catch(e => { if (live) setErr(e?.message || "Could not reach the people list."); });
    return () => { live = false; };
  }, []);

  const rows = useMemo(() => {
    const all = feed?.people ?? [];
    const needle = q.trim().toLowerCase();
    return all.filter(p => {
      if (filter === "ok" && p.email_status !== "ok") return false;
      if (filter === "risky" && p.email_status !== "risky") return false;
      if (filter === "armed" && p.trade !== "b2b") return false;
      if (filter === "emailed" && !p.emailed_at) return false;
      if (filter === "untouched" && p.emailed_at) return false;
      if (!needle) return true;
      return [p.name, p.contact_name, p.email, p.city, p.trade, p.owner_name]
        .some(v => v && String(v).toLowerCase().includes(needle));
    });
  }, [feed, filter, q]);

  // Counts sit on the pills so the shape of the book is readable without
  // clicking through all six.
  const counts = useMemo(() => {
    const all = feed?.people ?? [];
    return {
      all: all.length,
      ok: all.filter(p => p.email_status === "ok").length,
      risky: all.filter(p => p.email_status === "risky").length,
      armed: all.filter(p => p.trade === "b2b").length,
      emailed: all.filter(p => p.emailed_at).length,
      untouched: all.filter(p => !p.emailed_at).length,
    } as Record<FilterId, number>;
  }, [feed]);

  const unreachable = feed?.source === "local-db-unavailable" || feed?.source === "pc-required";

  return (
    <div style={{ maxWidth: 1080, margin: "0 auto", padding: "8px 4px", display: "flex", flexDirection: "column", gap: 14 }}>
      <header style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
        <h2 style={{ fontSize: 19, fontWeight: 800, letterSpacing: "-0.01em" }}>People</h2>
        <p style={{ fontSize: 12.5, color: "var(--text-muted)" }}>
          Everyone in the book with an email address. Nothing sends from this screen.
        </p>
      </header>

      {/* One honest line about the shape of the list, or about why there is no
          list. A count of 0 and an unreachable database must never look alike. */}
      {err || unreachable ? (
        <p style={{ fontSize: 13, color: "var(--text-muted)", border: "1px solid var(--border)", borderRadius: 10, padding: "12px 14px" }}>
          {err || feed?.message || "The people list lives in prospects.db on Jack's PC and is not reachable from here."}
          {feed?.error ? <span style={{ display: "block", marginTop: 4, fontSize: 11.5, opacity: 0.8 }}>{feed.error}</span> : null}
        </p>
      ) : feed ? (
        <p style={{ fontSize: 12.5, color: "var(--text-muted)" }}>
          {feed.total != null && feed.shown != null && feed.shown < feed.total
            ? `Showing the top ${feed.shown.toLocaleString()} of ${feed.total.toLocaleString()} with an address`
            : `${(feed.total ?? rows.length).toLocaleString()} with an address`}
          {typeof feed.armed === "number" ? ` · ${feed.armed.toLocaleString()} armed to send` : ""}
          {typeof feed.emailed === "number" ? ` · ${feed.emailed.toLocaleString()} emailed so far` : ""}
        </p>
      ) : (
        <p style={{ fontSize: 12.5, color: "var(--text-muted)" }}>Reading the book...</p>
      )}

      {feed && !unreachable && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          {FILTERS.map(f => (
            <button key={f.id} type="button" onClick={() => setFilter(f.id)}
              style={pill(filter === f.id)} aria-pressed={filter === f.id}>
              {f.label}{counts[f.id] != null ? ` ${counts[f.id].toLocaleString()}` : ""}
            </button>
          ))}
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search name, address, city"
            style={{
              marginLeft: "auto", minWidth: 220, flex: "0 1 280px",
              background: "var(--bg-secondary)", color: "var(--text-primary)",
              border: "1px solid var(--border)", borderRadius: 10,
              padding: "7px 11px", fontSize: 13, fontFamily: "inherit",
            }} />
        </div>
      )}

      {feed && !unreachable && (
        rows.length === 0 ? (
          <p style={{ fontSize: 13, color: "var(--text-muted)", padding: "18px 2px" }}>
            Nobody matches that. Clear the search or pick a different filter.
          </p>
        ) : (
          <ul style={{ listStyle: "none", display: "flex", flexDirection: "column", border: "1px solid var(--border)", borderRadius: 12, overflow: "hidden" }}>
            {rows.map((p, i) => {
              const quality = p.email_status ? QUALITY[p.email_status] : null;
              return (
                <li key={p.id} style={{
                  display: "grid",
                  gridTemplateColumns: "minmax(0,1.5fr) minmax(0,1.4fr) auto",
                  gap: 12, alignItems: "center", padding: "10px 14px",
                  borderTop: i === 0 ? "none" : "1px solid var(--border)",
                  background: i % 2 ? "var(--bg-card)" : "transparent",
                }}>
                  <div style={{ minWidth: 0 }}>
                    <p style={{ fontSize: 13.5, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {p.name}
                    </p>
                    <p style={{ fontSize: 11.5, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {[p.contact_name || p.owner_name, p.contact_title, [p.city, p.state].filter(Boolean).join(", ")]
                        .filter(Boolean).join(" · ") || "no contact name yet"}
                    </p>
                  </div>
                  <div style={{ minWidth: 0 }}>
                    <a href={`mailto:${p.email}`} style={{ fontSize: 12.5, color: "var(--accent)", textDecoration: "none", display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {p.email}
                    </a>
                    <p style={{ fontSize: 11, color: "var(--text-muted)", display: "flex", gap: 7, alignItems: "center" }}>
                      {quality ? <span style={{ color: quality.color, fontWeight: 700 }}>{quality.label}</span>
                               : <span>address not checked</span>}
                      {p.trade === "b2b" ? <span>{"· armed"}</span> : null}
                    </p>
                  </div>
                  <div style={{ textAlign: "right", fontSize: 11, color: "var(--text-muted)", whiteSpace: "nowrap" }}>
                    {p.emailed_at
                      ? <span>emailed {relative(p.emailed_at)}</span>
                      : <span style={{ opacity: 0.75 }}>never emailed</span>}
                  </div>
                </li>
              );
            })}
          </ul>
        )
      )}
    </div>
  );
}
