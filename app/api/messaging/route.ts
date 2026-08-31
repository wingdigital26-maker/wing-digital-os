import { NextResponse } from "next/server";
import { sbUrl, sbService } from "@/lib/osSupabase";

// ───────────────────────────────────────────────────────────────────────────
// GET /api/messaging — the automated-sending QA board.
//
// The CRM tab shows drafts written FOR clients (Sonar `outbound`). This route
// covers the other lane Jack asked to see: the people Wing's own AUTOMATED
// cold-email engine is going to contact next. It reads the same Supabase the
// cloud sender reads (prospects + outreach_state) and re-renders, in
// TypeScript, exactly the message each queued recipient would receive, so
// every word can be checked BEFORE the machine sends it.
//
// HONESTY RULES:
//  * This route sends NOTHING and writes NOTHING. Read-only, always.
//  * The template text below is a faithful port of the B2B templates in
//    wing-outreach-cloud/daily_outreach.py (the file the sender actually
//    runs). If that file changes, this preview drifts — the payload carries
//    that caveat on every rendered message rather than hiding it.
//  * NULL/unreadable is reported as unknown, never as zero.
//  * There is NO automated SMS lane today (GHL is retired and nothing
//    replaced its texting). The payload says so explicitly so an empty texts
//    panel reads as "does not exist", not "quiet".
// ───────────────────────────────────────────────────────────────────────────

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const WIRED = ["roofing", "plumbing", "pest-control", "b2b"] as const;
const SEND_STATUSES = ["new", "enriching"] as const;
const CLIENT = "wing";
const DAILY_CAP = 100;
const QUEUE_PREVIEW = 25;

// ── Templates, ported verbatim from daily_outreach.py ──────────────────────

const ROOFING_D1 =
  "Hi {first},\n\n" +
  "I am Jack with Wing Digital. We work with roofing companies in DFW to set up " +
  "automated systems that keep leads warm, stay in front of past customers, and build " +
  "the kind of online presence that brings work in on its own.\n\n" +
  "Most roofing companies we talk to are doing solid work but losing jobs to competitors " +
  "who are just more visible. More reviews showing up, faster response times, staying in " +
  "front of homeowners after the job is done. That gap is what we close.\n\n" +
  "For {company}, that could mean a steady stream of reviews coming in automatically, " +
  "leads hearing back within minutes, and your name showing up when homeowners in your " +
  "area search. It all runs on its own once it is set up.\n\n" +
  "Would you be open to a quick 10 to 15 minute call this week? Whatever day works for " +
  "you works for me, just reply and I will make it happen.\n\nSincerely,\nJack Wing";

const ROOFING_D3 =
  "Hi {first},\n\n" +
  "Following up on my note from earlier this week. I took a look at what roofing " +
  "companies in your area are competing against right now, and a couple of things come " +
  "up consistently.\n\n" +
  "The companies pulling the most work are not necessarily the best roofers. They are " +
  "the ones with the most reviews coming in steadily, the fastest response to new leads, " +
  "and a name that stays in front of past customers. Those three things compound over " +
  "time and create a gap that is hard to close without a system behind it.\n\n" +
  "For {company}, getting those three things running automatically is exactly what we " +
  "build. Would you be open to a quick call to walk through what that looks like? Name " +
  "any day and time and I will work around your schedule.\n\nSincerely,\nJack Wing";

const ROOFING_D7 =
  "Hi {first},\n\n" +
  "I have reached out a couple of times now so I will keep this short.\n\n" +
  "The roofing companies winning in DFW right now have one thing most others do not: " +
  "their reputation and follow-up runs automatically. New reviews come in after every " +
  "job. Past customers hear from them regularly. New leads get a response within minutes. " +
  "It compounds, and it is hard to compete against once it is running.\n\n" +
  "If you want to see what that looks like built out for {company}, reply with any day " +
  "and time that works and I will be there. If not, no worries at all and I wish you a " +
  "great rest of the season.\n\nSincerely,\nJack Wing";

