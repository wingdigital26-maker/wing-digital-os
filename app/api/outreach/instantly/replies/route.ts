import { NextRequest, NextResponse } from "next/server";
import { loadReplies } from "@/lib/instantlyReplies";

// GET /api/outreach/instantly/replies — who replied to Wing's Instantly
// campaigns and what they said, newest first. Staff-session gated like every
// other /api route. Read-only: answering happens in Instantly's Unibox.
//
// ?force=1 skips the 20s cache (still de-duplicated and still inside
// Instantly's 20-a-minute inbox budget, so hammering it cannot get us blocked).
//
// Always HTTP 200 with an honest payload: status "error" + reason when
// Instantly cannot be read, never an empty list that looks like "no replies".

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const force = req.nextUrl.searchParams.get("force") === "1";
  const payload = await loadReplies({ force });
  return NextResponse.json(payload, { headers: { "Cache-Control": "no-store" } });
}
