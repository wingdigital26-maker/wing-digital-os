// ── Client dashboard registry ────────────────────────────────────────────────
// ONE entry per client. Adding a new client to the live dashboard system means
// adding an object here and nothing else: no new route, no new deploy pipeline,
// no per-client HTML. The page at /dashboards/live.html?c=<slug> and the API at
// /api/dashboard/<slug> both read this.
//
// Every source must be PUBLIC (no credentials) so a client's dashboard can never
// break on a rotated key and no secret can leak through the endpoint.
//
// Source kinds:
//   wp_api      - WordPress REST. Best accuracy: `date` is the true publish time.
//   github_repo - Public repo. First commit that ADDED a file = its publish date.
//   sitemap     - Universal fallback. NOTE lastmod is last-MODIFIED, not first
//                 published, so prefer github_repo for a static site we own.

export type ContentSource = {
  kind: "wp_api" | "github_repo" | "sitemap";
  site?: string;
  repo?: string;            // "owner/name" for github_repo
  postType?: string;        // type label applied to WP posts
  pageType?: string;        // type label applied to WP pages (omit to skip pages)
  globs?: Array<{ dir: string; type: string; skip?: string[] }>;
};

export type ClientConfig = {
  brand: {
    name: string; initials: string; site: string;
    kicker: string; headline: string; subhead: string;
  };
  theme: Record<string, string>;
  types: Record<string, { label: string; color: string }>;
  sources: ContentSource[];
  pageGroups?: Array<{ group: string; types: string[] }>;
  outreach?: {
    intro: string;
    channels: Array<{ name: string; icon: string; types: string[]; state: string; note: string }>;
  };
  pendingMetrics?: Array<{ name: string; why: string; state: string }>;
};