const PLUMBING_D1 =
  "Hi {first},\n\n" +
  "I am Jack with Wing Digital. We set up automated systems for local service businesses " +
  "in DFW that answer for you when you cannot, follow up with leads fast, and keep past " +
  "customers coming back.\n\n" +
  "For a plumbing company, the expensive problem is simple. A homeowner with a burst pipe " +
  "or a dead water heater at 2am calls three numbers and hires whoever answers first. If " +
  "that call hits voicemail, that job is gone.\n\n" +
  "For {company}, we make sure every missed call gets an instant text back, every lead " +
  "hears from you within minutes, and reviews come in steadily after each job. It all runs " +
  "on its own once it is set up.\n\n" +
  "Would you be open to a quick 10 to 15 minute call this week? Whatever day works for you " +
  "works for me, just reply and I will make it happen.\n\nThanks,\nJack";

const PLUMBING_D3 =
  "Hi {first},\n\n" +
  "Following up on my note from earlier this week.\n\n" +
  "The plumbing companies pulling the most work in DFW are not always the best plumbers. " +
  "They are the ones who answer first when a water heater dies, respond to new leads in " +
  "minutes, and have reviews coming in steadily. Emergency work goes to whoever picks up, " +
  "and everything else goes to whoever looks most trusted online.\n\n" +
  "For {company}, getting those things running automatically is exactly what we build for " +
  "local service businesses we work with. Would you be open to a quick call to walk through " +
  "what that looks like? Name any day and time and I will work around your schedule." +
  "\n\nThanks,\nJack";

const PLUMBING_D7 =
  "Hi {first},\n\n" +
  "I have reached out a couple of times now so I will keep this short.\n\n" +
  "The plumbing companies winning in DFW have one thing most others do not. Their phones " +
  "never truly go unanswered. A missed call gets a text back in seconds, new leads get a " +
  "response in minutes, and reviews build after every job. When someone has water on the " +
  "floor, that speed is the whole decision.\n\n" +
  "If you want to see what that looks like built out for {company}, reply with any day and " +
  "time that works and I will be there. If not, no worries at all and I wish you a great " +
  "rest of the season.\n\nThanks,\nJack";

const PEST_D1 =
  "Hi {first},\n\n" +
  "I am Jack with Wing Digital. We set up automated systems for local service businesses " +
  "in DFW that answer fast, keep customers on schedule, and build the online reputation " +
  "that wins new work.\n\n" +
  "Pest control has a math most trades do not. One missed call is not one lost job, it is " +
  "a quarterly plan that would have paid you for years. And when a homeowner finds ants in " +
  "the kitchen, they call down the list and hire whoever answers first.\n\n" +
  "For {company}, we make sure missed calls get an instant text back, new leads hear from " +
  "you in minutes, and reviews come in steadily after every visit.\n\n" +
  "Would you be open to a quick 10 to 15 minute call this week? Whatever day works for you " +
  "works for me, just reply and I will make it happen.\n\nThanks,\nJack";

const PEST_D3 =
  "Hi {first},\n\n" +
  "Following up on my note from earlier this week.\n\n" +
  "When a homeowner picks a pest company, they do two things. They read reviews, and they " +
  "call whoever looks most trusted. The big national names win on volume, but a local " +
  "company with steady reviews and a phone that always gets answered beats them in its own " +
  "neighborhoods. The independents losing that fight are usually losing it on follow-up, " +
  "not on the work.\n\n" +
  "For {company}, getting reviews, fast response, and customer follow-up running " +
  "automatically is exactly what we build for local service businesses we work with. Would " +
  "you be open to a quick call to walk through it? Name any day and time and I will work " +
  "around your schedule.\n\nThanks,\nJack";

