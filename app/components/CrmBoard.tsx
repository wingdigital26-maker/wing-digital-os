"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { sfx } from "../lib/sounds";
import CrmClientSummary, {
  CHANNEL_LABEL, type ChannelRoll, type ClientProfile, type Scraper, type StatusBreakdown,
} from "./CrmClientSummary";
import CrmContentFeed, { type ContentFeed, type ContentItem } from "./CrmContentFeed";
import CrmScraperHealth, { ago, healthLook, isOffByChoice, type Watch } from "./CrmScraperHealth";
import CrmRowDetail, { type DetailItem, type Evidence, type Review, type TierInfo } from "./CrmRowDetail";

// CRM — everything happening for a client, compartmentalized by client.
//
// Left rail lists each client. Picking one shows a summary of their key facts,
// their scraper's hunting instructions, lanes for each channel (email, social
// replies, SMS), the messages in that lane, and the content Wing actually
// published for them. Reads /api/crm (Sonar Supabase + the vault + the content
// engine's state file). Nothing here transmits — it keeps the work checked.

// A client with no policy row, or with may_send anything but exactly true,
// can never be sent for. DEFAULT DENY — absence of a row is itself a deny,
// never an unknown to be rendered as blank.
type SendPolicy = { client: string; may_send: boolean; scope_note: string | null };

type ClientRollup = {
  client: string; total: number; draft: number; approved: number; sent: number;
  channels: string[]; byChannel: ChannelRoll[]; scraper: Scraper | null;
  profile: ClientProfile | null; watch?: Watch; sendPolicy: SendPolicy | null;
};

type Item = {
  id: number; client: string; channel: string; recipient: string | null;
  recipient_url: string | null; subject: string | null; body: string | null;
  personalization: string | null; evidence_url: string | null;
  status: string; tier: string | null; created_at: string;
  // null = not knowable right now (policy/queue read failed), never a guess.
  sendable: boolean | null;
  notSendableReason: string | null;
  // Rich per-row data the API computes: tier meaning, evidence quote +
  // source distinction, review state. Optional because older payloads may
  // not carry every field, but the live shape always does.
  recipientHandle?: string | null;
  reviewedAt?: string | null;
  sentAt?: string | null;
  direction?: string | null;
  tierInfo?: TierInfo;
  evidence?: Evidence;
  review?: Review;
  bodyState?: string;
};
type Payload = {
  configured: boolean; error?: string;
  clients: ClientRollup[]; items: Item[];
  totals?: { total: number; draft: number; approved: number; sent: number };
  content?: ContentFeed;
  sendPolicy?: { available: boolean; reason: string | null };
  sendable?: { available: boolean; reason: string | null; count: number | null };
};

const STATUS_COLOR: Record<string, string> = {
  draft: "var(--text-muted)",
  approved: "var(--green)",
  sent: "var(--accent)",
  skipped: "var(--red)",
  rejected: "var(--text-muted)",
};

// Which raw `channel` values belong to which lane.
const SOCIAL = ["nextdoor", "reddit", "facebook", "instagram", "tiktok", "linkedin"];
const SMS = ["sms", "text"];
type Lane = "email" | "social" | "sms";
const LANES: { id: Lane; label: string; match: (ch: string) => boolean }[] = [
  { id: "email", label: "Email", match: (ch) => ch === "email" },
  { id: "social", label: "Social replies", match: (ch) => SOCIAL.includes(ch) },
  { id: "sms", label: "SMS / texting", match: (ch) => SMS.includes(ch) },
];

// The API returns at most 200 rows per client. Past that, anything derived by
// reading the rows is a floor rather than a count, and has to say so.
const ROW_CAP = 200;

// ── Parked rows ────────────────────────────────────────────────────────────
// A lead the pipeline could not finish on its own and handed back to a human.
// Today the only such case is a post with real demand and no resolvable city:
// the scraper stores it as `rejected` and writes the reason into
// `personalization`. There is no distinct status on the row to key off, so the
// marker the scraper itself writes is what we read. If a dedicated status ever
// lands, this is the one place to change.
const PARK_MARK = /^\s*NEEDS LOCATION CHECK\b/i;
export const isParked = (it: Item) =>
  it.status === "rejected" && PARK_MARK.test(it.personalization ?? "");
/** The reason text, with the shouty marker stripped off the front. */
const parkReason = (it: Item) =>
  (it.personalization ?? "").replace(/^\s*NEEDS LOCATION CHECK\s*[—–-]\s*/i, "");

export function breakdownOf(items: Item[], roll: { total: number; draft: number; approved: number; sent: number }): StatusBreakdown {
  const notLive = Math.max(0, roll.total - roll.draft - roll.approved - roll.sent);
  const truncated = items.length >= ROW_CAP;
  if (truncated) {
    return { total: roll.total, draft: roll.draft, approved: roll.approved, sent: roll.sent,
             rejected: null, skipped: null, other: null, parked: null, notLive, truncated };
  }
  let rejected = 0, skipped = 0, other = 0, parked = 0;
  for (const it of items) {
    if (it.status === "rejected") { rejected++; if (isParked(it)) parked++; }
    else if (it.status === "skipped") skipped++;
    else if (!["draft", "approved", "sent"].includes(it.status)) other++;
  }
  return { total: roll.total, draft: roll.draft, approved: roll.approved, sent: roll.sent,
           rejected, skipped, other, parked, notLive, truncated };
}

// ── Timeline ───────────────────────────────────────────────────────────────
// One merged history from the sources that genuinely record a time. Nothing is
// synthesised: every entry carries the timestamp its own source wrote.
type Ev = {
  key: string; at: number;
  /** false when the source records a date but no clock time. */
  exact: boolean; when: string;
  mark: string; color: string; kind: string;
  title: string; detail?: string | null; url?: string | null; status?: string;
};

