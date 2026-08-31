"use client";

// Everything the API computes about one outbound row, rendered in full. The
// board's card shows a trimmed view; this panel is where nothing is thrown
// away. Grouped by what Jack actually needs, in order: the message itself,
// the evidence behind it, whether it can be sent, then the mechanical fields
// (ids, channel, raw timestamps) at the bottom so completeness never reads
// as a data dump.

export type TierInfo = { tier: string; label: string; meaning: string; rank: number } | null;

export type Evidence = {
  quote: string | null;
  sourceUrl: string | null;
  sourceKind: "evidence" | "recipient_only" | "none";
  strength: "quoted_with_source" | "quoted_no_source" | "stated_no_quote" | "flagged_unverified" | "none";
  label: string;
  detail: string;
};

export type Review = {
  state: "REVIEWED" | "NEVER_REVIEWED" | "NO_REVIEW_RECORDED";
  at: string | null;
  detail: string;
};

export type DetailItem = {
  id: number; client: string | null; channel: string | null; recipient: string | null;
  recipientHandle?: string | null; recipient_url: string | null;
  subject: string | null; body: string | null; personalization: string | null;
  evidence_url: string | null; status: string | null; tier: string | null;
  created_at: string | null; reviewedAt?: string | null; sentAt?: string | null;
  direction?: string | null;
  sendable: boolean | null; notSendableReason: string | null;
  tierInfo?: TierInfo; evidence?: Evidence; review?: Review; bodyState?: string;
};

const EVIDENCE_COLOR: Record<Evidence["sourceKind"], string> = {
  evidence: "var(--green)",
  recipient_only: "var(--orange)",
  none: "var(--text-muted)",
};

// ── Source links ───────────────────────────────────────────────────────────
// Jack's #1 complaint was that he could not click through to the post a draft
// was built from. The URLs were always in the payload; they were rendered as a
// bare, underline-less "open ↗" wedged into the button row, and were hidden
// entirely when the URL was null. Both are fixed here, in ONE component every
// surface uses, so a link always looks like a link and a missing link always
// says so out loud.

/** Friendly name for the site a URL points at, read from its host only. */
export function platformOf(url: string): { name: string; noun: string } {
  let host = "";
  try { host = new URL(url).hostname.replace(/^www\./, "").toLowerCase(); }
  catch { return { name: "the source page", noun: "page" }; }
  const on = (...parts: string[]) => parts.some((p) => host === p || host.endsWith(`.${p}`));
  if (on("reddit.com", "redd.it")) return { name: "Reddit", noun: "post" };
  if (on("nextdoor.com")) return { name: "Nextdoor", noun: "post" };
  if (on("facebook.com", "fb.com")) return { name: "Facebook", noun: "post" };
  if (on("instagram.com")) return { name: "Instagram", noun: "post" };
  if (on("tiktok.com")) return { name: "TikTok", noun: "video" };
  if (on("twitter.com", "x.com")) return { name: "X", noun: "post" };
  if (on("linkedin.com")) return { name: "LinkedIn", noun: "post" };
  if (on("craigslist.org")) return { name: "Craigslist", noun: "listing" };
  if (on("estatesales.net", "estatesale.com")) return { name: "EstateSales.net", noun: "listing" };
  if (on("yelp.com")) return { name: "Yelp", noun: "page" };
  if (on("youtube.com", "youtu.be")) return { name: "YouTube", noun: "video" };
  if (host.includes("permit")) return { name: "the permit record", noun: "record" };
  return { name: host, noun: "page" };
}

/**
 * What this link IS, which is not cosmetic. "evidence" is the page the claim
 * was actually read from; "recipient" is merely the prospect's own site and
 * proves nothing about the claim. They must never look identical.
 */
export type LinkKind = "evidence" | "recipient" | "matched" | "published";

const LINK_COLOR: Record<LinkKind, string> = {
  evidence: "var(--green)",
  recipient: "var(--orange)",
  matched: "var(--orange)",
  published: "var(--accent)",
};

