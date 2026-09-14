"use client";
import { useCallback, useEffect, useState } from "react";
import "./activity.css";

// ───────────────────────────────────────────────────────────────────────────
// Messaging Activity — one place to see what email/text is going out.
//
// This is a read-only VIEW. It fetches three existing read-only endpoints from
// the browser (same-origin, session cookie carried automatically) and never
// touches a send endpoint:
//   * /api/messaging   — the automated cold-email QA board (queue + sent +
//                        lane paused/delivery state + the "no SMS lane" truth)
//   * /api/messages    — the unified sent-message ledger (email + sms rows)
//   * /api/sms/health  — live Twilio status (read-only)
//
// HONESTY: Wing's automated send lanes are effectively dead right now
// (daily_outreach.py lost its delivery step in the GHL retirement; there is NO
// automated SMS lane). Empty states here must read as "not wired / dead", not
// as a quiet zero. Any count we cannot read renders as "unknown", never 0.
// ───────────────────────────────────────────────────────────────────────────

/** Render a count honestly: null/undefined => "unknown", never 0-as-silence. */
function num(v: number | null | undefined): string {
  return v == null || !Number.isFinite(v) ? "unknown" : String(v);
}

type Flag = { code: string; label: string; detail: string };
type Msg = {
  ported: boolean;
  note: string;
  subjects: [string, string, string] | null;
  bodies: { d1: string; d3: string; d7: string } | null;
};
type QueueItem = {
  id: number; company: string | null; person: string | null; email: string;
  city: string | null; trade: string | null; status: string | null;
  statusNote: string | null; message: Msg; flags: Flag[];
};
type SentItem = {
  id: number; company: string | null; email: string | null; city: string | null;
  trade: string | null; status: string | null; emailedAt: string | null;
};
type Messaging = {
  lane: {
    available: boolean; reason: string | null; paused: boolean | null;
    sentToday: number | null; dailyCap: number; lastSendAt: string | null;
    windowNote: string; stateNote: string | null; deliveryWarning: string;
  };
  queue: {
    available: boolean; reason: string | null; total: number | null; shown: number;
    truncated: boolean; orderNote: string; droppedNote: string | null; items: QueueItem[];
  };
  byVertical: { trade: string; queued: number | null }[];
  sent: { available: boolean; reason: string | null; total: number | null; items: SentItem[] };
  guardrails: { qaFailed: number | null; badEmail: number | null; claimed: number | null; claimedNote: string | null; note: string };
  texts: { exists: boolean; note: string };
};

type LedgerItem = {
  id: number; channel: string; direction: string; to_addr: string | null;
  from_addr: string | null; body: string | null; status: string; error: string | null;
  created_at: string; contact_name: string | null; contact_company: string | null;
};
type Ledger = {
  available: boolean; tableMissing: boolean; reason: string | null;
  total: number | null; returned: number; items: LedgerItem[];
  emptyNote: string | null;
  smsPipe: { configured: boolean; note: string };
};

type Check = { ok: boolean; detail: string };
type SmsHealth = {
  configured: boolean; fromNumber: string | null;
  account: Check | null; webhook: Check | null; webhookAuth: Check; note: string;
};

function when(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleString();
}

type LaneKind = "dead" | "draft" | "live" | "unknown";
function Lane({ name, kind, state, detail }: { name: string; kind: LaneKind; state: string; detail: string }) {
  return (
    <div className={`act-lane lane-${kind}`}>
      <p className="lane-name">{name}</p>
      <span className="lane-state">{state}</span>
      <p className="lane-detail">{detail}</p>
    </div>
  );
}

