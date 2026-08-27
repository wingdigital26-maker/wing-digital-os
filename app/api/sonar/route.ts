import { NextResponse } from "next/server";

// ───────────────────────────────────────────────────────────────────────────
// Sonar API — the free social + web lead engine's queue, surfaced in the OS.
//
// Unlike /api/prospects (which shells out to python against a local sqlite db),
// Sonar's data lives in Supabase, so this works with Jack's PC off. No isCloud()
// guard is needed: the same fetch runs locally and on Vercel.
//
// NOTE this is a DIFFERENT Supabase project from the OS one. Sonar writes to the
// Prowl project, so it needs its own credentials rather than OS_SUPABASE_*:
//   SONAR_SUPABASE_URL
//   SONAR_SUPABASE_SERVICE_KEY
// Without them the route degrades to a "not configured" body instead of 500ing,
// matching how the other data routes fail soft.
//
// ── WHAT THIS ROUTE IS FOR ────────────────────────────────────────────────
// The scrapers write 46 columns per lead. This route used to return 16 of them,
// flattened, so a lead with a named owner, a quoted fact from their own website
// and a Google Maps identity match rendered exactly like a bare row that was
// only ever guessed at. Jack could not tell what he was paying for.
//
// Three rules govern everything below, and they are enforced in code, not in
// comments:
//
//   1. STRENGTH OF EVIDENCE IS NEVER FLATTENED. "verified" has two completely
//      different standards behind it — a Google Maps place match (confirms the
//      business AND its location AND its phone) versus "verified by own website"
//      (confirms the company is real, but says nothing about where it is). Of
//      93 verified rows, 59 are Maps-matched and 34 are website-only. They are
//      returned as different tiers with different labels and different
//      statements of what each does and does not prove. Same for contacts: a
//      named person's inbox, a role inbox (info@/sales@), and a bare scraped
//      address with no page behind it are three different things.
//
//   2. EVERY CLAIM CARRIES ITS SOURCE. Each derived block ships a sourceUrl the
//      UI can link in one click. A fact with no reachable source is marked as
//      having no source rather than being quietly presented as if it did.
//
//   3. AN UNKNOWN IS NEVER A ZERO. Every numeric ships as { value, known,
//      reason }. gmb_reviews = 0 means "we looked and they have no reviews";
//      gmb_reviews = null means "nobody has checked", and the two are worth
//      opposite things on a sales call. Likewise, "never audited", "audited and
//      found nothing wrong", and "audited and found gaps" are three states.
//
// BACKWARD COMPATIBLE: every key the previous version returned is still
// returned with the same name, type and meaning. Everything here is additive,
// so the CRM components can adopt the richer blocks without a rewrite.
// ───────────────────────────────────────────────────────────────────────────

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TABLE = "candidates";

function creds() {
  return {
    url: process.env.SONAR_SUPABASE_URL,
    key: process.env.SONAR_SUPABASE_SERVICE_KEY,
  };
}

// Every column the scrapers actually write. Named explicitly rather than
// select=* so that a column added upstream shows up as a deliberate change
// here instead of silently widening the payload.
const LEAD_COLUMNS = [
  "id", "source", "source_id", "url", "title", "author", "place_name",
  "loc_confidence", "category", "intent", "score", "status", "discovered_at",
  "posted_at", "ghl_pushed", "website", "phone", "email",
  "gmb_rating", "gmb_reviews", "bad_review_themes", "seo_rank",
  "has_blog", "has_service_pages", "page_count", "ssl_ok",
  "audit_gaps", "need_score", "audited_at",
  "identity", "identity_reason", "place_name_matched", "identity_checked_at",
  "contact_name", "contact_title", "contact_email", "email_kind", "email_source",
  "personalization", "personalization_source", "contact_checked_at",
  "draft_reply", "body", "embeds", "lat", "lng",
] as const;

type Row = Record<string, unknown>;

async function sb(path: string, extraHeaders: Record<string, string> = {}) {
  const { url, key } = creds();
  const res = await fetch(`${url}/rest/v1/${path}`, {
    headers: {
      apikey: key as string,
      Authorization: `Bearer ${key}`,
      ...extraHeaders,
    },
    cache: "no-store",
  });
  return res;
}