/** The human sentence naming where the click goes. */
export function linkLabel(url: string, kind: LinkKind): string {
  const p = platformOf(url);
  if (kind === "evidence") return `View the ${p.name} ${p.noun} this was written from`;
  if (kind === "matched") return `View the matched ${p.name} ${p.noun} (not verified evidence)`;
  if (kind === "published") return `View the published ${p.noun}`;
  return p.noun === "page" && !/^[A-Z]/.test(p.name)
    ? "Open their website"
    : `Open their ${p.name} ${p.noun}`;
}

/** A real anchor: underlined, coloured, labelled by destination, new tab. */
export function SourceLink({ url, kind, compact }: { url: string; kind: LinkKind; compact?: boolean }) {
  const color = LINK_COLOR[kind];
  let host = url;
  try { host = new URL(url).hostname.replace(/^www\./, ""); } catch { /* show raw */ }
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      title={url}
      onClick={(e) => e.stopPropagation()}
      style={{
        display: "inline-flex", alignItems: "baseline", gap: 6, maxWidth: "100%",
        fontSize: compact ? 11.5 : 12.5, fontWeight: 600, color,
        textDecoration: "underline", textUnderlineOffset: 3,
        border: `1px solid ${color}`, borderRadius: 8, padding: "3px 9px",
        background: "var(--bg-card)", wordBreak: "break-word",
      }}
    >
      <span>{linkLabel(url, kind)} ↗</span>
      <span style={{ fontSize: 10.5, fontWeight: 500, color: "var(--text-muted)", textDecoration: "none" }}>
        {host}
      </span>
    </a>
  );
}

/**
 * The honest empty state. Never hidden, never faked — a draft with no captured
 * source is exactly the draft Jack most needs to spot, so it gets a louder
 * treatment than a working link, not a quieter one.
 */
export function NoSourceLink({ what, compact }: { what: string; compact?: boolean }) {
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 6,
      fontSize: compact ? 11.5 : 12, fontWeight: 600, color: "var(--red)",
      border: "1px dashed var(--red)", borderRadius: 8, padding: "3px 9px",
      background: "transparent",
    }}>
      ⚠ {what}
    </span>
  );
}

const heading: React.CSSProperties = {
  fontSize: 10.5, textTransform: "uppercase", letterSpacing: ".1em",
  fontWeight: 700, color: "var(--accent)",
};

const label: React.CSSProperties = {
  fontSize: 10.5, textTransform: "uppercase", letterSpacing: ".06em",
  color: "var(--text-muted)", fontWeight: 700,
};

function Field({ name, value, empty }: { name: string; value: string | null; empty: string }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={label}>{name}</div>
      <div style={{
        fontSize: 12.5, lineHeight: 1.5, marginTop: 3, wordBreak: "break-word",
        color: value ? "var(--text-primary)" : "var(--text-muted)",
        fontStyle: value ? "normal" : "italic",
      }}>
        {value || empty}
      </div>
    </div>
  );
}

function TimeField({ name, iso, empty }: { name: string; iso: string | null | undefined; empty: string }) {
  const when = iso ? new Date(iso) : null;
  const ok = when && !Number.isNaN(when.getTime());
  return <Field name={name} value={ok ? `${when!.toLocaleString()} (${iso})` : null} empty={empty} />;
}

const section: React.CSSProperties = {
  display: "flex", flexDirection: "column", gap: 8,
  paddingTop: 12, borderTop: "1px solid var(--border)",
};

