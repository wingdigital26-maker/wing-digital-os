"use client";
import { useCallback, useEffect, useState } from "react";

// ───────────────────────────────────────────────────────────────────────────
// Instantly on /activity: replies first (the part that makes money), then
// every campaign's real totals, then the focus campaign's detail.
//
// Read-only. Two endpoints:
//   /api/outreach/instantly/replies   re-checked every 15s while the tab is visible
//   /api/outreach/instantly           campaigns + totals, re-checked every 2 min
// Both are cached and rate-budgeted server-side, so an open tab is cheap.
//
// Honesty: every failure says why (no key / key rejected / Instantly down /
// rate limited), stale data says how old it is, and a number we could not
// read shows "unknown", never 0. No "live" dots or badges (standing rule): the
// only freshness signal is the plain "checked 12s ago" line.
// ───────────────────────────────────────────────────────────────────────────

type Stats = {
  leads: number | null; contacted: number | null; sent: number | null; opens: number | null;
  replies: number | null; autoReplies: number | null; clicks: number | null; bounced: number | null;
  unsubscribed: number | null; opportunities: number | null;
};
type CampaignRow = { id: string; name: string; status: number; state: string; schedule: string | null; openTracking: boolean | null; stats: Stats | null };
type Summary = {
  status: "ok" | "no_campaigns" | "no_key" | "error";
  available: boolean;
  reason: string | null;
  stale: boolean;
  staleReason: string | null;
  checkedAt: string | null;
  campaigns: CampaignRow[];
  totals: Stats | null;
  campaign: { id: string; name: string; status: number; state: string; schedule: string | null } | null;
  stats: Stats | null;
  sequence: { step: number; delayDays: number; subject: string; body: string }[];
  sent: { to: string; from: string; at: string; subject: string; body: string }[];
  sentOk: boolean;
  sentReason: string | null;
  leadsOk: boolean;
  leads: { email: string; name: string; company: string; contacted: boolean; replied: boolean }[];
  notes: string[];
};
type Reply = {
  key: string; source: "instantly" | "webhook"; at: string; fromEmail: string;
  name: string | null; company: string | null; campaign: string | null; subject: string;
  text: string; snippet: string; unread: boolean | null; autoReply: boolean;
  interest: string | null; temperature: "hot" | "neutral" | "cold"; uniboxUrl: string;
};
type Replies = {
  status: "ok" | "partial" | "error";
  reason: string | null;
  stale: boolean;
  staleReason: string | null;
  replies: Reply[];
  counts: { total: number; hot: number; unread: number };
  checkedAt: string | null;
};

const REPLIES_EVERY_MS = 15_000;
const SUMMARY_EVERY_MS = 120_000;

function num(v: number | null | undefined): string {
  return v == null || !Number.isFinite(v) ? "unknown" : v.toLocaleString();
}

function ago(iso: string | null, now: number): string {
  if (!iso) return "never";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return d < 30 ? `${d}d ago` : new Date(t).toLocaleDateString();
}

function pct(part: number | null | undefined, whole: number | null | undefined): string | null {
  if (part == null || whole == null || whole <= 0) return null;
  return `${((part / whole) * 100).toFixed(1)}%`;
}

/** Run fn now, then every ms while the tab is visible; re-run at once when it
 *  becomes visible again. fn must be stable (useCallback). */
function useVisiblePoll(fn: () => void, ms: number) {
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => { if (!timer) timer = setInterval(fn, ms); };
    const stop = () => { if (timer) { clearInterval(timer); timer = null; } };
    const onVis = () => {
      if (document.visibilityState === "visible") { fn(); start(); } else stop();
    };
    const first = setTimeout(fn, 0);
    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVis);
    return () => { clearTimeout(first); stop(); document.removeEventListener("visibilitychange", onVis); };
  }, [fn, ms]);
}

