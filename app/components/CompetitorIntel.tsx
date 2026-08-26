"use client";

import { useCallback, useEffect, useState } from "react";

// ───────────────────────────────────────────────────────────────────────────
// Creator / competitor intel — what the AI builders Wing follows just shipped.
//
// Fed by /api/intel (Supabase `intel_items`, filled from free YouTube RSS).
// Every field on screen came off the creator's own feed: title, publish date,
// their own description. Nothing is machine-summarized, so an empty summary
// stays empty rather than being filled with a guess. The takeaway is Jack's to
// write. Kept from the old panel: "Ask Claude to Analyze", which hands the
// current list to the assistant instead of pretending to interpret it here.
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

const STATUSES = ["new", "reviewed", "actioned", "ignored"] as const;

const STATUS_COLOR: Record<string, string> = {
  new: "var(--accent)",
  reviewed: "var(--text-muted)",
  actioned: "var(--green)",
  ignored: "var(--text-muted)",
};

function when(iso: string | null): string {
  if (!iso) return "date unknown";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "date unknown";
  const days = Math.floor((Date.now() - d.getTime()) / 86400000);
  const abs = d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  if (days <= 0) return `today · ${abs}`;
  if (days === 1) return `yesterday · ${abs}`;
  if (days < 30) return `${days}d ago · ${abs}`;
  return abs;
}

