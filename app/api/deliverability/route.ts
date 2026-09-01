import { NextResponse } from "next/server";
import { resolveTxt } from "node:dns/promises";
import { requireStaff, isAuthFailure } from "../pipeline/_lib";

// ───────────────────────────────────────────────────────────────────────────
// Deliverability API — email-sending health, surfaced for a non-coder.
//
// Four sections, each independently sourced and each honest about absence:
//
//   dns          Live SPF / DKIM / DMARC TXT lookups for the sending
//                domain(s). Domains come from DELIVERABILITY_DOMAINS (comma
//                separated). The Sonar project was probed for domain/warmup
//                tables (outreach_state, smtp_state, smtp_mailboxes,
//                sending_domains) and NONE exist — the SMTP warmup state lives
//                in a local JSON file on Jack's PC (ghl-cli/outreach_logs/
//                smtp_state.json), which a Vercel deployment cannot read. So
//                with no env var set, this section reports "no sending domain
//                configured yet", which is the true state: the owned SMTP pipe
//                is blocked on Jack buying a domain.
//
//   warmup       Today's sends vs cap and warmup day. The store behind this is
//                local-only (see above), so this section reports itself
//                unconfigured with an explanation, never invented numbers.
//
//   suppression  The do-not-contact list, from the Sonar Supabase project's
//                `suppression` table (email, reason, source, added_at) —
//                confirmed present by a live read-only probe.
//
//   outcomes     Last-7-day send outcomes from the Sonar `outbound` table.
//                Migration 0007 records attempts as COLUMNS on outbound
//                (sent_at, last_send_error, last_send_attempt_at), not a
//                separate outbound_send_attempts table — that table name was
//                probed and does not exist. Bounce data as such is not
//                recorded anywhere; failures are send errors, and the payload
//                says so instead of relabelling them "bounces".
//
// Statuses are the traffic light Jack asked for: "green" | "yellow" | "red",
// plus "gray" for a section whose source is not configured. Every non-green
// item carries `meaning` (what it is) and `action` (what to do), and a `link`
// to the broken thing when one exists.
// ───────────────────────────────────────────────────────────────────────────

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export type Light = "green" | "yellow" | "red" | "gray";

export type Check = {
  name: string;
  status: Light;
  summary: string;      // plain-English one-liner
  meaning: string | null;   // what a non-green state means
  action: string | null;    // what to do about it
  link: string | null;      // one click to the thing that's broken
  detail: string | null;    // raw record / technical detail, expandable
};

export type Section = {
  id: "dns" | "warmup" | "suppression" | "outcomes";
  label: string;
  configured: boolean;
  status: Light;
  summary: string;
  missing: string | null;   // which credential/env var is absent, when one is
  error: string | null;
  checks: Check[];
  // Section-specific extras (typed loosely; the component narrows them).
  extra?: unknown;
};

// ── Sonar credentials, same local pattern as app/api/sonar/route.ts ─────────
function creds() {
  return {
    url: process.env.SONAR_SUPABASE_URL,
    key: process.env.SONAR_SUPABASE_SERVICE_KEY,
  };
}

async function sonarFetch(path: string, extraHeaders: Record<string, string> = {}) {
  const { url, key } = creds();
  return fetch(`${url}/rest/v1/${path}`, {
    headers: {
      apikey: key as string,
      Authorization: `Bearer ${key}`,
      ...extraHeaders,
    },
    cache: "no-store",
  });
}

async function sonarCount(filter: string): Promise<number | null> {
  const res = await sonarFetch(`${filter}&select=id`, {
    Prefer: "count=exact",
    Range: "0-0",
  });
  if (!res.ok) return null;
  const total = Number((res.headers.get("content-range") || "").split("/").pop());
  return Number.isFinite(total) ? total : null;
}

// ── DNS section ─────────────────────────────────────────────────────────────

// Same selector list deliverability.py probes, so the two gates agree.
const DKIM_SELECTORS = [
  "ltx", "k1", "k2", "k3", "mail", "smtp", "default", "google",
  "selector1", "selector2", "dkim", "s1", "s2", "mandrill", "mg",
];

// One lookup gets at most this long before we stop waiting on it.
const PER_LOOKUP_TIMEOUT_MS = 3000;
// All DNS work for one request shares this budget, so one blackholed domain
// cannot stall the whole board into a gateway timeout.
const TOTAL_DNS_BUDGET_MS = 10000;

