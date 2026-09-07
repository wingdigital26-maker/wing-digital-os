// ───────────────────────────────────────────────────────────────────────────
// The Nimbus glance: a tiny read-only feed the desktop window can render the
// instant it opens, without asking the model anything.
//
// HONESTY RULES (the entire point of this route)
//   * A section that could not be read is null, and the reason goes in
//     couldNotCheck as a short human sentence. Never a zero, never a guess.
//     A zero that means "no data" is a lie in a business dashboard.
//   * Every source is capped in time. Slow is reported, not waited on.
//   * READ ONLY: nothing is written, sent, or alerted here.
//   * The watch result may be a remembered one, but it always carries asOf /
//     ageSeconds / stale so the window can state its age. Fast is never bought
//     by presenting an old number as a current one.
//   * watch.unknowns carries the checks the WATCH could not run; couldNotCheck
//     carries this route's own source failures. Two different things, kept apart.
// ───────────────────────────────────────────────────────────────────────────
import { NextResponse } from "next/server";
import { exec } from "child_process";
import { promisify } from "util";
import { runNimbusWatch } from "@/lib/nimbusWatch";
import { getRevenueTruth } from "@/lib/revenue";
import { isCloud } from "@/lib/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

const execAsync = promisify(exec);
const TZ = "America/Chicago";

const WATCH_MS = 9000;
const REVENUE_MS = 7000;
const AGENTS_MS = 6000;

// ── Disclosed-age caches ───────────────────────────────────────────────────
// Two of the three sources are slow: runNimbusWatch makes several database
// round trips, and reading the Windows Task Scheduler spawns PowerShell, which
// alone measured about 3.7 seconds. This window is opened with a keystroke, so
// the first paint has to be immediate.
//
// The deal we make: a remembered answer is served instantly, ALWAYS stamped
// with the moment it was actually taken, and refreshed in the background for
// the next open. A stale figure presented AS current would be a lie; a figure
// carrying its own age is not, so the window can say "as of 40 seconds ago".
// Nothing is invented and nothing is zeroed: an empty cache still waits for a
// real answer, and a failed refresh is confessed rather than papered over.
const FRESH_MS = 60_000; // younger than this: serve it, do not even refresh
const MAX_AGE_MS = 10 * 60_000; // older than this: too old to show, wait for a real one

type Cached<T> = { value: T; at: number };
type Slot<T> = {
  cache: Cached<T> | null;
  inFlight: Promise<T> | null;
  lastError: { why: string; at: number } | null;
};
type G = typeof globalThis & { __nimbusGlanceSlots?: Record<string, Slot<unknown>> };
// Held on globalThis so the dev server's module reloads do not throw it away.
const g = globalThis as G;
const slots: Record<string, Slot<unknown>> = (g.__nimbusGlanceSlots ??= {});

function slotFor<T>(key: string): Slot<T> {
  slots[key] ??= { cache: null, inFlight: null, lastError: null };
  return slots[key] as Slot<T>;
}

/** Start a refresh of this slot, or join the one already running. */
function refresh<T>(key: string, work: () => Promise<T>): Promise<T> {
  const slot = slotFor<T>(key);
  if (slot.inFlight) return slot.inFlight;
  const run = work()
    .then((value) => {
      slot.cache = { value, at: Date.now() };
      slot.lastError = null;
      return value;
    })
    .catch((e) => {
      slot.lastError = { why: e instanceof Error ? e.message : String(e), at: Date.now() };
      throw e;
    })
    .finally(() => {
      slot.inFlight = null;
    });
  slot.inFlight = run;
  return run;
}

type Served<T> = { value: T; at: number; fromCache: boolean; refreshFailedSince: string | null };

/**
 * Serve this source from its cache when there is a usable one, kicking off a
 * background refresh once it passes FRESH_MS. Returns null only when there is
 * nothing showable, in which case the caller must do the slow real read.
 */
