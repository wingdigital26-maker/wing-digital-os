"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import IntelProposalCard, {
  PROPOSAL_STATUSES,
  type Proposal,
} from "./IntelProposalCard";

// ───────────────────────────────────────────────────────────────────────────
// Creator intel: who Wing watches, what they proposed for Wing's own systems,
// and the raw video feed those proposals came from.
//
// Layout, top to bottom:
//   1. Header + "Last updated ... from ..." line + the two actions.
//   2. Who we watch: ONE card per creator. Name is the title, the "why we
//      watch" line sits under it, then the two or three numbers that matter
//      (videos filed, newest video, proposals waiting), then what it has
//      produced for Wing. Nothing on a card is invented: a missing field is
//      shown as missing.
//   3. Proposals: the ask-me-first gate. Approving only records a decision.
//   4. The video feed, collapsed by default, long descriptions behind "More".
//
// Readability rules for this screen: body text 13.5 to 15 px, no prose in
// monospace, generous spacing, filters stick to the top once there are more
// than eight creators to filter by.
// ───────────────────────────────────────────────────────────────────────────

type Item = {
  id: number;
  source_handle: string;
  title: string;
  url: string;
  published_at: string | null;
  summary: string | null;
  takeaway: string | null;
  actionable: boolean;
  status: string;
};

type Source = {
  id: number;
  kind: string;
  handle: string;
  name: string | null;
  channel_url: string | null;
  why: string | null;
  active: boolean;
  count: number;
};

type Totals = { total: number; new: number; reviewed: number; actioned: number; ignored: number };

type ProposalTotals = {
  total: number; proposed: number; approved: number; rejected: number; applied: number; failed: number;
};

const STATUSES = ["new", "reviewed", "actioned", "ignored"] as const;

const STATUS_COLOR: Record<string, string> = {
  new: "var(--accent)",
  reviewed: "var(--text-muted)",
  actioned: "var(--green)",
  ignored: "var(--text-muted)",
};

const STICKY_FILTERS_FROM = 8; // creators; past this the filter row sticks

