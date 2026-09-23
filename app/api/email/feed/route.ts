import { NextRequest, NextResponse } from "next/server";
import { loadEmailFeed } from "./source";

// ───────────────────────────────────────────────────────────────────────────
// GET /api/email/feed — every email Wing sends, from every lane, in one list.
//
// Session-gated by middleware like every other /api/* route. Read-only: this
// route cannot send, queue, or schedule anything. The merge, the lane honesty
// and the sanitizing all live in ./source.ts, which the SSE stream at
// /api/messages/stream shares so the live feed and the first paint can never
// disagree about what a row looks like.
//
// Query params: limit (10..500, default 100).
// ───────────────────────────────────────────────────────────────────────────

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const raw = Number(req.nextUrl.searchParams.get("limit"));
  const limit = Number.isFinite(raw) ? raw : 100;
  const payload = await loadEmailFeed({ limit });
  return NextResponse.json(payload, {
    headers: { "Cache-Control": "no-store" },
  });
}
