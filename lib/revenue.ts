// ─────────────────────────────────────────────────────────────────────────────
// THE SINGLE SOURCE OF TRUTH FOR CLIENT REVENUE.
//
// Every surface in the OS that shows a money figure or a client count MUST call
// getRevenueTruth() and render one of its fields. Nothing else may sum, guess,
// hardcode, or regex a revenue number out of a markdown file.
//
// WHY THIS EXISTS
// ---------------
// Before this module the same business fact was computed six different ways and
// disagreed with itself on every screen:
//   1. /api/ghl          summed `mrr:` frontmatter over every wiki/clients/*.md
//                        -> $3,200, and hardcoded a $700 "Jackson Roofing"
//                        fallback whenever the vault hiccuped.
//   2. /api/clients      summed the same field over a DIFFERENT set of rows
//                        (all pages, including the ones it had just flagged as
//                        not-clients) -> a third number.
//   3. /api/jarvis       had `mrr = 700; activeClients = 1;` literally hardcoded
//                        as its fallback, so the assistant confidently told Jack
//                        a number no data supported.
//   4. /api/mission      regexed "**MRR:** $3,200" out of a state-sync markdown
//                        snapshot -> whatever was true whenever that file last ran.
//   5. /api/agents/tools summed GHL won-opportunity `monetaryValue` and LABELLED
//                        IT MRR. Those are one-time deal values, not recurring.
//   6. ClientsBoard.tsx  re-summed the per-client rows client-side.
// That is why Jack saw "$1,250 from Hero's" and "$700 MRR" on the same dashboard.
//
// THE TWO SEPARATE QUESTIONS
// --------------------------
// MEMBERSHIP (who is a client) comes from the Supabase `crm_clients` roster in
// the SONAR project. It is the deliberate, curated list. It must never again be
// derived from "how many markdown files are in wiki/clients/" — that folder holds
// ~40 files (prospects, reports, playbooks, a template) and once reported 37
// active clients when there were 4.
//
// MONEY comes from each client's vault page frontmatter, which is the only place
// Jack actually records it. crm_clients has no money columns.
//
// MEASURES ARE NOT INTERCHANGEABLE
// --------------------------------
// A number is meaningless without its basis, so every amount carries one:
//   monthly     — a confirmed OPEN-ENDED recurring retainer. Sums into MRR and
//                 keeps running until someone cancels it.
//   term        — recurring monthly, but for a FIXED number of months. It is real
//                 recurring revenue right now, so it DOES sum into MRR — but it
//                 has an end date, so it is also reported separately as
//                 `mrrExpiring` with the months remaining. Modelling a fixed-term
//                 deal as plain `monthly` would let Jack read it as durable and be
//                 surprised when it lapses; modelling it as `one_time` would deny
//                 that it is genuinely arriving every month. Neither is true, so
//                 the term is carried explicitly: start date, monthly amount,
//                 number of months, computed end date and months remaining.
//   one_time    — collected once. Real money, but NEVER added to MRR.
//   expected    — agreed/likely but not yet earned. Pipeline. NEVER revenue.
//   unconfirmed — the amount is real but nobody has confirmed whether it recurs.
//                 Held OUT of MRR: silently treating it as recurring would inflate
//                 MRR on an assumption, which is exactly the lie this file exists
//                 to prevent. Surfaces as a question for Jack.
//   unknown     — no figure on file. Rendered as "unknown", NEVER as $0.
//                 A zero that means "no data" is a lie in a revenue dashboard.
//
// HARD RULES THIS MODULE ENFORCES
// -------------------------------
//   * No fabricated numbers. No fallback constants. If a source is unreachable
//     the truth object says so (`rosterSource`) rather than inventing a roster.
//   * No hardcoded client names anywhere. Every client is data.
//   * Unknown is a first-class value distinct from zero.
//
// FRONTMATTER CONTRACT (wiki/clients/<slug>.md)
//   revenue_amount: 1250
//   revenue_basis:  monthly | one_time | expected | unconfirmed
//   revenue_note:   free text explaining the basis / what needs confirming
//   revenue_question: an open question ONLY Jack can settle. Always surfaced in
//                   `questions`, whatever the basis — a confirmed figure can still
//                   have something outstanding about it.
// For basis `term`, two more fields are REQUIRED or the row degrades to
// `unconfirmed` (a term with no end is not a term):
//   revenue_start:  2026-08-18   (ISO date the term began)
//   revenue_months: 2            (how many monthly payments the term covers)
// Legacy `mrr: 700` is still honoured and read as basis `monthly`.
// ─────────────────────────────────────────────────────────────────────────────