type TxtResult = {
  records: string[];
  // true when the answer is "we could not ask", not "the record is absent":
  // a lookup timeout, SERVFAIL, network trouble, or the request-wide budget
  // running out. Only ENOTFOUND/ENODATA count as a confirmed-absent record.
  unreachable: boolean;
};

async function txt(name: string, deadline: number): Promise<TxtResult> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return { records: [], unreachable: true };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const recs = await Promise.race([
      resolveTxt(name),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(Object.assign(new Error("DNS lookup timed out"), { code: "ETIMEOUT" })),
          Math.min(PER_LOOKUP_TIMEOUT_MS, remaining)
        );
      }),
    ]);
    return { records: recs.map((chunks) => chunks.join("")), unreachable: false };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException | null)?.code;
    // ENOTFOUND / ENODATA: the DNS system answered and said "no such record".
    // Anything else (timeout, SERVFAIL, refused, network down) means we simply
    // could not check, and must not be reported as a missing record.
    if (code === "ENOTFOUND" || code === "ENODATA") {
      return { records: [], unreachable: false };
    }
    return { records: [], unreachable: true };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function unreachableCheck(name: string, domain: string): Check {
  return {
    name,
    status: "gray",
    summary: "Could not check DNS right now, try again in a few minutes.",
    meaning:
      `The DNS lookup for ${domain} did not answer in time or errored. That says nothing about whether the record exists, so this is not marked as failing.`,
    action: "Hit Re-check in a few minutes. If this stays gray for hours, the DNS resolver on the deployment may be having trouble.",
    link: null,
    detail: "Lookup timed out or the resolver returned a server error. Not counted as a missing record.",
  };
}

