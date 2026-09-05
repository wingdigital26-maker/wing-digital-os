import { NextResponse } from "next/server";
import { listVaultFiles, readVaultFile, isGithubVault } from "@/lib/vaultSource";

export const runtime = "nodejs";
// A cold build against the GitHub vault used to take 22-26 s (measured on
// production 2026-09-04: every one of ~270 files was fetched one after the
// other). Reads are now parallel, but give the function headroom anyway so a
// slow GitHub day returns a graph instead of a gateway timeout.
export const maxDuration = 60;
// How many vault files are read at once during a build. GitHub's secondary
// rate limits tolerate this comfortably; it turns ~270 sequential round trips
// into ~25 batches.
const READ_CONCURRENCY = 12;

// ── Always-loaded graph cache ──────────────────────────────────────────────
// Building the graph walks every vault file, which is slow (especially against
// the GitHub vault in cloud mode). We keep the last built graph in module
// memory and serve it instantly; when it goes stale we refresh in the
// BACKGROUND while still serving the cached copy, so the vault view never
// blocks on a rebuild after the first load.
const GRAPH_TTL_MS = 5 * 60 * 1000; // consider stale after 5 minutes

interface GraphPayload {
  nodes: { id: string; name: string; path: string; group: string }[];
  links: { source: string; target: string }[];
  builtAt: string;
  hash: string;
  // Set when the build could not see the vault at all (no files listed). The
  // client shows this instead of pretending the vault is empty.
  error?: string;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// Stable structural hash of the graph (node ids + link pairs). The client uses
// this as the change signal: same hash means the saved layout is still valid.
function graphHash(
  nodes: { id: string }[],
  links: { source: string; target: string }[]
): string {
  const parts = [
    ...nodes.map(n => n.id).sort(),
    ...links.map(l => `${l.source}>${l.target}`).sort(),
  ].join("|");
  // FNV-1a, 32-bit, hex
  let h = 0x811c9dc5;
  for (let i = 0; i < parts.length; i++) {
    h ^= parts.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

let graphCache: { value: GraphPayload; at: number } | null = null;
let building: Promise<GraphPayload> | null = null;

function extractWikilinks(content: string): string[] {
  // Match [[link]], [[link|alias]], [[link\|alias]] (escaped pipe in tables)
  const matches = content.matchAll(/\[\[([^\]|#\\]+)(?:[\\]?[|#][^\]]*)?\]\]/g);
  return [...matches].map(m => m[1].trim().toLowerCase().replace(/\\/g, ""));
}

function basename(rel: string): string {
  const file = rel.split("/").pop() ?? rel;
  return file.replace(/\.md$/, "");
}

// Classify a vault-relative path into a folder bucket. Robust against the
// differences between local disk paths and GitHub tree paths: normalizes
// separators + case, strips any vault-root prefix, and looks PAST the "wiki"
// umbrella folder to the meaningful subfolder (wiki/clients/x.md -> "clients").
function classifyGroup(rel: string): string {
  const norm = rel.replace(/\\/g, "/").replace(/^\/+/, "").toLowerCase();
  let parts = norm.split("/").filter(Boolean);
  // Strip a root-folder prefix if the path ever arrives absolute-ish
  // ("jacks ai brain 2.0/wiki/..." or the repo name).
  if (parts.length > 1 && (/brain/.test(parts[0]) || parts[0] === "wing-os-vault")) {
    parts = parts.slice(1);
  }
  if (parts.length <= 1) return "root";
  if (parts[0] === "wiki") {
    // wiki/clients/x.md -> clients; wiki/x.md -> wiki
    return parts.length >= 3 ? parts[1] : "wiki";
  }
  return parts[0];
}

async function buildGraph(): Promise<GraphPayload> {
  const allFiles = await listVaultFiles(); // relative paths, "/"-separated

  if (allFiles.length === 0) {
    // Nothing listed means the source is unreachable (missing token, GitHub
    // down, wrong VAULT_PATH), not an empty vault. Say so.
    const src = isGithubVault() ? "the GitHub vault" : "the local vault folder";
    return {
      nodes: [], links: [], builtAt: new Date().toISOString(), hash: "0",
      error: `No notes could be listed from ${src}. Check the vault source configuration.`,
    };
  }

  // Read every file up front, a bounded number at a time (see READ_CONCURRENCY).
  const contents = new Map<string, string>();
  const bodies = await mapLimit(allFiles, READ_CONCURRENCY, rel => readVaultFile(rel));
  allFiles.forEach((rel, i) => contents.set(rel, bodies[i] ?? ""));

  // Build both filename and relative-path lookups
  const nameMap: Record<string, string> = {};
  for (const rel of allFiles) {
    const name = basename(rel).toLowerCase();
    nameMap[name] = rel;                                  // "charles-palma" → "wiki/clients/charles-palma.md"
    nameMap[rel.replace(".md", "").toLowerCase()] = rel;  // "wiki/clients/charles-palma" → full path
    const parts = rel.replace(".md", "").toLowerCase().split("/");
    if (parts.length > 1) {
      nameMap[parts.slice(1).join("/")] = rel;            // "clients/charles-palma"
    }
  }

  const nodes: { id: string; name: string; path: string; group: string }[] = [];
  const links: { source: string; target: string }[] = [];
  const nodeIds = new Set<string>();

  for (const rel of allFiles) {
    const name = basename(rel);
    const group = classifyGroup(rel);

    if (!nodeIds.has(rel)) {
      nodes.push({ id: rel, name, path: rel, group });
      nodeIds.add(rel);
    }

    const content = contents.get(rel) ?? "";
    if (!content) continue;

    const wikilinks = extractWikilinks(content);
    for (const link of wikilinks) {
      const targetPath = nameMap[link];
      if (targetPath && targetPath !== rel) {
        links.push({ source: rel, target: targetPath });
      }
    }
  }

  // Bucket distribution log — sanity check that classification is not
  // collapsing everything into one bucket (the "all the same color" bug).
  const buckets: Record<string, number> = {};
  for (const n of nodes) buckets[n.group] = (buckets[n.group] ?? 0) + 1;
  console.log(
    "[vault/graph] bucket distribution:",
    JSON.stringify(buckets),
    "sample paths:",
    nodes.slice(0, 5).map(n => n.path).join(", ")
  );

  return { nodes, links, builtAt: new Date().toISOString(), hash: graphHash(nodes, links) };
}

function refresh(): Promise<GraphPayload> {
  if (!building) {
    building = buildGraph()
      .then(g => {
        // Never cache a failed build: the next request should try again.
        if (!g.error) graphCache = { value: g, at: Date.now() };
        return g;
      })
      .finally(() => {
        building = null;
      });
  }
  return building;
}

// CDN cache: on Vercel the auth middleware runs BEFORE the edge cache lookup,
// so unauthorized requests never reach a cached copy; s-maxage lets the CDN
// answer warm requests without even invoking the (cold-startable) function.
// stale-while-revalidate keeps first paint instant while a refresh happens.
const CACHE_HEADER = "max-age=0, s-maxage=300, stale-while-revalidate=1800";

export async function GET() {
  if (graphCache) {
    // Serve instantly; kick off a background rebuild if stale.
    if (Date.now() - graphCache.at > GRAPH_TTL_MS) {
      refresh().catch(() => {});
    }
    return NextResponse.json(
      { ...graphCache.value, cached: true },
      { headers: { "Cache-Control": CACHE_HEADER } }
    );
  }
  // First request since boot: build once (deduped if concurrent).
  let g: GraphPayload;
  try {
    g = await refresh();
  } catch (e) {
    const reason = e instanceof Error ? e.message : "build failed";
    return NextResponse.json(
      { nodes: [], links: [], builtAt: new Date().toISOString(), hash: "0", cached: false, error: `The graph build failed: ${reason}` },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
  return NextResponse.json(
    { ...g, cached: false },
    // A failed build must not be parked on the CDN for 30 minutes.
    { status: g.error ? 503 : 200, headers: { "Cache-Control": g.error ? "no-store" : CACHE_HEADER } }
  );
}