// Total row count without pulling the rows: PostgREST reports it in
// content-range when asked for an exact count over a single-row window.
async function countWhere(filter: string): Promise<number> {
  const res = await sb(`${TABLE}?${filter}&select=id`, {
    Prefer: "count=exact",
    Range: "0-0",
  });
  const cr = res.headers.get("content-range") || "";
  const total = Number(cr.split("/").pop());
  return Number.isFinite(total) ? total : 0;
}

// ── Pagination ──────────────────────────────────────────────────────────────
// PostgREST caps an unbounded select at 1000 rows and says nothing about it.
// This exact bug already bit this codebase once: Content-Range reported 1036
// while the select returned 1000, and 36 rows were silently never processed.
// So: ask for the authoritative total first, page until we have it, and RETURN
// the two numbers next to each other so a future short read is visible in the
// payload rather than being discovered months later.
export type ScanMeta = {
  contentRangeTotal: number | null;
  rowsRead: number;
  complete: boolean;
  pages: number;
  note: string | null;
};

const PAGE = 500;

async function scanAll(columns: string): Promise<{ rows: Row[]; meta: ScanMeta }> {
  const head = await sb(`${TABLE}?select=id&limit=1`, {
    Prefer: "count=exact",
    Range: "0-0",
  });
  const cr = head.headers.get("content-range") || "";
  const parsedTotal = Number(cr.split("/").pop());
  const total = Number.isFinite(parsedTotal) ? parsedTotal : null;

  const rows: Row[] = [];
  let pages = 0;
  if (total == null) {
    return {
      rows,
      meta: {
        contentRangeTotal: null, rowsRead: 0, complete: false, pages: 0,
        note: "PostgREST did not return a Content-Range total, so the true row " +
              "count of the candidates table is unknown. Nothing was scanned; " +
              "do not read the empty result as an empty table.",
      },
    };
  }
  for (let offset = 0; offset < total; offset += PAGE) {
    const res = await sb(
      `${TABLE}?select=${columns}&order=id.asc&offset=${offset}&limit=${PAGE}`
    );
    pages++;
    if (!res.ok) {
      return {
        rows,
        meta: {
          contentRangeTotal: total, rowsRead: rows.length, complete: false, pages,
          note: `Page ${pages} failed with HTTP ${res.status}, so this scan read ` +
                `${rows.length} of ${total} rows. Every count below is a floor, ` +
                `not a total.`,
        },
      };
    }
    const batch = (await res.json()) as Row[];
    if (!batch.length) break;
    rows.push(...batch);
  }
  const complete = rows.length === total;
  return {
    rows,
    meta: {
      contentRangeTotal: total, rowsRead: rows.length, complete, pages,
      note: complete
        ? null
        : `Read ${rows.length} rows but Content-Range says the table holds ${total}. ` +
          `${total - rows.length} rows were NOT scanned, so every figure derived ` +
          `from this scan is a floor. This is the PostgREST 1000-row truncation ` +
          `bug; it has bitten this project before.`,
    },
  };
}

// ── Small helpers ───────────────────────────────────────────────────────────
const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() !== "" ? v.trim() : null;
const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

function isFilled(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === "string") return v.trim() !== "";
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v as object).length > 0;
  return true;
}

// ── Identity: the single most-flattened field in the whole system ───────────
// identity says verified/unresolved/out_of_region/not_a_business. identity_reason
// says WHY, and the why is where the two different verification standards live.
export type EvidenceStandard = "maps_listing" | "own_website" | "other" | "none";
export type EvidenceStrength = "strong" | "moderate" | "none" | "negative";

export type IdentityBlock = {
  value: string | null;            // raw identity column, unchanged
  reason: string | null;           // raw identity_reason, unchanged
  standard: EvidenceStandard;
  strength: EvidenceStrength;
  label: string;                   // what to put on the chip
  proves: string;                  // what this evidence DOES establish
  doesNotProve: string | null;     // what a human must not assume from it
  matchedPlace: string | null;     // the Maps listing name we matched against
  sourceUrl: string | null;        // one click to the thing that proves it
  checkedAt: string | null;
};

function mapsSearchUrl(place: string, city: string | null): string {
  const q = city ? `${place} ${city}` : place;
  return `https://www.google.com/maps/search/${encodeURIComponent(q)}`;
}

