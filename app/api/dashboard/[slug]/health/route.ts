import { NextResponse } from "next/server";
import { CLIENTS, ClientConfig } from "../../clients";

// ── Live site-health endpoint ────────────────────────────────────────────────
// The main dashboard route reports WHAT we published. This one reports whether
// the site is actually working, measured against the live site at request time
// with no credentials of any kind. It exists because every outcome metric a
// client cares about (search clicks, calls, form leads) is gated behind access
// Jack does not have yet, and a dashboard that can only say "not connected" four
// times is not worth sending. These checks need nothing from the client.
//
// HONESTY RULES (same as the parent route):
//   - Anything we could not measure comes back null, never zero. "We did not
//     reach it" and "it scored zero" are different claims.
//   - Every number is measured on the live public site, this request, from the
//     server. Nothing is read from a stored artifact that could be stale.
//   - `checkedAt` is the measurement time, so the page can say how fresh it is.
//
// Split from the parent route on purpose: this one walks every page on the site,
// so it is slow and cached hard. The dashboard renders instantly off the parent
// payload and fills this section in when it lands.

export const revalidate = 21600; // 6h -- site health does not move minute to minute
export const maxDuration = 60;

const UA = { "User-Agent": "WingDigital-Dashboard/1.0 (+https://wingdigital.co)" };

const MAX_PAGES = 60;       // bounded so one big site cannot blow the time budget
const CONCURRENCY = 8;
const PER_REQUEST_MS = 8000;
const DEADLINE_MS = 40000;  // return what we have rather than timing the route out

type PageCheck = {
  url: string;
  title: string | null;
  ms: number | null;
  bytes: number | null;
  status: number | null;
  /** Something is actually wrong: the page is down, or Google cannot read it properly. */
  problems: string[];
  /** The page works; this is upside we have not taken yet. Never counted as a failure. */
  notes: string[];
};

async function get(url: string, ms = PER_REQUEST_MS, fresh = false) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    const started = Date.now();
    const r = await fetch(url, {
      headers: UA,
      signal: ac.signal,
      // Timing is only meaningful on a fetch that actually crossed the network.
      // Everything else reads the data cache, where a "2ms page load" would be a
      // number about our own cache dressed up as a fact about their site.
      ...(fresh ? { cache: "no-store" as const } : { next: { revalidate } }),
    });
    const body = await r.text();
    return { ok: r.ok, status: r.status, body, ms: Date.now() - started };
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

const MAX_CHILD_SITEMAPS = 10; // cap how many child sitemaps we follow in an index

/** Pull every <loc> value out of a sitemap body. */
function locs(body: string): string[] {
  const out: string[] = [];
  const rx = /<loc>([^<]+)<\/loc>/g;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(body))) out.push(m[1].trim());
  return out;
}

/**
 * Page list comes from the client's own sitemap: it is what Google is told
 * exists. On WordPress and many other CMSes, /sitemap.xml is a SITEMAP INDEX:
 * its <loc> entries point to OTHER sitemap files (.xml), not to real pages. If
 * we audited those we would be checking XML files for a title and an H1, find
 * none, and tell the client the files are broken pages. So when the top-level
 * sitemap is an index, we follow each child sitemap and collect the real page
 * URLs from them. Any .xml URL is excluded from the final list either way.
 */
