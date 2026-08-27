"use client";

// Client summary header — the key facts about whichever compartment is open.
// MRR/status come from the client's vault page; counts come from the outbound
// rollup; scraper state comes from crm_clients. Any fact with no source says so
// out loud rather than showing a comfortable-looking zero.

export type ClientProfile = {
  file: string; name: string; owner: string; industry: string;
  status: string; mrr: number | null; updated: string;
};
export type ChannelRoll = {
  channel: string; total: number; draft: number; approved: number; sent: number;
};
export type Scraper = {
  slug: string; name: string; channels: string | null; scrape_niche: string | null;
  scrape_cities: string | null; scrape_terms: string | null; active: boolean;
};

// Every row the client has, split by where it stands. `draft/approved/sent`
// come from the server's rollup over the whole table. The rest can only be
// split by reading the returned rows, so when that list is capped they are
// `null` — "not broken out" — rather than a zero that would read as a fact.
export type StatusBreakdown = {
  total: number;
  draft: number; approved: number; sent: number;
  /** null when the returned row list was capped and cannot be split. */
  rejected: number | null; skipped: number | null; other: number | null;
  /** Rejected rows parked for a human decision. Subset of `rejected`. */
  parked: number | null;
  /** total − (draft+approved+sent): exact, even when the row list is capped. */
  notLive: number;
  truncated: boolean;
};

export const CHANNEL_LABEL: Record<string, string> = {
  email: "Email", instagram: "Instagram", tiktok: "TikTok", nextdoor: "Nextdoor",
  facebook: "Facebook", linkedin: "LinkedIn", reddit: "Reddit", sms: "SMS", unknown: "Unlabeled",
};

const card: React.CSSProperties = {
  border: "1px solid var(--border)", borderRadius: 12, padding: "9px 13px",
  background: "var(--bg-card)", minWidth: 96,
};
const label: React.CSSProperties = {
  fontSize: 10.5, color: "var(--text-secondary)", textTransform: "uppercase",
  letterSpacing: ".07em", marginTop: 2,
};

function Fact({ value, sub, color, muted }: {
  value: string; sub: string; color?: string; muted?: boolean;
}) {
  return (
    <div style={card}>
      <div style={{
        fontSize: muted ? 12.5 : 19, fontWeight: muted ? 500 : 700,
        color: color ?? (muted ? "var(--text-muted)" : "var(--text-primary)"),
        fontVariantNumeric: "tabular-nums", lineHeight: 1.3,
      }}>{value}</div>
      <div style={label}>{sub}</div>
    </div>
  );
}

// A count that came from somewhere real. Zero renders muted, so a live zero
// never shouts as loudly as a live number.
function Pill({ n, label, color }: { n: number; label: string; color: string }) {
  const on = n > 0;
  return (
    <span style={{
      fontSize: 11.5, padding: "3px 10px", borderRadius: 20,
      border: `1px solid ${on ? color : "var(--border)"}`,
      color: on ? "var(--text-secondary)" : "var(--text-muted)",
      background: "var(--bg-card)",
    }}>
      <b style={{ color: on ? color : "var(--text-muted)", marginRight: 6, fontVariantNumeric: "tabular-nums" }}>{n}</b>
      {label}
    </span>
  );
}

// We know how many rows are not draft/approved/sent, but not which is which,
// because the row list came back capped. Say exactly that.
function Unsplit({ n }: { n: number }) {
  return (
    <span
      title="The API returns at most 200 rows per client, and that cap was hit, so these rows could not be split by status."
      style={{
        fontSize: 11.5, padding: "3px 10px", borderRadius: 20,
        border: "1px dashed var(--border)", color: "var(--text-muted)", background: "var(--bg-card)",
      }}
    >
      <b style={{ marginRight: 6, fontVariantNumeric: "tabular-nums" }}>{n}</b>
      closed — not broken out (row list capped)
    </span>
  );
}

