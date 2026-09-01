"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// ───────────────────────────────────────────────────────────────────────────
// ReplyInboxBoard — every inbound reply from cold outreach, hot first.
//
// Left: replies grouped Hot / Warm / Cold / Other with counts; rows that
// still need a human are highlighted. Right: the selected reply — the inbound
// message, the full prior thread with that address (from the messages
// ledger), the AI draft in an editable box, and three buttons: Save draft,
// Mark handled, Dismiss.
//
// NOTHING HERE SENDS. Marking a reply handled only records that Jack dealt
// with it; sending happens outside the OS (docs/SENDING-CONTRACT.md).
// Honesty rules like every OS board: a missing table says "run the
// migration", an empty table says exactly what would fill it.
// ───────────────────────────────────────────────────────────────────────────

type Msg = {
  id: number; channel: string; direction: string;
  to_addr: string | null; from_addr: string | null;
  body: string | null; status: string; error?: string | null;
  created_at: string; read_at?: string | null;
};

type Reply = {
  id: number;
  message_id: number;
  contact_id: number | null;
  client_slug: string | null;
  channel: string | null;
  classification: "hot" | "warm" | "cold" | "other";
  classified_by: string;
  confidence: string | null;
  draft: string | null;
  draft_model: string | null;
  status: "none" | "draft" | "sent" | "dismissed";
  triaged_at: string;
  handled_at: string | null;
  notes: string | null;
  messages: Msg | null;
  crm_contacts: { business_name: string | null; contact_name: string | null; email: string | null } | null;
};

type Payload = {
  available: boolean;
  tableMissing: boolean;
  reason: string | null;
  items: Reply[];
  clientSlugs: string[];
};

const GROUPS = [
  { key: "hot", name: "Hot", tone: "var(--red)" },
  { key: "warm", name: "Warm", tone: "var(--orange)" },
  { key: "cold", name: "Cold", tone: "var(--text-secondary)" },
  { key: "other", name: "Other", tone: "var(--text-muted)" },
] as const;

type FilterKey = "all" | "attention" | "handled";

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

/** The prospect's address on the inbound message. */
function replyAddress(r: Reply): string | null {
  return r.messages?.from_addr ?? null;
}

function displayName(r: Reply): string {
  return (
    r.crm_contacts?.contact_name ||
    r.crm_contacts?.business_name ||
    replyAddress(r) ||
    `reply #${r.id}`
  );
}

/** Still waiting on a human? (not handled, not dismissed) */
function needsAttention(r: Reply): boolean {
  return r.status === "none" || r.status === "draft";
}

function groupTone(c: Reply["classification"]): string {
  return GROUPS.find((g) => g.key === c)?.tone ?? "var(--text-muted)";
}

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

function pill(active: boolean): React.CSSProperties {
  return {
    padding: "3px 11px", borderRadius: 999, fontSize: 11.5, fontWeight: 600, cursor: "pointer",
    border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
    color: active ? "var(--accent)" : "var(--text-secondary)", background: "transparent",
  };
}

function statusWord(r: Reply): { text: string; tone: string } {
  if (r.status === "sent") return { text: "Handled", tone: "var(--green)" };
  if (r.status === "dismissed") return { text: "Dismissed", tone: "var(--text-muted)" };
  if (r.status === "draft") return { text: "Draft ready", tone: "var(--accent)" };
  return { text: "Needs reply", tone: "var(--orange)" };
}

