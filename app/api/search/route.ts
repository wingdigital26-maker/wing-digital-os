import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";

const GHL_API_KEY = process.env.GHL_API_KEY!;
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID!;
const VAULT = "C:\\Users\\wjack\\OneDrive\\Documentos\\Obsidian 2.0\\Jacks Ai Brain 2.0";
const IGNORE = [".obsidian", ".claude", "node_modules", "assets"];
const MAX_VAULT_RESULTS = 5;
const MAX_GHL_RESULTS = 5;

function searchVault(query: string): { name: string; path: string; excerpt: string }[] {
  const q = query.toLowerCase();
  const results: { name: string; path: string; excerpt: string }[] = [];

  function walk(dir: string) {
    if (results.length >= MAX_VAULT_RESULTS) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }

    for (const entry of entries) {
      if (results.length >= MAX_VAULT_RESULTS) break;
      if (IGNORE.includes(entry.name) || entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith(".md")) continue;

      const rel = path.relative(VAULT, full).replace(/\\/g, "/");
      const name = entry.name.replace(".md", "");

      // Match filename first (fastest)
      if (name.toLowerCase().includes(q)) {
        results.push({ name, path: rel, excerpt: "Filename match" });
        continue;
      }

      // Then scan content -- stop after finding first match
      try {
        const content = fs.readFileSync(full, "utf-8");
        const idx = content.toLowerCase().indexOf(q);
        if (idx !== -1) {
          const start = Math.max(0, idx - 60);
          const excerpt = "..." + content.slice(start, idx + 80).replace(/\n/g, " ").trim() + "...";
          results.push({ name, path: rel, excerpt });
        }
      } catch { continue; }
    }
  }

  walk(VAULT);
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
    Promise.resolve(searchVault(query)),
  ]);

  return NextResponse.json({ contacts, notes });
}
