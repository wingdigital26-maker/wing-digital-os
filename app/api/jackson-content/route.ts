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
      // updatedAt is when content_engine.py last WROTE this state, not when we
      // read it. Reading a three-week-old file must not report "just now".
      const writtenAt = fs.statSync(p).mtime.toISOString();
      return NextResponse.json(
        { updatedAt: writtenAt, state, source: "local-state-file" },
        { headers: { "Cache-Control": "no-store" } }
      );
    } catch {
      /* try next candidate path */
    }
  }
  // No state file reachable -- either it has never been written, or we are in the
  // cloud and the PC that writes it is off. Either way we know NOTHING about when
  // this content was last touched, so updatedAt must be null. Stamping a fresh
  // timestamp here would tell the dashboard the data is current when it is absent.
  return NextResponse.json({
    updatedAt: null,
    state: {},
    source: "state-file-unavailable",
  });
}
