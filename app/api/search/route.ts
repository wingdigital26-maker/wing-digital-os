import { NextRequest, NextResponse } from "next/server";
import { listVaultFiles, readVaultFile } from "@/lib/vaultSource";

export const runtime = "nodejs";

const MAX_VAULT_RESULTS = 5;

async function searchVault(query: string): Promise<{ name: string; path: string; excerpt: string }[]> {
  const q = query.toLowerCase();
  const results: { name: string; path: string; excerpt: string }[] = [];

  const files = await listVaultFiles();
  for (const rel of files) {
    if (results.length >= MAX_VAULT_RESULTS) break;
    const name = (rel.split("/").pop() ?? rel).replace(".md", "");

    // Match filename first (fastest)
    if (name.toLowerCase().includes(q)) {
      results.push({ name, path: rel, excerpt: "Filename match" });
      continue;
    }

    // Then scan content -- stop after finding first match
    const content = await readVaultFile(rel);
    if (!content) continue;
    const idx = content.toLowerCase().indexOf(q);
    if (idx !== -1) {
      const start = Math.max(0, idx - 60);
      const excerpt = "..." + content.slice(start, idx + 80).replace(/\n/g, " ").trim() + "...";
      results.push({ name, path: rel, excerpt });
    }
  }

  return results;
}

export async function GET(req: NextRequest) {
  const query = req.nextUrl.searchParams.get("q")?.trim() ?? "";
  if (!query || query.length < 2) return NextResponse.json({ contacts: [], notes: [] });

  // Contact search retired with GHL (2026-08-22): no CRM contact source is
  // connected, so `contacts` is always empty rather than silently failing.
  const notes = await searchVault(query);
  return NextResponse.json({ contacts: [], notes, crm: "GHL retired 2026-08-22, no replacement connected" });
}