async function checkDomain(domain: string, deadline: number): Promise<Check[]> {
  const dnsLink = `https://dnschecker.org/all-dns-records-of-domain.php?query=${encodeURIComponent(domain)}`;

  const [rootTxt, dmarcTxt, dkimResults] = await Promise.all([
    txt(domain, deadline),
    txt(`_dmarc.${domain}`, deadline),
    Promise.all(
      DKIM_SELECTORS.map(async (sel) => {
        const res = await txt(`${sel}._domainkey.${domain}`, deadline);
        const hit = res.records.find((r) => /v=dkim1|p=/i.test(r));
        return { sel, hit: hit ?? null, unreachable: res.unreachable };
      })
    ),
  ]);

  const spf = rootTxt.records.find((r) => r.toLowerCase().startsWith("v=spf1")) ?? null;
  const dmarc = dmarcTxt.records.find((r) => r.toLowerCase().startsWith("v=dmarc1")) ?? null;
  const dkim = dkimResults.find((r) => r.hit) as { sel: string; hit: string } | undefined;
  // If no selector answered with a key AND at least one lookup could not be
  // completed, the honest answer is "unknown", not "missing".
  const dkimUnreachable = !dkim && dkimResults.some((r) => r.unreachable);

  const checks: Check[] = [];

  checks.push(
    !spf && rootTxt.unreachable
      ? unreachableCheck(`SPF for ${domain}`, domain)
      : spf
      ? {
          name: `SPF for ${domain}`,
          status: "green",
          summary: `${domain}'s SPF record is set up. Inboxes can verify which servers are allowed to send as this domain.`,
          meaning: null, action: null, link: null,
          detail: spf,
        }
      : {
          name: `SPF for ${domain}`,
          status: "red",
          summary: `${domain} has no SPF record, so inboxes cannot verify your mail and are likely to junk or reject it.`,
          meaning:
            "SPF is a public DNS note that lists which servers may send email as this domain. Without it, receiving inboxes treat your mail as unverified.",
          action:
            `Add a TXT record on ${domain} starting with "v=spf1" that includes your email provider, at your domain registrar's DNS panel. Do not send cold email until this is green.`,
          link: dnsLink,
          detail: rootTxt.records.length ? `TXT records found: ${rootTxt.records.join(" | ")}` : "No TXT records found at the domain root.",
        }
  );

  checks.push(
    dkimUnreachable
      ? unreachableCheck(`DKIM for ${domain}`, domain)
      : dkim
      ? {
          name: `DKIM for ${domain}`,
          status: "green",
          summary: `${domain} has a DKIM signature key published (selector "${dkim.sel}"), so inboxes can confirm your mail was not tampered with.`,
          meaning: null, action: null, link: null,
          detail: dkim.hit.length > 200 ? `${dkim.hit.slice(0, 200)}...` : dkim.hit,
        }
      : {
          name: `DKIM for ${domain}`,
          status: "red",
          summary: `No DKIM key was found for ${domain}, so your mail arrives unsigned and inboxes trust it less.`,
          meaning:
            "DKIM is a cryptographic signature on every email that proves it really came from your domain. Without a published key, mail providers score you down.",
          action:
            `Your email provider (Google Workspace, etc.) generates the DKIM record; publish it as a TXT record under _domainkey.${domain}. Common selector names were probed (${DKIM_SELECTORS.slice(0, 5).join(", ")}, ...) and none answered.`,
          link: dnsLink,
          detail: `Probed selectors: ${DKIM_SELECTORS.join(", ")}`,
        }
  );

  if (dmarc) {
    const policy = /p=none/i.test(dmarc)
      ? "none"
      : /p=quarantine/i.test(dmarc)
      ? "quarantine"
      : /p=reject/i.test(dmarc)
      ? "reject"
      : "unknown";
    checks.push(
      policy === "none"
        ? {
            name: `DMARC for ${domain}`,
            status: "yellow",
            summary: `${domain} has a DMARC record, but its policy is "none", which only monitors and does not protect the domain.`,
            meaning:
              "DMARC tells inboxes what to do with mail that fails SPF/DKIM. Policy \"none\" means \"do nothing\", so spoofers can still send as you. It passes the basic check, which is why this is yellow, not red.",
            action:
              `Once SPF and DKIM have been green for a couple of weeks, tighten the _dmarc.${domain} TXT record from p=none to p=quarantine.`,
            link: dnsLink,
            detail: dmarc,
          }
        : {
            name: `DMARC for ${domain}`,
            status: "green",
            summary: `${domain}'s DMARC record is set up with an enforcing policy ("${policy}").`,
            meaning: null, action: null, link: null,
            detail: dmarc,
          }
    );
  } else if (dmarcTxt.unreachable) {
    checks.push(unreachableCheck(`DMARC for ${domain}`, domain));
  } else {
    checks.push({
      name: `DMARC for ${domain}`,
      status: "red",
      summary: `${domain} has no DMARC record. Gmail and Yahoo now require one from bulk senders.`,
      meaning:
        "DMARC is the DNS record that tells inboxes what to do when a message fails the other two checks, and where to report abuse. Bulk mail without it is increasingly rejected outright.",
      action:
        `Add a TXT record at _dmarc.${domain} with the value "v=DMARC1; p=none; rua=mailto:you@${domain}" to start, then tighten the policy later.`,
      link: dnsLink,
      detail: "No _dmarc TXT record found.",
    });
  }

  return checks;
}

function worst(checks: Check[]): Light {
  if (checks.some((c) => c.status === "red")) return "red";
  if (checks.some((c) => c.status === "yellow")) return "yellow";
  if (checks.every((c) => c.status === "gray")) return "gray";
  return "green";
}

