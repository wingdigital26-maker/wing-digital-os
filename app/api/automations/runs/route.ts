import { NextResponse } from "next/server";
import { requireStaff, isAuthFailure, errorResponse, sbGet } from "@/app/api/pipeline/_lib";
import { sbCount } from "@/lib/automations/db";
import type { WorkflowRunRow } from "@/lib/automations/types";

// ───────────────────────────────────────────────────────────────────────────
// GET /api/automations/runs: the last 100 workflow runs, newest first, with
// the workflow name and the event that caused each one embedded. Staff only.
//
//   ?workflow_id=   only runs of one workflow
//
// Also returns unprocessed_events: how many events are waiting for the engine.
// That number is null (not 0) when the count could not be read, because "no
// backlog" and "could not check" are different facts.
// ───────────────────────────────────────────────────────────────────────────

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RunWithJoins = WorkflowRunRow & {
  workflows: { name: string; client_slug: string | null } | null;
  events: { type: string; client_slug: string | null; payload: Record<string, unknown> } | null;
};

export async function GET(req: Request) {
  const auth = await requireStaff();
  if (isAuthFailure(auth)) return auth;
  try {
    const workflowId = new URL(req.url).searchParams.get("workflow_id");
    const filter = workflowId ? `&workflow_id=eq.${encodeURIComponent(workflowId)}` : "";
    const [runs, unprocessed] = await Promise.all([
      sbGet<RunWithJoins>(
        "workflow_runs",
        "*,workflows(name,client_slug),events(type,client_slug,payload)",
        `order=started_at.desc&limit=100${filter}`
      ),
      sbCount("events", "processed_at=is.null").catch(() => null),
    ]);
    return NextResponse.json({ runs, unprocessed_events: unprocessed });
  } catch (e) {
    return errorResponse(e);
  }
}
