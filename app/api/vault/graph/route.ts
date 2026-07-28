import { NextResponse } from "next/server";
import { listVaultFiles, readVaultFile } from "@/lib/vaultSource";

export const runtime = "nodejs";

function extractWikilinks(content: string): string[] {
  // Match [[link]], [[link|alias]], [[link\|alias]] (escaped pipe in tables)
  const matches = content.matchAll(/\[\[([^\]|#\\]+)(?:[\\]?[|#][^\]]*)?\]\]/g);
  return [...matches].map(m => m[1].trim().toLowerCase().replace(/\\/g, ""));
}

function basename(rel: string): string {
  const file = rel.split("/").pop() ?? rel;
  return file.replace(/\.md$/, "");
}

export async function GET() {
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

  return NextResponse.json({ nodes, links });
}
