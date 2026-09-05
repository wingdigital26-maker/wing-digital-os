import { NextResponse } from "next/server";
import { listVaultFiles, readVaultFile } from "@/lib/vaultSource";
import { getRevenueTruth, BASIS_LABEL } from "@/lib/revenue";
import { CLIENTS as DASHBOARD_CLIENTS } from "../dashboard/clients";

export const runtime = "nodejs";

// The dashboard registry (app/api/dashboard/clients.ts) is keyed by its own
// short slug, which does not always equal the roster slug ("heros-junk" vs
// "heros-junk-removal"). Match on the registry key first, then on the brand
// name, so a dashboard that really exists is never reported as missing.
// The page is credential-free, so no key goes in the URL.
function dashboardUrlFor(slug: string, name: string): string | null {
  const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const key = DASHBOARD_CLIENTS[slug]
    ? slug
    : Object.keys(DASHBOARD_CLIENTS).find((k) => norm(DASHBOARD_CLIENTS[k].brand.name) === norm(name) || norm(k) === norm(slug));
  return key ? `/dashboards/live.html?c=${encodeURIComponent(key)}` : null;
}


// The client roster + revenue view.
//
// This route no longer computes revenue or decides who counts as a client. Both
// answers come from lib/revenue.ts, the single source of truth, so the numbers
// here are byte-identical to /api/crm, /api/ghl, /api/mission and /api/jarvis.
//
// Two things it used to get wrong, both fixed at the source:
//   * It summed `mrr:` across EVERY row including the ones it had just flagged
//     as not-clients, producing a total that disagreed with the count beside it.
//   * It blended measures: a one-time payment and a monthly retainer were added
//     into one "totalMrr". Amounts are now bucketed by declared basis and only
//     confirmed monthly retainers sum into MRR.

function parseFrontmatter(text: string): Record<string, string> {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const out: Record<string, string> = {};
  if (!m) return out;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^(\w[\w_-]*):\s*(.+)$/);
    if (kv) out[kv[1].toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

export async function GET() {
  try {
    const truth = await getRevenueTruth();

    // Contact detail the revenue truth does not carry, keyed by slug.
    const detail = new Map<
      string,
      { file: string; owner: string; industry: string; location: string; email: string; phone: string; ghlLocationId: string; updated: string }
    >();
    try {
      const files = (await listVaultFiles()).filter(
        (rel) =>
          rel.startsWith("wiki/clients/") &&
          rel.endsWith(".md") &&
          !rel.slice("wiki/clients/".length).includes("/") &&
          !rel.split("/").pop()!.startsWith("_")
      );
      for (const rel of files) {
        const f = rel.split("/").pop()!;
        const text = (await readVaultFile(rel)) ?? "";
        const fm = parseFrontmatter(text);
        detail.set(f.replace(/\.md$/, ""), {
          file: f,
          owner: fm["owner"] || "",
          industry: fm["industry"] || "",
          location: fm["location"] || "",
          // first contact details found in the body
          email: text.match(/[\w.+-]+@[\w-]+\.[\w.]+/)?.[0] ?? "",
          phone: text.match(/\(?\d{3}\)?[ -.]?\d{3}[-.]?\d{4}/)?.[0] ?? "",
          ghlLocationId:
            fm["ghl_location_id"] ||
            text.match(/Location ID:\**\s*`?([A-Za-z0-9]{15,})`?/)?.[1] ||
            "",
          updated: fm["updated"] || fm["date"] || "",
        });
      }
    } catch { /* detail is optional; the roster + revenue still stand */ }

    const clients = truth.allPages.map((c) => {
      const d = detail.get(c.slug);
      return {
        file: d?.file ?? "",
        slug: c.slug,
        name: c.name,
        owner: d?.owner ?? "",
        industry: d?.industry ?? "",
        location: d?.location ?? "",
        status: c.status,
        // Narrow on purpose: ONLY a confirmed recurring retainer. Anything else
        // is null so no consumer can quietly add a one-time or expected figure
        // into a monthly total. The full picture is in `revenue`.
        mrr: c.basis === "monthly" || c.basis === "term" ? c.amount : null,
        revenue: {
          amount: c.amount,          // null = unknown, never zero-as-truth
          basis: c.basis,
          label: BASIS_LABEL[c.basis],
          note: c.note,
          question: c.question,
          term: c.term,              // end date + months remaining, when fixed-term
          evidence: c.evidence,      // paid invoices backing the figure
          evidenceBacked: c.evidenceBacked,
          countsTowardMrr: c.basis === "monthly" || c.basis === "term",
        },
        email: d?.email ?? "",
        phone: d?.phone ?? "",
        ghlLocationId: d?.ghlLocationId ?? "",
        updated: d?.updated ?? "",
        isClient: c.isClient,
        needsVaultPage: c.needsVaultPage,
        // The live client dashboard, only when a registry entry exists for
        // this slug (app/api/dashboard/clients.ts). The page itself is
        // credential-free, so no key is ever put in this URL; null means
        // "no dashboard yet", never a dead link.
        dashboardUrl: dashboardUrlFor(c.slug, c.name),
      };
    });

    return NextResponse.json({
      asOf: truth.asOf,
      clients,

      // ── The measures, kept apart on purpose ─────────────────────────────
      // EARNED: money actually recurring now. The headline number.
      mrr: truth.mrr,
      mrrDurable: truth.mrrDurable,
      mrrExpiring: truth.mrrExpiring,
      nextExpiry: truth.nextExpiry,
      mrrClients: truth.mrrClients.map((c) => ({
        name: c.name, amount: c.amount, basis: c.basis, term: c.term,
        evidence: c.evidence, evidenceBacked: c.evidenceBacked,
      })),
      mrrBasis: truth.mrrBasisLine,
      // PIPELINE: never earned, never summed into mrr. Display separately.
      pipelineTotal: truth.pipelineTotal,
      pipelineDeals: truth.pipelineDeals,
      // Real money, collected once. NOT recurring. Never add to mrr.
      oneTimeTotal: truth.oneTimeTotal,
      oneTime: truth.oneTime.map((c) => ({ name: c.name, amount: c.amount })),
      // Agreed/likely but NOT yet earned. Pipeline, not revenue.
      expectedTotal: truth.expectedTotal,
      expected: truth.expected.map((c) => ({ name: c.name, amount: c.amount, note: c.note })),
      // Amount known, recurrence unconfirmed — held out of MRR by design.
      unconfirmedTotal: truth.unconfirmedTotal,
      unconfirmed: truth.unconfirmed.map((c) => ({ name: c.name, amount: c.amount, note: c.note })),

      activeClients: truth.activeClients,
      coverage: {
        activeClients: truth.activeClients,
        clientsWithFigure: truth.clientsWithFigure,
        unknown: truth.unknown.map((c) => c.name),
        complete: truth.activeClients > 0 && truth.clientsWithFigure === truth.activeClients,
      },
      rosterSource: truth.rosterSource,
      questions: truth.questions,

      // Back-compat for any consumer still reading the old field names. Same
      // number as `mrr` — a legacy alias, never a second calculation.
      totalMrr: truth.mrr,
      mrrCoverage: {
        activeClients: truth.activeClients,
        clientsWithMrr: truth.mrrClients.length,
        missing: truth.clients.filter((c) => c.basis !== "monthly" && c.basis !== "term").map((c) => c.name),
        complete: truth.activeClients > 0 && truth.mrrClients.length === truth.activeClients,
      },
    });
  } catch (e: unknown) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e), clients: [] },
      { status: 500 }
    );
  }
}
