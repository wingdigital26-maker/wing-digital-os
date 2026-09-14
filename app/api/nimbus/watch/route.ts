import { NextRequest, NextResponse } from "next/server";
import { runNimbusWatch } from "@/lib/nimbusWatch";
import { getTriage } from "@/lib/nimbusTriage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

// ───────────────────────────────────────────────────────────────────────────
// GET /api/nimbus/watch
//
// The full watch behind the Nimbus window's problems view. It is a superset of
// /api/nimbus/problems: it returns the same core watch (runNimbusWatch, which
// covers sending, revenue, the agent fleet, the lead pipeline, the call room
// and client publishing), and then ALSO folds in the real attention signals
// that live in OTHER OS surfaces, so Nimbus watches the whole system from one
// panel rather than only the checks the watch itself runs.
//
// Right now the one cross-surface source that exposes attention signals the
// core watch does not already carry is the automated-messaging QA board
// (GET /api/messaging): rows the sender's own copy checks refused (qa-failed),
// rows that failed address verification (bad_email), and rows stuck in
// 'claimed' because a sender grabbed them and never reported back (the reaper
// is not releasing them). Each of those is a real thing to fix, so each is
// surfaced here with a one-click link to the Email hub where it lives.
//
// HONESTY RULES (identical spirit to runNimbusWatch and /api/messaging):
//   * A cross-surface source that could not be read comes back under
//     `unknowns` with the reason. It is NEVER counted as healthy and NEVER
//     zeroed. An empty panel must read as "nothing wrong", not "could not ask".
//   * Every problem carries a link to the thing that is broken.
//   * Cross-surface items carry source:"messaging" and no triage: the triage
//     agent only investigates problems the core watch reports (see
//     /api/nimbus/triage), so offering "Look into it" on a foreign item would
//     be a button that cannot work. Those items get "Ask me" and their link.
//   * `sources` names every OS signal this route consulted and its outcome, so
//     the panel can show honestly what is and is not being watched.
// ───────────────────────────────────────────────────────────────────────────

const MESSAGING_MS = 6000;

type Severity = "high" | "normal";
type Link = { label: string; href: string };
type ExtraProblem = {
  id: string;
  label: string;
  detail: string;
  fix: string | null;
  link: Link | null;
  severity: Severity;
  source: string;
};

// The subset of GET /api/messaging this route reads. Kept minimal and matched
// to that route's real response shape (see app/api/messaging/route.ts).
type MessagingPayload = {
  lane?: { available?: boolean; reason?: string | null };
  guardrails?: {
    qaFailed?: number | null;
    badEmail?: number | null;
    claimed?: number | null;
    claimedNote?: string | null;
  } | null;
};

/**
 * Fetch a sibling OS API server-side. Origin comes from the incoming request
 * so this works on localhost and on the deployed host without configuration.
 * Returns the parsed body, or a short reason string on any failure/timeout.
 */
async function fetchSibling<T>(req: NextRequest, path: string, ms: number): Promise<T | { why: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const url = new URL(path, req.nextUrl.origin).toString();
    const r = await fetch(url, {
      cache: "no-store",
      signal: controller.signal,
      headers: { cookie: req.headers.get("cookie") ?? "" },
    });
    if (!r.ok) return { why: `${path} returned HTTP ${r.status}` };
    return (await r.json()) as T;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { why: msg.includes("aborted") ? `${path} took longer than ${Math.round(ms / 1000)}s, so I skipped it` : `${path} could not be read: ${msg}` };
  } finally {
    clearTimeout(timer);
  }
}

const EMAIL_LINK: Link = { label: "CRM > Email", href: "/#view=email" };

