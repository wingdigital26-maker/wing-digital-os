"use client";
import { useCallback, useEffect, useMemo, useState } from "react";

// ───────────────────────────────────────────────────────────────────────────
// MessagesBoard — the unified sent-message tracking surface.
//
// Every SMS and email the OS has logged, both directions, in one place:
// filterable by client and channel, grouped into per-contact threads, with
// carrier-truth status chips and an unread-inbound badge. Renders
// /api/messages (the `messages` ledger, migration 0014).
//
// Honesty rules, same as every OS board:
//  * Twilio unconfigured is SAID, with env var names, never implied by silence.
//  * A missing table says "run the migration"; an empty table says it is empty.
//  * NOTHING here sends. Reading and marking-read are the only writes.
// ───────────────────────────────────────────────────────────────────────────

type Msg = {
  id: number; contact_id: number | null; client_slug: string | null;
  channel: string; direction: string; to_addr: string | null;
  from_addr: string | null; body: string | null; status: string;
  provider_sid: string | null; error: string | null;
  created_at: string; status_updated_at: string | null; read_at: string | null;
};

type Payload = {
  available: boolean; tableMissing: boolean; reason: string | null;
  total: number | null; returned: number; truncated: boolean;
  items: Msg[]; clientSlugs: string[];
  unreadInbound: number | null; unreadNote: string | null;
  emptyNote: string | null;
  smsPipe: { configured: boolean; note: string };
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

function Chip({ text, tone, solid }: { text: string; tone: string; solid?: boolean }) {
  return (
    <span style={{
      fontSize: 10.5, fontWeight: 700, borderRadius: 6, padding: "1px 8px",
      color: solid ? "var(--bg-card)" : tone,
      background: solid ? tone : "transparent",
      border: `1px solid ${tone}`, whiteSpace: "nowrap",
    }}>
      {text}
    </span>
  );
}

/** The other party in a message, from Wing's point of view. */
function counterpart(m: Msg): string {
  return (m.direction === "inbound" ? m.from_addr : m.to_addr) ?? "unknown address";
}

type Thread = {
  key: string;
  counterpart: string;
  channel: string;
  clientSlugs: string[];
  messages: Msg[];       // oldest first
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
    threads.push({
      key,
      counterpart: counterpart(sorted[0]),
      channel: sorted[0].channel,
      clientSlugs: Array.from(new Set(sorted.map((m) => m.client_slug).filter(Boolean))) as string[],
      messages: sorted,
      last: sorted[sorted.length - 1],
      unread: sorted.filter((m) => m.direction === "inbound" && !m.read_at).length,
    });
  }
  threads.sort((a, b) => Date.parse(b.last.created_at) - Date.parse(a.last.created_at));
  return threads;
}

export default function MessagesBoard() {
  const [data, setData] = useState<Payload | null>(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(true);
  const [client, setClient] = useState("");
  const [channel, setChannel] = useState("");
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
          Every SMS and email logged in the ledger, both directions, threaded per contact.
          Nothing on this screen can send.
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

      {/* Filters */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
        <span style={label}>Channel</span>
        {["", "sms", "email"].map((c) => (
          <button
            key={c || "all"} type="button" onClick={() => setChannel(c)}
            style={{
              padding: "3px 11px", borderRadius: 999, fontSize: 11.5, fontWeight: 600, cursor: "pointer",
              border: `1px solid ${channel === c ? "var(--accent)" : "var(--border)"}`,
              color: channel === c ? "var(--accent)" : "var(--text-secondary)", background: "transparent",
            }}
          >
            {c || "all"}
          </button>
        ))}
        <span style={{ ...label, marginLeft: 12 }}>Client</span>
        <button
          type="button" onClick={() => setClient("")}
          style={{
            padding: "3px 11px", borderRadius: 999, fontSize: 11.5, fontWeight: 600, cursor: "pointer",
            border: `1px solid ${client === "" ? "var(--accent)" : "var(--border)"}`,
            color: client === "" ? "var(--accent)" : "var(--text-secondary)", background: "transparent",
          }}
        >
          all
        </button>
        {data.clientSlugs.map((s) => (
          <button
            key={s} type="button" onClick={() => setClient(s)}
            style={{
              padding: "3px 11px", borderRadius: 999, fontSize: 11.5, fontWeight: 600, cursor: "pointer",
              border: `1px solid ${client === s ? "var(--accent)" : "var(--border)"}`,
              color: client === s ? "var(--accent)" : "var(--text-secondary)", background: "transparent",
            }}
          >
            {s}
          </button>
        ))}
        {data.clientSlugs.length === 0 && (
          <span style={{ fontSize: 11.5, color: "var(--text-muted)" }}>
            no client slug on any row yet
          </span>
        )}
      </div>

      {data.truncated && data.total != null && (
        <Note text={`Showing the newest ${data.returned} of ${data.total} messages matching these filters; older rows exist beyond this page.`} />
      )}
      {data.emptyNote && (
        <div style={{ fontSize: 12.5, color: "var(--text-muted)", lineHeight: 1.55 }}>{data.emptyNote}</div>
      )}

      {/* Threads */}
      <div style={{ display: "grid", gap: 8 }}>
        {threads.map((t) => {
          const isOpen = open === t.key;
          return (
            <div
              key={t.key}
              style={{
                border: `1px solid ${isOpen ? "var(--accent)" : t.unread ? "var(--accent)" : "var(--border)"}`,
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
                <span style={{ fontSize: 13.5, fontWeight: 700, color: "var(--text-primary)", wordBreak: "break-all" }}>
                  {t.counterpart}
                </span>
                {t.clientSlugs.map((s) => (
                  <span key={s} style={{ fontSize: 11, color: "var(--text-muted)" }}>for {s}</span>
                ))}
                {t.unread > 0 && <Chip solid tone="var(--accent)" text={`${t.unread} unread`} />}
                <span style={{ marginLeft: "auto", fontSize: 11.5, color: "var(--text-muted)" }}>
                  {t.messages.length} msg{t.messages.length === 1 ? "" : "s"} · {when(t.last.created_at)}
                </span>
              </div>

              {/* Collapsed: last message preview. Open: the whole thread. */}
              {!isOpen && (
                <div style={{ display: "flex", gap: 8, alignItems: "baseline", minWidth: 0 }}>
                  <Chip tone={statusTone(t.last.status, t.last.error)} text={t.last.status} />
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
                  {t.messages.map((m) => (
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
                        <Chip tone={statusTone(m.status, m.error)} text={m.status} />
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
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