// ── Detail pane: the selected reply ─────────────────────────────────────────
function ReplyDetail({ reply, onChanged }: { reply: Reply; onChanged: (r: Reply) => void }) {
  const [draft, setDraft] = useState(reply.draft ?? "");
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [thread, setThread] = useState<Msg[] | null>(null);
  const [threadErr, setThreadErr] = useState("");

  // Reset local edit state when a different reply is selected.
  useEffect(() => {
    setDraft(reply.draft ?? "");
    setResult(null);
  }, [reply.id, reply.draft]);

  // Pull the full history with this address from the messages ledger.
  const addr = replyAddress(reply);
  useEffect(() => {
    let dead = false;
    setThread(null); setThreadErr("");
    if (!addr) return;
    (async () => {
      try {
        const qs = new URLSearchParams({ thread: addr });
        if (reply.channel) qs.set("channel", reply.channel);
        const res = await fetch(`/api/replies?${qs}`);
        const j = (await res.json().catch(() => ({}))) as { items?: Msg[]; message?: string };
        if (!res.ok) throw new Error(j.message || `HTTP ${res.status}`);
        if (!dead) setThread(j.items ?? []);
      } catch (e) {
        if (!dead) setThreadErr(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { dead = true; };
  }, [addr, reply.channel, reply.id]);

  const act = async (action: "save_draft" | "handled" | "dismiss") => {
    if (busy) return;
    setBusy(action); setResult(null);
    try {
      const res = await fetch("/api/replies", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: reply.id,
          action,
          ...(action === "dismiss" ? {} : { draft }),
        }),
      });
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; row?: Reply; message?: string };
      if (!res.ok || !j.ok || !j.row) throw new Error(j.message || `HTTP ${res.status}`);
      // Keep the embedded message/contact we already have — the PATCH returns
      // the bare triage row.
      onChanged({ ...reply, ...j.row, messages: reply.messages, crm_contacts: reply.crm_contacts });
      setResult({
        ok: true,
        msg:
          action === "save_draft"
            ? "Draft saved. Nothing was sent — the OS never sends."
            : action === "handled"
            ? "Marked handled. Nothing was sent from here; sending happens in the outreach pipe."
            : "Dismissed. It stays in the list under Handled if you need it back.",
      });
    } catch (e) {
      setResult({ ok: false, msg: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  };

  const sw = statusWord(reply);
  const btn = (text: string, onClick: () => void, tone: string, disabled?: boolean): React.ReactElement => (
    <button
      type="button" onClick={onClick} disabled={Boolean(disabled)}
      style={{
        padding: "7px 15px", borderRadius: 999, fontSize: 12.5, fontWeight: 700,
        cursor: disabled ? "default" : "pointer", background: "transparent",
        border: `1px solid ${tone}`, color: disabled ? "var(--text-muted)" : tone,
        opacity: disabled ? 0.6 : 1,
      }}
    >
      {text}
    </button>
  );

  const inbound = reply.messages;

  return (
    <div style={{ display: "grid", gap: 12, alignContent: "start" }}>
      {/* Who + state */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "baseline" }}>
        <Chip solid tone={groupTone(reply.classification)} text={reply.classification.toUpperCase()} />
        <span style={{ fontSize: 15, fontWeight: 700, color: "var(--text-primary)", wordBreak: "break-word" }}>
          {displayName(reply)}
        </span>
        {addr && displayName(reply) !== addr && (
          <span style={{ fontSize: 11.5, color: "var(--text-muted)", wordBreak: "break-all" }}>{addr}</span>
        )}
        {reply.client_slug && (
          <span style={{ fontSize: 11.5, color: "var(--text-muted)" }}>for {reply.client_slug}</span>
        )}
        <Chip tone={sw.tone} text={sw.text} />
        <span style={{ marginLeft: "auto", fontSize: 11.5, color: "var(--text-muted)" }}>
          replied {when(inbound?.created_at ?? reply.triaged_at)}
        </span>
      </div>

      {/* The inbound reply itself */}
      <div style={{
        border: `1px solid ${groupTone(reply.classification)}`, borderRadius: 12,
        background: "var(--bg-card)", padding: "11px 14px", display: "grid", gap: 6,
      }}>
        <span style={label}>What they wrote</span>
        <pre style={{
          margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word", fontFamily: "inherit",
          fontSize: 13, lineHeight: 1.6, color: "var(--text-primary)",
        }}>
          {inbound?.body || "(the message body was not recorded on this row)"}
        </pre>
      </div>

      {/* Prior thread */}
      <div style={{ display: "grid", gap: 6 }}>
        <span style={label}>Earlier back and forth</span>
        {!addr && (
          <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.55 }}>
            No sender address on this reply, so the history cannot be looked up.
          </div>
        )}
        {addr && thread === null && !threadErr && (
          <div style={{ fontSize: 12, color: "var(--text-muted)" }}>Loading the history…</div>
        )}
        {threadErr && <Note tone="var(--red)" text={`The history could not be loaded: ${threadErr}`} />}
        {thread && thread.filter((m) => m.id !== reply.message_id).length === 0 && (
          <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.55 }}>
            No earlier messages with this address in the ledger. The original cold email may
            predate the ledger, or was sent by a pipe that does not log here yet.
          </div>
        )}
        {thread &&
          thread
            .filter((m) => m.id !== reply.message_id)
            .map((m) => (
              <div key={m.id} style={{
                justifySelf: m.direction === "inbound" ? "start" : "end",
                maxWidth: "min(560px, 94%)",
                border: "1px solid var(--border)", borderRadius: 10, padding: "7px 11px",
                background: m.direction === "inbound" ? "var(--bg-card)" : "transparent",
              }}>
                <div style={{ display: "flex", gap: 6, alignItems: "baseline", marginBottom: 3, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 10.5, fontWeight: 700, color: "var(--text-muted)" }}>
                    {m.direction === "inbound" ? "they wrote" : "Wing sent"}
                  </span>
                  <span style={{ fontSize: 10.5, color: "var(--text-muted)" }}>{when(m.created_at)}</span>
                </div>
                <pre style={{
                  margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word", fontFamily: "inherit",
                  fontSize: 12.5, lineHeight: 1.55, color: "var(--text-secondary)",
                }}>
                  {m.body || "(no body recorded)"}
                </pre>
              </div>
            ))}
      </div>

      {/* The draft */}
      <div style={{ display: "grid", gap: 6 }}>
        <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
          <span style={label}>Your reply draft</span>
          {reply.draft_model && (
            <span style={{ fontSize: 10.5, color: "var(--text-muted)" }}>
              first draft written by {reply.draft_model}
            </span>
          )}
        </div>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={
            reply.classification === "hot" || reply.classification === "warm"
              ? "No draft was written for this one yet. Type your reply here and press Save draft."
              : "Cold and Other replies do not get drafts automatically. You can still write one here."
          }
          rows={6}
          style={{
            resize: "vertical", borderRadius: 10, border: "1px solid var(--border)",
            background: "var(--bg-card)", color: "var(--text-primary)",
            fontSize: 13, lineHeight: 1.6, padding: "10px 12px", fontFamily: "inherit",
            minWidth: 0, width: "100%", boxSizing: "border-box",
          }}
        />
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          {btn(busy === "save_draft" ? "Saving…" : "Save draft", () => { void act("save_draft"); }, "var(--accent)", Boolean(busy))}
          {btn(busy === "handled" ? "Marking…" : "Mark handled", () => { void act("handled"); }, "var(--green)", Boolean(busy))}
          {btn(busy === "dismiss" ? "Dismissing…" : "Dismiss", () => { void act("dismiss"); }, "var(--text-muted)", Boolean(busy))}
          <span style={{ fontSize: 11, color: "var(--text-muted)", lineHeight: 1.5 }}>
            None of these buttons send anything. Sending happens in the outreach pipe, never from this screen.
          </span>
        </div>
        {result && (
          <div style={{ fontSize: 11.5, color: result.ok ? "var(--green)" : "var(--red)", lineHeight: 1.5 }}>
            {result.msg}
          </div>
        )}
      </div>
    </div>
  );
}