export default function InstantlyPanel() {
  const [sum, setSum] = useState<Summary | null>(null);
  const [sumErr, setSumErr] = useState<string | null>(null);
  const [rep, setRep] = useState<Replies | null>(null);
  const [repErr, setRepErr] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const loadSummary = useCallback(async () => {
    try {
      const r = await fetch("/api/outreach/instantly", { cache: "no-store" });
      if (!r.ok) throw new Error(`the OS answered HTTP ${r.status}`);
      setSum(await r.json());
      setSumErr(null);
    } catch (e) {
      setSumErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const loadReplies = useCallback(async (force = false) => {
    if (force) setChecking(true);
    try {
      const r = await fetch(`/api/outreach/instantly/replies${force ? "?force=1" : ""}`, { cache: "no-store" });
      if (!r.ok) throw new Error(`the OS answered HTTP ${r.status}`);
      setRep(await r.json());
      setRepErr(null);
    } catch (e) {
      setRepErr(e instanceof Error ? e.message : String(e));
    } finally {
      setChecking(false);
    }
  }, []);

  const pollReplies = useCallback(() => { void loadReplies(); }, [loadReplies]);
  const tick = useCallback(() => setNow(Date.now()), []);
  useVisiblePoll(pollReplies, REPLIES_EVERY_MS);
  useVisiblePoll(loadSummary, SUMMARY_EVERY_MS);
  useVisiblePoll(tick, 5_000);

  const t = sum?.totals ?? null;

  return (
    <section className="act-section act-instantly">
      <h2>Instantly</h2>
      <p className="sub">Wing&apos;s cold email, read straight from Instantly.ai. Replies first. This page only reads; you answer replies in Instantly.</p>

      {/* ── Replies ─────────────────────────────────────────────── */}
      <div className="inst-replies" id="replies">
        <div className="inst-replies-head">
          <h3 className="inst-subhead">
            Replies
            {rep && rep.counts.total > 0 && (
              <span className="inst-count">{rep.counts.total}{rep.counts.hot > 0 ? ` · ${rep.counts.hot} interested` : ""}</span>
            )}
          </h3>
          <button className="act-refresh inst-check" onClick={() => loadReplies(true)} disabled={checking}>
            {checking ? "Checking…" : "Check now"}
          </button>
        </div>

        {!rep && !repErr && <div className="act-loading">Checking Instantly for replies…</div>}
        {repErr && !rep && <div className="act-note warn">Replies could not be loaded: {repErr}.</div>}

        {rep && rep.status === "error" && (
          <div className="act-note dead">Replies are unknown right now. {rep.reason}</div>
        )}
        {rep && rep.status === "partial" && (
          <div className="act-note warn">Instantly could not be read ({rep.reason}). Showing only replies that arrived by webhook.</div>
        )}
        {rep && rep.stale && (
          <div className="act-note warn">Showing replies as of {ago(rep.checkedAt, now)}. {rep.staleReason}</div>
        )}

        {rep && rep.status === "ok" && rep.replies.length === 0 && (
          <div className="act-note">
            No replies yet. Instantly&apos;s inbox has none{t?.sent != null ? ` across ${num(t.sent)} emails sent` : ""}. This is the real number, not a failed read.
          </div>
        )}

        {rep && rep.replies.length > 0 && (
          <div className="inst-inbox">
            {rep.replies.slice(0, 25).map((r) => {
              const isOpen = open === r.key;
              return (
                <div className={`inst-email inst-reply temp-${r.temperature}`} key={r.key}>
                  <div className="inst-email-head">
                    <span className="inst-to">
                      {r.name ? `${r.name} · ` : ""}{r.fromEmail}
                      {r.unread && <span className="inst-tag">unread</span>}
                      {r.interest && <span className={`inst-tag tag-${r.temperature}`}>{r.interest}</span>}
                      {r.autoReply && <span className="inst-tag">auto reply</span>}
                    </span>
                    <span className="inst-time" title={new Date(r.at).toLocaleString()}>{ago(r.at, now)}</span>
                  </div>
                  <div className="inst-email-meta">
                    {[r.company, r.campaign].filter(Boolean).join(" · ") || "campaign not recorded"}
                  </div>
                  <div className="inst-email-subject">{r.subject}</div>
                  <div className="inst-email-body">{isOpen ? r.text : r.snippet}</div>
                  <div className="inst-reply-actions">
                    {r.text.length > r.snippet.length && (
                      <button className="inst-link" onClick={() => setOpen(isOpen ? null : r.key)}>
                        {isOpen ? "Show less" : "Read all"}
                      </button>
                    )}
                    <a className="inst-link" href={r.uniboxUrl} target="_blank" rel="noopener noreferrer">Answer in Instantly</a>
                  </div>
                </div>
              );
            })}
            {rep.replies.length > 25 && <p className="lane-detail">+ {rep.replies.length - 25} older replies not shown.</p>}
          </div>
        )}
        {rep && rep.checkedAt && !rep.stale && (
          <p className="inst-fresh">Checked Instantly {ago(rep.checkedAt, now)}. Re-checks every 15 seconds while this page is open.</p>
        )}
      </div>

      {/* ── Campaigns ───────────────────────────────────────────── */}
      {!sum && !sumErr && <div className="act-loading">Loading campaigns…</div>}
      {sumErr && !sum && <div className="act-note warn">Campaigns could not be loaded: {sumErr}.</div>}
      {sum && (sum.status === "no_key" || sum.status === "error") && (
        <div className="act-note dead">Campaign numbers are unknown right now. {sum.reason}</div>
      )}
      {sum && sum.status === "no_campaigns" && (
        <div className="act-note">{sum.reason}</div>
      )}

      {sum && sum.status === "ok" && (
        <>
          {sum.stale && <div className="act-note warn">Numbers as of {ago(sum.checkedAt, now)}. {sum.staleReason}</div>}

          <div className="act-stats">
            <div className="act-stat"><div className="n">{num(t?.sent)}</div><div className="l">emails sent</div></div>
            <div className="act-stat"><div className="n">{num(t?.contacted)}</div><div className="l">people contacted</div></div>
            <div className="act-stat"><div className="n">{num(t?.replies)}</div><div className="l">replies{pct(t?.replies, t?.contacted) ? ` · ${pct(t?.replies, t?.contacted)}` : ""}</div></div>
            <div className="act-stat"><div className="n">{num(t?.opens)}</div><div className="l">opens</div></div>
            <div className="act-stat"><div className="n">{num(t?.bounced)}</div><div className="l">bounced{pct(t?.bounced, t?.sent) ? ` · ${pct(t?.bounced, t?.sent)}` : ""}</div></div>
            <div className="act-stat"><div className="n">{num(t?.unsubscribed)}</div><div className="l">unsubscribed</div></div>
          </div>
          {t && t.opens === 0 && (t.sent ?? 0) > 0 &&
            sum.campaigns.filter((c) => (c.stats?.sent ?? 0) > 0).every((c) => c.openTracking === false) && (
            <p className="lane-detail">Opens read 0 because open tracking is switched off in Instantly for these campaigns. Replies are the number that counts.</p>
          )}

          <h3 className="inst-subhead">Campaigns</h3>
          <div className="inst-camps">
            {sum.campaigns.map((c) => (
              <div className="inst-camp" key={c.id}>
                <div className="inst-camp-name">{c.name}</div>
                <div className="inst-camp-state">{c.state}{c.schedule ? ` · ${c.schedule}` : ""}</div>
                <div className="inst-camp-nums">
                  <span><b>{num(c.stats?.sent)}</b> sent</span>
                  <span><b>{num(c.stats?.contacted)}</b> contacted</span>
                  <span><b>{num(c.stats?.replies)}</b> replies</span>
                  <span><b>{num(c.stats?.bounced)}</b> bounced</span>
                  <span><b>{num(c.stats?.leads)}</b> leads</span>
                </div>
              </div>
            ))}
          </div>

          {sum.campaign && (
            <>
              <h3 className="inst-subhead">Latest sends · {sum.campaign.name}</h3>
              {!sum.sentOk ? (
                <div className="act-note warn">Latest sends are unknown right now. {sum.sentReason}</div>
              ) : sum.sent.length === 0 ? (
                <div className="act-note">Instantly shows no emails sent from this campaign yet.</div>
              ) : (
                <div className="inst-inbox">
                  {sum.sent.slice(0, 10).map((s, i) => (
                    <details className="inst-email inst-sent" key={`${s.to}-${s.at}-${i}`}>
                      <summary>
                        <span className="inst-to">{s.to}</span>
                        <span className="inst-sent-subj">{s.subject}</span>
                        <span className="inst-time">{ago(s.at, now)}</span>
                      </summary>
                      <div className="inst-email-meta">from {s.from}</div>
                      <div className="inst-email-body">{s.body}</div>
                    </details>
                  ))}
                  {sum.sent.length > 10 && <p className="lane-detail">+ {sum.sent.length - 10} more in Instantly.</p>}
                </div>
              )}

              {(() => {
                const pending = sum.leads.filter((l) => !l.contacted);
                if (!sum.leadsOk || sum.leads.length === 0) return null;
                return (
                  <>
                    <h3 className="inst-subhead inst-subhead-sm">
                      {pending.length === 0
                        ? `Queued next: none. All ${sum.leads.length} leads have had their first email`
                        : `Queued next: ${pending.length} of ${sum.leads.length} leads not emailed yet`}
                    </h3>
                    {pending.length > 0 && (
                      <div className="inst-queue">
                        {pending.slice(0, 12).map((l, i) => (
                          <div className="inst-queue-row" key={`${l.email}-${i}`}>
                            <span className="inst-queue-name">{l.name || "(no name)"}</span>
                            {l.company && <span className="inst-queue-company">{l.company}</span>}
                            <span className="inst-queue-email">{l.email}</span>
                          </div>
                        ))}
                        {pending.length > 12 && <p className="lane-detail">+ {pending.length - 12} more not shown.</p>}
                      </div>
                    )}
                  </>
                );
              })()}

              {sum.sequence.length > 0 && (
                <details className="act-preview inst-sequence">
                  <summary>Sequence ({sum.sequence.length} step{sum.sequence.length === 1 ? "" : "s"})</summary>
                  {sum.sequence.map((step) => (
                    <div key={step.step}>
                      <div className="subj">Step {step.step} · day {step.delayDays}: {step.subject}</div>
                      <pre>{step.body}</pre>
                    </div>
                  ))}
                </details>
              )}
            </>
          )}

          {sum.notes.length > 0 && sum.notes.map((n, i) => <div className="act-note warn" key={i}>{n}</div>)}
        </>
      )}
    </section>
  );
}