import { listVaultFiles, readVaultFile } from "./vaultSource";

export type RevenueBasis =
  | "monthly"
  | "term"
  | "one_time"
  | "expected"
  | "unconfirmed"
  | "unknown";

/** Short human label for a basis. Use these verbatim in UI so wording never drifts. */
export const BASIS_LABEL: Record<RevenueBasis, string> = {
  monthly: "MRR (open-ended)",
  term: "MRR (fixed term)",
  one_time: "one-time",
  expected: "expected (not yet earned)",
  unconfirmed: "basis unconfirmed",
  unknown: "unknown",
};

/** The fixed-term shape carried by basis `term`. */
export interface RevenueTerm {
  start: string;          // ISO date the term began
  months: number;         // total monthly payments in the term
  /** ISO date the term runs out (start + months). */
  end: string;
  /** Whole months still to be billed, floored at 0. 0 = it has lapsed. */
  monthsRemaining: number;
  /** True once monthsRemaining hits 0 — this money has STOPPED. */
  expired: boolean;
  /** Total contract value = amount x months. */
  contractValue: number;
}

export interface ClientRevenue {
  slug: string;
  name: string;
  status: string;
  /** null means genuinely unknown. It never means zero. */
  amount: number | null;
  basis: RevenueBasis;
  /** Why this basis — surfaced in tooltips and in the questions list. */
  note: string | null;
  /** In the crm_clients roster (true), a vault page that is not a client (false), or roster unavailable (null). */
  isClient: boolean | null;
  /** Roster row with no vault page: we know they exist, we lack their detail. */
  needsVaultPage: boolean;
  /** Set when this client's figure needs Jack to answer something. */
  question: string | null;
  /** Present only for basis `term`. Carries the end date and months remaining. */
  term: RevenueTerm | null;
  /**
   * Paid invoices found for this client in the Sonar `invoices` table.
   * This is the only hard corroboration that money actually moved. A figure
   * written in a vault page is a CLAIM; a paid invoice is EVIDENCE.
   */
  evidence: { invoiceNo: string; amount: number; paidOn: string }[];
  /** True when at least one paid invoice backs this client's figure. */
  evidenceBacked: boolean;
}

/**
 * An open deal that is NOT earned revenue.
 *
 * Deals live in vault data, never in code, so moving one from pipeline to won —
 * or correcting its amount — is a data edit. Chris moved from "earned" to
 * "pipeline" on a single sentence from Jack; that must never require an engineer.
 */
export interface PipelineDeal {
  name: string;
  amount: number | null;
  /** e.g. "probable", "conditional" — how likely, in Jack's own framing. */
  stage: string;
  /** ISO date or a plain phrase like "no date". Never invented. */
  expectedClose: string | null;
  note: string | null;
  /** Set when we do not even know who this deal is with. */
  question: string | null;
}