async function dnsSection(): Promise<Section> {
  // The only cloud-readable source of sending domains is this env var. The
  // Sonar project holds NO domain/warmup tables (probed 2026-09-01:
  // outreach_state, smtp_state, smtp_mailboxes, sending_domains all absent),
  // and the local smtp store on Jack's PC is unreachable from Vercel.
  const raw = process.env.DELIVERABILITY_DOMAINS || "";
  const rawEntries = raw
    .split(",")
    .map((d) => d.trim())
    .filter(Boolean);
  const domainOk = (d: string) => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d);
  const domains = rawEntries.map((d) => d.toLowerCase()).filter(domainOk);
  const rejected = rawEntries.filter((d) => !domainOk(d.toLowerCase()));

  if (!rawEntries.length) {
    // The env var is genuinely unset (or empty): nothing was configured.
    return {
      id: "dns",
      label: "Domain setup (SPF / DKIM / DMARC)",
      configured: false,
      status: "gray",
      summary:
        "No sending domain configured yet, so there is nothing to check. This is expected: the owned email pipe is waiting on a domain purchase.",
      missing: "DELIVERABILITY_DOMAINS",
      error: null,
      checks: [],
    };
  }

  // Show a rejected entry exactly as written, with the characters that made it
  // invalid called out. The env var holds only domain names, never a secret.
  const rejectedChecks: Check[] = rejected.map((entry) => {
    const badChars = [...new Set(entry.toLowerCase().replace(/[a-z0-9.-]/g, ""))];
    return {
      name: `Rejected entry: "${entry}"`,
      status: "yellow",
      summary: badChars.length
        ? `"${entry}" is not a valid domain name. Invalid character${badChars.length === 1 ? "" : "s"}: ${badChars.map((c) => `"${c}"`).join(" ")}.`
        : `"${entry}" is not a valid domain name. It should look like "example.com" with a dot and an ending like .com.`,
      meaning:
        "This entry in DELIVERABILITY_DOMAINS could not be read as a domain, so it is not being checked. A typo here silently turns off DNS monitoring for that domain.",
      action:
        "Fix the entry in the DELIVERABILITY_DOMAINS environment variable on the deployment. Use bare domains separated by commas, like \"example.com,other.com\", with no http:// and no spaces inside a name.",
      link: null,
      detail: `Raw entry as configured: ${JSON.stringify(entry)}`,
    };
  });

  if (!domains.length) {
    // The env var IS set, but nothing in it parses. Saying "no domain
    // configured yet" here would hide a real misconfiguration.
    return {
      id: "dns",
      label: "Domain setup (SPF / DKIM / DMARC)",
      configured: true,
      status: "yellow",
      summary:
        "DELIVERABILITY_DOMAINS is set but no valid domain could be read from it. Check for typos.",
      missing: null,
      error: null,
      checks: rejectedChecks,
    };
  }

  try {
    const deadline = Date.now() + TOTAL_DNS_BUDGET_MS;
    const perDomain = await Promise.all(domains.map((d) => checkDomain(d, deadline)));
    const checks = [...perDomain.flat(), ...rejectedChecks];
    const status = worst(checks);
    const reds = checks.filter((c) => c.status === "red").length;
    const unchecked = checks.filter((c) => c.status === "gray").length;
    const truncatedNote =
      unchecked > 0
        ? ` ${unchecked} check${unchecked === 1 ? "" : "s"} could not be completed right now (DNS was slow or unreachable) and ${unchecked === 1 ? "is" : "are"} shown gray, not failed.`
        : "";
    return {
      id: "dns",
      label: "Domain setup (SPF / DKIM / DMARC)",
      configured: true,
      status,
      summary:
        (status === "gray"
          ? "Could not check DNS right now, try again in a few minutes. No record is being reported as missing."
          : status === "green"
          ? `All ${checks.length} DNS checks pass across ${domains.length === 1 ? domains[0] : `${domains.length} domains`}. Inboxes can verify your mail.`
          : status === "yellow"
          ? "The basics are in place, but at least one item below should be looked at."
          : `${reds} DNS check${reds === 1 ? "" : "s"} failing. Fix these before sending any cold email, or it will land in spam.`) + truncatedNote,
      missing: null,
      error: null,
      checks,
      extra: { domains },
    };
  } catch (e) {
    return {
      id: "dns",
      label: "Domain setup (SPF / DKIM / DMARC)",
      configured: true,
      status: "yellow",
      summary: "The DNS lookup itself failed, so record health is unknown right now. This says nothing about whether the records exist.",
      missing: null,
      error: String(e),
      checks: [],
    };
  }
}

// ── Warmup section ──────────────────────────────────────────────────────────
function warmupSection(): Section {
  // The warmup/cap state (today's sends per mailbox, warmup day per domain)
  // is written by ghl-cli/smtp_sender.py to a LOCAL file on Jack's PC:
  // ghl-cli/outreach_logs/smtp_state.json. It is not mirrored to any Supabase
  // project (probed and confirmed absent), so a cloud deployment cannot read
  // it, and inventing numbers here would be worse than saying so.
  return {
    id: "warmup",
    label: "Warmup and daily caps",
    configured: false,
    status: "gray",
    summary:
      "Warmup tracking lives in a local file on Jack's PC and has not started yet. The owned sending pipe is built and tested but waiting on a domain purchase, so there are no sends to cap.",
    missing: null,
    error: null,
    checks: [
      {
        name: "Warmup state",
        status: "gray",
        summary: "No mailbox has sent its first email yet, so no warmup ramp is running.",
        meaning:
          "When sending starts, new domains ramp from about 10 emails a day to full volume over roughly 3 weeks. Today's sends vs the daily cap will appear here, read from the sender's own records.",
        action:
          "Nothing to do here until the sending domain is bought and the first send happens. Once it does, this panel needs the warmup state mirrored to Supabase (or the board run on the PC) to go live.",
        link: null,
        detail:
          "Source of truth: ghl-cli/outreach_logs/smtp_state.json (local, written by smtp_sender.py). Warmup ramp: day 0-2 = 10/day, 3-6 = 15/day, 7-13 = 25/day, 14-20 = 35/day, 21+ = steady state per mailbox.",
      },
    ],
  };
}

