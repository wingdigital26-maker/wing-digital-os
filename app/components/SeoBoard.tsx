"use client";
import { useCallback, useEffect, useState } from "react";

// Marketing > SEO (2026-09-05, Jack): one feed of every SEO page and post that
// has actually shipped, across every client, newest first. Reads the SAME
// public-source engine the client dashboards use (/api/dashboard/<slug>), so
// this list is exactly what each client sees on their own dashboard — no
// second bookkeeping. Staff sessions bypass the per-client key on that route.
//
// Honesty rules: a client whose source fails shows a named error, never an
// empty list pretending nothing published. Counts only appear once every
// source answered.

// Same registry slugs as app/api/dashboard/clients.ts. Kept as a literal here
// (not imported) because that file is server-side registry with theme/outreach
// config; if a client is added there, add its slug here too.
const CLIENT_SLUGS = ["heros-junk", "jackson-roofing"] as const;

type Item = { date: string; type: string; title: string; status: string; url: string };
type ClientFeed = {
  slug: string;
  name: string;
  site: string;
  state: "loading" | "ok" | "error";
  reason?: string;
  items: Item[];
  failedSources: number;
};

const TYPE_COLORS: Record<string, string> = {
  blog: "#4a86e8",
  service: "#c9384a",
  city: "#d9903c",
  other: "#7a8ba3",
};

