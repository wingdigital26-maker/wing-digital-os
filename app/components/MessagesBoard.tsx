"use client";
import { useCallback, useEffect, useMemo, useState } from "react";

// ───────────────────────────────────────────────────────────────────────────
// MessagesBoard — the unified sent-message tracking surface.
//
// Three views:
//  * Conversations — per-contact threads, newest activity first, unread on
//    top, with a manual reply box (SMS threads only, human action only).
//  * Twilio status — what is actually going on with the SMS pipe, from
//    /api/sms/health: env vars present (names only), live account + webhook
//    checks when configured, exact remaining setup steps when not.
//
// Contact names come from crm_contacts (resolved server-side); a bare phone
// number only shows when no name is known. Honesty rules, same as every OS
// board: unconfigured is SAID, a missing table says "run the migration", an
// empty table says it is empty, and NOTHING sends without a human pressing
// the send button in a thread.
// ───────────────────────────────────────────────────────────────────────────

type Msg = {
  id: number; contact_id: number | null; client_slug: string | null;
  channel: string; direction: string; to_addr: string | null;
  from_addr: string | null; body: string | null; status: string;
  provider_sid: string | null; error: string | null;
  created_at: string; status_updated_at: string | null; read_at: string | null;
  contact_name: string | null; contact_company: string | null;
  resolved_contact_id: number | null;
};

type Payload = {
  available: boolean; tableMissing: boolean; reason: string | null;
  total: number | null; returned: number; truncated: boolean;
  items: Msg[]; clientSlugs: string[];
  clientCounts: Record<string, number>; clientCountsExact: boolean;
  contactNote: string | null;
  unreadInbound: number | null; unreadNote: string | null;
  emptyNote: string | null;
  smsPipe: { configured: boolean; note: string };
};

type HealthCheck = { ok: boolean; detail: string };
type Health = {
  configured: boolean;
  env: Record<string, boolean>;
  fromNumber: string | null;
  account: HealthCheck | null;
  webhook: HealthCheck | null;
  note: string;
};

