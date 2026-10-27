// Everything the Command Center reads from the vault. Server-only.
//
// Sources (all through lib/vaultSource, so it works on the laptop and in the
// cloud with VAULT_SOURCE=github + GH_VAULT_TOKEN):
//   wiki/clients/<slug>.md          the client roster (frontmatter + Sentinel Config)
//   wiki/clients/<slug>-health.md   the sentinel agent's daily health page
//   wiki/state/health-board.md      sentinel's last-completed line
//   wiki/state/watchdog.md          content-engine run notes
//
// Nothing here invents a value: a field the vault does not carry comes back
// null and the UI says "not recorded".
import { listVaultFiles, readVaultFile } from "../vaultSource";

export type Health = "green" | "yellow" | "red" | "unknown";

export type VaultClient = {
  slug: string;
  name: string;
  industry: string | null;
  location: string | null;
  status: string;
  revenueAmount: number | null;
  revenueBasis: string | null;
  liveSite: string | null;
  phase: string | null;
  contactPhone: string | null;
  contactName: string | null;
  isRoofer: boolean;
  path: string;
};

export type HealthPage = {
  slug: string;
  color: Health;
  checkedAt: string | null; // ISO, from frontmatter `updated`
  phase: string | null;
  headline: string;
  reds: string[];
  yellows: string[];
  published: string | null;
  /** The URL sentinel actually monitors, when the page names one. */
  surface: string | null;
  path: string;
};

// ── tiny frontmatter reader (the subset the vault uses) ──────────────────────
export function frontmatter(md: string): Record<string, string | string[]> {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const out: Record<string, string | string[]> = {};
  if (!m) return out;
  let listKey: string | null = null;
  for (const line of m[1].split(/\r?\n/)) {
    const item = line.match(/^\s+-\s+(.*)$/);
    if (item && listKey) {
      (out[listKey] as string[]).push(unquote(item[1]));
      continue;
    }
    const kv = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (!kv) continue;
    const [, k, v] = kv;
    if (v === "") {
      out[k] = [];
      listKey = k;
    } else if (v.startsWith("[") && v.endsWith("]")) {
      out[k] = v.slice(1, -1).split(",").map((x) => unquote(x.trim())).filter(Boolean);
      listKey = null;
    } else {
      out[k] = unquote(v);
      listKey = null;
    }
  }
  return out;
}

function unquote(s: string): string {
  return s.replace(/^["']|["']$/g, "").trim();
}

function str(v: string | string[] | undefined): string | null {
  if (typeof v === "string" && v && !v.includes("{{")) return v;
  return null;
}

function section(md: string, heading: RegExp): string | null {
  const lines = md.split(/\r?\n/);
  const start = lines.findIndex((l) => /^##\s/.test(l) && heading.test(l));
  if (start < 0) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^##\s/.test(l));
  return (end < 0 ? rest : rest.slice(0, end)).join("\n").trim();
}

/** Top-level numbered or bulleted items of a section, wrapped lines joined. */
function items(body: string | null): string[] {
  if (!body) return [];
  const out: string[] = [];
  for (const l of body.split(/\r?\n/)) {
    const m = l.match(/^(?:\d+\.|-)\s+(.*)$/);
    if (m) out.push(m[1]);
    else if (/^\s+\S/.test(l) && out.length) out[out.length - 1] += ` ${l.trim()}`;
  }
  return out.map(clean).filter((x) => x && !/^none( new)?\.?$/i.test(x));
}

/** Strip markdown emphasis and links down to readable text. */
export function clean(s: string): string {
  return s
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/\*\*/g, "")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, "$2")
    .replace(/\[([^\]]*)\]\(([^)]*)\)/g, "$1")
    .replace(/\s+--\s+/g, ", ")
    .replace(/\u2014/g, ", ")
    .trim();
}

