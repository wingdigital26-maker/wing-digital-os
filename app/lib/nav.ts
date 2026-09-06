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
    subs: [
      { id: "clients", label: "Clients" },
      // Potential clients (2026-09-04): paste a website, the OS researches it
      // and files it as a prospect to work toward signing.
      { id: "potential", label: "Potential clients", keywords: "prospects" },
      { id: "sonar", label: "Sonar Leads", keywords: "leads" },
      // Storm Response (2026-09-01): SPC hail events near DFW with the drafts
      // Wing WOULD fire (FB post, ad plan, Nextdoor). Demo build: draft-only,
      // nothing posts, nothing spends.
      { id: "storms", label: "Storm Response", keywords: "hail" },
    ],
  },
  {
    // ONE CRM surface. Inbox, Outbound and Pipeline were merged 2026-08-30:
    // three tabs for one workflow meant the source post lived in one tab and
    // the draft in another, so a draft had nothing to click through to.
    // Pipeline's data (Wing's own book of business, the GoHighLevel
    // replacement) is folded in as a category, never deleted.
    id: "crm", label: "CRM",
    hint: "Contacts, outreach emails, texts and replies",
    // Exactly four tabs (2026-09-04, Jack): Everything, Email, Text, Reply
    // Inbox. Sequences and Automations moved to their own group below.
    subs: [
      { id: "crm", label: "Everything", keywords: "contacts pipeline inbox outbound" },
      // Email: the automated-send queue, the email side of the message
      // ledger, and email health as internal pills. See EmailHub.tsx.
      { id: "email", label: "Email", keywords: "messaging deliverability" },
      // Text: the SMS conversations and the texting-line status, on their
      // own. Same MessagesBoard, locked to the sms channel.
      { id: "text", label: "Text", keywords: "sms messages" },
      // Reply Inbox (2026-09-01): every inbound cold-email reply, hot first,
      // with the thread and an editable draft. Read/draft only; never sends.
      { id: "replies", label: "Reply Inbox", keywords: "inbound" },
    ],
  },
  {
    // Automations (2026-09-04): sequences and automations out of the CRM tab
    // and onto the left rail as their own thing. Every sub is a routed page
    // (see EXTERNAL_SUB_LINKS), so clicking the group icon navigates too.
    id: "automate", label: "Automations",
    hint: "Automations, email sequences, and the call room",
    subs: [
      { id: "automations", label: "Automations", keywords: "workflows" },
      { id: "sequences", label: "Sequences" },
      { id: "calls", label: "Call Room", keywords: "cold calling dialer" },
    ],
  },
  {
    // Marketing (2026-09-05): the client-facing growth surfaces. Social is a
    // draft/schedule board that never auto-publishes; Reviews queues a
    // review request after a job closes and tracks the star ratings that
    // come back. Both are draft-only, same as the rest of the OS.
    id: "marketing", label: "Marketing",
    hint: "Social posts to schedule and reviews to request",
    subs: [
      { id: "social", label: "Social", keywords: "posts schedule" },
      { id: "reviews", label: "Reviews" },
      { id: "customers", label: "Customers" },
    ],
  },
  {
    // One sub only. The section owns its own Calendar/Invoices tabs, so listing
    // them here too showed everything twice.
    id: "calendar", label: "Calendar",
    hint: "Your schedule, plus invoices one tab over",
    subs: [{ id: "calendar", label: "Calendar", keywords: "schedule invoices" }],
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
  inbox: "crm",
  pipeline: "crm",
  money: "calendar",
  invoices: "calendar",
  // 2026-09-01 consolidation: School folded into Calendar, three email tabs
  // folded into the Email hub.
  school: "calendar",
  // 2026-09-04: the message ledger split by channel. Texts have their own tab.
  messaging: "email",
  messages: "text",
  deliverability: "email",
};

// Sub-tabs that are real routed pages rather than in-shell views. Clicking one
// navigates instead of switching the mounted view. The os:navigate handler
// honors these too, so a panel dispatching "sequences" still lands somewhere.
export const EXTERNAL_SUB_LINKS: Record<string, string> = {
  sequences: "/sequences",
  automations: "/automations",
  calls: "/calls",
  // Old Activity Log links land on the run history, its honest successor
  // (ActivityLog itself pointed users there). Was aliased to "knowledge",
  // which shares no content with it.
  log: "/automations/runs",
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
  { href: "/calls", label: "Call Room", keywords: "cold calling dialer", inStrip: true },
  { href: "/calls/booked", label: "Booked Calls", keywords: "appointments" },
  { href: "/calls/callbacks", label: "Callbacks" },
  { href: "/calls/schedule", label: "Call Schedule" },
  { href: "/calls/list", label: "Call List" },
  { href: "/calls/sources", label: "Call Sources" },
  { href: "/calls/team", label: "Call Team" },
  { href: "/sequences", label: "Sequences", inStrip: true },
  { href: "/sequences/people", label: "Sequence People" },
  // /email dropped from the strip 2026-09-05: "Email" appeared twice in one
  // header pointing at two different screens. Composing now lives inside
  // CRM > Email (Compose pill); /email itself still works and cross-links.
  { href: "/email", label: "Email", keywords: "compose send" },
  { href: "/automations", label: "Automations", keywords: "workflows", inStrip: true },
  { href: "/automations/forms", label: "Forms" },
  { href: "/automations/runs", label: "Automation Runs" },
  { href: "/automations/tasks", label: "Automation Tasks" },
  { href: "/automations/phone", label: "Phone Automations" },
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
  return NAV_TREE
    .map(g => ({ label: g.label, subs: g.subs.filter(s => !(s.id in EXTERNAL_SUB_LINKS)).map(({ id, label }) => ({ id, label })) }))
    .filter(g => g.subs.length > 0);
}
