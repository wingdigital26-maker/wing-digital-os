import { NextResponse } from "next/server";
import { dashboardKeyOk } from "../../lib/dashboardKey";

// ── Jackson Roofing client-facing dashboard data endpoint ────────────────────
// GHL retired 2026-08-22: the Jackson sub-account (and its PIT) is dead, every
// call 401s forever, and no replacement CRM is connected. This route no longer
// fetches anything; it answers 410 Gone so the client dashboard can render an
// honest "no data source" state instead of zeroed stats.
export async function GET(req: Request) {
  if (!dashboardKeyOk(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return NextResponse.json(
    { error: "GHL retired 2026-08-22, no replacement connected" },
    { status: 410 }
  );
}