function identityBlock(r: Row): IdentityBlock {
  const value = str(r.identity);
  const reason = str(r.identity_reason);
  const matchedPlace = str(r.place_name_matched);
  const city = str(r.place_name);
  const website = str(r.website);
  const checkedAt = str(r.identity_checked_at);

  if (!value) {
    return {
      value: null, reason: null, standard: "none", strength: "none",
      label: "Identity never checked",
      proves: "Nothing. identity_gate.py has never run against this row, so " +
              "whether this is even a real business in the right state is unknown.",
      doesNotProve: "Do not treat an unchecked row as a clean one. A fact-check " +
                    "of the raw table found 63% junk — wrong-state companies, " +
                    "lead-gen doorway shells, and personal LinkedIn profiles.",
      matchedPlace: null, sourceUrl: null, checkedAt: null,
    };
  }

  if (value === "verified") {
    // The distinction that matters. A Maps match anchors the business to a
    // place and a phone. A website match only proves the company exists.
    //
    // identity_reason is the authoritative statement of WHICH standard the gate
    // applied, so it is read first. place_name_matched is corroborating detail,
    // not a second vote — one live row (McKinney Roofing) carries a Maps place
    // name alongside a website-only reason, and quietly promoting it to "Maps
    // verified" on the strength of the weaker field would upgrade a row's
    // evidence on no evidence. It is reported as a conflict instead.
    if (/matched Maps listing/i.test(reason ?? "")) {
      const place = matchedPlace ?? str(r.title) ?? "";
      return {
        value, reason, standard: "maps_listing", strength: "strong",
        label: "Verified — Google Maps listing match",
        proves:
          `A Google Maps business listing${matchedPlace ? ` ("${matchedPlace}")` : ""} ` +
          `was matched to this row, which confirms the business is real, confirms ` +
          `where it operates, and confirms the phone number belongs to it. This is ` +
          `the strongest identity evidence Sonar produces.`,
        doesNotProve: null,
        matchedPlace,
        sourceUrl: place ? mapsSearchUrl(place, city) : website,
        checkedAt,
      };
    }
    if (/verified by own website/i.test(reason ?? "")) {
      return {
        value, reason, standard: "own_website", strength: "moderate",
        label: "Verified — own website only (location NOT confirmed)",
        proves:
          "The company's own website provably belongs to this business (domain or " +
          "title match) and publishes a DFW phone number. That establishes the " +
          "company is real and reachable.",
        doesNotProve:
          "It does NOT confirm where the business is located. The gate did not " +
          "verify this against a Google Maps listing, so the address and service " +
          "area are unconfirmed — a published DFW phone number is not the same as " +
          "a DFW address. Treat geography as an open question on the call." +
          (matchedPlace
            ? ` CONFLICT: this row also carries a matched Maps place name ` +
              `("${matchedPlace}") even though the gate recorded a website-only ` +
              `verification. The two fields disagree about how this was verified. ` +
              `The weaker of the two is shown, because a disagreement is not a ` +
              `reason to upgrade a row's evidence.`
            : ""),
        matchedPlace,
        sourceUrl: website,
        checkedAt,
      };
    }
    return {
      value, reason, standard: "other", strength: "moderate",
      label: "Verified — by an unrecognised method",
      proves: reason ?? "The gate marked this verified but recorded no reason.",
      doesNotProve:
        "The reason string does not match either known verification standard " +
        "(Maps listing or own website), so how strong this is cannot be judged " +
        "from the data. Check it by hand before relying on it.",
      matchedPlace, sourceUrl: website, checkedAt,
    };
  }

  const negatives: Record<string, { label: string; proves: string }> = {
    unresolved: {
      label: "Unresolved — could not be confirmed",
      proves:
        "The gate looked and could not confirm this is a real business at a real " +
        "location. Usually no Google Maps listing was found. Unresolved is NOT a " +
        "soft yes; it is an unanswered question.",
    },
    out_of_region: {
      label: "Out of region — wrong geography",
      proves:
        "The gate found positive evidence this business is not in the target " +
        "region (a non-US domain, or an area code outside DFW). Calling it wastes " +
        "the slot.",
    },
    not_a_business: {
      label: "Not a business",
      proves:
        "This row is a person, a group, or a page — not a company that can be " +
        "sold to. The largest single bucket in the table is LinkedIn person " +
        "profiles matched by a company-name query.",
    },
  };
  const n = negatives[value];
  return {
    value, reason,
    standard: "other",
    strength: "negative",
    label: n?.label ?? `Identity: ${value}`,
    proves: n?.proves ?? reason ?? "No reason was recorded.",
    doesNotProve: null,
    matchedPlace,
    sourceUrl: website ?? str(r.url),
    checkedAt,
  };
}

