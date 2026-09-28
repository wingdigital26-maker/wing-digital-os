// ───────────────────────────────────────────────────────────────────────────
// Per-client branding + review-request copy. THE one place client details live.
//
// Used by:
//   * /add/<slug>/<key>        the add-a-customer page header (logo, colours)
//   * /api/reviews/send        the text / email a client's customer receives
//
// ADDING A CLIENT = ONE ENTRY in CLIENT_BRANDS below. Everything else falls
// back cleanly: a slug with no entry shows public.clients.name with initials
// and the house amber, and its review requests are HELD (never sent) until the
// entry has a real review link. Nothing here is ever invented: every logo,
// phone number and review link below was copied from the client's own live
// website or Google Business Profile (sources noted per entry).
//
// COPY RULES (Jack's house rules, enforced by renderTemplate + the email copy
// guard): no em or en dashes, no unrendered {tokens}. SMS always names the
// business first and ends with "Reply STOP to opt out". Email always ends with
// an unsubscribe line.
//
// Template tokens: {first} {business} {review_link} {phone} {postal_address}
// {unsubscribe_link}. A line whose OPTIONAL token ({phone}, {postal_address})
// is empty is dropped, so a missing phone never leaves "call us at ." behind.
// ───────────────────────────────────────────────────────────────────────────

export type ClientLogo = {
  src: string; // under /public
  width: number; // intrinsic pixels
  height: number;
  alt: string;
  bg: string; // tile behind the logo so it reads on both themes
  wordmark: boolean; // true when the business name is already in the image
};

export type ReviewPace = {
  perDay: number; // max review asks that leave for this client per rolling 24h
  perWeek: number; // max per rolling 7 days
};

export type ReviewTemplates = {
  sms?: string;
  emailSubject?: string;
  emailBody?: string;
};

export type ClientBrand = {
  name: string; // the business name customers know
  initials: string;
  accentLight: string; // button + focus colour on the cream theme (white text on it)
  accentDark: string; // button + focus colour on the espresso theme (dark text on it)
  logo?: ClientLogo;
  site?: string;
  phone?: string; // E.164
  phoneDisplay?: string;
  replyTo?: string; // the client's own inbox, so an email reply reaches them
  postalAddress?: string; // CAN-SPAM footer
  reviewUrl?: string; // where the ask sends people. No link, no send.
  reviewSource?: "google" | "site";
  pace?: Partial<ReviewPace>;
  templates?: ReviewTemplates;
};

