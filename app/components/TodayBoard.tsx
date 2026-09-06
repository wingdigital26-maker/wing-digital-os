"use client";

// ───────────────────────────────────────────────────────────────────────────
// TodayBoard — the attention-first "Today" landing panel.
//
// One view that answers "what needs Jack RIGHT NOW", aggregated from the OS's
// own existing APIs. HONESTY RULES (project-wide, non-negotiable):
//   * Nothing here is ever synthesized. Every item comes from a real API row.
//   * A source that errors or is unreachable says so BY NAME ("Reply inbox:
//     not reachable"), never a fake zero and never placeholder items.
//   * NULL / unknown is rendered as unknown, never as 0.
//   * Every problem item carries a one-click link to the thing itself,
//     via os:navigate (in-shell views) or location.href (routed pages).
//
// Sources wired (all read-only GETs):
//   /api/replies           hot/warm unanswered replies + reply drafts
//   /api/reviews           queued review requests awaiting action
//   /api/social            social drafts + posts scheduled for today
//   /api/calendar          today's events across every configured lane
//   /api/automations/runs  failed runs + unprocessed event backlog
//   /api/alerts            open watchdog alerts + stale/erroring heartbeats
//   /api/messaging         cold-email QA queue + guardrail counts
// ───────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useMemo, useState } from "react";

// ── Navigation ─────────────────────────────────────────────────────────────

type ViewId =
  | "crm" | "email" | "text" | "replies" | "social" | "reviews"
  | "customers" | "calendar" | "agent" | "automations";

function goView(view: ViewId) {
  window.dispatchEvent(new CustomEvent("os:navigate", { detail: view }));
}

// ── Per-source fetch state ─────────────────────────────────────────────────

type Fetched<T> =
  | { state: "loading" }
  | { state: "ok"; data: T }
  | { state: "error"; reason: string };

async function getJson<T>(url: string): Promise<Fetched<T>> {
  try {
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) return { state: "error", reason: `HTTP ${r.status}` };
    return { state: "ok", data: (await r.json()) as T };
  } catch {
    return { state: "error", reason: "not reachable" };
  }
}

// ── Payload types (mirroring the routes, only the fields used here) ────────

type ReplyItem = {
  id: number;
  classification: "hot" | "warm" | "cold" | "other";
  status: "none" | "draft" | "sent" | "dismissed";
  client_slug: string | null;
  channel: string | null;
  triaged_at: string;
  draft: string | null;
  messages: { from_addr: string | null; body: string | null; created_at: string } | null;
  crm_contacts: { business_name: string | null; contact_name: string | null; email: string | null } | null;
};
type RepliesPayload = {
  available: boolean;
  tableMissing?: boolean;
  reason: string | null;
  items: ReplyItem[];
  totalCount?: number | null;
};

type ReviewRow = {
  id: number;
  client_slug: string;
  channel: string;
  status: string;
  requested_at: string | null;
  created_at: string;
};
type ReviewsPayload = {
  available: boolean;
  tableMissing: boolean;
  reason: string | null;
  reviews: ReviewRow[];
};

type SocialPost = {
  id: number;
  client_slug: string | null;
  platform: string;
  caption: string;
  scheduled_for: string | null;
  status: string;
};
type SocialPayload = { ok: boolean; missingTable: boolean; reason?: string | null; posts?: SocialPost[] };

type CalEvent = {
  id: string;
  source: string;
  title: string;
  start: string;
  end: string | null;
  allDay: boolean;
  detail: string | null;
  url: string | null;
  external: boolean;
  status: string | null;
};
type CalLane = {
  source: string;
  label: string;
  configured: boolean;
  missing: string | null;
  error: string | null;
  count: number;
  note?: string | null;
};
type CalendarPayload = { events: CalEvent[]; lanes: CalLane[]; today: string };

type RunRow = {
  id: number;
  status: "running" | "done" | "failed" | "skipped" | "waiting";
  error: string | null;
  started_at: string;
  workflows: { name: string; client_slug: string | null } | null;
};
type RunsPayload = { runs: RunRow[]; unprocessed_events: number | null };