// ── The board ───────────────────────────────────────────────────────────────
export default function ReplyInboxBoard() {
  const [data, setData] = useState<Payload | null>(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<FilterKey>("attention");
  const [client, setClient] = useState("");
  const [selected, setSelected] = useState<number | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setErr("");
    try {
      const qs = new URLSearchParams();
      if (client) qs.set("client", client);
      const res = await fetch(`/api/replies${qs.size ? `?${qs}` : ""}`);
      const j = (await res.json().catch(() => ({}))) as Payload & { message?: string };
      if (!res.ok) throw new Error(j.message || `HTTP ${res.status}`);
      setData(j);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => { void load(); }, [load]);

  const visible = useMemo(() => {
    if (!data) return [];
    return data.items.filter((r) =>
      filter === "all" ? true : filter === "attention" ? needsAttention(r) : !needsAttention(r)
    );
  }, [data, filter]);

  const selectedReply = useMemo(
    () => visible.find((r) => r.id === selected) ?? data?.items.find((r) => r.id === selected) ?? null,
    [visible, data, selected]
  );

  // j/k keyboard navigation over the visible list.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "j" && e.key !== "k") return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "TEXTAREA" || t.tagName === "INPUT" || t.isContentEditable)) return;
      if (!visible.length) return;
      const idx = visible.findIndex((r) => r.id === selected);
      const next = e.key === "j" ? Math.min(visible.length - 1, idx + 1) : Math.max(0, idx <= 0 ? 0 : idx - 1);
      setSelected(visible[next]?.id ?? null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [visible, selected]);

  const applyChange = useCallback((r: Reply) => {
    setData((d) => d && { ...d, items: d.items.map((it) => (it.id === r.id ? r : it)) });
  }, []);

  if (loading && !data) {
    return <div style={{ fontSize: 13, color: "var(--text-muted)" }}>Reading the reply inbox…</div>;
  }
  if (err && !data) {
    return (
      <Note
        tone="var(--red)"
        text={`The reply inbox could not be read: ${err}. Nothing below is available — this is a failure, not an empty inbox.`}
      />
    );
  }
  if (!data) return null;

  const attentionCount = data.items.filter(needsAttention).length;

  return (
    <div style={{ display: "grid", gap: 14 }}>
      {/* Header */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "baseline" }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: "var(--text-primary)" }}>
          Reply Inbox
        </h2>
        {attentionCount > 0 && <Chip solid tone="var(--accent)" text={`${attentionCount} need attention`} />}
        <span style={{ fontSize: 12.5, color: "var(--text-muted)" }}>
          Every reply to your cold outreach, hottest first. Nothing on this screen ever sends an email.
        </span>
        <button
          type="button" onClick={() => { void load(); }}
          style={{
            marginLeft: "auto", padding: "5px 11px", borderRadius: 999, fontSize: 12.5,
            cursor: "pointer", background: "transparent",
            border: "1px solid var(--border)", color: "var(--text-muted)",
          }}
        >
          {loading ? "Loading" : "Refresh"}
        </button>
      </div>

      {/* Setup honesty */}
      {!data.available && data.reason && (
        <Note tone={data.tableMissing ? "var(--orange)" : "var(--red)"} text={data.reason} />
      )}

      {/* Filters */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
        {([
          ["all", "All"],
          ["attention", "Needs attention"],
          ["handled", "Handled"],
        ] as const).map(([k, name]) => (
          <button key={k} type="button" onClick={() => setFilter(k)} style={pill(filter === k)}>
            {name}
          </button>
        ))}
        {data.clientSlugs.length > 0 && (
          <>
            <span style={{ ...label, marginLeft: 12 }}>Client</span>
            <button type="button" onClick={() => setClient("")} style={pill(client === "")}>all</button>
            {data.clientSlugs.map((s) => (
              <button key={s} type="button" onClick={() => setClient(s)} style={pill(client === s)}>
                {s}
              </button>
            ))}
          </>
        )}
        <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--text-muted)" }}>
          tip: j / k moves through the list
        </span>
      </div>

      {data.available && data.items.length === 0 && (
        <div style={{ fontSize: 12.5, color: "var(--text-muted)", lineHeight: 1.6 }}>
          No replies yet. Replies land here when the triage agent syncs inbound messages
          (ghl-cli smtp_replies) into the reply_triage table — the table exists and is simply empty.
        </div>
      )}

      {data.items.length > 0 && (
        <div style={{
          display: "grid", gap: 14, alignItems: "start",
          gridTemplateColumns: "minmax(240px, 330px) minmax(0, 1fr)",
        }}>
          {/* Left: grouped list */}
          <div ref={listRef} style={{ display: "grid", gap: 10, minWidth: 0 }}>
            {GROUPS.map((g) => {
              const rows = visible.filter((r) => r.classification === g.key);
              const total = data.items.filter((r) => r.classification === g.key).length;
              if (total === 0) return null;
              return (
                <div key={g.key} style={{ display: "grid", gap: 6 }}>
                  <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
                    <span style={{ ...label, color: g.tone }}>{g.name}</span>
                    <span style={{ fontSize: 10.5, color: "var(--text-muted)" }}>
                      {rows.length === total ? total : `${rows.length} of ${total}`}
                    </span>
                  </div>
                  {rows.length === 0 && (
                    <div style={{ fontSize: 11.5, color: "var(--text-muted)" }}>
                      none under this filter
                    </div>
                  )}
                  {rows.map((r) => {
                    const isSel = r.id === selected;
                    const attn = needsAttention(r);
                    const sw = statusWord(r);
                    return (
                      <div
                        key={r.id}
                        onClick={() => setSelected(r.id)}
                        style={{
                          border: `1px solid ${isSel ? "var(--accent)" : attn ? g.tone : "var(--border)"}`,
                          borderRadius: 10, padding: "8px 11px", cursor: "pointer",
                          background: isSel ? "var(--bg-hover)" : "var(--bg-card)",
                          display: "grid", gap: 3, minWidth: 0,
                          opacity: attn ? 1 : 0.72,
                        }}
                      >
                        <div style={{ display: "flex", gap: 6, alignItems: "baseline", minWidth: 0 }}>
                          <span style={{
                            fontSize: 12.5, fontWeight: attn ? 700 : 500, color: "var(--text-primary)",
                            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                            flex: 1, minWidth: 0,
                          }}>
                            {displayName(r)}
                          </span>
                          <span style={{ fontSize: 10.5, color: "var(--text-muted)", whiteSpace: "nowrap" }}>
                            {when(r.messages?.created_at ?? r.triaged_at)}
                          </span>
                        </div>
                        <div style={{ display: "flex", gap: 6, alignItems: "baseline", minWidth: 0 }}>
                          <Chip tone={sw.tone} text={sw.text} />
                          <span style={{
                            fontSize: 11.5, color: "var(--text-secondary)", overflow: "hidden",
                            textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0,
                          }}>
                            {r.messages?.body || "(no message text recorded)"}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              );
            })}
            {visible.length === 0 && data.items.length > 0 && (
              <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.55 }}>
                Nothing matches this filter. The replies are still there — switch the filter above to see them.
              </div>
            )}
          </div>

          {/* Right: detail */}
          <div style={{
            border: "1px solid var(--border)", borderRadius: 12,
            background: "var(--bg-secondary)", padding: "14px 16px", minWidth: 0,
          }}>
            {selectedReply ? (
              <ReplyDetail key={selectedReply.id} reply={selectedReply} onChanged={applyChange} />
            ) : (
              <div style={{ fontSize: 12.5, color: "var(--text-muted)", lineHeight: 1.6 }}>
                Pick a reply on the left to read it, see the earlier back and forth, and edit the draft.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