function colorFrom(s: string): Health {
  if (/🔴|\bred\b/i.test(s)) return "red";
  if (/🟡|\byellow\b|\bamber\b/i.test(s)) return "yellow";
  if (/🟢|\bgreen\b/i.test(s)) return "green";
  return "unknown";
}

// Not client pages: templates and indexes, and Wing's own page.
const SKIP = /^(_|index|dashboard-links|wing-digital\.md$)/;

/** A sentinel health page (by content, since a client slug can itself end in "-health"). */
function isHealthPage(fm: Record<string, string | string[]>): boolean {
  const tags = Array.isArray(fm.tags) ? fm.tags : [];
  return tags.includes("sentinel") || /\s-\s*Health$/i.test(str(fm.title) ?? "");
}

export function slugify(s: string): string {
  return s.toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/** Active Wing clients from wiki/clients/*.md. */
export async function vaultClients(): Promise<{ clients: VaultClient[]; error: string | null }> {
  const files = await listVaultFiles();
  if (!files.length) {
    return { clients: [], error: "The vault could not be read (VAULT_SOURCE / GH_VAULT_TOKEN on this deployment)." };
  }
  const top = files.filter((f) => /^wiki\/clients\/[^/]+\.md$/.test(f));
  const healthSlugs = new Set((await healthPages()).keys());
  const out: VaultClient[] = [];
  await Promise.all(
    top
      .filter((f) => !SKIP.test(f.slice("wiki/clients/".length)))
      .map(async (path) => {
        const md = await readVaultFile(path);
        if (!md) return;
        const fm = frontmatter(md);
        if (isHealthPage(fm)) return;
        const slug = path.slice("wiki/clients/".length, -3);
        const status = (str(fm.status) || "").toLowerCase();
        if (!status.startsWith("active")) return;
        const tags = Array.isArray(fm.tags) ? fm.tags : [];
        const sentinel = section(md, /Sentinel Config/i);
        const isClient =
          Boolean(str(fm.client_name)) ||
          Boolean(str(fm.revenue_amount)) ||
          tags.includes("wing-digital-client") ||
          Boolean(sentinel) ||
          healthSlugs.has(slug);
        if (!isClient) return;
        const h1 = md.match(/^#\s+(.+)$/m)?.[1];
        const name = str(fm.client_name) || (h1 ? clean(h1.split(/\s+--\s+/)[0]) : slug);
        const industry = str(fm.industry);
        const live = sentinel?.match(/live_site\W+\s*(https?:\/\/[^\s)`*]+)/i)?.[1] ?? null;
        const phase = sentinel?.match(/`?phase`?\W+\s*([a-z-]+)/i)?.[1] ?? null;
        const contact = section(md, /Contact/i) || "";
        const amount = Number(str(fm.revenue_amount));
        out.push({
          slug,
          name,
          industry,
          location: str(fm.location),
          status,
          revenueAmount: Number.isFinite(amount) && amount > 0 ? amount : null,
          revenueBasis: str(fm.revenue_basis),
          liveSite: live ? live.replace(/[.,]$/, "") : null,
          phase,
          contactPhone: contact.match(/\*\*Phone:\*\*\s*([()+\d.\s-]{10,})/)?.[1]?.trim() ?? null,
          contactName: str(fm.owner) || contact.match(/\*\*(?:Owner|Practitioner):\*\*\s*([^,\n(]+)/)?.[1]?.trim() || null,
          isRoofer: /roof/i.test(`${industry ?? ""} ${tags.join(" ")}`),
          path,
        });
      })
  );
  // Project sub-pages ("renewal-health-site-v2") belong to their client, not the roster.
  const slugs = out.map((c) => c.slug);
  const roster = out.filter((c) => !slugs.some((o) => o !== c.slug && c.slug.startsWith(`${o}-`)));
  roster.sort((a, b) => a.name.localeCompare(b.name));
  return { clients: roster, error: null };
}

/** Every sentinel health page, keyed by client slug. */
export async function healthPages(): Promise<Map<string, HealthPage>> {
  const files = (await listVaultFiles()).filter((f) => /^wiki\/clients\/[^/]+-health\.md$/.test(f));
  const map = new Map<string, HealthPage>();
  await Promise.all(
    files.map(async (path) => {
      const md = await readVaultFile(path);
      if (!md) return;
      const slug = path.slice("wiki/clients/".length, -"-health.md".length);
      const fm = frontmatter(md);
      if (!isHealthPage(fm)) return;
      const h1 = md.match(/^#\s+(.+)$/m)?.[1] ?? "";
      const updated = str(fm.updated);
      const t = updated ? Date.parse(updated) : NaN;
      map.set(slug, {
        slug,
        color: colorFrom(h1),
        checkedAt: Number.isFinite(t) ? new Date(t).toISOString() : null,
        phase: h1.match(/phase:\s*([a-z-]+)/i)?.[1] ?? null,
        headline: clean(h1.replace(/[🔴🟡🟢⚪]/gu, "")),
        reds: items(section(md, /Red flags/i)),
        yellows: items(section(md, /Recommendations/i)),
        published: section(md, /Published since/i)?.split(/\r?\n/).map(clean).join(" ").trim() || null,
        surface: md.match(/Monitored surface:\s*(https?:\/\/[^\s)]+)/i)?.[1]?.replace(/[.,]$/, "") ?? null,
        path,
      });
    })
  );
  return map;
}

export const STALE_HOURS = 36;

export function isStale(checkedAt: string | null, now = Date.now()): boolean {
  if (!checkedAt) return true;
  return now - Date.parse(checkedAt) > STALE_HOURS * 3600_000;
}

/** Raw client page text, for the client detail screen. */
export async function clientPage(slug: string): Promise<string | null> {
  if (!/^[a-z0-9-]+$/.test(slug)) return null;
  return readVaultFile(`wiki/clients/${slug}.md`);
}

export type AgentRunNote = { agent: string; client: string | null; when: string | null; text: string };

/**
 * Content-engine runs as the vault records them: "<engine> last ran <ISO>" and
 * "<engine> log <dates>: published N" lines in the health pages and the
 * watchdog. Best effort: an engine not mentioned simply does not appear.
 */
export async function contentEngineNotes(): Promise<AgentRunNote[]> {
  const paths = [
    "wiki/state/watchdog.md",
    ...(await listVaultFiles()).filter((f) => /^wiki\/clients\/[^/]+-health\.md$/.test(f)),
  ];
  const seen = new Map<string, AgentRunNote>();
  for (const p of paths) {
    const md = await readVaultFile(p);
    if (!md) continue;
    const client = p.includes("-health.md") ? p.slice("wiki/clients/".length, -"-health.md".length) : null;
    const re = /`?([a-z0-9]+(?:-[a-z0-9]+)*-content-(?:weekly|engine|daily)[a-z0-9-]*)`?\s+(last ran\s+([0-9TZ:+\-.]+)[^.\n]*|log[^.\n]*)/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(md))) {
      const agent = m[1].toLowerCase();
      const when = m[3] ? new Date(Date.parse(m[3].replace(/\.$/, ""))).toISOString() : null;
      const prev = seen.get(agent);
      if (!prev || (when && (!prev.when || when > prev.when))) {
        seen.set(agent, { agent, client, when: when && !when.startsWith("Invalid") ? when : prev?.when ?? null, text: clean(m[0]).slice(0, 220) });
      }
    }
  }
  return [...seen.values()];
}

/** Sentinel's own last-completed line from the health board. */
export async function sentinelLastRun(): Promise<string | null> {
  const md = await readVaultFile("wiki/state/health-board.md");
  if (!md) return null;
  const line = md.match(/Sentinel last completed:[^\n]*/)?.[0];
  return line ? clean(line) : null;
}