// ── Contact: a named human, a role inbox, and a bare scrape are not equal ───
export type ContactBlock = {
  name: string | null;
  title: string | null;
  email: string | null;
  kind: "person" | "role" | "unknown" | null;
  kindLabel: string;
  reachesAHuman: boolean | null;   // null = unknown, never false-by-default
  sourceUrl: string | null;        // the page the address was read from
  sourced: boolean;
  phone: string | null;
  checkedAt: string | null;
  detail: string;
};

const ROLE_LOCALS = new Set([
  "info", "contact", "sales", "hello", "office", "admin", "support", "team",
  "service", "estimates", "help", "inquiries", "mail", "roofing", "customerservice",
]);

function inferKind(email: string | null): "person" | "role" | "unknown" | null {
  if (!email) return null;
  const local = email.split("@")[0]?.toLowerCase().replace(/[^a-z]/g, "");
  if (!local) return "unknown";
  if (ROLE_LOCALS.has(local)) return "role";
  if (/^[a-z]+\.[a-z]+$/.test(email.split("@")[0].toLowerCase())) return "person";
  return "unknown";
}

function contactBlock(r: Row): ContactBlock {
  const name = str(r.contact_name);
  const title = str(r.contact_title);
  // contact_email came from contact_find.py and carries the page it was read
  // from. `email` is a bare scrape with no page behind it. Prefer the sourced
  // one, and say plainly which one is being shown.
  const sourced = str(r.contact_email);
  const bare = str(r.email);
  const email = sourced ?? bare;
  const sourceUrl = str(r.email_source);
  const declared = str(r.email_kind);
  const kind =
    declared === "personal" ? "person"
    : declared === "role" ? "role"
    : declared === "unknown" ? "unknown"
    : inferKind(email);

  const kindLabel =
    !email ? "No email address found"
    : kind === "person" ? (name ? `Named person — ${name}${title ? `, ${title}` : ""}` : "Named individual's inbox")
    : kind === "role" ? "Role inbox (goes to whoever is on duty)"
    : "Inbox of unknown type";

  let detail: string;
  if (!email) {
    detail = str(r.contact_checked_at)
      ? "contact_find.py ran against this business and found no email address " +
        "on the site. That is a checked absence, not an unchecked one."
      : "No contact lookup has ever run for this business, so the absence of an " +
        "email means nothing. Nobody has looked.";
  } else if (sourced) {
    detail =
      `Read from a specific page on the business's own site${sourceUrl ? "" : ", though the page URL was not recorded"}. ` +
      (kind === "person"
        ? `It reaches a named human${name ? ` (${name}${title ? `, ${title}` : ""})` : ""}, ` +
          `so the first line can address them directly.`
        : kind === "role"
        ? "It is a role inbox, not a person. Expect a gatekeeper, and do not " +
          "open with a first name."
        : "Whether it reaches a person or a shared inbox could not be determined.");
  } else {
    detail =
      "This is a bare scraped address with no source page recorded — it was " +
      "picked up during enrichment, not confirmed by a contact lookup. It may be " +
      "stale or belong to a different entity. Weaker than a sourced address.";
  }

  return {
    name, title, email, kind,
    kindLabel,
    reachesAHuman: !email ? null : kind === "person" ? true : kind === "role" ? false : null,
    sourceUrl, sourced: Boolean(sourced && sourceUrl),
    phone: str(r.phone),
    checkedAt: str(r.contact_checked_at),
    detail,
  };
}

// ── The opener: a quoted fact beats every number on this page ───────────────
export type PersonalizationBlock = {
  quote: string | null;
  sourceUrl: string | null;
  hasSource: boolean;
  detail: string;
};

function personalizationBlock(r: Row): PersonalizationBlock {
  const quote = str(r.personalization);
  const sourceUrl = str(r.personalization_source);
  if (!quote) {
    return {
      quote: null, sourceUrl: null, hasSource: false,
      detail:
        "personalize.py has not written an opener for this lead. Only 26 of " +
        "1,224 rows have one, so an empty opener here is the normal state of the " +
        "pipeline rather than a fact about this business.",
    };
  }
  return {
    quote, sourceUrl, hasSource: Boolean(sourceUrl),
    detail: sourceUrl
      ? "A specific fact read off this business's own site, with the page it came " +
        "from. Open the call with it."
      : "A specific fact about this business, but the page it was read from was " +
        "not recorded — so it cannot be checked before the call. Say it only if " +
        "you can confirm it.",
  };
}