export const CLIENT_BRANDS: Record<string, ClientBrand> = {
  // Source: herosjunkremovaltx.com (live Cloudflare site, 2026-09-28 build with
  // logo A). Mark = the site header's inline SVG, byte-for-byte. Colours =
  // trinity.css --navy #14284B / --red #D62A1E. Review link = the g.page link
  // the site carried, which resolves to placeid ChIJWfZ-0tvibKkR8kZLXcH31gM
  // (decodes to Hero's Maps cid 276680836995827442).
  "heros-junk": {
    name: "Hero's Junk Removal",
    initials: "HJ",
    accentLight: "#d62a1e",
    accentDark: "#f0645a",
    logo: { src: "/brands/heros-junk/mark.svg", width: 64, height: 64, alt: "Hero's Junk Removal", bg: "#ffffff", wordmark: false },
    site: "https://herosjunkremovaltx.com",
    phone: "+12142779069",
    phoneDisplay: "(214) 277-9069",
    replyTo: "herosjunkremovaltx@gmail.com",
    reviewUrl: "https://g.page/r/CfJGS13B99YDEBM/review",
    reviewSource: "google",
  },
  // Source: wingdigital26-maker.github.io/jackson-roofing (assets/img/logo.webp,
  // --cyan #1bc0ff / --cyan-ink #06809f). Phone, address and place ID from the
  // Google Business Profile "Jackson Roofing, 1516 Municipal Ave, Plano"
  // (website jacksonroofingco.com, phone (469) 323-4626), verified 2026-09-28.
  "jackson-roofing": {
    name: "Jackson Roofing",
    initials: "JR",
    accentLight: "#06809f",
    accentDark: "#1bc0ff",
    logo: { src: "/brands/jackson-roofing/logo.webp", width: 500, height: 218, alt: "Jackson Roofing", bg: "#000000", wordmark: true },
    site: "https://jacksonroofingco.com",
    phone: "+14693234626",
    phoneDisplay: "(469) 323-4626",
    replyTo: "admin@jacksonroofingco.us",
    postalAddress: "Jackson Roofing, 1516 Municipal Ave, Plano, TX 75074",
    reviewUrl: "https://search.google.com/local/writereview?placeid=ChIJ6ame49A8TIYReeE7DDlq9e0",
    reviewSource: "google",
  },
  // Source: renewalhealth.life (header logo renewalhealth2stack.jpg, v2.css
  // --plum #4b2e5a / --lilac #b79cc9). There is NO Google Business Profile yet,
  // so the review link is her own site's review page. Phone from the contact page.
  "renewal-health": {
    name: "Renewal Health",
    initials: "RH",
    accentLight: "#4b2e5a",
    accentDark: "#b79cc9",
    logo: { src: "/brands/renewal-health/logo.jpg", width: 240, height: 102, alt: "Renewal Health with Lynette Wing", bg: "#ffffff", wordmark: true },
    site: "https://renewalhealth.life",
    phone: "+15804611686",
    phoneDisplay: "(580) 461-1686",
    replyTo: "lynette@renewalhealth.life",
    reviewUrl: "https://renewalhealth.life/leave-a-review.html",
    reviewSource: "site",
    templates: {
      sms:
        "Hi {first}, this is Renewal Health. Thank you for the time we spent together. " +
        "If you'd like to share a few words about your experience, you can do that here: {review_link} " +
        "Reply STOP to opt out.",
    },
  },
};

// Google flags review spikes and pauses the whole profile, so asks drip out
// per client: at most 1 a day and 3 a week unless a client entry says otherwise.
export const DEFAULT_PACE: ReviewPace = { perDay: 1, perWeek: 3 };

// Central time. Texas limits solicitation texts to 9am to 9pm (noon on
// Sunday); we stay well inside that.
export const SEND_WINDOW = { startHour: 10, endHour: 19, sundayStartHour: 12 };

const DEFAULT_ACCENT = { accentLight: "#a8650f", accentDark: "#e8a33d" };

function initialsOf(name: string): string {
  const words = name.replace(/[^A-Za-z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
  return (words.slice(0, 2).map((w) => w[0]).join("") || "W").toUpperCase();
}

/** Brand for a slug. Unknown slugs get a clean fallback built from the DB name. */
export function brandFor(slug: string, dbName: string | null = null): ClientBrand {
  const known = CLIENT_BRANDS[slug];
  if (known) return known;
  const name = dbName?.trim() || "Your business";
  return { name, initials: initialsOf(name), ...DEFAULT_ACCENT };
}

export function hasBrand(slug: string): boolean {
  return Object.prototype.hasOwnProperty.call(CLIENT_BRANDS, slug);
}

export function paceFor(slug: string): ReviewPace {
  const p = CLIENT_BRANDS[slug]?.pace ?? {};
  return { perDay: p.perDay ?? DEFAULT_PACE.perDay, perWeek: p.perWeek ?? DEFAULT_PACE.perWeek };
}

/** True when `now` is inside the send window, in America/Chicago. */
export function inSendWindow(now: Date = new Date()): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    weekday: "short",
    hour: "numeric",
    hour12: false,
  }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0") % 24;
  const day = parts.find((p) => p.type === "weekday")?.value ?? "";
  const start = day === "Sun" ? SEND_WINDOW.sundayStartHour : SEND_WINDOW.startHour;
  return hour >= start && hour < SEND_WINDOW.endHour;
}

// ── Default review-request copy ────────────────────────────────────────────
const SMS_GOOGLE =
  "Hi {first}, this is {business}. Thanks for choosing us! If you have a minute, " +
  "a quick Google review would really help: {review_link} Reply STOP to opt out.";