export default function CompetitorIntel({ onSendToAI }: { onSendToAI?: (ctx: string) => void }) {
  const [items, setItems] = useState<Item[]>([]);
  const [sources, setSources] = useState<Source[]>([]);
  const [totals, setTotals] = useState<Totals | null>(null);
  const [status, setStatus] = useState<string>("new");
  const [source, setSource] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [configured, setConfigured] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<number | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams();
      if (status) qs.set("status", status);
      if (source) qs.set("source", source);
      const res = await fetch(`/api/intel?${qs.toString()}`);
      const data = await res.json();
      setConfigured(data.configured !== false);
      setError(data.error ?? "");
      setItems(data.items ?? []);
      setSources(data.sources ?? []);
      setTotals(data.totals ?? null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [status, source]);

  useEffect(() => { void load(); }, [load]);

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
    borderRadius: 12,
    padding: 16,
  };

  const chip = (active: boolean): React.CSSProperties => ({
    padding: "5px 12px",
    borderRadius: 999,
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
    background: active ? "var(--accent)" : "transparent",
    color: active ? "var(--bg-card)" : "var(--text-secondary)",
    border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
  });

  const actionBtn: React.CSSProperties = {
    padding: "6px 12px",
    borderRadius: 8,
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
    background: "transparent",
    border: "1px solid var(--border)",
    color: "var(--text-secondary)",
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 980 }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
        <div>
          <h2 style={{ fontSize: 18, fontWeight: 700, color: "var(--text-primary)" }}>Creator Intel</h2>
          <p style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 4 }}>
            New videos from the AI builders Wing follows. Titles, dates and descriptions come
            straight off each channel&apos;s public feed — no summary is written for you.
          </p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={() => void load()} style={actionBtn}>Refresh</button>
          {onSendToAI && (
            <button
              onClick={() => onSendToAI(analyzePrompt)}
              disabled={!items.length}
              style={{
                ...actionBtn,
                borderColor: "var(--accent)",
                color: "var(--accent)",
                opacity: items.length ? 1 : 0.4,
                cursor: items.length ? "pointer" : "not-allowed",
              }}
            >
              Ask Claude to Analyze
            </button>
          )}
        </div>
      </div>

      {!configured && (
        <div style={{ ...card, borderColor: "var(--orange)" }}>
          <p style={{ fontSize: 13, color: "var(--text-primary)" }}>
            Intel is not configured — SONAR_SUPABASE_URL / SONAR_SUPABASE_SERVICE_KEY are missing.
          </p>
        </div>
      )}
      {error && (
        <div style={{ ...card, borderColor: "var(--red)" }}>
          <p style={{ fontSize: 13, color: "var(--red)", fontWeight: 600 }}>{error}</p>
        </div>
      )}

      {/* Who we watch, and why. */}
      {sources.length > 0 && (
        <div style={{ ...card, display: "flex", flexDirection: "column", gap: 10 }}>
          <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.6, textTransform: "uppercase", color: "var(--text-muted)" }}>
            Watching
          </span>
          {sources.map((s) => (
            <div key={s.id} style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
              <button
                onClick={() => setSource(source === s.handle ? "" : s.handle)}
                style={chip(source === s.handle)}
              >
                {s.name || s.handle}
              </button>
              <span style={{ fontSize: 12, color: "var(--text-secondary)", flex: 1, minWidth: 220 }}>
                {s.why || `@${s.handle}`}
              </span>
              <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{s.count} filed</span>
              {!s.active && <span style={{ fontSize: 12, color: "var(--orange)" }}>paused</span>}
            </div>
          ))}
        </div>
      )}

      {/* Status filter. */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <button onClick={() => setStatus("")} style={chip(status === "")}>
          All{totals ? ` (${totals.total})` : ""}
        </button>
        {STATUSES.map((s) => (
          <button key={s} onClick={() => setStatus(s)} style={chip(status === s)}>
            {s}{totals ? ` (${totals[s]})` : ""}
          </button>
        ))}
        {source && (
          <button onClick={() => setSource("")} style={{ ...actionBtn, marginLeft: "auto" }}>
            Clear source filter
          </button>
        )}
      </div>

      {loading && <p style={{ fontSize: 13, color: "var(--text-muted)" }}>Loading…</p>}
      {!loading && items.length === 0 && (
        <div style={card}>
          <p style={{ fontSize: 13, color: "var(--text-muted)" }}>
            Nothing here. The watcher (intel_watch.py) files new videos on each cloud run.
          </p>
        </div>
      )}

      {/* The feed. */}
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {items.map((it) => {
          const open = expanded === it.id;
          const long = (it.summary?.length ?? 0) > 220;
          return (
            <div key={it.id} style={card}>
              <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap", marginBottom: 6 }}>
                <span style={{ fontSize: 12, fontWeight: 700, color: "var(--text-secondary)" }}>
                  {sources.find((s) => s.handle === it.source_handle)?.name || it.source_handle}
                </span>
                <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{when(it.published_at)}</span>
                <span style={{
                  fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5,
                  color: STATUS_COLOR[it.status] ?? "var(--text-muted)",
                }}>
                  {it.status}
                </span>
                {it.actionable && (
                  <span style={{ fontSize: 11, fontWeight: 700, color: "var(--green)" }}>actionable</span>
                )}
              </div>

              <a
                href={it.url}
                target="_blank"
                rel="noreferrer"
                style={{ fontSize: 15, fontWeight: 700, color: "var(--text-primary)", textDecoration: "none", lineHeight: 1.35 }}
              >
                {it.title}
              </a>

              {it.summary ? (
                <p style={{ fontSize: 13, color: "var(--text-secondary)", marginTop: 8, whiteSpace: "pre-wrap", lineHeight: 1.5 }}>
                  {open || !long ? it.summary : `${it.summary.slice(0, 220)}…`}
                  {long && (
                    <button
                      onClick={() => setExpanded(open ? null : it.id)}
                      style={{ ...actionBtn, border: "none", padding: "0 6px", color: "var(--accent)" }}
                    >
                      {open ? "less" : "more"}
                    </button>
                  )}
                </p>
              ) : (
                <p style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 8, fontStyle: "italic" }}>
                  No description published with this video.
                </p>
              )}

              {it.takeaway && (
                <p style={{
                  fontSize: 13, color: "var(--text-primary)", marginTop: 10,
                  paddingLeft: 10, borderLeft: "2px solid var(--accent)",
                }}>
                  {it.takeaway}
                </p>
              )}

              <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
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
            </div>
          );
        })}
      </div>
    </div>
  );
}
