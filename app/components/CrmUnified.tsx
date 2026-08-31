"use client";
import { useMemo, useState } from "react";

// ── Unified pipeline ───────────────────────────────────────────────────────
// One view over BOTH sides of the business: the outbound Cold Call Room and
// the inbound CRM. They live in two unrelated tables with no key joining them,
// so this view deliberately keeps them side by side with their OWN real stages
// rather than inventing a shared funnel. Every number here is read straight
// off /api/crm's `unified` key — nothing is derived, estimated or projected.

export type UnifiedOutboundRow = {
  id: string; company: string | null; person: string | null; title: string | null;
  where: string | null; vertical: string | null; score: number | null;
  callCount: number | null; lastCalledAt: string | null; nextActionAt: string | null;
};
export type UnifiedOutboundStage = {
  key: string; label: string; note: string | null; leads: number;
  rows: UnifiedOutboundRow[]; truncated: boolean;
};
export type UnifiedInboundRow = {
  id: number; title: string | null; valueCents: number | null; business: string | null;
  person: string | null; where: string | null; expectedClose: string | null;
  updatedAt: string | null;
};
export type UnifiedInboundStage = {
  key: string; label: string; sort: number; isWon: boolean; isLost: boolean;
  deals: number; unquoted: number; valueCents: number | null;
  rows: UnifiedInboundRow[]; truncated: boolean;
};
export type StreamEntry = {
  key: string; side: "inbound" | "outbound"; at: string; kind: string;
  who: string | null; subject: string | null; detail: string | null;
  durationSec: number | null; nextActionAt: string | null;
};
export type Unified = {
  available: boolean;
  reason: string | null;
  summary: {
    inboundContacts: number | null; outboundLeads: number | null;
    total: number | null; note: string;
  };
  inbound: {
    available: boolean; reason: string | null;
    contacts: number | null; contactsReason: string | null;
    doNotContact: number | null; deals: number | null; dealsTotal: number | null;
    stages: UnifiedInboundStage[]; activityCount: number | null;
  };
  outbound: {
    available: boolean; reason: string | null;
    total: number | null; read: number | null; truncated: boolean;
    dialable: number | null; rejected: number | null; sources: string[];
    stages: UnifiedOutboundStage[];
    terminal: { key: string; label: string; leads: number }[];
    excludedReasons: { reason: string; n: number }[];
    activityCount: number | null; activityReason: string | null;
  };
  stream: {
    entries: StreamEntry[]; inboundCount: number; outboundCount: number;
    gaps: string[]; cap: number;
  };
};

type Side = "all" | "inbound" | "outbound";

const ACCENT = "linear-gradient(135deg,#22d3ee,#0e7490)";
const num = (n: number | null | undefined) =>
  n == null ? "not counted" : n.toLocaleString();

const card: React.CSSProperties = {
  border: "1px solid var(--border)", borderRadius: 14,
  background: "var(--bg-card)", padding: "14px 16px",
};
const eyebrow: React.CSSProperties = {
  fontSize: 10.5, textTransform: "uppercase", letterSpacing: ".1em", fontWeight: 700,
};
const note: React.CSSProperties = {
  margin: 0, fontSize: 11.5, lineHeight: 1.55, color: "var(--text-secondary)",
};

function Empty({ title, lines }: { title: string; lines: string[] }) {
  return (
    <div style={{ border: "1px dashed var(--border)", borderRadius: 12, padding: "13px 15px" }}>
      <div style={{ fontSize: 12.5, fontWeight: 650, color: "var(--text-secondary)" }}>{title}</div>
      <ul style={{ margin: "6px 0 0", paddingLeft: 17, display: "flex", flexDirection: "column", gap: 5 }}>
        {lines.map((l, i) => (
          <li key={i} style={{ fontSize: 11.5, lineHeight: 1.55, color: "var(--text-secondary)" }}>{l}</li>
        ))}
      </ul>
    </div>
  );
}