const PEST_D7 =
  "Hi {first},\n\n" +
  "I have reached out a couple of times now so I will keep this short.\n\n" +
  "Recurring service is the whole value of a pest control customer. Every missed call or " +
  "quiet follow-up is not a one time loss, it is a plan that renews somewhere else. The " +
  "local companies holding their routes have systems doing the follow-up for them, " +
  "reminders before each visit, review requests after, and an instant reply to every call " +
  "they cannot take.\n\n" +
  "If you want to see what that looks like built out for {company}, reply with any day and " +
  "time that works and I will be there. If not, no worries at all and I wish you a great " +
  "rest of the season.\n\nThanks,\nJack";

const B2B_D1 =
  "{greeting}\n\n" +
  "I am Jack with Wing Digital. We build the growth engine for local businesses: lead " +
  "generation, custom software, SEO and AEO to get you found in Google and in AI answers.\n\n" +
  "For an operation like {company}, the math is different. One new commercial account can be " +
  "worth more than a year of small jobs, so we focus on two things: getting you in front of " +
  "the companies already searching for what you do, then building the systems that turn those " +
  "inquiries into signed contracts.\n\n" +
  "That means qualified leads coming in steadily, custom tools that handle your follow-up, and " +
  "a presence that makes a serious business trust you with a contract.\n\n" +
  "Would you be open to a quick 10 to 15 minute call this week? Whatever day works for you " +
  "works for me. Just reply and I will make it happen.\n\nThanks,\nJack";

const B2B_D3 =
  "{greeting}\n\n" +
  "Following up on my note from earlier this week.\n\n" +
  "The businesses winning the best commercial accounts in DFW are usually not the biggest. " +
  "They are the ones a buyer finds first, the ones that answer fast, the ones with systems " +
  "doing the follow-up so nothing slips. That is a visibility problem, a lead gen problem, a " +
  "software problem, all fixable.\n\n" +
  "For {company}, we build the whole stack: SEO and AEO so you show up first in search, lead " +
  "gen that keeps qualified inquiries coming in, custom tools that follow up for you. Open to " +
  "a quick call to walk through it? Name any day that works and I will fit your schedule." +
  "\n\nThanks,\nJack";

const B2B_D7 =
  "{greeting}\n\n" +
  "I have reached out a couple of times now so I will keep this short.\n\n" +
  "One commercial contract can carry a whole year. The businesses that keep landing them are " +
  "easy to find, quick to respond, backed by systems that never drop a lead. That is exactly " +
  "what we build: lead generation, custom software, SEO and AEO, all working together.\n\n" +
  "If you want to see what that looks like for {company}, reply with any day that works and I " +
  "will be there. If not, no worries at all, and I wish you a strong rest of the year." +
  "\n\nThanks,\nJack";

const TEMPLATE_SOURCE =
  "Rendered by this dashboard from a port of wing-outreach-cloud/daily_outreach.py's " +
  "templates (all four wired verticals, ported 2026-08-31). The sender renders from that " +
  "Python file at send time, so if it changed since the port the live email could differ " +
  "from this preview.";

// Per-vertical routing, mirroring VERTICAL_ROUTING in daily_outreach.py.
// requireFirst=false only for b2b (company-inbox greeting via {greeting}).
const ROUTING: Record<string, { bodies: [string, string, string]; requireFirst: boolean }> = {
  roofing: { bodies: [ROOFING_D1, ROOFING_D3, ROOFING_D7], requireFirst: true },
  plumbing: { bodies: [PLUMBING_D1, PLUMBING_D3, PLUMBING_D7], requireFirst: true },
  "pest-control": { bodies: [PEST_D1, PEST_D3, PEST_D7], requireFirst: true },
  b2b: { bodies: [B2B_D1, B2B_D3, B2B_D7], requireFirst: false },
};

// ── Rendering helpers, ported from daily_outreach.py ───────────────────────

const LEGAL_SUFFIX_RE = /[\s,]*\b(?:LLC|L\.L\.C\.|Inc\.?|Incorporated|Corp\.?|Corporation|Co\.|Ltd\.?)\s*$/i;

