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

export default function CrmClientSummary({ name, profile, scraper, counts, byChannel }: {
  name: string;
  profile: ClientProfile | null;
  scraper: Scraper | null;
  counts: { draft: number; approved: number; sent: number; total: number };
  byChannel: ChannelRoll[];
}) {
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
        <Fact value={String(counts.draft)} sub="drafts" />
        <Fact value={String(counts.approved)} sub="approved" color="var(--green)" />
        <Fact value={String(counts.sent)} sub="sent" color="var(--accent)" />
        {scraper
          ? <Fact value={scraper.active ? "running" : "paused"} sub="scraper" muted
                  color={scraper.active ? "var(--green)" : "var(--orange)"} />
          : <Fact value="none configured" sub="scraper" muted />}
      </div>

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
