import { listVaultFiles, readVaultFile } from "@/lib/vaultSource";

// Read every .md directly inside a vault folder (non-recursive), returning
// { name, content } for non-empty files. Works in both local and GitHub modes.
async function readFolder(folder: string): Promise<{ name: string; content: string }[]> {
  const prefix = folder.replace(/\/+$/, "") + "/";
  const files = (await listVaultFiles()).filter(
    (rel) => rel.startsWith(prefix) && !rel.slice(prefix.length).includes("/")
  );
  const out: { name: string; content: string }[] = [];
  for (const rel of files) {
    const content = (await readVaultFile(rel)) ?? "";
    if (content.trim().length > 0) {
      out.push({ name: (rel.split("/").pop() ?? rel).replace(".md", ""), content });
    }
  }
  return out;
}

export async function loadPermanentVaultContext(): Promise<string> {
  const sections: string[] = [];

  // 1. CLAUDE.md -- master schema, read first (same as Claude CLI)
  const claudeMd = await readVaultFile("CLAUDE.md");
  if (claudeMd) sections.push(`## CLAUDE.md\n${claudeMd}`);

  // 2. Agent context (who Jack is, Wing Digital overview)
  const agentCtx = await readVaultFile("wiki/agent-context.md");
  if (agentCtx) sections.push(`## Agent Context\n${agentCtx}`);

  // 2. Hot cache (what's happening right now)
  const hot = await readVaultFile("wiki/hot.md");
  if (hot) sections.push(`## Current Focus (hot.md)\n${hot}`);

  // 3. Active clients
  const clients = await readFolder("wiki/clients");
  if (clients.length > 0) {
    sections.push(`## Clients\n${clients.map(c => `### ${c.name}\n${c.content}`).join("\n\n")}`);
  }

  // 4. Campaigns
  const campaigns = await readFolder("wiki/campaigns");
  if (campaigns.length > 0) {
    sections.push(`## Campaigns\n${campaigns.map(c => `### ${c.name}\n${c.content}`).join("\n\n")}`);
  }

  return sections.join("\n\n---\n\n");
}
