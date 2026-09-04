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

/** Cloudflare Web Analytics, read per client from the zone we control. */
export type AnalyticsSource = {
  kind: "cloudflare";
  /** Zone id for the client's domain, from the Cloudflare dashboard overview. */
  zoneId?: string;
  /** Env var holding the API token (Zone > Analytics: Read). */
  tokenEnv: string;
};

export type ClientConfig = {
  brand: {
    name: string; initials: string; site: string;
    kicker: string; headline: string; subhead: string;
  };
  theme: Record<string, string>;
  types: Record<string, { label: string; color: string }>;
  sources: ContentSource[];
  /** Optional: traffic source. Omit and the dashboard shows an honest pending state. */
  analytics?: AnalyticsSource;
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
    // Hero's DNS runs on Cloudflare nameservers, so the zone is in Wing's own
    // Cloudflare account and its analytics are readable with a scoped token.
    // (A site fronted by a registrar's CDN is not comparable: that is not a
    // zone we hold, so this source only works for zones in Wing's account.)
    analytics: { kind: "cloudflare", tokenEnv: "CLOUDFLARE_API_TOKEN" },
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
    // Jack's call 2026-09-03: no "Not connected yet" section for this client. An
    // empty list hides the whole section rather than printing an empty card.
    // What is still unmeasured for Hero's -- Cloudflare Web Analytics, Search
    // Console, and calls/form leads -- is tracked in the vault, not on the page
    // the client reads. Other clients keep theirs; this is per-client, not a
    // change to the engine.
    pendingMetrics: [],
  },

  // ── Jackson Roofing ────────────────────────────────────────────────────────
  // Chris Jackson, Plano. Family-run since 2000, residential and commercial
  // roofing across North DFW. Rebuilt 2026-09-04 at Jack's direction after the
  // account came back.
  //
  // Their site is GoDaddy Managed WordPress, so content comes from the WP REST
  // API rather than a repo we own. That is the better source anyway: `date` on
  // a WP post is the true publish time, where a repo only tells us when a file
  // first appeared.
  "jackson-roofing": {
    brand: {
      name: "Jackson Roofing",
      initials: "JR",
      site: "https://jacksonroofingco.com",
      kicker: "Marketing dashboard",
      headline: "Everything Wing Digital is building for Jackson Roofing",
      subhead:
        "A live record of the pages and posts running on your site. Click anything to open it on the real site.",
    },
    theme: {
      accent: "#d98324", accent2: "#f0a95c",
      accent_bg: "rgba(217,131,36,.13)", accent_glow: "rgba(217,131,36,.20)",
      accent_light: "#a35c12", accent2_light: "#c97c28",
      accent_bg_light: "rgba(163,92,18,.09)", accent_glow_light: "rgba(163,92,18,.13)",
      mark_bg: "#1c2b3a", mark_fg: "#ffffff",
    },
    types: {
      blog: { label: "Blog post", color: "#4a86e8" },
      service: { label: "Service page", color: "#c9384a" },
      city: { label: "City page", color: "#d9903c" },
      other: { label: "Other", color: "#7a8ba3" },
    },
    sources: [
      {
        kind: "wp_api",
        site: "https://jacksonroofingco.com",
        postType: "blog",
        pageType: "service",
      },
    ],
    // No analytics source claimed. Their DNS is not on Wing's Cloudflare
    // account, so there is no zone we can read. The dashboard shows an honest
    // pending state rather than a fabricated number.
    pageGroups: [
      { group: "Blog posts live on your site", types: ["blog"] },
      { group: "Service and city pages", types: ["service", "city"] },
    ],
    outreach: {
      intro:
        "Everything we send out under your name, and what is not running yet.",
      channels: [
        { name: "Email campaigns", icon: "mail", types: [], state: "not_connected",
          note: "Nothing is being emailed under your name. The sending domain was never authenticated, so this stays off until it is." },
        { name: "Google Business posts", icon: "star", types: [], state: "needs_access",
          note: "Ready to run as soon as we have manager access to your Google Business Profile." },
        { name: "Facebook and Instagram", icon: "share", types: [], state: "needs_access",
          note: "Not connected. We would need access to your pages before we could post or report on them." },
        { name: "Review requests", icon: "chat", types: [], state: "not_connected",
          note: "No review request system is wired up yet. This is the fastest lever once the Google profile is connected." },
      ],
    },
    // Stated plainly rather than shown as zero. A blank number on a client
    // dashboard reads as "you did nothing for me", which is the opposite of
    // the truth when the real answer is "this is not connected yet".
    pendingMetrics: [
      { name: "Website traffic", why: "Your DNS is not on our Cloudflare account, so we cannot read visit counts yet.", state: "needs_access" },
      { name: "Search rankings", why: "Search Console access would let us show which searches are finding you.", state: "needs_access" },
      { name: "Calls and form leads", why: "No call tracking or form capture is wired up yet.", state: "not_connected" },
    ],
  },
};