export default function CrmClientSummary({ name, profile, scraper, counts, byChannel, breakdown, scrapingOff }: {
  name: string;
  profile: ClientProfile | null;
  scraper: Scraper | null;
  counts: { draft: number; approved: number; sent: number; total: number };
  byChannel: ChannelRoll[];
  breakdown: StatusBreakdown;
  /** Scraping deliberately switched off — not a fault. */
  scrapingOff: boolean;
}) {
  const b = breakdown;
  return (
    <section style={{
      border: "1px solid var(--border)", borderRadius: 14, padding: "14px 16px",
      background: "var(--bg-card)", display: "flex", flexDirection: "column", gap: 11,
    }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
        <h3 style={{ margin: 0, fontSize: 16.5, letterSpacing: "-0.01em" }}>{name}</h3>
        {profile?.industry && (
          <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>{profile.industry}</span>
        )}
        {profile?.owner && (
          <span style={{ fontSize: 12, color: "var(--text-muted)" }}>· {profile.owner}</span>
        )}
        <span style={{ flex: 1 }} />
        {profile?.updated && (
          <span style={{ fontSize: 11, color: "var(--text-muted)" }}>vault updated {profile.updated}</span>
        )}
      </div>

      <div style={{ display: "flex", gap: 9, flexWrap: "wrap" }}>
        {profile
          ? <Fact value={profile.mrr != null ? `$${profile.mrr.toLocaleString()}` : "not recorded"}
                  sub="MRR" muted={profile.mrr == null}
                  color={profile.mrr != null ? "var(--green)" : undefined} />
          : <Fact value="no vault page" sub="MRR" muted />}
        {profile
          ? <Fact value={profile.status} sub="status" muted
                  color={profile.status === "active" ? "var(--green)" : "var(--orange)"} />
          : <Fact value="unknown" sub="status" muted />}
        <Fact value={String(counts.draft)} sub="drafts"
              color={counts.draft > 0 ? "var(--accent)" : "var(--text-muted)"} />
        <Fact value={String(counts.approved)} sub="approved" color="var(--green)" />
        <Fact value={String(counts.sent)} sub="sent" color="var(--accent)" />
        {scraper
          ? <Fact value={scrapingOff ? "off by choice" : scraper.active ? "running" : "paused"} sub="scraper" muted
                  color={scrapingOff ? "var(--text-secondary)" : scraper.active ? "var(--green)" : "var(--orange)"} />
          : <Fact value="none configured" sub="scraper" muted />}
      </div>

      {/* Where every row this client has actually stands. Without this, a
          client with 15 leads and 0 drafts looks identical to a client with
          nothing at all. */}
      <div style={{ display: "flex", gap: 7, flexWrap: "wrap", alignItems: "center" }}>
        <span style={{ fontSize: 10.5, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: ".07em" }}>
          all {b.total} row{b.total === 1 ? "" : "s"} ever
        </span>
        {b.total === 0 ? (
          <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
            {scrapingOff
              ? "nothing has ever been drafted for this client, which is expected while scraping is off"
              : "the scraper has never written a single row for this client"}
          </span>
        ) : (
          <>
            <Pill n={b.draft} label="waiting on you" color="var(--accent)" />
            <Pill n={b.approved} label="approved" color="var(--green)" />
            <Pill n={b.sent} label="sent" color="var(--accent)" />
            {b.parked != null && <Pill n={b.parked} label="parked for you" color="var(--orange)" />}
            {b.rejected != null
              ? <Pill n={b.rejected - (b.parked ?? 0)} label="filtered out" color="var(--text-muted)" />
              : <Unsplit n={b.notLive} />}
            {b.skipped != null && b.skipped > 0 && <Pill n={b.skipped} label="skipped" color="var(--text-muted)" />}
            {b.other != null && b.other > 0 && <Pill n={b.other} label="other status" color="var(--text-muted)" />}
          </>
        )}
      </div>

      {/* Zero drafts is a finding, not an absence. Say which of the two it is. */}
      {b.total > 0 && b.draft === 0 && b.approved === 0 && b.sent === 0 && (
        <p style={{
          margin: 0, fontSize: 12, lineHeight: 1.6, color: "var(--text-secondary)",
          borderLeft: "2px solid var(--orange)", paddingLeft: 9,
        }}>
          <b style={{ color: "var(--orange)" }}>No drafts yet — ever.</b>{" "}
          The scraper has found {b.total} lead{b.total === 1 ? "" : "s"} for {name}, and{" "}
          {b.rejected != null
            ? `every one of them was filtered out before a message was written`
            : `none of them reached a draft`}
          . This panel is not empty because nothing has happened; it is empty because nothing
          survived the filter.
        </p>
      )}

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <span style={{ fontSize: 10.5, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: ".07em" }}>
          active channels
        </span>
        {byChannel.length === 0 ? (
          <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
            nothing drafted on any channel yet
          </span>
        ) : byChannel.map((c) => (
          <span key={c.channel} style={{
            fontSize: 11.5, padding: "3px 10px", borderRadius: 20,
            border: "1px solid var(--border)", color: "var(--text-secondary)",
          }}>
            {CHANNEL_LABEL[c.channel] || c.channel}
            <b style={{ color: "var(--text-primary)", marginLeft: 6 }}>{c.total}</b>
          </span>
        ))}
      </div>

      {!profile && (
        <p style={{ margin: 0, fontSize: 11.5, color: "var(--text-muted)" }}>
          No page at <code>wiki/clients/</code> matches “{name}”, so MRR and account status are unknown
          here. Add one to fill this in.
        </p>
      )}
    </section>
  );
}