type AlertRow = {
  key: string;
  title: string;
  body: string | null;
  last_seen: string;
  resolved_at: string | null;
};
type HeartbeatRow = { agent: string; status: string; message: string | null; last_beat: string };
type AlertsPayload = { alerts: AlertRow[]; heartbeats: HeartbeatRow[] };

type MessagingPayload = {
  lane?: { paused?: boolean | null; deliveryWarning?: string | null };
  queue?: { available: boolean; reason: string | null; total: number | null };
  guardrails?: { qaFailed: number | null; badEmail: number | null; claimed: number | null };
};

// ── Small helpers ──────────────────────────────────────────────────────────

function localDayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function isTodayEvent(e: CalEvent, todayKey: string): boolean {
  if (e.allDay || e.start.length === 10) return e.start === todayKey;
  const t = new Date(e.start);
  return !Number.isNaN(t.getTime()) && localDayKey(t) === todayKey;
}

function fmtTime(iso: string): string {
  if (iso.length === 10) return "all day";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function ago(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const mins = Math.round((Date.now() - t) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const h = Math.round(mins / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function trunc(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

// ── Presentational bits (inline styles, existing CSS tokens only) ──────────

const card: React.CSSProperties = {
  background: "var(--bg-card)",
  border: "1px solid var(--border)",
  borderRadius: 12,
  padding: "14px 16px",
  display: "flex",
  flexDirection: "column",
  gap: 8,
  minWidth: 0,
};

const rowBtn: React.CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  gap: 8,
  width: "100%",
  textAlign: "left",
  background: "transparent",
  border: "none",
  borderTop: "1px solid var(--border)",
  padding: "7px 2px",
  cursor: "pointer",
  color: "var(--text-primary)",
  font: "inherit",
  fontSize: 13,
  minWidth: 0,
};

function Badge({ color, children }: { color: string; children: React.ReactNode }) {
  return (
    <span
      style={{
        color,
        border: `1px solid ${color}`,
        borderRadius: 999,
        padding: "1px 8px",
        fontSize: 11,
        fontWeight: 600,
        whiteSpace: "nowrap",
        textTransform: "uppercase",
        letterSpacing: "0.04em",
      }}
    >
      {children}
    </span>
  );
}

function SourceDown({ name, reason }: { name: string; reason: string }) {
  // The honest unavailable state: names the source, never fakes a zero.
  return (
    <div style={{ color: "var(--orange)", fontSize: 13 }}>
      {name}: {reason}
    </div>
  );
}

function Muted({ children }: { children: React.ReactNode }) {
  return <div style={{ color: "var(--text-muted)", fontSize: 13 }}>{children}</div>;
}

function Section({
  title,
  count,
  countColor,
  onOpen,
  openLabel,
  children,
}: {
  title: string;
  count: number | null; // null = unknown (a source is down); never shown as 0
  countColor?: string;
  onOpen: () => void;
  openLabel: string;
  children: React.ReactNode;
}) {
  return (
    <section style={card}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <h3 style={{ margin: 0, fontSize: 14, fontWeight: 700, color: "var(--text-primary)", flex: 1 }}>
          {title}
        </h3>
        {count !== null && (
          <span style={{ fontSize: 18, fontWeight: 700, color: countColor ?? "var(--text-secondary)" }}>
            {count}
          </span>
        )}
        <button
          onClick={onOpen}
          style={{
            background: "transparent",
            border: "1px solid var(--border)",
            borderRadius: 8,
            color: "var(--accent)",
            padding: "3px 10px",
            fontSize: 12,
            cursor: "pointer",
            font: "inherit",
          }}
        >
          {openLabel} →
        </button>
      </div>
      {children}
    </section>
  );
}

// ── The board ──────────────────────────────────────────────────────────────

export default function TodayBoard() {
  const [replies, setReplies] = useState<Fetched<RepliesPayload>>({ state: "loading" });
  const [reviews, setReviews] = useState<Fetched<ReviewsPayload>>({ state: "loading" });
  const [social, setSocial] = useState<Fetched<SocialPayload>>({ state: "loading" });
  const [calendar, setCalendar] = useState<Fetched<CalendarPayload>>({ state: "loading" });
  const [runs, setRuns] = useState<Fetched<RunsPayload>>({ state: "loading" });
  const [alerts, setAlerts] = useState<Fetched<AlertsPayload>>({ state: "loading" });
  const [messaging, setMessaging] = useState<Fetched<MessagingPayload>>({ state: "loading" });
  const [loadedAt, setLoadedAt] = useState<Date | null>(null);

  const load = useCallback(() => {
    getJson<RepliesPayload>("/api/replies?limit=200").then(setReplies);
    getJson<ReviewsPayload>("/api/reviews").then(setReviews);
    getJson<SocialPayload>("/api/social").then(setSocial);
    getJson<CalendarPayload>("/api/calendar").then(setCalendar);
    getJson<RunsPayload>("/api/automations/runs").then(setRuns);
    getJson<AlertsPayload>("/api/alerts").then(setAlerts);
    getJson<MessagingPayload>("/api/messaging").then((r) => {
      setMessaging(r);
      setLoadedAt(new Date());
    });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const todayKey = localDayKey(new Date());

  // ── Derivations (pure filters over real rows; nothing invented) ──────────

  const hotWarm = useMemo(() => {
    if (replies.state !== "ok" || !replies.data.available) return null;
    return replies.data.items.filter(
      (r) =>
        (r.classification === "hot" || r.classification === "warm") &&
        (r.status === "none" || r.status === "draft")
    );
  }, [replies]);

  const replyDrafts = useMemo(
    () => (hotWarm ? hotWarm.filter((r) => r.status === "draft") : null),
    [hotWarm]
  );

  const queuedReviews = useMemo(() => {
    if (reviews.state !== "ok" || !reviews.data.available) return null;
    return reviews.data.reviews.filter((r) => r.status === "queued");
  }, [reviews]);

  const socialNeedsAction = useMemo(() => {
    if (social.state !== "ok" || social.data.missingTable || !social.data.posts) return null;
    return social.data.posts.filter(
      (p) =>
        p.status === "draft" ||
        (p.status === "scheduled" && !!p.scheduled_for && isTodayEvent(
          { start: p.scheduled_for, allDay: false } as CalEvent, todayKey
        ))
    );
  }, [social, todayKey]);

  const todayEvents = useMemo(() => {
    if (calendar.state !== "ok") return null;
    const key = calendar.data.today || todayKey;
    return calendar.data.events.filter((e) => isTodayEvent(e, key));
  }, [calendar, todayKey]);

  const failedRuns = useMemo(() => {
    if (runs.state !== "ok") return null;
    return runs.data.runs.filter((r) => r.status === "failed");
  }, [runs]);

  const openAlerts = useMemo(() => {
    if (alerts.state !== "ok" || !Array.isArray(alerts.data.alerts)) return null;
    return alerts.data.alerts.filter((a) => !a.resolved_at);
  }, [alerts]);

  const badBeats = useMemo(() => {
    if (alerts.state !== "ok" || !Array.isArray(alerts.data.heartbeats)) return null;
    return alerts.data.heartbeats.filter((h) => h.status === "error");
  }, [alerts]);

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="tb-root" style={{ display: "flex", flexDirection: "column", gap: 14, minWidth: 0 }}>
      <style>{`
        @media (max-width: 768px) {
          /* One column on phone; minmax(0,1fr) so a long unbroken string can
             never widen the track and cause sideways page scroll. */
          .tb-grid { grid-template-columns: minmax(0, 1fr) !important; }
          /* Touch-sized targets for every tappable row/button on the board
             (Refresh, each section's open button, and the item rows). */
          .tb-root button { min-height: 40px; }
          /* Header row: keep "Today" + timestamp + Refresh on one tidy line. */
          .tb-head { flex-wrap: wrap; align-items: center !important; }
          /* Item rows: keep the truncating middle span from squeezing the
             timestamp off the edge. */
          .tb-root section { overflow: hidden; }
        }
      `}</style>
      <div className="tb-head" style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 800, color: "var(--text-primary)", flex: 1 }}>
          Today
        </h2>
        {loadedAt && (
          <span style={{ color: "var(--text-muted)", fontSize: 12 }}>
            loaded {loadedAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
          </span>
        )}
        <button
          onClick={load}
          style={{
            background: "transparent",
            border: "1px solid var(--border)",
            borderRadius: 8,
            color: "var(--text-secondary)",
            padding: "3px 10px",
            fontSize: 12,
            cursor: "pointer",
            font: "inherit",
          }}
        >
          Refresh
        </button>
      </div>

      <div
        className="tb-grid"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
          gap: 14,
          alignItems: "start",
        }}
      >
        {/* ── Replies that need Jack ─────────────────────────────────────── */}
        <Section
          title="Replies needing you"
          count={hotWarm ? hotWarm.length : null}
          countColor={hotWarm && hotWarm.length > 0 ? "var(--red)" : "var(--green)"}
          onOpen={() => goView("replies")}
          openLabel="Reply inbox"
        >
          {replies.state === "loading" && <Muted>Checking the reply inbox…</Muted>}
          {replies.state === "error" && <SourceDown name="Reply inbox (/api/replies)" reason={replies.reason} />}
          {replies.state === "ok" && !replies.data.available && (
            <SourceDown name="Reply inbox" reason={replies.data.reason ?? "unavailable"} />
          )}
          {hotWarm && hotWarm.length === 0 && <Muted>No hot or warm replies are waiting. (Table is live; queue is genuinely empty.)</Muted>}
          {hotWarm &&
            hotWarm.slice(0, 8).map((r) => {
              const who =
                r.crm_contacts?.business_name ||
                r.crm_contacts?.contact_name ||
                r.messages?.from_addr ||
                `triage #${r.id}`;
              return (
                <button key={r.id} style={rowBtn} onClick={() => goView("replies")} title="Open in the reply inbox">
                  <Badge color={r.classification === "hot" ? "var(--red)" : "var(--orange)"}>
                    {r.classification}
                  </Badge>
                  <span style={{ fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {who}
                  </span>
                  <span style={{ color: "var(--text-muted)", flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {r.messages?.body ? trunc(r.messages.body, 70) : ""}
                  </span>
                  <span style={{ color: "var(--text-muted)", fontSize: 11 }}>{ago(r.triaged_at)}</span>
                </button>
              );
            })}
          {hotWarm && hotWarm.length > 8 && <Muted>+{hotWarm.length - 8} more in the inbox.</Muted>}
        </Section>

        {/* ── Drafts awaiting approval ───────────────────────────────────── */}
        <Section
          title="Drafts awaiting approval"
          count={
            replyDrafts !== null && queuedReviews !== null && socialNeedsAction !== null
              ? replyDrafts.length + queuedReviews.length + socialNeedsAction.length
              : null
          }
          countColor="var(--orange)"
          onOpen={() => goView("replies")}
          openLabel="Replies"
        >
          {replyDrafts === null && replies.state === "loading" ? (
            <Muted>Checking reply drafts…</Muted>
          ) : replyDrafts === null ? (
            <SourceDown name="Reply drafts (/api/replies)" reason="not reachable" />
          ) : (
            <button style={rowBtn} onClick={() => goView("replies")}>
              <span style={{ fontWeight: 600 }}>{replyDrafts.length}</span>
              <span style={{ color: "var(--text-secondary)" }}>reply draft{replyDrafts.length === 1 ? "" : "s"} written, not yet handled</span>
            </button>
          )}
          {queuedReviews === null && reviews.state === "loading" ? (
            <Muted>Checking review queue…</Muted>
          ) : queuedReviews === null ? (
            <SourceDown
              name="Review queue (/api/reviews)"
              reason={reviews.state === "ok" ? reviews.data.reason ?? "unavailable" : reviews.state === "error" ? reviews.reason : "unavailable"}
            />
          ) : (
            <button style={rowBtn} onClick={() => goView("reviews")}>
              <span style={{ fontWeight: 600 }}>{queuedReviews.length}</span>
              <span style={{ color: "var(--text-secondary)" }}>
                review request{queuedReviews.length === 1 ? "" : "s"} queued, waiting to go out
              </span>
            </button>
          )}
          {socialNeedsAction === null && social.state === "loading" ? (
            <Muted>Checking social queue…</Muted>
          ) : socialNeedsAction === null ? (
            <SourceDown
              name="Social queue (/api/social)"
              reason={social.state === "ok" ? (social.data.reason ?? "table missing — run migration 0028") : social.state === "error" ? social.reason : "unavailable"}
            />
          ) : (
            <button style={rowBtn} onClick={() => goView("social")}>
              <span style={{ fontWeight: 600 }}>{socialNeedsAction.length}</span>
              <span style={{ color: "var(--text-secondary)" }}>
                social post{socialNeedsAction.length === 1 ? "" : "s"} in draft or scheduled for today
              </span>
            </button>
          )}
        </Section>

        {/* ── Today's calendar ───────────────────────────────────────────── */}
        <Section
          title="Today's schedule"
          count={todayEvents ? todayEvents.length : null}
          onOpen={() => goView("calendar")}
          openLabel="Calendar"
        >
          {calendar.state === "loading" && <Muted>Loading the calendar…</Muted>}
          {calendar.state === "error" && <SourceDown name="Calendar (/api/calendar)" reason={calendar.reason} />}
          {todayEvents && todayEvents.length === 0 && <Muted>Nothing dated today across the configured lanes.</Muted>}
          {todayEvents &&
            todayEvents.slice(0, 8).map((e) => (
              <button
                key={e.id}
                style={rowBtn}
                onClick={() => {
                  if (e.url) {
                    if (e.external) window.open(e.url, "_blank", "noopener");
                    else location.href = e.url;
                  } else goView("calendar");
                }}
                title={e.url ? "Open this item" : "Open the calendar"}
              >
                <span style={{ color: "var(--accent)", fontSize: 12, whiteSpace: "nowrap" }}>{fmtTime(e.start)}</span>
                <span style={{ fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {e.title}
                </span>
                {e.detail && (
                  <span style={{ color: "var(--text-muted)", flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {e.detail}
                  </span>
                )}
              </button>
            ))}
          {calendar.state === "ok" &&
            calendar.data.lanes
              .filter((l) => !l.configured || l.error)
              .map((l) => (
                <div key={l.source} style={{ color: "var(--text-muted)", fontSize: 12 }}>
                  {l.label}: {l.error ?? (l.missing ? `not configured (${l.missing})` : "not configured")}
                </div>
              ))}
        </Section>

        {/* ── Automations health ─────────────────────────────────────────── */}
        <Section
          title="Automations"
          count={failedRuns ? failedRuns.length : null}
          countColor={failedRuns && failedRuns.length > 0 ? "var(--red)" : "var(--green)"}
          onOpen={() => goView("automations")}
          openLabel="Automations"
        >
          {runs.state === "loading" && <Muted>Checking workflow runs…</Muted>}
          {runs.state === "error" && (
            <SourceDown name="Automation runs (/api/automations/runs)" reason={runs.reason} />
          )}
          {failedRuns && failedRuns.length === 0 && <Muted>No failed runs in the last 100.</Muted>}
          {failedRuns &&
            failedRuns.slice(0, 6).map((r) => (
              <button key={r.id} style={rowBtn} onClick={() => goView("automations")} title="Open automations">
                <Badge color="var(--red)">failed</Badge>
                <span style={{ fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {r.workflows?.name ?? `run #${r.id}`}
                </span>
                <span style={{ color: "var(--text-muted)", flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {r.error ? trunc(r.error, 60) : ""}
                </span>
                <span style={{ color: "var(--text-muted)", fontSize: 11 }}>{ago(r.started_at)}</span>
              </button>
            ))}
          {runs.state === "ok" &&
            (runs.data.unprocessed_events === null ? (
              <Muted>Event backlog: could not be read (unknown, not zero).</Muted>
            ) : runs.data.unprocessed_events > 0 ? (
              <button style={rowBtn} onClick={() => goView("automations")}>
                <Badge color="var(--orange)">backlog</Badge>
                <span style={{ color: "var(--text-secondary)" }}>
                  {runs.data.unprocessed_events} event{runs.data.unprocessed_events === 1 ? "" : "s"} waiting for the engine
                </span>
              </button>
            ) : (
              <Muted>No events waiting for the engine.</Muted>
            ))}
        </Section>

        {/* ── Watchdog alerts + heartbeats ───────────────────────────────── */}
        <Section
          title="Alerts"
          count={openAlerts && badBeats ? openAlerts.length + badBeats.length : null}
          countColor={openAlerts && badBeats && openAlerts.length + badBeats.length > 0 ? "var(--red)" : "var(--green)"}
          onOpen={() => goView("agent")}
          openLabel="Agent HQ"
        >
          {alerts.state === "loading" && <Muted>Checking watchdog alerts…</Muted>}
          {alerts.state === "error" && <SourceDown name="Alerts (/api/alerts)" reason={alerts.reason} />}
          {openAlerts && badBeats && openAlerts.length === 0 && badBeats.length === 0 && (
            <Muted>No open watchdog alerts; no agent heartbeat is reporting an error.</Muted>
          )}
          {openAlerts &&
            openAlerts.slice(0, 6).map((a) => (
              <button key={a.key} style={rowBtn} onClick={() => goView("agent")} title="Open Agent HQ">
                <Badge color="var(--red)">alert</Badge>
                <span style={{ fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {a.title}
                </span>
                <span style={{ color: "var(--text-muted)", flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {a.body ? trunc(a.body, 60) : ""}
                </span>
                <span style={{ color: "var(--text-muted)", fontSize: 11 }}>{ago(a.last_seen)}</span>
              </button>
            ))}
          {badBeats &&
            badBeats.map((h) => (
              <button key={h.agent} style={rowBtn} onClick={() => goView("agent")} title="Open Agent HQ">
                <Badge color="var(--orange)">heartbeat</Badge>
                <span style={{ fontWeight: 600 }}>{h.agent}</span>
                <span style={{ color: "var(--text-muted)", flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {h.message ? trunc(h.message, 60) : "reporting error"}
                </span>
                <span style={{ color: "var(--text-muted)", fontSize: 11 }}>{ago(h.last_beat)}</span>
              </button>
            ))}
        </Section>

        {/* ── Cold-email QA queue ────────────────────────────────────────── */}
        <Section
          title="Cold-email queue"
          count={
            messaging.state === "ok" && messaging.data.queue?.available && messaging.data.queue.total !== null
              ? messaging.data.queue.total ?? null
              : null
          }
          onOpen={() => goView("crm")}
          openLabel="CRM · messaging"
        >
          {messaging.state === "loading" && <Muted>Checking the outbound queue…</Muted>}
          {messaging.state === "error" && (
            <SourceDown name="Messaging QA board (/api/messaging)" reason={messaging.reason} />
          )}
          {messaging.state === "ok" && (
            <>
              {messaging.data.queue ? (
                messaging.data.queue.available ? (
                  <Muted>
                    {messaging.data.queue.total === null
                      ? "Queue size could not be counted (unknown, not zero)."
                      : `${messaging.data.queue.total} prospect${messaging.data.queue.total === 1 ? "" : "s"} in the eligible send pool.`}
                  </Muted>
                ) : (
                  <SourceDown name="Outbound queue" reason={messaging.data.queue.reason ?? "unavailable"} />
                )
              ) : (
                <SourceDown name="Outbound queue" reason="payload missing the queue block" />
              )}
              {messaging.data.guardrails && (
                <button style={rowBtn} onClick={() => goView("crm")}>
                  <Badge color="var(--orange)">guardrails</Badge>
                  <span style={{ color: "var(--text-secondary)" }}>
                    qa-failed {messaging.data.guardrails.qaFailed ?? "?"} · bad email{" "}
                    {messaging.data.guardrails.badEmail ?? "?"} · stuck claimed{" "}
                    {messaging.data.guardrails.claimed ?? "?"}
                  </span>
                </button>
              )}
              {messaging.data.lane?.deliveryWarning && (
                <div style={{ color: "var(--orange)", fontSize: 12 }}>
                  {trunc(messaging.data.lane.deliveryWarning, 160)}
                </div>
              )}
            </>
          )}
        </Section>
      </div>
    </div>
  );
}
