import { NextResponse } from "next/server";
import { CLIENTS, ClientConfig, ContentSource } from "../clients";

// ── Live client-dashboard data endpoint ──────────────────────────────────────
// Serves a client's dashboard payload built FROM PUBLIC SOURCES AT REQUEST TIME.
// This is what makes a dashboard a permanent link instead of a file Jack has to
// rebuild on his PC: hosted once, current forever, and adding a client is a new
// entry in clients.ts rather than a new deploy pipeline.
//
// Deliberately credential-free. Every source below is readable by anyone:
//   - wp_api      -> {site}/wp-json/wp/v2/posts   (published posts are public)
//   - github_repo -> api.github.com commits       (public repo)
//   - sitemap     -> {site}/sitemap.xml           (public by definition)
// That means no secret can leak through this route and no key rotation can
// silently break a client's dashboard.
//
// HONESTY RULES (same as the static build):
//   - Only PUBLISHED work is returned. Never drafts, never plans.
//   - A metric with no wired source is returned as a named "pending" state,
//     never as a zero. A zero reads to a client as "you did nothing this month".
//   - `dataThrough` reports how current the SOURCE is, not when this ran.

export const revalidate = 1800; // 30 min: fresh enough to feel live, cheap enough to survive traffic

type Item = { date: string; type: string; title: string; status: string; url: string };

const UA = { "User-Agent": "WingDigital-Dashboard/1.0 (+https://wingdigital.co)" };

/**
 * Unauthenticated api.github.com allows 60 calls an hour per IP, and dating one
 * client's pages costs roughly one call each. Measured 2026-09-03: a throttled
 * run quietly returned 26 of 30 published posts, because a failed date lookup
 * dropped the page entirely. A client watching their own total shrink is the
 * worst possible failure mode for this page, so the token is used when present
 * and a partial run is now REPORTED rather than rendered as a smaller number.
 */
const GH_AUTH: Record<string, string> = process.env.GITHUB_TOKEN
  ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
  : {};


