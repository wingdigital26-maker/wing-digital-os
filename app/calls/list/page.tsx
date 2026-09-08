"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import SignalLinks from "../SignalLinks";
import { displayName } from "../names";

type Lead = {
  id: string;
  company: string;
  contact_name: string | null;
  contact_title: string | null;
  title: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  linkedin: string | null;
  city: string | null;
  vertical: string | null;
  employees: number | null;
  revenue: number | null;
  score: number | null;
  signals: string | null;
  status: string;
  claim: "free" | "mine" | "taken";
  claimed_by_email: string | null;
  last_outcome: string | null;
  last_called_at: string | null;
  call_count: number;
  next_action_at: string | null;
  excluded: boolean | null;
  excluded_reason: string | null;
  assigned_to_email: string | null;
  // Dial-sheet intel. All optional: the enrichment backfill lands row by row,
  // so most of these are null on most leads and the UI must simply say less.
  angle?: string | null;
  cautions?: unknown;
  chips?: unknown;
  socials?: unknown;
  google_reviews?: number | null;
  google_rating?: number | null;
  site_pages?: number | null;
  has_blog?: boolean | null;
  service_pages?: number | null;
  // Buy-likelihood tier. The column name is chosen by the enrichment pipeline
  // and reported by the API as `tierField`, so it is read dynamically.
  [key: string]: unknown;
};

type Chip = { label: string; tone: string };
type Social = { platform: string; handle: string | null; url: string | null };

// jsonb comes back parsed, but a column backfilled as text arrives as a JSON
// string. Accept both, and treat anything else as "nothing to show".
const asArray = (v: unknown): unknown[] => {
  if (Array.isArray(v)) return v;
  if (typeof v === "string" && v.trim().startsWith("[")) {
    try {
      const p = JSON.parse(v);
      return Array.isArray(p) ? p : [];
    } catch {
      return [];
    }
  }
  return [];
};

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim());

// Evidence chips: {label, tone} where tone is has | miss | neutral. A bare
// string is accepted too and rendered neutral.
const readChips = (v: unknown): Chip[] =>
  asArray(v)
    .map((c) => {
      if (typeof c === "string") return { label: c.trim(), tone: "neutral" };
      if (c && typeof c === "object") {
        const o = c as Record<string, unknown>;
        return { label: str(o.label ?? o.text ?? o.name), tone: str(o.tone) || "neutral" };
      }
      return { label: "", tone: "neutral" };
    })
    .filter((c) => c.label);

const readCautions = (v: unknown): string[] =>
  asArray(v)
    .map((c) => (typeof c === "string" ? c.trim() : str((c as Record<string, unknown>)?.text)))
    .filter(Boolean);

// Only accounts the enrichment could confirm reach this column. Anything that
// was merely name-matched belongs in cautions, so nothing here is hedged.
const readSocials = (v: unknown): Social[] =>
  asArray(v)
    .map((s) => {
      if (!s || typeof s !== "object") return null;
      const o = s as Record<string, unknown>;
      const platform = str(o.platform ?? o.network ?? o.site);
      const handle = str(o.handle ?? o.username);
      const url = str(o.url ?? o.link);
      if (!platform && !handle && !url) return null;
      return { platform: platform || "Profile", handle: handle || null, url: url || null };
    })
    .filter(Boolean) as Social[];

const chipTone = (tone: string): { fg: string; bg: string; bd: string } => {
  const t = tone.toLowerCase();
  if (t === "has" || t === "good" || t === "yes") return { fg: "#4ade80", bg: "rgba(34,197,94,0.10)", bd: "rgba(34,197,94,0.30)" };
  if (t === "miss" || t === "gap" || t === "no") return { fg: "#fbbf24", bg: "rgba(251,191,36,0.10)", bd: "rgba(251,191,36,0.30)" };
  return { fg: "var(--text-muted)", bg: "var(--bg-hover)", bd: "var(--border)" };
};

// Tier values arrive as "A" / "b" / "tier-c" / "not callable". Normalise to a
// single letter, or null when it is not one of the three callable tiers.
const readTier = (v: unknown): "A" | "B" | "C" | null => {
  const t = str(v).toUpperCase();
  const m = t.match(/(?:^|[^A-Z])([ABC])(?:$|[^A-Z])/) ?? t.match(/^([ABC])$/);
  if (t.includes("NOT")) return null;
  return (m?.[1] as "A" | "B" | "C") ?? null;
};

const TIER_META: Record<string, { label: string; tone: string }> = {
  A: { label: "A", tone: "#4ade80" },
  B: { label: "B", tone: "#38bdf8" },
  C: { label: "C", tone: "#94a3b8" },
};