// ── The audit: three states, never one blank panel ─────────────────────────
export type AuditGap = { text: string; severity: "warning" | "gap"; sourceUrl: string | null };
export type AuditBlock = {
  state: "NEVER_AUDITED" | "AUDITED_NO_GAPS" | "AUDITED_WITH_GAPS";
  gaps: AuditGap[];
  auditedAt: string | null;
  sourceUrl: string | null;
  detail: string;
};

function auditBlock(r: Row): AuditBlock {
  const auditedAt = str(r.audited_at);
  const website = str(r.website);
  const raw = Array.isArray(r.audit_gaps) ? (r.audit_gaps as unknown[]) : null;
  const gaps: AuditGap[] = (raw ?? [])
    .map((g) => String(g))
    .filter((g) => g.trim() !== "")
    .map((text) => ({
      // The audit prefixes genuine red flags with WARNING:. Those are not
      // things to sell against — they are reasons to doubt the row itself.
      severity: /^WARNING:/i.test(text) ? ("warning" as const) : ("gap" as const),
      text,
      sourceUrl: website,
    }));

  if (!auditedAt && raw == null) {
    return {
      state: "NEVER_AUDITED", gaps: [], auditedAt: null, sourceUrl: website,
      detail:
        "audit_prospect.py has never run against this business. There is no list " +
        "of weaknesses because nobody looked — not because the site is clean.",
    };
  }
  if (!gaps.length) {
    return {
      state: "AUDITED_NO_GAPS", gaps: [], auditedAt, sourceUrl: website,
      detail:
        "The audit ran and found no weaknesses worth selling against. Their web " +
        "presence is in decent shape, which makes this a harder sell, not an " +
        "unexamined one.",
    };
  }
  const warnings = gaps.filter((g) => g.severity === "warning").length;
  return {
    state: "AUDITED_WITH_GAPS", gaps, auditedAt, sourceUrl: website,
    detail:
      `${gaps.length} finding${gaps.length === 1 ? "" : "s"} from the audit of ` +
      `${website ?? "their site"}` +
      (warnings
        ? `, of which ${warnings} ${warnings === 1 ? "is a WARNING about the row itself" : "are WARNINGS about the row itself"} ` +
          `rather than something to sell against — resolve those before calling.`
        : `. These are the weaknesses Wing sells against.`),
  };
}

// ── Numbers, with unknowns that stay unknown ───────────────────────────────
export type Metric = { value: number | null; known: boolean; reason: string | null };
const metric = (v: unknown, reason: string): Metric => {
  const n = num(v);
  return n == null ? { value: null, known: false, reason } : { value: n, known: true, reason: null };
};

export type SignalsBlock = {
  needScore: Metric;
  seoRank: Metric;
  gmbRating: Metric;
  gmbReviews: Metric;
  pageCount: Metric;
  hasBlog: boolean | null;
  hasServicePages: boolean | null;
  sslOk: boolean | null;
  siteChecked: boolean;
  badReviewThemes: string[];
  detail: string;
};

function signalsBlock(r: Row): SignalsBlock {
  const siteChecked = num(r.page_count) != null || typeof r.ssl_ok === "boolean";
  const themesRaw = r.bad_review_themes;
  const badReviewThemes = Array.isArray(themesRaw)
    ? (themesRaw as unknown[]).map(String).filter(Boolean)
    : str(themesRaw) ? [str(themesRaw) as string] : [];
  return {
    needScore: metric(
      r.need_score,
      "No need score. Scoring only runs after an audit, so this lead has not " +
      "been ranked against the others — it is unscored, not low-need."
    ),
    seoRank: metric(
      r.seo_rank,
      "Their Google rank for the target term was never measured. Only 21 of " +
      "1,224 rows carry a rank, so this is an unmeasured field across the board — " +
      "an absent rank says nothing about how they rank."
    ),
    gmbRating: metric(
      r.gmb_rating,
      "No Google rating was captured. Nobody checked; this does not mean they " +
      "are unrated."
    ),
    gmbReviews: metric(
      r.gmb_reviews,
      "The review count was never captured. This is NOT zero reviews — a real " +
      "zero (they have a listing with no reviews) is a strong buying signal, and " +
      "an unknown is no signal at all. Do not confuse them."
    ),
    pageCount: metric(r.page_count, "Their site was never crawled, so its size is unknown."),
    hasBlog: typeof r.has_blog === "boolean" ? (r.has_blog as boolean) : null,
    hasServicePages:
      typeof r.has_service_pages === "boolean" ? (r.has_service_pages as boolean) : null,
    sslOk: typeof r.ssl_ok === "boolean" ? (r.ssl_ok as boolean) : null,
    siteChecked,
    badReviewThemes,
    detail: siteChecked
      ? "Site metrics come from a real crawl of their website."
      : "Their website was never crawled, so blog/service-page/SSL/page-count are " +
        "all unknown rather than absent.",
  };
}

