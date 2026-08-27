"use client";
import { useEffect, useMemo, useState } from "react";
import { sfx } from "../lib/sounds";

// ClientInbox, a WORKING QUEUE, not a browsing board. One rail entry per
// client, oldest unhandled draft first. Open a client, see what needs a
// human, deal with it, move to the next. Reads /api/inbox. Nothing here
// ever sends; approve/skip only move a row's status, and a failed write
// stays on screen with the real error, exactly like CrmBoard.

type InboxItem = {
  id: number;
  client: string | null;
  channel: string | null;
  direction: string | null;
  recipient: string | null;
  recipientHandle: string | null;
  recipientUrl: string | null;
  subject: string | null;
  body: string | null;
  personalization: string | null;
  evidenceUrl: string | null;
  status: string | null;
  tier: string | null;
  createdAt: string | null;
  reviewedAt: string | null;
  sentAt: string | null;
  reason: string;
};

type ClientEntry = {
  client: string;
  waiting: number;
  counts: { draft: number; approved: number; skipped: number; sent: number; other: number };
  sendPolicy: { available: boolean; mayySend: boolean | null; scopeNote: string | null };
  lastScrapedAt: string | null;
  lastScrapedTracked: boolean;
  queue: InboxItem[];
  replies: { available: boolean; reason: string; items: never[] };
};

type Payload = {
  configured: boolean;
  clients: ClientEntry[];
  scan?: { complete: boolean; total: number | null; note: string | null };
  error: string | null;
};

const NONE = "not recorded";

