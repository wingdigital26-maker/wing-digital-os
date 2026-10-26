// The day 0 to 14 onboarding checklist every new client gets. Client-safe.
// Drawn from the vault's client-onboarding SOP and the website handoff rules,
// trimmed to the steps a person has to tick. Edit here to change it for everyone.

export type OnboardingItem = { key: string; day: number; who: string; text: string };

export const ONBOARDING: OnboardingItem[] = [
  { key: "kickoff", day: 0, who: "Jack", text: "Kickoff call done, notes saved to the client page" },
  { key: "invoice", day: 0, who: "Jack", text: "First invoice sent and billing set to due" },
  { key: "vault", day: 0, who: "Jack", text: "Client page created in the vault (wiki/clients) with the Sentinel Config" },
  { key: "access", day: 1, who: "Jack", text: "Logins collected: domain, Google Business Profile, site host" },
  { key: "assets", day: 2, who: "Dylan", text: "Logo, 10 or more real job photos and service list received" },
  { key: "roofcommand", day: 2, who: "Jack", text: "Roof Command account set up (roofers only)" },
  { key: "brief", day: 3, who: "Jack", text: "Website brief written and sent to Pansh (if a site is in the deal)" },
  { key: "seo", day: 5, who: "Jack", text: "SEO package done: keywords, meta, GBP content, schema" },
  { key: "content", day: 7, who: "Jack", text: "Content engine configured, first post drafted and approved" },
  { key: "sentinel", day: 7, who: "Jack", text: "Sentinel daily check running and the first health page written" },
  { key: "checkin1", day: 7, who: "Dylan", text: "First weekly check-in call with the client" },
  { key: "site", day: 10, who: "Pansh", text: "Website delivered and passed the handoff standard" },
  { key: "dashboard", day: 12, who: "Jack", text: "Client dashboard link sent" },
  { key: "review", day: 14, who: "Dylan", text: "Day 14 review call: happy, any problems logged" },
];