// ── Where the row came from, and how sure we are about the city ────────────
export type OriginBlock = {
  source: string | null;
  sourceUrl: string | null;
  author: string | null;
  discoveredAt: string | null;
  postedAt: string | null;
  city: string | null;
  cityConfidence: number | null;
  cityDetail: string;
};

function originBlock(r: Row): OriginBlock {
  const conf = num(r.loc_confidence);
  const city = str(r.place_name);
  const matched = str(r.place_name_matched);
  let cityDetail: string;
  if (!city) {
    cityDetail = "No city was ever assigned to this row.";
  } else if (matched) {
    cityDetail =
      `${city} is corroborated by the matched Google Maps listing "${matched}", ` +
      `so the geography is confirmed rather than inferred.`;
  } else if (conf != null && conf >= 0.8) {
    cityDetail = `${city} was read directly from the listing (confidence ${conf}).`;
  } else if (conf != null && conf <= 0.25) {
    cityDetail =
      `${city} is a LOW-CONFIDENCE guess (${conf}) — it was inferred from the ` +
      `search that found this row, not read off the business. Treat the city as ` +
      `unverified.`;
  } else {
    cityDetail =
      `${city} is inferred from the query that found this row (confidence ` +
      `${conf ?? "unrecorded"}), not confirmed against the business itself.`;
  }
  return {
    source: str(r.source),
    sourceUrl: str(r.url),
    author: str(r.author),
    discoveredAt: str(r.discovered_at),
    postedAt: str(r.posted_at),
    city, cityConfidence: conf, cityDetail,
  };
}

// ── Tiers from the new demand-side sources ─────────────────────────────────
// source_junk.py writes its tier into BOTH `category` and `intent`: `hire`
// (someone is asking to pay a hauler right now), `event` (a dated cleanout with
// a deadline), `signal` (a bulky giveaway — a marketing row, not a job). These
// are worth wildly different amounts, and lumping them together is exactly how
// you get a lead list nobody calls. Everything else keeps `intent=prospect`.
export type TierBlock = {
  tier: string | null;
  label: string;
  meaning: string;
  rank: number;              // 1 = act today
} | null;

const JUNK_TIERS: Record<string, { label: string; meaning: string; rank: number }> = {
  hire: {
    label: "HIRE — someone is trying to pay a hauler right now",
    meaning:
      "A live posting from a person asking to pay for haul-away work. The " +
      "highest-value row this pipeline produces, and it expires — treat it as " +
      "same-day.",
    rank: 1,
  },
  event: {
    label: "EVENT — a dated cleanout with a deadline",
    meaning:
      "An estate sale or similar dated cleanout. The city, the company running " +
      "it and the end date are known, and the leftovers have to leave the house " +
      "when it ends. Call before the end date.",
    rank: 2,
  },
  signal: {
    label: "SIGNAL — a bulky giveaway, not a job",
    meaning:
      "Someone giving away something bulky (sofa, appliance, hot tub) because " +
      "they are moving or decluttering. This is a marketing-list row, NOT " +
      "somebody hiring. Do not work it like a hire.",
    rank: 3,
  },
};

function tierBlock(r: Row): TierBlock {
  const t = (str(r.intent) ?? str(r.category) ?? "").toLowerCase();
  const spec = JUNK_TIERS[t];
  if (!spec) return null;
  return { tier: t, label: spec.label, meaning: spec.meaning, rank: spec.rank };
}