/** A stage row: label, count, and a proportion bar against the busiest stage. */
function StageBar({ label, sub, n, max, tint }: {
  label: string; sub: string | null; n: number; max: number; tint: string;
}) {
  const pct = max > 0 ? Math.round((n / max) * 100) : 0;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
        <span style={{ fontSize: 12.5, fontWeight: 600, color: n > 0 ? "var(--text-primary)" : "var(--text-muted)", flex: 1 }}>
          {label}
        </span>
        <span style={{
          fontSize: 14, fontWeight: 700, fontVariantNumeric: "tabular-nums",
          color: n > 0 ? "var(--text-primary)" : "var(--text-muted)",
        }}>{n}</span>
      </div>
      <div style={{ height: 4, borderRadius: 4, background: "var(--bg-hover)", overflow: "hidden" }}>
        <div style={{ height: "100%", width: `${pct}%`, background: n > 0 ? tint : "transparent" }} />
      </div>
      {sub && (
        <p style={{ margin: 0, fontSize: 11, lineHeight: 1.5, color: "var(--text-muted)" }}>{sub}</p>
      )}
    </div>
  );
}

export default function CrmUnified({ unified }: { unified: Unified | undefined }) {
  const [side, setSide] = useState<Side>("all");
  const [showRejects, setShowRejects] = useState(false);

  if (!unified) {
    return (
      <section style={card}>
        <span style={{ ...eyebrow, color: "var(--text-muted)" }}>Everything in play</span>
        <p style={{ ...note, marginTop: 6 }}>
          This build of <code>/api/crm</code> returned no <code>unified</code> key, so the combined
          inbound + outbound view has nothing to read. Nothing is being hidden — the data simply is
          not in the response.
        </p>
      </section>
    );
  }
  if (!unified.available) {
    return (
      <section style={{ ...card, borderColor: "var(--orange)" }}>
        <span style={{ ...eyebrow, color: "var(--orange)" }}>Everything in play — unavailable</span>
        <p style={{ ...note, marginTop: 6 }}>
          {unified.reason ?? "The API reported the unified view as unavailable but gave no reason."}
        </p>
      </section>
    );
  }

  const { summary, inbound, outbound, stream } = unified;
  const showIn = side !== "outbound";
  const showOut = side !== "inbound";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <Header summary={summary} side={side} setSide={setSide} />

      <div style={{
        display: "grid", gap: 14,
        gridTemplateColumns: showIn && showOut ? "repeat(auto-fit,minmax(320px,1fr))" : "1fr",
        alignItems: "start",
      }}>
        {showOut && <OutboundColumn o={outbound} showRejects={showRejects} setShowRejects={setShowRejects} />}
        {showIn && <InboundColumn i={inbound} />}
      </div>

      <Stream stream={stream} side={side} />
    </div>
  );
}

