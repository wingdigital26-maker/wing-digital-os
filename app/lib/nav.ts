// ── The ONE navigation tree ──────────────────────────────────────────────────
// Single source of truth for the OS nav. Consumed by:
//   - app/page.tsx            (the "/" shell: sidebar groups + sub-tab strip)
//   - components/SectionChrome.tsx (routed-page header: section pills + "All sections" menu)
//   - components/CommandPalette.tsx (Ctrl+K registry: shell views + routed pages)
// Data-only on purpose: icons are React components, so the id->icon map lives
// in page.tsx (NAV_ICONS) and this file stays importable from anywhere.

export type NavSub = {
  id: string;
  label: string;
  /** Extra fuzzy-match fodder for the command palette. */
  keywords?: string;
};

export type NavGroupDef = {
  id: string;
  label: string;
  /** Plain-English one-liner shown as the hover tooltip on the sidebar button. */
  hint: string;
  subs: NavSub[];
};

export const NAV_TREE: NavGroupDef[] = [
  {
    id: "command", label: "Command Center",
    hint: "Today's numbers, briefing, and quick actions",
    subs: [
      { id: "command", label: "Overview", keywords: "home dashboard" },
      // Today (2026-09-05): the attention-first board — what needs Jack now,
      // aggregated from the OS's own APIs with honest per-source states.
      { id: "today", label: "Today", keywords: "agenda daily" },
      { id: "personal", label: "Personal" },
    ],
  },
  {
    id: "clients", label: "Clients",
    hint: "Your clients, new leads, and storm alerts",
    // 2026-09-15 (Jack): trimmed to just Clients and Dashboards. Potential
    // clients, Sonar Leads and Storm Response were dropped from the nav (their
    // components stay on disk and are still reachable via the command palette /
    // deep links, just not on the rail).
    subs: [
      { id: "clients", label: "Clients" },
      // Dashboards (2026-09-13): the OS index of every built client dashboard,
      // opened inside the OS. Routed page (see EXTERNAL_SUB_LINKS).
      { id: "dashboards", label: "Dashboards", keywords: "reporting client dashboard" },
    ],
  },
  {
    // ONE CRM surface. Inbox, Outbound and Pipeline were merged 2026-08-30:
    // three tabs for one workflow meant the source post lived in one tab and
    // the draft in another, so a draft had nothing to click through to.
    // Pipeline's data (Wing's own book of business, the GoHighLevel
    // replacement) is folded in as a category, never deleted.
    id: "crm", label: "CRM",
    hint: "Every email going out, the replies coming back, and who to call",
    // 2026-09-22 (Jack): texting is gone from the CRM entirely, and so are the
    // Activity and Contacts tabs. His words: "This should be like the call
    // room, basically: call room plus people that are potentially going to
    // email." So the CRM is now four tabs and nothing else -- the outgoing
    // email feed (the landing), the replies, the people who could be emailed,
    // and the call room folded in beside them. Activity was a second, weaker
    // view of the same sends the Email tab now owns; Contacts (CrmWorkspace)
    // was the everything-drawer. Both components stay on disk, off the rail.
    subs: [
      // Email: the live feed of every email going out -- sent, queued,
      // scheduled, failed -- with a reading pane. First = the CRM's default
      // landing, because email is the majority of this CRM.
      { id: "email", label: "Email", keywords: "messaging outgoing sent queue deliverability" },
      // Reply Inbox left the rail 2026-09-22: the Email hub carries Replies as
      // its second view, sharing the feed's list and reading pane, so a
      // top-level tab drew the same board twice. "replies" aliases to Email.
      // People (2026-09-22): the lean list of who is in line for an email.
      // Call-room ergonomics, not the old everything-grid.
      { id: "people", label: "People", keywords: "contacts leads prospects email list" },
      // Call Room moved here from Automations (2026-09-22) so "call room plus
      // people that are potentially going to email" is one section, not two.
      // /calls stays a routed page -- caller-role users still land there.
      { id: "calls", label: "Call Room", keywords: "cold calling dialer" },
    ],
  },
  {
    // Automations (2026-09-04): sequences and automations out of the CRM tab
    // and onto the left rail as their own thing. Every sub is a routed page
    // (see EXTERNAL_SUB_LINKS), so clicking the group icon navigates too.
    id: "automate", label: "Automations",
    hint: "Automations and email sequences",
    // Call Room left this group 2026-09-22 -- it sits in the CRM now, next to
    // the people it dials.
    subs: [
      { id: "automations", label: "Automations", keywords: "workflows" },
      { id: "sequences", label: "Sequences" },
    ],
  },
  {
    // Marketing (2026-09-05): the client-facing growth surfaces. Social is a
    // draft/schedule board that never auto-publishes; Reviews queues a
    // review request after a job closes and tracks the star ratings that
    // come back. Both are draft-only, same as the rest of the OS.
    id: "marketing", label: "Marketing",
    hint: "Social posts, reviews, and the SEO content feed",
    // 2026-09-15 (Jack): SEO and Social flipped so SEO leads.
    subs: [
      // SEO (2026-09-05, Jack): every page/post shipped on client sites, one
      // feed, read from the same public sources their dashboards use.
      { id: "seo", label: "SEO", keywords: "blog posts content pages published" },
      { id: "social", label: "Social", keywords: "posts schedule" },
      { id: "reviews", label: "Reviews" },
      // Customers deleted from the nav 2026-09-22 (Jack: "for marketing, get
      // rid of the customers tab"). CustomersBoard stays on disk, unmounted.
    ],
  },
  {
    // One sub only. The section owns its own Calendar/Invoices tabs, so listing
    // them here too showed everything twice.
    // 2026-09-22 (Jack): "The calendar should only have invoices and payments.
    // Forget the calendar where everyone's available. Just delete it." The
    // month/week grid and the Availability panel behind the booking link are
    // gone; what is left is the money.
    id: "calendar", label: "Invoices",
    hint: "Invoices and payments",
    subs: [{ id: "calendar", label: "Invoices and payments", keywords: "invoices payments money billing stripe" }],
  },
  // School section removed 2026-09-01 (Jack: "get rid of the school schedule
  // completely"). Classes still show as the school lane on the Calendar; the
  // legacy alias below keeps old links landing there.
  {
    id: "agent", label: "Agents",
    hint: "What the automated agents are doing right now",
    subs: [{ id: "agent", label: "Mission Control", keywords: "agents" }],
  },
  {
    id: "intel", label: "Intel",
    hint: "Saved notes, competitor research, and activity history",
    subs: [
      { id: "knowledge", label: "Knowledge Base", keywords: "notes vault" },
      { id: "competitors", label: "Competitor Intel", keywords: "research" },
      // Activity Log removed from the nav 2026-09-04 (Jack). The component
      // stays on disk; the legacy alias below lands old links on the
      // Knowledge Base.
    ],
  },
];