export interface RevenueTruth {
  /** ISO timestamp — this was computed just now, nothing here is a snapshot. */
  asOf: string;
  /**
   * THE headline earned number: money recurring monthly right now, across
   * active roster clients only. Includes fixed-term deals while they run.
   * NEVER includes pipeline, expected, or one-time amounts.
   */
  mrr: number;
  /** The part of mrr with no end date — genuinely durable. */
  mrrDurable: number;
  /** The part of mrr that STOPS on a known date. See mrrClients[].term. */
  mrrExpiring: number;
  /** Clients contributing to mrr, so the figure is always explainable. */
  mrrClients: ClientRevenue[];
  /** Soonest term expiry across mrrClients, so it is seen coming, not discovered. */
  nextExpiry: { name: string; end: string; monthsRemaining: number; amount: number } | null;
  /** Open deals that are explicitly NOT revenue. Never summed into mrr. */
  pipelineDeals: PipelineDeal[];
  /** expected-basis clients + pipelineDeals. Display beside mrr, never added to it. */
  pipelineTotal: number;
  /** Collected once. Real, but categorically not MRR. Never add to it. */
  oneTime: ClientRevenue[];
  oneTimeTotal: number;
  /** Agreed/likely, not yet earned. Pipeline only. */
  expected: ClientRevenue[];
  expectedTotal: number;
  /** Amount known but recurrence unconfirmed — deliberately excluded from mrr. */
  unconfirmed: ClientRevenue[];
  unconfirmedTotal: number;
  /** Active clients with no figure on file at all. Rendered as unknown, not 0. */
  unknown: ClientRevenue[];
  /** Every active roster client, whatever their basis. */
  clients: ClientRevenue[];
  /** All vault pages too, including non-clients (flagged isClient:false). */
  allPages: ClientRevenue[];
  activeClients: number;
  /** How many active clients have any figure at all — makes the gap visible. */
  clientsWithFigure: number;
  /** "crm_clients" | "vault-only (roster unavailable)" */
  rosterSource: string;
  /** Open questions only Jack can settle. Never guessed around. */
  questions: string[];
  /** One-line honest description of what `mrr` means right now. */
  mrrBasisLine: string;
}

const norm = (s: string) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

