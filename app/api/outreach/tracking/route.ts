import { NextRequest, NextResponse } from "next/server";
import { outreachStore, storeFailure } from "@/lib/outreach/store";
import { staffActor } from "@/lib/outreach/auth";
import { LAST_SYNC_KEY, type SyncSummary } from "@/lib/outreach/sync";
import {
  buildHandoffs,
  buildMailboxHealth,
  buildRetouchPool,
  buildSuppression,
  buildTracking,
  DEFAULT_RETOUCH,
} from "@/lib/outreach/stats";

// GET /api/outreach/tracking?days=30
// Everything /outreach shows that comes from what Instantly did: per-day sent,
// replies and bounces, per step, per mailbox, 7-day mailbox health with the
// engine's pause state, the re-touch pool, the suppression list and the
// handoffs. All computed from outreach_events + outreach_leads, which the sync
// and the webhook fill. Staff only. Reads nothing from Instantly itself.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function rules() {
  const n = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
  return {
    intervalDays: n(process.env.OUTREACH_RETOUCH_DAYS, DEFAULT_RETOUCH.intervalDays),
    yearlyCap: n(process.env.OUTREACH_YEARLY_CAP, DEFAULT_RETOUCH.yearlyCap),
    stepsPerRound: n(process.env.OUTREACH_STEPS_PER_ROUND, DEFAULT_RETOUCH.stepsPerRound),
  };
}

export async function GET(req: NextRequest) {
  if (!(await staffActor())) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const choice = outreachStore();
  if (!choice.store) return NextResponse.json({ ok: false, reason: choice.reason }, { status: 503 });
  const store = choice.store;
  const days = Math.min(90, Math.max(7, Number(req.nextUrl.searchParams.get("days")) || 30));
  const now = Date.now();
  try {
    const yearAgo = new Date(now - 366 * 24 * 3600 * 1000).toISOString();
    const [events, leads, states, sends, lastSync] = await Promise.all([
      // Sends from well before the window too, so a reply today is credited
      // to the step that earned it (rounds are ~75 days apart).
      store.listEvents(new Date(now - (days + 150) * 24 * 3600 * 1000).toISOString()),
      store.listLeads(),
      store.listMailboxStates(),
      store.sendTimes(yearAgo),
      store.getState<SyncSummary>(LAST_SYNC_KEY),
    ]);
    const configured = (process.env.OUTREACH_MAILBOXES ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    const r = rules();
    return NextResponse.json(
      {
        ok: true,
        storeKind: store.kind,
        tracking: buildTracking(events, { now, windowDays: days }),
        mailboxHealth: buildMailboxHealth(events, states, { now, mailboxes: configured }),
        retouch: buildRetouchPool(leads, sends, { now, rules: r, horizonDays: 30 }),
        retouchRules: r,
        suppression: buildSuppression(leads),
        handoffs: buildHandoffs(leads),
        eventCount: events.length,
        lastSync,
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (e) {
    const f = storeFailure(e);
    return NextResponse.json({ ok: false, reason: f.message }, { status: f.status });
  }
}
