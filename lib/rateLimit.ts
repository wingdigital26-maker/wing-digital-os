// Shared rate limit + daily spend ceiling for money-spending API routes.
//
// WHAT THIS IS, HONESTLY
// ---------------------
// Counters live in Postgres (OS Supabase, table `lecture_usage`, see
// docs/lecture_rate_limit.sql). Every reservation runs inside ONE plpgsql
// function that takes a pg advisory transaction lock, so concurrent requests
// are serialized in the database.
//
// WHAT THAT DOES STOP:
//   - Bursts spread across many Vercel instances. The cap is a real global cap,
//     not a per-instance approximation, because no instance keeps state.
//   - Cost overshoot from concurrency. Each call PRE-CHARGES an estimated cost
//     before the model runs and settles the difference afterwards, so ten
//     simultaneous callers cannot each read the same "spend so far" and all
//     decide there is room.
//   - A stolen bearer token being used to run up an unbounded bill. It can burn
//     at most the configured daily call/dollar budget, then it is dead until
//     UTC midnight.
//
// WHAT IT DOES *NOT* STOP:
//   - A stolen token still gets the full daily budget. This is a spend cap, not
//     authentication. Rotating LECTURE_API_SECRET is still the fix for a leak.
//   - Per-IP limits are per-IP. Anything with a pool of addresses (or any proxy
//     in front) walks past the per-IP tiers straight to the global ones. The
//     global call cap and the dollar ceiling are the limits that actually
//     bound the money; the per-IP ones only keep one noisy client polite.
//   - X-Forwarded-For is client-supplied upstream of Vercel's own edge. Vercel
//     overwrites it, but do not treat the IP as trustworthy identity.
//   - Windows are UTC calendar days, so a caller can spend the full budget at
//     23:59 and the full budget again at 00:01.
//
// FAIL-CLOSED. If Supabase is unreachable or the table/function is missing,
// reserve() returns a refusal, and the caller must return 503 rather than
// spend. For a ceiling whose entire job is protecting real money, an outage in
// the thing that counts the money is not a reason to stop counting it. The cost
// of being wrong the other way is a bill with no ceiling on it.

import { sbUrl, sbService } from "./osSupabase";

export type Reservation =
  | { ok: true; ipCalls: number; dayCalls: number; daySpend: number }
  | { ok: false; reason: "burst" | "ip_daily" | "global_daily" | "spend" | "backend"; retryAfter: number; detail: string };

export type Limits = {
  burstLimit: number;
  burstSecs: number;
  ipDaily: number;
  globalDaily: number;
  spendUsd: number;
};

function num(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

// Conservative by design: one student summarising his own lectures needs
// single-digit calls a day. Every value is env-overridable.
export function lectureLimits(): Limits {
  return {
    burstLimit: num("LECTURE_RATE_BURST", 3),
    burstSecs: num("LECTURE_RATE_BURST_SECS", 60),
    ipDaily: num("LECTURE_RATE_IP_DAILY", 15),
    globalDaily: num("LECTURE_RATE_GLOBAL_DAILY", 30),
    spendUsd: num("LECTURE_DAILY_SPEND_USD", 1.5),
  };
}

// Best guess at what a call will cost, in dollars, before it runs. Input is
// billed at $5/M and output at $25/M; we assume a full-length answer so the
// estimate errs high, which makes the ceiling err safe. The real number
// replaces this via settle().
export function estimateCost(inputChars: number, assumedOutputTokens = 2000): number {
  const inputTokens = inputChars / 3.5; // deliberately pessimistic chars-per-token
  return (inputTokens * 5 + assumedOutputTokens * 25) / 1_000_000;
}

export function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for") ?? "";
  const first = xff.split(",")[0]?.trim();
  return first || req.headers.get("x-real-ip")?.trim() || "unknown";
}

async function rpc(fn: string, args: Record<string, unknown>): Promise<unknown> {
  const url = sbUrl();
  const key = sbService();
  if (!url || !key) throw new Error("OS_SUPABASE_URL / OS_SUPABASE_SERVICE_KEY not set");
  const r = await fetch(`${url}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(args),
    cache: "no-store",
  });
  if (!r.ok) throw new Error(`${fn} -> ${r.status} ${(await r.text().catch(() => "")).slice(0, 200)}`);
  return r.json();
}

const REASON_DETAIL: Record<string, string> = {
  burst: "too many requests in a short window",
  ip_daily: "daily request limit reached for this client",
  global_daily: "daily request limit reached for this endpoint",
  spend: "daily spend ceiling reached for this endpoint",
};

// Claim one call slot and pre-charge `est` dollars against today's ceiling.
export async function reserve(ip: string, limits: Limits, est: number): Promise<Reservation> {
  let rows: any;
  try {
    rows = await rpc("lecture_rate_reserve", {
      p_ip: ip,
      p_burst_limit: limits.burstLimit,
      p_burst_secs: limits.burstSecs,
      p_ip_limit: limits.ipDaily,
      p_day_limit: limits.globalDaily,
      p_spend_limit: limits.spendUsd,
      p_est: est,
    });
  } catch (e) {
    // Fail CLOSED: see the header comment. No counter means no spending.
    return {
      ok: false,
      reason: "backend",
      retryAfter: 60,
      detail: `rate limit backend unavailable: ${String(e).slice(0, 200)}`,
    };
  }
  const row = Array.isArray(rows) ? rows[0] : rows;
  if (!row || typeof row.allowed !== "boolean") {
    return { ok: false, reason: "backend", retryAfter: 60, detail: "rate limit backend returned no decision" };
  }
  if (row.allowed) {
    return {
      ok: true,
      ipCalls: Number(row.ip_calls) || 0,
      dayCalls: Number(row.day_calls) || 0,
      daySpend: Number(row.day_spend) || 0,
    };
  }
  const known = ["burst", "ip_daily", "global_daily", "spend"] as const;
  const raw = String(row.reason);
  const reason = (known as readonly string[]).includes(raw)
    ? (raw as (typeof known)[number])
    : ("backend" as const);
  return {
    ok: false,
    reason,
    retryAfter: Math.max(1, Number(row.retry_after) || 60),
    detail: REASON_DETAIL[reason] ?? "rate limited",
  };
}

// Replace the pre-charged estimate with what the call really cost. Pass the
// actual dollar cost, or 0 when the call produced nothing billable-ish (a
// failed upstream call still consumed a call slot, which we keep counted).
export async function settle(ip: string, est: number, actual: number): Promise<void> {
  const delta = actual - est;
  if (Math.abs(delta) < 0.000001) return;
  try {
    await rpc("lecture_rate_settle", { p_ip: ip, p_delta: delta });
  } catch {
    // Settling is a correction, not a gate. If it fails the estimate stands,
    // which biases the ceiling conservative. Nothing to recover.
  }
}

// Constant-time bearer comparison. Free to do, so there is no reason not to.
export function bearerOk(header: string | null, secret: string | undefined): boolean {
  if (!secret) return false; // fail CLOSED: no key configured => nobody gets in
  const expected = `Bearer ${secret}`;
  const a = Buffer.from(header ?? "", "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) {
    // Length alone leaks nothing useful here, but still burn a comparison.
    timingSafeEqualSafe(b, b);
    return false;
  }
  return timingSafeEqualSafe(a, b);
}

function timingSafeEqualSafe(a: Buffer, b: Buffer): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { timingSafeEqual } = require("crypto") as typeof import("crypto");
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
