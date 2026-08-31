"use client";
import { useCallback, useEffect, useState } from "react";

// ───────────────────────────────────────────────────────────────────────────
// MessagingBoard — the automated-sending QA surface.
//
// The CRM's "Everything" tab covers drafts written FOR clients. This tab
// answers the other question Jack asked: who is the AUTOMATED engine going to
// email next, what exactly will each of them receive, and is any of it not
// solid. It renders /api/messaging, which is read-only against the same
// Supabase the cloud sender runs on — nothing on this screen can transmit.
//
// Same honesty rules as the rest of the OS: unknown renders as unknown, an
// empty panel says WHY it is empty, and every caveat the route ships
// (template-port drift, the retired GHL delivery path, the enriching-rows
// gate) is shown, not swallowed.
// ───────────────────────────────────────────────────────────────────────────

type QaFlag = { code: string; label: string; detail: string };

type Rendered = {
  ported: boolean;
  note: string;
  subjects: [string, string, string] | null;
  bodies: { d1: string; d3: string; d7: string } | null;
};

type QueueItem = {
  id: number;
  company: string | null;
  person: string | null;
  email: string;
  city: string | null;
  trade: string | null;
  status: string | null;
  statusNote: string | null;
  message: Rendered;
  flags: QaFlag[];
};

type Payload = {
  lane: {
    available: boolean; reason: string | null;
    paused: boolean | null; sentToday: number | null; dailyCap: number;
    lastSendAt: string | null; windowNote: string; stateNote: string | null;
    deliveryWarning: string;
  };
  queue: {
    available: boolean; reason: string | null;
    total: number | null; shown: number; truncated: boolean;
    orderNote: string; droppedNote: string | null;
    items: QueueItem[];
  };
  byVertical: { trade: string; queued: number | null }[];
  sent: {
    available: boolean; reason: string | null; total: number | null;
    items: { id: number; company: string | null; email: string | null; city: string | null; trade: string | null; status: string | null; emailedAt: string | null }[];
  };
  guardrails: {
    qaFailed: number | null; badEmail: number | null; claimed: number | null;
    claimedNote: string | null; note: string;
  };
  texts: { exists: boolean; note: string };
};

function when(iso: string | null): string {
  if (!iso) return "no date recorded";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const mins = Math.round((Date.now() - t) / 60000);
  if (mins < 0) return new Date(t).toLocaleString();
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return days < 60 ? `${days}d ago` : new Date(t).toLocaleDateString();
}

function Note({ text, tone = "var(--orange)" }: { text: string; tone?: string }) {
  return (
    <div style={{
      border: `1px solid ${tone}`, borderRadius: 10, padding: "9px 12px",
      background: "var(--bg-card)", fontSize: 12, lineHeight: 1.55, color: tone,
    }}>
      {text}
    </div>
  );
}

const label: React.CSSProperties = {
  fontSize: 10.5, textTransform: "uppercase", letterSpacing: ".06em",
  color: "var(--text-muted)", fontWeight: 700,
};

function Stat({ n, v, tone }: { n: string; v: string; tone?: string }) {
  return (
    <div style={{ minWidth: 120 }}>
      <div style={label}>{n}</div>
      <div style={{ fontSize: 16, fontWeight: 700, marginTop: 3, color: tone ?? "var(--text-primary)" }}>
        {v}
      </div>
    </div>
  );
}

function MessageBody({ title, subject, body }: { title: string; subject: string | null; body: string }) {
  return (
    <div style={{
      border: "1px solid var(--border)", borderRadius: 10, padding: "10px 12px",
      background: "var(--bg-card)", minWidth: 0,
    }}>
      <div style={{ ...label, marginBottom: 5 }}>{title}</div>
      {subject !== null && (
        <div style={{ fontSize: 12.5, fontWeight: 700, color: "var(--text-primary)", marginBottom: 6 }}>
          Subject: {subject}
        </div>
      )}
      <pre style={{
        margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word",
        fontFamily: "inherit", fontSize: 12.5, lineHeight: 1.6, color: "var(--text-secondary)",
      }}>
        {body}
      </pre>
    </div>
  );
}