function fmtDate(d: string): string {
  const t = new Date(d);
  if (isNaN(t.getTime())) return d;
  return t.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export default function SeoBoard() {
  const [feeds, setFeeds] = useState<ClientFeed[]>(
    CLIENT_SLUGS.map(slug => ({ slug, name: slug, site: "", state: "loading", items: [], failedSources: 0 })),
  );
  const [typeFilter, setTypeFilter] = useState<string | null>(null);
  const [clientFilter, setClientFilter] = useState<string | null>(null);

  const load = useCallback(() => {
    CLIENT_SLUGS.forEach(async slug => {
      try {
        const r = await fetch(`/api/dashboard/${slug}`, { cache: "no-store" });
        if (!r.ok) {
          setFeeds(f => f.map(c => c.slug === slug
            ? { ...c, state: "error", reason: `HTTP ${r.status}` } : c));
          return;
        }
        const j = await r.json();
        setFeeds(f => f.map(c => c.slug === slug
          ? {
              ...c,
              state: "ok",
              name: j?.brand?.name || slug,
              site: j?.brand?.site || "",
              items: Array.isArray(j?.items) ? j.items : [],
              failedSources: (typeof j?.sourcesFailed === "number" ? j.sourcesFailed : 0)
                + (typeof j?.undated === "number" ? j.undated : 0),
            }
          : c));
      } catch {
        setFeeds(f => f.map(c => c.slug === slug
          ? { ...c, state: "error", reason: "not reachable" } : c));
      }
    });
  }, []);
  useEffect(() => { load(); }, [load]);

  const allLoaded = feeds.every(f => f.state !== "loading");
  const okFeeds = feeds.filter(f => f.state === "ok");
  const merged: Array<Item & { client: string; clientSlug: string }> = okFeeds
    .flatMap(f => f.items.map(it => ({ ...it, client: f.name, clientSlug: f.slug })))
    .filter(it => (typeFilter ? it.type === typeFilter : true))
    .filter(it => (clientFilter ? it.clientSlug === clientFilter : true))
    .sort((a, b) => (a.date < b.date ? 1 : -1));

  const typesPresent = Array.from(new Set(okFeeds.flatMap(f => f.items.map(i => i.type))));

  const chip = (on: boolean): React.CSSProperties => ({
    padding: "5px 12px", borderRadius: 999, fontSize: 12, fontWeight: 600, cursor: "pointer",
    border: `1px solid ${on ? "var(--accent)" : "var(--border)"}`,
    color: on ? "var(--accent)" : "var(--text-muted)",
    background: on ? "color-mix(in srgb, var(--accent) 10%, transparent)" : "transparent",
    minHeight: 32,
  });

  return (
    <div style={{ maxWidth: 900, margin: "0 auto" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
        <h2 style={{ fontSize: 18, fontWeight: 800 }}>SEO content shipped</h2>
        <span style={{ fontSize: 12.5, color: "var(--text-muted)" }}>
          Every page and post live on a client site, straight from the same sources their dashboards read.
          {allLoaded && okFeeds.length > 0 && ` ${merged.length} shown.`}
        </span>
        <button onClick={load} style={{ ...chip(false), marginLeft: "auto" }}>Refresh</button>
      </div>

      {/* Per-client source states — a down source is said out loud. */}
      {feeds.some(f => f.state !== "ok" || f.failedSources > 0) && (
        <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 4 }}>
          {feeds.filter(f => f.state === "loading").map(f => (
            <div key={f.slug} style={{ fontSize: 12.5, color: "var(--text-muted)" }}>{f.slug}: loading…</div>
          ))}
          {feeds.filter(f => f.state === "error").map(f => (
            <div key={f.slug} style={{ fontSize: 12.5, color: "var(--orange)" }}>
              {f.slug} (/api/dashboard/{f.slug}): {f.reason}. Its posts are missing from this list.
            </div>
          ))}
          {feeds.filter(f => f.state === "ok" && f.failedSources > 0).map(f => (
            <div key={f.slug} style={{ fontSize: 12.5, color: "var(--orange)" }}>
              {f.name}: {f.failedSources} source(s) failed or pages could not be dated this run, so this list may be short.
            </div>
          ))}
        </div>
      )}

      {/* Filters */}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 14 }}>
        <button style={chip(clientFilter === null && typeFilter === null)} onClick={() => { setClientFilter(null); setTypeFilter(null); }}>All</button>
        {feeds.filter(f => f.state === "ok").map(f => (
          <button key={f.slug} style={chip(clientFilter === f.slug)}
            onClick={() => setClientFilter(c => (c === f.slug ? null : f.slug))}>{f.name}</button>
        ))}
        <span style={{ width: 8 }} />
        {typesPresent.map(t => (
          <button key={t} style={chip(typeFilter === t)}
            onClick={() => setTypeFilter(v => (v === t ? null : t))}>{t}</button>
        ))}
      </div>

      {/* Feed */}
      <div style={{ marginTop: 14, border: "1px solid var(--border)", borderRadius: 12, background: "var(--bg-card)", overflow: "hidden" }}>
        {!allLoaded && merged.length === 0 && (
          <div style={{ padding: 18, fontSize: 13, color: "var(--text-muted)" }}>Loading the live sites…</div>
        )}
        {allLoaded && okFeeds.length === 0 && (
          <div style={{ padding: 18, fontSize: 13, color: "var(--orange)" }}>
            No content source answered, so nothing can be listed. That is a connection problem, not an empty catalog.
          </div>
        )}
        {allLoaded && okFeeds.length > 0 && merged.length === 0 && (
          <div style={{ padding: 18, fontSize: 13, color: "var(--text-muted)" }}>Nothing matches this filter.</div>
        )}
        {merged.map((it, i) => (
          <a key={`${it.url}-${i}`} href={it.url} target="_blank" rel="noreferrer"
            style={{
              display: "flex", alignItems: "center", gap: 10, padding: "10px 14px",
              borderTop: i === 0 ? "none" : "1px solid var(--border)",
              textDecoration: "none", color: "var(--text-primary)", minHeight: 44,
            }}>
            <span style={{
              width: 9, height: 9, borderRadius: 3, flex: "0 0 auto",
              background: TYPE_COLORS[it.type] || TYPE_COLORS.other,
            }} />
            <span style={{ fontSize: 13.5, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0, flex: 1 }}>
              {it.title}
            </span>
            <span style={{ fontSize: 11.5, color: "var(--text-muted)", flex: "0 0 auto" }}>{it.client}</span>
            <span style={{ fontSize: 11.5, color: "var(--text-muted)", flex: "0 0 auto", fontVariantNumeric: "tabular-nums" }}>{fmtDate(it.date)}</span>
          </a>
        ))}
      </div>

      <p style={{ marginTop: 10, fontSize: 11.5, color: "var(--text-muted)" }}>
        Sources: Hero&apos;s from its site repo, Jackson from its WordPress API. Clients without a
        registered public source (registry in api/dashboard/clients.ts) are not listed here yet.
      </p>
    </div>
  );
}