export function buildTimeline(items: Item[], watch: Watch | undefined, content: ContentFeed | undefined): Ev[] {
  const evs: Ev[] = [];

  for (const it of items) {
    const t = Date.parse(it.created_at);
    if (!Number.isFinite(t)) continue;
    const parked = isParked(it);
    const look = parked
      ? { mark: "⚑", color: "var(--orange)", kind: "parked for a decision" }
      : it.status === "draft" ? { mark: "✎", color: "var(--accent)", kind: "draft written" }
      : it.status === "approved" ? { mark: "✓", color: "var(--green)", kind: "approved" }
      : it.status === "sent" ? { mark: "→", color: "var(--accent)", kind: "sent" }
      : it.status === "skipped" ? { mark: "×", color: "var(--text-muted)", kind: "skipped" }
      : { mark: "·", color: "var(--text-muted)", kind: "lead filtered out" };
    evs.push({
      key: `i${it.id}`, at: t, exact: true, when: it.created_at,
      ...look,
      title: `${CHANNEL_LABEL[it.channel] || it.channel || "unlabeled"} · ${it.recipient || "(no recipient recorded)"}`,
      detail: parked ? parkReason(it) : it.personalization,
      url: it.evidence_url || it.recipient_url,
      status: it.status,
    });
  }

  const run = watch?.run;
  if (run?.ran_at) {
    const t = Date.parse(run.ran_at);
    if (Number.isFinite(t)) {
      const n = (v: number | null) => (v == null ? "an unrecorded number of" : String(v));
      evs.push({
        key: "run", at: t, exact: true, when: run.ran_at,
        mark: "◎", color: (run.results ?? 0) > 0 ? "var(--green)" : "var(--orange)",
        kind: "scraper run",
        title: `${n(run.queries)} queries → ${n(run.results)} results`,
        detail: `${n(run.kept)} kept as drafts, ${n(run.rejected)} filtered out` +
                (run.throttled ? `, ${run.throttled} throttled` : ""),
      });
    }
  }

  // Only content that actually shipped belongs in a history. Planned and
  // drafted rows are future work and stay in the content panel below.
  for (const [i, c] of ((content?.items ?? []) as ContentItem[]).entries()) {
    if (c.status !== "published") continue;
    const t = Date.parse(`${c.date}T00:00:00Z`);
    if (!Number.isFinite(t)) continue;
    evs.push({
      key: `c${i}`, at: t, exact: false, when: c.date,
      mark: "◆", color: "var(--green)", kind: "published",
      title: c.title || "(untitled)", detail: c.type, url: c.url,
    });
  }

  return evs.sort((a, b) => b.at - a.at);
}