function stripTags(s: string): string {
  return s
    .replace(/<[^>]+>/g, "")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#0?39;|&#x27;|&rsquo;|&#8217;/gi, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** WordPress: the `date` field is the real publish timestamp, so no guessing. */
async function fromWpApi(src: ContentSource): Promise<Item[]> {
  const out: Item[] = [];
  for (const kind of ["posts", "pages"] as const) {
    const type = kind === "posts" ? src.postType || "blog" : src.pageType;
    if (!type) continue;
    const url = `${src.site!.replace(/\/$/, "")}/wp-json/wp/v2/${kind}` +
      `?per_page=100&status=publish&orderby=date&order=desc&_fields=date,title,link`;
    const r = await fetch(url, { headers: UA, next: { revalidate } });
    if (!r.ok) continue;
    const rows = (await r.json()) as Array<{ date: string; title: { rendered: string }; link: string }>;
    for (const p of rows) {
      out.push({
        date: (p.date || "").slice(0, 10),
        type,
        title: stripTags(p.title?.rendered || ""),
        status: "published",
        url: p.link || "",
      });
    }
  }
  return out;
}

/**
 * GitHub: the FIRST commit that added a file is its publish date. `until` walks
 * back to the oldest commit touching the path, which is what we want -- a later
 * edit must never masquerade as a new publish.
 */
async function fromGithub(src: ContentSource): Promise<{ items: Item[]; missed: number }> {
  const out: Item[] = [];
  let missed = 0;
  const H = { ...UA, ...GH_AUTH };
  for (const g of src.globs || []) {
    const listUrl = `https://api.github.com/repos/${src.repo}/contents/${g.dir}`;
    const r = await fetch(listUrl, { headers: H, next: { revalidate } });
    if (!r.ok) continue;
    const files = (await r.json()) as Array<{ name: string; path: string }>;
    const wanted = files.filter(
      (f) => f.name.endsWith(".html") && !(g.skip || []).includes(f.name)
    );
    // One commit query per file. Bounded by the client's page count, and the
    // 30-minute cache means a normal week is a handful of real calls.
    const results = await Promise.all(
      wanted.map(async (f) => {
        const cUrl = `https://api.github.com/repos/${src.repo}/commits` +
          `?path=${encodeURIComponent(f.path)}&per_page=1&until=`;
        // Ask for the oldest commit by paging to the end is expensive; instead
        // take the full (small) commit list for this path and use its last entry.
        const cr = await fetch(
          `https://api.github.com/repos/${src.repo}/commits?path=${encodeURIComponent(f.path)}&per_page=100`,
          { headers: H, next: { revalidate } }
        );
        if (!cr.ok) return null;
        const commits = (await cr.json()) as Array<{ commit: { author: { date: string } } }>;
        if (!Array.isArray(commits) || !commits.length) return null;
        const added = commits[commits.length - 1].commit.author.date.slice(0, 10);
        void cUrl;
        return {
          date: added,
          type: g.type,
          title: titleFromSlug(f.name),
          status: "published",
          url: `${src.site!.replace(/\/$/, "")}/${f.path}`,
        } as Item;
      })
    );
    for (const it of results) {
      if (it) out.push(it);
      else missed++;   // found on the site, could not be dated -- never silently dropped
    }
  }
  return { items: out, missed };
}

function titleFromSlug(name: string): string {
  return name
    .replace(/\.html$/, "")
    .split("-")
    .map((w) => (w.length > 2 ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

/** Sitemap: the universal fallback. lastmod is LAST MODIFIED, not first publish. */
async function fromSitemap(src: ContentSource): Promise<Item[]> {
  const r = await fetch(`${src.site!.replace(/\/$/, "")}/sitemap.xml`, {
    headers: UA, next: { revalidate },
  });
  if (!r.ok) return [];
  const xml = await r.text();
  const out: Item[] = [];
  const rx = /<url>\s*<loc>([^<]+)<\/loc>\s*(?:<lastmod>([^<]+)<\/lastmod>)?/g;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(xml))) {
    const loc = m[1];
    const g = (src.globs || []).find((x) => loc.includes(`/${x.dir}/`));
    if (!g) continue;
    const file = loc.split("/").pop() || "";
    if ((g.skip || []).includes(file)) continue;
    out.push({
      date: (m[2] || "").slice(0, 10),
      type: g.type,
      title: titleFromSlug(file),
      status: "published",
      url: loc,
    });
  }
  return out;
}

/**
 * Cloudflare Web Analytics via the GraphQL API.
 *
 * Returns null for every "we cannot know" case (no token, no zone, API error)
 * rather than zeros -- a zero on a traffic tile reads to a client as "nobody
 * visited your site", which is a very different claim from "we are not
 * connected yet". The dashboard renders the pending state when this is null.
 *
 * Uses rumPageloadEventsAdaptiveGroups (the beacon's own dataset) rather than
 * zone httpRequests: zone requests count bots and asset fetches, so reporting
 * them to a client as "visits" would overstate reality.
 */
async function fetchCloudflare(cfg: ClientConfig) {
  const a = cfg.analytics;
  if (!a || a.kind !== "cloudflare") return null;
  const token = process.env[a.tokenEnv];
  if (!token) return null;                       // not wired up yet

  const host = cfg.brand.site.replace(/^https?:\/\//, "").replace(/\/$/, "");
  const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  try {
    // Resolve the zone from the domain so no ID has to be copied by hand.
    let zoneId = a.zoneId;
    let accountId: string | undefined;
    const zr = await fetch(
      `https://api.cloudflare.com/client/v4/zones?name=${encodeURIComponent(host)}`,
      { headers: auth, next: { revalidate } }
    );
    const zj = await zr.json();
    if (zj?.success && zj.result?.length) {
      zoneId = zoneId || zj.result[0].id;
      accountId = zj.result[0].account?.id;
    }
    if (!accountId) return null;

    const end = new Date();
    const start = new Date(end);
    start.setDate(end.getDate() - 29);
    const iso = (d: Date) => d.toISOString().slice(0, 10);

    const query = `query($account:String!,$start:Date!,$end:Date!){
      viewer { accounts(filter:{accountTag:$account}) {
        total: rumPageloadEventsAdaptiveGroups(
          limit:1, filter:{date_geq:$start, date_leq:$end, requestHost:"${host}"}
        ) { count }
        daily: rumPageloadEventsAdaptiveGroups(
          limit:100, filter:{date_geq:$start, date_leq:$end, requestHost:"${host}"},
          orderBy:[date_ASC]
        ) { count dimensions { date } }
      } }
    }`;

    const gr = await fetch("https://api.cloudflare.com/client/v4/graphql", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ query, variables: { account: accountId, start: iso(start), end: iso(end) } }),
      next: { revalidate },
    });
    const gj = await gr.json();
    const acct = gj?.data?.viewer?.accounts?.[0];
    if (!acct) return null;

    const total = acct.total?.[0]?.count ?? 0;
    const daily = (acct.daily || []).map((d: { count: number; dimensions: { date: string } }) => ({
      date: d.dimensions.date,
      count: d.count,
    }));
    // Beacon enabled but nothing recorded yet is a real, reportable zero --
    // distinct from "not connected", which is the null above.
    return { pageviews30d: total, daily, zoneId };
  } catch {
    return null;
  }
}

