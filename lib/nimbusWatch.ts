// ───────────────────────────────────────────────────────────────────────────
// The Nimbus watch: one pass over the whole business, in Nimbus's voice.
//
// The existing cloud watchdog answers "are the agents alive". This answers the
// larger question Jack actually asks: is anything not working. Sending, client
// publishing, revenue running out, the lead pipeline, the call room, the agent
// fleet, and the client sites themselves.
//
// HONESTY RULES
//   * Three states only: ok, problem, unknown. A check that could not run is
//     UNKNOWN and says why. It is never reported as ok and never as a zero.
//   * Every problem carries a link to the thing that is broken, so the alert is
//     one tap from the fix.
//   * Thresholds are stated in the detail line, so a report can be argued with.
//   * No em dashes.
//
// Used by /api/cron/nimbus-report (push alerts + the daily report) and by the
// nimbus_report tool, so the chat answer and the phone alert can never disagree.
// ───────────────────────────────────────────────────────────────────────────
import { getRevenueTruth } from "@/lib/revenue";
import { sbUrl, sbService } from "@/lib/osSupabase";
import { EXPECTED_HEARTBEATS, inPcWindow } from "@/lib/watchdogExpected";

export type CheckState = "ok" | "problem" | "unknown";
export type Check = {
  /** Stable id. Alert keys are derived from it, so renaming one re-alerts. */
  id: string;
  label: string;
  state: CheckState;
  /** One plain sentence. For a problem, what is wrong and against what threshold. */
  detail: string;
  /** Where to go to fix it. Every problem must have one. */
  link?: { label: string; href: string };
  /**
   * What to actually DO about it, in one imperative sentence. Required on every
   * problem: an alert that names a symptom and stops leaves the reader guessing,
   * which is the failure mode this watch exists to remove.
   */
  fix?: string;
  /** Severity for ordering and for the push title. */
  severity?: "high" | "normal";
};

export type WatchResult = {
  ranAt: string;
  checks: Check[];
  problems: Check[];
  unknowns: Check[];
  /** One line Nimbus can open a report with. */
  headline: string;
};

const OS_LINK = (path: string, label: string) => ({ label, href: path });

/**
 * A link into an in-shell view of "/". The shell reads the HASH form
 * (app/page.tsx honors "#view=<subId>" on mount and on hashchange); a "?view="
 * query param is read by nothing and lands on the default view, so every link
 * here has to be built with this helper. Ids must be real NAV_TREE sub ids
 * (app/lib/nav.ts) or LEGACY_VIEW_ALIAS keys. Note the agents view id is
 * "agent", singular.
 */
const VIEW_LINK = (subId: string, label: string) => ({ label, href: `/#view=${subId}` });

/**
 * Some agents write a whole report into their heartbeat message, and the first
 * line is a banner or a date stamp rather than the failure. Pick the first line
 * that actually carries information: skip separators, skip bare dates/times,
 * and skip all-caps banners (with or without a "label:" prefix in front).
 */
