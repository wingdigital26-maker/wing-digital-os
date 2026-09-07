import { NextRequest, NextResponse } from "next/server";
import { isCloud } from "@/lib/runtime";
import { runNimbusWatch } from "@/lib/nimbusWatch";
import { startTriage, getTriage, listTriage } from "@/lib/nimbusTriage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

// ───────────────────────────────────────────────────────────────────────────
// POST /api/nimbus/triage  { problemId }   start looking into one problem
// GET  /api/nimbus/triage?problemId=...    poll what he has found so far
// GET  /api/nimbus/triage                  everything looked into this session
//
// The investigation itself lives in lib/nimbusTriage.ts, along with the rules
// about what it may and may not do on its own. This route only decides WHICH
// problem, and it will only accept a problem the watch is actually reporting,
// so nothing can talk it into investigating an arbitrary string.
// ───────────────────────────────────────────────────────────────────────────

const noStore = { "Cache-Control": "no-store" };

export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("problemId");
  if (!id) return NextResponse.json({ ok: true, runs: listTriage() }, { headers: noStore });
  const run = getTriage(id);
  if (!run) return NextResponse.json({ ok: true, triage: null }, { headers: noStore });
  return NextResponse.json({ ok: true, triage: run }, { headers: noStore });
}

export async function POST(req: NextRequest) {
  if (isCloud()) {
    return NextResponse.json(
      {
        ok: false,
        pcRequired: true,
        error: "Looking into a problem needs Jack's PC, because the investigation runs Claude Code there.",
      },
      { status: 503, headers: noStore }
    );
  }
  let body: { problemId?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "expected a JSON body with problemId" }, { status: 400, headers: noStore });
  }
  const problemId = typeof body.problemId === "string" ? body.problemId : "";
  if (!problemId) {
    return NextResponse.json({ ok: false, error: "problemId is required" }, { status: 400, headers: noStore });
  }

  // Only a problem the watch is currently reporting can be investigated. The
  // agent's prompt is built from the watch's own text, so this is also what
  // keeps a caller from putting words into it.
  let problem;
  try {
    const w = await runNimbusWatch();
    problem = w.problems.find((p) => p.id === problemId);
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: `The checks could not be run, so I could not confirm that problem: ${e instanceof Error ? e.message : String(e)}` },
      { status: 503, headers: noStore }
    );
  }
  if (!problem) {
    return NextResponse.json(
      { ok: false, error: `'${problemId}' is not one of the problems being reported right now.` },
      { status: 404, headers: noStore }
    );
  }

  const triage = await startTriage(problem);
  return NextResponse.json({ ok: true, triage }, { headers: noStore });
}
