// Static, read-only seed of GBP (Google Business Profile) staged post copy.
// Draft-and-stage only -- there is no accessible free GBP posting API for a
// small operator (see C:\Users\wjack\seo-factory\_seo-research\specs\
// gbp-post-generator.md), so this is copy a human copies and pastes into the
// Business Profile app or business.google.com themselves. Nothing here posts
// anything, calls any API, or writes to any database.
//
// Content is transcribed verbatim (types, CTA buttons, captions) from the
// approved sample calendar at
// C:\Users\wjack\seo-factory\_seo-research\assets\gbp-calendar-qa.md, which
// was already written to respect each client's hard rules -- no pricing for
// Hero's, no diagnose/treat/cure for Renewal, no jacksonroofingco.com for
// Jackson, no phone numbers in body copy, no em dashes, no exclamation marks.
// This file only reshapes that markdown into typed rows; it invents nothing.

export type GbpPostType = "update" | "offer" | "event" | "product";

export const GBP_TYPE_LABEL: Record<GbpPostType, string> = {
  update: "Update",
  offer: "Offer",
  event: "Event",
  product: "Service",
};

export type GbpDraft = {
  id: string;
  client_slug: string;
  client_name: string;
  week: number;
  type: GbpPostType;
  cta_button: string;
  caption: string;
  needs_photo: boolean;
};

export const GBP_DRAFTS: GbpDraft[] = [
  // ── Hero's Junk Removal ── no pricing, no trailer/capacity talk, no reselling, no phone CTAs
  {
    id: "heros-junk-w1",
    client_slug: "heros-junk",
    client_name: "Hero's Junk Removal",
    week: 1,
    type: "update",
    cta_button: "Learn more",
    caption:
      "Fall cleanout season is here. If you have furniture, yard waste, or general junk piling up before the holidays, we handle the loading and hauling so you do not have to. Contact us to get on the schedule this week.",
    needs_photo: true,
  },
  {
    id: "heros-junk-w2",
    client_slug: "heros-junk",
    client_name: "Hero's Junk Removal",
    week: 2,
    type: "product",
    cta_button: "Book online",
    caption:
      "Old mattress taking up space? We remove mattresses and box springs same week in most cases, no trailer trips or dump runs on your end. Book online and we will handle the rest.",
    needs_photo: true,
  },
  {
    id: "heros-junk-w3",
    client_slug: "heros-junk",
    client_name: "Hero's Junk Removal",
    week: 3,
    type: "update",
    cta_button: "Learn more",
    caption:
      "A cluttered garage is one of the most common calls we get this time of year. Whether it is old furniture, boxes, or stuff you have been meaning to toss for months, we clear it in a single visit. Contact us to see if same-week service is open.",
    needs_photo: true,
  },
  {
    id: "heros-junk-w4",
    client_slug: "heros-junk",
    client_name: "Hero's Junk Removal",
    week: 4,
    type: "offer",
    cta_button: "Book online",
    caption:
      "We are holding same-week pickup slots open through the end of the month for anyone doing a fall cleanout. No obligation to book until you confirm a time that works. Book online to grab a spot.",
    needs_photo: true,
  },

  // ── Jackson Roofing ── never jacksonroofingco.com, no phone CTAs, owned site only
  {
    id: "jackson-roofing-w1",
    client_slug: "jackson-roofing",
    client_name: "Jackson Roofing",
    week: 1,
    type: "update",
    cta_button: "Learn more",
    caption:
      "DFW storm season means more homeowners are asking how to tell if their roof actually needs attention after a hailstorm. We put together a plain-language guide on what to look for on our site. Contact us if you want a second set of eyes on yours.",
    needs_photo: true,
  },
  {
    id: "jackson-roofing-w2",
    client_slug: "jackson-roofing",
    client_name: "Jackson Roofing",
    week: 2,
    type: "product",
    cta_button: "Book online",
    caption:
      "Asphalt shingle repair is one of the most common calls we get after a wind or hail event. If a section is lifted, cracked, or missing granules, it is usually fixable without a full replacement. Book online for an inspection.",
    needs_photo: true,
  },
  {
    id: "jackson-roofing-w3",
    client_slug: "jackson-roofing",
    client_name: "Jackson Roofing",
    week: 3,
    type: "event",
    cta_button: "Learn more",
    caption:
      "We are tracking this year's storm activity across the DFW area through our own hail-mapping tool, so homeowners can check their address against real storm history instead of guessing. Contact us to see what has hit your neighborhood.",
    needs_photo: true,
  },
  {
    id: "jackson-roofing-w4",
    client_slug: "jackson-roofing",
    client_name: "Jackson Roofing",
    week: 4,
    type: "update",
    cta_button: "Learn more",
    caption:
      "A roof inspection after a storm is worth doing even if nothing looks obviously wrong from the ground. Small issues found early are almost always cheaper to fix than the same issue after another season of weather. Contact us to schedule a look.",
    needs_photo: true,
  },

  // ── Renewal Health ── no diagnose/treat/cure (YMYL), no phone CTAs, no fabricated claims
  {
    id: "renewal-health-w1",
    client_slug: "renewal-health",
    client_name: "Renewal Health",
    week: 1,
    type: "update",
    cta_button: "Learn more",
    caption:
      "This week's blog covers a few simple habits that support day-to-day energy and recovery. It is written to be practical, not clinical. Contact us if you want to talk through what might fit your routine.",
    needs_photo: true,
  },
  {
    id: "renewal-health-w2",
    client_slug: "renewal-health",
    client_name: "Renewal Health",
    week: 2,
    type: "product",
    cta_button: "Book online",
    caption:
      "A wellness consultation is a good starting point if you are not sure what to prioritize for your health goals right now. We take time to understand your history before suggesting anything. Book online to get on the calendar.",
    needs_photo: true,
  },
  {
    id: "renewal-health-w3",
    client_slug: "renewal-health",
    client_name: "Renewal Health",
    week: 3,
    type: "update",
    cta_button: "Learn more",
    caption:
      "Small, consistent changes tend to matter more than big overhauls when it comes to long-term wellness. This week we wrote about a few of the ones our clients ask about most. Contact us with questions on what applies to you.",
    needs_photo: true,
  },
  {
    id: "renewal-health-w4",
    client_slug: "renewal-health",
    client_name: "Renewal Health",
    week: 4,
    type: "event",
    cta_button: "Learn more",
    caption:
      "As the season changes, a lot of people notice shifts in sleep, energy, and stress levels. We put together some seasonal wellness guidance on our site. Contact us if you would like to set up time to discuss your own routine.",
    needs_photo: true,
  },
];

// Ordered, de-duplicated list of clients that actually have drafts, so the
// board never invents a client with nothing to show.
export const GBP_CLIENTS: { slug: string; name: string }[] = (() => {
  const seen = new Set<string>();
  const out: { slug: string; name: string }[] = [];
  for (const d of GBP_DRAFTS) {
    if (seen.has(d.client_slug)) continue;
    seen.add(d.client_slug);
    out.push({ slug: d.client_slug, name: d.client_name });
  }
  return out;
})();
