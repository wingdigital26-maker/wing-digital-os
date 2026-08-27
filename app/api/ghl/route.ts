import { NextResponse } from "next/server";

export const runtime = "nodejs";

// GHL retired 2026-08-22. Every GoHighLevel API call 401s permanently and no
// replacement CRM is connected yet, so this route no longer fetches anything.
// It answers 410 Gone with a clear error so call sites can render an honest
// "no data source" state instead of blanks. Revenue/MRR truth still lives in
// lib/revenue.ts and is served by /api/clients and /api/crm.
export async function GET() {
  return NextResponse.json(
    { error: "GHL retired 2026-08-22, no replacement connected" },
    { status: 410 }
  );
}