async function sitemapUrls(site: string): Promise<{ urls: string[]; found: boolean }> {
  const r = await get(`${site.replace(/\/$/, "")}/sitemap.xml`);
  if (!r || !r.ok) return { urls: [], found: false };

  const top = locs(r.body);
  const isIndex = /<sitemapindex[\s>]/i.test(r.body)
    || (top.length > 0 && top.every((u) => /\.xml($|\?)/i.test(u)));

  let collected: string[] = top;
  if (isIndex) {
    // Follow the child sitemaps the index points to and gather their page URLs.
    // Bounded and sequential so one large index cannot blow the time budget; a
    // child that fails to fetch is skipped, never fabricated.
    const children = top.filter((u) => /\.xml($|\?)/i.test(u)).slice(0, MAX_CHILD_SITEMAPS);
    const pages: string[] = [];
    for (const child of children) {
      const cr = await get(child);
      if (!cr || !cr.ok) continue;
      pages.push(...locs(cr.body));
    }
    collected = pages;
  }

  // Belt and suspenders: never let an .xml file into the pages-to-check list,
  // and de-dupe. If following the index turned up no real pages, fall back to
  // the top-level page URLs (also .xml-filtered) so we report something true.
  const clean = (arr: string[]) =>
    Array.from(new Set(arr.filter((u) => !/\.xml($|\?)/i.test(u))));
  let urls = clean(collected);
  if (!urls.length && isIndex) urls = clean(top);

  return { urls, found: true };
}

/**
 * Entities are decoded before anything reads the value. Skipping this puts
 * "Donate Furniture &amp; Goods" in front of a client, and it also inflates the
 * title-length check by four characters per ampersand -- so the decode is a
 * correctness fix, not only a display one.
 */
function decode(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&rsquo;|&#0?39;/gi, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");   // last, so &amp;lt; does not become a tag
}