// ── One lead, fully surfaced ───────────────────────────────────────────────
function shapeLead(r: Row) {
  return {
    // ── unchanged keys, same names and types as the previous version ──
    id: num(r.id) ?? 0,
    title: str(r.title),
    place_name: str(r.place_name),
    category: str(r.category),
    source: str(r.source),
    url: str(r.url),
    website: str(r.website),
    phone: str(r.phone),
    need_score: num(r.need_score),
    gmb_rating: num(r.gmb_rating),
    gmb_reviews: num(r.gmb_reviews),
    seo_rank: num(r.seo_rank),
    audit_gaps: Array.isArray(r.audit_gaps) ? (r.audit_gaps as unknown[]).map(String) : null,
    draft_reply: str(r.draft_reply),
    status: str(r.status),
    discovered_at: str(r.discovered_at),

    // ── additive: everything the scrapers found, graded by evidence ──
    identity: identityBlock(r),
    contact: contactBlock(r),
    personalization: personalizationBlock(r),
    audit: auditBlock(r),
    signals: signalsBlock(r),
    origin: originBlock(r),
    tier: tierBlock(r),
    pushedToCrm: r.ghl_pushed === true,
  };
}

// ── Fill rates: what is actually being collected, per column ───────────────
// Jack cannot tell a rich lead from a bare one, and cannot see what he is
// paying for. This block answers both from the real table: for every column,
// how many of the scanned rows carry a non-null, non-empty value. A column at
// 2% is a different design problem from one at 90%, and shipping the number
// means the UI can refuse to draw a panel that would be misleading.
export type Coverage = {
  column: string;
  filled: number;
  rows: number;
  pct: number;
  verdict: "core" | "common" | "sparse" | "rare" | "empty";
};

function coverageOf(rows: Row[]): Coverage[] {
  if (!rows.length) return [];
  const cols = new Set<string>();
  for (const r of rows) for (const k of Object.keys(r)) cols.add(k);
  return [...cols]
    .map((column) => {
      const filled = rows.reduce((n, r) => n + (isFilled(r[column]) ? 1 : 0), 0);
      const pct = Math.round((filled / rows.length) * 1000) / 10;
      const verdict: Coverage["verdict"] =
        pct === 0 ? "empty" : pct < 5 ? "rare" : pct < 25 ? "sparse" : pct < 75 ? "common" : "core";
      return { column, filled, rows: rows.length, pct, verdict };
    })
    .sort((a, b) => b.filled - a.filled);
}