export default function MessagingBoard() {
  const [data, setData] = useState<Payload | null>(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setErr("");
    try {
      const res = await fetch("/api/messaging");
      const j = (await res.json()) as Payload;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData(j);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  if (loading && !data) {
    return <div style={{ fontSize: 13, color: "var(--text-muted)" }}>Reading the automated send queue…</div>;
  }
  if (err && !data) {
    return <Note tone="var(--red)" text={`The automated messaging lane could not be read: ${err}. Nothing below is available — this is a failure, not an empty queue.`} />;
  }
  if (!data) return null;

  const { lane, queue, byVertical, sent, guardrails, texts } = data;
  const laneTone = lane.paused === true ? "var(--orange)" : lane.paused === false ? "var(--green)" : "var(--text-muted)";
  const laneWord = lane.paused === true ? "PAUSED" : lane.paused === false ? "ARMED" : "unknown";

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "baseline" }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: "var(--text-primary)" }}>
          Automated messaging
        </h2>
        <span style={{ fontSize: 12.5, color: "var(--text-muted)" }}>
          Every person the cold-email engine will contact next, with the exact message they would
          get. Read-only: nothing on this screen can send.
        </span>
        <button
          type="button"
          onClick={() => { void load(); }}
          style={{
            marginLeft: "auto", padding: "5px 11px", borderRadius: 999, fontSize: 12.5,
            cursor: "pointer", background: "transparent",
            border: "1px solid var(--border)", color: "var(--text-muted)",
          }}
        >
          {loading ? "Loading" : "Refresh"}
        </button>
      </div>

      {/* ── Lane state ──────────────────────────────────────────────────── */}
      {!lane.available && lane.reason && (
        <Note tone="var(--red)" text={`The engine's state could not be read: ${lane.reason}. Paused/armed and today's count are unknown below.`} />
      )}
      <div style={{
        border: `1px solid ${laneTone}`, borderRadius: 12, padding: "12px 14px",
        background: "var(--bg-card)", display: "flex", flexWrap: "wrap", gap: 18, alignItems: "flex-start",
      }}>
        <Stat n="Engine" v={laneWord} tone={laneTone} />
        <Stat n="Sent today" v={lane.sentToday == null ? "unknown" : `${lane.sentToday} / ${lane.dailyCap}`} />
        <Stat n="Last send" v={when(lane.lastSendAt)} />
        <Stat n="Queued (all verticals)" v={queue.total == null ? "unknown" : String(queue.total)} />
        <div style={{ flex: "1 1 280px", fontSize: 12, lineHeight: 1.55, color: "var(--text-muted)" }}>
          {lane.windowNote}
          {lane.stateNote ? ` ${lane.stateNote}` : ""}
        </div>
      </div>
      <Note text={lane.deliveryWarning} />
      {byVertical.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {byVertical.map((v) => (
            <span key={v.trade} style={{
              fontSize: 11.5, fontWeight: 600, color: "var(--text-secondary)",
              border: "1px solid var(--border)", borderRadius: 999, padding: "3px 11px",
            }}>
              {v.trade}: {v.queued == null ? "unknown" : `${v.queued} queued`}
            </span>
          ))}
        </div>
      )}

      {/* ── The queue ───────────────────────────────────────────────────── */}
      <div>
        <div style={{ fontSize: 14.5, fontWeight: 700, color: "var(--text-primary)", marginBottom: 4 }}>
          Next out the door
        </div>
        <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5, marginBottom: 10 }}>
          {queue.orderNote}
          {queue.truncated && queue.total != null &&
            ` Showing the first ${queue.shown} of ${queue.total}; the rest follow in the same order.`}
        </div>
        {queue.droppedNote && <Note text={queue.droppedNote} />}
        {!queue.available && queue.reason && (
          <Note tone="var(--red)" text={`The queue could not be read: ${queue.reason}. An empty list below is a failure, not an empty queue.`} />
        )}
        {queue.available && queue.items.length === 0 && (
          <div style={{ fontSize: 12.5, color: "var(--text-muted)" }}>
            The eligible pool is empty: no row matches the sender&rsquo;s gate
            (wired vertical, status new/enriching, email present) right now.
          </div>
        )}
        <div style={{ display: "grid", gap: 8 }}>
          {queue.items.map((it, i) => {
            const isOpen = open === it.id;
            return (
              <div
                key={it.id}
                onClick={() => setOpen(isOpen ? null : it.id)}
                style={{
                  border: `1px solid ${isOpen ? "var(--accent)" : it.flags.length ? "var(--red)" : "var(--border)"}`,
                  borderRadius: 12, padding: "11px 14px", background: "var(--bg-card)",
                  cursor: "pointer", display: "grid", gap: 8,
                }}
              >
                <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "baseline" }}>
                  <span style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)" }}>#{i + 1}</span>
                  <span style={{ fontSize: 13.5, fontWeight: 700, color: "var(--text-primary)" }}>
                    {it.company || "no company name recorded"}
                  </span>
                  <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                    {it.person ? `${it.person} · ` : ""}{it.email}
                  </span>
                  <span style={{ fontSize: 11.5, color: "var(--text-muted)" }}>
                    {it.city || "no city"} · {it.trade} · status {it.status}
                  </span>
                  <span style={{ marginLeft: "auto", fontSize: 11.5, color: "var(--text-muted)" }}>
                    {isOpen ? "close" : "read the messages"}
                  </span>
                </div>
                {it.flags.length > 0 && (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                    {it.flags.map((f) => (
                      <span key={f.code} title={f.detail} style={{
                        fontSize: 10.5, fontWeight: 700, color: "var(--red)",
                        border: "1px solid var(--red)", borderRadius: 6, padding: "1px 7px",
                      }}>
                        {f.label}
                      </span>
                    ))}
                  </div>
                )}
                {it.statusNote && isOpen && <Note text={it.statusNote} />}
                {isOpen && (
                  <div onClick={(e) => e.stopPropagation()} style={{ display: "grid", gap: 10 }}>
                    {it.flags.map((f) => (
                      <div key={f.code} style={{ fontSize: 12, lineHeight: 1.55, color: "var(--text-secondary)" }}>
                        <strong style={{ color: "var(--red)" }}>{f.label}</strong>: {f.detail}
                      </div>
                    ))}
                    {it.message.ported && it.message.bodies && it.message.subjects ? (
                      <>
                        <div style={{
                          display: "grid", gap: 10,
                          gridTemplateColumns: "repeat(auto-fit,minmax(260px,1fr))",
                        }}>
                          <MessageBody title="Day 1" subject={it.message.subjects[0]} body={it.message.bodies.d1} />
                          <MessageBody title="Day 3 follow-up" subject={it.message.subjects[1]} body={it.message.bodies.d3} />
                          <MessageBody title="Day 7 final" subject={it.message.subjects[2]} body={it.message.bodies.d7} />
                        </div>
                        <div style={{ fontSize: 11, lineHeight: 1.5, color: "var(--text-muted)" }}>
                          {it.message.note}
                        </div>
                      </>
                    ) : (
                      <Note text={it.message.note} />
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Guardrails ──────────────────────────────────────────────────── */}
      <div style={{
        border: "1px solid var(--border)", borderRadius: 12, padding: "12px 14px",
        background: "var(--bg-card)", display: "flex", flexWrap: "wrap", gap: 18, alignItems: "flex-start",
      }}>
        <Stat n="Blocked by copy QA" v={guardrails.qaFailed == null ? "unknown" : String(guardrails.qaFailed)} />
        <Stat n="Blocked bad address" v={guardrails.badEmail == null ? "unknown" : String(guardrails.badEmail)} />
        <Stat n="Stuck claims" v={guardrails.claimed == null ? "unknown" : String(guardrails.claimed)}
              tone={(guardrails.claimed ?? 0) > 0 ? "var(--orange)" : undefined} />
        <div style={{ flex: "1 1 280px", fontSize: 12, lineHeight: 1.55, color: "var(--text-muted)" }}>
          {guardrails.note}
          {guardrails.claimedNote ? ` ${guardrails.claimedNote}` : ""}
        </div>
      </div>

      {/* ── Already sent ────────────────────────────────────────────────── */}
      <div>
        <div style={{ fontSize: 14.5, fontWeight: 700, color: "var(--text-primary)", marginBottom: 4 }}>
          Already emailed
          {sent.total != null && (
            <span style={{ fontWeight: 500, color: "var(--text-muted)" }}> · {sent.total} all-time, newest 30 below</span>
          )}
        </div>
        {!sent.available && sent.reason && (
          <Note tone="var(--red)" text={`The sent history could not be read: ${sent.reason}.`} />
        )}
        {sent.available && sent.items.length === 0 && (
          <div style={{ fontSize: 12.5, color: "var(--text-muted)" }}>
            No prospect row carries an emailed_at stamp. The engine has not sent from this pool.
          </div>
        )}
        <div style={{ display: "grid", gap: 4 }}>
          {sent.items.map((r) => (
            <div key={r.id} style={{
              display: "flex", flexWrap: "wrap", gap: 10, alignItems: "baseline",
              fontSize: 12.5, padding: "7px 10px", borderRadius: 9,
              border: "1px solid var(--border)", background: "var(--bg-card)",
            }}>
              <span style={{ fontWeight: 600, color: "var(--text-primary)" }}>{r.company || "no company name"}</span>
              <span style={{ color: "var(--text-secondary)" }}>{r.email || "no address recorded"}</span>
              <span style={{ color: "var(--text-muted)" }}>{r.city || "no city"} · {r.trade}</span>
              <span style={{ marginLeft: "auto", color: "var(--text-muted)" }}>{when(r.emailedAt)}</span>
            </div>
          ))}
        </div>
      </div>

      {/* ── Automated texts ─────────────────────────────────────────────── */}
      <div>
        <div style={{ fontSize: 14.5, fontWeight: 700, color: "var(--text-primary)", marginBottom: 4 }}>
          Automated texts
        </div>
        <Note tone="var(--text-muted)" text={texts.note} />
      </div>
    </div>
  );
}
