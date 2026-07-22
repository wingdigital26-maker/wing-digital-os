import fs from "fs";
import path from "path";

const VAULT = "C:\\Users\\wjack\\OneDrive\\Documentos\\Obsidian 2.0\\Jacks Ai Brain 2.0";

function readFile(filePath: string): string {
  try { return fs.readFileSync(filePath, "utf-8"); }
  catch { return ""; }
}

function readFolder(folderPath: string): { name: string; content: string }[] {
  try {
    return fs.readdirSync(folderPath)
      .filter(f => f.endsWith(".md"))
      .map(f => ({
        name: f.replace(".md", ""),
        content: readFile(path.join(folderPath, f)),
      }))
      .filter(f => f.content.trim().length > 0);
  } catch { return []; }
}

export function loadPermanentVaultContext(): string {
  const sections: string[] = [];

  // 1. CLAUDE.md -- master schema, read first (same as Claude CLI)
  const claudeMd = readFile(path.join(VAULT, "CLAUDE.md"));
  if (claudeMd) sections.push(`## CLAUDE.md\n${claudeMd}`);

  // 2. Agent context (who Jack is, Wing Digital overview)
  const agentCtx = readFile(path.join(VAULT, "wiki", "agent-context.md"));
  if (agentCtx) sections.push(`## Agent Context\n${agentCtx}`);

  // 2. Hot cache (what's happening right now)
  const hot = readFile(path.join(VAULT, "wiki", "hot.md"));
  if (hot) sections.push(`## Current Focus (hot.md)\n${hot}`);

  // 3. Active clients
  const clients = readFolder(path.join(VAULT, "wiki", "clients"));
  if (clients.length > 0) {
    sections.push(`## Clients\n${clients.map(c => `### ${c.name}\n${c.content}`).join("\n\n")}`);
  }

  // 4. Campaigns
  const campaigns = readFolder(path.join(VAULT, "wiki", "campaigns"));
  if (campaigns.length > 0) {
    sections.push(`## Campaigns\n${campaigns.map(c => `### ${c.name}\n${c.content}`).join("\n\n")}`);
  }

  return sections.join("\n\n---\n\n");
}