function parseFrontmatter(text: string): Record<string, string> {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const out: Record<string, string> = {};
  if (!m) return out;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^(\w[\w_-]*):\s*(.+)$/);
    if (kv) out[kv[1].toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

const VALID_BASIS: RevenueBasis[] = [
  "monthly",
  "term",
  "one_time",
  "expected",
  "unconfirmed",
  "unknown",
];

/**
 * Work out where a fixed-term deal stands today.
 *
 * monthsRemaining counts whole monthly payments still to come, so a 2-month term
 * starting 2026-08-18 reads 2 on the signing day, 1 after 2026-09-18, and 0 (with
 * expired:true) from 2026-10-18. Returns null when the inputs are not a real term
 * — the caller then degrades the row to `unconfirmed` rather than inventing dates.
 */
function computeTerm(
  amount: number,
  start: string,
  months: number,
  now: Date
): RevenueTerm | null {
  const s = new Date(start);
  if (isNaN(s.getTime()) || !Number.isFinite(months) || months <= 0) return null;

  const end = new Date(s);
  end.setMonth(end.getMonth() + months);

  // Whole months elapsed since the start, by calendar month with a day-of-month
  // adjustment so a term is not counted down early.
  let elapsed =
    (now.getFullYear() - s.getFullYear()) * 12 + (now.getMonth() - s.getMonth());
  if (now.getDate() < s.getDate()) elapsed -= 1;
  const monthsRemaining = Math.max(0, months - Math.max(0, elapsed));

  return {
    start: s.toISOString().slice(0, 10),
    months,
    end: end.toISOString().slice(0, 10),
    monthsRemaining,
    expired: monthsRemaining === 0,
    contractValue: amount * months,
  };
}

/**
 * Read the curated client roster from the SONAR Supabase project.
 *
 * NOTE the project split: Sonar/CRM data (crm_clients, outbound, watch_runs)
 * lives in SONAR_SUPABASE_*, while outreach/prospect data lives in OS_SUPABASE_*.
 * Mixing them silently returns empty sets, so this only ever touches SONAR_*.
 *
 * Returns null when unconfigured/unreachable so callers degrade honestly rather
 * than inventing a roster or 500ing (same pattern as /api/sonar).
 */
async function readRoster(): Promise<{ name: string; slug: string }[] | null> {
  const url = process.env.SONAR_SUPABASE_URL;
  const key = process.env.SONAR_SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;
  try {
    const res = await fetch(
      `${url}/rest/v1/crm_clients?select=name,slug&active=is.true`,
      {
        headers: { apikey: key, Authorization: `Bearer ${key}` },
        cache: "no-store",
      }
    );
    if (!res.ok) return null;
    return (await res.json()) as { name: string; slug: string }[];
  } catch {
    return null;
  }
}

/**
 * Paid invoices, grouped by normalised client name — the hard evidence layer.
 *
 * A number typed into a markdown page is a claim about revenue. A paid invoice
 * is proof money moved. Keeping the two apart is what lets the OS say "$1,250
 * MRR, backed by invoice WD-2026-001 paid 2026-08-22" instead of just asserting
 * a figure. Returns an empty map when the table is unreachable, which downgrades
 * confidence rather than inventing evidence.
 */
async function readPaidInvoices(): Promise<
  Map<string, { invoiceNo: string; amount: number; paidOn: string }[]>
> {
  const out = new Map<string, { invoiceNo: string; amount: number; paidOn: string }[]>();
  const url = process.env.SONAR_SUPABASE_URL;
  const key = process.env.SONAR_SUPABASE_SERVICE_KEY;
  if (!url || !key) return out;
  try {
    const res = await fetch(
      `${url}/rest/v1/invoices?select=client,invoice_no,amount_cents,status,paid_on&status=eq.paid`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` }, cache: "no-store" }
    );
    if (!res.ok) return out;
    const rows = (await res.json()) as {
      client: string; invoice_no: string; amount_cents: number; paid_on: string | null;
    }[];
    for (const r of rows) {
      const k = norm(r.client ?? "");
      if (!out.has(k)) out.set(k, []);
      out.get(k)!.push({
        invoiceNo: r.invoice_no,
        amount: (Number(r.amount_cents) || 0) / 100,
        paidOn: r.paid_on ?? "",
      });
    }
  } catch { /* evidence unavailable -> unbacked, never fabricated */ }
  return out;
}

/**
 * Open deals from wiki/state/pipeline-deals.md. Data, not code — see that file.
 * Anything here is explicitly NOT revenue.
 */
async function readPipelineDeals(): Promise<PipelineDeal[]> {
  try {
    const raw = await readVaultFile("wiki/state/pipeline-deals.md");
    const block = raw?.match(/```json\s*([\s\S]*?)```/);
    if (!block) return [];
    const parsed = JSON.parse(block[1]) as Partial<PipelineDeal>[];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((d) => d && typeof d.name === "string")
      .map((d) => ({
        name: d.name as string,
        amount: typeof d.amount === "number" ? d.amount : null,
        stage: d.stage || "unspecified",
        expectedClose: d.expectedClose ?? null,
        note: d.note ?? null,
        question: d.question ?? null,
      }));
  } catch {
    return [];
  }
}

/** Parse one vault client page into a revenue row. Never invents an amount. */
function toRow(slug: string, fm: Record<string, string>): ClientRevenue {
  const pretty = slug
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");

  // Preferred explicit contract, with the legacy `mrr:` field as a fallback that
  // means exactly what it used to mean: a confirmed monthly retainer.
  let amount: number | null = null;
  let basis: RevenueBasis = "unknown";

  const explicit = fm["revenue_amount"];
  if (explicit != null && explicit !== "") {
    const n = Number(explicit.replace(/[$,]/g, ""));
    if (Number.isFinite(n)) {
      amount = n;
      const b = (fm["revenue_basis"] || "").toLowerCase() as RevenueBasis;
      // An amount with no declared basis is NOT assumed to recur.
      basis = VALID_BASIS.includes(b) ? b : "unconfirmed";
    }
  } else if (fm["mrr"] != null && fm["mrr"] !== "") {
    const n = Number(fm["mrr"].replace(/[$,]/g, ""));
    if (Number.isFinite(n) && n > 0) {
      amount = n;
      basis = "monthly";
    }
  }
  if (amount === null) basis = "unknown";

  // A fixed-term deal must actually carry its term. Without a start date and a
  // month count there is no end date to warn about, so rather than quietly
  // treating it as open-ended MRR we drop it to `unconfirmed` — held out of MRR
  // and raised as a question.
  let term: RevenueTerm | null = null;
  if (basis === "term" && amount !== null) {
    term = computeTerm(
      amount,
      fm["revenue_start"] || "",
      Number(fm["revenue_months"]),
      new Date()
    );
    if (!term) basis = "unconfirmed";
  }

  return {
    slug,
    name: fm["client_name"] || pretty,
    status: (fm["status"] || "active").toLowerCase(),
    amount,
    basis,
    note: fm["revenue_note"] || null,
    isClient: null,
    needsVaultPage: false,
    question: fm["revenue_question"] || null,
    term,
    evidence: [],
    evidenceBacked: false,
  };
}

/**
 * THE resolver. Call this instead of computing revenue anywhere else.
 *
 * Membership: crm_clients roster (Supabase, SONAR project).
 * Money:      per-client vault frontmatter, bucketed by declared basis.
 */
export async function getRevenueTruth(): Promise<RevenueTruth> {
  const asOf = new Date().toISOString();

  // ── Vault pages (detail) ──────────────────────────────────────────────────
  let files: string[] = [];
  try {
    files = (await listVaultFiles()).filter(
      (rel) =>
        rel.startsWith("wiki/clients/") &&
        rel.endsWith(".md") &&
        !rel.slice("wiki/clients/".length).includes("/") &&
        !rel.split("/").pop()!.startsWith("_") // _TEMPLATE, _sonar-index
    );
  } catch {
    files = [];
  }

  const allPages: ClientRevenue[] = [];
  for (const rel of files) {
    const slug = rel.split("/").pop()!.replace(/\.md$/, "");
    const text = (await readVaultFile(rel)) ?? "";
    allPages.push(toRow(slug, parseFrontmatter(text)));
  }

  // ── Roster (membership) ───────────────────────────────────────────────────
  const rosterRows = await readRoster();
  const rosterKnown = !!rosterRows && rosterRows.length > 0;
  const rosterKeys = new Set<string>();
  if (rosterRows) {
    for (const r of rosterRows) {
      rosterKeys.add(norm(r.name));
      rosterKeys.add(norm(r.slug));
    }
  }

  for (const p of allPages) {
    // Without a roster we cannot claim to know either way -> null, not false.
    p.isClient = rosterKnown
      ? rosterKeys.has(norm(p.name)) || rosterKeys.has(norm(p.slug))
      : null;
  }

  // A roster client with no vault page used to be invisible: the old code only
  // iterated markdown files. Surface them as stubs with unknown revenue.
  if (rosterKnown && rosterRows) {
    const seen = new Set<string>();
    for (const p of allPages) {
      seen.add(norm(p.name));
      seen.add(norm(p.slug));
    }
    for (const r of rosterRows) {
      if (seen.has(norm(r.name)) || seen.has(norm(r.slug))) continue;
      allPages.push({
        slug: r.slug,
        name: r.name,
        status: "active",
        amount: null,
        basis: "unknown",
        note: null,
        isClient: true,
        needsVaultPage: true,
        question: null,
        term: null,
        evidence: [],
        evidenceBacked: false,
      });
    }
  }

  // ── Active clients = roster members, not "every markdown file" ────────────
  const clients = allPages.filter(
    (p) => p.status === "active" && p.isClient !== false
  );

  // ── Attach hard evidence, and let it override an unbacked claim ───────────
  const invoices = await readPaidInvoices();
  const evidenceKnown = invoices.size > 0;
  for (const c of allPages) {
    c.evidence = invoices.get(norm(c.name)) ?? invoices.get(norm(c.slug)) ?? [];
    c.evidenceBacked = c.evidence.length > 0;
  }
  for (const c of clients) {
    // A recurring retainer nobody has ever invoiced is a claim, not revenue.
    // Rather than trust it into MRR, drop it to `unconfirmed` and ask. This is
    // what stops a stale vault field from quietly inflating the headline number.
    if (
      evidenceKnown &&
      !c.evidenceBacked &&
      (c.basis === "monthly" || c.basis === "term")
    ) {
      c.basis = "unconfirmed";
      c.term = null;
      c.question ||=
        `${c.name} is recorded at $${c.amount?.toLocaleString()} recurring, but there is no paid invoice ` +
        `for them anywhere in the invoices table — so nothing corroborates that this money has ever ` +
        `actually arrived. Is this retainer real and active? It is held OUT of MRR until it is invoiced or you confirm it.`;
    }
  }

  const has = (b: RevenueBasis) =>
    clients.filter((c) => c.basis === b && typeof c.amount === "number");

  const openEnded = has("monthly");
  const termed = has("term");
  const mrrClients = [...openEnded, ...termed];
  const oneTime = has("one_time");
  const expected = has("expected");
  const unconfirmed = has("unconfirmed");
  const unknown = clients.filter((c) => c.amount === null);

  const sum = (rows: ClientRevenue[]) =>
    rows.reduce((s, c) => s + (c.amount ?? 0), 0);

  // MRR = money genuinely recurring this month. Fixed-term deals count while
  // they run — they really are arriving monthly — but they are also reported
  // as `mrrExpiring` with an end date so nothing reads as durable by default.
  const mrr = sum(mrrClients);
  const mrrDurable = sum(openEnded);
  const mrrExpiring = sum(termed);

  const pipelineDeals = await readPipelineDeals();
  // Expected-basis clients are pipeline too; present them in one place so no
  // screen has to assemble "what is not yet earned" for itself.
  const pipelineTotal =
    sum(expected) + pipelineDeals.reduce((s, d) => s + (d.amount ?? 0), 0);

  // ── Questions: things no code may decide on Jack's behalf ─────────────────
  const questions: string[] = [];
  // Explicit per-client questions surface whatever the basis: a confirmed
  // figure can still have something outstanding attached to it.
  for (const c of clients) {
    if (c.question) questions.push(c.question);
  }
  for (const c of unconfirmed) {
    if (c.question) continue; // an explicit revenue_question already covered it
    const q =
      c.note ||
      `Is ${c.name}'s $${c.amount?.toLocaleString()} a recurring monthly retainer or a one-time payment? ` +
        `Until you confirm, it is held OUT of MRR rather than assumed to recur.`;
    c.question = q;
    questions.push(q);
  }
  for (const c of unknown) {
    if (c.question) continue;
    const q = `What is Wing Digital actually billing ${c.name}? No figure is on file, so their revenue renders as unknown (never $0).`;
    c.question = q;
    questions.push(q);
  }
  if (!rosterKnown) {
    questions.push(
      "The crm_clients roster (SONAR Supabase) is unreachable, so client membership could not be verified. Counts below are vault pages, not a confirmed roster."
    );
  }

  // Soonest expiry first, so the tile can warn before the money stops.
  const expiries = termed
    .filter((c) => c.term)
    .map((c) => ({
      name: c.name,
      end: c.term!.end,
      monthsRemaining: c.term!.monthsRemaining,
      amount: c.amount ?? 0,
    }))
    .sort((a, b) => a.end.localeCompare(b.end));
  const nextExpiry = expiries[0] ?? null;

  if (nextExpiry) {
    questions.push(
      `${nextExpiry.name}'s $${nextExpiry.amount.toLocaleString()}/mo runs out on ${nextExpiry.end} ` +
        `(${nextExpiry.monthsRemaining} month${nextExpiry.monthsRemaining === 1 ? "" : "s"} left). ` +
        `Are you renewing it? If not, MRR drops by that amount on that date.`
    );
  }
  for (const d of pipelineDeals) {
    if (d.question) questions.push(d.question);
  }

  const mrrBasisLine = mrrClients.length
    ? `$${mrr.toLocaleString()}/mo recurring right now, from ${mrrClients
        .map(
          (c) =>
            `${c.name} ($${c.amount?.toLocaleString()}${
              c.term ? `, fixed term ending ${c.term.end}, ${c.term.monthsRemaining} mo left` : ", open-ended"
            }${c.evidenceBacked ? `, invoice ${c.evidence[0].invoiceNo} paid ${c.evidence[0].paidOn}` : ""})`
        )
        .join("; ")}. Excludes $${pipelineTotal.toLocaleString()} of pipeline (expected/probable, not earned)` +
      `${unconfirmed.length ? ` and ${unconfirmed.length} figure(s) with an unconfirmed basis` : ""}.`
    : "No recurring retainer is corroborated, so MRR is $0 — that is a real zero, not missing data.";

  return {
    asOf,
    mrr,
    mrrDurable,
    mrrExpiring,
    mrrClients,
    nextExpiry,
    pipelineDeals,
    pipelineTotal,
    oneTime,
    oneTimeTotal: sum(oneTime),
    expected,
    expectedTotal: sum(expected),
    unconfirmed,
    unconfirmedTotal: sum(unconfirmed),
    unknown,
    clients,
    allPages,
    activeClients: clients.length,
    clientsWithFigure: clients.filter((c) => c.amount !== null).length,
    rosterSource: rosterKnown ? "crm_clients" : "vault-only (roster unavailable)",
    questions,
    mrrBasisLine,
  };
}