export default function CrmRowDetail({
  it, onClose, actions,
}: {
  it: DetailItem;
  onClose: () => void;
  /** Optional decision controls, rendered at the top of the panel so the
   *  action is the first thing in reach rather than the last. Omitted by the
   *  surfaces that only read (CrmBoard passes nothing and is unchanged). */
  actions?: React.ReactNode;
}) {
  const ev = it.evidence;
  const sourceKind = ev?.sourceKind ?? "none";

  return (
    <div
      role="region"
      aria-label={`Full details for row ${it.id}`}
      style={{
        border: "1px solid var(--accent)", borderRadius: 12, padding: "14px 16px",
        background: "var(--bg-secondary)", display: "flex", flexDirection: "column", gap: 12,
        marginTop: 2, maxWidth: "100%", overflowX: "hidden",
      }}
      // A detail panel is a sibling section, not the trigger; clicks inside
      // it must never bubble up into the card's own action row.
      onClick={(e) => e.stopPropagation()}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
        <span style={heading}>Full details · row #{it.id}</span>
        <button
          type="button"
          onClick={onClose}
          style={{
            fontSize: 11.5, padding: "3px 10px", borderRadius: 8, cursor: "pointer",
            border: "1px solid var(--border)", background: "transparent", color: "var(--text-secondary)",
          }}
        >
          close
        </button>
      </div>

      {actions && (
        <div style={{
          border: "1px solid var(--border)", borderRadius: 10, padding: "10px 12px",
          background: "var(--bg-card)",
        }}>
          {actions}
        </div>
      )}

      {/* ── The message ─────────────────────────────────────────────────── */}
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <span style={heading}>The message</span>
        <Field name="Subject" value={it.subject} empty="No subject line was recorded." />
        <div>
          <div style={label}>Body</div>
          {it.body ? (
            <pre style={{
              margin: "4px 0 0", fontSize: 12.5, lineHeight: 1.65, color: "var(--text-primary)",
              whiteSpace: "pre-wrap", wordBreak: "break-word", fontFamily: "inherit",
              background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 8,
              padding: "11px 13px", maxHeight: 420, overflowY: "auto", boxSizing: "border-box",
            }}>
              {it.body}
            </pre>
          ) : (
            <p style={{ margin: "3px 0 0", fontSize: 12, fontStyle: "italic", color: "var(--text-muted)" }}>
              {it.bodyState && it.bodyState !== "written" ? it.bodyState : "No message body was ever written for this row."}
            </p>
          )}
        </div>
        <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))" }}>
          <Field name="Recipient" value={it.recipient} empty="No recipient recorded." />
          <Field name="Recipient handle" value={it.recipientHandle ?? null} empty="No handle recorded." />
        </div>
        <div>
          <div style={label}>Recipient page</div>
          <div style={{ marginTop: 4 }}>
            {it.recipient_url
              ? <SourceLink url={it.recipient_url} kind="recipient" />
              : <NoSourceLink what="No recipient page captured for this lead" />}
          </div>
        </div>
      </div>

      {/* ── Why we think this person is worth contacting ───────────────── */}
      <div style={section}>
        <span style={heading}>Why we think this is worth contacting</span>

        <div>
          <div style={label}>Tier</div>
          {it.tierInfo ? (
            <div style={{ marginTop: 3 }}>
              <div style={{ fontSize: 13, fontWeight: 650, color: "var(--text-primary)" }}>{it.tierInfo.label}</div>
              <p style={{ margin: "3px 0 0", fontSize: 12, lineHeight: 1.55, color: "var(--text-secondary)" }}>
                {it.tierInfo.meaning}
              </p>
            </div>
          ) : (
            <p style={{ margin: "3px 0 0", fontSize: 12, fontStyle: "italic", color: "var(--text-muted)" }}>
              No tier was recorded for this row.
            </p>
          )}
        </div>

        <Field name="Personalization note" value={it.personalization} empty="No personalization note recorded." />

        {/* Evidence: the verbatim quote, and the evidence/recipient_only line
            kept visually distinct so an unevidenced row never borrows a
            proven look. */}
        <div style={{
          border: `1px solid ${EVIDENCE_COLOR[sourceKind]}`, borderRadius: 10, padding: "10px 12px",
          background: "var(--bg-card)",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span style={{ fontSize: 11.5, fontWeight: 700, color: EVIDENCE_COLOR[sourceKind] }}>
              {ev?.label ?? "No evidence data returned"}
            </span>
            <span style={{
              fontSize: 9.5, fontWeight: 700, padding: "1px 8px", borderRadius: 20, textTransform: "uppercase",
              letterSpacing: ".05em", color: EVIDENCE_COLOR[sourceKind], border: `1px solid ${EVIDENCE_COLOR[sourceKind]}`,
            }}>
              {sourceKind === "evidence" ? "verified evidence"
                : sourceKind === "recipient_only" ? "prospect's own page, not proof"
                : "no source"}
            </span>
          </div>

          <div style={{ marginTop: 9 }}>
            <div style={label}>Quote from the prospect</div>
            {ev?.quote ? (
              <blockquote style={{
                margin: "5px 0 0", fontSize: 13.5, fontStyle: "italic", color: "var(--text-primary)",
                lineHeight: 1.6, borderLeft: "2px solid var(--accent-dim)", paddingLeft: 10,
              }}>
                &ldquo;{ev.quote}&rdquo;
              </blockquote>
            ) : (
              <p style={{ margin: "3px 0 0", fontSize: 12, fontStyle: "italic", color: "var(--text-muted)" }}>
                No quote was captured for this row.
              </p>
            )}
          </div>

          <div style={{ marginTop: 8 }}>
            <div style={label}>Source page</div>
            <div style={{ marginTop: 4 }}>
              {ev?.sourceUrl
                ? <SourceLink url={ev.sourceUrl} kind={sourceKind === "evidence" ? "evidence" : "recipient"} />
                : <NoSourceLink what="No source link captured for this lead" />}
            </div>
            {sourceKind === "recipient_only" && (
              <p style={{ margin: "5px 0 0", fontSize: 11.5, lineHeight: 1.5, color: "var(--orange)" }}>
                This is the prospect&rsquo;s own page, not the page the claim was read from.
                It is a place to start checking, not proof.
              </p>
            )}
          </div>

          <div style={{ marginTop: 8 }}>
            <div style={label}>evidence_url (raw)</div>
            <div style={{ marginTop: 4 }}>
              {it.evidence_url
                ? <SourceLink url={it.evidence_url} kind="evidence" />
                : <NoSourceLink what="No source link captured for this lead" />}
            </div>
          </div>

          {ev?.detail && (
            <p style={{ margin: "9px 0 0", fontSize: 11.5, lineHeight: 1.55, color: "var(--text-secondary)" }}>
              {ev.detail}
            </p>
          )}
        </div>
      </div>

      {/* ── Whether it can be sent, and why not ─────────────────────────── */}
      <div style={section}>
        <span style={heading}>Sending status</span>
        <div>
          <div style={label}>Sendable</div>
          <div style={{
            fontSize: 12.5, marginTop: 3, fontWeight: 600,
            color: it.sendable === true ? "var(--green)" : it.sendable === false ? "var(--orange)" : "var(--text-muted)",
          }}>
            {it.sendable === true ? "Yes, in the sendable queue"
              : it.sendable === false ? "No"
              : "Not known, the sendable queue could not be checked"}
          </div>
          {it.notSendableReason && (
            <p style={{ margin: "3px 0 0", fontSize: 12, lineHeight: 1.5, color: "var(--text-secondary)" }}>
              {it.notSendableReason}
            </p>
          )}
        </div>
        {it.review && (
          <div>
            <div style={label}>Review state</div>
            <div style={{ fontSize: 12.5, marginTop: 3, color: "var(--text-primary)", fontWeight: 600 }}>
              {it.review.state.replace(/_/g, " ").toLowerCase()}
            </div>
            <p style={{ margin: "3px 0 0", fontSize: 12, lineHeight: 1.5, color: "var(--text-secondary)" }}>
              {it.review.detail}
            </p>
          </div>
        )}
      </div>

      {/* ── Timestamps ───────────────────────────────────────────────────── */}
      <div style={section}>
        <span style={heading}>Timestamps</span>
        <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit,minmax(200px,1fr))" }}>
          <TimeField name="Created" iso={it.created_at} empty="No created timestamp recorded." />
          <TimeField name="Reviewed" iso={it.reviewedAt} empty="Not yet reviewed." />
          <TimeField name="Sent" iso={it.sentAt} empty="Not yet sent." />
        </div>
      </div>

      {/* ── Everything else, unstyled and complete ──────────────────────── */}
      <details style={section}>
        <summary style={{ ...heading, cursor: "pointer", listStyle: "none" }}>
          Raw record (id, client, channel, status, tier, direction)
        </summary>
        <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit,minmax(160px,1fr))", marginTop: 8 }}>
          <Field name="id" value={String(it.id)} empty="missing" />
          <Field name="client" value={it.client} empty="No client recorded." />
          <Field name="channel" value={it.channel} empty="No channel recorded." />
          <Field name="direction" value={it.direction ?? null} empty="No direction recorded." />
          <Field name="status" value={it.status} empty="No status recorded." />
          <Field name="tier (raw code)" value={it.tier} empty="No tier recorded." />
        </div>
      </details>
    </div>
  );
}