function ago(iso: string | null): string {
  if (!iso) return NONE;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return NONE;
  const mins = Math.max(0, Math.round((Date.now() - t) / 60000));
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

export default function ClientInbox() {
  const [data, setData] = useState<Payload | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState<Record<number, boolean>>({});
  const [rowErr, setRowErr] = useState<Record<number, string>>({});

  async function load() {
    setLoading(true);
    setLoadErr(null);
    try {
      const r = await fetch("/api/inbox", { cache: "no-store" });
      const j = (await r.json()) as Payload;
      if (!r.ok || j?.error) {
        // A failed read must render as a failed read, never as an empty queue.
        setLoadErr(j?.error || `Inbox failed to load (HTTP ${r.status}).`);
        setData(j?.configured ? j : null);
      } else {
        setData(j);
        setSelected((cur) => cur ?? j.clients[0]?.client ?? null);
      }
    } catch (e) {
      setLoadErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  const current = useMemo(
    () => data?.clients.find((c) => c.client === selected) ?? null,
    [data, selected]
  );

  async function act(it: InboxItem, action: "approve" | "skip") {
    setRowErr((m) => ({ ...m, [it.id]: "" }));
    setBusy((m) => ({ ...m, [it.id]: true }));
    try {
      const r = await fetch("/api/inbox", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: it.id, action }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j?.ok === false) {
        // Failed write must never look like success. Row stays, real error shown.
        setRowErr((m) => ({ ...m, [it.id]: String(j?.error || `${action} failed (HTTP ${r.status})`) }));
        return;
      }
      sfx.play("blip");
      // Advance to the next item: drop this one from the local queue so the
      // next-oldest is now on top, without a full reload.
      setData((d) => {
        if (!d) return d;
        return {
          ...d,
          clients: d.clients.map((c) =>
            c.client !== it.client
              ? c
              : {
                  ...c,
                  waiting: c.waiting - 1,
                  queue: c.queue.filter((q) => q.id !== it.id),
                  counts: {
                    ...c.counts,
                    draft: c.counts.draft - 1,
                    approved: action === "approve" ? c.counts.approved + 1 : c.counts.approved,
                    skipped: action === "skip" ? c.counts.skipped + 1 : c.counts.skipped,
                  },
                }
          ),
        };
      });
    } catch (e) {
      setRowErr((m) => ({ ...m, [it.id]: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy((m) => ({ ...m, [it.id]: false }));
    }
  }

  if (loading && !data) {
    return <div style={{ padding: 24, color: "var(--text-muted)" }}>Loading inboxes...</div>;
  }

  if (loadErr) {
    return (
      <div style={{ padding: 24 }}>
        <div style={{
          border: "1px solid var(--red)", borderRadius: 8, padding: 16,
          color: "var(--red)", background: "transparent",
        }}>
          <strong>Could not load the inbox.</strong>
          <div style={{ marginTop: 8, color: "var(--text-primary)" }}>{loadErr}</div>
          <button onClick={load} style={btnStyle()}>Retry</button>
        </div>
      </div>
    );
  }

  if (!data?.configured) {
    return (
      <div style={{ padding: 24, color: "var(--text-muted)" }}>
        Inbox is not configured. SONAR_SUPABASE_URL / SONAR_SUPABASE_SERVICE_KEY are missing.
      </div>
    );
  }

  const clients = data.clients;

  return (
    <div style={{ display: "flex", gap: 0, height: "100%", minHeight: 480 }}>
      {/* Left rail */}
      <div style={{
        width: 260, flexShrink: 0, borderRight: "1px solid var(--text-muted)",
        overflowY: "auto", paddingRight: 8,
      }}>
        {clients.length === 0 && (
          <div style={{ padding: 16, color: "var(--text-muted)" }}>
            No clients found in crm_clients or outbound.
          </div>
        )}
        {clients.map((c) => {
          const isActive = c.client === selected;
          return (
            <button
              key={c.client}
              onClick={() => setSelected(c.client)}
              style={{
                display: "block", width: "100%", textAlign: "left",
                padding: "12px 14px", marginBottom: 4, borderRadius: 8,
                border: "1px solid transparent",
                borderColor: isActive ? "var(--accent)" : "transparent",
                background: "transparent",
                cursor: "pointer",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ color: "var(--text-primary)", fontWeight: isActive ? 700 : 500 }}>
                  {c.client}
                </span>
                {c.waiting > 0 ? (
                  <span style={{
                    background: "var(--accent)", color: "var(--text-primary)",
                    borderRadius: 999, padding: "1px 8px", fontSize: 12, fontWeight: 700,
                  }}>
                    {c.waiting}
                  </span>
                ) : (
                  <span style={{ color: "var(--green)", fontSize: 12 }}>clear</span>
                )}
              </div>
              <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2 }}>
                {c.sendPolicy.mayySend === false
                  ? "cannot send"
                  : c.sendPolicy.mayySend === true
                  ? "can send"
                  : "send status unknown"}
                {" · scraper "}{ago(c.lastScrapedTracked ? c.lastScrapedAt : null)}
              </div>
            </button>
          );
        })}
      </div>

      {/* Main pane */}
      <div style={{ flex: 1, overflowY: "auto", padding: "0 16px" }}>
        {!current ? (
          <div style={{ padding: 24, color: "var(--text-muted)" }}>Select a client.</div>
        ) : (
          <ClientPane
            client={current}
            act={act}
            busy={busy}
            rowErr={rowErr}
          />
        )}
      </div>
    </div>
  );
}

function ClientPane({
  client, act, busy, rowErr,
}: {
  client: ClientEntry;
  act: (it: InboxItem, action: "approve" | "skip") => void;
  busy: Record<number, boolean>;
  rowErr: Record<number, string>;
}) {
  const pol = client.sendPolicy;
  const cannotSend = pol.mayySend === false;
  const unknownSend = pol.mayySend === null;

  return (
    <div style={{ paddingTop: 16, paddingBottom: 32 }}>
      <h2 style={{ margin: 0, color: "var(--text-primary)" }}>{client.client}</h2>

      {/* Send permission banner, always visible at the top */}
      <div style={{
        marginTop: 10, marginBottom: 16, padding: "10px 14px", borderRadius: 8,
        border: `1px solid ${cannotSend ? "var(--red)" : unknownSend ? "var(--text-muted)" : "var(--green)"}`,
      }}>
        {cannotSend ? (
          <span style={{ color: "var(--red)" }}>
            <strong>Cannot send for this client.</strong>{" "}
            <span style={{ color: "var(--text-primary)" }}>
              {pol.scopeNote ?? "No scope note on file."}
            </span>{" "}
            <span style={{ color: "var(--text-muted)" }}>
              Approving is still useful, it records the decision, it just cannot leave Wing.
            </span>
          </span>
        ) : unknownSend ? (
          <span style={{ color: "var(--text-muted)" }}>
            Send permission is unknown, the send-policy table could not be read.
          </span>
        ) : (
          <span style={{ color: "var(--green)" }}>
            Can send for this client.{" "}
            <span style={{ color: "var(--text-muted)" }}>{pol.scopeNote ?? ""}</span>
          </span>
        )}
      </div>

      <div style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 20 }}>
        Scraper last ran: {ago(client.lastScrapedTracked ? client.lastScrapedAt : null)}
        {" · "}{client.counts.draft} waiting, {client.counts.approved} approved, {client.counts.sent} sent, {client.counts.skipped} skipped
      </div>

      {/* Reply seam: no fake section, just an honest one-liner */}
      <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 16 }}>
        Replies: {client.replies.reason}
      </div>

      {client.queue.length === 0 ? (
        <div style={{
          padding: 20, borderRadius: 8, border: "1px solid var(--green)",
          color: "var(--green)",
        }}>
          Nothing waiting for {client.client}. Every drafted message has been reviewed.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {client.queue.map((it) => (
            <QueueRow
              key={it.id}
              it={it}
              cannotSend={cannotSend}
              busy={!!busy[it.id]}
              error={rowErr[it.id]}
              onApprove={() => act(it, "approve")}
              onSkip={() => act(it, "skip")}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function QueueRow({
  it, cannotSend, busy, error, onApprove, onSkip,
}: {
  it: InboxItem;
  cannotSend: boolean;
  busy: boolean;
  error?: string;
  onApprove: () => void;
  onSkip: () => void;
}) {
  const who = it.recipient ?? it.recipientHandle ?? NONE;
  return (
    <div style={{
      border: `1px solid ${error ? "var(--red)" : "var(--text-muted)"}`,
      borderRadius: 8, padding: 14,
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ color: "var(--text-primary)", fontWeight: 600 }}>
            {who}
            <span style={{ color: "var(--text-muted)", fontWeight: 400, marginLeft: 8, fontSize: 12 }}>
              {it.channel ?? NONE} · {ago(it.createdAt)}
            </span>
          </div>
          {it.subject && (
            <div style={{ color: "var(--text-primary)", marginTop: 6, fontWeight: 500 }}>{it.subject}</div>
          )}
          <div style={{
            color: "var(--text-primary)", marginTop: 6, whiteSpace: "pre-wrap",
            maxHeight: 140, overflowY: "auto",
          }}>
            {it.body ?? "MISSING, this row has no message body at all."}
          </div>
          <div style={{ marginTop: 8, fontSize: 13, color: "var(--accent)" }}>
            {it.reason}
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6, flexShrink: 0 }}>
          <button
            disabled={busy}
            onClick={onApprove}
            style={btnStyle(cannotSend ? "var(--text-muted)" : "var(--green)")}
            title={cannotSend ? "Approving records the decision, it will not send." : "Approve"}
          >
            {cannotSend ? "Approve (no send)" : "Approve"}
          </button>
          <button disabled={busy} onClick={onSkip} style={btnStyle("var(--red)")}>
            Skip
          </button>
        </div>
      </div>
      {error && (
        <div style={{ marginTop: 8, color: "var(--red)", fontSize: 13 }}>
          {error}
        </div>
      )}
    </div>
  );
}

function btnStyle(color: string = "var(--accent)") {
  return {
    border: `1px solid ${color}`, color, background: "transparent",
    borderRadius: 6, padding: "6px 12px", cursor: "pointer", fontSize: 13,
  } as const;
}
