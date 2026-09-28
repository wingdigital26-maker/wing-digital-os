"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { DraftRow, DraftStep, StopReason } from "@/lib/outreach/types";
import type { MailboxHealth, RetouchRow, SuppressionRow, Tracking } from "@/lib/outreach/stats";
import type { SyncSummary } from "@/lib/outreach/sync";

// The /outreach board. Reads /api/outreach/queue and /api/outreach/tracking;
// writes only decisions (edit, approve, reject, reopen) through
// /api/outreach/drafts/:id and /api/outreach/approve-passed. The push button
// calls /api/outreach/push, which refuses unless the deployment switched it on.
// Honest states: a rate with no sends is "no sends yet", never 0%; a failed
// read says why; a lane that has nothing says so in one line.

type QueuePayload =
  | { ok: true; storeKind: string; dates: { date: string; count: number }[]; batchDate: string | null; drafts: DraftRow[]; pushEnabled: boolean }
  | { ok: false; reason: string };

type TrackingPayload =
  | {
      ok: true;
      storeKind: string;
      tracking: Tracking;
      mailboxHealth: MailboxHealth[];
      retouch: RetouchRow[];
      retouchRules: { intervalDays: number; yearlyCap: number; stepsPerRound: number };
      suppression: SuppressionRow[];
      handoffs: SuppressionRow[];
      eventCount: number;
      lastSync: SyncSummary | null;
    }
  | { ok: false; reason: string };

type Tab = "batch" | "tracking" | "retouch" | "suppressed";

const TZ = "America/Chicago";
const STOP_LABEL: Record<StopReason, string> = {
  unsubscribed: "Unsubscribed",
  negative_reply: "Asked to be removed",
  spam_complaint: "Spam complaint",
  hard_bounce: "Hard bounce",
  handoff: "Replied, handed to a person",
};