/** Derive attention items from the automated-messaging QA board. */
function messagingProblems(m: MessagingPayload): ExtraProblem[] {
  const out: ExtraProblem[] = [];
  const g = m.guardrails;
  // A null/unavailable guardrails block is handled by the caller as an
  // unknown; here we only translate real, present numbers into problems.
  if (!g) return out;

  const qa = typeof g.qaFailed === "number" ? g.qaFailed : 0;
  if (qa > 0) {
    out.push({
      id: "messaging:qa-failed",
      label: "Cold emails the machine refused to send",
      detail: `${qa} queued email${qa === 1 ? "" : "s"} tripped the sender's own copy checks (placeholder left in, bad greeting, or off tone) and will never be mailed as-is.`,
      fix: "Open CRM > Email and fix or retire each qa-failed row. A row sits at the front of the queue getting skipped until it is cleaned up.",
      link: EMAIL_LINK,
      severity: "normal",
      source: "messaging",
    });
  }

  const bad = typeof g.badEmail === "number" ? g.badEmail : 0;
  if (bad > 0) {
    out.push({
      id: "messaging:bad-email",
      label: "Leads with an unmailable address",
      detail: `${bad} lead${bad === 1 ? "" : "s"} failed address verification, so ${bad === 1 ? "it" : "they"} can never be emailed as ${bad === 1 ? "it is" : "they are"}.`,
      fix: "Open CRM > Email, correct the address on each bad_email row or drop it, so the queue reflects who can actually be reached.",
      link: EMAIL_LINK,
      severity: "normal",
      source: "messaging",
    });
  }

  const claimed = typeof g.claimed === "number" ? g.claimed : 0;
  if (claimed > 0) {
    out.push({
      id: "messaging:stuck-claimed",
      label: "Leads stuck mid-send",
      detail:
        g.claimedNote ??
        `${claimed} row${claimed === 1 ? " is" : "s are"} stuck in 'claimed' — a sender grabbed ${claimed === 1 ? "it" : "them"} and never reported back. The stale-claim reaper should release ${claimed === 1 ? "it" : "them"}.`,
      fix: "If this number persists across days the reaper is not running. Check the outreach cloud job, then release the stale claims so those leads re-enter the queue.",
      link: EMAIL_LINK,
      severity: claimed >= 25 ? "high" : "normal",
      source: "messaging",
    });
  }

  return out;
}

export async function GET(req: NextRequest) {
  // The core watch is the spine. If it cannot run at all, say so the same way
  // /api/nimbus/problems does rather than returning a misleadingly short list.
  let w;
  try {
    w = await runNimbusWatch();
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: `The checks could not be run: ${e instanceof Error ? e.message : String(e)}` },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    );
  }

  const problems = w.problems.map((p) => ({
    id: p.id,
    label: p.label,
    detail: p.detail,
    fix: p.fix ?? null,
    link: p.link ?? null,
    severity: p.severity ?? "normal",
    source: "watch",
    triage: getTriage(p.id),
  }));

  const unknowns = w.unknowns.map((u) => ({ id: u.id, label: u.label, reason: u.detail }));

  // ── Cross-surface source: the automated-messaging QA board ───────────────
  const sources: { id: string; label: string; state: "watched" | "absent"; note: string }[] = [
    {
      id: "watch",
      label: "Core watch",
      state: "watched",
      note: "Sending, revenue, agent fleet, lead pipeline, call room, and client publishing.",
    },
  ];

  const extra: (ExtraProblem & { triage: null })[] = [];
  const msg = await fetchSibling<MessagingPayload>(req, "/api/messaging", MESSAGING_MS);
  if ("why" in msg) {
    unknowns.push({ id: "messaging:board", label: "Automated messaging QA board", reason: msg.why });
    sources.push({ id: "messaging", label: "Messaging QA board", state: "absent", note: msg.why });
  } else if (!msg.guardrails) {
    const reason = msg.lane?.reason || "the messaging board returned no guardrails block";
    unknowns.push({ id: "messaging:board", label: "Automated messaging QA board", reason });
    sources.push({ id: "messaging", label: "Messaging QA board", state: "absent", note: reason });
  } else {
    for (const p of messagingProblems(msg)) extra.push({ ...p, triage: null });
    sources.push({
      id: "messaging",
      label: "Messaging QA board",
      state: "watched",
      note: "Refused sends (qa-failed), unmailable addresses (bad_email), and stuck 'claimed' rows.",
    });
  }

  // The core watch's high-severity items lead; cross-surface items follow in
  // their own severity order, so the panel opens on what is worst first.
  const merged = [
    ...problems,
    ...extra.sort((a, b) => (a.severity === "high" ? -1 : 0) - (b.severity === "high" ? -1 : 0)),
  ];

  const extraHigh = extra.filter((e) => e.severity === "high").length;
  const totalProblems = merged.length;
  const headline =
    totalProblems > 0
      ? `${totalProblems} thing${totalProblems === 1 ? "" : "s"} need${totalProblems === 1 ? "s" : ""} attention` +
        (unknowns.length ? `, and ${unknowns.length} check${unknowns.length === 1 ? "" : "s"} could not run.` : ".")
      : unknowns.length
        ? `Nothing is broken in what I could check, but ${unknowns.length} check${unknowns.length === 1 ? "" : "s"} could not run.`
        : "Everything I watch is working.";

  return NextResponse.json(
    {
      ok: true,
      asOf: w.ranAt,
      headline,
      problems: merged,
      unknowns,
      sources,
      working: w.checks.filter((c) => c.state === "ok").length,
      // Kept for parity with the old shape; high-severity count across all.
      highSeverity: w.problems.filter((c) => c.severity === "high").length + extraHigh,
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
