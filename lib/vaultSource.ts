// Vault source abstraction.
//
// Reads the Obsidian vault markdown from EITHER:
//   - the local filesystem at process.env.VAULT_PATH (default: Jack's OneDrive
//     Obsidian folder) when running locally, OR
//   - the private GitHub repo `wingdigital26-maker/wing-os-vault` via the GitHub
//     REST API (token in process.env.GH_VAULT_TOKEN) when VAULT_SOURCE === "github".
//
// This lets the same routes serve the vault both on Jack's PC and on a cloud host
// that has no access to his local files.
//
// Public helpers:
//   VAULT_PATH            local vault root (also the write target in local mode)
//   isGithubVault()       true when reading from GitHub
//   listVaultTree()       nested folder/file tree of .md files (for the file browser)
//   listVaultFiles()      flat list of .md relative paths (for search / graph walks)
//   readVaultFile(rel)    file contents, or null if missing

import fs from "fs";
import path from "path";

export const VAULT_PATH =
  process.env.VAULT_PATH ||
  "C:\\Users\\wjack\\OneDrive\\Documentos\\Obsidian 2.0\\Jacks Ai Brain 2.0";

const GH_OWNER = "wingdigital26-maker";
const GH_REPO = "wing-os-vault";
const GH_BRANCH = process.env.GH_VAULT_BRANCH || "main";

// Folders/files we never surface (same ignore list the local routes used).
const IGNORE = new Set([".obsidian", ".claude", "node_modules", "raw", "assets"]);

export interface VaultFileNode {
  name: string;
  path: string;
  type: "file" | "folder";
  children?: VaultFileNode[];
}

export function isGithubVault(): boolean {
  return process.env.VAULT_SOURCE === "github";
}

function isIgnored(relPath: string): boolean {
  const parts = relPath.split("/");
  return parts.some((p) => IGNORE.has(p) || p.startsWith("."));
}

// ── In-memory cache for GitHub responses (brief, to survive request bursts) ────
const CACHE_TTL_MS = 60_000;
interface CacheEntry<T> {
  value: T;
  at: number;
}
let treeCache: CacheEntry<string[]> | null = null;
const fileCache = new Map<string, CacheEntry<string | null>>();

function fresh<T>(e: CacheEntry<T> | null | undefined): e is CacheEntry<T> {
  return !!e && Date.now() - e.at < CACHE_TTL_MS;
}

async function ghApi(url: string): Promise<any | null> {
  const token = process.env.GH_VAULT_TOKEN;
  if (!token) return null;
  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "wing-digital-os",
      },
      cache: "no-store",
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// Flat list of all .md relative paths in the GitHub vault (cached).
async function githubListFiles(): Promise<string[]> {
  if (fresh(treeCache)) return treeCache.value;
  const data = await ghApi(
    `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/git/trees/${GH_BRANCH}?recursive=1`
  );
  const files: string[] = [];
  for (const node of data?.tree ?? []) {
    if (node.type !== "blob") continue;
    const p: string = node.path;
    if (!p.endsWith(".md")) continue;
    if (isIgnored(p)) continue;
    files.push(p);
  }
  treeCache = { value: files, at: Date.now() };
  return files;
}

async function githubReadFile(relPath: string): Promise<string | null> {
  const rel = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
  const cached = fileCache.get(rel);
  if (fresh(cached)) return cached.value;
  // raw.githubusercontent needs the token via the contents API to stay private.
  const data = await ghApi(
    `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/${rel
      .split("/")
      .map(encodeURIComponent)
      .join("/")}?ref=${GH_BRANCH}`
  );
  let content: string | null = null;
  if (data && typeof data.content === "string" && data.encoding === "base64") {
    try {
      content = Buffer.from(data.content, "base64").toString("utf-8");
    } catch {
      content = null;
    }
  }
  fileCache.set(rel, { value: content, at: Date.now() });
  return content;
}

// ── Local filesystem implementations ───────────────────────────────────────────
function localListFiles(dir = VAULT_PATH, files: string[] = []): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    if (IGNORE.has(entry.name) || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) localListFiles(full, files);
    else if (entry.name.endsWith(".md")) {
      files.push(path.relative(VAULT_PATH, full).replace(/\\/g, "/"));
    }
  }
  return files;
}

function localReadFile(relPath: string): string | null {
  const rel = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
  const abs = path.resolve(VAULT_PATH, rel);
  const root = VAULT_PATH.endsWith(path.sep) ? VAULT_PATH : VAULT_PATH + path.sep;
  if (abs !== VAULT_PATH && !abs.startsWith(root)) return null; // escape guard
  try {
    return fs.readFileSync(abs, "utf-8");
  } catch {
    return null;
  }
}

// Build a nested tree from a flat list of relative paths.
function buildTree(relPaths: string[]): VaultFileNode[] {
  const root: VaultFileNode[] = [];
  for (const rel of relPaths.slice().sort()) {
    const parts = rel.split("/");
    let level = root;
    let acc = "";
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      acc = acc ? `${acc}/${part}` : part;
      const isFile = i === parts.length - 1;
      if (isFile) {
        level.push({ name: part.replace(/\.md$/, ""), path: rel, type: "file" });
      } else {
        let folder = level.find((n) => n.type === "folder" && n.name === part);
        if (!folder) {
          folder = { name: part, path: acc, type: "folder", children: [] };
          level.push(folder);
        }
        level = folder.children!;
      }
    }
  }
  const sortNodes = (nodes: VaultFileNode[]) => {
    nodes.sort((a, b) => {
      if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const n of nodes) if (n.children) sortNodes(n.children);
  };
  sortNodes(root);
  return root;
}

// ── Public API ─────────────────────────────────────────────────────────────────
export async function listVaultFiles(): Promise<string[]> {
  return isGithubVault() ? githubListFiles() : localListFiles();
}

export async function listVaultTree(): Promise<VaultFileNode[]> {
  const files = await listVaultFiles();
  return buildTree(files);
}

export async function readVaultFile(relPath: string): Promise<string | null> {
  return isGithubVault() ? githubReadFile(relPath) : localReadFile(relPath);
}
