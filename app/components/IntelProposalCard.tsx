"use client";

// ───────────────────────────────────────────────────────────────────────────
// One proposed improvement to Wing's own systems, derived from one watched
// video. The point of this card is trust: the verbatim quote that justified
// the suggestion is shown as a real quote, with its timestamp and a link that
// opens the video at (or near) that moment, so a human can check the claim in
// seconds instead of taking the machine's word for it.
//
// Approving does NOT apply anything. It only records the human decision and
// moves the card into the "approved — waiting on you" queue. There is no
// auto-apply anywhere in this UI.
// ───────────────────────────────────────────────────────────────────────────

export type Proposal = {
  id: number;
  intel_item_id: number | null;
  source_handle: string | null;
  video_title: string | null;
  video_url: string | null;
  title: string;
  rationale: string | null;
  evidence_quote: string | null;
  evidence_ts: string | null;
  target_system: string | null;
  target_paths: string[] | string | null;
  effort: string | null;
  risk: string | null;
  status: string;
  decided_at: string | null;
  applied_at: string | null;
  outcome: string | null;
  created_at: string | null;
};

export const PROPOSAL_STATUSES = ["proposed", "approved", "rejected", "applied", "failed"] as const;

export const PROPOSAL_STATUS_COLOR: Record<string, string> = {
  proposed: "var(--accent)",
  approved: "var(--green)",
  rejected: "var(--text-muted)",
  applied: "var(--accent-2)",
  failed: "var(--red)",
};

const RISK_COLOR: Record<string, string> = {
  low: "var(--green)",
  medium: "var(--orange)",
  high: "var(--red)",
};

function pathList(p: string[] | string | null): string[] {
  if (!p) return [];
  if (Array.isArray(p)) return p.filter(Boolean);
  const s = p.trim();
  if (s.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(s);
      if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
    } catch { /* fall through to the plain-string reading below */ }
  }
  return s ? [s] : [];
}

// Turn "12:30" / "1:02:03" / "750" into seconds so the link lands on the claim.
function tsSeconds(ts: string | null): number | null {
  if (!ts) return null;
  const t = ts.trim();
  if (/^\d+$/.test(t)) return Number(t);
  const parts = t.split(":").map((x) => Number(x));
  if (parts.some((n) => Number.isNaN(n))) return null;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

function watchUrl(url: string | null, ts: string | null): string | null {
  if (!url) return null;
  const secs = tsSeconds(ts);
  if (secs === null) return url;
  try {
    const u = new URL(url);
    if (/youtu/.test(u.hostname)) {
      u.searchParams.set("t", `${secs}s`);
      return u.toString();
    }
    return url;
  } catch {
    return url;
  }
}

function stamp(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, {
    month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit",
  });
}

const card: React.CSSProperties = {
  background: "var(--bg-card)",
  border: "1px solid var(--border)",
  borderRadius: 12,
  padding: 18,
};

const btn: React.CSSProperties = {
  padding: "8px 16px",
  borderRadius: 8,
  fontSize: 13,
  fontWeight: 700,
  cursor: "pointer",
  background: "transparent",
  border: "1px solid var(--border)",
  color: "var(--text-secondary)",
};

const metaLabel: React.CSSProperties = {
  fontSize: 11.5,
  fontWeight: 700,
  letterSpacing: 0.6,
  textTransform: "uppercase",
  color: "var(--text-muted)",
};