export function firstInformativeLine(message: string | null | undefined): string | null {
  const lines = (message || "")
    .split(String.fromCharCode(10))
    .map((l) => l.trim())
    .filter(Boolean);
  for (const line of lines) {
    // Drop a leading "Something:" label before judging what follows it.
    const body = line.replace(/^[A-Za-z][\w '-]{0,40}:\s*/, "") || line;
    // Remove dates, clock times and punctuation to see what content is left.
    const bare = body
      .replace(/\d{4}-\d{2}-\d{2}([T ]\d{1,2}:\d{2}(:\d{2})?)?/g, " ")
      .replace(/\b\d{1,2}:\d{2}(:\d{2})?\s*(am|pm)?\b/gi, " ")
      .replace(/[^A-Za-z ]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (bare.length < 8) continue; // separator, date stamp, or near-empty
    if (bare === bare.toUpperCase()) continue; // ALL-CAPS BANNER
    return line;
  }
  return lines[0] || null;
}

/** Push bodies get cut around here on a lock screen, so budget to it. */
const BODY_MAX = 300;

/**
 * Build the push body so the FIX always survives whole. The detail is the part
 * that gets shortened; a fix cut mid-word ("...so plug the laptop in and
 * re-enable") is worse than no fix at all, because it reads like an
 * instruction and is not one.
 */
export function alertBody(detail: string, fix: string | undefined, max = BODY_MAX): string {
  const tail = fix ? ` FIX: ${fix}` : "";
  // No room for both: the fix wins and goes out on its own, uncut. It is the
  // only actionable half.
  const room = max - tail.length;
  if (room < 24) return (fix ? `FIX: ${fix}` : detail.slice(0, max)).trim();
  if (detail.length <= room) return `${detail}${tail}`;
  // Trim the detail on a word boundary and mark that it was shortened.
  const cut = detail.slice(0, room - 3);
  const at = cut.lastIndexOf(" ");
  return `${(at > room / 2 ? cut.slice(0, at) : cut).trimEnd()}...${tail}`;
}

function ok(id: string, label: string, detail: string): Check {
  return { id, label, state: "ok", detail };
}
function unknown(id: string, label: string, why: string): Check {
  return { id, label, state: "unknown", detail: `Could not check: ${why}` };
}
function problem(
  id: string,
  label: string,
  detail: string,
  link: Check["link"],
  fix: string,
  severity: "high" | "normal" = "normal"
): Check {
  return { id, label, state: "problem", detail, link, fix, severity };
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const daysSince = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.floor((Date.now() - t) / 86400000);
};

// ── PostgREST helpers. These throw, so a failure becomes UNKNOWN, never ok. ──
function osEnv(): { url: string; key: string } {
  const url = sbUrl();
  const key = sbService();
  if (!url || !key) throw new Error("OS_SUPABASE_URL / OS_SUPABASE_SERVICE_KEY are not set");
  return { url: url.replace(/\/$/, ""), key };
}
function sonarEnv(): { url: string; key: string } {
  const url = process.env.SONAR_SUPABASE_URL;
  const key = process.env.SONAR_SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error("SONAR_SUPABASE_URL / SONAR_SUPABASE_SERVICE_KEY are not set");
  return { url: url.replace(/\/$/, ""), key };
}
async function rows<T>(env: { url: string; key: string }, query: string): Promise<T[]> {
  const r = await fetch(`${env.url}/rest/v1/${query}`, {
    headers: { apikey: env.key, Authorization: `Bearer ${env.key}` },
    cache: "no-store",
  });
  if (!r.ok) throw new Error(`${r.status} reading ${query.split("?")[0]}`);
  return (await r.json()) as T[];
}
async function count(env: { url: string; key: string }, query: string): Promise<number> {
  const sep = query.includes("?") ? "&" : "?";
  const r = await fetch(`${env.url}/rest/v1/${query}${sep}select=id`, {
    method: "HEAD",
    headers: { apikey: env.key, Authorization: `Bearer ${env.key}`, Prefer: "count=exact", Range: "0-0" },
    cache: "no-store",
  });
  if (!r.ok) throw new Error(`${r.status} counting ${query.split("?")[0]}`);
  const cr = r.headers.get("content-range");
  const n = cr ? Number(cr.split("/")[1]) : NaN;
  if (!Number.isFinite(n)) throw new Error(`no count returned for ${query.split("?")[0]}`);
  return n;
}

// ── The checks ───────────────────────────────────────────────────────────────

// Cold email: is the sender paused, erroring, or silently doing nothing.
async function checkSending(): Promise<Check[]> {
  const out: Check[] = [];
  try {
    const os = osEnv();
    const state = await rows<{ client: string; paused: boolean | null; count: number | null; updated_at: string }>(
      os,
      "outreach_state?select=client,paused,count,updated_at&order=updated_at.desc&limit=3"
    );
    if (!state.length) {
      out.push(unknown("send:state", "Cold email sender", "no outreach_state rows exist yet"));
    } else {
      const s = state[0];
      const age = daysSince(s.updated_at);
      if (s.paused) {
        out.push(
          problem(
            "send:paused",
            "Cold email sender",
            `The sender is paused${age === null ? "" : ` and has been since its last run ${age} days ago`}. Nothing is going out.`,
            VIEW_LINK("email", "CRM > Email"),
            "Unpause the sender in Supabase outreach_state (set paused to false for client wing), then confirm the next cloud run sends.")
        );
      } else if (age !== null && age >= 2) {
        out.push(
          problem(
            "send:silent",
            "Cold email sender",
            `The sender is armed but has not run in ${age} days (expected daily).`,
            VIEW_LINK("email", "CRM > Email"),
            "Check the outreach GitHub Actions run for a failure, then re-run it. If the cloud runner is fine, look at the send-ready lead count.")
        );
      } else {
        out.push(ok("send:state", "Cold email sender", `Running, last recorded ${s.count ?? "an unknown number of"} sends.`));
      }
    }
  } catch (e) {
    out.push(unknown("send:state", "Cold email sender", errText(e)));
  }

  try {
    const sonar = sonarEnv();
    const since = new Date(Date.now() - 7 * 86400000).toISOString();
    const errors = await count(sonar, `outbound?last_send_error=not.is.null&sent_at=is.null&last_send_attempt_at=gte.${encodeURIComponent(since)}`);
    if (errors > 0) {
      out.push(
        problem(
          "send:errors",
          "Email send errors",
          `${errors} email${errors === 1 ? "" : "s"} failed to send in the last 7 days and never went out.`,
          VIEW_LINK("email", "CRM > Email"),
            "Open Deliverability and read last_send_error on the failed rows. A bad mailbox password or a rejected domain is the usual cause.")
      );
    } else {
      out.push(ok("send:errors", "Email send errors", "No failed sends in the last 7 days."));
    }
  } catch (e) {
    out.push(unknown("send:errors", "Email send errors", errText(e)));
  }
  return out;
}

// Money: is a retainer about to run out, and is anything unpriced.
async function checkRevenue(): Promise<Check[]> {
  try {
    const t = await getRevenueTruth();
    const out: Check[] = [];
    if (t.nextExpiry && t.nextExpiry.monthsRemaining <= 2) {
      out.push(
        problem(
          "revenue:expiring",
          "Revenue expiring",
          `$${t.nextExpiry.amount.toLocaleString()}/mo ends ${t.nextExpiry.end}, ${t.nextExpiry.monthsRemaining} month${t.nextExpiry.monthsRemaining === 1 ? "" : "s"} left, unless it is renewed. That is ${Math.round((t.nextExpiry.amount / Math.max(t.mrr, 1)) * 100)}% of MRR.`,
          VIEW_LINK("clients", "Clients"),
            "Start the renewal conversation now. A term that ends with nothing lined up is a cliff, not a surprise.", "high")
      );
    } else {
      out.push(ok("revenue:expiring", "Revenue expiring", `MRR is $${t.mrr.toLocaleString()} with no term ending inside two months.`));
    }
    if (t.unknown.length) {
      // Two different causes, two different fixes. getRevenueTruth marks a
      // roster client that has no vault page at all with needsVaultPage (see
      // lib/revenue.ts), and telling Jack to edit frontmatter on a file that
      // does not exist is a dead instruction.
      const noPage = t.unknown.filter((c) => c.needsVaultPage).map((c) => c.name);
      const noFigure = t.unknown.filter((c) => !c.needsVaultPage).map((c) => c.name);
      const fixParts: string[] = [];
      if (noFigure.length)
        fixParts.push(
          `Add revenue_amount and revenue_basis to the frontmatter of the vault page for ${noFigure.join(", ")}.`
        );
      if (noPage.length)
        fixParts.push(
          `Create a vault client page for ${noPage.join(", ")} (they are on the roster with no page at all) with revenue_amount and revenue_basis in the frontmatter.`
        );
      out.push(
        problem(
          "revenue:unpriced",
          "Clients with no figure",
          `${t.unknown.length} active client${t.unknown.length === 1 ? " has" : "s have"} no amount on file, so MRR is understated by an unknown amount: ${t.unknown.map((c) => `${c.name}${c.needsVaultPage ? " (no vault page)" : ""}`).join(", ")}.`,
          VIEW_LINK("clients", "Clients"),
          fixParts.join(" ")
        )
      );
    }
    return out;
  } catch (e) {
    return [unknown("revenue:expiring", "Revenue", errText(e))];
  }
}

// The agent fleet, judged by the same table the cloud watchdog uses.
async function checkAgents(): Promise<Check[]> {
  try {
    const os = osEnv();
    const beats = await rows<{ agent: string; status: string; message: string | null; last_beat: string }>(
      os,
      "agent_heartbeats?select=agent,status,message,last_beat"
    );
    const byAgent = new Map(beats.map((b) => [b.agent, b]));
    const out: Check[] = [];
    const stale: string[] = [];
    const missing: string[] = [];
    const disabled: string[] = [];
    let judged = 0; // only agents this pass actually looked at
    const inWindow = inPcWindow();
    for (const exp of EXPECTED_HEARTBEATS) {
      if (exp.windowed && !inWindow) continue;
      const b = byAgent.get(exp.agent);
      // An expected agent with NO row at all has never checked in. That is a
      // problem, not an unknown: the expectation is ours, so silence from an
      // agent we expect to hear from is a fact about the fleet, not a gap in
      // what we could measure. Skipping it let the fleet report green.
      if (!b) {
        missing.push(`${exp.label} (${exp.agent})`);
        judged++;
        continue;
      }
      if (b.status === "disabled") {
        disabled.push(exp.label);
        continue;
      }
      judged++;
      const ageMin = (Date.now() - new Date(b.last_beat).getTime()) / 60000;
      if (ageMin > exp.staleMin) stale.push(`${exp.label} (${Math.round(ageMin / 60)}h ago)`);
    }
    const erroring = beats.filter((b) => b.status === "error");
    if (stale.length) {
      out.push(problem("agents:stale", "Silent agents", `${stale.length} agent${stale.length === 1 ? "" : "s"} past the allowed gap: ${stale.join(", ")}.`, VIEW_LINK("agent", "Mission Control"),
            "Open Mission Control and check that task's last run. A battery-frozen or disabled Windows task is the usual cause, so plug the laptop in and re-enable it."));
    }
    if (missing.length) {
      out.push(
        problem(
          "agents:missing",
          "Agents that have never reported",
          `${missing.length} expected agent${missing.length === 1 ? " has" : "s have"} no heartbeat row at all: ${missing.join(", ")}.`,
          VIEW_LINK("agent", "Mission Control"),
          "Either start that agent so it posts a heartbeat, or drop it from EXPECTED_HEARTBEATS in lib/watchdogExpected.ts if it is retired. An expected agent with no row is invisible everywhere else.",
          "high"
        )
      );
    }
    for (const b of erroring) {
      // Some agents report a whole report as their message, headed by a banner
      // and a date. Take the first line that actually says something.
      const first = firstInformativeLine(b.message) || "No detail was recorded with the error.";
      out.push(problem(`agents:error:${b.agent}`, `${b.agent} reported an error`, first.slice(0, 200), VIEW_LINK("agent", "Mission Control"), "Open Mission Control and read that agent's full message, then fix what it reported and let it run again."));
    }
    if (!stale.length && !missing.length && !erroring.length) {
      // Count what was judged, not beats.length: that included disabled rows
      // and rows for agents nobody expects.
      out.push(
        ok(
          "agents:stale",
          "Agent fleet",
          `All ${judged} expected agent${judged === 1 ? " is" : "s are"} inside their allowed gap${disabled.length ? `, and ${disabled.length} (${disabled.join(", ")}) ${disabled.length === 1 ? "is" : "are"} marked disabled and not judged` : ""}.`
        )
      );
    }
    return out;
  } catch (e) {
    return [unknown("agents:stale", "Agent fleet", errText(e))];
  }
}

// The lead pipeline, read from the cloud copy so this works with the PC off.
async function checkPipeline(): Promise<Check[]> {
  try {
    const os = osEnv();
    const sendable = await count(os, "prospects?trade=eq.b2b&status=in.(new,enriching)");
    if (sendable < 200) {
      return [
        problem(
          "pipeline:low",
          "Send-ready leads",
          `Only ${sendable} leads are send-ready (below the 200 mark). The scrapers need to run before the sender runs dry.`,
          VIEW_LINK("crm", "CRM"),
            "Run `python C:/Users/wjack/ghl-cli/b2b_prospect_run.py` to scrape and stage new B2B leads, then `python C:/Users/wjack/ghl-cli/arm_b2b_scored.py` to arm them so the cloud sender can drain them."),
      ];
    }
    return [ok("pipeline:low", "Send-ready leads", `${sendable.toLocaleString()} leads are send-ready.`)];
  } catch (e) {
    return [unknown("pipeline:low", "Send-ready leads", errText(e))];
  }
}

// The call room: leads waiting on a call-back that nobody has made.
async function checkCallRoom(): Promise<Check[]> {
  try {
    const os = osEnv();
    const overdue = await count(os, `call_leads?next_action_at=lt.${encodeURIComponent(new Date().toISOString())}&status=neq.dead`);
    if (overdue > 0) {
      return [
        problem(
          "calls:overdue",
          "Call-backs overdue",
          `${overdue} lead${overdue === 1 ? " is" : "s are"} past the call-back time you set.`,
          OS_LINK("/calls", "Call room"),
          "Open the call room and either make the call or move the call-back time so the list stays honest."
        ),
      ];
    }
    return [ok("calls:overdue", "Call-backs", "No call-back is past its time.")];
  } catch (e) {
    return [unknown("calls:overdue", "Call-backs", errText(e))];
  }
}

// Client delivery: is anything actually going live for the people who pay.
async function checkClientPublishing(): Promise<Check[]> {
  // Reading the built dashboards needs the filesystem, which the cloud has a
  // copy of at build time. Import lazily so this module stays edge-friendly.
  try {
    const fs = await import("fs");
    const path = await import("path");
    const dir = path.join(process.cwd(), "public", "dashboards");
    if (!fs.existsSync(dir)) return [unknown("clients:quiet", "Client publishing", "no built dashboards on this host")];
    const out: Check[] = [];
    const quiet: string[] = [];
    const empty: string[] = [];
    const unreadable: string[] = [];
    let judged = 0;
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".html") && !x.endsWith(".artifact.html"))) {
      // Sample dashboards are demos, not clients, and must not raise alarms.
      if (/summit-ridge/i.test(f)) continue;
      const html = fs.readFileSync(path.join(dir, f), "utf-8");
      const at = html.indexOf("const DATA = ");
      if (at < 0) {
        // Not a built client dashboard, or the build changed shape. Either way
        // this file was not judged, so say so rather than passing over it.
        unreadable.push(f);
        continue;
      }
      const data = html.slice(at);
      const dates = [...data.matchAll(/"date":"(\d{4}-\d{2}-\d{2})"/g)].map((x) => x[1]).sort();
      const nameMatch = data.match(/"brand":\{"name":"([^"]*)"/);
      const name = nameMatch ? nameMatch[1] : f.replace(/\.html$/, "");
      judged++;
      // A dashboard with no dated work at all is exactly what a client whose
      // delivery stopped looks like. Silently skipping it let the next branch
      // claim every client had work go live.
      if (!dates.length) {
        empty.push(name);
        continue;
      }
      const age = daysSince(dates[dates.length - 1]);
      if (age !== null && age > 14) quiet.push(`${name} (${age} days)`);
    }
    const CONTENT_FIX =
      "Run that client's content engine skill (heros-content-engine or renewal-content-engine), then rebuild the dashboard with `python C:/Users/wjack/wing-digital-os/scripts/client_dashboard/build.py <slug>` so the published record catches up.";
    if (quiet.length) {
      out.push(
        problem(
          "clients:quiet",
          "Client sites gone quiet",
          `Nothing has gone live in over 14 days for: ${quiet.join(", ")}.`,
          VIEW_LINK("clients", "Clients"),
          CONTENT_FIX,
          "high"
        )
      );
    }
    if (empty.length) {
      out.push(
        problem(
          "clients:nodates",
          "Client dashboards with no dated work",
          `${empty.length} dashboard${empty.length === 1 ? " lists" : "s list"} no dated work at all, so there is nothing to age: ${empty.join(", ")}.`,
          VIEW_LINK("clients", "Clients"),
          CONTENT_FIX,
          "high"
        )
      );
    }
    if (unreadable.length) {
      out.push(
        unknown(
          "clients:unreadable",
          "Client publishing",
          `${unreadable.length} file${unreadable.length === 1 ? "" : "s"} in public/dashboards had no readable DATA block, so ${unreadable.length === 1 ? "it was" : "they were"} not judged: ${unreadable.join(", ")}`
        )
      );
    }
    if (!quiet.length && !empty.length) {
      out.push(
        ok("clients:quiet", "Client publishing", `All ${judged} client dashboard${judged === 1 ? "" : "s"} had work go live inside the last 14 days.`)
      );
    }
    return out;
  } catch (e) {
    return [unknown("clients:quiet", "Client publishing", errText(e))];
  }
}