function serveCached<T>(key: string, work: () => Promise<T>): Served<T> | null {
  const slot = slotFor<T>(key);
  const cached = slot.cache;
  if (!cached) return null;
  const age = Date.now() - cached.at;
  if (age >= MAX_AGE_MS) return null;
  if (age >= FRESH_MS) void refresh(key, work).catch(() => {});
  return {
    value: cached.value,
    at: cached.at,
    fromCache: true,
    // A background refresh that failed must not hide behind a served cache.
    refreshFailedSince: slot.lastError && slot.lastError.at > cached.at ? slot.lastError.why : null,
  };
}

/** How old a served answer is, in whole seconds, and whether that counts as stale. */
function ageOf(at: number) {
  const ageSeconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  return { asOf: new Date(at).toISOString(), ageSeconds, stale: ageSeconds >= Math.round(FRESH_MS / 1000) };
}

/** Resolves to a value, or to a short reason string if it failed or timed out. */
async function attempt<T>(
  label: string,
  ms: number,
  work: () => Promise<T>,
  /**
   * Per-request stopwatch, emitted as Server-Timing. Whoever is debugging a
   * slow glance can see WHICH source is slow instead of guessing at a total.
   * Request-local on purpose: a module-level array would mix concurrent calls.
   */
  timings?: string[]
): Promise<{ value: T } | { why: string }> {
  const started = Date.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} took longer than ${Math.round(ms / 1000)} seconds, so I skipped it.`)), ms);
    });
    return { value: await Promise.race([work(), timeout]) };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { why: msg.includes("took longer") ? msg : `${label} could not be read: ${msg}` };
  } finally {
    if (timer) clearTimeout(timer);
    timings?.push(`${label.replace(/[^A-Za-z]+/g, "") || "src"};dur=${Date.now() - started}`);
  }
}

function centralParts(now: Date) {
  const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", hour12: false }).format(now));
  const dateLine = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, weekday: "long", month: "long", day: "numeric",
  }).format(now);
  const partOfDay: "morning" | "afternoon" | "evening" = hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening";
  return { partOfDay, dateLine };
}

/** Soonest real NextRunTime from the Windows Task Scheduler. No schedule is inferred. */
async function nextAgentRunFromScheduler(): Promise<{ agent: string; when: string } | null> {
  const ps = `Get-ScheduledTask -TaskName 'WingDigital-Agent-*' | ForEach-Object {
    $i = $_ | Get-ScheduledTaskInfo
    [PSCustomObject]@{
      name    = $_.TaskName -replace 'WingDigital-Agent-',''
      state   = "$($_.State)"
      nextRun = if ($i.NextRunTime) { $i.NextRunTime.ToString('o') } else { $null }
    }
  } | ConvertTo-Json -Compress`;
  const encoded = Buffer.from(ps, "utf16le").toString("base64");
  const { stdout } = await execAsync(
    `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${encoded}`,
    { timeout: AGENTS_MS - 500, windowsHide: true }
  );
  const raw = stdout.trim();
  if (!raw) return null;
  const parsed = JSON.parse(raw);
  const tasks: Array<{ name?: string; state?: string; nextRun?: string | null }> = Array.isArray(parsed) ? parsed : [parsed];
  const now = Date.now();
  const upcoming = tasks
    .filter((t) => t.state !== "Disabled" && t.nextRun)
    .map((t) => ({ agent: String(t.name ?? "agent"), at: new Date(t.nextRun as string) }))
    .filter((t) => !Number.isNaN(t.at.getTime()) && t.at.getTime() > now)
    .sort((a, b) => a.at.getTime() - b.at.getTime());
  if (!upcoming.length) return null;
  const soonest = upcoming[0];
  const when = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, weekday: "short", hour: "numeric", minute: "2-digit",
  }).format(soonest.at);
  return { agent: soonest.agent, when };
}

export async function GET() {
  const couldNotCheck: string[] = [];
  const timings: string[] = [];
  const greeting = centralParts(new Date());

  // The slow work for the agent schedule, named once so the cache and the
  // background refresh run exactly the same read.
  const readAgentSchedule = async () => {
    if (isCloud()) throw new Error("the Windows scheduler is only readable on Jack's PC");
    return nextAgentRunFromScheduler();
  };

  // Decide BEFORE the parallel block: a usable cached answer means this request
  // never waits on the database or on PowerShell at all.
  const watchServed = serveCached("watch", runNimbusWatch);
  const agentServed = serveCached("agents", readAgentSchedule);

  const [watchRes, revRes, agentRes] = await Promise.all([
    watchServed
      ? Promise.resolve({ value: watchServed.value })
      : attempt("The watch", WATCH_MS, () => refresh("watch", runNimbusWatch), timings),
    attempt("Revenue", REVENUE_MS, getRevenueTruth, timings),
    agentServed
      ? Promise.resolve({ value: agentServed.value })
      : attempt("The agent schedule", AGENTS_MS, () => refresh("agents", readAgentSchedule), timings),
  ]);

  /** The freshness fields every cacheable section carries. */
  type Freshness = { asOf: string; ageSeconds: number; stale: boolean };

  let watch:
    | ({
        problems: number;
        headline: string;
        /**
         * The checks the WATCH itself could not run, each with its own reason.
         * The headline already counts these ("and 1 check could not run"), and
         * without this the window was told a check failed with no way to say
         * which one. Distinct from couldNotCheck, which is this route's own
         * source failures.
         */
        unknowns: Array<{ id: string; label: string; reason: string }>;
      } & Freshness)
    | null = null;
  if ("value" in watchRes) {
    const r = watchRes.value;
    // Prefer the watch's own ranAt: it is when the pass actually ran, which is
    // the honest stamp whether the result came from the cache or from just now.
    const ranAtMs = Date.parse(r.ranAt);
    const fresh = ageOf(Number.isFinite(ranAtMs) ? ranAtMs : watchServed ? watchServed.at : Date.now());
    watch = {
      problems: r.problems.length,
      headline: r.headline,
      unknowns: r.unknowns.map((u) => ({
        id: u.id,
        label: u.label,
        // detail reads "Could not check: <why>". Hand the reason over on its
        // own so the window can phrase it however it likes.
        reason: u.detail.replace(/^Could not check:\s*/i, ""),
      })),
      ...fresh,
    };
    if (watchServed?.refreshFailedSince) {
      couldNotCheck.push(
        `The watch could not be refreshed, so its figures are ${fresh.ageSeconds} seconds old: ${watchServed.refreshFailedSince}`
      );
    }
  } else {
    couldNotCheck.push(watchRes.why);
  }

  let mrr: { value: number; line: string } | null = null;
  if ("value" in revRes) {
    mrr = { value: revRes.value.mrr, line: revRes.value.mrrBasisLine };
  } else {
    couldNotCheck.push(revRes.why);
  }

  let nextAgentRun: ({ agent: string; when: string } & Freshness) | null = null;
  if ("value" in agentRes) {
    const v = agentRes.value;
    if (!v) {
      couldNotCheck.push("No agent has a scheduled next run time right now.");
    } else {
      nextAgentRun = { ...v, ...ageOf(agentServed ? agentServed.at : Date.now()) };
      if (agentServed?.refreshFailedSince) {
        couldNotCheck.push(
          `The agent schedule could not be re-read, so the next run time is ${nextAgentRun.ageSeconds} seconds old: ${agentServed.refreshFailedSince}`
        );
      }
    }
  } else {
    couldNotCheck.push(agentRes.why);
  }

  return NextResponse.json(
    { ok: true, greeting, watch, mrr, nextAgentRun, couldNotCheck },
    {
      headers: {
        "Cache-Control": "no-store, max-age=0",
        "Server-Timing": [
          `watchcache;desc="${watchServed ? "hit" : "miss"}";dur=0`,
          `agentcache;desc="${agentServed ? "hit" : "miss"}";dur=0`,
          ...timings,
        ].join(", "),
      },
    }
  );
}
