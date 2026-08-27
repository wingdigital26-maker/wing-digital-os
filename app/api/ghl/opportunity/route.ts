import { NextResponse } from "next/server";

// GHL retired 2026-08-22. Opportunity updates have no backing CRM any more.
const GONE = { error: "GHL retired 2026-08-22, no replacement connected" };

export async function PATCH() {
  return NextResponse.json(GONE, { status: 410 });
}

export async function POST() {
  return NextResponse.json(GONE, { status: 410 });
}
