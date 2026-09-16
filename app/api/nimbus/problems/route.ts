import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { runNimbusWatch } from "@/lib/nimbusWatch";
import { getTriage } from "@/lib/nimbusTriage";
import { VAULT_PATH } from "@/lib/vaultSource";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

// ───────────────────────────────────────────────────────────────────────────
// getTriage() only sees triage runs kept in this process's memory (see
// lib/nimbusTriage.ts's `store`). On a serverless host that memory does not
// survive a cold start or a redeploy, so a triage that finished five minutes
// ago can go invisible even though nimbusTriage.ts faithfully wrote it to
// triage-log.jsonl. Nothing in the app ever read that ledger back — this is
// the fix: fall back to the ledger's own latest line for this problem when
// the in-memory copy is gone.
//
// FAIL-CLOSED: no ledger file, an unreadable line, or no matching entry all
// resolve to null (no verdict shown), never a thrown error.
// ───────────────────────────────────────────────────────────────────────────
const LEDGER = path.join(VAULT_PATH, "wiki", "nimbus", "triage-log.jsonl");

type LedgerTriage = {
  problemId: string;
  status: "investigating" | "fixed" | "needs_you" | "failed";
  summary: string;
  steps: { at: string; kind: string; text: string }[];
  nextStep: string | null;
  proposedCommand: string | null;
  finishedAt: string | null;
  startedAt: string;
};

function readLedgerTriage(problemId: string): LedgerTriage | null {
  try {
    if (!fs.existsSync(LEDGER)) return null;
    const lines = fs.readFileSync(LEDGER, "utf-8").split("\n").filter(Boolean);
    let latest: LedgerTriage | null = null;
    for (const line of lines) {
      let r: LedgerTriage;
      try {
        r = JSON.parse(line);
      } catch {
        continue; // one bad line never sinks the read
      }
      if (r.problemId !== problemId) continue;
      const rKey = r.finishedAt ?? r.startedAt;
      const latestKey = latest ? latest.finishedAt ?? latest.startedAt : "";
      if (!latest || rKey > latestKey) latest = r;
    }
    if (!latest) return null;
    // A run stuck at "investigating" with no finishedAt means the process
    // doing the investigating is gone (cold start, restart, crash) — nothing
    // in THIS request is actually still looking into it. Say so honestly
    // rather than showing "Looking into it" forever.
    if (latest.status === "investigating" && !latest.finishedAt) {
      return {
        ...latest,
        status: "failed",
        summary: `${latest.summary} (the run that was looking into this did not finish — likely interrupted by a restart)`,
      };
    }
    return latest;
  } catch {
    return null; // fail-closed: never let a ledger read error break the route
  }
}

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
          // Live in-memory triage wins when present; otherwise fall back to
          // the ledger's own last word on this problem (see readLedgerTriage
          // above) so a verdict survives a cold start instead of vanishing.
          triage: getTriage(p.id) ?? readLedgerTriage(p.id),
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