function cleanCompany(company: string): string {
  let name = (company || "").trim();
  for (const sep of [" | ", " - ", " – "]) {
    if (name.includes(sep)) name = name.split(sep)[0].trim();
  }
  let prev: string | null = null;
  while (prev !== name) {
    prev = name;
    name = name.replace(LEGAL_SUFFIX_RE, "").replace(/[ ,]+$/, "");
  }
  return name || company;
}

const BAD_FIRST = new Set(["", "none", "there", "info", "sales", "team", "owner", "contact"]);

function parseFirst(owner: string): string {
  const n = (owner || "").trim();
  return n ? n.split(/\s+/)[0] : "there";
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const PLACEHOLDER_RE = /\{[a-z_]+\}/;

type QueueRow = {
  id: number; name: string | null; owner_name: string | null; email: string | null;
  city: string | null; trade: string | null; status: string | null;
};

type RenderedMessage = {
  ported: boolean;
  note: string;
  subjects: [string, string, string] | null;
  bodies: { d1: string; d3: string; d7: string } | null;
};

type QaFlag = { code: string; label: string; detail: string };

function renderFor(r: QueueRow): { message: RenderedMessage; flags: QaFlag[] } {
  const flags: QaFlag[] = [];
  const company = cleanCompany(r.name ?? "");
  const first = parseFirst(r.owner_name ?? "");
  const email = (r.email ?? "").trim();
  const trade = (r.trade ?? "").trim();

  if (!company) {
    flags.push({
      code: "no_company", label: "no company name",
      detail: "This row has no usable company name, so the templates would interpolate an empty string mid-sentence. The sender's own QA gate should block it; do not trust that, fix the row.",
    });
  }
  if (!email) {
    flags.push({
      code: "no_email", label: "no email address",
      detail: "No recipient address on the row. It matches the queue filter only because of whitespace; it cannot actually be mailed.",
    });
  } else if (!EMAIL_RE.test(email)) {
    flags.push({
      code: "bad_email", label: "malformed email",
      detail: `"${email}" does not parse as an address. The sender's verifier should mark it bad_email and skip it.`,
    });
  }

  const routing = ROUTING[trade];
  if (!routing) {
    return {
      message: {
        ported: false,
        subjects: null, bodies: null,
        note: `Vertical "${trade}" has no routing in the sender at all — if it ever reached the send path it would be skipped as unwired, not mailed.`,
      },
      flags,
    };
  }

  if (routing.requireFirst && BAD_FIRST.has(first.toLowerCase())) {
    flags.push({
      code: "no_first_name",
      label: "no owner first name",
      detail: `The "${trade}" templates greet a person by first name and this row has none usable ("${first}"). The sender's QA gate blocks it rather than shipping "Hi there," on a personal template — but it will sit at the front of the queue getting skipped until the name is filled or the row is retired.`,
    });
  }

  const greeting = !BAD_FIRST.has(first.toLowerCase()) ? `Hi ${first},` : "Hi there,";
  const fill = (t: string) =>
    t.replaceAll("{greeting}", greeting).replaceAll("{company}", company).replaceAll("{first}", first);
  const [t1, t3, t7] = routing.bodies;
  const d1 = fill(t1), d3 = fill(t3), d7 = fill(t7);
  for (const [label, text] of [["day 1", d1], ["day 3", d3], ["day 7", d7]] as const) {
    if (PLACEHOLDER_RE.test(text)) {
      flags.push({
        code: "placeholder", label: `unfilled placeholder in ${label}`,
        detail: `The rendered ${label} body still contains a {placeholder}. This exact check also blocks the real send, but the row needs fixing either way.`,
      });
    }
  }
  return {
    message: {
      ported: true,
      note: TEMPLATE_SOURCE,
      subjects: [
        `quick idea for ${company}`,
        routing.requireFirst
          ? `noticed a couple things, ${first}`
          : `a couple things on ${company}`,
        `last note on ${company}`,
      ],
      bodies: { d1, d3, d7 },
    },
    flags,
  };
}

// ── PostgREST plumbing ─────────────────────────────────────────────────────

async function pg(path: string, exact = false): Promise<{ rows: unknown[]; total: number | null; error: string | null }> {
  const url = sbUrl(); const key = sbService();
  if (!url || !key) {
    return { rows: [], total: null, error: "OS_SUPABASE_URL / OS_SUPABASE_SERVICE_KEY are not set on this deployment." };
  }
  try {
    const res = await fetch(`${url}/rest/v1/${path}`, {
      headers: {
        apikey: key, Authorization: `Bearer ${key}`,
        ...(exact ? { Prefer: "count=exact" } : {}),
      },
      cache: "no-store",
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { rows: [], total: null, error: `${path.split("?")[0]} returned HTTP ${res.status}: ${body.slice(0, 180)}` };
    }
    const n = Number((res.headers.get("content-range") || "").split("/").pop());
    return { rows: (await res.json()) as unknown[], total: Number.isFinite(n) ? n : null, error: null };
  } catch (e) {
    return { rows: [], total: null, error: `Could not reach ${path.split("?")[0]}: ${e instanceof Error ? e.message : String(e)}` };
  }
}

async function countOf(filter: string): Promise<number | null> {
  const r = await pg(`prospects?select=id&${filter}&limit=1`, true);
  return r.error ? null : r.total;
}

const TRADE_IN = `trade=in.(${WIRED.join(",")})`;
const STATUS_IN = `status=in.(${SEND_STATUSES.join(",")})`;
const QUEUE_FILTER = `${STATUS_IN}&email=not.is.null&${TRADE_IN}&client=eq.${CLIENT}`;

export async function GET() {
  // ── Lane state: paused flag, daily counter, last send ────────────────────
  const stateR = await pg(`outreach_state?client=eq.${CLIENT}&select=client,day,count,last_send_ts,paused`);
  const state = (stateR.rows[0] ?? null) as
    | { day: string | null; count: number | null; last_send_ts: string | null; paused: boolean | null }
    | null;
  const today = new Date().toISOString().slice(0, 10);
  const sentToday = state ? (state.day === today ? state.count ?? 0 : 0) : null;

  const lane = {
    available: !stateR.error,
    reason: stateR.error,
    paused: state ? state.paused === true : null,
    sentToday,
    dailyCap: DAILY_CAP,
    // last_send_ts is stored as epoch seconds (a float), not ISO. Normalize so
    // the UI's date parsing never mistakes 1786923735 for a millisecond value.
    lastSendAt: (() => {
      const v = state?.last_send_ts;
      if (v == null) return null;
      const n = Number(v);
      if (Number.isFinite(n)) return new Date(n * 1000).toISOString();
      return String(v);
    })(),
    windowNote: "The sender only fires 7am to 7pm, at most one email every 10 minutes, hard cap 100/day.",
    stateNote: state
      ? null
      : stateR.error
      ? null
      : `No outreach_state row exists for client "${CLIENT}", so the paused flag, daily count and last-send time are all unknown — this is a missing row, not a fresh day.`,
    // Load-bearing and true regardless of the paused flag: the sender's GHL
    // delivery step was removed when GHL was retired (2026-08-22), and per
    // daily_outreach.py there is currently NO live delivery step — the
    // Wing-owned SMTP pipe (smtp_sender.py) is the replacement and is not
    // live yet. Unpausing today would not actually deliver mail.
    deliveryWarning:
      "The engine currently has NO live delivery step: the old GoHighLevel path was removed when " +
      "GHL was retired on 2026-08-22, and the replacement (the Wing-owned SMTP pipe, " +
      "smtp_sender.py) is built but not live yet. Even unpaused, nothing would reach an inbox. " +
      "Treat this board as the pre-flight QA queue for when that pipe goes live.",
  };

  // ── The queue: exactly the sender's eligible pool, in the sender's order ─
  const queueR = await pg(
    `prospects?select=id,name,owner_name,email,city,trade,status&${QUEUE_FILTER}&order=id.asc&limit=${QUEUE_PREVIEW}`,
    true
  );
  const queueRows = (queueR.rows as QueueRow[]).filter((r) => (r.email ?? "").trim() !== "");
  const emptyEmailDropped = queueR.rows.length - queueRows.length;

  const queue = {
    available: !queueR.error,
    reason: queueR.error,
    total: queueR.total,
    shown: queueRows.length,
    truncated: queueR.total != null && queueR.total > queueRows.length,
    orderNote:
      "Ordered by id ascending, which is the exact order the sender claims rows in " +
      "(claim_next_prospect: ORDER BY id ASC). The first row here is literally the next email out.",
    droppedNote: emptyEmailDropped > 0
      ? `${emptyEmailDropped} row${emptyEmailDropped === 1 ? "" : "s"} in this page carry an empty-string email; the database filter cannot see that, so they are dropped here and would be skipped by the verifier at send time.`
      : null,
    items: queueRows.map((r) => {
      const { message, flags } = renderFor(r);
      return {
        id: r.id,
        company: r.name,
        person: (r.owner_name ?? "").trim() || null,
        email: (r.email ?? "").trim(),
        city: r.city,
        trade: r.trade,
        status: r.status,
        statusNote: r.status === "enriching"
          ? "Status 'enriching' is INSIDE the send gate — the sender treats it exactly like 'new'. Being mid-enrichment does not protect a row from being mailed."
          : null,
        message,
        flags,
      };
    }),
  };

  // ── Per-vertical queue counts ────────────────────────────────────────────
  const byVertical = await Promise.all(
    WIRED.map(async (t) => ({
      trade: t,
      queued: await countOf(`${STATUS_IN}&email=not.is.null&trade=eq.${t}&client=eq.${CLIENT}`),
    }))
  );

  // ── What already went out ────────────────────────────────────────────────
  const sentR = await pg(
    `prospects?select=id,name,email,city,trade,status,emailed_at&emailed_at=not.is.null&client=eq.${CLIENT}&order=emailed_at.desc&limit=30`,
    true
  );
  const sent = {
    available: !sentR.error,
    reason: sentR.error,
    total: sentR.total,
    items: (sentR.rows as (QueueRow & { emailed_at: string | null })[]).map((r) => ({
      id: r.id, company: r.name, email: r.email, city: r.city,
      trade: r.trade, status: r.status, emailedAt: r.emailed_at,
    })),
  };

  // ── What the machine refused to send ─────────────────────────────────────
  const [qaFailed, badEmail, claimed] = await Promise.all([
    countOf(`status=eq.qa-failed&client=eq.${CLIENT}`),
    countOf(`status=eq.bad_email&client=eq.${CLIENT}`),
    countOf(`status=eq.claimed&client=eq.${CLIENT}`),
  ]);
  const guardrails = {
    qaFailed,
    badEmail,
    claimed,
    claimedNote: (claimed ?? 0) > 0
      ? `${claimed} row${claimed === 1 ? " is" : "s are"} stuck in 'claimed' — a sender grabbed them and never reported back. The stale-claim reaper should release them; if this number persists across days, it is not.`
      : null,
    note:
      "qa-failed rows tripped the sender's own copy checks (placeholders, bad greeting, tone); " +
      "bad_email rows failed address verification. Neither will ever be mailed as-is.",
  };

  // ── Automated texts: the honest answer ───────────────────────────────────
  const texts = {
    exists: false,
    note:
      "No automated SMS lane exists today. Texting went through GoHighLevel, which was retired " +
      "on 2026-08-22, and nothing has replaced it. There is no queue to review because there is " +
      "no pipe — an empty panel here means 'does not exist', not 'nothing scheduled'. Building a " +
      "replacement is a platform decision for Jack.",
  };

  return NextResponse.json({ lane, queue, byVertical, sent, guardrails, texts });
}
