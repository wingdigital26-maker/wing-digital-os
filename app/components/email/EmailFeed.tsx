"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Avatar, Chip, FilterPill, HeaderLine, ListShell, MailPanes, Note,
  fullWhen, inputStyle, label, selectStyle, when,
} from "./ui";

// ───────────────────────────────────────────────────────────────────────────
// EmailFeed — every email Wing sends, in one list, live.
//
// This is the CRM's front door. Jack's ask was literal: "I want to see all
// the emails that are going out. That's really what I want," and "emails need
// to be easier for me to look at." So it is built the way a mail client is
// built, not the way a dashboard is: a scannable list on the left, the whole
// email rendered on the right, j/k to move, one compact toolbar of filters
// that each carry their own count.
//
// The rows come from /api/email/feed, which merges the cold campaign sender,
// the one-to-one ledger and the approved queue and reports each lane's health
// separately. A lane that is down prints its own reason here, word for word —
// a dead lane never renders as "no emails".
//
// LIVE, WITHOUT A LIGHT. /api/messages/stream holds an SSE connection open and
// pushes new and changed rows; they simply appear, with a one-second highlight
// so a row that arrived while you were reading is not silent. There is no
// green dot and no "live" badge anywhere on this screen, on purpose. If the
// stream drops, the component falls back to a plain poll and says so in the
// one place it matters: the line under the toolbar.
//
// NOTHING ON THIS SCREEN SENDS. It is a reader.
// ───────────────────────────────────────────────────────────────────────────

type FeedState =
  | "sent" | "queued" | "scheduled" | "failed" | "bounced"
  | "replied" | "received" | "draft" | "unknown";

type Item = {
  key: string;
  lane: "cold" | "ledger" | "approved";
  laneLabel: string;
  direction: "out" | "in";
  to: string | null; from: string | null;
  name: string | null; company: string | null;
  subject: string;
  html: string | null; text: string; snippet: string;
  state: FeedState; stateNote: string | null;
  campaign: string | null; campaignId: string | null;
  step: string | null;
  at: string;
  opens: number | null; clicks: number | null; replies: number | null;
  error: string | null;
};

type Lane = { id: string; label: string; available: boolean; reason: string | null; count: number };

type Campaign = {
  id: string; name: string; state: string | null;
  sent: number | null; opens: number | null; clicks: number | null;
  replies: number | null; bounces: number | null; unsubscribes: number | null;
};

type Payload = {
  items: Item[]; lanes: Lane[]; campaigns: Campaign[];
  anyAvailable: boolean; emptyNote: string | null; trackingNote: string | null;
  fetchedAt: string;
};

// Every state Jack asked to filter by, in the order he said them, plus the two
// the data can actually produce beyond that list. Tone comes from OS tokens.
const STATES: { id: FeedState; name: string; tone: string }[] = [
  { id: "queued", name: "Queued", tone: "var(--orange)" },
  { id: "scheduled", name: "Scheduled", tone: "var(--orange)" },
  { id: "sent", name: "Sent", tone: "var(--text-secondary)" },
  { id: "replied", name: "Replied", tone: "var(--green)" },
  { id: "failed", name: "Failed", tone: "var(--red)" },
  { id: "bounced", name: "Bounced", tone: "var(--red)" },
  { id: "received", name: "Received", tone: "var(--accent)" },
  { id: "draft", name: "Draft", tone: "var(--text-muted)" },
  { id: "unknown", name: "Unrecognized", tone: "var(--text-muted)" },
];

function stateTone(s: FeedState): string {
  return STATES.find((x) => x.id === s)?.tone ?? "var(--text-muted)";
}
function stateName(s: FeedState): string {
  return STATES.find((x) => x.id === s)?.name ?? s;
}

const RANGES = [
  { id: "all", name: "Any time", ms: null as number | null },
  { id: "1", name: "Today", ms: 24 * 3600_000 },
  { id: "7", name: "7 days", ms: 7 * 24 * 3600_000 },
  { id: "30", name: "30 days", ms: 30 * 24 * 3600_000 },
];

/** Best display name, in the order a human reads a row. Never invented. */
function who(i: Item): string {
  return i.name || i.company || (i.direction === "in" ? i.from : i.to) || "unknown address";
}