function Header({ summary, side, setSide }: {
  summary: Unified["summary"]; side: Side; setSide: (s: Side) => void;
}) {
  const tabs: { id: Side; label: string }[] = [
    { id: "all", label: "Everything" },
    { id: "outbound", label: "Outbound only" },
    { id: "inbound", label: "Inbound only" },
  ];
  return (
    <section style={{ ...card, padding: "16px 18px", display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 20, flexWrap: "wrap" }}>
        <div style={{ minWidth: 190 }}>
          <span style={{ ...eyebrow, color: "var(--accent)" }}>Everything in play</span>
          <div style={{
            fontSize: 40, fontWeight: 750, lineHeight: 1.05, marginTop: 6,
            fontVariantNumeric: "tabular-nums", letterSpacing: "-0.02em",
            background: ACCENT, WebkitBackgroundClip: "text", backgroundClip: "text",
            WebkitTextFillColor: "transparent", color: "var(--text-primary)",
          }}>{num(summary.total)}</div>
          <div style={{ fontSize: 11.5, color: "var(--text-secondary)", marginTop: 2 }}>
            businesses across both pipelines
          </div>
        </div>

        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", flex: 1, minWidth: 260 }}>
          {([["Outbound leads", summary.outboundLeads, "the Cold Call Room"],
             ["Inbound contacts", summary.inboundContacts, "the existing CRM"]] as
            [string, number | null, string][]).map(([label, val, sub]) => (
            <div key={label} style={{
              border: "1px solid var(--border)", borderRadius: 12, padding: "10px 14px",
              background: "var(--bg-hover)", minWidth: 150, flex: 1,
            }}>
              <div style={{ fontSize: 24, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{num(val)}</div>
              <div style={{ fontSize: 11.5, color: "var(--text-secondary)", marginTop: 2 }}>{label}</div>
              <div style={{ fontSize: 10.5, color: "var(--text-muted)", marginTop: 1 }}>from {sub}</div>
            </div>
          ))}
        </div>

        <div style={{ display: "flex", gap: 7, flexWrap: "wrap", alignSelf: "flex-start" }}>
          {tabs.map((t) => {
            const on = side === t.id;
            return (
              <button key={t.id} onClick={() => setSide(t.id)} style={{
                fontSize: 12, padding: "5px 13px", borderRadius: 20, cursor: "pointer",
                fontWeight: on ? 650 : 500,
                border: `1px solid ${on ? "var(--accent)" : "var(--border)"}`,
                background: on ? "var(--accent-glow)" : "transparent",
                color: on ? "var(--accent)" : "var(--text-secondary)",
              }}>{t.label}</button>
            );
          })}
        </div>
      </div>

      <p style={{
        margin: 0, fontSize: 11.5, lineHeight: 1.6, color: "var(--text-secondary)",
        borderLeft: "2px solid var(--accent-dim)", paddingLeft: 10,
      }}>{summary.note}</p>
    </section>
  );
}

function OutboundColumn({ o, showRejects, setShowRejects }: {
  o: Unified["outbound"]; showRejects: boolean; setShowRejects: (v: boolean) => void;
}) {
  const max = useMemo(() => Math.max(1, ...o.stages.map((s) => s.leads)), [o.stages]);
  const previewStage = useMemo(
    () => o.stages.find((s) => s.rows.length > 0) ?? null, [o.stages]);

  if (!o.available) {
    return (
      <section style={{ ...card, borderColor: "var(--orange)" }}>
        <span style={{ ...eyebrow, color: "var(--orange)" }}>Outbound — unavailable</span>
        <p style={{ ...note, marginTop: 6 }}>
          {o.reason ?? "The outbound side reported unavailable with no reason given."}
        </p>
      </section>
    );
  }

  return (
    <section style={{ ...card, display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 9, flexWrap: "wrap" }}>
        <span style={{ ...eyebrow, color: "var(--accent)" }}>Outbound</span>
        <span style={{ fontSize: 11.5, color: "var(--text-secondary)" }}>
          cold call room · {num(o.total)} leads imported
          {o.sources.length ? ` · ${o.sources.join(", ")}` : ""}
        </span>
      </div>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <Pill n={o.dialable} label="dialable" tint="var(--green)" />
        <Pill n={o.rejected} label="rejected by the quality audit" tint="var(--text-muted)" />
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 11 }}>
        {o.stages.map((s) => (
          <StageBar key={s.key} label={s.label} sub={s.note} n={s.leads} max={max} tint="#22d3ee" />
        ))}
      </div>

      {o.terminal.length > 0 && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", borderTop: "1px solid var(--border)", paddingTop: 10 }}>
          {o.terminal.map((t) => (
            <span key={t.key} style={{
              fontSize: 11, color: t.leads > 0 ? "var(--text-primary)" : "var(--text-muted)",
              border: "1px solid var(--border)", borderRadius: 20, padding: "3px 10px",
            }}>
              {t.label} <b style={{ fontVariantNumeric: "tabular-nums" }}>{t.leads}</b>
            </span>
          ))}
        </div>
      )}

      {previewStage && (
        <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
          <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
            {previewStage.label} — showing {previewStage.rows.length} of {previewStage.leads}
            {previewStage.truncated ? ", the API caps this list" : ""}
          </div>
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column" }}>
            {previewStage.rows.slice(0, 6).map((r, i) => (
              <li key={r.id} style={{
                display: "flex", gap: 10, alignItems: "baseline", padding: "7px 0",
                borderTop: i === 0 ? "none" : "1px solid var(--border)",
              }}>
                <div style={{ flex: 1, minWidth: 150 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 600 }}>{r.company ?? "(no company recorded)"}</div>
                  <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
                    {[r.person, r.title, r.where].filter(Boolean).join(" · ") || "no contact detail recorded"}
                  </div>
                </div>
                <span style={{ fontSize: 11, color: "var(--text-muted)", fontVariantNumeric: "tabular-nums" }}>
                  {r.score == null ? "unscored" : `score ${r.score}`}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {(o.rejected ?? 0) > 0 && o.excludedReasons.length > 0 && (
        <div style={{ borderTop: "1px solid var(--border)", paddingTop: 10 }}>
          <button onClick={() => setShowRejects(!showRejects)} style={{
            fontSize: 11.5, padding: "4px 12px", borderRadius: 8, cursor: "pointer",
            border: "1px solid var(--border)", background: "transparent", color: "var(--accent)",
          }}>
            {showRejects ? "hide" : `why ${o.rejected} are not being called`}
          </button>
          {showRejects && (
            <ul style={{ listStyle: "none", margin: "9px 0 0", padding: 0, display: "flex", flexDirection: "column", gap: 5 }}>
              {o.excludedReasons.map((e) => (
                <li key={e.reason} style={{ display: "flex", gap: 9, alignItems: "baseline" }}>
                  <span style={{
                    fontSize: 11, fontWeight: 700, minWidth: 22, textAlign: "right",
                    color: "var(--text-primary)", fontVariantNumeric: "tabular-nums",
                  }}>{e.n}</span>
                  <span style={{ fontSize: 11.5, lineHeight: 1.5, color: "var(--text-secondary)" }}>{e.reason}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

function InboundColumn({ i }: { i: Unified["inbound"] }) {
  const max = useMemo(() => Math.max(1, ...i.stages.map((s) => s.deals)), [i.stages]);
  const withRows = useMemo(() => i.stages.filter((s) => s.rows.length > 0), [i.stages]);

  if (!i.available) {
    return (
      <section style={{ ...card, borderColor: "var(--orange)" }}>
        <span style={{ ...eyebrow, color: "var(--orange)" }}>Inbound — unavailable</span>
        <p style={{ ...note, marginTop: 6 }}>
          {i.reason ?? "The inbound side reported unavailable with no reason given."}
        </p>
      </section>
    );
  }

  return (
    <section style={{ ...card, display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 9, flexWrap: "wrap" }}>
        <span style={{ ...eyebrow, color: "var(--accent)" }}>Inbound</span>
        <span style={{ fontSize: 11.5, color: "var(--text-secondary)" }}>
          the existing CRM · {num(i.contacts)} contacts
          {i.contactsReason ? ` · ${i.contactsReason}` : ""}
        </span>
      </div>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <Pill n={i.dealsTotal ?? i.deals} label="open deals" tint="var(--green)" />
        <Pill n={i.doNotContact} label="marked do-not-contact" tint="var(--text-muted)" />
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 11 }}>
        {i.stages.map((s) => (
          <StageBar
            key={s.key}
            label={s.label}
            sub={s.deals > 0 && s.unquoted === s.deals
              ? `${s.deals} deal${s.deals === 1 ? "" : "s"}, none of them carry a value`
              : null}
            n={s.deals} max={max}
            tint={s.isWon ? "var(--green)" : s.isLost ? "var(--text-muted)" : "#0e7490"}
          />
        ))}
        {i.stages.length === 0 && (
          <Empty title="No inbound stages returned"
                 lines={["The crm_stages table returned no rows, so this pipeline has no shape to draw."]} />
        )}
      </div>

      {withRows.map((s) => (
        <div key={s.key} style={{ display: "flex", flexDirection: "column", gap: 7 }}>
          <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
            {s.label} — showing {s.rows.length} of {s.deals}
            {s.truncated ? ", the API caps this list" : ""}
          </div>
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column" }}>
            {s.rows.slice(0, 6).map((r, idx) => (
              <li key={r.id} style={{
                display: "flex", gap: 10, alignItems: "baseline", padding: "7px 0",
                borderTop: idx === 0 ? "none" : "1px solid var(--border)",
              }}>
                <div style={{ flex: 1, minWidth: 150 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 600 }}>{r.title ?? r.business ?? "(untitled deal)"}</div>
                  <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
                    {[r.person, r.where].filter(Boolean).join(" · ") || "no contact detail recorded"}
                  </div>
                </div>
                <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                  {r.valueCents == null ? "no value set" : `$${(r.valueCents / 100).toLocaleString()}`}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ))}

      {i.contacts != null && (i.dealsTotal ?? 0) === 0 && (
        <p style={note}>
          {num(i.contacts)} contacts exist but no deal has been opened against any of them, so the
          pipeline above is empty by fact, not by filter.
        </p>
      )}
    </section>
  );
}

function Pill({ n, label, tint }: { n: number | null; label: string; tint: string }) {
  return (
    <div style={{
      border: "1px solid var(--border)", borderRadius: 12, padding: "8px 13px",
      background: "var(--bg-hover)", minWidth: 108,
    }}>
      <div style={{ fontSize: 19, fontWeight: 700, color: tint, fontVariantNumeric: "tabular-nums" }}>{num(n)}</div>
      <div style={{ fontSize: 10.5, color: "var(--text-secondary)", lineHeight: 1.4 }}>{label}</div>
    </div>
  );
}

function Stream({ stream, side }: { stream: Unified["stream"]; side: Side }) {
  const entries = useMemo(
    () => (side === "all" ? stream.entries : stream.entries.filter((e) => e.side === side)),
    [stream.entries, side]
  );
  const shown = entries.slice(0, stream.cap);

  return (
    <section style={{ ...card, display: "flex", flexDirection: "column", gap: 11 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
        <span style={{ ...eyebrow, color: "var(--accent)" }}>Combined activity</span>
        <span style={{ fontSize: 11.5, color: "var(--text-secondary)" }}>
          both sides, newest first · {stream.outboundCount} outbound, {stream.inboundCount} inbound logged
        </span>
      </div>

      {shown.length === 0 ? (
        <Empty
          title={
            side === "outbound" ? "No outbound call has been logged yet"
            : side === "inbound" ? "No inbound activity has been logged yet"
            : "No calls or contact activity have been logged yet on either side"
          }
          lines={stream.gaps.length ? stream.gaps : [
            "Both activity tables returned zero rows and the API gave no further explanation.",
          ]}
        />
      ) : (
        <ol style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column" }}>
          {shown.map((e, i) => (
            <li key={e.key} style={{
              display: "flex", gap: 11, alignItems: "flex-start", padding: "9px 0",
              borderTop: i === 0 ? "none" : "1px solid var(--border)",
            }}>
              <span style={{
                fontSize: 9.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".07em",
                padding: "2px 8px", borderRadius: 20, whiteSpace: "nowrap",
                border: `1px solid ${e.side === "outbound" ? "var(--accent)" : "var(--border)"}`,
                color: e.side === "outbound" ? "var(--accent)" : "var(--text-secondary)",
              }}>{e.side}</span>
              <span title={e.at} style={{
                fontSize: 11, color: "var(--text-muted)", minWidth: 120,
                fontVariantNumeric: "tabular-nums", lineHeight: 1.5,
              }}>{e.at}</span>
              <div style={{ flex: 1, minWidth: 180 }}>
                <div style={{ fontSize: 12.5, color: "var(--text-primary)" }}>
                  {e.subject ?? "(no subject recorded)"}
                  <span style={{ color: "var(--text-muted)" }}> — {e.kind}</span>
                </div>
                {e.detail && (
                  <p style={{ margin: "2px 0 0", fontSize: 11.5, lineHeight: 1.5, color: "var(--text-secondary)" }}>
                    {e.detail}
                  </p>
                )}
                <div style={{ fontSize: 10.5, color: "var(--text-muted)", marginTop: 2 }}>
                  {e.who ?? "logged by nobody recorded"}
                  {e.durationSec != null ? ` · ${e.durationSec}s` : ""}
                  {e.nextActionAt ? ` · next action ${e.nextActionAt}` : ""}
                </div>
              </div>
            </li>
          ))}
        </ol>
      )}

      {shown.length > 0 && stream.gaps.length > 0 && (
        <details style={{ fontSize: 11, color: "var(--text-muted)" }}>
          <summary style={{ cursor: "pointer" }}>What this stream cannot see ({stream.gaps.length})</summary>
          <ul style={{ margin: "6px 0 0", paddingLeft: 18, display: "flex", flexDirection: "column", gap: 4 }}>
            {stream.gaps.map((g, i) => (
              <li key={i} style={{ lineHeight: 1.55, color: "var(--text-secondary)" }}>{g}</li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
