// ───────────────────────────────────────────────────────────────────────────
// /api/roof-command — read-only overview of the separate Roof Command project.
//
// GET only. Staff-gated like every other OS API route. All reads happen
// server-side in lib/roofCommand.ts with the Roof Command service key, which
// never reaches the browser. There is no write verb here and never will be.
// ───────────────────────────────────────────────────────────────────────────
import { NextResponse } from "next/server";
import { requireStaff, isAuthFailure } from "../pipeline/_lib";
import { getRoofOverview } from "@/lib/roofCommand";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await requireStaff();
  if (isAuthFailure(auth)) return auth;
  const data = await getRoofOverview();
  return NextResponse.json(data, {
    status: data.connected && !data.ok ? 502 : 200,
    headers: { "Cache-Control": "no-store" },
  });
}
