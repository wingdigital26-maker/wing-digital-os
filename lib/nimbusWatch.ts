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

function ok(id: string, label: string, detail: string): Check {
  return { id, label, state: "ok", detail };
}
function unknown(id: string, label: string, why: string): Check {
  return { id, label, state: "unknown", detail: `Could not check: ${why}` };
}
function problem(id: string, label: string, detail: string, link: Check["link"], severity: "high" | "normal" = "normal"): Check {
  return { id, label, state: "problem", detail, link, severity };
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
            OS_LINK("/?view=email", "Deliverability")
          )
        );
      } else if (age !== null && age >= 2) {
        out.push(
          problem(
            "send:silent",
            "Cold email sender",
            `The sender is armed but has not run in ${age} days (expected daily).`,
            OS_LINK("/?view=email", "Deliverability")
          )
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
          OS_LINK("/?view=email", "Deliverability")
        )
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
          OS_LINK("/?view=clients", "Clients"),
          "high"
        )
      );
    } else {
      out.push(ok("revenue:expiring", "Revenue expiring", `MRR is $${t.mrr.toLocaleString()} with no term ending inside two months.`));
    }
    if (t.unknown.length) {
      out.push(
        problem(
          "revenue:unpriced",
          "Clients with no figure",
          `${t.unknown.length} active client${t.unknown.length === 1 ? " has" : "s have"} no amount on file, so MRR is understated by an unknown amount.`,
          OS_LINK("/?view=clients", "Clients")
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
    const inWindow = inPcWindow();
    for (const exp of EXPECTED_HEARTBEATS) {
      if (exp.windowed && !inWindow) continue;
      const b = byAgent.get(exp.agent);
      if (!b || b.status === "disabled") continue;
      const ageMin = (Date.now() - new Date(b.last_beat).getTime()) / 60000;
      if (ageMin > exp.staleMin) stale.push(`${exp.label} (${Math.round(ageMin / 60)}h ago)`);
    }
    const erroring = beats.filter((b) => b.status === "error");
    if (stale.length) {
      out.push(problem("agents:stale", "Silent agents", `${stale.length} agent${stale.length === 1 ? "" : "s"} past the allowed gap: ${stale.join(", ")}.`, OS_LINK("/?view=agents", "Agents")));
    }
    for (const b of erroring) {
      // Some agents report a whole report as their message. Alerts have to fit
      // on a lock screen, so take the first meaningful line and cap it; the
      // full text stays where the agent wrote it.
      const detailLines = (b.message || "").split(String.fromCharCode(10)).map((l) => l.trim()).filter(Boolean);
      const first = detailLines[0] || "No detail was recorded with the error.";
      out.push(problem(`agents:error:${b.agent}`, `${b.agent} reported an error`, first.slice(0, 200), OS_LINK("/?view=agents", "Agents")));
    }
    if (!stale.length && !erroring.length) out.push(ok("agents:stale", "Agent fleet", `All ${beats.length} reporting agents are inside their expected gap.`));
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
          OS_LINK("/?view=crm", "CRM")
        ),
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
          OS_LINK("/calls", "Call room")
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
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".html") && !x.endsWith(".artifact.html"))) {
      const html = fs.readFileSync(path.join(dir, f), "utf-8");
      const at = html.indexOf("const DATA = ");
      if (at < 0) continue;
      const data = html.slice(at);
      const dates = [...data.matchAll(/"date":"(\d{4}-\d{2}-\d{2})"/g)].map((x) => x[1]).sort();
      const nameMatch = data.match(/"brand":\{"name":"([^"]*)"/);
      const name = nameMatch ? nameMatch[1] : f.replace(/\.html$/, "");
      if (!dates.length) continue;
      const newest = dates[dates.length - 1] || null;
      const age = daysSince(newest);
      // Sample dashboards are demos, not clients, and must not raise alarms.
      if (/summit-ridge/i.test(f)) continue;
      if (age === null) quiet.push(`${name} (no dated work on file)`);
      else if (age > 14) quiet.push(`${name} (${age} days)`);
    }
    if (quiet.length) {
      out.push(
        problem(
          "clients:quiet",
          "Client sites gone quiet",
          `Nothing has gone live in over 14 days for: ${quiet.join(", ")}.`,
          OS_LINK("/?view=clients", "Clients"),
          "high"
        )
      );
    } else {
      out.push(ok("clients:quiet", "Client publishing", "Every client had work go live inside the last 14 days."));
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
    for (const p of r.problems) lines.push(`- ${p.label}: ${p.detail}${p.link ? ` [${p.link.label}: ${p.link.href}]` : ""}`);
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
