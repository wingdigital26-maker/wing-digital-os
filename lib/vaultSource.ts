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

// ── THE 1 MB CEILING (do not "simplify" this away) ───────────────────────────
// The REST Contents API only inlines file content for blobs up to 1 MB. Past
// that it still answers 200 with the metadata -- name, size, and crucially
// `sha` -- but with `content: ""` and `encoding: "none"`. No error status, no
// error body. A caller that just base64-decodes `content` gets nothing back and
// reports "no data", or worse renders an empty list as a real empty result.
//
// This was NOT hypothetical: wiki/state/cloud/prospects.json (~3.9 MB) and
// wiki/chronicler-inbox.md (~1.6 MB) were both returning null in cloud mode,
// silently, for every route that read them. Found 2026-09-04.
//
// The fix: when the Contents API withholds content, refetch the same blob by
// its sha through the Git Blobs API, which serves blobs up to 100 MB. The sha
// is already in the truncated Contents response, so it costs no extra lookup.
const CONTENTS_API_INLINE_LIMIT_BYTES = 1_048_576;

function decodeB64(content: unknown): string | null {
  if (typeof content !== "string" || content === "") return null;
  try {
    // GitHub wraps base64 at 60 chars; Buffer ignores the newlines.
    const out = Buffer.from(content, "base64").toString("utf-8");
    return out === "" ? null : out;
  } catch {
    return null;
  }
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
  if (!data || Array.isArray(data) || data.type === "dir") {
    fileCache.set(rel, { value: null, at: Date.now() });
    return null;
  }

  let content: string | null = null;
  if (data.encoding === "base64") content = decodeB64(data.content);

  const size = typeof data.size === "number" ? data.size : null;

  // Content withheld (over the ceiling, or empty for any other reason): go get
  // the blob by sha.
  if (content === null && size !== 0) {
    const sha = typeof data.sha === "string" ? data.sha : null;
    if (sha) {
      const blob = await ghApi(
        `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/git/blobs/${sha}`
      );
      // encoding !== base64 means >100 MB, where the Blobs API gives up too.
      if (blob && blob.encoding === "base64") {
        const out = decodeB64(blob.content);
        // If GitHub told us the size, the decoded payload must match it. A
        // mismatch means a truncated read, and serving a partial file is worse
        // than serving nothing: callers cannot tell it is incomplete.
        content =
          out !== null && size !== null && Buffer.byteLength(out, "utf-8") !== size
            ? null
            : out;
      }
    }
  }
  if (content === null && size === 0) content = ""; // genuinely empty file

  // Do not hold multi-MB payloads in the module cache across serverless
  // invocations; a re-fetch is cheaper than the memory.
  if (size === null || size <= CONTENTS_API_INLINE_LIMIT_BYTES) {
    fileCache.set(rel, { value: content, at: Date.now() });
  }
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

// ── GitHub write-back (contents API commit) ────────────────────────────────────
// Commit updated content for a single vault file to the private GitHub vault on
// GH_BRANCH. Used by cloud (Vercel) hosts that read the vault from GitHub and
// have no local disk to write to. Fetches the current blob sha first, then PUTs
// the new content. Never throws; returns a discriminated result the caller can
// degrade on. The token is only ever sent in the Authorization header and is
// never returned or logged.
export async function commitVaultFile(
  relPath: string,
  content: string,
  message: string
): Promise<{ ok: true; commit: string } | { ok: false; reason: string }> {
  const token = process.env.GH_VAULT_TOKEN;
  if (!token) return { ok: false, reason: "no vault token configured" };
  const rel = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
  const apiPath = rel.split("/").map(encodeURIComponent).join("/");
  const base = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/${apiPath}`;

  // Current sha (required to update an existing file). Absent -> create new.
  const cur = await ghApi(`${base}?ref=${GH_BRANCH}`);
  const sha = cur && typeof cur.sha === "string" ? cur.sha : undefined;

  try {
    const res = await fetch(base, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "wing-digital-os",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message,
        content: Buffer.from(content, "utf-8").toString("base64"),
        branch: GH_BRANCH,
        ...(sha ? { sha } : {}),
      }),
      cache: "no-store",
    });
    if (!res.ok) return { ok: false, reason: `github api ${res.status}` };
    const j = await res.json();
    // Invalidate caches so a follow-up /api/mission read reflects the new file.
    fileCache.delete(rel);
    treeCache = null;
    const commit = j?.commit?.sha;
    return { ok: true, commit: typeof commit === "string" ? commit : "unknown" };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.name : "put failed" };
  }
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
