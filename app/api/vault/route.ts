import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";

const VAULT = "C:\\Users\\wjack\\OneDrive\\Documentos\\Obsidian 2.0\\Jacks Ai Brain 2.0";

const IGNORE = [".obsidian", ".claude", "node_modules", "raw", "assets"];

interface FileNode {
  name: string;
  path: string;
  type: "file" | "folder";
  children?: FileNode[];
}

function readDir(dir: string, relativeTo: string): FileNode[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const nodes: FileNode[] = [];

  for (const entry of entries) {
    if (IGNORE.includes(entry.name)) continue;
    if (entry.name.startsWith(".")) continue;

    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(relativeTo, fullPath).replace(/\\/g, "/");

    if (entry.isDirectory()) {
      nodes.push({
        name: entry.name,
        path: relPath,
        type: "folder",
        children: readDir(fullPath, relativeTo),
      });
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      nodes.push({ name: entry.name.replace(".md", ""), path: relPath, type: "file" });
    }
  }

  return nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

export async function GET() {
  const tree = readDir(VAULT, VAULT);
  return NextResponse.json({ tree, vault: VAULT });
}