// "maddox@wingdigital.co" -> "Maddox's sheet". Names come from the data, never
// a hardcoded list.
const sheetLabel = (email: string) => `${displayName(email)}'s sheet`;

// How many leads render at once. More arrive via the "Show 50 more" button --
// a phone cannot hold 500 full cards in the DOM without freezing.
const PAGE = 50;

// Some rows carry internal research dumps in the `title` field ("[factcheck
// 2026-08-22] ..."). Those are for the caller's eyes on demand, not the
// contact line. Anything long or bracket-prefixed is treated as notes.
const isResearchDump = (t: string | null): t is string =>
  !!t && (t.trim().startsWith("[") || t.length > 80);

// Strip machine tokens ("src:maps-scrape") out of the signals string before it
// is shown or linked. Returns null when nothing displayable remains.
const displaySignals = (signals: string | null): string | null => {
  if (!signals) return null;
  const parts = signals
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s && !s.toLowerCase().startsWith("src:"));
  return parts.length ? parts.join(", ") : null;
};

type Activity = {
  id: number;
  user_email: string | null;
  outcome: string;
  notes: string | null;
  created_at: string;
};

const OUTCOMES: { key: string; label: string; tone: string }[] = [
  { key: "signed", label: "Signed", tone: "#10b981" },
  { key: "booked", label: "Booked a call", tone: "#22c55e" },
  { key: "callback", label: "Call back later", tone: "#eab308" },
  { key: "contacted", label: "Spoke, no yes", tone: "#38bdf8" },
  { key: "no_answer", label: "No answer", tone: "#94a3b8" },
  { key: "not_interested", label: "Not interested", tone: "#f97316" },
  { key: "bad_number", label: "Bad number", tone: "#a78bfa" },
  { key: "dnc", label: "Do not call", tone: "#ef4444" },
];

// The outcomes that cover nearly every cold call, offered one tap deep on the
// card itself. Anything rarer (do not call, bad number, notes, a callback date)
// still lives in the panel.
const QUICK: { key: string; short: string; tone: string }[] = [
  { key: "signed", short: "Signed", tone: "#10b981" },
  { key: "booked", short: "Booked", tone: "#22c55e" },
  { key: "callback", short: "Call back", tone: "#eab308" },
  { key: "no_answer", short: "No answer", tone: "#94a3b8" },
  { key: "not_interested", short: "Not interested", tone: "#f97316" },
];

const FILTERS = [
  { key: "new", label: "Not called yet" },
  { key: "callback", label: "Call backs" },
  { key: "contacted", label: "Spoken to" },
  { key: "booked", label: "Booked" },
  { key: "signed", label: "Signed" },
  { key: "all", label: "Everything" },
];

const statusColor = (s: string) =>
  OUTCOMES.find((o) => o.key === s)?.tone ?? "#64748b";

