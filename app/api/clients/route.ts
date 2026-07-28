import { NextResponse } from "next/server";
import { listVaultFiles, readVaultFile } from "@/lib/vaultSource";

export const runtime = "nodejs";

function parseFrontmatter(text: string): Record<string, string> {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const out: Record<string, string> = {};
  if (!m) return out;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^(\w[\w_-]*):\s*(.+)$/);
    if (kv) out[kv[1].toLowerCase()] = kv[2].trim();
  }
  return out;
}

export async function GET() {
  try {
    const files = (await listVaultFiles()).filter(
      (rel) => rel.startsWith("wiki/clients/") && !rel.slice("wiki/clients/".length).includes("/")
    );
    const clients = await Promise.all(files.map(async rel => {
      const f = rel.split("/").pop()!;
      const text = (await readVaultFile(rel)) ?? "";
      const fm = parseFrontmatter(text);
      // pull contact info from the body (first email/phone found)
      const email = text.match(/[\w.+-]+@[\w-]+\.[\w.]+/)?.[0] ?? "";
      const phone = text.match(/\(?\d{3}\)?[ -.]?\d{3}[-.]?\d{4}/)?.[0] ?? "";
      // GHL sub-account link: frontmatter ghl_location_id, else "Location ID: `...`" in the body
      const ghlLocationId =
        fm["ghl_location_id"] ||
        text.match(/Location ID:\**\s*`?([A-Za-z0-9]{15,})`?/)?.[1] ||
        "";
      const pretty = f.replace(".md", "").split("-")
        .map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
      return {
        file: f,
        name: fm["client_name"] || pretty,
        owner: fm["owner"] || "",
        industry: fm["industry"] || "",
        location: fm["location"] || "",
        status: (fm["status"] || "active").toLowerCase(),
        mrr: fm["mrr"] ? Number(fm["mrr"]) : null,
        email,
        phone,
        ghlLocationId,
        updated: fm["updated"] || fm["date"] || "",
      };
    }));
    const totalMrr = clients.reduce((s, c) => s + (c.mrr ?? 0), 0);
    return NextResponse.json({ clients, totalMrr });
  } catch (e: any) {
    return NextResponse.json({ error: e.message, clients: [] }, { status: 500 });
  }
}
