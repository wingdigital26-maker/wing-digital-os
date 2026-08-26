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

const norm = (s: string) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

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
    // WHO COUNTS AS A CLIENT. wiki/clients/ holds 38 markdown files, but most
    // are not clients — they are notes, reports, playbooks, prospect names, the
    // page template ({{CLIENT_NAME}}) and a generated index. Counting the folder
    // reported 37 "active clients". The deliberate, curated roster lives in the
    // Supabase `crm_clients` table (4 rows). Membership comes from there; the
    // vault supplies the detail. A vault page with no matching roster row is
    // still returned, flagged `isClient: false`, so nothing is hidden — it just
    // stops being counted as a client.
    let roster: Set<string> = new Set();
    let rosterRows: { name: string; slug: string }[] = [];
    try {
      const su = process.env.SONAR_SUPABASE_URL, sk = process.env.SONAR_SUPABASE_SERVICE_KEY;
      if (su && sk) {
        const rr = await fetch(`${su}/rest/v1/crm_clients?select=name,slug&active=is.true`, {
          headers: { apikey: sk, Authorization: `Bearer ${sk}` }, cache: "no-store",
        });
        if (rr.ok) {
          const rows = (await rr.json()) as { name: string; slug: string }[];
          rosterRows = rows;
          for (const r of rows) {
            roster.add(norm(r.name));
            roster.add(norm(r.slug));
          }
        }
      }
    } catch { /* roster unavailable -> every page falls back to unflagged */ }

    const rosterKnown = roster.size > 0;
    for (const c of clients) {
      // Without the roster we cannot claim to know, so leave it null rather
      // than guessing either way.
      (c as Record<string, unknown>).isClient = rosterKnown
        ? roster.has(norm(c.name)) || roster.has(norm((c.file || "").replace(/^.*\//, "").replace(/\.md$/, "")))
        : null;
    }

    // MRR is summed from an `mrr:` field in each client's vault page — and
    // most clients do not have one. Reporting the bare sum implies it is the
    // whole business: Jack saw "$700 MRR" the same day a $1,250 payment landed,
    // because only one of four active clients has the field filled in. Report
    // the coverage alongside the number so the gap is visible instead of
    // silently understating revenue.
    // A roster client with no vault page was previously invisible: the route
    // only ever iterated markdown files, so Hero's Junk Removal and Northcomm
    // Technologies simply did not exist in the OS despite being real clients.
    // Add them as stubs flagged `needsVaultPage` — an honest "we know they
    // exist and we are missing their detail" beats silently undercounting.
    if (rosterKnown) {
      const seen = new Set(clients.map((c) => norm(c.name)));
      for (const r of rosterRows) {
        if (seen.has(norm(r.name)) || seen.has(norm(r.slug))) continue;
        clients.push({
          file: "", name: r.name, owner: "", industry: "", location: "",
          status: "active", mrr: null, email: "", phone: "",
          ghlLocationId: "", updated: "",
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ...( { isClient: true, needsVaultPage: true } as any ),
        } as (typeof clients)[number]);
      }
    }

    // Count only real roster clients, not every markdown file in the folder.
    const active = clients.filter(
      (c) => c.status === "active" &&
             ((c as Record<string, unknown>).isClient !== false)
    );
    const withMrr = active.filter((c) => typeof c.mrr === "number" && c.mrr > 0);
    const totalMrr = clients.reduce((s, c) => s + (c.mrr ?? 0), 0);
    const mrrCoverage = {
      activeClients: active.length,
      clientsWithMrr: withMrr.length,
      missing: active
        .filter((c) => !(typeof c.mrr === "number" && c.mrr > 0))
        .map((c) => c.name),
      complete: active.length > 0 && withMrr.length === active.length,
    };
    return NextResponse.json({
      clients, totalMrr, mrrCoverage,
      rosterSource: rosterKnown ? "crm_clients" : "vault-only (roster unavailable)",
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message, clients: [] }, { status: 500 });
  }
}