export default function CallRoom() {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [me, setMe] = useState<{ email: string; role: string; isAdmin: boolean } | null>(null);
  const [filter, setFilter] = useState("new");
  const [assigned, setAssigned] = useState("all");
  const [assignedEmails, setAssignedEmails] = useState<string[]>([]);
  const [tier, setTier] = useState("all");
  const [tierField, setTierField] = useState<string | null>(null);
  const [tierCounts, setTierCounts] = useState<Record<string, number>>({});
  const [q, setQ] = useState("");
  const [active, setActive] = useState<Lead | null>(null);
  const [history, setHistory] = useState<Activity[]>([]);
  const [notes, setNotes] = useState("");
  const [callbackAt, setCallbackAt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [pageSize, setPageSize] = useState(PAGE);

  // Filters and search stay server-driven; changing any of them starts back at
  // the first page.
  useEffect(() => {
    setPageSize(PAGE);
  }, [filter, assigned, q, tier]);

  const load = useCallback(async () => {
    const p = new URLSearchParams({ status: filter, limit: String(pageSize), offset: "0" });
    if (assigned !== "all") p.set("assigned", assigned);
    if (tier !== "all") p.set("tier", tier);
    if (q.trim()) p.set("q", q.trim());
    const r = await fetch(`/api/calls/leads?${p}`, { cache: "no-store" });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      setError(d.error ?? "Could not load leads");
      setLoading(false);
      return;
    }
    const d = await r.json();
    // Leads that failed the quality audit are filtered out server-side by
    // /api/calls/leads (it appends excluded=is.false unless ?includeExcluded=1),
    // so both the rows AND the counts here are already dialable-only. Nothing
    // to correct client-side.
    const rows: Lead[] = d.leads ?? [];
    setLeads(rows);
    setCounts(d.counts ?? {});
    setTotal(typeof d.total === "number" ? d.total : rows.length);
    setHasMore(Boolean(d.hasMore));
    setAssignedEmails(d.assignedEmails ?? []);
    setTierField(d.tierField ?? null);
    setTierCounts(d.tierCounts ?? {});
    setMe(d.me ?? null);
    setError(null);
    setLoading(false);
  }, [filter, assigned, q, tier, pageSize]);

  useEffect(() => {
    load();
  }, [load]);

  // Refresh while idle so a caller sees what teammates are claiming in near
  // real time. Paused while a lead is open so the list cannot shuffle mid-call.
  useEffect(() => {
    if (active) return;
    const t = setInterval(load, 20000);
    return () => clearInterval(t);
  }, [active, load]);

  async function openLead(lead: Lead) {
    setError(null);
    setNotes("");
    setCallbackAt("");
    setBusy(true);
    const r = await fetch("/api/calls/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ leadId: lead.id }),
    });
    setBusy(false);
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      setError(d.error ?? "Could not open that lead");
      load();
      return;
    }
    setActive(lead);
    // Shared-password sessions get no lock. Say so instead of implying a hold.
    if (d.locked === false && d.note) setError(d.note);
    const h = await fetch(`/api/calls/disposition?leadId=${lead.id}`, { cache: "no-store" });
    setHistory(h.ok ? (await h.json()).activity ?? [] : []);
  }

  async function closeLead(release = true) {
    if (active && release) {
      await fetch("/api/calls/claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ leadId: active.id, release: true }),
      });
    }
    setActive(null);
    setHistory([]);
    load();
  }

  async function disposition(outcome: string) {
    if (!active) return;
    // A callback with no date lands in "No date set" and reminds nobody.
    // Gentle check, not a wall.
    if (outcome === "callback" && !callbackAt) {
      if (!window.confirm("Log without a date? It will not remind anyone.")) return;
    }
    setBusy(true);
    setError(null);
    const r = await fetch("/api/calls/disposition", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        leadId: active.id,
        outcome,
        notes: notes.trim() || undefined,
        nextActionAt: callbackAt ? new Date(callbackAt).toISOString() : undefined,
      }),
    });
    setBusy(false);
    const d = await r.json().catch(() => ({}));
    if (!r.ok && r.status !== 207) {
      setError(d.error ?? "Could not save that");
      return;
    }
    if (d.warning) setError(d.warning);
    setFlash(`${active.company}: ${OUTCOMES.find((o) => o.key === outcome)?.label ?? outcome}`);
    setTimeout(() => setFlash(null), 3500);
    setActive(null);
    setHistory([]);
    load();
  }

  // Log an outcome straight off the list card, the way the dial sheet does it.
  // Opening the panel to record "no answer" is three taps for the most common
  // result of a cold call, and the sheet Maddox already works needs one.
  async function quickLog(lead: Lead, outcome: string) {
    setBusy(true);
    setError(null);
    const r = await fetch("/api/calls/disposition", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ leadId: lead.id, outcome }),
    });
    setBusy(false);
    const d = await r.json().catch(() => ({}));
    if (!r.ok && r.status !== 207) {
      setError(d.error ?? "Could not save that");
      return;
    }
    setFlash(`${lead.company}: ${OUTCOMES.find((o) => o.key === outcome)?.label ?? outcome}`);
    setTimeout(() => setFlash(null), 3000);
    load();
  }

  // Everything the list card needs from the jsonb columns is derived ONCE per
  // load, keyed by lead id, so scrolling hundreds of rows never re-parses JSON.
  const derived = useMemo(() => {
    const m = new Map<string, { chips: Chip[]; cautions: number; tier: "A" | "B" | "C" | null }>();
    for (const l of leads) {
      m.set(l.id, {
        chips: readChips(l.chips).slice(0, 4),
        cautions: readCautions(l.cautions).length,
        tier: tierField ? readTier(l[tierField]) : null,
      });
    }
    return m;
  }, [leads, tierField]);

  const activeIntel = useMemo(() => {
    if (!active) return null;
    return {
      angle: str(active.angle),
      chips: readChips(active.chips),
      cautions: readCautions(active.cautions),
      socials: readSocials(active.socials),
      tier: tierField ? readTier(active[tierField]) : null,
      tierReason: tierField ? str(active[`${tierField}_reason`]) : "",
    };
  }, [active, tierField]);

  const shown = useMemo(() => leads, [leads]);

  return (
    <>
      <div>
        {/* header — sign-out and admin links live in the shared nav above */}
        <div>
          <h1 style={{ fontSize: 26, fontWeight: 800, letterSpacing: -0.5 }}>Dial list</h1>
          <p style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 4 }}>
            {me
              ? `Signed in as ${me.email}. Tap Call on a lead, dial it, log what happened.`
              : "Shared leads. Tap Call on one, dial it, log what happened."}
          </p>
        </div>

        {flash && (
          <div style={{ ...banner, background: "rgba(34,197,94,0.12)", borderColor: "rgba(34,197,94,0.4)", color: "#4ade80" }}>
            Logged: {flash}
          </div>
        )}
        {error && (
          <div style={{ ...banner, background: "rgba(239,68,68,0.12)", borderColor: "rgba(239,68,68,0.4)", color: "#f87171" }}>
            {error}
          </div>
        )}

        {/* filters */}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 20, alignItems: "center" }}>
          {FILTERS.map((f) => {
            const on = filter === f.key;
            const n = f.key === "all" ? Object.values(counts).reduce((a, b) => a + b, 0) : counts[f.key] ?? 0;
            return (
              <button key={f.key} onClick={() => setFilter(f.key)} style={{
                ...chip,
                background: on ? "linear-gradient(135deg,#3D6BF0,#1E44B8)" : "var(--bg-card)",
                borderColor: on ? "transparent" : "var(--border)",
                color: on ? "#fff" : "var(--text-muted)",
                fontWeight: on ? 700 : 500,
              }}>
                {f.label} {n > 0 && <span style={{ opacity: 0.75 }}>{n}</span>}
              </button>
            );
          })}
          {/* Buy-likelihood pills, in the same row as the status filters. They
              appear only once the enrichment has tiered at least one lead. */}
          {(Object.values(tierCounts).some((n) => n > 0) || tier !== "all") && (
            <>
              <span style={{ width: 1, alignSelf: "stretch", background: "var(--border)", margin: "0 2px" }} />
              {[{ key: "all", label: "Any tier" }, ...["A", "B", "C"].filter((t) => (tierCounts[t] ?? 0) > 0).map((t) => ({ key: t, label: `Tier ${t}` }))].map((f) => {
                const on = tier === f.key;
                const tone = TIER_META[f.key]?.tone ?? "#3D6BF0";
                const n = f.key === "all" ? null : tierCounts[f.key] ?? 0;
                return (
                  <button key={f.key} onClick={() => setTier(f.key)} style={{
                    ...chip,
                    background: on ? `${tone}22` : "var(--bg-card)",
                    borderColor: on ? tone : "var(--border)",
                    color: on ? tone : "var(--text-muted)",
                    fontWeight: on ? 700 : 500,
                  }}>
                    {f.label} {n !== null && n > 0 && <span style={{ opacity: 0.75 }}>{n}</span>}
                  </button>
                );
              })}
            </>
          )}
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search company, contact, city"
            style={{
              marginLeft: "auto", minWidth: 220, background: "var(--bg-hover)",
              border: "1px solid var(--border)", borderRadius: 10, padding: "9px 12px",
              color: "var(--text-primary)", fontSize: 13, outline: "none",
            }}
          />
        </div>

        {/* assignment filter -- only shown once at least one lead carries an
            assigned sheet. A view narrower, never a wall: everyone can pick any pill. */}
        {assignedEmails.length > 0 && (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10, alignItems: "center" }}>
            <span style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.6, color: "var(--text-muted)", fontWeight: 700 }}>
              Sheet
            </span>
            {[
              { key: "all", label: "All" },
              ...assignedEmails.map((e) => ({ key: e, label: sheetLabel(e) })),
              { key: "unassigned", label: "Unassigned" },
            ].map((f) => {
              const on = assigned === f.key;
              return (
                <button key={f.key} onClick={() => setAssigned(f.key)} title={f.key !== "all" && f.key !== "unassigned" ? f.key : undefined} style={{
                  ...chip,
                  background: on ? "linear-gradient(135deg,#a78bfa,#6d28d9)" : "var(--bg-card)",
                  borderColor: on ? "transparent" : "var(--border)",
                  color: on ? "#fff" : "var(--text-muted)",
                  fontWeight: on ? 700 : 500,
                }}>
                  {f.label}
                </button>
              );
            })}
          </div>
        )}

        {/* list */}
        <div style={{ marginTop: 18, display: "flex", flexDirection: "column", gap: 10 }}>
          {loading && <p style={{ color: "var(--text-muted)", fontSize: 13 }}>Loading leads…</p>}
          {!loading && shown.length === 0 && (
            <div style={{ ...card, textAlign: "center", padding: 40, color: "var(--text-muted)" }}>
              <p style={{ fontSize: 15, fontWeight: 600 }}>Nothing here</p>
              <p style={{ fontSize: 13, marginTop: 6 }}>
                {filter === "new"
                  ? "Every lead in this list has been called. Try another filter."
                  : "No leads match this filter yet."}
              </p>
            </div>
          )}
          {shown.map((l) => (
            <div key={l.id} style={{ ...card, display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}>
              <div
                title="Lead score: higher = more worth calling. Green from 65 up."
                style={{
                  width: 44, height: 44, borderRadius: 11, flexShrink: 0,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  background: "var(--bg-hover)", border: "1px solid var(--border)",
                  fontSize: 14, fontWeight: 800, color: (l.score ?? 0) >= 65 ? "#4ade80" : "var(--text-muted)",
                }}>{l.score ?? 0}</div>

              <div style={{ flex: "1 1 260px", minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 15, fontWeight: 700 }}>{l.company}</span>
                  <span style={{ ...pill, borderColor: statusColor(l.status), color: statusColor(l.status) }}>
                    {OUTCOMES.find((o) => o.key === l.status)?.label ?? "Not called yet"}
                  </span>
                  {l.claim === "taken" && (
                    <span style={{ ...pill, borderColor: "#f97316", color: "#f97316" }}>
                      on a call with {l.claimed_by_email ? displayName(l.claimed_by_email) : "someone"}
                    </span>
                  )}
                  {(() => {
                    const d = derived.get(l.id);
                    if (!d) return null;
                    return (
                      <>
                        {d.tier && (
                          <span
                            title="How likely they are to buy"
                            style={{ ...pill, borderColor: TIER_META[d.tier].tone, color: TIER_META[d.tier].tone }}
                          >
                            tier {d.tier}
                          </span>
                        )}
                        {d.cautions > 0 && (
                          <span
                            title={`${d.cautions} thing${d.cautions === 1 ? "" : "s"} to check before you dial`}
                            style={{ ...pill, borderColor: "#fbbf24", color: "#fbbf24" }}
                          >
                            ! check {d.cautions}
                          </span>
                        )}
                      </>
                    );
                  })()}
                </div>
                {/* Who to ask for is the first thing a caller needs and it used
                    to be one comma-separated item in a muted grey line. It gets
                    its own line, in the body colour, at the size of a thing you
                    read rather than scan. */}
                {l.contact_name ? (
                  <p style={{ fontSize: 14, marginTop: 5, fontWeight: 700 }}>
                    <span style={{ color: "var(--text-muted)", fontWeight: 600 }}>Ask for </span>
                    {l.contact_name}
                    {l.contact_title && (
                      <span style={{ color: "var(--text-muted)", fontWeight: 500 }}>
                        {" "}· {l.contact_title}
                      </span>
                    )}
                  </p>
                ) : (
                  <p style={{ fontSize: 13, marginTop: 5, color: "var(--text-muted)", fontStyle: "italic" }}>
                    No name yet, ask who handles marketing
                  </p>
                )}
                <p style={{ fontSize: 12.5, color: "var(--text-muted)", marginTop: 3 }}>
                  {[isResearchDump(l.title) ? null : l.title, l.city, l.vertical, l.employees ? `${l.employees} emp` : null]
                    .filter(Boolean).join(" · ")}
                </p>
                {(derived.get(l.id)?.chips.length ?? 0) > 0 && (
                  <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginTop: 6 }}>
                    {derived.get(l.id)!.chips.map((c, i) => {
                      const t = chipTone(c.tone);
                      return (
                        <span key={i} style={{ ...miniChip, color: t.fg, background: t.bg, borderColor: t.bd }}>
                          {c.label}
                        </span>
                      );
                    })}
                  </div>
                )}
                {isResearchDump(l.title) && (
                  <details style={{ marginTop: 5 }}>
                    <summary style={{ fontSize: 12, color: "var(--text-muted)", cursor: "pointer" }}>
                      Research notes
                    </summary>
                    <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 4, lineHeight: 1.45, whiteSpace: "pre-wrap" }}>
                      {l.title}
                    </p>
                  </details>
                )}
                {displaySignals(l.signals) && (
                  <p style={{ fontSize: 12, color: "#7dd3fc", marginTop: 5, lineHeight: 1.45 }}>
                    <SignalLinks signals={displaySignals(l.signals)!} company={l.company} city={l.city} website={l.website} />
                  </p>
                )}
                {l.call_count > 0 && (
                  <p style={{ fontSize: 11.5, color: "var(--text-muted)", marginTop: 4 }}>
                    {l.call_count} previous {l.call_count === 1 ? "attempt" : "attempts"}
                    {l.last_called_at ? ` · last ${new Date(l.last_called_at).toLocaleDateString()}` : ""}
                  </p>
                )}

                {/* One tap to record how the call went, same as the dial sheet.
                    The four that cover nearly every call; the rest, and notes,
                    stay in the panel. */}
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
                  {QUICK.map((o) => {
                    const on = l.status === o.key;
                    return (
                      <button
                        key={o.key}
                        onClick={(e) => { e.stopPropagation(); quickLog(l, o.key); }}
                        disabled={busy}
                        style={{
                          ...miniChip,
                          cursor: busy ? "not-allowed" : "pointer",
                          fontWeight: 700,
                          color: on ? "#0b1220" : o.tone,
                          background: on ? o.tone : "transparent",
                          borderColor: o.tone,
                          opacity: busy ? 0.5 : 1,
                        }}
                      >
                        {o.short}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div style={{ display: "flex", gap: 8, alignItems: "center", flexShrink: 0 }}>
                {l.phone ? (
                  <a href={`tel:${l.phone.replace(/[^+\d]/g, "")}`} style={{ ...btnGhost, fontVariantNumeric: "tabular-nums" }}>
                    {l.phone}
                  </a>
                ) : (
                  <span style={{ ...btnGhost, opacity: 0.5, cursor: "default" }}>no phone</span>
                )}
                <button
                  onClick={() => openLead(l)}
                  disabled={busy || l.claim === "taken"}
                  style={{
                    ...btnPrimary,
                    opacity: busy || l.claim === "taken" ? 0.45 : 1,
                    cursor: l.claim === "taken" ? "not-allowed" : "pointer",
                  }}
                >
                  {l.claim === "taken" ? "In use" : "Call"}
                </button>
              </div>
            </div>
          ))}

          {!loading && hasMore && (
            <button
              onClick={() => setPageSize((s) => s + PAGE)}
              style={{
                ...btnPrimary, width: "100%", minHeight: 52, marginTop: 4,
                background: "var(--bg-card)", border: "1px solid var(--border)",
                color: "var(--text-primary)", fontSize: 14,
              }}
            >
              Show {Math.min(PAGE, total - shown.length)} more ({total - shown.length} left)
            </button>
          )}
          {!loading && shown.length > 0 && (
            <p style={{ fontSize: 12, color: "var(--text-muted)", textAlign: "center", marginTop: 4 }}>
              Showing {shown.length} of {total}
            </p>
          )}
        </div>
      </div>

      {/* call panel. Portalled to <body> because the app shell puts the sticky
          header in a stacking context this component sits below -- without the
          portal a tall panel (one carrying an angle) has its top, including the
          company name, painted over by the nav. */}
      {active && createPortal(
        <div
          onClick={(e) => e.target === e.currentTarget && closeLead()}
          style={{
            position: "fixed", inset: 0, background: "rgba(0,0,0,0.65)",
            display: "flex", alignItems: "flex-end", justifyContent: "center", zIndex: 50,
            backdropFilter: "blur(3px)",
          }}
        >
          <div style={{
            width: "min(680px, 100%)", maxHeight: "92vh", overflowY: "auto",
            background: "var(--bg-card)", border: "1px solid var(--border)",
            borderRadius: "20px 20px 0 0", padding: 24,
            boxShadow: "0 -20px 60px rgba(0,0,0,0.6)",
          }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
              <div>
                <h2 style={{ fontSize: 20, fontWeight: 800 }}>{active.company}</h2>
                {/* The name he asks for, at a size he can read while the phone
                    is already ringing. */}
                {active.contact_name ? (
                  <p style={{ fontSize: 17, fontWeight: 800, marginTop: 5 }}>
                    <span style={{ color: "var(--text-muted)", fontWeight: 600, fontSize: 14 }}>Ask for </span>
                    {active.contact_name}
                  </p>
                ) : (
                  <p style={{ fontSize: 13.5, color: "var(--text-muted)", marginTop: 5, fontStyle: "italic" }}>
                    No name yet, ask who handles marketing
                  </p>
                )}
                <p style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 2 }}>
                  {[active.contact_title, isResearchDump(active.title) ? null : active.title]
                    .filter(Boolean).join(" · ")}
                </p>
              </div>
              <button onClick={() => closeLead()} style={btnGhost}>Close</button>
            </div>

            {/* The angle is the first thing on the panel because it is the last
                thing read before the call connects. */}
            {activeIntel?.angle && (
              <div style={{
                marginTop: 14, padding: "13px 15px", borderRadius: 12,
                background: "linear-gradient(135deg,rgba(61,107,240,0.16),rgba(30,68,184,0.10))",
                border: "1px solid rgba(61,107,240,0.45)",
              }}>
                <p style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.6, color: "#93b4ff", fontWeight: 700 }}>
                  Say this
                </p>
                <p style={{ fontSize: 15.5, lineHeight: 1.5, marginTop: 6, fontWeight: 600 }}>
                  {activeIntel.angle}
                </p>
              </div>
            )}

            {activeIntel?.tier && (
              <p style={{ fontSize: 12.5, color: "var(--text-muted)", marginTop: 12, lineHeight: 1.45 }}>
                <span style={{ ...pill, borderColor: TIER_META[activeIntel.tier].tone, color: TIER_META[activeIntel.tier].tone, marginRight: 7 }}>
                  tier {activeIntel.tier}
                </span>
                {activeIntel.tierReason || "How likely they are to buy."}
              </p>
            )}

            {(activeIntel?.chips.length ?? 0) > 0 && (
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 12 }}>
                {activeIntel!.chips.map((c, i) => {
                  const t = chipTone(c.tone);
                  return (
                    <span key={i} style={{ ...miniChip, fontSize: 12, padding: "5px 10px", color: t.fg, background: t.bg, borderColor: t.bd }}>
                      {c.label}
                    </span>
                  );
                })}
              </div>
            )}

            {(activeIntel?.socials.length ?? 0) > 0 && (
              <div style={{ marginTop: 14 }}>
                <p style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.6, color: "var(--text-muted)", fontWeight: 700 }}>
                  Where they post
                </p>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 7 }}>
                  {activeIntel!.socials.map((sc, i) =>
                    sc.url ? (
                      <a key={i} href={sc.url} target="_blank" rel="noreferrer" style={btnGhost}>
                        {sc.platform}{sc.handle ? ` ${sc.handle}` : ""}
                      </a>
                    ) : (
                      <span key={i} style={{ ...btnGhost, cursor: "default" }}>
                        {sc.platform}{sc.handle ? ` ${sc.handle}` : ""}
                      </span>
                    )
                  )}
                </div>
              </div>
            )}

            {isResearchDump(active.title) && (
              <details style={{ marginTop: 10 }}>
                <summary style={{ fontSize: 12.5, color: "var(--text-muted)", cursor: "pointer", fontWeight: 600 }}>
                  Research notes
                </summary>
                <p style={{ fontSize: 12.5, color: "var(--text-muted)", marginTop: 5, lineHeight: 1.5, whiteSpace: "pre-wrap" }}>
                  {active.title}
                </p>
              </details>
            )}

            {displaySignals(active.signals) && (
              <div style={{
                marginTop: 14, padding: 12, borderRadius: 10,
                background: "rgba(56,189,248,0.08)", border: "1px solid rgba(56,189,248,0.25)",
              }}>
                <p style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.6, color: "#7dd3fc", fontWeight: 700 }}>
                  Why they are worth calling
                </p>
                <p style={{ fontSize: 13, marginTop: 5, lineHeight: 1.5 }}>
                  <SignalLinks signals={displaySignals(active.signals)!} company={active.company} city={active.city} website={active.website} />
                </p>
              </div>
            )}

            {/* Facts the enrichment could NOT confirm. Directly above the phone
                button so it is impossible to dial past. */}
            {(activeIntel?.cautions.length ?? 0) > 0 && (
              <div style={{
                marginTop: 16, padding: "13px 15px", borderRadius: 12,
                background: "rgba(251,191,36,0.10)", border: "1px solid rgba(251,191,36,0.45)",
              }}>
                <p style={{ fontSize: 11.5, textTransform: "uppercase", letterSpacing: 0.6, color: "#fbbf24", fontWeight: 800 }}>
                  Check before you dial
                </p>
                <ul style={{ margin: "7px 0 0", paddingLeft: 18 }}>
                  {activeIntel!.cautions.map((c, i) => (
                    <li key={i} style={{ fontSize: 13, lineHeight: 1.5, marginTop: i ? 4 : 0 }}>{c}</li>
                  ))}
                </ul>
              </div>
            )}

            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 14 }}>
              {active.phone && (
                <a href={`tel:${active.phone.replace(/[^+\d]/g, "")}`} style={{ ...btnPrimary, textDecoration: "none" }}>
                  Call {active.phone}
                </a>
              )}
              {active.website && <a href={active.website} target="_blank" rel="noreferrer" style={btnGhost}>Website</a>}
              {active.linkedin && <a href={active.linkedin} target="_blank" rel="noreferrer" style={btnGhost}>LinkedIn</a>}
              {active.email && <a href={`mailto:${active.email}`} style={btnGhost}>{active.email}</a>}
            </div>

            {history.length > 0 && (
              <div style={{ marginTop: 18 }}>
                <p style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.6, color: "var(--text-muted)", fontWeight: 700 }}>
                  What already happened
                </p>
                <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 8 }}>
                  {history.map((h) => (
                    <div key={h.id} style={{ fontSize: 12.5, padding: 10, borderRadius: 8, background: "var(--bg-hover)" }}>
                      <span style={{ color: statusColor(h.outcome), fontWeight: 700 }}>
                        {OUTCOMES.find((o) => o.key === h.outcome)?.label ?? h.outcome}
                      </span>
                      <span style={{ color: "var(--text-muted)" }}>
                        {" "}· {displayName(h.user_email)} · {new Date(h.created_at).toLocaleString()}
                      </span>
                      {h.notes && <p style={{ marginTop: 4, lineHeight: 1.45 }}>{h.notes}</p>}
                    </div>
                  ))}
                </div>
              </div>
            )}

            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="What did they say? (optional, but the next caller will thank you)"
              rows={3}
              style={{
                width: "100%", marginTop: 16, background: "var(--bg-hover)",
                border: "1px solid var(--border)", borderRadius: 10, padding: 12,
                color: "var(--text-primary)", fontSize: 13, outline: "none",
                resize: "vertical", fontFamily: "inherit",
              }}
            />

            <div style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <label style={{ fontSize: 12, color: "var(--text-muted)" }}>Call back on</label>
              <input
                type="datetime-local"
                value={callbackAt}
                onChange={(e) => setCallbackAt(e.target.value)}
                style={{
                  background: "var(--bg-hover)", border: "1px solid var(--border)",
                  borderRadius: 8, padding: "7px 10px", color: "var(--text-primary)", fontSize: 12.5,
                }}
              />
            </div>

            <p style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.6, color: "var(--text-muted)", fontWeight: 700, marginTop: 18 }}>
              How did it go?
            </p>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 8, marginTop: 8 }}>
              {OUTCOMES.map((o) => (
                <button
                  key={o.key}
                  disabled={busy}
                  onClick={() => disposition(o.key)}
                  style={{
                    padding: "14px 12px", minHeight: 48, borderRadius: 10, cursor: busy ? "wait" : "pointer",
                    border: `1px solid ${o.tone}55`, background: `${o.tone}18`,
                    color: o.tone, fontSize: 14, fontWeight: 700, opacity: busy ? 0.6 : 1,
                  }}
                >
                  {o.label}
                </button>
              ))}
            </div>
            <p style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 12, lineHeight: 1.5 }}>
              This lead is held for you for 20 minutes so nobody double-dials it. Logging any
              outcome, including No answer, releases the hold right away. The one exception is
              Call back later, which keeps the hold for the rest of the 20 minutes so you can
              finish scheduling.
            </p>
          </div>
        </div>,
        document.body
      )}
    </>
  );
}

