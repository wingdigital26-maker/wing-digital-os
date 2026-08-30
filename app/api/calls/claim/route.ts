import { NextResponse } from "next/server";
import { requireCallUser, sbConfigured, sbGet, sbPatch, CLAIM_MINUTES } from "../_guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Row = { id: string; claimed_by: string | null; claimed_at: string | null; company: string };

// POST /api/calls/claim  { leadId, release?: boolean }
//
// A claim is a 20-minute soft lock so two dialers never call the same business
// at the same time. It is NOT ownership: it expires on its own, so a caller who
// closes their laptop mid-list cannot strand a lead forever.
//
// The claim is taken with a conditional PATCH -- the filter only matches rows
// that are genuinely free (or already mine, or expired). Two callers hitting
// the button in the same second means one PATCH matches zero rows and that
// caller is told the truth instead of both being told they own it.
export async function POST(req: Request) {
  const user = await requireCallUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!sbConfigured()) {
    return NextResponse.json({ error: "call room not configured" }, { status: 503 });
  }
  // The shared OS_PASSWORD login has no user id, so it cannot hold a lock --
  // claimed_by is a real FK to auth.users. Rather than refuse (which would stop
  // Jack opening any lead at all while the auth swap is unfinished), we let the
  // call proceed WITHOUT a lock and say so plainly. Nobody is misled into
  // thinking a lead is reserved when it isn't.
  if (user.id === "legacy") {
    return NextResponse.json({
      ok: true,
      locked: false,
      note: "Opened without a lock. Sign in with your own email to reserve leads so nobody double-dials them.",
    });
  }

  const body = await req.json().catch(() => ({}));
  const leadId = String((body as { leadId?: string }).leadId ?? "");
  const release = Boolean((body as { release?: boolean }).release);
  if (!/^[0-9a-f-]{36}$/i.test(leadId)) {
    return NextResponse.json({ error: "bad leadId" }, { status: 400 });
  }

  if (release) {
    // You may only release your OWN claim.
    const out = await sbPatch<Row>(
      "call_leads",
      `id=eq.${leadId}&claimed_by=eq.${user.id}`,
      { claimed_by: null, claimed_by_email: null, claimed_at: null }
    );
    if (out === null) return NextResponse.json({ error: "release failed" }, { status: 502 });
    return NextResponse.json({ ok: true, released: out.length > 0 });
  }

  const expiry = new Date(Date.now() - CLAIM_MINUTES * 60_000).toISOString();
  // Match only if: unclaimed, OR already mine, OR the existing claim has expired.
  const filter =
    `id=eq.${leadId}&or=(claimed_by.is.null,claimed_by.eq.${user.id},claimed_at.lt.${encodeURIComponent(expiry)})`;

  const out = await sbPatch<Row>("call_leads", filter, {
    claimed_by: user.id,
    claimed_by_email: user.email,
    claimed_at: new Date().toISOString(),
  });
  if (out === null) return NextResponse.json({ error: "claim failed" }, { status: 502 });

  if (out.length === 0) {
    // Somebody else holds a live claim. Say who, so the room self-organizes.
    const cur = await sbGet<{ claimed_by_email: string | null }>(
      "call_leads",
      `select=claimed_by_email&id=eq.${leadId}`
    );
    const who = cur?.[0]?.claimed_by_email || "another caller";
    return NextResponse.json(
      { ok: false, taken: true, by: who, error: `Already being called by ${who}` },
      { status: 409 }
    );
  }

  return NextResponse.json({ ok: true, claimedUntil: new Date(Date.now() + CLAIM_MINUTES * 60_000).toISOString() });
}