export default function ActivityBoard() {
  const [msg, setMsg] = useState<Messaging | null>(null);
  const [ledger, setLedger] = useState<Ledger | null>(null);
  const [sms, setSms] = useState<SmsHealth | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<"email" | "text">("email");

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const [mR, lR, sR] = await Promise.all([
        fetch("/api/messaging", { cache: "no-store" }),
        fetch("/api/messages?channel=email&limit=200", { cache: "no-store" }),
        fetch("/api/sms/health", { cache: "no-store" }),
      ]);
      // Each is best-effort: one failing must not blank the whole board.
      setMsg(mR.ok ? await mR.json() : null);
      setLedger(lR.ok ? await lR.json() : null);
      setSms(sR.ok ? await sR.json() : null);
      if (!mR.ok && !lR.ok && !sR.ok) {
        setErr(`All data sources failed (messaging ${mR.status}, messages ${lR.status}, sms/health ${sR.status}).`);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // ── Lane status logic ──────────────────────────────────────────────
  // Automated cold email: DEAD regardless of the paused flag — the delivery
  // step was removed in the GHL retirement (see /api/messaging deliveryWarning).
  const coldEmail: { kind: LaneKind; state: string; detail: string } = (() => {
    if (!msg) return { kind: "unknown", state: "unknown", detail: "Could not read /api/messaging, so the automated cold-email lane state is unknown." };
    const pausedTxt = msg.lane.paused == null ? "pause flag unknown" : msg.lane.paused ? "flag: paused" : "flag: not paused";
    return {
      kind: "dead",
      state: "not wired",
      detail: `${msg.lane.deliveryWarning} (${pausedTxt}).`,
    };
  })();

  // 1:1 SMTP + Instantly: manual-only lanes. There is no health endpoint to
  // probe config from the client, so we report what is certain: nothing calls
  // them automatically, they only fire on a deliberate action.
  const smtpLane: { kind: LaneKind; state: string; detail: string } = {
    kind: "draft",
    state: "manual only",
    detail: "1:1 SMTP send (/api/email/send) exists but nothing calls it automatically — it only fires when a person sends from the Email page. Returns 503 if SMTP env is unset.",
  };
  const campaignLane: { kind: LaneKind; state: string; detail: string } = {
    kind: "draft",
    state: "manual only",
    detail: "Instantly campaign enqueue (/api/email/campaign) adds a lead to a cold campaign on a deliberate action; Instantly then sends on its own warmed schedule. No automatic enqueue from the OS.",
  };

  // SMS: live truth from /api/sms/health + the "no automated lane" fact.
  const smsLane: { kind: LaneKind; state: string; detail: string } = (() => {
    const noAuto = msg?.texts && !msg.texts.exists;
    if (!sms) {
      return { kind: noAuto ? "dead" : "unknown", state: noAuto ? "no auto lane" : "unknown",
        detail: (msg?.texts.note ?? "Could not read /api/sms/health.") };
    }
    const base = msg?.texts.note ?? "";
    if (!sms.configured) {
      return { kind: "dead", state: "not wired", detail: `Twilio is NOT configured on this deployment, and there is no automated SMS lane regardless. ${base}` };
    }
    // Twilio configured = manual 1:1 texting possible, but still no automation.
    const acct = sms.account?.detail ?? "";
    return { kind: "draft", state: "manual only",
      detail: `Twilio is configured (manual 1:1 texting via /api/sms/send only — no automated SMS lane exists). ${acct}` };
  })();

  const emailSent = (ledger?.items ?? []).filter((m) => m.channel === "email" && m.direction === "outbound");

  return (
    <div className="act-wrap">
      <div className="act-head">
        <button className="act-refresh" onClick={load} disabled={loading}>{loading ? "Loading…" : "Refresh"}</button>
        <h1>Messaging Activity</h1>
        <p>
          Everything Wing is sending — or would send — in one place: what has actually gone out, what is queued next
          with a word-for-word preview, and which lanes are live versus dead. This view sends nothing and only reads.
        </p>
      </div>

      {err && <div className="act-error">{err}</div>}

      {/* ── Lane status strip ─────────────────────────────────────── */}
      <div className="act-lanes">
        <Lane name="Automated cold email" kind={coldEmail.kind} state={coldEmail.state} detail={coldEmail.detail} />
        <Lane name="Email · 1:1 (SMTP)" kind={smtpLane.kind} state={smtpLane.state} detail={smtpLane.detail} />
        <Lane name="Email · campaign (Instantly)" kind={campaignLane.kind} state={campaignLane.state} detail={campaignLane.detail} />
        <Lane name="Text · SMS (Twilio)" kind={smsLane.kind} state={smsLane.state} detail={smsLane.detail} />
      </div>

      {/* ── Tabs ──────────────────────────────────────────────────── */}
      <div className="act-tabs">
        <button className="act-tab" data-active={tab === "email"} onClick={() => setTab("email")}>Email</button>
        <button className="act-tab" data-active={tab === "text"} onClick={() => setTab("text")}>Text</button>
      </div>

      {loading && !msg && !ledger && <div className="act-loading">Loading messaging activity…</div>}

      {tab === "email" && (
        <>
          {/* Sent */}
          <section className="act-section">
            <h2>Sent</h2>
            <p className="sub">Email that has actually left the building, newest first — from the unified message ledger and the cold-engine sent rows.</p>

            {ledger?.tableMissing && (
              <div className="act-note dead">{ledger.reason}</div>
            )}
            {ledger && !ledger.available && !ledger.tableMissing && (
              <div className="act-note warn">Message ledger unavailable: {ledger.reason ?? "unknown reason"}.</div>
            )}

            <div className="act-stats">
              <div className="act-stat"><div className="n">{num(ledger?.total)}</div><div className="l">ledger rows</div></div>
              <div className="act-stat"><div className="n">{num(msg?.sent.total)}</div><div className="l">cold-engine sent</div></div>
              <div className="act-stat"><div className="n">{num(msg?.lane.sentToday)}</div><div className="l">sent today</div></div>
            </div>

            {ledger?.available && emailSent.length > 0 && (
              <div className="act-tablewrap">
                <table className="act-table">
                  <thead><tr><th>When</th><th>To</th><th>Who</th><th>Status</th></tr></thead>
                  <tbody>
                    {emailSent.map((m) => (
                      <tr key={m.id}>
                        <td>{when(m.created_at)}</td>
                        <td>{m.to_addr ?? "—"}</td>
                        <td>{m.contact_company ? <span className="co">{m.contact_company}</span> : (m.contact_name ?? "—")}</td>
                        <td>{m.error ? <span style={{ color: "var(--red)" }}>{m.status}: {m.error}</span> : <span className="act-badge">{m.status}</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {ledger?.available && emailSent.length === 0 && !ledger.tableMissing && (
              <div className="act-note dead">
                Nothing is sending. The ledger holds no outbound email — with the automated cold lane not wired (delivery step removed in the GHL retirement), this is empty because no pipe is running, not because it is a quiet day.
                {ledger.emptyNote ? ` ${ledger.emptyNote}` : ""}
              </div>
            )}

            {/* Cold-engine sent rows (emailed_at) — separate honest source */}
            {msg?.sent.available && (msg.sent.items.length > 0) && (
              <>
                <p className="sub" style={{ marginTop: 16 }}>Cold-engine rows stamped as emailed (from prospects.emailed_at):</p>
                <div className="act-tablewrap">
                  <table className="act-table">
                    <thead><tr><th>When</th><th>Company</th><th>Email</th><th>Trade</th><th>Status</th></tr></thead>
                    <tbody>
                      {msg.sent.items.map((s) => (
                        <tr key={s.id}>
                          <td>{when(s.emailedAt)}</td>
                          <td><span className="co">{s.company ?? "—"}</span></td>
                          <td>{s.email ?? "—"}</td>
                          <td>{s.trade ?? "—"}</td>
                          <td><span className="act-badge">{s.status ?? "—"}</span></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
            {msg && !msg.sent.available && (
              <div className="act-note warn" style={{ marginTop: 12 }}>Cold-engine sent history unavailable: {msg.sent.reason ?? "unknown reason"}.</div>
            )}
          </section>

          {/* Queued / next to send */}
          <section className="act-section">
            <h2>Queued · next to send</h2>
            <p className="sub">
              The exact pool the cold-email sender would draw from next, in send order, with each message rendered word-for-word for review.
              {msg?.queue.orderNote ? ` ${msg.queue.orderNote}` : ""}
            </p>

            {msg && (
              <div className="act-note warn" style={{ marginBottom: 14 }}>
                {msg.lane.deliveryWarning} Treat this as a pre-flight QA queue, not an outbox — nothing below is actually going out today.
              </div>
            )}

            {msg && !msg.queue.available && (
              <div className="act-note warn">Queue unavailable: {msg.queue.reason ?? "unknown reason"}.</div>
            )}

            <div className="act-stats">
              <div className="act-stat"><div className="n">{num(msg?.queue.total)}</div><div className="l">in queue</div></div>
              {(msg?.byVertical ?? []).map((v) => (
                <div className="act-stat" key={v.trade}><div className="n">{num(v.queued)}</div><div className="l">{v.trade}</div></div>
              ))}
            </div>

            {msg?.queue.droppedNote && <div className="act-note warn" style={{ marginBottom: 12 }}>{msg.queue.droppedNote}</div>}

            {msg?.queue.available && msg.queue.items.length === 0 && (
              <div className="act-note">The eligible queue is empty right now — no rows match the sender&apos;s filter.</div>
            )}

            {(msg?.queue.items ?? []).map((q) => (
              <div className="act-queue-item" key={q.id}>
                <div className="qhead">
                  <span className="co">{q.company ?? "(no company name)"}</span>
                  <span className="meta">{q.person ? `${q.person} · ` : ""}{q.email} · {q.trade ?? "?"}{q.city ? ` · ${q.city}` : ""}</span>
                  <span className="act-badge">{q.status ?? "—"}</span>
                </div>
                {q.statusNote && <span className="lane-detail" style={{ display: "block" }}>{q.statusNote}</span>}
                {q.flags.map((f) => (
                  <span className="act-flag" key={f.code}>⚠ {f.label} — {f.detail}</span>
                ))}
                {q.message.bodies ? (
                  <details className="act-preview">
                    <summary>Preview the 3 emails this row would receive</summary>
                    {q.message.subjects && (
                      <>
                        <div className="subj">Day 1 — {q.message.subjects[0]}</div>
                        <pre>{q.message.bodies.d1}</pre>
                        <div className="subj">Day 3 — {q.message.subjects[1]}</div>
                        <pre>{q.message.bodies.d3}</pre>
                        <div className="subj">Day 7 — {q.message.subjects[2]}</div>
                        <pre>{q.message.bodies.d7}</pre>
                      </>
                    )}
                    <p className="lane-detail">{q.message.note}</p>
                  </details>
                ) : (
                  <p className="lane-detail">{q.message.note}</p>
                )}
              </div>
            ))}
          </section>

          {/* Guardrails */}
          {msg && (
            <section className="act-section">
              <h2>Blocked by the sender&apos;s own checks</h2>
              <p className="sub">{msg.guardrails.note}</p>
              <div className="act-stats">
                <div className="act-stat"><div className="n">{num(msg.guardrails.qaFailed)}</div><div className="l">qa-failed</div></div>
                <div className="act-stat"><div className="n">{num(msg.guardrails.badEmail)}</div><div className="l">bad email</div></div>
                <div className="act-stat"><div className="n">{num(msg.guardrails.claimed)}</div><div className="l">claimed</div></div>
              </div>
              {msg.guardrails.claimedNote && <div className="act-note warn">{msg.guardrails.claimedNote}</div>}
            </section>
          )}
        </>
      )}

      {tab === "text" && (
        <section className="act-section">
          <h2>Text (SMS)</h2>
          <p className="sub">The honest state of texting at Wing.</p>

          {msg && !msg.texts.exists && (
            <div className="act-note dead">
              {msg.texts.note}
            </div>
          )}
          {!msg && (
            <div className="act-note warn">Could not read /api/messaging, so the automated-SMS state is unknown. Nothing here should be read as an active text lane.</div>
          )}

          {/* Live Twilio pipe status (manual 1:1 only) */}
          <h2 style={{ marginTop: 22 }}>Twilio pipe (manual 1:1 only)</h2>
          <p className="sub">Whether the manual send/receive pipe is even configured — this is NOT an automated lane. Live from /api/sms/health.</p>
          {!sms && <div className="act-note warn">/api/sms/health did not return — Twilio status unknown.</div>}
          {sms && !sms.configured && <div className="act-note dead">{sms.note}</div>}
          {sms && sms.configured && (
            <>
              <div className="act-note" style={{ marginBottom: 10 }}>
                From number: {sms.fromNumber ?? "unknown"}. {sms.note}
              </div>
              {sms.account && <div className={`act-note ${sms.account.ok ? "" : "warn"}`} style={{ marginBottom: 8 }}>Account: {sms.account.detail}</div>}
              {sms.webhook && <div className={`act-note ${sms.webhook.ok ? "" : "warn"}`} style={{ marginBottom: 8 }}>Inbound webhook: {sms.webhook.detail}</div>}
              <div className={`act-note ${sms.webhookAuth.ok ? "" : "warn"}`}>Webhook auth: {sms.webhookAuth.detail}</div>
            </>
          )}

          {/* Any SMS rows that were logged manually */}
          <h2 style={{ marginTop: 22 }}>Logged texts</h2>
          <p className="sub">Any SMS that has actually been logged into the ledger (manual sends or inbound replies).</p>
          <SmsLedger />
        </section>
      )}
    </div>
  );
}

// A small self-contained fetch for SMS ledger rows, kept separate so the email
// ledger fetch above (channel=email) stays focused. Honest empty state.
function SmsLedger() {
  const [rows, setRows] = useState<LedgerItem[] | null>(null);
  const [state, setState] = useState<{ tableMissing: boolean; reason: string | null; available: boolean; emptyNote: string | null } | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch("/api/messages?channel=sms&limit=100", { cache: "no-store" });
        if (!r.ok) { setFailed(true); return; }
        const d: Ledger = await r.json();
        setRows(d.items ?? []);
        setState({ tableMissing: d.tableMissing, reason: d.reason, available: d.available, emptyNote: d.emptyNote });
      } catch {
        setFailed(true);
      }
    })();
  }, []);

  if (failed) return <div className="act-note warn">Could not read the SMS ledger — status unknown.</div>;
  if (!state) return <div className="act-loading">Loading…</div>;
  if (state.tableMissing) return <div className="act-note dead">{state.reason}</div>;
  if (!state.available) return <div className="act-note warn">SMS ledger unavailable: {state.reason ?? "unknown reason"}.</div>;
  if (!rows || rows.length === 0) {
    return <div className="act-note dead">No text has ever been logged. With no automated SMS lane and manual texting only, an empty list here means nothing has been sent or received — not a quiet inbox.</div>;
  }
  return (
    <div className="act-tablewrap">
      <table className="act-table">
        <thead><tr><th>When</th><th>Dir</th><th>Counterpart</th><th>Body</th><th>Status</th></tr></thead>
        <tbody>
          {rows.map((m) => (
            <tr key={m.id}>
              <td>{when(m.created_at)}</td>
              <td>{m.direction}</td>
              <td>{m.contact_company ?? m.contact_name ?? (m.direction === "inbound" ? m.from_addr : m.to_addr) ?? "—"}</td>
              <td>{m.body ?? "—"}</td>
              <td>{m.error ? <span style={{ color: "var(--red)" }}>{m.status}: {m.error}</span> : <span className="act-badge">{m.status}</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
