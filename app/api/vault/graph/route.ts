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
    const group = rel.split("/")[0];

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

  return { nodes, links, builtAt: new Date().toISOString() };
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

export async function GET() {
  if (graphCache) {
    // Serve instantly; kick off a background rebuild if stale.
    if (Date.now() - graphCache.at > GRAPH_TTL_MS) {
      refresh().catch(() => {});
    }
    return NextResponse.json({ ...graphCache.value, cached: true });
  }
  // First request since boot: build once (deduped if concurrent).
  const g = await refresh();
  return NextResponse.json({ ...g, cached: false });
}