// ── Suppression section ─────────────────────────────────────────────────────
type SuppressionRow = {
  email: string;
  reason: string | null;
  source: string | null;
  added_at: string | null;
};

async function suppressionSection(): Promise<Section> {
  const { url, key } = creds();
  const base: Omit<Section, "status" | "summary" | "checks"> = {
    id: "suppression",
    label: "Do-not-contact list",
    configured: Boolean(url && key),
    missing: url && key ? null : "SONAR_SUPABASE_URL / SONAR_SUPABASE_SERVICE_KEY",
    error: null,
  };
  if (!url || !key) {
    return {
      ...base,
      status: "gray",
      summary: "The database holding the do-not-contact list is not connected on this deployment.",
      checks: [],
    };
  }
  try {
    const res = await sonarFetch(
      "suppression?select=email,reason,source,added_at&order=added_at.desc&limit=10",
      { Prefer: "count=exact", Range: "0-9" }
    );
    if (!res.ok) {
      return {
        ...base,
        status: "yellow",
        summary: `The do-not-contact list could not be read (HTTP ${res.status}). Sending must treat an unreadable list as a reason to stop, and so does this board.`,
        error: `Supabase ${res.status}`,
        checks: [],
      };
    }
    const rows = (await res.json()) as SuppressionRow[];
    const parsed = Number((res.headers.get("content-range") || "").split("/").pop());
    const total = Number.isFinite(parsed) ? parsed : rows.length;

    // Known suppression reason codes, translated to plain English. Anything
    // not listed falls through to a generic line that still makes clear the
    // address IS excluded from sending.
    const REASON_TRANSLATIONS: Record<string, string> = {
      "role-junk-localpart":
        "Generic mailbox like info@ or sales@, skipped because those rarely reach a person",
    };
    const checks: Check[] = rows.map((r) => {
      const reason = (r.reason || "").toLowerCase();
      const known = REASON_TRANSLATIONS[reason.trim()];
      const label = reason.includes("unsub")
        ? "asked to be left alone (unsubscribe)"
        : reason.includes("bounce")
        ? "address bounced (undeliverable)"
        : known
        ? known
        : r.reason
        ? null // unknown code: use the generic wording below instead
        : "reason not recorded";
      return {
        name: r.email,
        status: "green", // a populated suppression list working as intended is healthy
        summary: label
          ? `Suppressed: ${label}.`
          : `Excluded from sending. Reason code: ${r.reason}.`,
        meaning: null,
        action: null,
        link: null,
        detail: `Source: ${r.source || "not recorded"} · Added: ${r.added_at ? r.added_at.slice(0, 10) : "date not recorded"}`,
      };
    });

    return {
      ...base,
      status: "green",
      summary:
        total === 0
          ? "The do-not-contact list is connected and empty. No one has unsubscribed or bounced yet. That is a real zero: the list was read successfully."
          : `${total} address${total === 1 ? " is" : "es are"} on the do-not-contact list and will never be emailed again. The 10 most recent are below.`,
      checks,
      extra: { total },
    };
  } catch (e) {
    return {
      ...base,
      status: "yellow",
      summary: "The do-not-contact list is unreachable right now, so its state is unknown. Sending treats that as a stop condition.",
      error: String(e),
      checks: [],
    };
  }
}

