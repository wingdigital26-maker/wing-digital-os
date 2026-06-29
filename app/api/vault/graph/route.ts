import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";

const VAULT = "C:\\Users\\wjack\\OneDrive\\Documentos\\Obsidian 2.0\\Jacks Ai Brain 2.0";
const IGNORE = [".obsidian", ".claude", "node_modules", "assets"];

function getAllFiles(dir: string, files: string[] = []): string[] {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return files; }

  for (const entry of entries) {
    if (IGNORE.includes(entry.name) || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) getAllFiles(full, files);
    else if (entry.name.endsWith(".md")) files.push(full);
  }
  return files;
}

function extractWikilinks(content: string): string[] {
  const matches = content.matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g);
  return [...matches].map(m => m[1].trim().toLowerCase());
}

export async function GET() {
  const allFiles = getAllFiles(VAULT);

  // Build name → path map
  const nameMap: Record<string, string> = {};
  for (const file of allFiles) {
    const name = path.basename(file, ".md").toLowerCase();
    const rel = path.relative(VAULT, file).replace(/\\/g, "/");
    nameMap[name] = rel;
  }

  // Build nodes and links
  const nodes: { id: string; name: string; path: string; group: string }[] = [];
  const links: { source: string; target: string }[] = [];
  const nodeIds = new Set<string>();

  for (const file of allFiles) {
    const rel = path.relative(VAULT, file).replace(/\\/g, "/");
    const name = path.basename(file, ".md");
    const group = rel.split("/")[0];

    if (!nodeIds.has(rel)) {
      nodes.push({ id: rel, name, path: rel, group });
      nodeIds.add(rel);
    }

    let content = "";
    try { content = fs.readFileSync(file, "utf-8"); } catch { continue; }

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