export const CLIENTS: Record<string, ClientConfig> = {
  "heros-junk": {
    brand: {
      name: "Hero's Junk Removal",
      initials: "HJ",
      site: "https://herosjunkremovaltx.com",
      kicker: "Marketing dashboard",
      headline: "Everything Wing Digital is building for Hero's Junk Removal",
      subhead: "A live record of the pages and posts running on your site. Click anything to open it on the real site.",
    },
    // Real brand, confirmed on the live site 2026-08-27: navy header, red CTA.
    // Their stylesheet's variable NAMES say teal/green and are misleading.
    theme: {
      accent: "#e2586a", accent2: "#f08fa0",
      accent_bg: "rgba(226,88,106,.13)", accent_glow: "rgba(226,88,106,.20)",
      accent_light: "#b22234", accent2_light: "#d9455c",
      accent_bg_light: "rgba(178,34,52,.08)", accent_glow_light: "rgba(178,34,52,.12)",
      mark_bg: "#0a2342", mark_fg: "#ffffff",
    },
    types: {
      blog: { label: "Blog post", color: "#4a86e8" },
      service: { label: "Service page", color: "#c9384a" },
      city: { label: "City page", color: "#d9903c" },
      other: { label: "Other", color: "#7a8ba3" },
    },
    sources: [
      {
        kind: "github_repo",
        repo: "wingdigital26-maker/heros-junk-removal",
        site: "https://herosjunkremovaltx.com",
        globs: [
          { dir: "blog", type: "blog", skip: ["index.html"] },
          { dir: "services", type: "service", skip: ["index.html"] },
        ],
      },
    ],
    pageGroups: [
      { group: "Blog posts live on your site", types: ["blog"] },
      { group: "Service pages", types: ["service", "city"] },
    ],
    // HARD RULE: no outbound email for this client, ever. The email card must
    // read as deliberate, never as broken -- "not connected" there would look
    // like a service they pay for that is failing.
    outreach: {
      intro: "Everything we send out under your name, and what is not running yet. Your plan is search-led, so nothing is being emailed on your behalf.",
      channels: [
        { name: "Email campaigns", icon: "mail", types: [], state: "not_in_plan",
          note: "By design. Your plan wins work through search, not inbox outreach, so we do not send email under your name." },
        { name: "Google Business posts", icon: "star", types: [], state: "needs_access",
          note: "Ready to run as soon as we have manager access to your Google Business Profile." },
        { name: "Facebook and Instagram", icon: "share", types: [], state: "needs_access",
          note: "Not connected. We would need access to your pages before we could post or report on them." },
        { name: "Review requests", icon: "chat", types: [], state: "not_connected",
          note: "No review request system is wired up yet. This is the fastest lever once the Google profile is connected." },
      ],
    },
    pendingMetrics: [
      { name: "Website visits", why: "Cloudflare Web Analytics needs to be switched on for this site. Once it is, visits appear here automatically", state: "needs access" },
      { name: "Google Search clicks and impressions", why: "Needs Search Console access for herosjunkremovaltx.com", state: "needs access" },
      { name: "Calls and form leads", why: "The contact form does not report back to us yet, so no lead count here would be trustworthy", state: "not connected" },
    ],
  },

  "jackson-roofing": {
    brand: {
      name: "Jackson Roofing",
      initials: "JR",
      site: "https://jacksonroofingco.com",
      kicker: "Marketing dashboard",
      headline: "Everything Wing Digital is building for Jackson Roofing",
      subhead: "A live record of the content, pages and search work running on your site. Click anything to open it.",
    },
    // Real brand read off the live site 2026-08-27: near-black + electric blue.
    // The blue is too light for text on white, so light mode uses the darker tone.
    theme: {
      accent: "#1bc0ff", accent2: "#7ddcff",
      accent_bg: "rgba(27,192,255,.12)", accent_glow: "rgba(27,192,255,.20)",
      accent_light: "#0b7fa6", accent2_light: "#1bc0ff",
      accent_bg_light: "rgba(11,127,166,.09)", accent_glow_light: "rgba(11,127,166,.13)",
      mark_bg: "#0a0a0a", mark_fg: "#1bc0ff",
    },
    types: {
      blog: { label: "Blog post", color: "#1bc0ff" },
      service: { label: "Service page", color: "#8b7cf6" },
      city: { label: "City page", color: "#5b8def" },
      gbp: { label: "Google post", color: "#2fbf8f" },
      other: { label: "Other", color: "#7b8794" },
    },
    // WordPress REST replaces the old local state file. That file was only as
    // fresh as the last script run on Jack's PC and had gone 18 days stale; this
    // reads the site itself, so the dashboard can never drift from reality.
    sources: [
      {
        kind: "wp_api",
        site: "https://jacksonroofingco.com",
        postType: "blog",
        pageType: "service",
      },
    ],
    pageGroups: [
      { group: "Blog posts live on your site", types: ["blog"] },
      { group: "Service and city pages", types: ["service", "city"] },
    ],
    outreach: {
      intro: "Everything we send out under your name, and what is not running yet.",
      channels: [
        { name: "Google Business posts", icon: "star", types: ["gbp"], state: "not_connected",
          note: "Google Business posting is not connected to this dashboard yet. It needs manager access to your profile." },
        { name: "Review requests", icon: "chat", types: [], state: "not_connected",
          note: "Review requests went out through the old CRM, which was retired on 2026-08-22. Nothing is sending until a replacement is chosen." },
        { name: "Email campaigns", icon: "mail", types: [], state: "not_connected",
          note: "No email is being sent for you right now. This needs a CRM to replace the retired one before anything goes out." },
        { name: "Facebook and Instagram", icon: "share", types: [], state: "needs_access",
          note: "Not connected. We would need manager access to your pages before we could post or report on them." },
      ],
    },
    pendingMetrics: [
      { name: "Website visits", why: "A Facebook Pixel is running on the site but no visit-analytics source is connected to this dashboard yet", state: "needs access" },
      { name: "Google Search clicks and impressions", why: "Needs Search Console access for jacksonroofingco.com", state: "needs access" },
      { name: "Calls and form leads", why: "The old CRM was retired on 2026-08-22. No lead source is connected to this dashboard yet", state: "not connected" },
    ],
  },
};
