"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import SignalLinks from "../SignalLinks";
import { displayName } from "../names";
import CallSkeleton from "../_skeleton";

// The follow-up queue. Every lead sitting at status='callback', soonest first,
// bucketed by how urgent it is. A caller can work the queue right here: same
// claim -> dial -> log-outcome loop the dial list uses, so there is only one
// interaction pattern in the section.

type Lead = {
  id: string;
  company: string;
  contact_name: string | null;
  title: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  linkedin: string | null;
  city: string | null;
  vertical: string | null;
  employees: number | null;
  score: number | null;
  signals: string | null;
  status: string;
  claim: "free" | "mine" | "taken";
  claimed_by_email: string | null;
  last_outcome: string | null;
  last_called_at: string | null;
  call_count: number;
  next_action_at: string | null;
  excluded?: boolean | null;
  excluded_reason?: string | null;
  // Dial-sheet intel, same shape/source as the Dial list (both read
  // /api/calls/leads). Optional: enrichment backfill lands row by row, so most
  // callbacks have none of this and the UI must simply say less.
  angle?: string | null;
  cautions?: unknown;
  chips?: unknown;
  socials?: unknown;
  [key: string]: unknown;
};

type Chip = { label: string; tone: string };
type Social = { platform: string; handle: string | null; url: string | null };

// jsonb comes back parsed, but a column backfilled as text arrives as a JSON
// string. Accept both, and treat anything else as "nothing to show". (Ported
// verbatim from list/page.tsx so both screens read the same shape the same way.)
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

const isResearchDump = (t: string | null): t is string =>
  !!t && (t.trim().startsWith("[") || t.length > 80);

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
  { key: "booked", label: "Booked a call", tone: "#22c55e" },
  { key: "callback", label: "Call back later", tone: "#eab308" },
  { key: "contacted", label: "Spoke, no yes", tone: "#38bdf8" },
  { key: "no_answer", label: "No answer", tone: "#94a3b8" },
  { key: "not_interested", label: "Not interested", tone: "#f97316" },
  { key: "bad_number", label: "Bad number", tone: "#a78bfa" },
  { key: "dnc", label: "Do not call", tone: "#ef4444" },
];

const statusColor = (s: string) => OUTCOMES.find((o) => o.key === s)?.tone ?? "#64748b";

// Same one-tap set as the Dial list, so a caller working either screen sees
// the same shortcuts. "Signed" omitted here on purpose: a callback that closes
// is rare enough to warrant opening the panel and confirming, same as list.
const QUICK: { key: string; short: string; tone: string }[] = [
  { key: "booked", short: "Booked", tone: "#22c55e" },
  { key: "callback", short: "Call back", tone: "#eab308" },
  { key: "no_answer", short: "No answer", tone: "#94a3b8" },
  { key: "not_interested", short: "Not interested", tone: "#f97316" },
];

type BucketKey = "overdue" | "today" | "week" | "later" | "undated";

const BUCKETS: { key: BucketKey; label: string; tone: string; blurb: string }[] = [
  { key: "overdue", label: "Overdue", tone: "#ef4444", blurb: "The promised time has passed." },
  { key: "today", label: "Today", tone: "#eab308", blurb: "Due before the day is out." },
  { key: "week", label: "This week", tone: "#38bdf8", blurb: "Due in the next seven days." },
  { key: "later", label: "Later", tone: "#94a3b8", blurb: "Further out than a week." },
  { key: "undated", label: "No date set", tone: "#a78bfa", blurb: "Nobody said when to ring back." },
];

function bucketOf(iso: string | null, now: Date): BucketKey {
  if (!iso) return "undated";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "undated";
  if (t < now.getTime()) return "overdue";
  const endOfToday = new Date(now);
  endOfToday.setHours(23, 59, 59, 999);
  if (t <= endOfToday.getTime()) return "today";
  if (t <= endOfToday.getTime() + 6 * 86_400_000) return "week";
  return "later";
}