export default function IntelProposalCard({
  p, busy, onDecide,
}: {
  p: Proposal;
  busy: boolean;
  onDecide: (id: number, action: "approve" | "reject" | "undo") => void;
}) {
  const paths = pathList(p.target_paths);
  const link = watchUrl(p.video_url, p.evidence_ts);
  const decided = p.status !== "proposed";

  return (
    <div
      style={{
        ...card,
        borderColor: p.status === "proposed" ? "var(--accent)" : "var(--border)",
        display: "flex",
        flexDirection: "column",
        gap: 14,
      }}
    >
      {/* Header: what is being proposed, and to which system. */}
      <div style={{ display: "flex", gap: 12, alignItems: "flex-start", justifyContent: "space-between", flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 260 }}>
          <span style={metaLabel}>Proposed change</span>
          <h3 style={{ fontSize: 17, fontWeight: 700, color: "var(--text-primary)", lineHeight: 1.3, marginTop: 4 }}>
            {p.title}
          </h3>
        </div>
        <span
          style={{
            fontSize: 11, fontWeight: 700, letterSpacing: 0.6, textTransform: "uppercase",
            color: PROPOSAL_STATUS_COLOR[p.status] ?? "var(--text-muted)",
            border: `1px solid ${PROPOSAL_STATUS_COLOR[p.status] ?? "var(--border)"}`,
            borderRadius: 999, padding: "4px 10px", whiteSpace: "nowrap",
          }}
        >
          {p.status}
        </span>
      </div>

      {/* Which system it touches. */}
      <div style={{ display: "flex", gap: 18, flexWrap: "wrap", alignItems: "baseline" }}>
        <div>
          <span style={metaLabel}>Touches</span>
          <div style={{ fontSize: 13, fontWeight: 600, color: "var(--accent-2)", marginTop: 2 }}>
            {p.target_system || "system not specified"}
          </div>
        </div>
        <div>
          <span style={metaLabel}>Effort</span>
          <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)", marginTop: 2 }}>
            {p.effort || "unrated"}
          </div>
        </div>
        <div>
          <span style={metaLabel}>Risk</span>
          <div style={{
            fontSize: 13, fontWeight: 600, marginTop: 2,
            color: RISK_COLOR[(p.risk || "").toLowerCase()] ?? "var(--text-primary)",
          }}>
            {p.risk || "unrated"}
          </div>
        </div>
      </div>

      {paths.length > 0 && (
        <div>
          <span style={metaLabel}>Files it would touch</span>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 5 }}>
            {paths.map((f) => (
              <code
                key={f}
                style={{
                  fontSize: 12, background: "var(--bg-secondary)", border: "1px solid var(--border)",
                  borderRadius: 6, padding: "3px 8px", color: "var(--text-secondary)",
                }}
              >
                {f}
              </code>
            ))}
          </div>
        </div>
      )}

      {/* Why. */}
      {p.rationale && (
        <div>
          <span style={metaLabel}>Rationale</span>
          <p style={{ fontSize: 14, color: "var(--text-secondary)", lineHeight: 1.55, marginTop: 4, whiteSpace: "pre-wrap" }}>
            {p.rationale}
          </p>
        </div>
      )}

      {/* The trust anchor: the verbatim quote, marked as a quote, with a link. */}
      <div>
        <span style={metaLabel}>Evidence from the video</span>
        {p.evidence_quote ? (
          <blockquote
            style={{
              margin: "6px 0 0",
              background: "var(--bg-secondary)",
              borderLeft: "3px solid var(--accent)",
              borderRadius: "0 10px 10px 0",
              padding: "12px 14px",
            }}
          >
            <p style={{
              fontSize: 14, color: "var(--text-primary)", lineHeight: 1.6,
              fontStyle: "italic", whiteSpace: "pre-wrap",
            }}>
              &ldquo;{p.evidence_quote}&rdquo;
            </p>
            <footer style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 8, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <span>
                {p.video_title || "source video"}
                {p.source_handle ? `, ${p.source_handle}` : ""}
                {p.evidence_ts ? ` @ ${p.evidence_ts}` : ""}
              </span>
              {link && (
                <a
                  href={link}
                  target="_blank"
                  rel="noreferrer"
                  style={{
                    fontSize: 12, fontWeight: 700, color: "var(--accent)", textDecoration: "none",
                    border: "1px solid var(--accent)", borderRadius: 6, padding: "3px 9px",
                  }}
                >
                  {p.evidence_ts ? `Watch at ${p.evidence_ts}` : "Watch the video"}
                </a>
              )}
            </footer>
          </blockquote>
        ) : (
          <p style={{ fontSize: 13, color: "var(--orange)", marginTop: 6 }}>
            No quote was captured for this proposal, so nothing here proves the claim, so treat it
            as unverified{link ? " and check the video yourself." : "."}
            {link && (
              <>
                {" "}
                <a href={link} target="_blank" rel="noreferrer" style={{ color: "var(--accent)", fontWeight: 700 }}>
                  Open the video
                </a>
              </>
            )}
          </p>
        )}
      </div>

      {/* The decision. Approving queues; it never applies. */}
      <div style={{ borderTop: "1px solid var(--border)", paddingTop: 12, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        {!decided ? (
          <>
            <button
              disabled={busy}
              onClick={() => onDecide(p.id, "approve")}
              style={{ ...btn, borderColor: "var(--green)", color: "var(--green)", opacity: busy ? 0.5 : 1 }}
            >
              Approve and queue for me to apply
            </button>
            <button
              disabled={busy}
              onClick={() => onDecide(p.id, "reject")}
              style={{ ...btn, borderColor: "var(--red)", color: "var(--red)", opacity: busy ? 0.5 : 1 }}
            >
              Reject
            </button>
            <span style={{ fontSize: 13, color: "var(--text-muted)" }}>
              Approving records your decision only. Nothing is changed until you apply it yourself.
            </span>
          </>
        ) : (
          <>
            <span style={{ fontSize: 13, color: "var(--text-secondary)" }}>
              {p.status === "approved" && "Approved and queued for you to apply by hand. Not applied."}
              {p.status === "rejected" && "Rejected. Nothing was changed."}
              {p.status === "applied" && `Applied${p.applied_at ? ` on ${stamp(p.applied_at)}` : ""}.`}
              {p.status === "failed" && "An apply attempt failed."}
              {p.decided_at ? ` Decided ${stamp(p.decided_at)}.` : ""}
            </span>
            {(p.status === "approved" || p.status === "rejected") && (
              <button
                disabled={busy}
                onClick={() => onDecide(p.id, "undo")}
                style={{ ...btn, marginLeft: "auto", opacity: busy ? 0.5 : 1 }}
              >
                Undo decision
              </button>
            )}
          </>
        )}
      </div>

      {p.outcome && (
        <p style={{ fontSize: 13, color: "var(--text-secondary)", borderLeft: "2px solid var(--border)", paddingLeft: 10 }}>
          {p.outcome}
        </p>
      )}
    </div>
  );
}