export default function CrmBoard() {
  const [data, setData] = useState<Payload | null>(null);
  const [err, setErr] = useState("");
  const [client, setClient] = useState<string>("");
  const [status, setStatus] = useState<string>("draft");
  // When set, the list ignores lane + status and shows exactly the pile the
  // "needs you" panel pointed at. Clicking a queue has to take you TO it.
  const [focus, setFocus] = useState<null | "draft" | "approved" | "parked">(null);
  const [showAllEvents, setShowAllEvents] = useState(false);
  const [lane, setLane] = useState<Lane>("email");
  const [lanePicked, setLanePicked] = useState(false);
  const [edits, setEdits] = useState<Record<number, string>>({});
  const [copied, setCopied] = useState<number | null>(null);
  // Per-row failure text. A row that could not be approved stays on the board
  // carrying the reason, instead of vanishing as though it succeeded.
  const [actErr, setActErr] = useState<Record<number, string>>({});
  // Which row's full-detail panel is open. One at a time, per board.
  const [openId, setOpenId] = useState<number | null>(null);
  const [cfg, setCfg] = useState<Scraper | null>(null);
  const [cfgSaved, setCfgSaved] = useState(false);
  const [cfgErr, setCfgErr] = useState("");

  // Deliberately unfiltered: a CRM has to show the whole history for a client,
  // not just one status. The status chips filter these rows in the browser, so
  // switching them never blanks the timeline or hides what needs a decision.
  const load = useCallback(() => {
    const qs = new URLSearchParams();
    if (client) qs.set("client", client);
    qs.set("status", "");
    fetch(`/api/crm?${qs}`)
      .then((r) => r.json())
      .then((d: Payload) => {
        setData(d); setErr(d.error || "");
        if (!client && d.clients?.length) setClient(d.clients[0].client);
      })
      .catch((e) => setErr(String(e)));
  }, [client]);

  useEffect(() => { load(); }, [load]);

  const current = useMemo(
    () => data?.clients.find((x) => x.client === client) ?? null,
    [data?.clients, client]
  );

  // Reseed the editable scraper form when the compartment changes — done during
  // render (React's sanctioned reset pattern) so in-progress edits survive a
  // background refresh but never leak from one client onto another.
  const [cfgFor, setCfgFor] = useState<string | null>(null);
  if (current && cfgFor !== current.client) {
    setCfgFor(current.client);
    setCfg(current.scraper ? { ...current.scraper } : null);
    setLanePicked(false);
    setFocus(null);
    setShowAllEvents(false);
  }

  // Every row this client has, whatever its status.
  const rows = useMemo(
    () => (data?.items ?? []).filter((i) => i.client === client),
    [data?.items, client]
  );
  const scrapingOff = isOffByChoice(current?.scraper?.channels);
  const breakdown = useMemo(
    () => breakdownOf(rows, {
      total: current?.total ?? rows.length, draft: current?.draft ?? 0,
      approved: current?.approved ?? 0, sent: current?.sent ?? 0,
    }),
    [rows, current]
  );
  const parked = useMemo(() => rows.filter(isParked), [rows]);
  const drafts = useMemo(() => rows.filter((i) => i.status === "draft"), [rows]);
  const approved = useMemo(() => rows.filter((i) => i.status === "approved"), [rows]);
  const events = useMemo(
    () => buildTimeline(rows, current?.watch, data?.content),
    [rows, current?.watch, data?.content]
  );

  // Counts per lane come from the client's full rollup, so a lane's tab is
  // honest about having zero even when the current status filter hides it.
  const laneCounts = useMemo(() => {
    const out: Record<Lane, number> = { email: 0, social: 0, sms: 0 };
    for (const c of current?.byChannel ?? []) {
      const l = LANES.find((x) => x.match(c.channel));
      if (l) out[l.id] += c.total;
    }
    return out;
  }, [current]);

  // Until Jack picks a lane, default to one that actually has something. Once
  // he clicks, his choice sticks even if that lane is empty.
  const active: Lane = lanePicked
    ? lane
    : (LANES.find((l) => laneCounts[l.id] > 0)?.id ?? lane);

  // Focus wins over lane + status: when you click a queue you get that queue,
  // whole, across every channel — not that queue intersected with whatever
  // tabs happened to be selected.
  const visible = useMemo(() => {
    if (focus === "parked") return parked;
    if (focus === "draft") return drafts;
    if (focus === "approved") return approved;
    const m = LANES.find((l) => l.id === active)!.match;
    return rows.filter((i) => m(i.channel || "") && (!status || i.status === status));
  }, [rows, active, status, focus, parked, drafts, approved]);

  const unlaned = useMemo(() => {
    const known = (ch: string) => LANES.some((l) => l.match(ch));
    return (current?.byChannel ?? []).filter((c) => !known(c.channel));
  }, [current]);

  async function saveCfg() {
    if (!cfg) return;
    const err = await post({ action: "config", ...cfg });
    if (err) {
      // "saved" is a claim. Do not make it when the write was refused.
      setCfgErr(err);
      return;
    }
    setCfgErr("");
    sfx.play("blip");
    setCfgSaved(true);
    setTimeout(() => setCfgSaved(false), 1600);
  }

  // Removing the row is how this board says "done". That is only truthful if the
  // write actually landed, so nothing is removed until the server confirms it.
  // The previous version dropped the row and played the success sound no matter
  // what came back, which made a failed approve look exactly like a real one.
  async function post(payload: Record<string, unknown>): Promise<string | null> {
    try {
      const r = await fetch("/api/crm", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j?.ok === false) return String(j?.error || `failed (${r.status})`);
      return null;
    } catch (e) {
      return String(e);
    }
  }

  async function act(it: Item, action: "approve" | "skip" | "sent") {
    setActErr((m) => ({ ...m, [it.id]: "" }));
    if (edits[it.id] !== undefined && edits[it.id] !== it.body) {
      const saveErr = await post({ id: it.id, action: "save", body: edits[it.id] });
      // The edit is the thing being approved. If it did not persist, stop here
      // rather than approving the older body behind Jack's back.
      if (saveErr) {
        setActErr((m) => ({ ...m, [it.id]: `Edit did not save: ${saveErr}` }));
        return;
      }
    }
    const err = await post({ id: it.id, action });
    if (err) {
      setActErr((m) => ({ ...m, [it.id]: `Could not ${action}: ${err}` }));
      return;
    }
    sfx.play("blip");
    setData((d) => (d ? { ...d, items: d.items.filter((x) => x.id !== it.id) } : d));
  }

  function copy(it: Item) {
    const text = edits[it.id] ?? it.body ?? "";
    navigator.clipboard?.writeText(
      it.channel === "email" && it.subject ? `Subject: ${it.subject}\n\n${text}` : text
    );
    setCopied(it.id);
    setTimeout(() => setCopied((c) => (c === it.id ? null : c)), 1500);
  }

  if (err && !data?.items?.length) return <p style={{ color: "var(--red)", fontSize: 13 }}>CRM: {err}</p>;
  if (!data) {
    return (
      <div style={{ display: "grid", gridTemplateColumns: "220px 1fr", gap: 16 }} aria-label="Loading CRM">
        <div className="skel" style={{ height: 300, borderRadius: 14 }} />
        <div style={{ display: "grid", gap: 12 }}>
          {[0, 1, 2].map((i) => <div key={i} className="skel" style={{ height: 130, borderRadius: 14 }} />)}
        </div>
      </div>
    );
  }
  if (!data.configured) {
    return (
      <div style={{ padding: 18, border: "1px solid var(--border)", borderRadius: 14 }}>
        <h3 style={{ margin: "0 0 6px", fontSize: 15 }}>CRM not connected</h3>
        <p style={{ margin: 0, fontSize: 13, color: "var(--text-secondary)" }}>
          Add <code>SONAR_SUPABASE_URL</code> and <code>SONAR_SUPABASE_SERVICE_KEY</code> to the environment.
        </p>
      </div>
    );
  }

  const t = data.totals;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <header style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
        <h2 style={{ margin: 0, fontSize: 18, letterSpacing: "-0.01em" }}>CRM</h2>
        <span style={{ fontSize: 12.5, color: "var(--text-secondary)" }}>
          Everything happening for each client. Nothing sends from here, you keep it checked.
        </span>
      </header>

      {t && (
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          {([["Total", t.total, null], ["Drafts", t.draft, null],
             ["Approved", t.approved, "var(--green)"], ["Sent", t.sent, "var(--accent)"]] as
            [string, number, string | null][]).map(([label, val, color]) => (
            <div key={label} style={{
              border: "1px solid var(--border)", borderRadius: 12, padding: "8px 14px",
              background: "var(--bg-card)", minWidth: 92,
            }}>
              <div style={{ fontSize: 20, fontWeight: 700, color: color || "var(--text-primary)", fontVariantNumeric: "tabular-nums" }}>{val}</div>
              <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>{label}</div>
            </div>
          ))}
          {/* How many rows could actually go out right now, distinct from how
              many are approved. An approved row is only a request; this is
              the count that survived client permission, suppression, channel
              and body checks. Zero here must never look like a read failure,
              and a read failure must never render as zero. */}
          <div style={{
            border: `1px solid ${data.sendable?.available === false ? "var(--red)" : "var(--border)"}`,
            borderRadius: 12, padding: "8px 14px", background: "var(--bg-card)", minWidth: 168,
          }}>
            {data.sendable?.available === false ? (
              <>
                <div style={{ fontSize: 13, fontWeight: 700, color: "var(--red)" }}>Could not read policy</div>
                <div style={{ fontSize: 10.5, color: "var(--text-secondary)", marginTop: 2, lineHeight: 1.4 }}>
                  {data.sendable.reason ?? "The sendable queue could not be read."} Not the same as zero.
                </div>
              </>
            ) : (
              <>
                <div style={{ fontSize: 20, fontWeight: 700, color: (data.sendable?.count ?? 0) > 0 ? "var(--green)" : "var(--text-primary)", fontVariantNumeric: "tabular-nums" }}>
                  {data.sendable?.count ?? "not counted"}
                </div>
                <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                  sendable right now{(data.sendable?.count ?? 0) === 0 ? ", because every client is denied or nothing is eligible" : ""}
                </div>
              </>
            )}
          </div>
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "minmax(180px,220px) 1fr", gap: 16, alignItems: "start" }}>
        {/* Client compartments */}
        <nav style={{ display: "flex", flexDirection: "column", gap: 6 }} aria-label="Clients">
          {data.clients.length === 0 && (
            <p style={{ fontSize: 12.5, color: "var(--text-secondary)" }}>No clients configured yet.</p>
          )}
          {data.clients.map((c) => {
            const on = c.client === client;
            return (
              <button key={c.client} onClick={() => setClient(c.client)} style={{
                textAlign: "left", cursor: "pointer", borderRadius: 12, padding: "10px 12px",
                border: `1px solid ${on ? "var(--accent)" : "var(--border)"}`,
                background: on ? "var(--accent-glow)" : "var(--bg-card)",
                color: "var(--text-primary)",
              }}>
                <div style={{ fontSize: 13.5, fontWeight: 600 }}>{c.client}</div>
                <div style={{ fontSize: 11, color: "var(--text-secondary)", marginTop: 3 }}>
                  {c.draft} draft · {c.approved} ok · {c.sent} sent
                </div>
                <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 2 }}>
                  {c.channels.length
                    ? c.channels.map((ch) => CHANNEL_LABEL[ch] || ch).join(" · ")
                    : "no messages yet"}
                </div>
                {(() => {
                  if (!c.watch) return null;
                  const r = healthLook(c.watch, c.scraper?.channels);
                  // Anything the client is actually waiting on you for, on the
                  // rail, so a full queue is visible before you click in.
                  const waiting = c.draft + c.approved;
                  return (
                    <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginTop: 4 }}>
                      <span style={{ fontSize: 10, fontWeight: 600, color: r.color }}>
                        <span aria-hidden>{r.mark}</span> {r.label.toLowerCase()}
                      </span>
                      {waiting > 0 && (
                        <span style={{
                          fontSize: 9.5, fontWeight: 700, padding: "1px 7px", borderRadius: 20,
                          background: "var(--accent)", color: "var(--bg-card)",
                        }}>{waiting} for you</span>
                      )}
                    </div>
                  );
                })()}
              </button>
            );
          })}
        </nav>

        {/* Everything for the selected client */}
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>

          {/* Contract boundary, stated plainly. This is not a bug and not a
              toggle to flip from the board, it is what was signed. Shown
              before anything else for a denied client so an empty queue
              reads as "by design" instead of "broken". */}
          {current && data.sendPolicy?.available === false && (
            <div style={{
              border: "1px solid var(--red)", borderRadius: 12, padding: "10px 14px",
              background: "var(--bg-card)",
            }}>
              <div style={{ fontSize: 12.5, fontWeight: 700, color: "var(--red)" }}>
                Send permission could not be checked
              </div>
              <p style={{ margin: "4px 0 0", fontSize: 11.5, color: "var(--text-secondary)", lineHeight: 1.5 }}>
                {data.sendPolicy.reason ?? "The send-policy table could not be read."} Treat every row for{" "}
                {current.client} as NOT sendable until this is confirmed. A failed read is not permission.
              </p>
            </div>
          )}
          {current && data.sendPolicy?.available !== false && current.sendPolicy?.may_send !== true && (
            <div style={{
              border: "1px solid var(--orange)", borderRadius: 12, padding: "10px 14px",
              background: "var(--bg-card)",
            }}>
              <div style={{ fontSize: 12.5, fontWeight: 700, color: "var(--orange)" }}>
                {current.client} cannot be sent for. Contract limit, not a bug.
              </div>
              <p style={{ margin: "4px 0 0", fontSize: 11.5, color: "var(--text-secondary)", lineHeight: 1.5 }}>
                {current.sendPolicy?.scope_note
                  ?? `${current.client} has no send-policy row on file, which defaults to deny.`}
                {" "}Approving rows below still keeps them checked, but nothing for this client can ever leave
                Wing until the signed scope changes.
              </p>
            </div>
          )}

          {current && (
            <CrmClientSummary
              name={current.client}
              profile={current.profile}
              scraper={current.scraper}
              counts={{ draft: current.draft, approved: current.approved, sent: current.sent, total: current.total }}
              byChannel={current.byChannel}
              breakdown={breakdown}
              scrapingOff={scrapingOff}
            />
          )}

          {/* What needs a decision from Jack, for this client, right now. */}
          {current && (
            <NeedsYou
              name={current.client}
              drafts={drafts.length} approved={approved.length} parked={parked.length}
              watch={current.watch} scrapingOff={scrapingOff}
              breakdown={breakdown}
              focus={focus} setFocus={setFocus}
            />
          )}

          {/* Is this client's scraper actually working? Sits directly above the
              settings that control it, so a broken state and the knobs that fix
              it are in the same glance. */}
          {current?.watch && (
            <CrmScraperHealth watch={current.watch} name={current.client}
                              channels={current.scraper?.channels} />
          )}

          {/* This client's own scraper: what it hunts, where, on which
              platforms. The watcher reads exactly these fields on every run,
              so editing here retargets the next run. */}
          {cfg && (
            <section style={{
              border: "1px solid var(--border)", borderRadius: 14,
              padding: "13px 16px", background: "var(--accent-glow)",
              display: "flex", flexDirection: "column", gap: 8,
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <span style={{
                  fontSize: 10.5, textTransform: "uppercase", letterSpacing: ".1em",
                  fontWeight: 700, color: "var(--accent)",
                }}>◉ {cfg.name}&apos;s scraper</span>
                <span style={{ fontSize: 11.5, color: "var(--text-secondary)" }}>
                  {isOffByChoice(cfg.channels) ? (
                    <>platforms set to <b style={{ color: "var(--text-primary)" }}>none</b>, this
                    scraper is intentionally not hunting for anyone</>
                  ) : (
                    <>hunts <b style={{ color: "var(--text-primary)" }}>{cfg.scrape_niche || "?"}</b> customers
                    in <b style={{ color: "var(--text-primary)" }}>{cfg.scrape_cities || "?"}</b>
                    {" "}· runs 3x daily, PC off</>
                  )}
                </span>
                <span style={{ flex: 1 }} />
                <label style={{ fontSize: 11.5, color: "var(--text-secondary)", display: "flex", alignItems: "center", gap: 5 }}>
                  <input type="checkbox" checked={cfg.active}
                    onChange={(e) => setCfg({ ...cfg, active: e.target.checked })} />
                  active
                </label>
              </div>
              <div style={{ display: "grid", gap: 8, gridTemplateColumns: "repeat(auto-fit,minmax(160px,1fr))" }}>
                {([["what they sell", "scrape_niche", "roofing"],
                   ["cities to watch", "scrape_cities", "Plano,Frisco"],
                   ["extra keywords", "scrape_terms", "roof leak,hail damage"],
                   ["platforms", "channels", "nextdoor,reddit"]] as
                  [string, "scrape_niche" | "scrape_cities" | "scrape_terms" | "channels", string][]
                ).map(([label, key, ph]) => (
                  <label key={key} style={{ fontSize: 10.5, color: "var(--text-muted)", display: "flex", flexDirection: "column", gap: 3 }}>
                    {label}
                    <input value={cfg[key] ?? ""} placeholder={ph}
                      onChange={(e) => setCfg({ ...cfg, [key]: e.target.value })}
                      style={{
                        fontSize: 12.5, padding: "6px 9px", borderRadius: 8,
                        border: "1px solid var(--border)", background: "var(--bg-card)",
                        color: "var(--text-primary)", fontFamily: "inherit",
                      }} />
                  </label>
                ))}
              </div>
              <div>
                <button onClick={saveCfg} style={{
                  fontSize: 11.5, padding: "5px 14px", borderRadius: 8, cursor: "pointer",
                  border: "1px solid var(--accent)", color: "var(--accent)",
                  background: "transparent", fontWeight: 600,
                }}>{cfgSaved ? "saved, next run uses this" : "save scraper settings"}</button>
                {cfgErr && (
                  <p role="alert" style={{ color: "var(--red)", fontSize: 12, margin: "6px 0 0" }}>
                    Not saved: {cfgErr}. The next run still uses the old settings.
                  </p>
                )}
              </div>
            </section>
          )}

          {/* What actually happened, newest first. */}
          {current && (
            <Timeline
              name={current.client} events={events} rows={rows.length}
              truncated={breakdown.truncated} content={data.content}
              watch={current.watch} scrapingOff={scrapingOff}
              showAll={showAllEvents} setShowAll={setShowAllEvents}
            />
          )}

          {/* Channel lanes */}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center",
                        borderBottom: "1px solid var(--border)", paddingBottom: 9,
                        opacity: focus ? 0.45 : 1 }}>
            {LANES.map((l) => {
              const on = active === l.id;
              return (
                <button key={l.id} onClick={() => { setLane(l.id); setLanePicked(true); }} style={{
                  fontSize: 12.5, padding: "5px 13px", borderRadius: 9, cursor: "pointer",
                  fontWeight: on ? 650 : 500,
                  border: `1px solid ${on ? "var(--accent)" : "var(--border)"}`,
                  background: on ? "var(--accent-glow)" : "transparent",
                  color: on ? "var(--accent)" : "var(--text-secondary)",
                }}>
                  {l.label}
                  <span style={{ marginLeft: 7, color: "var(--text-muted)", fontVariantNumeric: "tabular-nums" }}>
                    {laneCounts[l.id]}
                  </span>
                </button>
              );
            })}
            {unlaned.length > 0 && (
              <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                + {unlaned.map((c) => `${CHANNEL_LABEL[c.channel] || c.channel} (${c.total})`).join(", ")} on
                {" "}channels with no lane
              </span>
            )}
          </div>

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            {(["draft", "approved", "sent", "skipped", "rejected", ""]).map((s) => {
              const on = !focus && status === s;
              return (
                <button key={s || "all"} onClick={() => { setStatus(s); setFocus(null); }} style={{
                  fontSize: 12, padding: "4px 12px", borderRadius: 20, cursor: "pointer",
                  border: `1px solid ${on ? "var(--accent)" : "var(--border)"}`,
                  background: on ? "var(--accent-glow)" : "transparent",
                  color: focus ? "var(--text-muted)" : "var(--text-primary)",
                }}>{s || "all"}</button>
              );
            })}
            {focus && (
              <button onClick={() => setFocus(null)} style={{
                fontSize: 12, padding: "4px 12px", borderRadius: 20, cursor: "pointer",
                border: "1px solid var(--orange)", background: "var(--accent-glow)",
                color: "var(--orange)", fontWeight: 650,
              }}>
                showing the {focus === "parked" ? "parked" : focus} queue, all channels, clear ✕
              </button>
            )}
          </div>

          {focus && visible.length === 0 ? (
            <p style={{ fontSize: 13, color: "var(--text-secondary)" }}>
              That queue is empty for {client}.
            </p>
          ) : !focus && active === "sms" && laneCounts.sms === 0 ? (
            <div style={{
              border: "1px dashed var(--border)", borderRadius: 12, padding: "13px 15px",
            }}>
              <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--orange)" }}>
                No SMS lane wired yet
              </div>
              <p style={{ margin: "5px 0 0", fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.55 }}>
                Nothing writes rows with <code>channel = &quot;sms&quot;</code> to the <code>outbound</code> table,
                and Wing has no texting provider connected since GHL was retired. This lane will fill in on
                its own once a sender starts drafting texts, nothing is being hidden.
              </p>
            </div>
          ) : visible.length === 0 ? (
            <div style={{ border: "1px dashed var(--border)", borderRadius: 12, padding: "13px 15px" }}>
              <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text-secondary)" }}>
                Nothing {status || "at all"} on{" "}
                {LANES.find((l) => l.id === active)!.label.toLowerCase()} for {client || "this client"}
              </div>
              <p style={{ margin: "5px 0 0", fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.55 }}>
                {/* Say WHICH kind of empty this is, using only real counts. */}
                {laneCounts[active] === 0
                  ? breakdown.total === 0
                    ? scrapingOff
                      ? `No row has ever been written for ${client} on any channel, expected, since their scraping is off by choice.`
                      : `No row has ever been written for ${client} on any channel.`
                    : `${client} has ${breakdown.total} row${breakdown.total === 1 ? "" : "s"}, but none of them on this channel.`
                  : `This channel has ${laneCounts[active]} row${laneCounts[active] === 1 ? "" : "s"} in total, none of them ${status || "matching"}.`}
              </p>
            </div>
          ) : visible.map((it) => {
            const park = isParked(it);
            const stripe = park ? "var(--orange)"
              : STATUS_COLOR[it.status] || "var(--border)";
            // A rejected lead carries no drafted message — the pipeline stopped
            // before writing one. Showing an empty editor there would invite you
            // to type into a row nothing will ever send.
            const writable = it.status === "draft" || it.status === "approved" || it.body != null;
            return (
            <article key={it.id} style={{
              border: "1px solid var(--border)", borderLeft: `4px solid ${stripe}`,
              borderRadius: 14, padding: "14px 16px",
              background: "var(--bg-card)", display: "flex", flexDirection: "column", gap: 9,
            }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
                <div>
                  <span style={{
                    fontSize: 10.5, textTransform: "uppercase", letterSpacing: ".08em",
                    color: "var(--accent)", fontWeight: 700,
                  }}>{CHANNEL_LABEL[it.channel] || it.channel}{it.tier ? ` · ${it.tier}` : ""}</span>
                  <div style={{ fontSize: 14.5, fontWeight: 650, marginTop: 3 }}>
                    {it.recipient || "(recipient)"}
                  </div>
                </div>
                <div style={{ display: "flex", gap: 6, alignItems: "flex-start", flexWrap: "wrap" }}>
                  {park && (
                    <span style={{
                      fontSize: 10.5, fontWeight: 700, padding: "2px 9px", borderRadius: 20,
                      border: "1px solid var(--orange)", color: "var(--orange)",
                    }}>⚑ parked, needs you</span>
                  )}
                  <span style={{ fontSize: 11, fontWeight: 600, color: STATUS_COLOR[it.status] || "var(--text-primary)" }}>
                    {it.status}
                  </span>
                  <button
                    type="button"
                    aria-expanded={openId === it.id}
                    onClick={(e) => { e.stopPropagation(); setOpenId((cur) => (cur === it.id ? null : it.id)); }}
                    style={{
                      fontSize: 11, padding: "3px 10px", borderRadius: 20, cursor: "pointer",
                      border: `1px solid ${openId === it.id ? "var(--accent)" : "var(--border)"}`,
                      background: openId === it.id ? "var(--accent-glow)" : "transparent",
                      color: openId === it.id ? "var(--accent)" : "var(--text-secondary)", fontWeight: 600,
                    }}
                  >
                    {openId === it.id ? "hide details" : "details"}
                  </button>
                </div>
              </div>

              {it.subject && (
                <div style={{ fontSize: 13, fontWeight: 600 }}>{it.subject}</div>
              )}

              {/* Approved does not mean sendable. Name the specific reason,
                  read from the data, never a generic "not ready". */}
              {it.status === "approved" && it.sendable !== true && (
                <div style={{
                  fontSize: 11.5, lineHeight: 1.5, borderRadius: 8, padding: "6px 9px",
                  background: "var(--bg-secondary)",
                  color: it.sendable === null ? "var(--red)" : "var(--orange)",
                  border: `1px solid ${it.sendable === null ? "var(--red)" : "var(--orange)"}`,
                }}>
                  <b>{it.sendable === null ? "Cannot confirm sendable: " : "Approved, but not sendable: "}</b>
                  {it.notSendableReason ?? "No reason was returned for this row."}
                </div>
              )}

              {/* The real fact this was personalized on, the thing that keeps
                  it honest and non-generic. For a parked row it is instead the
                  reason a human has to step in. */}
              {it.personalization && (
                <div style={{
                  fontSize: 12, fontStyle: park ? "normal" : "italic",
                  color: "var(--text-secondary)", lineHeight: 1.55,
                  borderLeft: `2px solid ${park ? "var(--orange)" : "var(--accent-dim)"}`, paddingLeft: 8,
                }}>
                  {park && (
                    <b style={{ color: "var(--orange)", display: "block", marginBottom: 2 }}>
                      Locate this one before replying
                    </b>
                  )}
                  {park ? parkReason(it) : it.personalization}
                </div>
              )}

              {writable ? (
                <textarea
                  value={edits[it.id] ?? it.body ?? ""}
                  onChange={(e) => setEdits((m) => ({ ...m, [it.id]: e.target.value }))}
                  style={{
                    width: "100%", minHeight: 120, resize: "vertical", borderRadius: 8, padding: 10,
                    fontSize: 12.5, lineHeight: 1.5, fontFamily: "inherit",
                    background: "var(--bg-secondary)", color: "var(--text-primary)",
                    border: "1px solid var(--border)", boxSizing: "border-box",
                  }}
                />
              ) : (
                <p style={{ margin: 0, fontSize: 11.5, color: "var(--text-muted)", lineHeight: 1.55 }}>
                  No message was ever drafted for this row, the pipeline stopped at{" "}
                  <b style={{ color: "var(--text-secondary)" }}>{it.status}</b>, so there is nothing to edit.
                  Open the source to judge it yourself.
                </p>
              )}

              <div style={{ display: "flex", gap: 7, flexWrap: "wrap", alignItems: "center" }}>
                {(it.recipient_url || it.evidence_url) && (
                  <a href={it.evidence_url || it.recipient_url || "#"} target="_blank" rel="noopener"
                    style={{ fontSize: 11.5, color: "var(--accent)", textDecoration: "none" }}>
                    {park ? "open the post to find the city ↗" : "open ↗"}
                  </a>
                )}
                {writable && (
                  <button onClick={() => copy(it)} style={btn}>{copied === it.id ? "copied" : "copy"}</button>
                )}
                <span style={{ flex: 1 }} />
                <button onClick={() => act(it, "approve")} style={{ ...btn, borderColor: "var(--green)", color: "var(--green)" }}>approve</button>
                {writable && (
                  <button onClick={() => act(it, "sent")} style={{ ...btn, borderColor: "var(--accent)", color: "var(--accent)" }}>mark sent</button>
                )}
                <button onClick={() => act(it, "skip")} style={btn}>
                  {park ? "not our area, skip" : "skip"}
                </button>
              </div>
              {actErr[it.id] && (
                <p role="alert" style={{ color: "var(--red)", fontSize: 12, margin: "6px 0 0" }}>
                  {actErr[it.id]}. Nothing changed, the row is still here.
                </p>
              )}
              {openId === it.id && (
                <CrmRowDetail it={it as DetailItem} onClose={() => setOpenId(null)} />
              )}
            </article>
          );})}

          {/* Delivery work: what Wing actually published for this client. */}
          {client && data.content && (
            <CrmContentFeed feed={data.content} client={client} />
          )}
        </div>
      </div>
    </div>
  );
}