const SMS_SITE =
  "Hi {first}, this is {business}. Thanks for choosing us! If you have a minute, " +
  "we'd love a quick review: {review_link} Reply STOP to opt out.";

const EMAIL_SUBJECT = "Thanks from {business}";
const EMAIL_BODY =
  "Hi {first},\n\n" +
  "Thank you for choosing {business}. We hope everything turned out the way you wanted.\n\n" +
  "If you have a minute, would you leave us a quick review? It helps other people nearby find us.\n\n" +
  "{review_link}\n\n" +
  "Questions about the job? Call or text us at {phone}.\n\n" +
  "Thank you,\n{business}\n\n" +
  "{postal_address}\n" +
  "Don't want emails like this? Unsubscribe here: {unsubscribe_link}";

const OPTIONAL = new Set(["phone", "postal_address"]);

export class TemplateError extends Error {}

/** Fill {tokens}. Lines holding an empty OPTIONAL token are dropped; an empty
 *  required token, a leftover {token} or a dash throws, so bad copy never sends. */
export function renderTemplate(tpl: string, vars: Record<string, string | null | undefined>): string {
  const lines = tpl.split("\n").filter((line) => {
    const tokens = [...line.matchAll(/\{([a-z_]+)\}/g)].map((m) => m[1]);
    return !tokens.some((t) => OPTIONAL.has(t) && !(vars[t] ?? "").trim());
  });
  const out = lines
    .join("\n")
    .replace(/\{([a-z_]+)\}/g, (whole, k: string) => {
      const v = (vars[k] ?? "").trim();
      if (!v) throw new TemplateError(`Missing value for {${k}}`);
      return v;
    })
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (/\{[a-z_]+\}/i.test(out)) throw new TemplateError("Unrendered token left in the message");
  if (/[—–]/.test(out)) throw new TemplateError("Message contains an em or en dash");
  return out;
}

export type ReviewMessage =
  | { ok: true; sms: string; emailSubject: string; emailBody: string; fromName: string; replyTo: string | null }
  | { ok: false; reason: string };

/** The exact text and email a customer of `slug` receives. Refuses (ok:false)
 *  when the client has no config entry or no real review link. */
export function reviewMessage(
  slug: string,
  first: string,
  unsubscribeLink: string | null
): ReviewMessage {
  if (!hasBrand(slug)) return { ok: false, reason: `No brand entry for "${slug}" in lib/clientBrands.ts` };
  const b = CLIENT_BRANDS[slug];
  if (!b.reviewUrl) return { ok: false, reason: `No review link configured for "${slug}"` };
  const vars = {
    first: first || "there",
    business: b.name,
    review_link: b.reviewUrl,
    phone: b.phoneDisplay ?? "",
    postal_address: b.postalAddress ?? "",
    unsubscribe_link: unsubscribeLink ?? "",
  };
  const t = b.templates ?? {};
  try {
    const sms = renderTemplate(t.sms ?? (b.reviewSource === "google" ? SMS_GOOGLE : SMS_SITE), vars);
    if (!/Reply STOP to opt out\.?$/.test(sms)) throw new TemplateError('SMS must end with "Reply STOP to opt out."');
    // The email needs an unsubscribe link; without one only the SMS can go.
    let emailSubject = "";
    let emailBody = "";
    if (unsubscribeLink) {
      emailSubject = renderTemplate(t.emailSubject ?? EMAIL_SUBJECT, vars);
      emailBody = renderTemplate(t.emailBody ?? EMAIL_BODY, vars);
      if (!emailBody.includes(unsubscribeLink)) throw new TemplateError("Email must carry the unsubscribe link");
    }
    return { ok: true, sms, emailSubject, emailBody, fromName: b.name, replyTo: b.replyTo ?? null };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

/** Brand name for an opt-out confirmation, falling back to a neutral phrase. */
export function brandNameOrNull(slug: string | null | undefined): string | null {
  return slug && hasBrand(slug) ? CLIENT_BRANDS[slug].name : null;
}
