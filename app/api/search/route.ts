import { NextRequest, NextResponse } from "next/server";
import { listVaultFiles, readVaultFile } from "@/lib/vaultSource";

export const runtime = "nodejs";

const GHL_API_KEY = process.env.GHL_API_KEY!;
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID!;
const MAX_VAULT_RESULTS = 5;
const MAX_GHL_RESULTS = 5;

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

async function searchGHL(query: string) {
  try {
    const res = await fetch(
      `https://services.leadconnectorhq.com/contacts/?locationId=${GHL_LOCATION_ID}&query=${encodeURIComponent(query)}&limit=${MAX_GHL_RESULTS}`,
      { headers: { Authorization: `Bearer ${GHL_API_KEY}`, Version: "2021-07-28" } }
    );
    if (!res.ok) return [];
    const data = await res.json();
    return (data.contacts ?? []).map((c: any) => ({
      id: c.id,
      name: `${c.firstName ?? ""} ${c.lastName ?? ""}`.trim() || c.email,
      email: c.email,
      phone: c.phone,
      tags: c.tags ?? [],
    }));
  } catch { return []; }
}

export async function GET(req: NextRequest) {
  const query = req.nextUrl.searchParams.get("q")?.trim() ?? "";
  if (!query || query.length < 2) return NextResponse.json({ contacts: [], notes: [] });

  const [contacts, notes] = await Promise.all([
    searchGHL(query),
    searchVault(query),
  ]);

  return NextResponse.json({ contacts, notes });
}