// ── Send outcomes section ───────────────────────────────────────────────────
async function outcomesSection(): Promise<Section> {
  const { url, key } = creds();
  const base: Omit<Section, "status" | "summary" | "checks"> = {
    id: "outcomes",
    label: "Last 7 days of sending",
    configured: Boolean(url && key),
    missing: url && key ? null : "SONAR_SUPABASE_URL / SONAR_SUPABASE_SERVICE_KEY",
    error: null,
  };
  if (!url || !key) {
    return {
      ...base,
      status: "gray",
      summary: "The database holding send records is not connected on this deployment.",
      checks: [],
    };
  }
  try {
    const since = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
    // Attempts live as columns on `outbound` (migration 0007), not in a
    // separate table. sent_at = delivered to the SMTP server; last_send_error
    // = the most recent attempt failed. True bounce tracking does not exist
    // yet, and this section says so rather than dressing errors up as bounces.
    const [sent, failed, ready] = await Promise.all([
      sonarCount(`outbound?sent_at=gte.${encodeURIComponent(since)}`),
      sonarCount(
        `outbound?last_send_error=not.is.null&last_send_attempt_at=gte.${encodeURIComponent(since)}&sent_at=is.null`
      ),
      sonarCount("outbound_sendable?id=gt.0"),
    ]);

    if (sent == null && failed == null) {
      return {
        ...base,
        status: "yellow",
        summary: "Send records could not be counted right now, so the week's numbers are unknown rather than zero.",
        error: "Count queries returned no total.",
        checks: [],
      };
    }

    const s = sent ?? 0;
    const f = failed ?? 0;
    const checks: Check[] = [];

    checks.push({
      name: "Emails sent",
      status: s > 0 ? "green" : "gray",
      summary:
        s > 0
          ? `${s} email${s === 1 ? "" : "s"} handed to the mail server in the last 7 days.`
          : "No emails were sent in the last 7 days. The cloud sending lane has been paused by Jack since 08-16, so a quiet week is the expected state, not a failure.",
      meaning: null,
      action: null,
      link: null,
      detail: `Counted from outbound.sent_at since ${since.slice(0, 10)}.`,
    });

    checks.push({
      name: "Failed send attempts",
      status: f === 0 ? "green" : f <= 2 ? "yellow" : "red",
      summary:
        f === 0
          ? "No send attempts failed in the last 7 days."
          : `${f} send attempt${f === 1 ? "" : "s"} failed in the last 7 days and the message${f === 1 ? " is" : "s are"} still unsent.`,
      meaning:
        f === 0
          ? null
          : "A failed attempt means the mail server rejected or errored on the send. Repeated failures can mean a credential, connection, or reputation problem.",
      action: f === 0 ? null : "Open the messaging queue and read the recorded error on each stuck row.",
      link: f === 0 ? null : "#crm",
      detail: `Counted from outbound rows with last_send_error set, attempted since ${since.slice(0, 10)}, still unsent. Note: true bounce tracking (mail accepted then returned) is not recorded anywhere yet; these are send-time failures only.`,
    });

    if (ready != null) {
      checks.push({
        name: "Approved and waiting to send",
        status: "gray",
        summary:
          ready === 0
            ? "Nothing is currently approved and waiting in the send queue."
            : `${ready} approved message${ready === 1 ? " is" : "s are"} cleared by every safety check and waiting for the sending lane to run.`,
        meaning: null,
        action: null,
        link: "#crm",
        detail: "Counted from the outbound_sendable view, which already excludes suppressed addresses, unapproved rows, and clients without send permission.",
      });
    }

    const status = worst(checks.filter((c) => c.status !== "gray")) === "green" && s === 0 && f === 0
      ? "gray"
      : worst(checks);

    return {
      ...base,
      status,
      summary:
        f > 2
          ? `${f} sends failed this week. Something in the sending pipe needs attention.`
          : s === 0 && f === 0
          ? "A quiet week: nothing sent, nothing failed. Sending is paused, so this is the expected state."
          : `${s} sent, ${f} failed in the last 7 days.`,
      checks,
      extra: { sent: s, failed: f, ready },
    };
  } catch (e) {
    return {
      ...base,
      status: "yellow",
      summary: "Send records are unreachable right now, so this week's numbers are unknown rather than zero.",
      error: String(e),
      checks: [],
    };
  }
}

// ── Handler ─────────────────────────────────────────────────────────────────
export async function GET() {
  const auth = await requireStaff();
  if (isAuthFailure(auth)) return auth;

  const [dns, suppression, outcomes] = await Promise.all([
    dnsSection(),
    suppressionSection(),
    outcomesSection(),
  ]);
  const warmup = warmupSection();

  const sections = [dns, warmup, suppression, outcomes];
  const overall = worst(
    sections.filter((s) => s.status !== "gray").map((s) => ({ status: s.status } as Check))
  );

  return NextResponse.json({
    sections,
    overall: sections.every((s) => s.status === "gray") ? "gray" : overall,
    fetchedAt: new Date().toISOString(),
  });
}