function when(iso: string | null): string {
  if (!iso) return "no date";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const mins = Math.round((Date.now() - t) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return days < 60 ? `${days}d ago` : new Date(t).toLocaleDateString();
}

// Status chip tones. Anything unrecognized renders neutrally with its own
// word — Twilio invents statuses, and an unknown word must not look healthy.
function statusTone(status: string, error: string | null): string {
  if (error || status === "failed" || status === "undelivered") return "var(--red)";
  if (status === "delivered") return "var(--green)";
  if (status === "received") return "var(--accent)";
  if (status === "sent") return "var(--text-secondary)";
  if (status === "queued") return "var(--orange)";
  return "var(--text-muted)";
}

/** Delivery status in plain English. Twilio invents words; an unrecognized one
 *  renders as itself (never dressed up as healthy), raw word on hover always. */
function statusPlainWord(status: string, error: string | null): string {
  if (error) return "failed";
  switch (status) {
    case "delivered": return "delivered";
    case "failed": return "failed";
    case "undelivered": return "not delivered";
    case "queued": return "waiting to send";
    case "sent": return "sent, delivery unconfirmed";
    case "received": return "received";
    default: return status;
  }
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

function Chip({ text, tone, solid, title }: { text: string; tone: string; solid?: boolean; title?: string }) {
  return (
    <span title={title} style={{
      fontSize: 10.5, fontWeight: 700, borderRadius: 6, padding: "1px 8px",
      color: solid ? "var(--bg-card)" : tone,
      background: solid ? tone : "transparent",
      border: `1px solid ${tone}`, whiteSpace: "nowrap",
    }}>
      {text}
    </span>
  );
}

function pill(active: boolean): React.CSSProperties {
  return {
    padding: "3px 11px", borderRadius: 999, fontSize: 11.5, fontWeight: 600, cursor: "pointer",
    border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
    color: active ? "var(--accent)" : "var(--text-secondary)", background: "transparent",
  };
}

/** The other party in a message, from Wing's point of view. */
function counterpart(m: Msg): string {
  return (m.direction === "inbound" ? m.from_addr : m.to_addr) ?? "unknown address";
}

/** Best display name for a message's counterpart: person, company, or the raw address. */
function displayName(m: Msg): string {
  return m.contact_name || m.contact_company || counterpart(m);
}

type Thread = {
  key: string;
  counterpart: string;
  name: string | null;        // resolved person/company name, if any message knew one
  company: string | null;
  contactId: number | null;
  channel: string;
  clientSlugs: string[];
  messages: Msg[];            // oldest first
  last: Msg;
  unread: number;
};

function buildThreads(items: Msg[]): Thread[] {
  const map = new Map<string, Msg[]>();
  for (const m of items) {
    const key = `${m.channel}|${counterpart(m)}`;
    (map.get(key) ?? map.set(key, []).get(key)!).push(m);
  }
  const threads: Thread[] = [];
  for (const [key, msgs] of map) {
    const sorted = [...msgs].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
    const named = sorted.find((m) => m.contact_name || m.contact_company);
    threads.push({
      key,
      counterpart: counterpart(sorted[0]),
      name: named?.contact_name ?? null,
      company: named?.contact_company ?? null,
      contactId: named?.resolved_contact_id ?? sorted.find((m) => m.resolved_contact_id != null)?.resolved_contact_id ?? null,
      channel: sorted[0].channel,
      clientSlugs: Array.from(new Set(sorted.map((m) => m.client_slug).filter(Boolean))) as string[],
      messages: sorted,
      last: sorted[sorted.length - 1],
      unread: sorted.filter((m) => m.direction === "inbound" && !m.read_at).length,
    });
  }
  // Unread threads first, then newest activity first within each group.
  threads.sort((a, b) =>
    (b.unread > 0 ? 1 : 0) - (a.unread > 0 ? 1 : 0) ||
    Date.parse(b.last.created_at) - Date.parse(a.last.created_at)
  );
  return threads;
}

function matches(q: string, ...fields: (string | null | undefined)[]): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  return fields.some((f) => f && f.toLowerCase().includes(needle));
}

// ── Reply box (SMS threads; a deliberate human send, nothing automatic) ─────
function ReplyBox({ thread, configured, pipeNote, onSent }: {
  thread: Thread; configured: boolean; pipeNote: string; onSent: () => void;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);

  if (thread.channel !== "sms") {
    return (
      <div style={{ fontSize: 11.5, color: "var(--text-muted)", lineHeight: 1.5 }}>
        Email threads are read-only here — email goes out through the senders, not this board.
      </div>
    );
  }
  if (!configured) {
    return (
      <div style={{ fontSize: 11.5, color: "var(--orange)", lineHeight: 1.5 }}>
        Replying is disabled: {pipeNote} See the Twilio status view for the exact setup steps.
      </div>
    );
  }

  const send = async () => {
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true); setResult(null);
    try {
      const res = await fetch("/api/sms/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          to: thread.counterpart,
          body,
          client_slug: thread.clientSlugs[0] ?? undefined,
          contact_id: thread.contactId ?? undefined,
        }),
      });
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; status?: string };
      if (!res.ok || !j.ok) {
        setResult({ ok: false, msg: j.error || `Send failed (HTTP ${res.status}).` });
      } else {
        setResult({ ok: true, msg: `Sent — Twilio accepted it as "${j.status ?? "queued"}". Delivery status updates on this thread.` });
        setText("");
        onSent();
      }
    } catch (e) {
      setResult({ ok: false, msg: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: "grid", gap: 6 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={`Text ${thread.name || thread.counterpart}… (sends only when you press Send)`}
          rows={2}
          style={{
            flex: "1 1 220px", minWidth: 0, resize: "vertical", borderRadius: 10,
            border: "1px solid var(--border)", background: "transparent",
            color: "var(--text-primary)", fontSize: 12.5, lineHeight: 1.5,
            padding: "8px 10px", fontFamily: "inherit",
          }}
        />
        <button
          type="button" onClick={() => { void send(); }} disabled={busy || !text.trim()}
          style={{
            padding: "7px 16px", borderRadius: 999, fontSize: 12.5, fontWeight: 700,
            cursor: busy || !text.trim() ? "default" : "pointer",
            border: "1px solid var(--accent)",
            color: busy || !text.trim() ? "var(--text-muted)" : "var(--accent)",
            background: "transparent", opacity: busy || !text.trim() ? 0.6 : 1,
          }}
        >
          {busy ? "Sending…" : "Send"}
        </button>
      </div>
      {result && (
        <div style={{ fontSize: 11.5, color: result.ok ? "var(--green)" : "var(--red)", lineHeight: 1.5 }}>
          {result.msg}
        </div>
      )}
    </div>
  );
}

// ── Twilio status panel ─────────────────────────────────────────────────────
const SETUP_STEPS = [
  "Create a Twilio account (twilio.com) — free to start.",
  "Register A2P 10DLC (a brand + campaign under Messaging > Regulatory compliance). Carriers require this for business texting to US numbers; approval can take days and texts sent before it are filtered.",
  "Buy an SMS-capable phone number in the Twilio console.",
  "Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_FROM_NUMBER on Vercel (Project > Settings > Environment Variables), then redeploy.",
  "Point the number's inbound SMS webhook (HTTP POST) at this app's /api/sms/inbound so replies and STOPs land in the ledger.",
];

function TwilioPanel() {
  const [h, setH] = useState<Health | null>(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true); setErr("");
    try {
      const res = await fetch("/api/sms/health");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setH((await res.json()) as Health);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  if (loading && !h) return <div style={{ fontSize: 13, color: "var(--text-muted)" }}>Checking the Twilio pipe…</div>;
  if (err && !h) return <Note tone="var(--red)" text={`The Twilio status check itself failed: ${err}. That means the answer is unknown, not that Twilio is fine.`} />;
  if (!h) return null;

  const row = (ok: boolean | null, title: string, detail: string) => (
    <div key={title} style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
      <Chip
        tone={ok == null ? "var(--text-muted)" : ok ? "var(--green)" : "var(--red)"}
        text={ok == null ? "N/A" : ok ? "OK" : "PROBLEM"}
      />
      <div style={{ flex: "1 1 240px", minWidth: 0 }}>
        <div style={{ fontSize: 12.5, fontWeight: 700, color: "var(--text-primary)" }}>{title}</div>
        <div style={{ fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.55 }}>{detail}</div>
      </div>
    </div>
  );

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
        <Chip solid tone={h.configured ? "var(--green)" : "var(--orange)"} text={h.configured ? "CONFIGURED" : "NOT CONFIGURED"} />
        <span style={{ fontSize: 12.5, color: "var(--text-secondary)", lineHeight: 1.55 }}>{h.note}</span>
        <button type="button" onClick={() => { void load(); }} style={pill(false)}>
          {loading ? "Checking…" : "Re-check"}
        </button>
      </div>

      <div style={{
        border: "1px solid var(--border)", borderRadius: 12, background: "var(--bg-card)",
        padding: "12px 14px", display: "grid", gap: 10,
      }}>
        <span style={label}>Environment variables (names only — values never leave the server)</span>
        {Object.entries(h.env).map(([name, set]) =>
          row(set, name, set
            ? (name === "TWILIO_FROM_NUMBER" && h.fromNumber ? `Set — sending from ${h.fromNumber}.` : "Set on this deployment.")
            : "Not set on this deployment.")
        )}
      </div>

      {h.configured ? (
        <div style={{
          border: "1px solid var(--border)", borderRadius: 12, background: "var(--bg-card)",
          padding: "12px 14px", display: "grid", gap: 10,
        }}>
          <span style={label}>Live Twilio checks</span>
          {h.account && row(h.account.ok, "Account", h.account.detail)}
          {h.webhook && row(h.webhook.ok, "Inbound webhook", h.webhook.detail)}
        </div>
      ) : (
        <div style={{
          border: "1px solid var(--border)", borderRadius: 12, background: "var(--bg-card)",
          padding: "12px 14px", display: "grid", gap: 8,
        }}>
          <span style={label}>What is left to get the SMS pipe live</span>
          {SETUP_STEPS.map((s, i) => (
            <div key={i} style={{ display: "flex", gap: 8, fontSize: 12.5, lineHeight: 1.55, color: "var(--text-secondary)" }}>
              <span style={{ fontWeight: 700, color: "var(--accent)" }}>{i + 1}.</span>
              <span>{s}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── The board ───────────────────────────────────────────────────────────────
export default function MessagesBoard() {
  const [data, setData] = useState<Payload | null>(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(true);
  const [client, setClient] = useState("");
  const [channel, setChannel] = useState("");
  const [view, setView] = useState<"threads" | "twilio">("threads");
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setErr("");
    try {
      const qs = new URLSearchParams();
      if (client) qs.set("client", client);
      if (channel) qs.set("channel", channel);
      const res = await fetch(`/api/messages${qs.size ? `?${qs}` : ""}`);
      const j = (await res.json()) as Payload;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData(j);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [client, channel]);

  useEffect(() => { void load(); }, [load]);

  const threads = useMemo(() => (data ? buildThreads(data.items) : []), [data]);
  const visibleThreads = useMemo(
    () => threads.filter((t) => matches(search, t.name, t.company, t.counterpart, ...t.messages.map((m) => m.body))),
    [threads, search]
  );

  const markRead = useCallback(async (t: Thread) => {
    const ids = t.messages.filter((m) => m.direction === "inbound" && !m.read_at).map((m) => m.id);
    if (!ids.length) return;
    try {
      await fetch("/api/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "read", ids }),
      });
      // Reflect locally without a refetch.
      setData((d) => d && {
        ...d,
        unreadInbound: d.unreadInbound == null ? null : Math.max(0, d.unreadInbound - ids.length),
        items: d.items.map((m) => (ids.includes(m.id) ? { ...m, read_at: new Date().toISOString() } : m)),
      });
    } catch { /* the badge simply stays until the next successful load */ }
  }, []);

  if (loading && !data) {
    return <div style={{ fontSize: 13, color: "var(--text-muted)" }}>Reading the message ledger…</div>;
  }
  if (err && !data) {
    return <Note tone="var(--red)" text={`The message ledger could not be read: ${err}. Nothing below is available — this is a failure, not an empty board.`} />;
  }
  if (!data) return null;

  const bubble = (m: Msg) => (
    <div key={m.id} style={{
      justifySelf: m.direction === "inbound" ? "start" : "end",
      maxWidth: "min(560px, 92%)",
      border: `1px solid ${m.error ? "var(--red)" : "var(--border)"}`,
      borderRadius: 10, padding: "8px 11px",
      background: m.direction === "inbound" ? "var(--bg-card)" : "transparent",
    }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "baseline", marginBottom: 4 }}>
        <span style={{ fontSize: 10.5, fontWeight: 700, color: "var(--text-muted)" }}>
          {m.direction === "inbound" ? "received" : "sent by Wing"}
        </span>
        <Chip tone={statusTone(m.status, m.error)} text={statusPlainWord(m.status, m.error)} title={`provider status: ${m.status}`} />
        {m.client_slug && <span style={{ fontSize: 10.5, color: "var(--text-muted)" }}>for {m.client_slug}</span>}
        <span style={{ fontSize: 10.5, color: "var(--text-muted)" }}>{when(m.created_at)}</span>
        {m.status_updated_at && (
          <span style={{ fontSize: 10.5, color: "var(--text-muted)" }}>
            status {when(m.status_updated_at)}
          </span>
        )}
      </div>
      <pre style={{
        margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word",
        fontFamily: "inherit", fontSize: 12.5, lineHeight: 1.55, color: "var(--text-secondary)",
      }}>
        {m.body || "(no body recorded)"}
      </pre>
      {m.error && (
        <div style={{ fontSize: 11.5, color: "var(--red)", marginTop: 4 }}>{m.error}</div>
      )}
    </div>
  );

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "baseline" }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: "var(--text-primary)" }}>
          Messages
        </h2>
        {data.unreadInbound != null && data.unreadInbound > 0 && (
          <Chip solid tone="var(--accent)" text={`${data.unreadInbound} unread`} />
        )}
        <span style={{ fontSize: 12.5, color: "var(--text-muted)" }}>
          Every SMS and email logged in the ledger, both directions. Sending is a human action — nothing here fires on its own.
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

      {/* Pipe state + data-source honesty */}
      <Note tone={data.smsPipe.configured ? "var(--green)" : "var(--orange)"} text={data.smsPipe.note} />
      {!data.available && data.reason && (
        <Note tone={data.tableMissing ? "var(--orange)" : "var(--red)"} text={data.reason} />
      )}
      {data.unreadNote && <Note text={data.unreadNote} />}
      {data.contactNote && <Note text={data.contactNote} />}

      {/* View switcher */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
        {([
          ["threads", "Conversations"],
          ["twilio", "Twilio status"],
        ] as const).map(([v, name]) => (
          <button key={v} type="button" onClick={() => setView(v)} style={pill(view === v)}>{name}</button>
        ))}
      </div>

      {view === "twilio" ? (
        <TwilioPanel />
      ) : (
        <>
          {/* Search + filters */}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search name, number, or message text…"
              style={{
                flex: "1 1 220px", minWidth: 0, borderRadius: 999,
                border: "1px solid var(--border)", background: "transparent",
                color: "var(--text-primary)", fontSize: 12.5, padding: "6px 14px",
              }}
            />
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
            <span style={label}>Channel</span>
            {["", "sms", "email"].map((c) => (
              <button key={c || "all"} type="button" onClick={() => setChannel(c)} style={pill(channel === c)}>
                {c || "all"}
              </button>
            ))}
            <span style={{ ...label, marginLeft: 12 }}>Client</span>
            <button type="button" onClick={() => setClient("")} style={pill(client === "")}>all</button>
            {data.clientSlugs.map((s) => (
              <button key={s} type="button" onClick={() => setClient(s)} style={pill(client === s)}>
                {s}{data.clientCountsExact && data.clientCounts[s] != null ? ` · ${data.clientCounts[s]}` : ""}
              </button>
            ))}
            {data.clientSlugs.length === 0 && (
              <span style={{ fontSize: 11.5, color: "var(--text-muted)" }}>
                no client slug on any row yet
              </span>
            )}
            {!data.clientCountsExact && data.clientSlugs.length > 0 && (
              <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                (counts hidden — the ledger outgrew the counting page, so a number here could be wrong)
              </span>
            )}
          </div>

          {data.truncated && data.total != null && (
            <Note text={`Showing the newest ${data.returned} of ${data.total} messages matching these filters; older rows exist beyond this page.`} />
          )}
          {data.emptyNote && (
            <div style={{ fontSize: 12.5, color: "var(--text-muted)", lineHeight: 1.55 }}>
              {data.emptyNote}
              {!data.smsPipe.configured &&
                " Once Twilio is configured (see the Twilio status view), outbound texts you send and every reply will appear here automatically; email rows arrive when the senders log to /api/messages/log."}
            </div>
          )}
          {!data.emptyNote && search.trim() &&
            visibleThreads.length === 0 && (
            <div style={{ fontSize: 12.5, color: "var(--text-muted)" }}>
              Nothing matches “{search.trim()}”. The rows are still in the ledger — clear the search to see them.
            </div>
          )}

          {view === "threads" && (
            <div style={{ display: "grid", gap: 8 }}>
              {visibleThreads.map((t) => {
                const isOpen = open === t.key;
                const title = t.name || t.company || t.counterpart;
                const subtitleParts = [
                  t.name && t.company ? t.company : null,
                  (t.name || t.company) ? t.counterpart : null,
                ].filter(Boolean);
                return (
                  <div
                    key={t.key}
                    style={{
                      border: `1px solid ${isOpen || t.unread ? "var(--accent)" : "var(--border)"}`,
                      borderRadius: 12, background: "var(--bg-card)", padding: "11px 14px",
                      display: "grid", gap: 8, cursor: "pointer",
                    }}
                    onClick={() => {
                      setOpen(isOpen ? null : t.key);
                      if (!isOpen) void markRead(t);
                    }}
                  >
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "baseline" }}>
                      <Chip tone={t.channel === "sms" ? "var(--accent)" : "var(--text-secondary)"} text={t.channel.toUpperCase()} />
                      <span style={{ fontSize: 13.5, fontWeight: 700, color: "var(--text-primary)", wordBreak: "break-word" }}>
                        {title}
                      </span>
                      {subtitleParts.length > 0 && (
                        <span style={{ fontSize: 11.5, color: "var(--text-muted)", wordBreak: "break-all" }}>
                          {subtitleParts.join(" · ")}
                        </span>
                      )}
                      {t.clientSlugs.map((s) => (
                        <span key={s} style={{ fontSize: 11, color: "var(--text-muted)" }}>for {s}</span>
                      ))}
                      {t.unread > 0 && <Chip solid tone="var(--accent)" text={`${t.unread} unread`} />}
                      <span style={{ marginLeft: "auto", fontSize: 11.5, color: "var(--text-muted)" }}>
                        {t.messages.length} msg{t.messages.length === 1 ? "" : "s"} · {when(t.last.created_at)}
                      </span>
                    </div>

                    {/* Collapsed: last message preview. Open: the whole thread + reply box. */}
                    {!isOpen && (
                      <div style={{ display: "flex", gap: 8, alignItems: "baseline", minWidth: 0 }}>
                        <Chip tone={statusTone(t.last.status, t.last.error)} text={statusPlainWord(t.last.status, t.last.error)} title={`provider status: ${t.last.status}`} />
                        <span style={{
                          fontSize: 12.5, color: "var(--text-secondary)", overflow: "hidden",
                          textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0,
                        }}>
                          {t.last.direction === "inbound" ? "← " : "→ "}
                          {t.last.body || "(no body recorded)"}
                        </span>
                      </div>
                    )}
                    {isOpen && (
                      <div onClick={(e) => e.stopPropagation()} style={{ display: "grid", gap: 6 }}>
                        {t.messages.map(bubble)}
                        <div style={{ borderTop: "1px solid var(--border)", paddingTop: 8, marginTop: 2 }}>
                          <ReplyBox
                            thread={t}
                            configured={data.smsPipe.configured}
                            pipeNote={data.smsPipe.note}
                            onSent={() => { void load(); }}
                          />
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

        </>
      )}
    </div>
  );
}
