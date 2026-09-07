import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { sbUrl, sbService, sbSelect } from "@/lib/osSupabase";
import { pushToAll } from "@/lib/push";
import { runNimbusWatch, formatWatchReport, alertBody, type Check } from "@/lib/nimbusWatch";

export const runtime = "nodejs";
export const maxDuration = 60;

// ───────────────────────────────────────────────────────────────────────────
// The Nimbus watch, on a schedule.
//
// /api/cron/watchdog answers "are the agents alive". This one answers the wider
// question: is anything in the business not working. Sending, money running
// out, client sites gone quiet, the lead pipeline, overdue call-backs, the
// agent fleet.
//
// It pushes Jack's phone for a NEW problem and again every 6 hours while it is
// still open, and sends a recovery notice when it clears. Dedupe rides on the
// same watchdog_alerts table the cloud watchdog uses, under `nimbus:` keys, so
// the two never fight over a row.
//
// ?report=1 also pushes the digest even when nothing is broken. That is how the
// morning report arrives; the every-30-minutes run stays silent unless
// something is actually wrong.
//
// HONESTY: a check that could not run is reported as could-not-check. It is
// never counted as healthy, and it never pushes a false all-clear.
// ───────────────────────────────────────────────────────────────────────────

const REPUSH_MS = 6 * 60 * 60 * 1000;
const KEY_PREFIX = "nimbus:";
type AlertRow = { key: string; title: string | null; last_pushed: string | null; resolved_at: string | null };

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
  if (sameSecret(req.headers.get("x-heartbeat-key"), process.env.HEARTBEAT_KEY)) return true;
  return false;
}

/** Keep the daily report in the vault when this runs on the PC. Best effort. */
async function writeVaultReport(text: string): Promise<string | null> {
  if (process.env.RUNTIME_ENV === "cloud") return null;
  try {
    const fs = await import("fs");
    const path = await import("path");
    const { VAULT_PATH } = await import("@/lib/vaultSource");
    const day = new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
    const dir = path.join(VAULT_PATH, "wiki", "nimbus", "reports");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${day}.md`);
    const stamp = new Date().toLocaleTimeString("en-US", { timeZone: "America/Chicago", hour: "numeric", minute: "2-digit" });
    fs.appendFileSync(file, `\n## ${stamp}\n\n${text}\n`, "utf-8");
    return `wiki/nimbus/reports/${day}.md`;
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const url = sbUrl();
  const key = sbService();
  const wantsDigest = req.nextUrl.searchParams.get("report") === "1";

  const watch = await runNimbusWatch();
  const text = formatWatchReport(watch);
  const savedTo = await writeVaultReport(text);

  // No database means no dedupe state, so alerting would either spam or lie.
  // Say that plainly instead of pretending the run was clean.
  if (!url || !key) {
    return NextResponse.json(
      { ok: false, error: "supabase not configured, so nothing could be deduped or alerted", headline: watch.headline, report: text },
      { status: 503 }
    );
  }

  const now = Date.now();
  const open = await sbSelect<AlertRow>({ table: "watchdog_alerts", service: true, query: "resolved_at=is.null" });
  const mine = open.filter((a) => a.key.startsWith(KEY_PREFIX));
  const headers = {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    Prefer: "resolution=merge-duplicates",
  };

  const alertKey = (c: Check) => `${KEY_PREFIX}${c.id}`;
  const problemKeys = new Set(watch.problems.map(alertKey));
  let pushed = 0;

  for (const p of watch.problems) {
    const k = alertKey(p);
    const existing = mine.find((a) => a.key === k);
    const due = !existing || !existing.last_pushed || now - new Date(existing.last_pushed).getTime() > REPUSH_MS;
    if (due) {
      await pushToAll({
        title: `${p.severity === "high" ? "🔴" : "🟠"} ${p.label}`,
        // The alert carries the fix, so a lock-screen glance is actionable.
        // Only the detail may be shortened; the fix goes out intact.
        body: alertBody(p.detail, p.fix),
        url: p.link?.href || "/mission",
        tag: k,
      });
      pushed++;
    }
    await fetch(`${url}/rest/v1/watchdog_alerts?on_conflict=key`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        key: k,
        title: p.label,
        body: p.detail,
        last_seen: new Date(now).toISOString(),
        resolved_at: null,
        ...(due ? { last_pushed: new Date(now).toISOString() } : {}),
      }),
    }).catch(() => {});
  }

  for (const a of mine) {
    if (!problemKeys.has(a.key)) {
      await fetch(`${url}/rest/v1/watchdog_alerts?key=eq.${encodeURIComponent(a.key)}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ resolved_at: new Date(now).toISOString() }),
      }).catch(() => {});
      await pushToAll({ title: "✅ Fixed", body: `${a.title || a.key.slice(KEY_PREFIX.length)} is back to normal.`, url: "/mission", tag: a.key });
      pushed++;
    }
  }

  // The scheduled digest: one push a day with the headline, whatever the state.
  if (wantsDigest) {
    await pushToAll({
      title: watch.problems.length ? `Nimbus: ${watch.headline}` : "Nimbus: all clear",
      body: watch.problems.length
        ? watch.problems.map((p) => p.label).join(", ").slice(0, 220)
        : `${watch.checks.filter((c) => c.state === "ok").length} checks passed${watch.unknowns.length ? `, ${watch.unknowns.length} could not run` : ""}.`,
      url: "/mission",
      tag: "nimbus:digest",
    });
    pushed++;
  }

  return NextResponse.json({
    ok: true,
    ranAt: watch.ranAt,
    headline: watch.headline,
    problems: watch.problems.length,
    couldNotCheck: watch.unknowns.length,
    pushed,
    savedTo,
    report: text,
  });
}
