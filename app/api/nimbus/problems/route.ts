import { NextResponse } from "next/server";
import { runNimbusWatch } from "@/lib/nimbusWatch";
import { getTriage } from "@/lib/nimbusTriage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

// ───────────────────────────────────────────────────────────────────────────
// GET /api/nimbus/problems
//
// The list behind the Nimbus window's problems view: every open problem with
// its detail, its fix, where to go, and whatever Nimbus has already found out
// about it. Read-only. It starts nothing and sends nothing.
//
// HONESTY: this is the watch's own output, unedited. A check that could not run
// comes back under `unknowns` rather than being counted as healthy, and no
// figure is invented to fill a gap.
// ───────────────────────────────────────────────────────────────────────────

export async function GET() {
  try {
    const w = await runNimbusWatch();
    return NextResponse.json(
      {
        ok: true,
        asOf: w.ranAt,
        headline: w.headline,
        problems: w.problems.map((p) => ({
          id: p.id,
          label: p.label,
          detail: p.detail,
          fix: p.fix ?? null,
          link: p.link ?? null,
          severity: p.severity ?? "normal",
          triage: getTriage(p.id),
        })),
        unknowns: w.unknowns.map((u) => ({ id: u.id, label: u.label, reason: u.detail })),
        working: w.checks.filter((c) => c.state === "ok").length,
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: `The checks could not be run: ${e instanceof Error ? e.message : String(e)}` },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    );
  }
}