function matches(q: string, i: Item): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  return [i.name, i.company, i.to, i.from, i.subject, i.text, i.campaign]
    .some((f) => f && f.toLowerCase().includes(needle));
}

// The one-second highlight on a row that arrived while you were looking at the
// screen. This is how the feed shows it is live: behavior, not a badge.
const FLASH_CSS = `
@keyframes wingMailArrive {
  from { background: var(--accent-glow); }
  to   { background: transparent; }
}
.wing-mail-row-new { animation: wingMailArrive 1.4s ease-out 1; }
@media (prefers-reduced-motion: reduce) { .wing-mail-row-new { animation: none; } }
.wing-mail-body a { color: var(--accent); }
.wing-mail-body img { max-width: 100%; height: auto; }
.wing-mail-body table { border-collapse: collapse; max-width: 100%; }
.wing-mail-body td, .wing-mail-body th { padding: 4px 8px; border: 1px solid var(--border); }
.wing-mail-body blockquote {
  margin: 8px 0; padding-left: 10px; border-left: 2px solid var(--border);
  color: var(--text-muted);
}
`;

export default function EmailFeed() {
  const [data, setData] = useState<Payload | null>(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [state, setState] = useState<FeedState | "all">("all");
  const [campaign, setCampaign] = useState("all");
  const [range, setRange] = useState("all");
  // Null while the stream is doing its job. A string once it is not, so the
  // degraded mode is stated rather than hidden.
  const [degraded, setDegraded] = useState<string | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(() => new Set());
  const listRef = useRef<HTMLDivElement | null>(null);

  // ── Plain read, used for the manual refresh and as the poll fallback ──────
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/email/feed?limit=100", { cache: "no-store" });
      const j = (await res.json()) as Payload;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData(j);
      setErr("");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  // ── The live connection ──────────────────────────────────────────────────
  // Snapshot on connect, then append/patch as things move. On failure this
  // degrades to a 30-second poll instead of going quietly stale.
  useEffect(() => {
    let es: EventSource | null = null;
    let poll: ReturnType<typeof setInterval> | null = null;
    let dead = false;

    const flash = (keys: string[]) => {
      setFresh((f) => {
        const n = new Set(f);
        for (const k of keys) n.add(k);
        return n;
      });
      window.setTimeout(() => {
        if (dead) return;
        setFresh((f) => {
          const n = new Set(f);
          for (const k of keys) n.delete(k);
          return n;
        });
      }, 1600);
    };

    const startPolling = (reason: string) => {
      if (dead || poll) return;
      setDegraded(reason);
      void load();
      poll = setInterval(() => { void load(); }, 30_000);
    };

    try {
      es = new EventSource("/api/messages/stream");
    } catch {
      startPolling("The live connection could not be opened in this browser, so the feed is refreshing every 30 seconds instead.");
      return () => { dead = true; if (poll) clearInterval(poll); };
    }

    es.addEventListener("snapshot", (ev) => {
      if (dead) return;
      setData(JSON.parse((ev as MessageEvent).data) as Payload);
      setLoading(false);
      setErr("");
      setDegraded(null);
    });

    es.addEventListener("append", (ev) => {
      if (dead) return;
      const { items, fetchedAt } = JSON.parse((ev as MessageEvent).data) as { items: Item[]; fetchedAt: string };
      setData((d) => {
        if (!d) return d;
        const known = new Set(d.items.map((i) => i.key));
        const add = items.filter((i) => !known.has(i.key));
        if (!add.length) return { ...d, fetchedAt };
        return {
          ...d, fetchedAt,
          items: [...add, ...d.items].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)),
        };
      });
      flash(items.map((i) => i.key));
    });

    es.addEventListener("patch", (ev) => {
      if (dead) return;
      const { items, fetchedAt } = JSON.parse((ev as MessageEvent).data) as { items: Item[]; fetchedAt: string };
      const byKey = new Map(items.map((i) => [i.key, i]));
      setData((d) => d && { ...d, fetchedAt, items: d.items.map((i) => byKey.get(i.key) ?? i) });
      flash(items.map((i) => i.key));
    });

    es.addEventListener("lanes", (ev) => {
      if (dead) return;
      const { lanes, campaigns, fetchedAt } = JSON.parse((ev as MessageEvent).data) as
        { lanes: Lane[]; campaigns: Campaign[]; fetchedAt: string };
      setData((d) => d && { ...d, lanes, campaigns, fetchedAt });
    });

    es.addEventListener("failed", (ev) => {
      if (dead) return;
      const { reason } = JSON.parse((ev as MessageEvent).data) as { reason: string };
      setDegraded(`The last live read failed: ${reason}. The connection is still open and will try again.`);
    });

    // The server hangs up on purpose after 30 minutes; EventSource reconnects
    // on its own, so this is not a degraded state.
    es.addEventListener("bye", () => { setDegraded(null); });

    es.onerror = () => {
      if (dead) return;
      // readyState 2 means the browser gave up. Anything else is a reconnect
      // in flight, which needs no fallback and no message.
      if (es && es.readyState === 2) {
        startPolling("The live connection dropped and did not come back, so the feed is refreshing every 30 seconds instead.");
      }
    };

    return () => {
      dead = true;
      if (es) es.close();
      if (poll) clearInterval(poll);
    };
  }, [load]);

  const items = useMemo(() => data?.items ?? [], [data]);

  // ── Filtering. Counts are computed against everything EXCEPT the state
  // filter, so a pill's number never changes just because you clicked it.
  // The date window is measured from the payload's own fetch time rather than
  // from the clock, so a re-render can never quietly move the boundary.
  const preState = useMemo(() => {
    const cut = RANGES.find((r) => r.id === range)?.ms ?? null;
    const anchor = Date.parse(data?.fetchedAt ?? "");
    const floor = cut == null || Number.isNaN(anchor) ? null : anchor - cut;
    return items.filter((i) =>
      matches(search, i) &&
      (campaign === "all" || (i.campaignId ?? i.campaign ?? "none") === campaign) &&
      (floor == null || Date.parse(i.at) >= floor)
    );
  }, [items, search, campaign, range, data?.fetchedAt]);

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const i of preState) c[i.state] = (c[i.state] ?? 0) + 1;
    return c;
  }, [preState]);

  const visible = useMemo(
    () => (state === "all" ? preState : preState.filter((i) => i.state === state)),
    [preState, state]
  );

  // Opening on the newest email is what every mail client does, and it means
  // the reading pane is never an empty box on arrival. Derived, not written
  // from an effect: the first row can change under us as the stream pushes.
  const active = useMemo(
    () => (selected && visible.some((i) => i.key === selected) ? selected : visible[0]?.key ?? null),
    [selected, visible]
  );

  const current = useMemo(
    () => visible.find((i) => i.key === active) ?? items.find((i) => i.key === active) ?? null,
    [visible, items, active]
  );

  // ── Keyboard: j/k and the arrows walk the list, Enter opens, Esc clears ───
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      const down = e.key === "j" || e.key === "ArrowDown";
      const up = e.key === "k" || e.key === "ArrowUp";
      if (!down && !up && e.key !== "Enter" && e.key !== "Escape") return;
      if (e.key === "Escape") { setSelected(null); return; }
      if (!visible.length) return;
      const idx = visible.findIndex((i) => i.key === active);
      if (e.key === "Enter") {
        // On a narrow screen the reading pane is below the list, so Enter has
        // to actually move the eye to it.
        document.getElementById("wing-mail-reader")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
        return;
      }
      e.preventDefault();
      const next = down
        ? Math.min(visible.length - 1, idx < 0 ? 0 : idx + 1)
        : Math.max(0, idx <= 0 ? 0 : idx - 1);
      const key = visible[next]?.key ?? null;
      setSelected(key);
      if (key) {
        listRef.current
          ?.querySelector(`[data-key="${CSS.escape(key)}"]`)
          ?.scrollIntoView({ block: "nearest" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [visible, active]);

  const campaignOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const i of items) {
      const id = i.campaignId ?? i.campaign ?? null;
      if (id && !seen.has(id)) seen.set(id, i.campaign ?? id);
    }
    return Array.from(seen, ([id, name]) => ({ id, name }));
  }, [items]);

  if (loading && !data) {
    return (
      <div style={{ display: "grid", gap: 10 }} aria-label="Loading the email feed">
        <div className="skel" style={{ height: 24, width: 200, borderRadius: 8 }} />
        <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
          <div style={{ display: "grid", gap: 8, flex: "1 1 380px" }}>
            {[0, 1, 2, 3, 4, 5].map((i) => <div key={i} className="skel" style={{ height: 58, borderRadius: 10 }} />)}
          </div>
          <div className="skel" style={{ flex: "2 1 460px", minHeight: 320, borderRadius: 14 }} />
        </div>
      </div>
    );
  }

  if (err && !data) {
    return (
      <Note tone="var(--red)"
        text={`The email feed could not be read: ${err}. Nothing below is available, and that is a failure, not an empty inbox.`} />
    );
  }
  if (!data) return null;

  const brokenLanes = data.lanes.filter((l) => !l.available);
  const liveLanes = data.lanes.filter((l) => l.available);

  // ── List ─────────────────────────────────────────────────────────────────
  const list = (
    <div ref={listRef} style={{ display: "grid", gap: 8, minWidth: 0 }}>
      <ListShell>
        {visible.length === 0 ? (
          <div style={{ padding: "18px 16px", fontSize: 12.5, color: "var(--text-muted)", lineHeight: 1.6 }}>
            {items.length === 0
              ? (data.emptyNote ??
                 "No email is readable from any working lane right now. The reasons are listed above; this is not an empty inbox.")
              : "Nothing matches these filters. The emails are still there. Clear the search or pick a different state above."}
          </div>
        ) : visible.map((i) => {
          const sel = i.key === active;
          return (
            <div
              key={i.key}
              data-key={i.key}
              className={fresh.has(i.key) ? "wing-mail-row-new" : undefined}
              onClick={() => setSelected(i.key)}
              style={{
                display: "flex", gap: 11, alignItems: "flex-start", padding: "10px 13px",
                cursor: "pointer", minWidth: 0,
                borderBottom: "1px solid var(--border)",
                borderLeft: `2px solid ${sel ? "var(--accent)" : "transparent"}`,
                background: sel ? "var(--bg-hover)" : undefined,
              }}
            >
              <Avatar seedA={i.name} seedB={i.company ?? (i.direction === "in" ? i.from : i.to)} />
              <div style={{ display: "grid", gap: 2, minWidth: 0, flex: 1 }}>
                <div style={{ display: "flex", gap: 8, alignItems: "baseline", minWidth: 0 }}>
                  <span style={{
                    fontSize: 12.5, fontWeight: 700, color: "var(--text-primary)", flex: 1,
                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0,
                  }}>
                    {who(i)}
                  </span>
                  <span style={{ fontSize: 10.5, color: "var(--text-muted)", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>
                    {when(i.at)}
                  </span>
                </div>
                {i.name && i.company && (
                  <div style={{
                    fontSize: 11, color: "var(--text-muted)", overflow: "hidden",
                    textOverflow: "ellipsis", whiteSpace: "nowrap",
                  }}>
                    {i.company}
                  </div>
                )}
                <div style={{
                  fontSize: 12.5, color: "var(--text-primary)", overflow: "hidden",
                  textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0,
                }}>
                  {i.subject}
                </div>
                <div style={{
                  fontSize: 11.5, color: "var(--text-secondary)", overflow: "hidden",
                  textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0,
                }}>
                  {i.direction === "in" ? "← " : "→ "}{i.snippet || "(no body recorded)"}
                </div>
                <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginTop: 2 }}>
                  <Chip tone={stateTone(i.state)} text={stateName(i.state)} title={i.stateNote ?? undefined} />
                  {i.step && <span style={{ fontSize: 10.5, color: "var(--text-muted)" }}>{i.step}</span>}
                  {i.campaign && (
                    <span style={{
                      fontSize: 10.5, color: "var(--text-muted)", overflow: "hidden",
                      textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 190,
                    }}>
                      {i.campaign}
                    </span>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </ListShell>
      {visible.length > 0 && (
        <div style={{ fontSize: 11, color: "var(--text-muted)", paddingLeft: 2 }}>
          {visible.length === items.length
            ? `${items.length} email${items.length === 1 ? "" : "s"}`
            : `${visible.length} of ${items.length} emails`}
          {" · j and k move, Enter opens"}
        </div>
      )}
    </div>
  );

  // ── Reading pane ─────────────────────────────────────────────────────────
  const reader = (
    <div id="wing-mail-reader" style={{ display: "grid", gap: 14, alignContent: "start", minWidth: 0 }}>
      {!current ? (
        <div style={{ fontSize: 12.5, color: "var(--text-muted)", lineHeight: 1.6 }}>
          Pick an email on the left to read it exactly as it landed in their inbox.
        </div>
      ) : (
        <>
          <div style={{ display: "grid", gap: 8 }}>
            <div style={{ display: "flex", gap: 9, alignItems: "center", flexWrap: "wrap" }}>
              <Chip solid tone={stateTone(current.state)} text={stateName(current.state)} />
              <span style={{ fontSize: 11.5, color: "var(--text-muted)" }}>{current.laneLabel}</span>
              {current.step && <span style={{ fontSize: 11.5, color: "var(--text-muted)" }}>{current.step}</span>}
              <span style={{ marginLeft: "auto", fontSize: 11.5, color: "var(--text-muted)" }}>
                {fullWhen(current.at)}
              </span>
            </div>
            <h3 style={{
              margin: 0, fontSize: 17, fontWeight: 700, color: "var(--text-primary)",
              lineHeight: 1.35, wordBreak: "break-word",
            }}>
              {current.subject}
            </h3>
            {current.stateNote && (
              <div style={{ fontSize: 11.5, color: "var(--orange)", lineHeight: 1.5 }}>{current.stateNote}</div>
            )}
            {current.error && (
              <div style={{ fontSize: 11.5, color: "var(--red)", lineHeight: 1.5 }}>{current.error}</div>
            )}
          </div>

          <div style={{
            display: "grid", gap: 5, padding: "11px 13px", borderRadius: 11,
            border: "1px solid var(--border)", background: "var(--bg-card)",
          }}>
            <HeaderLine name="From" value={current.from ?? "not recorded on this row"} />
            <HeaderLine name="To" value={
              current.name || current.company
                ? `${[current.name, current.company].filter(Boolean).join(" · ")} — ${current.to ?? "no address"}`
                : current.to ?? "no address"
            } />
            <HeaderLine name="Campaign" value={current.campaign ?? "not part of a campaign"} />
          </div>

          {/* Engagement, only what the source actually knows. Unknown renders
              as a word, never as a zero pretending to be a measurement — and a
              zero open count while the campaign has open tracking off is
              exactly that, so it reads "not tracked" too. */}
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "baseline" }}>
            {([
              ["Opens", current.opens, Boolean(data.trackingNote)],
              ["Clicks", current.clicks, Boolean(data.trackingNote)],
              ["Replies", current.replies, false],
            ] as const).map(([n, v, untracked]) => {
              const unknown = v == null || (untracked && v === 0);
              return (
                <div key={n}>
                  <div style={label}>{n}</div>
                  <div style={{
                    fontSize: unknown ? 12.5 : 15, fontWeight: 700,
                    color: unknown ? "var(--text-muted)" : "var(--text-primary)",
                  }}>
                    {unknown ? "not tracked" : v}
                  </div>
                </div>
              );
            })}
          </div>

          <div style={{
            border: "1px solid var(--border)", borderRadius: 12, background: "var(--bg-card)",
            padding: "14px 16px", minWidth: 0, overflowX: "auto",
          }}>
            {current.html ? (
              <div
                className="wing-mail-body"
                style={{ fontSize: 13.5, lineHeight: 1.62, color: "var(--text-primary)", wordBreak: "break-word" }}
                // Sanitized server-side in app/api/email/feed/source.ts against a
                // tag allow-list: no script, no style, no handlers, no non-http
                // hrefs. This is what makes "exactly as they see it" safe.
                dangerouslySetInnerHTML={{ __html: current.html }}
              />
            ) : current.text ? (
              <pre style={{
                margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word", fontFamily: "inherit",
                fontSize: 13.5, lineHeight: 1.62, color: "var(--text-primary)",
              }}>
                {current.text}
              </pre>
            ) : (
              <div style={{ fontSize: 12.5, color: "var(--text-muted)", lineHeight: 1.6 }}>
                No body is stored for this row. {current.state === "queued"
                  ? "The sequence writes the copy at send time, so there is nothing to show until it goes out."
                  : "The lane it came from did not record one."}
              </div>
            )}
          </div>

          {data.trackingNote && (
            <div style={{ fontSize: 11, color: "var(--text-muted)", lineHeight: 1.55 }}>{data.trackingNote}</div>
          )}
        </>
      )}
    </div>
  );

  return (
    <div style={{ display: "grid", gap: 13, minWidth: 0 }}>
      <style>{FLASH_CSS}</style>

      {/* Lane honesty, before anything else. A broken lane is the reason the
          count below looks small, so it cannot sit under a fold. One box for
          all of them, because two stacked warnings push the mail off screen. */}
      {brokenLanes.length > 0 && (
        <div style={{
          border: "1px solid var(--orange)", borderRadius: 10, padding: "9px 12px",
          background: "var(--bg-card)", display: "grid", gap: 4,
        }}>
          {brokenLanes.map((l) => (
            <div key={l.id} style={{ fontSize: 11.5, lineHeight: 1.5, color: "var(--orange)" }}>
              <b>{l.label}</b> is not readable. {l.reason}
            </div>
          ))}
        </div>
      )}
      {err && data && (
        <Note tone="var(--red)" text={`The last manual refresh failed: ${err}. What is shown came from the read before it.`} />
      )}
      {degraded && <Note tone="var(--orange)" text={degraded} />}

      {/* Toolbar, one compact row plus the state pills. */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search recipient, subject, or body"
          style={{ ...inputStyle, flex: "1 1 240px" }}
        />
        <select value={campaign} onChange={(e) => setCampaign(e.target.value)} style={selectStyle} aria-label="Campaign">
          <option value="all">All campaigns</option>
          {campaignOptions.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select value={range} onChange={(e) => setRange(e.target.value)} style={selectStyle} aria-label="Date range">
          {RANGES.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
        <button
          type="button" onClick={() => { void load(); }}
          style={{
            padding: "6px 13px", borderRadius: 999, fontSize: 12, cursor: "pointer",
            background: "transparent", border: "1px solid var(--border)",
            color: "var(--text-muted)", fontFamily: "inherit",
          }}
        >
          {loading ? "Reading" : "Refresh"}
        </button>
      </div>

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
        <FilterPill text="All" count={preState.length} active={state === "all"} onClick={() => setState("all")} />
        {STATES.filter((s) => (counts[s.id] ?? 0) > 0 || s.id === state).map((s) => (
          <FilterPill
            key={s.id} text={s.name} count={counts[s.id] ?? 0} tone={s.tone}
            active={state === s.id} onClick={() => setState(s.id)}
          />
        ))}
        {liveLanes.length > 0 && (
          <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--text-muted)" }}>
            reading {liveLanes.map((l) => l.label.toLowerCase()).join(", ")}
          </span>
        )}
      </div>

      <MailPanes list={list} reader={reader} />

      {/* Campaign totals, under the panes: the summary Jack would otherwise
          have to open the sender's own dashboard to see. */}
      {data.campaigns.length > 0 && (
        <div style={{ display: "grid", gap: 8 }}>
          <span style={label}>Campaign totals</span>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            {data.campaigns.map((c) => (
              <div key={c.id || c.name} style={{
                border: "1px solid var(--border)", borderRadius: 12, background: "var(--bg-card)",
                padding: "10px 13px", display: "grid", gap: 5, minWidth: 220, flex: "1 1 260px",
              }}>
                <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
                  <span style={{ fontSize: 12.5, fontWeight: 700, color: "var(--text-primary)" }}>{c.name}</span>
                  {c.state && <Chip tone="var(--text-muted)" text={c.state} />}
                </div>
                <div style={{ display: "flex", gap: 14, flexWrap: "wrap", fontSize: 11.5, color: "var(--text-secondary)" }}>
                  {([
                    ["sent", c.sent], ["opens", c.opens], ["clicks", c.clicks],
                    ["replies", c.replies], ["bounced", c.bounces], ["unsubscribed", c.unsubscribes],
                  ] as const).map(([n, v]) => (
                    <span key={n}>
                      <b style={{ color: "var(--text-primary)", fontVariantNumeric: "tabular-nums" }}>
                        {v == null ? "unknown" : v}
                      </b>{" "}{n}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
