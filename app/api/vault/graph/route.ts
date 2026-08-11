import { NextResponse } from "next/server";
import { listVaultFiles, readVaultFile } from "@/lib/vaultSource";

export const runtime = "nodejs";

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

    const content = (await readVaultFile(rel)) ?? "";
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
        graphCache = { value: g, at: Date.now() };
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
  const g = await refresh();
  return NextResponse.json(
    { ...g, cached: false },
    { headers: { "Cache-Control": CACHE_HEADER } }
  );
}