const card: React.CSSProperties = {
  background: "var(--bg-card)", border: "1px solid var(--border)",
  borderRadius: 14, padding: "14px 16px",
};
const chip: React.CSSProperties = {
  padding: "7px 13px", borderRadius: 999, border: "1px solid", fontSize: 12.5, cursor: "pointer",
};
const miniChip: React.CSSProperties = {
  padding: "3px 8px", borderRadius: 7, border: "1px solid",
  fontSize: 11, fontWeight: 600, lineHeight: 1.35, whiteSpace: "nowrap",
};
const pill: React.CSSProperties = {
  padding: "2px 8px", borderRadius: 999, border: "1px solid", fontSize: 10.5, fontWeight: 700,
  textTransform: "uppercase", letterSpacing: 0.4,
};
const btnPrimary: React.CSSProperties = {
  padding: "12px 18px", minHeight: 44,
  display: "inline-flex", alignItems: "center", justifyContent: "center",
  borderRadius: 10, border: "none",
  background: "linear-gradient(135deg,#3D6BF0,#1E44B8)", color: "#fff",
  fontSize: 13, fontWeight: 700, cursor: "pointer",
};
const btnGhost: React.CSSProperties = {
  padding: "8px 14px", borderRadius: 10, border: "1px solid var(--border)",
  background: "var(--bg-hover)", color: "var(--text-primary)",
  fontSize: 12.5, fontWeight: 600, cursor: "pointer", textDecoration: "none",
};
const banner: React.CSSProperties = {
  marginTop: 14, padding: "11px 14px", borderRadius: 10,
  border: "1px solid", fontSize: 13, fontWeight: 600,
};