// Views that existed before the 2026-08-30 restructure. Old deep links and any
// panel still dispatching the old id land on the merged view instead of a dead
// screen. Keep these entries; removing one silently breaks a bookmark.
export const LEGACY_VIEW_ALIAS: Record<string, string> = {
  // 2026-09-15: the "Everything" view (id "crm") became the "Contacts" tab
  // (id "contacts"). Old links and any panel dispatching the old ids land there.
  crm: "people",
  inbox: "people",
  pipeline: "people",
  money: "calendar",
  invoices: "calendar",
  // 2026-09-01 consolidation: School folded into Calendar, three email tabs
  // folded into the Email hub.
  school: "calendar",
  // 2026-09-04: the message ledger split by channel. Texts have their own tab.
  messaging: "email",
  deliverability: "email",
  // 2026-09-22: texting deleted from the CRM. Every text/SMS id lands on Email,
  // the surface that replaced it, rather than a dead screen.
  text: "email",
  messages: "email",
  sms: "email",
  // 2026-09-22: Activity was a second view of the sends Email now owns.
  activity: "email",
  // 2026-09-22: Contacts (the old "Everything" grid) collapsed into People.
  contacts: "people",
  // 2026-09-22: Replies is a view inside the Email hub now, not its own tab.
  replies: "email",
  // 2026-09-22: Marketing lost its Customers tab.
  customers: "clients",
};

// Sub-tabs that are real routed pages rather than in-shell views. Clicking one
// navigates instead of switching the mounted view. The os:navigate handler
// honors these too, so a panel dispatching "sequences" still lands somewhere.
export const EXTERNAL_SUB_LINKS: Record<string, string> = {
  // "automations", "sequences" and "calls" left this map 2026-09-05 (Jack:
  // clicking them must not drag into a second screen). Their LIST/Today
  // screens mount in-shell as keep-alive views; detail pages (a workflow, a
  // sequence editor, booked/callbacks/etc.) stay routed, and /calls remains a
  // standalone page because caller-role users land there directly.
  // Old Activity Log links land on the run history, its honest successor
  // (ActivityLog itself pointed users there). Was aliased to "knowledge",
  // which shares no content with it.
  log: "/automations/runs",
  // 2026-09-13: a routed section reached from its sidebar sub. /activity left
  // this map 2026-09-22 when the Activity tab was deleted; the page still
  // exists, but "activity" now aliases to Email (see LEGACY_VIEW_ALIAS).
  dashboards: "/dashboards",
};