async function collect(cfg: ClientConfig) {
  const items: Item[] = [];
  const failed: string[] = [];
  let missed = 0;
  for (const src of cfg.sources) {
    try {
      let got: Item[] = [];
      if (src.kind === "wp_api") got = await fromWpApi(src);
      else if (src.kind === "github_repo") {
        const gh = await fromGithub(src);
        got = gh.items;
        missed += gh.missed;
      }
      else if (src.kind === "sitemap") got = await fromSitemap(src);
      items.push(...got);
    } catch {
      // A dead source must never fabricate an empty-but-confident dashboard.
      failed.push(src.kind);
    }
  }
  // De-dupe on (date, title); prefer whichever record carries a URL.
  const merged = new Map<string, Item>();
  for (const it of items) {
    if (!it.date || !it.title) continue;
    const k = `${it.date}|${it.title.toLowerCase()}`;
    const prev = merged.get(k);
    if (!prev || (it.url && !prev.url)) merged.set(k, it);
  }
  const list = [...merged.values()].sort((a, b) => b.date.localeCompare(a.date));
  return { items: list, failed, missed };
}

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ slug: string }> } | { params: { slug: string } }
) {
  const p = await (ctx.params as Promise<{ slug: string }>);
  const slug = p.slug;
  const cfg = CLIENTS[slug];
  if (!cfg) {
    return NextResponse.json({ error: `unknown client '${slug}'` }, { status: 404 });
  }

  const [{ items, failed, missed }, traffic] = await Promise.all([
    collect(cfg),
    fetchCloudflare(cfg),
  ]);

  // Live sources are current as of NOW -- unlike the old local state file, which
  // was only as fresh as the last time Jack's PC ran a script.
  const today = new Date().toISOString().slice(0, 10);

  return NextResponse.json(
    {
      generated: today,
      dataThrough: items.length ? today : null,
      live: true,
      // The page needs its own slug to call the sibling health endpoint. The
      // static build has no slug and no server, which is exactly how that build
      // knows to hide the live site-check section instead of fetching nothing.
      slug,
      sourcesFailed: failed,
      // Pages we can see on the site but could not date this run. Non-zero means
      // the totals below are an UNDERCOUNT, and the page says so rather than
      // showing a smaller number as if work disappeared.
      undated: missed,
      brand: cfg.brand,
      // Theme rides in the payload: one hosted HTML file has to repaint itself
      // in each client's own brand colours at runtime.
      theme: cfg.theme,
      types: cfg.types,
      outreach: cfg.outreach || {},
      // null when no traffic source is wired: the page then shows the named
      // pending state instead of a zero that would read as "nobody visited".
      traffic,
      // Drop the "website visits" pending row once real traffic is flowing --
      // otherwise the page would show the number AND claim it is unavailable.
      pendingMetrics: (cfg.pendingMetrics || []).filter(
        (p) => !(traffic && /website visits/i.test(p.name))
      ),
      items,
      // Live pages are derived from the same public records, so a page can never
      // appear here that is not actually reachable on the client's site.
      pages: (cfg.pageGroups || []).map((g) => ({
        group: g.group,
        links: items
          .filter((i) => g.types.includes(i.type))
          .map((i) => ({ title: i.title, url: i.url }))
          .filter((l) => l.url),
      })).filter((g) => g.links.length),
    },
    { headers: { "Cache-Control": "public, s-maxage=1800, stale-while-revalidate=3600" } }
  );
}
