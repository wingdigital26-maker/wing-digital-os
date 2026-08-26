"use client";

// Delivery-side activity for a client: the blog posts, city pages, Google
// Business posts and review pushes the content engine actually recorded.
// This reads a real state file or it shows nothing — there are no sample rows.

export type ContentItem = {
  date: string; type: string; title: string; status: string; url: string | null;
};
export type ContentFeed = {
  available: boolean; source: string | null; reason: string | null; items: ContentItem[];
};

const TYPE_LABEL: Record<string, string> = {
  blog: "Blog post", city: "City page", gbp: "Google Business post",
  reviews: "Review request", backlink: "Backlink", faq: "FAQ block",
};

function statusColor(s: string) {
  if (s === "published") return "var(--green)";
  if (s === "drafted") return "var(--orange)";
  return "var(--text-muted)";
}

export default function CrmContentFeed({ feed, client }: { feed: ContentFeed; client: string }) {
  const items = feed.items;
  const published = items.filter((i) => i.status === "published").length;
  const planned = items.filter((i) => i.status !== "published").length;

  return (
    <section style={{
      border: "1px solid var(--border)", borderRadius: 14, padding: "13px 16px",
      background: "var(--bg-card)", display: "flex", flexDirection: "column", gap: 10,
    }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
        <span style={{
          fontSize: 10.5, textTransform: "uppercase", letterSpacing: ".1em",
          fontWeight: 700, color: "var(--accent)",
        }}>Content &amp; posting</span>
        <span style={{ fontSize: 11.5, color: "var(--text-secondary)" }}>
          the client-delivery work recorded for {client}
        </span>
        <span style={{ flex: 1 }} />
        {feed.available && (
          <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
            {published} published · {planned} not yet published · <code>{feed.source}</code>
          </span>
        )}
      </div>

      {!feed.available || items.length === 0 ? (
        <div style={{
          border: "1px dashed var(--border)", borderRadius: 10, padding: "12px 14px",
        }}>
          <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--orange)" }}>
            No publishing record to show
          </div>
          <p style={{ margin: "5px 0 0", fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.55 }}>
            {feed.reason || "No source reported a reason."}
          </p>
        </div>
      ) : (
        <ol style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 6 }}>
          {items.map((it, i) => (
            <li key={`${it.date}-${i}`} style={{
              display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap",
              padding: "7px 0", borderTop: i === 0 ? "none" : "1px solid var(--border)",
            }}>
              <span style={{
                fontSize: 11, color: "var(--text-muted)", fontVariantNumeric: "tabular-nums",
                minWidth: 78,
              }}>{it.date}</span>
              <span style={{
                fontSize: 10, textTransform: "uppercase", letterSpacing: ".07em",
                color: "var(--text-secondary)", minWidth: 120,
              }}>{TYPE_LABEL[it.type] || it.type || "item"}</span>
              <span style={{ fontSize: 13, flex: 1, minWidth: 200, color: "var(--text-primary)" }}>
                {it.title || "(untitled)"}
              </span>
              {it.url ? (
                <a href={it.url} target="_blank" rel="noopener"
                  style={{ fontSize: 11.5, color: "var(--accent)", textDecoration: "none" }}>
                  open ↗
                </a>
              ) : it.status === "published" ? (
                <span style={{ fontSize: 11, color: "var(--text-muted)" }}>no link logged</span>
              ) : null}
              <span style={{ fontSize: 11, fontWeight: 600, color: statusColor(it.status), minWidth: 66, textAlign: "right" }}>
                {it.status || "unknown"}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