export async function GET(req: Request) {
  const { url, key } = creds();
  if (!url || !key) {
    return NextResponse.json({
      configured: false,
      error:
        "Sonar Supabase credentials are not set. Add SONAR_SUPABASE_URL and SONAR_SUPABASE_SERVICE_KEY.",
      totals: null,
      leads: [],
    });
  }

  const { searchParams } = new URL(req.url);
  const limit = Math.min(Number(searchParams.get("limit") || 40), 200);
  // Default to showing ONLY identity-verified businesses. A fact-check of the
  // raw table found 63% junk — wrong-state companies, lead-gen doorway shells,
  // and LinkedIn person profiles. identity_gate.py classifies every row; a
  // call list must never default to the unfiltered pile.
  const identity = searchParams.get("identity") ?? "verified";
  const minNeed = searchParams.get("minNeed") || "0.6";
  const city = searchParams.get("city") || "";
  // The full-table scan powers the exact evidence-tier counts and the fill-rate
  // table. It is the expensive part of this route, so it can be turned off.
  const wantScan = searchParams.get("coverage") !== "0";

  try {
    const [total, awaiting, highNeed, verified, unresolved, outOfRegion,
           notABusiness, unaudited, withPhone, approved] =
      await Promise.all([
        countWhere("id=gt.0"),
        countWhere("status=eq.new"),
        countWhere("need_score=gte.0.7"),
        countWhere("identity=eq.verified"),
        countWhere("identity=eq.unresolved"),
        countWhere("identity=eq.out_of_region"),
        countWhere("identity=eq.not_a_business"),
        countWhere("audited_at=is.null"),
        countWhere("phone=not.is.null"),
        countWhere("status=eq.approved"),
      ]);

    // The working list: audited businesses worth a call, best first. People
    // (LinkedIn profiles) carry a null need_score by design and are excluded.
    const filters = [
      "status=eq.new",
      identity === "all" ? "" : `identity=eq.${encodeURIComponent(identity)}`,
      `need_score=gte.${encodeURIComponent(minNeed)}`,
      city ? `place_name=eq.${encodeURIComponent(city)}` : "",
      "order=need_score.desc.nullslast",
      `limit=${limit}`,
      `select=${LEAD_COLUMNS.join(",")}`,
    ]
      .filter(Boolean)
      .join("&");

    const res = await sb(`${TABLE}?${filters}`);
    if (!res.ok) {
      return NextResponse.json(
        { configured: true, error: `Supabase ${res.status}`, totals: null, leads: [] },
        { status: 200 }
      );
    }
    const rawLeads = (await res.json()) as Row[];
    const leads = rawLeads.map(shapeLead);

    // Cities present in the working list, so the UI can offer a real filter
    // rather than a hardcoded list that drifts from the data.
    const cities = Array.from(
      new Set(leads.map((l) => l.place_name).filter(Boolean) as string[])
    ).sort();

    // ── Full-table scan: exact evidence split + fill rates ──────────────
    let coverage: Coverage[] = [];
    let scan: ScanMeta | null = null;
    let evidence: {
      verifiedTotal: number; mapsMatched: number; websiteOnly: number;
      otherMethod: number; conflicting: number; conflictNote: string | null;
      detail: string;
    } | null = null;

    if (wantScan) {
      const scanned = await scanAll(LEAD_COLUMNS.filter((c) => c !== "body").join(","));
      scan = scanned.meta;
      coverage = coverageOf(scanned.rows);
      // Classified with the SAME function that labels each lead, so the summary
      // count and the per-row chip can never tell a human two different stories.
      // (A first cut counted a Maps-reason and a place_name_matched row twice
      // and produced a negative "other" bucket — the buckets must partition.)
      const ver = scanned.rows.filter((r) => r.identity === "verified");
      const standards = ver.map((r) => identityBlock(r).standard);
      const maps = standards.filter((x) => x === "maps_listing").length;
      const site = standards.filter((x) => x === "own_website").length;
      // Rows where identity_reason and place_name_matched disagree about which
      // standard was applied. Reported, never silently resolved.
      const conflicting = ver.filter(
        (r) => /verified by own website/i.test(String(r.identity_reason ?? "")) &&
               isFilled(r.place_name_matched)
      ).length;
      evidence = {
        verifiedTotal: ver.length,
        mapsMatched: maps,
        websiteOnly: site,
        otherMethod: ver.length - maps - site,
        conflicting,
        conflictNote: conflicting
          ? `${conflicting} verified row${conflicting === 1 ? " carries" : "s carry"} a matched ` +
            `Maps place name alongside a website-only verification reason. The fields ` +
            `disagree; each such row is shown at the WEAKER (website-only) standard.`
          : null,
        detail:
          `"Verified" is not one thing. ${maps} of ${ver.length} verified rows are ` +
          `matched to a Google Maps listing, which confirms the business, its ` +
          `location and its phone. ${site} are verified by the company's own ` +
          `website only, which proves the company exists but leaves its location ` +
          `unconfirmed. Never render the two identically.` +
          (scanned.meta.complete
            ? ""
            : ` NOTE: ${scanned.meta.note} These counts are floors.`),
      };
    }

    return NextResponse.json({
      configured: true,
      totals: { total, awaiting, highNeed, unaudited, withPhone, approved,
                verified, unresolved, outOfRegion, notABusiness },
      identityFilter: identity,
      cities,
      leads,
      evidence,
      coverage,
      scan,
      fetchedAt: new Date().toISOString(),
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { configured: true, error: message, totals: null, leads: [] },
      { status: 200 }
    );
  }
}

// Approve or skip a lead straight from the OS. Mirrors queue/serve.py so both
// front ends drive the same rows. Nothing here sends a message.
export async function POST(req: Request) {
  const { url, key } = creds();
  if (!url || !key) {
    return NextResponse.json({ ok: false, error: "Sonar not configured" }, { status: 200 });
  }
  const body = await req.json().catch(() => ({}));
  const { id, action } = body as { id?: number; action?: string };
  const patch: Record<string, string> | null =
    action === "approve"
      ? { status: "approved" }
      : action === "reject"
      ? { status: "rejected" }
      : null;
  if (!id || !patch) {
    return NextResponse.json({ ok: false, error: "bad request" }, { status: 400 });
  }
  const res = await fetch(`${url}/rest/v1/${TABLE}?id=eq.${id}`, {
    method: "PATCH",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify(patch),
  });
  return NextResponse.json({ ok: res.ok });
}