/** Run every check. Never throws: a failed check becomes an unknown. */
export async function runNimbusWatch(): Promise<WatchResult> {
  const groups = await Promise.all([
    checkSending(),
    checkRevenue(),
    checkAgents(),
    checkPipeline(),
    checkCallRoom(),
    checkClientPublishing(),
  ]);
  const checks = groups.flat();
  const problems = checks.filter((c) => c.state === "problem").sort((a, b) => (a.severity === "high" ? -1 : 0) - (b.severity === "high" ? -1 : 0));
  const unknowns = checks.filter((c) => c.state === "unknown");
  const headline = problems.length
    ? `${problems.length} thing${problems.length === 1 ? "" : "s"} need${problems.length === 1 ? "s" : ""} attention` +
      (unknowns.length ? `, and ${unknowns.length} check${unknowns.length === 1 ? "" : "s"} could not run.` : ".")
    : unknowns.length
      ? `Nothing is broken in what I could check, but ${unknowns.length} check${unknowns.length === 1 ? "" : "s"} could not run.`
      : "Everything I watch is working.";
  return { ranAt: new Date().toISOString(), checks, problems, unknowns, headline };
}

/** The report as plain text, used for the vault file and the chat answer. */
export function formatWatchReport(r: WatchResult): string {
  const lines: string[] = [];
  lines.push(r.headline, "");
  if (r.problems.length) {
    lines.push("NEEDS ATTENTION");
    for (const p of r.problems) {
      lines.push(`- ${p.label}: ${p.detail}${p.link ? ` [${p.link.label}: ${p.link.href}]` : ""}`);
      if (p.fix) lines.push(`  FIX: ${p.fix}`);
    }
    lines.push("");
  }
  if (r.unknowns.length) {
    lines.push("COULD NOT CHECK");
    for (const u of r.unknowns) lines.push(`- ${u.label}: ${u.detail}`);
    lines.push("");
  }
  const good = r.checks.filter((c) => c.state === "ok");
  if (good.length) {
    lines.push("WORKING");
    for (const g of good) lines.push(`- ${g.label}: ${g.detail}`);
  }
  return lines.join("\n");
}