function dueLabel(iso: string | null, now: Date) {
  if (!iso) return "no callback time recorded";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "no callback time recorded";
  const when = new Date(t).toLocaleString(undefined, {
    weekday: "short", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit",
  });
  const diff = t - now.getTime();
  const mins = Math.round(Math.abs(diff) / 60000);
  const rel =
    mins < 60 ? `${mins} min` :
    mins < 1440 ? `${Math.round(mins / 60)} hr` :
    `${Math.round(mins / 1440)} day${Math.round(mins / 1440) === 1 ? "" : "s"}`;
  return diff < 0 ? `${when} · ${rel} late` : `${when} · in ${rel}`;
}

export default function Callbacks() {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [active, setActive] = useState<Lead | null>(null);
  const [history, setHistory] = useState<Activity[]>([]);
  const [notes, setNotes] = useState("");
  const [callbackAt, setCallbackAt] = useState("");
  // Last note per lead, so a caller has context without opening the row.
  const [context, setContext] = useState<Record<string, Activity | null>>({});
  const [now, setNow] = useState(() => new Date());

  const load = useCallback(async () => {
    const r = await fetch("/api/calls/leads?status=callback&limit=500", { cache: "no-store" });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      setError(d.error ?? "Could not load callbacks");
      setLoading(false);
      return;
    }
    const d = await r.json();
    // Leads that failed the quality audit are not callable, so they are not
    // part of the queue either.
    const rows: Lead[] = (d.leads ?? []).filter((l: Lead) => !l.excluded);
    setLeads(rows);
    setError(null);
    setLoading(false);

    // Pull the most recent activity row per callback for at-a-glance context.
    const found = await Promise.all(
      rows.map(async (l) => {
        const h = await fetch(`/api/calls/disposition?leadId=${l.id}`, { cache: "no-store" });
        if (!h.ok) return [l.id, null] as const;
        const act: Activity[] = (await h.json()).activity ?? [];
        const latest = act
          .slice()
          .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0] ?? null;
        return [l.id, latest] as const;
      })
    );
    setContext(Object.fromEntries(found));
  }, []);

  useEffect(() => { load(); }, [load]);

  // Keep the overdue/today split truthful without a reload.
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(t);
  }, []);

  const grouped = useMemo(() => {
    const sorted = leads.slice().sort((a, b) => {
      if (!a.next_action_at && !b.next_action_at) return a.company.localeCompare(b.company);
      if (!a.next_action_at) return 1;
      if (!b.next_action_at) return -1;
      return Date.parse(a.next_action_at) - Date.parse(b.next_action_at);
    });
    const out: Record<BucketKey, Lead[]> = {
      overdue: [], today: [], week: [], later: [], undated: [],
    };
    for (const l of sorted) out[bucketOf(l.next_action_at, now)].push(l);
    return out;
  }, [leads, now]);

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
    if (d.locked === false && d.note) setError(d.note);
    const h = await fetch(`/api/calls/disposition?leadId=${lead.id}`, { cache: "no-store" });
    setHistory(h.ok ? (await h.json()).activity ?? [] : []);
  }

  const closeLead = useCallback(async (release = true) => {
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
  }, [active, load]);

  // Desktop keyboard speed to match the dial list's call panel: Escape closes
  // it, same as tapping Close, and 1-4 log the same QUICK outcomes as the
  // on-screen chips. Both skip while a text field has focus, so dismissing a
  // callback date picker with Escape (or typing a digit into notes) doesn't
  // also fire a panel shortcut. disposition is in the deps so the handler
  // always sees the latest notes/callbackAt/busy.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "TEXTAREA" || tag === "INPUT") return;
      if (e.key === "Escape") {
        closeLead();
        return;
      }
      if (busy || e.repeat) return;
      const idx = Number(e.key) - 1;
      if (Number.isInteger(idx) && idx >= 0 && idx < QUICK.length) {
        disposition(QUICK[idx].key);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, busy, closeLead, disposition]);

  async function disposition(outcome: string) {
    if (!active) return;
    // A callback with no date reminds nobody. Same gentle check as the dial
    // list, so logging "call back" (tap or the "2" key) never silently drops
    // the follow-up.
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

  // Log an outcome straight off the card, same one-tap pattern as the dial list.
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

  const activeIntel = useMemo(() => {
    if (!active) return null;
    return {
      angle: str(active.angle),
      chips: readChips(active.chips),
      cautions: readCautions(active.cautions),
      socials: readSocials(active.socials),
    };
  }, [active]);

  const overdue = grouped.overdue.length;

  return (
    <>
      <div>
        <h1 style={{ fontSize: 26, fontWeight: 800, letterSpacing: -0.5 }}>Callbacks</h1>
        <p style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 4 }}>
          {loading
            ? "Loading the follow-up queue…"
            : leads.length === 0
              ? "Nobody is waiting on a call back."
              : `${leads.length} waiting${overdue > 0 ? ` · ${overdue} overdue` : ""}`}
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

      {loading && (
        <div style={{ marginTop: 20 }}>
          <CallSkeleton rows={4} height={84} />
        </div>
      )}

      {!loading && leads.length === 0 && !error && (
        <div style={{ ...card, textAlign: "center", padding: 40, color: "var(--text-muted)", marginTop: 18 }}>
          <p style={{ fontSize: 15, fontWeight: 600 }}>No callbacks scheduled yet</p>
          <p style={{ fontSize: 13, marginTop: 6, lineHeight: 1.5 }}>
            When someone logs “Call back later” on the dial list, the lead lands here with the
            time it was promised for.
          </p>
        </div>
      )}

      {BUCKETS.map((b) => {
        const rows = grouped[b.key];
        if (rows.length === 0) return null;
        const loud = b.key === "overdue";
        return (
          <section key={b.key} style={{ marginTop: 24 }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
              <h2 style={{ fontSize: 15, fontWeight: 800, color: loud ? "var(--red)" : "var(--text-primary)" }}>
                {b.label}
              </h2>
              <span style={{ ...pill, borderColor: b.tone, color: b.tone }}>{rows.length}</span>
              <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{b.blurb}</span>
            </div>

            <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 10 }}>
              {rows.map((l) => {
                const last = context[l.id];
                return (
                  <div
                    key={l.id}
                    style={{
                      ...card,
                      display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap",
                      borderColor: loud ? "color-mix(in srgb, var(--red) 55%, transparent)" : "var(--border)",
                      background: loud ? "color-mix(in srgb, var(--red) 7%, var(--bg-card))" : "var(--bg-card)",
                      borderLeft: `4px solid ${b.tone}`,
                    }}
                  >
                    <div style={{ flex: "1 1 280px", minWidth: 0 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                        <span style={{ fontSize: 15, fontWeight: 700 }}>{l.company}</span>
                        <span style={{
                          ...pill,
                          borderColor: b.tone, color: loud ? "#fff" : b.tone,
                          background: loud ? "var(--red)" : "transparent",
                        }}>
                          {loud ? "Overdue" : b.label}
                        </span>
                        {l.claim === "taken" && (
                          <span style={{ ...pill, borderColor: "#f97316", color: "#f97316" }}>
                            on a call with {l.claimed_by_email ? displayName(l.claimed_by_email) : "someone"}
                          </span>
                        )}
                      </div>

                      <p style={{
                        fontSize: 12.5, color: "var(--text-muted)", marginTop: 4,
                        fontStyle: l.contact_name ? "normal" : "italic",
                        opacity: l.contact_name ? 1 : 0.75,
                      }}>
                        {l.contact_name && (
                          <span style={{ color: "var(--text-primary)", fontWeight: 600 }}>{l.contact_name}</span>
                        )}
                        {l.contact_name && [l.title, l.city].some(Boolean) ? " · " : ""}
                        {[l.title, l.city].filter(Boolean).join(" · ")
                          || (l.contact_name ? "" : "No named contact")}
                      </p>

                      <p style={{
                        fontSize: 12.5, marginTop: 5, fontWeight: 700,
                        fontVariantNumeric: "tabular-nums",
                        color: loud ? "var(--red)" : b.tone,
                      }}>
                        {dueLabel(l.next_action_at, now)}
                      </p>

                      {last ? (
                        <div style={{
                          marginTop: 8, padding: 10, borderRadius: 9,
                          background: "var(--bg-hover)", border: "1px solid var(--border)",
                        }}>
                          <p style={{ fontSize: 11.5, color: "var(--text-muted)" }}>
                            Set by {displayName(last.user_email)} ·{" "}
                            {new Date(last.created_at).toLocaleString()}
                          </p>
                          {last.notes ? (
                            <p style={{ fontSize: 12.5, marginTop: 4, lineHeight: 1.45 }}>{last.notes}</p>
                          ) : (
                            <p style={{ fontSize: 12.5, marginTop: 4, color: "var(--text-muted)", fontStyle: "italic" }}>
                              No notes were left on that call.
                            </p>
                          )}
                        </div>
                      ) : (
                        <p style={{ fontSize: 11.5, color: "var(--text-muted)", marginTop: 6 }}>
                          No call history recorded for this lead.
                        </p>
                      )}

                      {/* One tap to record how the call went, same as the dial list. */}
                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
                        {QUICK.map((o) => (
                          <button
                            key={o.key}
                            onClick={(e) => { e.stopPropagation(); quickLog(l, o.key); }}
                            disabled={busy || l.claim === "taken"}
                            style={{
                              ...miniChip,
                              minHeight: 40, padding: "8px 14px",
                              display: "inline-flex", alignItems: "center",
                              cursor: busy || l.claim === "taken" ? "not-allowed" : "pointer",
                              fontWeight: 700, color: o.tone, background: "transparent",
                              borderColor: o.tone,
                              opacity: busy || l.claim === "taken" ? 0.5 : 1,
                            }}
                          >
                            {o.short}
                          </button>
                        ))}
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
                );
              })}
            </div>
          </section>
        );
      })}

      {/* call panel — same loop as the dial list, portalled to <body> for the
          same reason: the app shell's sticky header sits in a stacking context
          above this component, so a tall panel (one carrying an angle/chips)
          would otherwise have its top painted over by the nav. */}
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
                <p style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 3 }}>
                  {[active.contact_name, active.title].filter(Boolean).join(" · ") || "No named contact"}
                </p>
                <p style={{
                  fontSize: 12.5, marginTop: 4, fontWeight: 700,
                  fontVariantNumeric: "tabular-nums",
                  color: bucketOf(active.next_action_at, now) === "overdue" ? "var(--red)" : "var(--orange)",
                }}>
                  Call back {dueLabel(active.next_action_at, now)}
                </p>
              </div>
              <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 5, flexShrink: 0 }}>
                <button onClick={() => closeLead()} style={btnGhost}>Close</button>
                <span style={{ fontSize: 10.5, color: "var(--text-muted)", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>
                  1-{QUICK.length} log · Esc closes
                </span>
              </div>
            </div>

            {/* Say-this angle, same placement as the dial list: first thing on
                the panel because it's the last thing read before the call
                connects. Only renders when the enrichment actually reached
                this lead. */}
            {activeIntel?.angle && (
              <div style={{
                marginTop: 14, padding: "13px 15px", borderRadius: 12,
                background: "linear-gradient(135deg,rgba(61,107,240,0.16),rgba(30,68,184,0.10))",
                border: "1px solid rgba(61,107,240,0.45)",
              }}>
                <p style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.6, color: "var(--accent)", fontWeight: 700 }}>
                  Say this
                </p>
                <p style={{ fontSize: 15.5, lineHeight: 1.5, marginTop: 6, fontWeight: 600 }}>
                  {activeIntel.angle}
                </p>
              </div>
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

            {active.signals && (
              <div style={{
                marginTop: 14, padding: 12, borderRadius: 10,
                background: "rgba(56,189,248,0.08)", border: "1px solid rgba(56,189,248,0.25)",
              }}>
                <p style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.6, color: "var(--accent)", fontWeight: 700 }}>
                  Why they are worth calling
                </p>
                <p style={{ fontSize: 13, marginTop: 5, lineHeight: 1.5 }}>
                  {displaySignals(active.signals) ? (
                    <SignalLinks signals={displaySignals(active.signals)!} company={active.company} city={active.city} website={active.website} />
                  ) : active.signals}
                </p>
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
              placeholder="What did they say this time? (optional, but the next caller will thank you)"
              rows={3}
              style={{
                width: "100%", marginTop: 16, background: "var(--bg-hover)",
                border: "1px solid var(--border)", borderRadius: 10, padding: 12,
                color: "var(--text-primary)", fontSize: 13, outline: "none",
                resize: "vertical", fontFamily: "inherit",
              }}
            />

            <div style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <label style={{ fontSize: 12, color: "var(--text-muted)" }}>Move the call back to</label>
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

            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8, flexWrap: "wrap", marginTop: 18 }}>
              <p style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.6, color: "var(--text-muted)", fontWeight: 700 }}>
                How did it go?
              </p>
              <p style={{ fontSize: 11, color: "var(--text-muted)" }}>Press 1-{QUICK.length} for the marked ones</p>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 8, marginTop: 8 }}>
              {/* Numbered outcomes first, in 1-N order, matching the on-screen
                  QUICK badges/keyboard order, same layout rule as the dial list. */}
              {[...OUTCOMES].sort((a, b) => {
                const ia = QUICK.findIndex((q) => q.key === a.key);
                const ib = QUICK.findIndex((q) => q.key === b.key);
                if (ia === -1 && ib === -1) return 0;
                if (ia === -1) return 1;
                if (ib === -1) return -1;
                return ia - ib;
              }).map((o) => {
                const quickIdx = QUICK.findIndex((q) => q.key === o.key);
                return (
                  <button
                    key={o.key}
                    disabled={busy}
                    onClick={() => disposition(o.key)}
                    style={{
                      padding: "14px 12px", minHeight: 48, borderRadius: 10, cursor: busy ? "wait" : "pointer",
                      border: `1px solid ${o.tone}55`, background: `${o.tone}18`,
                      color: o.tone, fontSize: 14, fontWeight: 700, opacity: busy ? 0.6 : 1,
                      display: "flex", alignItems: "center", justifyContent: "center", gap: 7,
                    }}
                  >
                    {quickIdx >= 0 && (
                      <span style={{
                        display: "inline-flex", alignItems: "center", justifyContent: "center",
                        width: 18, height: 18, borderRadius: 5, fontSize: 11, fontWeight: 800,
                        background: `${o.tone}2a`, border: `1px solid ${o.tone}55`, flexShrink: 0,
                      }}>
                        {quickIdx + 1}
                      </span>
                    )}
                    {o.label}
                  </button>
                );
              })}
            </div>
            <p style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 12, lineHeight: 1.5 }}>
              This lead is held for you for 20 minutes so nobody double-dials it. Logging any
              outcome releases the hold right away, except Call back later, which keeps the
              hold for the rest of the 20 minutes.
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
const pill: React.CSSProperties = {
  padding: "2px 8px", borderRadius: 999, border: "1px solid", fontSize: 10.5, fontWeight: 700,
  textTransform: "uppercase", letterSpacing: 0.4,
};
const miniChip: React.CSSProperties = {
  padding: "3px 8px", borderRadius: 7, border: "1px solid",
  fontSize: 11, fontWeight: 600, lineHeight: 1.35, whiteSpace: "nowrap",
};
const btnPrimary: React.CSSProperties = {
  padding: "12px 18px", minHeight: 44,
  display: "inline-flex", alignItems: "center", justifyContent: "center",
  borderRadius: 10, border: "none",
  background: "linear-gradient(135deg,#3D6BF0,#1E44B8)", color: "#fff",
  fontSize: 13, fontWeight: 700, cursor: "pointer",
};
const btnGhost: React.CSSProperties = {
  padding: "8px 14px", minHeight: 40,
  display: "inline-flex", alignItems: "center", justifyContent: "center",
  borderRadius: 10, border: "1px solid var(--border)",
  background: "var(--bg-hover)", color: "var(--text-primary)",
  fontSize: 12.5, fontWeight: 600, cursor: "pointer", textDecoration: "none",
};
const banner: React.CSSProperties = {
  marginTop: 14, padding: "11px 14px", borderRadius: 10,
  border: "1px solid", fontSize: 13, fontWeight: 600,
};