function firstMatch(html: string, rx: RegExp): string | null {
  const m = html.match(rx);
  if (!m) return null;
  return decode(m[1].replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim() || null;
}

/**
 * The on-page checks, phrased the way they would be explained out loud rather
 * than as SEO acronyms.
 *
 * Two tiers on purpose. A broken page and a page whose title runs eight
 * characters long are both true findings, but collapsing them into one list
 * turns a healthy site into "25 pages we are fixing" and tells the client
 * nothing about which ones matter. Problems are things that are wrong; notes
 * are upside we have not taken yet, and a page carrying only notes still counts
 * as passing.
 */
function inspect(url: string, html: string, ms: number, status: number): PageCheck {
  const problems: string[] = [];
  const notes: string[] = [];
  const title = firstMatch(html, /<title[^>]*>([\s\S]*?)<\/title>/i);
  const desc = firstMatch(html, /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i)
    || firstMatch(html, /<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i);
  const h1 = firstMatch(html, /<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const hasSchema = /application\/ld\+json/i.test(html);
  const canonical = /rel=["']canonical["']/i.test(html);
  const noindex = /<meta[^>]+name=["']robots["'][^>]+noindex/i.test(html);

  if (status !== 200) problems.push(`The page returns ${status} instead of loading`);
  if (!title) problems.push("No page title, so Google has no headline to show");
  if (!desc) problems.push("No description, so Google writes its own snippet");
  if (!h1) problems.push("No main heading on the page");
  if (noindex) problems.push("Marked noindex, so Google is told to skip it");

  // Google shows roughly the first 60 characters of a title. Past 70 the tail is
  // reliably cut, which is worth rewriting but is not a fault in the page.
  if (title && title.length > 70) {
    notes.push(`Title runs ${title.length} characters, so Google will cut the end off`);
  }
  if (!hasSchema) notes.push("No structured data yet, so it cannot win a rich result");
  if (!canonical) notes.push("No canonical link set");

  return {
    url,
    title,
    ms,
    bytes: html.length,
    status,
    problems,
    notes,
  };
}

/**
 * Google's own speed grade. Keyless works but the shared anonymous quota is
 * usually exhausted, so PAGESPEED_API_KEY (free, 25k calls a day) is what makes
 * this reliable. Null on any failure -- a throttle is not a score.
 */
async function pagespeed(site: string) {
  const key = process.env.PAGESPEED_API_KEY;
  const u = "https://www.googleapis.com/pagespeedonline/v5/runPagespeed"
    + `?url=${encodeURIComponent(site)}&strategy=mobile&category=performance`
    + (key ? `&key=${encodeURIComponent(key)}` : "");
  const r = await get(u, 25000);
  if (!r || !r.ok) return null;
  try {
    const j = JSON.parse(r.body);
    const score = j?.lighthouseResult?.categories?.performance?.score;
    const lcp = j?.lighthouseResult?.audits?.["largest-contentful-paint"]?.displayValue;
    if (typeof score !== "number") return null;
    return { score: Math.round(score * 100), lcp: lcp || null, strategy: "mobile" };
  } catch {
    return null;
  }
}

async function runChecks(cfg: ClientConfig, deadline: number) {
  const site = cfg.brand.site.replace(/\/$/, "");
  const [sm, robots] = await Promise.all([
    sitemapUrls(site),
    get(`${site}/robots.txt`),
  ]);

  // Prefer the sitemap; fall back to the homepage alone so a site without one
  // still reports something true rather than nothing at all.
  const all = sm.urls.length ? sm.urls : [site + "/"];
  const list = all.slice(0, MAX_PAGES);

  const checks: PageCheck[] = [];
  for (let i = 0; i < list.length; i += CONCURRENCY) {
    if (Date.now() > deadline) break;
    const batch = list.slice(i, i + CONCURRENCY);
    const done = await Promise.all(
      batch.map(async (u) => {
        const r = await get(u);
        if (!r) return null;                       // unreachable: excluded, not scored as 0
        return inspect(u, r.body, r.ms, r.status);
      })
    );
    for (const c of done) if (c) checks.push(c);
  }

  const unreachable = list.length - checks.length;
  // A page passes when nothing is WRONG with it. Queued improvements do not
  // demote a working page.
  const clean = checks.filter((c) => !c.problems.length).length;

  // One deliberately uncached request, so this is the real round trip to their
  // server rather than a read of ours.
  const timed = await get(site + "/", PER_REQUEST_MS, true);
  const homepageMs = timed && timed.ok ? timed.ms : null;

  // Blocked-by-robots is a real, reportable finding; a missing robots.txt is not.
  const robotsBlocking = robots && robots.ok
    ? /^\s*disallow:\s*\/\s*$/im.test(robots.body)
    : false;

  return {
    site,
    sitemap: { found: sm.found, urls: sm.urls.length },
    robotsBlocking,
    pages: {
      listed: all.length,
      checked: checks.length,
      clean,
      unreachable,
      capped: all.length > MAX_PAGES,
    },
    homepageMs,
    // Only pages that actually have something wrong. A clean site returns [].
    issues: checks
      .filter((c) => c.problems.length)
      .sort((a, b) => b.problems.length - a.problems.length)
      .slice(0, 25)
      .map((c) => ({ url: c.url, title: c.title, problems: c.problems })),
    // Working pages with upside left on the table, kept separate so they can
    // never be read as breakage.
    improvements: checks
      .filter((c) => !c.problems.length && c.notes.length)
      .sort((a, b) => b.notes.length - a.notes.length)
      .slice(0, 30)
      .map((c) => ({ url: c.url, title: c.title, notes: c.notes })),
  };
}

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ slug: string }> } | { params: { slug: string } }
) {
  const p = await (ctx.params as Promise<{ slug: string }>);
  const cfg = CLIENTS[p.slug];
  if (!cfg) {
    return NextResponse.json({ error: `unknown client '${p.slug}'` }, { status: 404 });
  }

  const deadline = Date.now() + DEADLINE_MS;
  const [health, speed] = await Promise.all([
    runChecks(cfg, deadline),
    pagespeed(cfg.brand.site),
  ]);

  return NextResponse.json(
    {
      checkedAt: new Date().toISOString(),
      ...health,
      // null when Google's keyless API throttled us. The page then says the
      // grade is still being measured instead of printing a score of nothing.
      speed,
    },
    { headers: { "Cache-Control": "public, s-maxage=21600, stale-while-revalidate=43200" } }
  );
}
