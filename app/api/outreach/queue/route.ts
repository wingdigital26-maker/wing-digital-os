import { NextRequest, NextResponse } from "next/server";
import { outreachStore, storeFailure } from "@/lib/outreach/store";
import { pushEnabled, staffActor } from "@/lib/outreach/auth";

// GET /api/outreach/queue?date=YYYY-MM-DD&tenant=wing
// One batch of drafts for /outreach, plus the list of batch dates. Staff only.
// With no date, the newest batch is returned (today's when it exists).

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!(await staffActor())) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const choice = outreachStore();
  if (!choice.store) return NextResponse.json({ ok: false, reason: choice.reason }, { status: 503 });
  const store = choice.store;
  try {
    const dates = await store.batchDates(45);
    const asked = req.nextUrl.searchParams.get("date");
    const tenant = req.nextUrl.searchParams.get("tenant") || null;
    const batchDate = asked && /^\d{4}-\d{2}-\d{2}$/.test(asked) ? asked : dates[0]?.date ?? null;
    const drafts = batchDate ? await store.listDrafts({ batchDate, tenant }) : [];
    return NextResponse.json(
      { ok: true, storeKind: store.kind, dates, batchDate, drafts, pushEnabled: pushEnabled() },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (e) {
    const f = storeFailure(e);
    return NextResponse.json({ ok: false, reason: f.message }, { status: f.status });
  }
}
