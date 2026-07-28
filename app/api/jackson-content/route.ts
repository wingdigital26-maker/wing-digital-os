import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { dashboardKeyOk } from "../../lib/dashboardKey";

// ── Jackson Roofing content-calendar state endpoint ──────────────────────────
// Serves the live content-calendar state written by content_engine.py so the
// client dashboard can reflect what has actually been drafted/published, not just
// a static weekday rhythm.
//  - READ ONLY. Returns the JSON as-is. No secrets, no GHL calls, no writes.
//  - If the state file is missing or unreadable, returns an empty map so the
//    dashboard falls back to its built-in weekday-rule calendar and never breaks.

const STATE_CANDIDATES = [
  "C:\\Users\\wjack\\ghl-cli\\outreach_logs\\jackson-content-state.json",
  path.join(process.cwd(), "..", "ghl-cli", "outreach_logs", "jackson-content-state.json"),
];

export async function GET(req: Request) {
  if (!dashboardKeyOk(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  for (const p of STATE_CANDIDATES) {
    try {
      const text = fs.readFileSync(p, "utf-8");
      const state = JSON.parse(text);
      return NextResponse.json(
        { updatedAt: new Date().toISOString(), state },
        { headers: { "Cache-Control": "no-store" } }
      );
    } catch {
      /* try next candidate path */
    }
  }
  // No file yet -- empty state, dashboard falls back to the weekday rule.
  return NextResponse.json({ updatedAt: new Date().toISOString(), state: {} });
}