function relative(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? "" : "s"} ago`;
  const days = Math.round(hrs / 24);
  if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function when(iso: string | null): string {
  if (!iso) return "date unknown";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "date unknown";
  const abs = d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  const rel = relative(iso);
  return rel && rel !== abs ? `${rel} (${abs})` : abs;
}

export default function CompetitorIntel({ onSendToAI }: { onSendToAI?: (ctx: string) => void }) {
  const [items, setItems] = useState<Item[]>([]);
  const [sources, setSources] = useState<Source[]>([]);
  const [totals, setTotals] = useState<Totals | null>(null);
  const [status, setStatus] = useState<string>("new");
  const [source, setSource] = useState<string>("");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadedAt, setLoadedAt] = useState<string | null>(null);
  const [configured, setConfigured] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<number | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [proposalTotals, setProposalTotals] = useState<ProposalTotals | null>(null);
  const [proposalStatus, setProposalStatus] = useState<string>("proposed");
  const [pBusy, setPBusy] = useState<number | null>(null);
  const [showFeed, setShowFeed] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams();
      if (status) qs.set("status", status);
      if (source) qs.set("source", source);
      if (proposalStatus) qs.set("proposalStatus", proposalStatus);
      const res = await fetch(`/api/intel?${qs.toString()}`);
      const data = await res.json();
      setConfigured(data.configured !== false);
      setError(data.error ?? "");
      setItems(data.items ?? []);
      setSources(data.sources ?? []);
      setTotals(data.totals ?? null);
      setProposals(data.proposals ?? []);
      setProposalTotals(data.proposalTotals ?? null);
      setLoadedAt(new Date().toISOString());
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [status, source, proposalStatus]);

  // Kick the fetch off after the effect body, not inside it: `load` flips the
  // loading flag synchronously, and the shell's lint forbids that in an effect.
  useEffect(() => {
    let alive = true;
    void Promise.resolve().then(() => { if (alive) void load(); });
    return () => { alive = false; };
  }, [load]);

  // Records a human decision on a proposal. Never applies the change.
  async function decide(id: number, action: "approve" | "reject" | "undo") {
    setPBusy(id);
    try {
      await fetch("/api/intel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "proposal", id, action }),
      });
      await load();
    } finally {
      setPBusy(null);
    }
  }

  async function mark(id: number, action: string) {
    setBusy(id);
    try {
      await fetch("/api/intel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, action }),
      });
      await load();
    } finally {
      setBusy(null);
    }
  }

  // Newest thing the watcher filed, across videos and proposals. This is the
  // honest "last updated": when the DATA last moved, not when this tab loaded.
  const newestData = useMemo(() => {
    let best: string | null = null;
    for (const it of items) if (it.published_at && (!best || it.published_at > best)) best = it.published_at;
    for (const p of proposals) if (p.created_at && (!best || p.created_at > best)) best = p.created_at;
    return best;
  }, [items, proposals]);

  // Per-creator facts, derived only from what is on screen.
  const perSource = useMemo(() => {
    const m = new Map<string, { newest: string | null; waiting: number; total: number }>();
    for (const s of sources) m.set(s.handle, { newest: null, waiting: 0, total: 0 });
    for (const it of items) {
      const e = m.get(it.source_handle);
      if (e && it.published_at && (!e.newest || it.published_at > e.newest)) e.newest = it.published_at;
    }
    for (const p of proposals) {
      if (!p.source_handle) continue;
      const e = m.get(p.source_handle);
      if (!e) continue;
      e.total++;
      if (p.status === "proposed") e.waiting++;
    }
    return m;
  }, [sources, items, proposals]);

  const q = search.trim().toLowerCase();
  const visibleSources = useMemo(
    () => (q ? sources.filter(s => `${s.name ?? ""} ${s.handle} ${s.why ?? ""}`.toLowerCase().includes(q)) : sources),
    [sources, q]
  );
  const visibleItems = useMemo(
    () => (q ? items.filter(i => `${i.title} ${i.summary ?? ""} ${i.source_handle}`.toLowerCase().includes(q)) : items),
    [items, q]
  );
  const sticky = sources.length > STICKY_FILTERS_FROM;

  const analyzePrompt = items.length
    ? "Here is what the AI creators Wing Digital follows published recently:\n\n" +
      items.slice(0, 20).map((i) =>
        `- ${i.title} (${i.source_handle}, ${(i.published_at || "").slice(0, 10)})\n  ${i.url}` +
        (i.summary ? `\n  ${i.summary.slice(0, 300)}` : "")
      ).join("\n\n") +
      "\n\nWing Digital builds AI-run marketing systems for local service businesses. " +
      "For each of these: is there a technique or product idea Wing should actually adopt, " +
      "or is it noise? Be blunt, and say when the answer is nothing."
    : "";

  const card: React.CSSProperties = {
    background: "var(--bg-card)",
    border: "1px solid var(--border)",
    borderRadius: 14,
    padding: 20,
  };

  const chip = (active: boolean): React.CSSProperties => ({
    padding: "7px 14px",
    borderRadius: 999,
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
    lineHeight: 1.2,
    background: active ? "var(--accent)" : "var(--bg-card)",
    color: active ? "var(--bg-card)" : "var(--text-secondary)",
    border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
  });

  const actionBtn: React.CSSProperties = {
    padding: "8px 14px",
    borderRadius: 9,
    fontSize: 13.5,
    fontWeight: 600,
    cursor: "pointer",
    background: "transparent",
    border: "1px solid var(--border)",
    color: "var(--text-secondary)",
  };

  const label: React.CSSProperties = {
    fontSize: 12,
    fontWeight: 700,
    letterSpacing: 0.5,
    textTransform: "uppercase",
    color: "var(--text-muted)",
  };

  const body: React.CSSProperties = { fontSize: 14, lineHeight: 1.6, color: "var(--text-secondary)" };

  const updatedLine = loading && !loadedAt
    ? "Loading from the Sonar database"
    : newestData
      ? `Last updated ${relative(newestData)} from the creators' public YouTube feeds, via the Sonar watcher`
      : loadedAt
        ? `Checked ${relative(loadedAt)}. Nothing has been filed yet from the creators' public YouTube feeds`
        : "";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 22, maxWidth: 980 }}>
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 260 }}>
          <h2 style={{ fontSize: 22, fontWeight: 700, color: "var(--text-primary)", letterSpacing: -0.2 }}>Creator Intel</h2>
          <p style={{ ...body, marginTop: 6, maxWidth: 620 }}>
            Wing watches a handful of AI builders. When one of them shows a technique worth stealing,
            the analyzer writes it up as a proposal, and every proposal waits here for your yes or no.
          </p>
          {updatedLine && (
            <p style={{ fontSize: 13.5, color: "var(--text-muted)", marginTop: 8 }}>{updatedLine}.</p>
          )}
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button onClick={() => void load()} style={actionBtn} disabled={loading}>{loading ? "Refreshing" : "Refresh"}</button>
          {onSendToAI && (
            <button
              onClick={() => onSendToAI(analyzePrompt)}
              disabled={!items.length}
              title={items.length ? "Send the recent videos to the assistant for a blunt read" : "Nothing to analyze yet"}
              style={{
                ...actionBtn,
                borderColor: "var(--accent)",
                color: "var(--accent)",
                opacity: items.length ? 1 : 0.45,
                cursor: items.length ? "pointer" : "not-allowed",
              }}
            >
              Send to AI
            </button>
          )}
        </div>
      </div>

      {!configured && (
        <div style={{ ...card, borderColor: "var(--orange)" }}>
          <p style={{ ...body, color: "var(--text-primary)" }}>
            Intel is not configured. The server is missing SONAR_SUPABASE_URL or SONAR_SUPABASE_SERVICE_KEY,
            so there is nothing to read.
          </p>
        </div>
      )}
      {error && (
        <div style={{ ...card, borderColor: "var(--red)" }}>
          <p style={{ ...body, color: "var(--red)", fontWeight: 600 }}>Could not load intel: {error}</p>
          <button onClick={() => void load()} style={{ ...actionBtn, marginTop: 10 }}>Try again</button>
        </div>
      )}

      {/* ── Filter / search row. Sticks once the creator list gets long. ── */}
      {sources.length > 0 && (
        <div style={{
          display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap",
          ...(sticky ? { position: "sticky", top: -24, zIndex: 3, background: "var(--bg-primary)", padding: "10px 0", margin: "-10px 0" } : {}),
        }}>
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder={sticky ? "Search creators and videos" : "Search"}
            aria-label="Search creators and videos"
            style={{
              flex: "1 1 220px", minWidth: 160, padding: "9px 14px", borderRadius: 10,
              border: "1px solid var(--border)", background: "var(--bg-card)",
              color: "var(--text-primary)", fontSize: 14, outline: "none",
            }}
          />
          {source && (
            <button onClick={() => setSource("")} style={actionBtn}>
              Showing only {sources.find(s => s.handle === source)?.name || source}. Clear
            </button>
          )}
        </div>
      )}

      {/* ── Who we watch: one card per creator ─────────────────────────── */}
      {loading && sources.length === 0 && !error && configured && (
        <div style={card}><p style={body}>Loading the watch list.</p></div>
      )}
      {!loading && configured && !error && sources.length === 0 && (
        <div style={card}>
          <p style={{ ...body, color: "var(--text-primary)", fontWeight: 600 }}>No creators are being watched</p>
          <p style={{ ...body, marginTop: 4 }}>
            The watcher has an empty source list, so it cannot file anything. Add a channel to intel_sources
            in the Sonar database and the next cloud run will start filing.
          </p>
        </div>
      )}
      {visibleSources.length > 0 && (
        <section style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
            <h3 style={{ fontSize: 17, fontWeight: 700, color: "var(--text-primary)" }}>
              Who we watch{sources.length > 1 ? ` (${sources.length})` : ""}
            </h3>
            <span style={{ fontSize: 13, color: "var(--text-muted)" }}>Tap a name to filter everything below to that creator.</span>
          </div>
          <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 300px), 1fr))" }}>
            {visibleSources.map((s) => {
              const f = perSource.get(s.handle);
              const selected = source === s.handle;
              return (
                <article
                  key={s.id}
                  style={{
                    ...card,
                    borderColor: selected ? "var(--accent)" : "var(--border)",
                    display: "flex", flexDirection: "column", gap: 12,
                  }}
                >
                  <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 10 }}>
                    <button
                      onClick={() => setSource(selected ? "" : s.handle)}
                      aria-pressed={selected}
                      style={{
                        background: "none", border: "none", padding: 0, cursor: "pointer", textAlign: "left",
                        fontSize: 17, fontWeight: 700, color: selected ? "var(--accent)" : "var(--text-primary)", lineHeight: 1.3,
                      }}
                    >
                      {s.name || s.handle}
                    </button>
                    <span style={{
                      ...label, fontSize: 11, padding: "3px 9px", borderRadius: 999, whiteSpace: "nowrap",
                      color: s.active ? "var(--green)" : "var(--orange)",
                      border: `1px solid ${s.active ? "var(--green)" : "var(--orange)"}`,
                    }}>
                      {s.active ? "watching" : "paused"}
                    </span>
                  </div>

                  {/* One-line positioning: why this creator is on the list. */}
                  <p style={{ ...body, color: "var(--text-secondary)" }}>
                    {s.why || <span style={{ color: "var(--text-muted)" }}>No note on why this creator is watched.</span>}
                  </p>

                  {/* The two or three numbers that matter. */}
                  <dl style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 10, margin: 0 }}>
                    <div>
                      <dt style={label}>Videos filed</dt>
                      <dd style={{ margin: "3px 0 0", fontSize: 16, fontWeight: 700, color: "var(--text-primary)" }}>{s.count}</dd>
                    </div>
                    <div>
                      <dt style={label}>Newest video</dt>
                      <dd style={{ margin: "3px 0 0", fontSize: 14, fontWeight: 600, color: "var(--text-primary)" }}>
                        {f?.newest ? relative(f.newest) : <span style={{ color: "var(--text-muted)", fontWeight: 500 }}>none loaded</span>}
                      </dd>
                    </div>
                    <div>
                      <dt style={label}>Waiting on you</dt>
                      <dd style={{ margin: "3px 0 0", fontSize: 16, fontWeight: 700, color: f?.waiting ? "var(--accent)" : "var(--text-primary)" }}>
                        {f?.waiting ?? 0}
                      </dd>
                    </div>
                  </dl>

                  {/* What it has produced for Wing so far. */}
                  <p style={{ fontSize: 13.5, lineHeight: 1.5, color: "var(--text-secondary)", borderTop: "1px solid var(--border)", paddingTop: 10 }}>
                    {f && f.total > 0
                      ? `${f.total} proposal${f.total === 1 ? "" : "s"} for Wing came from this creator${f.waiting ? `, ${f.waiting} still undecided` : ""}.`
                      : "Nothing from this creator has turned into a proposal for Wing yet."}
                    {s.channel_url && (
                      <>
                        {" "}
                        <a href={s.channel_url} target="_blank" rel="noreferrer" style={{ color: "var(--accent)", fontWeight: 600, textDecoration: "none" }}>
                          Open channel
                        </a>
                      </>
                    )}
                  </p>
                </article>
              );
            })}
          </div>
        </section>
      )}
      {q && sources.length > 0 && visibleSources.length === 0 && (
        <p style={{ ...body, color: "var(--text-muted)" }}>No creator matches &ldquo;{search}&rdquo;.</p>
      )}

      {/* ── Proposals: the primary content, and the ask-me-first gate ──── */}
      <section style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ display: "flex", gap: 10, alignItems: "baseline", justifyContent: "space-between", flexWrap: "wrap" }}>
          <h3 style={{ fontSize: 17, fontWeight: 700, color: "var(--text-primary)" }}>
            Proposed improvements
          </h3>
          <span style={{ fontSize: 13.5, color: "var(--text-muted)" }}>
            {proposalTotals ? `${proposalTotals.proposed} waiting on you, ${proposalTotals.total} total` : ""}
          </span>
        </div>

        <p style={{ ...body, color: "var(--text-primary)", background: "var(--bg-secondary)", borderLeft: "3px solid var(--accent)", borderRadius: "0 10px 10px 0", padding: "12px 16px" }}>
          <strong>Nothing here is applied automatically.</strong> Approving only records your decision and
          queues the change for you to apply by hand. These buttons cannot change a system, send anything,
          or run anything.
        </p>

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <button onClick={() => setProposalStatus("")} style={chip(proposalStatus === "")}>
            All{proposalTotals ? ` (${proposalTotals.total})` : ""}
          </button>
          {PROPOSAL_STATUSES.map((s) => (
            <button key={s} onClick={() => setProposalStatus(s)} style={chip(proposalStatus === s)}>
              {s === "proposed" ? "waiting on you" : s}
              {proposalTotals ? ` (${proposalTotals[s]})` : ""}
            </button>
          ))}
        </div>

        {loading && proposals.length === 0 && (
          <p style={{ ...body, color: "var(--text-muted)" }}>Loading proposals.</p>
        )}
        {!loading && proposals.length === 0 && (
          <div style={card}>
            <p style={body}>
              {proposalTotals && proposalTotals.total > 0
                ? `No proposals with status "${proposalStatus || "any"}"${source ? " from this creator" : ""}. Nothing is hidden; the other filters above hold the rest.`
                : "No proposals yet. Nothing has been analyzed into a suggested change, so there is nothing to approve. Proposals appear here only once a watched video has actually been analyzed."}
            </p>
          </div>
        )}

        {proposals.map((p) => (
          <IntelProposalCard key={p.id} p={p} busy={pBusy === p.id} onDecide={(id, a) => void decide(id, a)} />
        ))}
      </section>

      {/* ── Secondary: the raw video feed the proposals came from ──────── */}
      <section style={{ display: "flex", flexDirection: "column", gap: 14, borderTop: "1px solid var(--border)", paddingTop: 20 }}>
        <div style={{ display: "flex", gap: 10, alignItems: "baseline", justifyContent: "space-between", flexWrap: "wrap" }}>
          <div>
            <h3 style={{ fontSize: 17, fontWeight: 700, color: "var(--text-primary)" }}>
              Source videos{totals ? ` (${totals.total})` : ""}
            </h3>
            <p style={{ fontSize: 13.5, color: "var(--text-muted)", marginTop: 3 }}>
              Titles, dates and the creators&apos; own descriptions, straight off each public feed.
            </p>
          </div>
          <button onClick={() => setShowFeed(!showFeed)} style={actionBtn} aria-expanded={showFeed}>
            {showFeed ? "Hide the video feed" : "Show the video feed"}
          </button>
        </div>

        {showFeed && (
          <>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <button onClick={() => setStatus("")} style={chip(status === "")}>
                All{totals ? ` (${totals.total})` : ""}
              </button>
              {STATUSES.map((s) => (
                <button key={s} onClick={() => setStatus(s)} style={chip(status === s)}>
                  {s}{totals ? ` (${totals[s]})` : ""}
                </button>
              ))}
            </div>

            {loading && items.length === 0 && <p style={{ ...body, color: "var(--text-muted)" }}>Loading videos.</p>}
            {!loading && items.length === 0 && (
              <div style={card}>
                <p style={body}>
                  Nothing filed{status ? ` with status "${status}"` : ""}{source ? " from this creator" : ""}.
                  The watcher files new videos on each cloud run.
                </p>
              </div>
            )}
            {q && items.length > 0 && visibleItems.length === 0 && (
              <p style={{ ...body, color: "var(--text-muted)" }}>No video matches &ldquo;{search}&rdquo;.</p>
            )}

            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {visibleItems.map((it) => {
                const open = expanded === it.id;
                const long = (it.summary?.length ?? 0) > 240;
                return (
                  <article key={it.id} style={card}>
                    <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap", marginBottom: 8, fontSize: 13.5 }}>
                      <span style={{ fontWeight: 700, color: "var(--text-secondary)" }}>
                        {sources.find((s) => s.handle === it.source_handle)?.name || it.source_handle}
                      </span>
                      <span style={{ color: "var(--text-muted)" }}>{when(it.published_at)}</span>
                      <span style={{ ...label, fontSize: 11, color: STATUS_COLOR[it.status] ?? "var(--text-muted)" }}>
                        {it.status}
                      </span>
                      {it.actionable && (
                        <span style={{ ...label, fontSize: 11, color: "var(--green)" }}>actionable</span>
                      )}
                    </div>

                    <a
                      href={it.url}
                      target="_blank"
                      rel="noreferrer"
                      style={{ fontSize: 16, fontWeight: 700, color: "var(--text-primary)", textDecoration: "none", lineHeight: 1.35 }}
                    >
                      {it.title}
                    </a>

                    {it.summary ? (
                      <div style={{ marginTop: 10 }}>
                        <p style={{ ...body, whiteSpace: "pre-wrap" }}>
                          {open || !long ? it.summary : `${it.summary.slice(0, 240).trimEnd()}...`}
                        </p>
                        {long && (
                          <button
                            onClick={() => setExpanded(open ? null : it.id)}
                            aria-expanded={open}
                            style={{ ...actionBtn, border: "none", padding: "4px 0", color: "var(--accent)", fontSize: 13.5 }}
                          >
                            {open ? "Less" : "More"}
                          </button>
                        )}
                      </div>
                    ) : (
                      <p style={{ ...body, color: "var(--text-muted)", marginTop: 10, fontStyle: "italic" }}>
                        No description published with this video.
                      </p>
                    )}

                    {it.takeaway && (
                      <p style={{ ...body, color: "var(--text-primary)", marginTop: 12, paddingLeft: 12, borderLeft: "3px solid var(--accent)" }}>
                        {it.takeaway}
                      </p>
                    )}

                    <div style={{ display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap" }}>
                      <a href={it.url} target="_blank" rel="noreferrer"
                         style={{ ...actionBtn, borderColor: "var(--accent)", color: "var(--accent)", textDecoration: "none" }}>
                        Watch
                      </a>
                      <button disabled={busy === it.id} onClick={() => void mark(it.id, "reviewed")} style={actionBtn}>
                        Reviewed
                      </button>
                      <button
                        disabled={busy === it.id}
                        onClick={() => void mark(it.id, "actioned")}
                        style={{ ...actionBtn, borderColor: "var(--green)", color: "var(--green)" }}
                      >
                        Actioned
                      </button>
                      <button
                        disabled={busy === it.id}
                        onClick={() => void mark(it.id, "ignored")}
                        style={{ ...actionBtn, borderColor: "var(--orange)", color: "var(--orange)" }}
                      >
                        Ignore
                      </button>
                      {it.status !== "new" && (
                        <button disabled={busy === it.id} onClick={() => void mark(it.id, "new")} style={actionBtn}>
                          Undo
                        </button>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
          </>
        )}
      </section>
    </div>
  );
}
