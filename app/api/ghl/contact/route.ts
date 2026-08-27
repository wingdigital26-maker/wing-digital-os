import { NextResponse } from "next/server";

// GHL retired 2026-08-22. Contact creation has no backing CRM any more.
export async function POST() {
  return NextResponse.json(
    { error: "GHL retired 2026-08-22, no replacement connected" },
    { status: 410 }
  );
}