function when(iso: string | null | undefined): string {
  if (!iso) return "unknown time";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "unknown time";
  return d.toLocaleString("en-US", { timeZone: TZ, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
function day(iso: string | null | undefined): string {
  if (!iso) return "unknown";
  const d = new Date(iso.length === 10 ? `${iso}T12:00:00Z` : iso);
  return d.toLocaleDateString("en-US", { timeZone: TZ, weekday: "short", month: "short", day: "numeric" });
}
function ago(iso: string | null | undefined): string {
  if (!iso) return "never";
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}
function inDays(iso: string): string {
  const d = Math.round((Date.parse(iso) - Date.now()) / 86400000);
  if (d <= 0) return d === 0 ? "today" : `${-d} d overdue`;
  return `in ${d} d`;
}
const pct = (r: number | null, none = "no sends yet") => (r == null ? none : `${(r * 100).toFixed(r < 0.1 ? 1 : 0)}%`);

async function send(url: string, method: string, body?: unknown): Promise<{ ok: boolean; reason?: string; [k: string]: unknown }> {
  try {
    const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || j.ok === false) return { ok: false, reason: j.reason ?? j.error ?? `HTTP ${res.status}` };
    return { ok: true, ...j };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

// ── Draft card ──────────────────────────────────────────────────────────────

function DraftCard({ d, onChange }: { d: DraftRow; onChange: (next: DraftRow | null, msg?: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [steps, setSteps] = useState<DraftStep[]>(d.steps);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [showOriginal, setShowOriginal] = useState(false);
  const [showAllFacts, setShowAllFacts] = useState(false);
  // Decided drafts fold down to one line so the ones still waiting stand out.
  const [open, setOpen] = useState(d.approvalStatus === "pending");

  const locked = Boolean(d.pushRequestedAt || d.pushedAt);
  const usedFacts = d.facts.filter((f) => f.used);
  const otherFacts = d.facts.filter((f) => !f.used);
  const edited = Boolean(d.editedAt);

  async function act(body: Record<string, unknown>) {
    setBusy(true);
    setErr(null);
    const r = await send(`/api/outreach/drafts/${d.id}`, "PATCH", body);
    setBusy(false);
    if (!r.ok) { setErr(r.reason ?? "That did not save."); return false; }
    onChange(r.draft as DraftRow);
    return true;
  }

  const shown = showOriginal ? d.originalSteps : editing ? steps : d.steps;

  return (
    <article id={`draft-${d.id}`} className="ob-card v2-card" data-state={d.approvalStatus} data-qa={d.qaStatus}>
      <header className="ob-card-head">
        <div className="ob-who">
          <h3>
            {d.website ? <a href={d.website} target="_blank" rel="noopener noreferrer">{d.company ?? d.website}</a> : d.company ?? "Unnamed company"}
          </h3>
          <div className="ob-meta">
            {d.contactName ? <span>{d.contactName}</span> : <span className="muted">no confirmed contact name</span>}
            {d.contactEmail && <span className="mono">{d.contactEmail}</span>}
            {[d.city, d.trade].filter(Boolean).length > 0 && <span>{[d.city, d.trade].filter(Boolean).join(" · ")}</span>}
            {d.round > 1 && <span className="ob-chip info">Round {d.round}</span>}
          </div>
        </div>
        <div className="ob-badges">
          <span className={`v2-status ${d.qaStatus === "passed" ? "v2-status--ok" : d.qaStatus === "failed" ? "v2-status--bad" : "v2-status--warn"}`}>
            QA {d.qaStatus === "pending" ? "not run" : d.qaStatus}
          </span>
          <span className={`v2-status ${d.approvalStatus === "approved" ? "v2-status--info" : d.approvalStatus === "rejected" ? "v2-status--bad" : "v2-status--warn"}`}>
            {d.approvalStatus === "pending" ? "Waiting for review" : d.approvalStatus === "approved" ? "Approved" : "Rejected"}
          </span>
        </div>
      </header>

      {d.approvalStatus !== "pending" && (
        <p className="ob-decision">
          {d.approvalStatus === "approved" ? "Approved" : "Rejected"} by <b>{d.approver ?? "unknown"}</b>, {when(d.approvedAt)}
          {d.rejectedReason ? <>. Note: {d.rejectedReason}</> : null}
          {d.pushRequestedAt ? <>. Handed to the sender by {d.pushRequestedBy ?? "unknown"}, {when(d.pushRequestedAt)}</> : null}
          {d.pushedAt ? <>. Pushed to Instantly {when(d.pushedAt)}</> : null}
        </p>
      )}

      {!open && (
        <button type="button" className="ob-link" onClick={() => setOpen(true)}>
          Show the {d.steps.length}-step sequence: {d.steps.map((s) => s.subject).join(" / ")}
        </button>
      )}

      {open && d.qaStatus === "failed" && d.qaReasons.length > 0 && (
        <ul className="ob-qa-reasons">
          {d.qaReasons.map((r, i) => <li key={i}>{r}</li>)}
        </ul>
      )}

      {open && (<>
      <section className="ob-facts">
        <h4>Facts the emails stand on</h4>
        {usedFacts.length === 0 && otherFacts.length === 0 ? (
          <p className="muted small">The engine did not attach research to this draft.</p>
        ) : (
          <ul>
            {(usedFacts.length ? usedFacts : otherFacts.slice(0, 3)).map((f, i) => (
              <li key={f.id ?? i}>
                {f.text}
                {f.source && <> <a href={f.source} target="_blank" rel="noopener noreferrer" className="ob-src">source</a></>}
              </li>
            ))}
          </ul>
        )}
        {usedFacts.length > 0 && otherFacts.length > 0 && (
          <>
            <button type="button" className="ob-link" onClick={() => setShowAllFacts((v) => !v)}>
              {showAllFacts ? "Hide" : "Show"} the other {otherFacts.length} research fact{otherFacts.length === 1 ? "" : "s"}
            </button>
            {showAllFacts && (
              <ul className="ob-facts-more">
                {otherFacts.map((f, i) => <li key={f.id ?? i}>{f.text}</li>)}
              </ul>
            )}
          </>
        )}
      </section>

      <section className="ob-steps">
        {shown.map((s, i) => (
          <div key={s.step} className="ob-step v2-inner">
            <div className="ob-step-head">
              <b>Step {s.step}</b>
              {s.delayDays != null && <span className="muted">{i === 0 ? "day 0" : `+${s.delayDays} d`}</span>}
              {s.angle && <span className="ob-chip">{s.angle}</span>}
            </div>
            {editing && !showOriginal ? (
              <>
                <input
                  className="ob-input"
                  value={s.subject}
                  aria-label={`Step ${s.step} subject`}
                  onChange={(e) => setSteps((st) => st.map((x, j) => (j === i ? { ...x, subject: e.target.value } : x)))}
                />
                <textarea
                  className="ob-textarea"
                  value={s.body}
                  rows={Math.min(14, Math.max(5, s.body.split("\n").length + 1))}
                  aria-label={`Step ${s.step} body`}
                  onChange={(e) => setSteps((st) => st.map((x, j) => (j === i ? { ...x, body: e.target.value } : x)))}
                />
              </>
            ) : (
              <>
                <div className="ob-subject">{s.subject}</div>
                <pre className="ob-body">{s.body}</pre>
              </>
            )}
          </div>
        ))}
        <p className="muted small">The engine appends the signature and opt-out line to every step when it pushes.</p>
      </section>

      {edited && (
        <p className="ob-edited">
          Edited by {d.editedBy ?? "unknown"}, {when(d.editedAt)}.{" "}
          <button type="button" className="ob-link" onClick={() => setShowOriginal((v) => !v)}>
            {showOriginal ? "Show the edited version" : "Show what the engine wrote"}
          </button>
        </p>
      )}
      </>)}

      {err && <p className="ob-err">{err}</p>}

      <footer className="ob-actions">
        {editing ? (
          <>
            <button type="button" className="ob-btn primary" disabled={busy} onClick={async () => { if (await act({ action: "edit", steps })) setEditing(false); }}>
              {busy ? "Saving" : "Save edits"}
            </button>
            <button type="button" className="ob-btn" disabled={busy} onClick={() => { setSteps(d.steps); setEditing(false); setErr(null); }}>Cancel</button>
          </>
        ) : rejecting ? (
          <>
            <input className="ob-input grow" placeholder="Why? (optional, saved with the rejection)" value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Rejection reason" />
            <button type="button" className="ob-btn danger" disabled={busy} onClick={async () => { if (await act({ action: "reject", reason })) { setRejecting(false); setReason(""); } }}>Reject</button>
            <button type="button" className="ob-btn" disabled={busy} onClick={() => setRejecting(false)}>Cancel</button>
          </>
        ) : d.approvalStatus === "pending" ? (
          <>
            {d.qaStatus === "failed" ? (
              <button type="button" className="ob-btn" disabled={busy} title="QA failed. Approving anyway needs a written reason."
                onClick={async () => {
                  const why = window.prompt("QA failed on this draft. Why approve it anyway?");
                  if (why && why.trim()) await act({ action: "approve", reason: why.trim() });
                }}>
                Approve anyway
              </button>
            ) : (
              <button type="button" className="ob-btn primary" disabled={busy} onClick={() => act({ action: "approve" })}>Approve</button>
            )}
            <button type="button" className="ob-btn" disabled={busy} onClick={() => { setSteps(d.steps); setEditing(true); }}>Edit</button>
            <button type="button" className="ob-btn danger-ghost" disabled={busy} onClick={() => setRejecting(true)}>Reject</button>
          </>
        ) : !locked ? (
          <button type="button" className="ob-btn" disabled={busy} onClick={async () => { if (await act({ action: "reopen" })) setOpen(true); }}>Move back to review</button>
        ) : (
          <span className="muted small">Handed to the sender. The decision is locked.</span>
        )}
      </footer>
    </article>
  );
}

// ── Batch tab ───────────────────────────────────────────────────────────────

function BatchTab() {
  const [date, setDate] = useState<string | null>(null);
  const [data, setData] = useState<QueuePayload | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async (d: string | null) => {
    const url = d ? `/api/outreach/queue?date=${d}` : "/api/outreach/queue";
    try {
      const res = await fetch(url, { cache: "no-store" });
      const j = (await res.json()) as QueuePayload;
      setData(res.ok || !j.ok ? j : { ok: false, reason: `HTTP ${res.status}` });
      if (j.ok) setDate(d ?? j.batchDate);
    } catch (e) {
      setData({ ok: false, reason: e instanceof Error ? e.message : String(e) });
    }
  }, []);

  useEffect(() => {
    void load(new URLSearchParams(window.location.search).get("date"));
  }, [load]);

  useEffect(() => {
    if (!data?.ok) return;
    const h = window.location.hash;
    if (h.startsWith("#draft-")) document.getElementById(h.slice(1))?.scrollIntoView({ block: "start" });
  }, [data]);

  if (!data) return <div className="ob-skel" aria-label="Loading the batch" />;
  if (!data.ok) return <div className="act-note dead">The review queue could not be read. {data.reason}</div>;

  const drafts = data.drafts;
  // Edited drafts are left out: QA passed on the engine's text, not the edit.
  const passedPending = drafts.filter((d) => d.qaStatus === "passed" && d.approvalStatus === "pending" && !d.editedAt).length;
  const approvedWaiting = drafts.filter((d) => d.approvalStatus === "approved" && !d.pushRequestedAt && !d.pushedAt).length;
  const counts = {
    total: drafts.length,
    passed: drafts.filter((d) => d.qaStatus === "passed").length,
    failed: drafts.filter((d) => d.qaStatus === "failed").length,
    approved: drafts.filter((d) => d.approvalStatus === "approved").length,
    rejected: drafts.filter((d) => d.approvalStatus === "rejected").length,
  };

  const replace = (next: DraftRow | null) => {
    if (!next) return;
    setData((cur) => (cur && cur.ok ? { ...cur, drafts: cur.drafts.map((x) => (x.id === next.id ? next : x)) } : cur));
  };

  return (
    <div>
      <div className="ob-toolbar">
        <label className="ob-date">
          <span>Batch</span>
          <select
            value={date ?? ""}
            onChange={(e) => { setDate(e.target.value); setMsg(null); history.replaceState(null, "", `?date=${e.target.value}`); void load(e.target.value); }}
          >
            {data.dates.length === 0 && <option value="">none yet</option>}
            {data.dates.map((d) => <option key={d.date} value={d.date}>{day(d.date)} ({d.count})</option>)}
          </select>
        </label>
        {counts.total > 0 && (
          <span className="ob-counts">
            {counts.total} drafts · {counts.passed} passed QA{counts.failed ? ` · ${counts.failed} failed` : ""} · {counts.approved} approved{counts.rejected ? ` · ${counts.rejected} rejected` : ""}
          </span>
        )}
        <span className="ob-spacer" />
        <button
          type="button"
          className="ob-btn primary"
          disabled={busy || passedPending === 0 || !date}
          onClick={async () => {
            if (!date) return;
            setBusy(true);
            const r = await send("/api/outreach/approve-passed", "POST", { date });
            setBusy(false);
            setMsg(r.ok ? `Approved ${r.approved} draft${r.approved === 1 ? "" : "s"} as ${r.approver}.` : r.reason ?? "That did not save.");
            await load(date);
          }}
        >
          Approve all QA-passed ({passedPending})
        </button>
        <button
          type="button"
          className="ob-btn"
          disabled={!data.pushEnabled || busy || approvedWaiting === 0}
          title={data.pushEnabled ? "Hand approved drafts to the engine's sender" : "Switched off on this deployment (OUTREACH_PUSH_ENABLED)"}
          onClick={async () => {
            if (!window.confirm(`Hand ${approvedWaiting} approved draft${approvedWaiting === 1 ? "" : "s"} to the sender? The engine pushes them to Instantly on its next run.`)) return;
            setBusy(true);
            const r = await send("/api/outreach/push", "POST", {});
            setBusy(false);
            setMsg(r.ok ? `${r.requested} draft${r.requested === 1 ? "" : "s"} handed to the sender.` : r.reason ?? "That did not save.");
            if (date) await load(date);
          }}
        >
          Push approved to Instantly
        </button>
      </div>
      {!data.pushEnabled && (
        <p className="muted small ob-pushnote">Pushing is switched off here, so approving only records the decision. Nothing reaches Instantly from this page.</p>
      )}
      {msg && <p className="ob-msg">{msg}</p>}
      {data.storeKind === "dev-file" && <p className="muted small">Local preview store (no OS_DB_URL on this machine).</p>}

      {drafts.length === 0 ? (
        <div className="act-note">No drafts in this batch.</div>
      ) : (
        <div className="ob-cards">
          {drafts.map((d) => <DraftCard key={d.id} d={d} onChange={replace} />)}
        </div>
      )}
    </div>
  );
}

// ── Tracking + health ───────────────────────────────────────────────────────

function HealthStrip({ rows }: { rows: MailboxHealth[] }) {
  if (rows.length === 0) return null;
  return (
    <div className="ob-health">
      {rows.map((m) => (
        <div key={m.mailbox} className="ob-health-card v2-card" data-level={m.paused ? "paused" : m.level}>
          <div className="mono ob-health-box">{m.mailbox}</div>
          {m.paused ? (
            <div className="ob-health-paused">Paused by the circuit breaker{m.pausedReason ? `: ${m.pausedReason}` : ""}{m.pausedAt ? ` (${when(m.pausedAt)})` : ""}</div>
          ) : null}
          <div className="ob-health-nums">
            {m.sent7 === 0 ? (
              <span className="muted">Nothing sent in 7 days</span>
            ) : (
              <>
                <span><b>{pct(m.bounceRate7)}</b> bounce</span>
                <span><b>{m.bounces7}</b> bounced of {m.sent7} sent</span>
              </>
            )}
            <span><b>{m.complaints7}</b> complaint{m.complaints7 === 1 ? "" : "s"}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function TrackingTab({ data, onSync, syncing }: { data: Extract<TrackingPayload, { ok: true }>; onSync: () => void; syncing: boolean }) {
  const t = data.tracking;
  const ls = data.lastSync;
  return (
    <div>
      <section className="act-section">
        <h2>Mailboxes, last 7 days</h2>
        <p className="sub">Bounce rate over 2% needs watching, over 3% is where inboxes start getting hurt.</p>
        {data.mailboxHealth.length ? <HealthStrip rows={data.mailboxHealth} /> : <div className="act-note">No mailbox has sent from a synced campaign yet.</div>}
      </section>

      <section className="act-section">
        <h2>Last {t.windowDays} days</h2>
        {t.totals.sent === 0 && t.totals.replies === 0 ? (
          <div className="act-note">Nothing has gone out from a synced campaign in the last {t.windowDays} days.</div>
        ) : (
          <div className="act-stats">
            <div className="act-stat"><div className="n">{t.totals.sent}</div><div className="l">Emails sent</div></div>
            <div className="act-stat"><div className="n">{t.totals.replies}</div><div className="l">People replied</div></div>
            <div className="act-stat"><div className="n">{pct(t.totals.replyRate)}</div><div className="l">Reply rate</div></div>
            <div className="act-stat"><div className="n">{t.totals.bounces}</div><div className="l">Bounced</div></div>
            <div className="act-stat"><div className="n">{t.totals.unsubscribes}</div><div className="l">Unsubscribed</div></div>
          </div>
        )}
      </section>

      {t.days.length > 0 && (
        <section className="act-section">
          <h2>By day</h2>
          <div className="act-tablewrap">
            <table className="act-table">
              <thead><tr><th>Day</th><th>Sent</th><th>Replied</th><th>Reply rate</th><th>Bounced</th></tr></thead>
              <tbody>
                {t.days.map((d) => (
                  <tr key={d.date}><td className="co">{day(d.date)}</td><td>{d.sent}</td><td>{d.replies}</td><td>{pct(d.replyRate, "none sent")}</td><td>{d.bounces}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {(t.steps.length > 0 || t.mailboxes.length > 0) && (
        <div className="ob-two">
          {t.steps.length > 0 && (
            <section className="act-section">
              <h2>By step</h2>
              <p className="sub">A reply counts for the last step that person was sent.</p>
              <div className="act-tablewrap">
                <table className="act-table ob-narrow">
                  <thead><tr><th>Step</th><th>Sent</th><th>Replied</th><th>Rate</th><th>Bounced</th></tr></thead>
                  <tbody>
                    {t.steps.map((s) => <tr key={s.step}><td className="co">Step {s.step}</td><td>{s.sent}</td><td>{s.replies}</td><td>{pct(s.replyRate)}</td><td>{s.bounces}</td></tr>)}
                  </tbody>
                </table>
              </div>
            </section>
          )}
          {t.mailboxes.length > 0 && (
            <section className="act-section">
              <h2>By mailbox</h2>
              <p className="sub">Which inbox each email left from.</p>
              <div className="act-tablewrap">
                <table className="act-table ob-narrow">
                  <thead><tr><th>Mailbox</th><th>Sent</th><th>Replied</th><th>Rate</th><th>Bounced</th></tr></thead>
                  <tbody>
                    {t.mailboxes.map((m) => <tr key={m.mailbox}><td className="co mono">{m.mailbox}</td><td>{m.sent}</td><td>{m.replies}</td><td>{pct(m.replyRate)}</td><td>{m.bounces}</td></tr>)}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </div>
      )}

      <section className="act-section ob-syncline">
        <span>
          {ls ? <>Instantly synced {ago(ls.at)} ({when(ls.at)}): {ls.pulled.sent} sends, {ls.pulled.replies} replies, {ls.pulled.leadOutcomes} lead outcomes read; {ls.written.inserted} new.</> : "Instantly has not been synced into the OS yet."}
          {" "}The sync runs every 15 minutes.
        </span>
        <button type="button" className="ob-btn" disabled={syncing} onClick={onSync}>{syncing ? "Syncing" : "Sync now"}</button>
      </section>
      {ls && ls.errors.length > 0 && (
        <div className="act-note warn">
          The last sync could not read everything:
          <ul>{ls.errors.map((e, i) => <li key={i}>{e}</li>)}</ul>
        </div>
      )}
    </div>
  );
}

function RetouchTab({ data }: { data: Extract<TrackingPayload, { ok: true }> }) {
  const r = data.retouchRules;
  return (
    <section className="act-section">
      <h2>Re-touch pool</h2>
      <p className="sub">
        Nobody is dropped until they opt out. After a sequence, a new custom round goes out about {r.intervalDays} days later,
        never more than {r.yearlyCap} emails to one person in a year. Anyone who replied, bounced, unsubscribed or complained is not in this list.
      </p>
      {data.retouch.length === 0 ? (
        <div className="act-note">Nobody is due a new round in the next 30 days.</div>
      ) : (
        <div className="act-tablewrap">
          <table className="act-table">
            <thead><tr><th>Company</th><th>Next round</th><th>Due</th><th>Last emailed</th><th>This year</th><th></th></tr></thead>
            <tbody>
              {data.retouch.map((x) => (
                <tr key={`${x.tenant}|${x.email}`}>
                  <td><div className="co">{x.company ?? x.email}</div><div className="mono small muted">{x.email}</div></td>
                  <td>Round {x.round + 1}</td>
                  <td>{day(x.dueAt)} <span className="muted">({inDays(x.dueAt)})</span></td>
                  <td>{day(x.lastSentAt)}</td>
                  <td>{x.sentThisYear} of {r.yearlyCap}</td>
                  <td>
                    <span className={`v2-status ${x.state === "due" ? "v2-status--info" : x.state === "capped" ? "v2-status--warn" : "ob-chip"}`}>
                      {x.state === "due" ? "Due" : x.state === "capped" ? `Capped until ${day(x.dueAt)}` : "Upcoming"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function SuppressedTab({ data }: { data: Extract<TrackingPayload, { ok: true }> }) {
  return (
    <>
      <section className="act-section">
        <h2>Suppressed for good</h2>
        <p className="sub">Unsubscribes, &quot;remove me&quot; replies, spam complaints and hard bounces. None of these people get another email from any round.</p>
        {data.suppression.length === 0 ? (
          <div className="act-note">Nobody has opted out, complained or hard bounced.</div>
        ) : (
          <div className="act-tablewrap">
            <table className="act-table">
              <thead><tr><th>Who</th><th>Why</th><th>When</th><th>Detail</th></tr></thead>
              <tbody>
                {data.suppression.map((s) => (
                  <tr key={`${s.tenant}|${s.email}`}>
                    <td><div className="co">{s.company ?? s.email}</div><div className="mono small muted">{s.email}</div></td>
                    <td><span className="v2-status v2-status--bad">{STOP_LABEL[s.reason]}</span></td>
                    <td>{when(s.at)}</td>
                    <td className="small">{s.detail ?? ""}{s.source ? <div className="muted">{s.source}</div> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {data.handoffs.length > 0 && (
        <section className="act-section">
          <h2>Replied, now yours</h2>
          <p className="sub">A real reply stops the engine for that person. These are waiting on a human, not suppressed.</p>
          <div className="act-tablewrap">
            <table className="act-table">
              <thead><tr><th>Who</th><th>When</th><th>What they said</th></tr></thead>
              <tbody>
                {data.handoffs.map((s) => (
                  <tr key={`${s.tenant}|${s.email}`}>
                    <td><div className="co">{s.company ?? s.email}</div><div className="mono small muted">{s.email}</div></td>
                    <td>{when(s.at)}</td>
                    <td className="small">{s.detail ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}

// ── Board ───────────────────────────────────────────────────────────────────

export default function OutreachBoard() {
  const [tab, setTab] = useState<Tab>("batch");
  const [tracking, setTracking] = useState<TrackingPayload | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);

  // Deep links (/outreach#tracking): follow the hash, including on back/forward.
  useEffect(() => {
    const follow = () => {
      const h = window.location.hash.replace("#", "");
      if (h === "tracking" || h === "retouch" || h === "suppressed") setTab(h);
    };
    const t = window.setTimeout(follow, 0);
    window.addEventListener("hashchange", follow);
    return () => { window.clearTimeout(t); window.removeEventListener("hashchange", follow); };
  }, []);

  const loadTracking = useCallback(async () => {
    try {
      const res = await fetch("/api/outreach/tracking", { cache: "no-store" });
      const j = (await res.json()) as TrackingPayload;
      setTracking(res.ok || !j.ok ? j : { ok: false, reason: `HTTP ${res.status}` });
    } catch (e) {
      setTracking({ ok: false, reason: e instanceof Error ? e.message : String(e) });
    }
  }, []);

  useEffect(() => { void loadTracking(); }, [loadTracking]);

  const sync = useCallback(async () => {
    setSyncing(true);
    setSyncMsg(null);
    const r = await send("/api/outreach/sync", "POST");
    setSyncing(false);
    const s = r.summary as SyncSummary | undefined;
    setSyncMsg(s ? `${s.written.inserted} new event${s.written.inserted === 1 ? "" : "s"} from Instantly${s.errors.length ? `, with ${s.errors.length} problem${s.errors.length === 1 ? "" : "s"}` : ""}.` : r.reason ?? "The sync did not run.");
    await loadTracking();
  }, [loadTracking]);

  const counts = useMemo(() => {
    if (!tracking?.ok) return null;
    return { retouch: tracking.retouch.filter((r) => r.state === "due").length, suppressed: tracking.suppression.length };
  }, [tracking]);

  const tabs: { id: Tab; label: string }[] = [
    { id: "batch", label: "Today's batch" },
    { id: "tracking", label: "Tracking" },
    { id: "retouch", label: counts?.retouch ? `Re-touch pool (${counts.retouch} due)` : "Re-touch pool" },
    { id: "suppressed", label: counts?.suppressed ? `Suppressed (${counts.suppressed})` : "Suppressed" },
  ];

  return (
    <div className="act-wrap ob-wrap">
      <div className="act-head">
        <h1>Outreach</h1>
        <p>Every custom cold email is reviewed here before it can go anywhere. Approving records your decision; handing drafts to Instantly is a separate step.</p>
      </div>

      <div className="act-tabs" role="tablist">
        {tabs.map((t) => (
          <button key={t.id} type="button" role="tab" className="act-tab" data-active={tab === t.id} aria-selected={tab === t.id}
            onClick={() => { setTab(t.id); history.replaceState(null, "", `${window.location.search}${t.id === "batch" ? "" : `#${t.id}`}`); }}>
            {t.label}
          </button>
        ))}
      </div>

      {syncMsg && <p className="ob-msg">{syncMsg}</p>}

      {tab === "batch" && <BatchTab />}
      {tab !== "batch" && !tracking && <div className="ob-skel" aria-label="Loading tracking" />}
      {tab !== "batch" && tracking && !tracking.ok && <div className="act-note dead">Tracking could not be read. {tracking.reason}</div>}
      {tab === "tracking" && tracking?.ok && <TrackingTab data={tracking} onSync={sync} syncing={syncing} />}
      {tab === "retouch" && tracking?.ok && <RetouchTab data={tracking} />}
      {tab === "suppressed" && tracking?.ok && <SuppressedTab data={tracking} />}
    </div>
  );
}