// ── Routed pages ─────────────────────────────────────────────────────────────
// The canonical list of standalone routed pages under app/. Two consumers:
//   - SectionChrome's top switcher strip = entries with inStrip (routed
//     sections only; everything in-shell goes in its "All sections" menu).
//   - CommandPalette's "Page" entries = entries with inPalette !== false.
export type RoutedPage = {
  href: string;
  label: string;
  keywords?: string;
  /** Show as a pill in SectionChrome's top section switcher. */
  inStrip?: boolean;
  /** Set false to keep it out of the palette (Home is the view:command entry). */
  inPalette?: boolean;
};

export const ROUTED_PAGES: RoutedPage[] = [
  // "/" is a strip pill but never a palette page entry — the palette reaches
  // it through the shell views (view:command) instead.
  { href: "/", label: "Home", inStrip: true, inPalette: false },
  // The three section roots are inPalette:false — their shell VIEW entries
  // (view:calls etc.) cover the palette, so listing the page too showed every
  // one twice with identical labels.
  { href: "/calls", label: "Call Room", keywords: "cold calling dialer", inStrip: true, inPalette: false },
  { href: "/calls/booked", label: "Booked Calls", keywords: "appointments" },
  { href: "/calls/callbacks", label: "Callbacks" },
  { href: "/calls/schedule", label: "Call Schedule" },
  // /calls/list merged into the Call Room root (2026-09-15); the route now just
  // redirects, so it is off the strip and out of the palette.
  { href: "/calls/sources", label: "Call Sources" },
  // Admin-only (proxy.ts redirects non-admins to /calls). Kept out of the
  // command palette so a caller is never shown a door that only bounces them;
  // admins reach it from the "Manage callers" button in the Call Room header.
  { href: "/calls/team", label: "Call Team", inPalette: false },
  { href: "/sequences", label: "Sequences", inStrip: true, inPalette: false },
  { href: "/sequences/people", label: "Sequence People" },
  // /email dropped from the strip 2026-09-05: "Email" appeared twice in one
  // header pointing at two different screens. Composing now lives inside
  // CRM > Email (Compose pill); /email itself still works and cross-links.
  { href: "/email", label: "Email", keywords: "compose send" },
  { href: "/automations", label: "Automations", keywords: "workflows", inStrip: true, inPalette: false },
  { href: "/automations/forms", label: "Forms" },
  { href: "/automations/runs", label: "Automation Runs" },
  { href: "/automations/tasks", label: "Automation Tasks" },
  { href: "/automations/phone", label: "Phone Automations" },
  // The full-page fleet monitor. Same data as the shell's Mission Control view
  // but the complete read-only layout; was only reachable from watchdog
  // finding links before 2026-09-05.
  { href: "/mission", label: "Mission (full page)", keywords: "fleet monitor agents watchdog" },
  // 2026-09-13 swarm: client dashboards inside the OS, and the messaging
  // activity board (what emails/texts are going out).
  { href: "/dashboards", label: "Client Dashboards", keywords: "reporting clients dashboard" },
  { href: "/activity", label: "Messaging Activity", keywords: "emails texts sent going out outbound queue" },
];

/** Routed sections shown in SectionChrome's top switcher strip. */
export const STRIP_SECTIONS: { href: string; label: string }[] =
  ROUTED_PAGES.filter(p => p.inStrip).map(({ href, label }) => ({ href, label }));

/** Routed pages listed in the command palette. */
export const PALETTE_ROUTED_PAGES: { href: string; label: string; keywords?: string }[] =
  ROUTED_PAGES.filter(p => p.inPalette !== false).map(({ href, label, keywords }) => ({ href, label, keywords }));

/** Flatten the nav tree into palette shell-view entries: every sub with its
 *  group label. Sub ids in EXTERNAL_SUB_LINKS are still included — the palette
 *  dispatches them via os:navigate and the shell's handler redirects itself. */
export function flattenShellViews(): { id: string; label: string; group: string; keywords?: string }[] {
  return NAV_TREE.flatMap(g => g.subs.map(s => ({ id: s.id, label: s.label, group: g.label, keywords: s.keywords })));
}

/** The nav tree with groups that live INSIDE "/" only — routed-page subs
 *  (Automations group) filtered out. SectionChrome's "All sections" menu links
 *  each remaining sub as "/#view=<id>"; the routed sections already have their
 *  own strip pills, so listing them here would show everything twice. */
export function shellGroups(): { label: string; subs: { id: string; label: string }[] }[] {
  // These three became in-shell views on 2026-09-05, but the routed sections
  // keep their strip pills, so the menu still skips them to avoid listing the
  // same destination twice in one header.
  const STRIP_COVERED = new Set(["automations", "sequences", "calls"]);
  return NAV_TREE
    .map(g => ({
      label: g.label,
      subs: g.subs
        .filter(s => !(s.id in EXTERNAL_SUB_LINKS) && !STRIP_COVERED.has(s.id))
        .map(({ id, label }) => ({ id, label })),
    }))
    .filter(g => g.subs.length > 0);
}
