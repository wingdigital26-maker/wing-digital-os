// SEO output per client: what is live on each client's site, read from the
// site's own public sitemap, plus each content agent's last run. Server-only.
//
// Dating rule (honest): a sitemap's <lastmod> is when a page last CHANGED, not
// when it first went live. So "published this week" here means "new or changed
// this week" and the screen says so. The client dashboards (/dashboards/<slug>)
// date posts from the repo history and are linked for the exact record.
import { CLIENTS as DASHBOARDS } from "@/app/api/dashboard/clients";
import { withStore } from "./db";
import { contentEngineNotes, type AgentRunNote } from "./vault";
import { dayCT, monthStart, weekStart } from "./time";

export type SeoPage = { url: string; lastmod: string | null; kind: "post" | "page" };
export type SeoClient = {
  slug: string;
  name: string;
  site: string;
  ok: boolean;
  error: string | null;
  total: number;
  posts: number;
  servicePages: number;
  thisWeek: SeoPage[];
  thisMonth: number;
  undated: number;
  dashboard: string | null;
};

const POST_RE = /\/(blog|posts?|news|articles?|insights|resources)\//i;

function host(u: string): string {
  try {
    return new URL(u).host.replace(/^www\./, "");
  } catch {
    return u;
  }
}

async function getText(url: string): Promise<string | null> {
  try {
    const r = await fetch(url, { next: { revalidate: 3600 }, signal: AbortSignal.timeout(12000) });
    return r.ok ? await r.text() : null;
  } catch {
    return null;
  }
}

function parse(xml: string): { loc: string; lastmod: string | null }[] {
  const out: { loc: string; lastmod: string | null }[] = [];
  const re = /<(url|sitemap)>([\s\S]*?)<\/\1>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const loc = m[2].match(/<loc>\s*([^<\s]+)\s*<\/loc>/)?.[1];
    const lm = m[2].match(/<lastmod>\s*([^<\s]+)\s*<\/lastmod>/)?.[1] ?? null;
    if (loc) out.push({ loc: loc.replace(/&amp;/g, "&"), lastmod: lm });
  }
  return out;
}

export async function sitemapPages(site: string): Promise<SeoPage[] | null> {
  const root = site.replace(/\/+$/, "");
  const xml = await getText(`${root}/sitemap.xml`);
  if (!xml) return null;
  let entries = parse(xml);
  if (/<sitemapindex/i.test(xml)) {
    const children = await Promise.all(entries.slice(0, 8).map((e) => getText(e.loc)));
    entries = children.flatMap((c) => (c ? parse(c) : []));
  }
  const seen = new Set<string>();
  return entries
    .filter((e) => (seen.has(e.loc) ? false : (seen.add(e.loc), true)))
    .map((e) => ({ url: e.loc, lastmod: !e.lastmod ? null : /^\d{4}-\d{2}-\d{2}$/.test(e.lastmod) ? e.lastmod : dayCT(e.lastmod), kind: POST_RE.test(e.loc) ? "post" : "page" }));
}

export async function seoForClients(list: { slug: string; name: string; liveSite: string | null }[]): Promise<SeoClient[]> {
  const today = dayCT();
  const wk = weekStart(today);
  const mo = monthStart(today);
  const withSite = list.filter((c) => c.liveSite);
  return Promise.all(
    withSite.map(async (c) => {
      const site = c.liveSite!;
      const dash = Object.entries(DASHBOARDS).find(([, cfg]) =>
        [cfg.brand.site, ...cfg.sources.map((s) => s.site || "")].some((s) => s && host(s) === host(site))
      );
      const pages = await sitemapPages(site);
      if (!pages) {
        return {
          slug: c.slug, name: c.name, site, ok: false, error: "Sitemap could not be read", total: 0, posts: 0,
          servicePages: 0, thisWeek: [], thisMonth: 0, undated: 0, dashboard: dash ? `/dashboards/${dash[0]}` : null,
        };
      }
      return {
        slug: c.slug,
        name: c.name,
        site,
        ok: true,
        error: null,
        total: pages.length,
        posts: pages.filter((p) => p.kind === "post").length,
        servicePages: pages.filter((p) => p.kind === "page").length,
        thisWeek: pages.filter((p) => p.lastmod && p.lastmod >= wk).sort((a, b) => (b.lastmod! > a.lastmod! ? 1 : -1)),
        thisMonth: pages.filter((p) => p.lastmod && p.lastmod >= mo).length,
        undated: pages.filter((p) => !p.lastmod).length,
        dashboard: dash ? `/dashboards/${dash[0]}` : null,
      };
    })
  );
}

export type AgentRun = { agent: string; client: string | null; status: string; published: number | null; note: string | null; at: string | null; source: "reported" | "vault" };

/** Each content agent's last run: reported runs first, vault notes for the rest. */
export async function agentRuns(): Promise<{ runs: AgentRun[]; error: string | null }> {
  const [reported, notes] = await Promise.all([
    withStore((sql) =>
      sql<{ agent: string; client_slug: string | null; status: string; published: number | null; note: string | null; ran_at: string }[]>`
        select distinct on (agent) agent, client_slug, status, published, note, ran_at::text
          from cc_agent_runs order by agent, ran_at desc`
    ),
    contentEngineNotes().catch((): AgentRunNote[] => []),
  ]);
  const runs = new Map<string, AgentRun>();
  for (const n of notes) {
    runs.set(n.agent, { agent: n.agent, client: n.client, status: "from the vault", published: null, note: n.text, at: n.when, source: "vault" });
  }
  if (reported.ok) {
    for (const r of reported.data) {
      const prev = runs.get(r.agent);
      if (!prev || !prev.at || r.ran_at > prev.at) {
        runs.set(r.agent, { agent: r.agent, client: r.client_slug, status: r.status, published: r.published, note: r.note, at: r.ran_at, source: "reported" });
      }
    }
  }
  return { runs: [...runs.values()].sort((a, b) => a.agent.localeCompare(b.agent)), error: reported.ok ? null : reported.reason };
}
