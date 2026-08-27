import { NextResponse } from "next/server";

// GHL retired 2026-08-22. Per-client GHL snapshots are gone permanently (all
// PIT tokens 401) and no replacement CRM exists yet. 410 Gone with an honest
// error; `available: false` keeps any legacy caller's guard working.
export async function GET() {
  return NextResponse.json(
    { available: false, error: "GHL retired 2026-08-22, no replacement connected" },
    { status: 410 }
  );
}
