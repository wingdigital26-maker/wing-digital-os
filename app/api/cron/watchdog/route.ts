import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { sbUrl, sbService, sbSelect } from "@/lib/osSupabase";
import { pushToAll } from "@/lib/push";
import { EXPECTED_HEARTBEATS, inPcWindow } from "@/lib/watchdogExpected";

export const runtime = "nodejs";
export const maxDuration = 60;

// Cloud watchdog. Runs on a Vercel cron every 30 minutes, PC on or off.
// Reads agent_heartbeats, decides what is broken, dedupes via watchdog_alerts,
// and web-pushes Jack's phone. Re-pushes an unresolved problem every 6h and
// sends a recovery notice when it clears.

const REPUSH_MS = 6 * 60 * 60 * 1000;

// Expected cadence per heartbeat lives in lib/watchdogExpected.ts so the
// on-demand Da Boss recheck judges the fleet by exactly the same table.
const EXPECTED = EXPECTED_HEARTBEATS;

type Beat = { agent: string; status: string; message: string | null; last_beat: string };
type Alert = { key: string; title: string; body: string };
type AlertRow = { key: string; last_pushed: string | null; resolved_at: string | null };

// Constant-time compare over sha256 digests so the length of the secret and
// the position of the first mismatch leak nothing through timing.
function sameSecret(got: string | null, expected: string | undefined): boolean {
  if (!got || !expected) return false;
  const a = crypto.createHash("sha256").update(got).digest();
  const b = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

function authorized(req: NextRequest): boolean {
  const auth = req.headers.get("authorization");
  const bearer = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
  if (sameSecret(bearer, process.env.CRON_SECRET)) return true;
  if (sameSecret(req.headers.get("x-heartbeat-key"), process.env.HEARTBEAT_KEY)) return true; // manual trigger
  return false;
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const url = sbUrl();
  const key = sbService();
  if (!url || !key) return NextResponse.json({ error: "supabase not configured" }, { status: 503 });

  const now = Date.now();
  const inWindow = inPcWindow();
  const beats = await sbSelect<Beat>({ table: "agent_heartbeats", service: true });
  const byAgent = new Map(beats.map((b) => [b.agent, b]));

  const problems: Alert[] = [];

  // 1) Expected heartbeats gone stale.
  for (const exp of EXPECTED) {
    if (exp.windowed && !inWindow) continue;
    const b = byAgent.get(exp.agent);
    if (!b) {
      // Never reported: only the PC heartbeat is required from day one; the
      // rest come online as agents adopt reporting, so silence isn't failure yet.
      if (exp.agent === "pc-alive")
        problems.push({
          key: "stale:pc-alive",
          title: "PC is offline",
          body: "No PC heartbeat has ever been received. The local agent fleet cannot run.",
        });
      continue;
    }
    if (b.status === "disabled") continue;
    const ageMin = (now - new Date(b.last_beat).getTime()) / 60000;
    if (ageMin > exp.staleMin) {
      problems.push({
        key: `stale:${exp.agent}`,
        title: exp.agent === "pc-alive" ? "PC is offline" : `${exp.label} has gone silent`,
        body:
          exp.agent === "pc-alive"
            ? `Last PC heartbeat ${Math.round(ageMin)} min ago. Scheduled agents are not running.`
            : `Last run ${Math.round(ageMin / 60)}h ago (allowed ${Math.round(exp.staleMin / 60)}h).`,
      });
    }
  }

  // 2) Any heartbeat explicitly reporting an error.
  for (const b of beats) {
    if (b.status === "error")
      problems.push({
        key: `error:${b.agent}`,
        title: `${b.agent} reported an error`,
        body: b.message || "No detail provided.",
      });
  }

  // 3) Dedupe against watchdog_alerts, push new/re-due, resolve cleared.
  const open = await sbSelect<AlertRow>({
    table: "watchdog_alerts",
    service: true,
    query: "resolved_at=is.null",
  });
  const problemKeys = new Set(problems.map((p) => p.key));
  const sbHeaders = {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    Prefer: "resolution=merge-duplicates",
  };
  let pushed = 0;

  for (const p of problems) {
    const existing = open.find((a) => a.key === p.key);
    const due = !existing || !existing.last_pushed || now - new Date(existing.last_pushed).getTime() > REPUSH_MS;
    if (due) {
      await pushToAll({ title: `🔴 ${p.title}`, body: p.body, url: "/mission", tag: p.key });
      pushed++;
    }
    await fetch(`${url}/rest/v1/watchdog_alerts?on_conflict=key`, {
      method: "POST",
      headers: sbHeaders,
      body: JSON.stringify({
        key: p.key,
        title: p.title,
        body: p.body,
        last_seen: new Date(now).toISOString(),
        resolved_at: null,
        ...(due ? { last_pushed: new Date(now).toISOString() } : {}),
      }),
    }).catch(() => {});
  }

  for (const a of open) {
    if (!problemKeys.has(a.key)) {
      await fetch(`${url}/rest/v1/watchdog_alerts?key=eq.${encodeURIComponent(a.key)}`, {
        method: "PATCH",
        headers: sbHeaders,
        body: JSON.stringify({ resolved_at: new Date(now).toISOString() }),
      }).catch(() => {});
      await pushToAll({ title: "✅ Recovered", body: a.key.replace(/^(stale|error):/, "") + " is back to normal.", url: "/mission", tag: a.key });
    }
  }

  return NextResponse.json({ inWindow, beats: beats.length, problems: problems.map((p) => p.key), pushed });
}
