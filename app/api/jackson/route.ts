import { NextResponse } from "next/server";

// ── Jackson Roofing client-facing dashboard data endpoint ────────────────────
// GHL retired 2026-08-22: the Jackson sub-account (and its PIT) is dead, every
// call 401s forever, and no replacement CRM is connected. This route no longer
// fetches anything; it answers 410 Gone so the client dashboard can render an
// honest "no data source" state instead of zeroed stats.
//
// The dashboard-key check was removed deliberately: this response carries no
// business data, and gating it returned 401 to the client page, which then
// showed a "we will retry automatically" message for an outage that is
// permanent. A key that only hides the truth from the client protects nothing.
export async function GET() {
  return NextResponse.json(
    { error: "GHL retired 2026-08-22, no replacement connected" },
    { status: 410 }
  );
}