const btn: React.CSSProperties = {
  fontSize: 11.5, padding: "4px 11px", borderRadius: 8, cursor: "pointer",
  border: "1px solid var(--border)", background: "transparent", color: "var(--text-primary)",
};

// ── Needs you ──────────────────────────────────────────────────────────────
// The one panel that answers "what needs a decision from me?". Every row is a
// real queue with a real count and a button that takes you to it. When there is
// nothing, it says what it checked — an all-clear you can trust is different
// from a panel that simply had no data.
export function NeedsYou({ name, drafts, approved, parked, watch, scrapingOff, breakdown, focus, setFocus }: {
  name: string; drafts: number; approved: number; parked: number;
  watch: Watch | undefined; scrapingOff: boolean; breakdown: StatusBreakdown;
  focus: null | "draft" | "approved" | "parked";
  setFocus: (f: null | "draft" | "approved" | "parked") => void;
}) {
  type Row = {
    id: string; n: number | null; color: string; mark: string;
    title: string; why: string; go?: "draft" | "approved" | "parked";
  };
  const rows: Row[] = [];

  if (drafts > 0) rows.push({
    id: "draft", n: drafts, color: "var(--accent)", mark: "✎", go: "draft",
    title: `${drafts} draft${drafts === 1 ? "" : "s"} waiting for your approval`,
    why: "Written and ready. Nothing moves until you approve or skip each one.",
  });
  if (approved > 0) rows.push({
    id: "approved", n: approved, color: "var(--green)", mark: "✓", go: "approved",
    title: `${approved} approved but not marked sent`,
    why: "You said yes to these. Nothing in this OS transmits, so they sit here until you send them and mark them sent.",
  });
  if (parked > 0) rows.push({
    id: "parked", n: parked, color: "var(--orange)", mark: "⚑", go: "parked",
    title: `${parked} parked, a human has to locate ${parked === 1 ? "it" : "them"}`,
    why: "Real demand, but the scraper could not resolve a city from the post, so it refused to guess. " +
         "Open each one, decide whether it is in the service area, then reply or skip.",
  });

  // A scraper that cannot work is itself a decision waiting on Jack — unless it
  // was switched off on purpose, which is not a problem to be solved.
  if (watch && !scrapingOff) {
    const look = healthLook(watch, null);
    if (look.severity === "bad" || look.severity === "warn") rows.push({
      id: "scraper", n: null, color: look.color, mark: look.mark,
      title: `Scraper: ${look.label.toLowerCase()}`,
      why: watch.detail,
    });
  }
  // The run log and the outbound table disagreeing is a silent failure.
  const kept = watch?.run?.kept ?? 0;
  if (!scrapingOff && kept > 0 && drafts === 0) rows.push({
    id: "mismatch", n: null, color: "var(--orange)", mark: "≠",
    title: "The last run says it kept drafts that do not exist",
    why: `The run log records ${kept} kept as drafts, but there are 0 draft rows for ${name}. ` +
         `Something wrote them somewhere else, or never wrote them.`,
  });

  const clear = rows.length === 0;
  return (
    <section
      aria-label={`Needs you: ${clear ? "nothing" : `${rows.length} item${rows.length === 1 ? "" : "s"}`}`}
      style={{
        border: `1px solid ${clear ? "var(--border)" : "var(--accent)"}`,
        borderLeft: `4px solid ${clear ? "var(--border)" : "var(--accent)"}`,
        borderRadius: 14, padding: "13px 16px",
        background: clear ? "var(--bg-card)" : "var(--accent-glow)",
        display: "flex", flexDirection: "column", gap: 9,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span style={{
          fontSize: 10.5, textTransform: "uppercase", letterSpacing: ".1em",
          fontWeight: 700, color: clear ? "var(--text-muted)" : "var(--accent)",
        }}>Needs you</span>
        <span style={{ fontSize: 11.5, color: "var(--text-secondary)" }}>
          {clear ? `nothing is waiting on you for ${name}` : `${rows.length} thing${rows.length === 1 ? "" : "s"} want a decision`}
        </span>
      </div>

      {clear ? (
        <p style={{ margin: 0, fontSize: 12, lineHeight: 1.6, color: "var(--text-secondary)" }}>
          Checked: drafts awaiting approval ({breakdown.draft}), approved-but-unsent ({breakdown.approved}),
          leads parked for a location call ({breakdown.parked ?? "not counted, row list capped"}),
          and scraper health
          {scrapingOff ? " (off by choice, so not flagged)"
            : watch ? ` (${healthLook(watch, null).label.toLowerCase()})`
            : " (no watch data returned for this client)"}.
          All clear.
        </p>
      ) : (
        <ol style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 7 }}>
          {rows.map((r) => (
            <li key={r.id} style={{
              display: "flex", gap: 11, alignItems: "flex-start",
              border: "1px solid var(--border)", borderLeft: `3px solid ${r.color}`,
              borderRadius: 10, padding: "9px 12px", background: "var(--bg-card)",
            }}>
              <span aria-hidden style={{ color: r.color, fontSize: 15, lineHeight: 1.3 }}>{r.mark}</span>
              <div style={{ flex: 1, minWidth: 180 }}>
                <div style={{ fontSize: 13, fontWeight: 650, color: "var(--text-primary)" }}>{r.title}</div>
                <p style={{ margin: "3px 0 0", fontSize: 11.5, lineHeight: 1.55, color: "var(--text-secondary)" }}>
                  {r.why}
                </p>
              </div>
              {r.go && (
                <button
                  onClick={() => setFocus(focus === r.go ? null : r.go!)}
                  style={{
                    fontSize: 11.5, padding: "4px 12px", borderRadius: 8, cursor: "pointer",
                    fontWeight: 650, whiteSpace: "nowrap",
                    border: `1px solid ${r.color}`, color: focus === r.go ? "var(--bg-card)" : r.color,
                    background: focus === r.go ? r.color : "transparent",
                  }}
                >{focus === r.go ? "showing ✓" : "show me"}</button>
              )}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

// ── Timeline ───────────────────────────────────────────────────────────────
// What actually happened for this client, newest first. Every entry comes from
// a row that recorded its own timestamp. Where a source cannot tell us
// something — when a status changed, what earlier runs did — the panel says so
// instead of leaving a gap that reads as "nothing happened".
const EVENT_CAP = 30;

export function Timeline({ name, events, rows, truncated, content, watch, scrapingOff, showAll, setShowAll }: {
  name: string; events: Ev[]; rows: number; truncated: boolean;
  content: ContentFeed | undefined; watch: Watch | undefined; scrapingOff: boolean;
  showAll: boolean; setShowAll: (v: boolean) => void;
}) {
  const shown = showAll ? events : events.slice(0, EVENT_CAP);

  // Everything this history cannot see, stated plainly.
  const gaps: string[] = [];
  gaps.push(
    "Status changes are not timestamped here: the API returns a row's current status but not when " +
    "it was approved, skipped or sent, so each entry is dated when the row was created and shows " +
    "where it stands now."
  );
  if (watch?.run) {
    gaps.push(
      "Only the most recent scraper run is available, the API returns one run per client, so " +
      "earlier runs are not in this history."
    );
  } else if (watch && !scrapingOff) {
    gaps.push(watch.runsReason ?? "No scraper run has been logged for this client, so no run appears below.");
  }
  if (!content?.available) {
    gaps.push(content?.reason ?? "No publishing record was available for this client.");
  }
  if (truncated) {
    gaps.push(
      `Only the newest ${ROW_CAP} rows are returned per client, and that cap was hit, this history ` +
      `does not reach all the way back.`
    );
  }

  return (
    <section style={{
      border: "1px solid var(--border)", borderRadius: 14, padding: "13px 16px",
      background: "var(--bg-card)", display: "flex", flexDirection: "column", gap: 10,
    }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
        <span style={{
          fontSize: 10.5, textTransform: "uppercase", letterSpacing: ".1em",
          fontWeight: 700, color: "var(--accent)",
        }}>Activity</span>
        <span style={{ fontSize: 11.5, color: "var(--text-secondary)" }}>
          what actually happened for {name}, newest first
        </span>
        <span style={{ flex: 1 }} />
        {events.length > EVENT_CAP && (
          <button onClick={() => setShowAll(!showAll)} style={{
            fontSize: 11.5, padding: "3px 11px", borderRadius: 8, cursor: "pointer",
            border: "1px solid var(--border)", background: "transparent", color: "var(--accent)",
          }}>{showAll ? `show newest ${EVENT_CAP}` : `show all ${events.length}`}</button>
        )}
      </div>

      {events.length === 0 ? (
        <div style={{ border: "1px dashed var(--border)", borderRadius: 10, padding: "12px 14px" }}>
          <div style={{ fontSize: 12.5, fontWeight: 600, color: scrapingOff ? "var(--text-secondary)" : "var(--orange)" }}>
            Nothing has ever been recorded for {name}
          </div>
          <p style={{ margin: "5px 0 0", fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.55 }}>
            {scrapingOff
              ? `Not a single outbound row, and no publishing record. That is the expected history for a ` +
                `client whose scraping is deliberately off, this timeline is empty because there is ` +
                `genuinely nothing to show, not because a source failed.`
              : `No outbound row, no logged run and no publishing record carries a timestamp for this ` +
                `client. That is an absence of data, not a quiet period, check the sources named below.`}
          </p>
        </div>
      ) : (
        <ol style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column" }}>
          {shown.map((e, i) => (
            <li key={e.key} style={{
              display: "flex", gap: 11, alignItems: "flex-start", padding: "8px 0",
              borderTop: i === 0 ? "none" : "1px solid var(--border)",
            }}>
              <span aria-hidden style={{ color: e.color, fontSize: 13, lineHeight: 1.5, width: 14, textAlign: "center" }}>
                {e.mark}
              </span>
              <span
                title={e.when}
                style={{
                  fontSize: 11, color: "var(--text-muted)", minWidth: 108,
                  fontVariantNumeric: "tabular-nums", lineHeight: 1.5,
                }}
              >
                {e.exact ? ago(e.when) : e.when}
                {!e.exact && (
                  <span style={{ display: "block", fontSize: 9.5 }} title="This source records a date but no clock time.">
                    date only
                  </span>
                )}
              </span>
              <div style={{ flex: 1, minWidth: 200 }}>
                <div style={{ display: "flex", gap: 7, alignItems: "baseline", flexWrap: "wrap" }}>
                  <span style={{
                    fontSize: 9.5, textTransform: "uppercase", letterSpacing: ".07em",
                    fontWeight: 700, color: e.color,
                  }}>{e.kind}</span>
                  <span style={{ fontSize: 12.5, color: "var(--text-primary)", flex: 1, minWidth: 160 }}>
                    {e.title}
                  </span>
                  {e.url && (
                    <a href={e.url} target="_blank" rel="noopener"
                      style={{ fontSize: 11, color: "var(--accent)", textDecoration: "none" }}>open ↗</a>
                  )}
                </div>
                {e.detail && (
                  <p style={{
                    margin: "2px 0 0", fontSize: 11.5, lineHeight: 1.5, color: "var(--text-secondary)",
                    overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical",
                  }}>{e.detail}</p>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}

      <details style={{ fontSize: 11, color: "var(--text-muted)" }}>
        <summary style={{ cursor: "pointer" }}>
          What this history cannot see ({gaps.length})
        </summary>
        <ul style={{ margin: "6px 0 0", paddingLeft: 18, display: "flex", flexDirection: "column", gap: 4 }}>
          {gaps.map((g, i) => (
            <li key={i} style={{ lineHeight: 1.55, color: "var(--text-secondary)" }}>{g}</li>
          ))}
        </ul>
      </details>

      <div style={{ fontSize: 10.5, color: "var(--text-muted)" }}>
        Built from {rows} outbound row{rows === 1 ? "" : "s"}
        {watch?.run ? ", 1 scraper run" : ""}
        {content?.available ? `, ${content.items.filter((c) => c.status === "published").length} published item(s)` : ""}
        {" "}and no entry here is synthetic.
      </div>
    </section>
  );
}
