# FRONTIER.md - /visual loop on the Wing OS (route kit, pick = .visual/pick.png)

Broken first, then the look. Evidence = `.visual/round-0/` (1440 + 375, light) and a
console/network/overflow probe. One item per round, max 4 rounds per item.

| # | status | item (specific, visible) | why / evidence | rounds |
|---|---|---|---|---|
| 1 | DONE | /activity (Messaging Activity) crashes to "This page couldn't load" | pageerror `Cannot read properties of undefined (reading 'note')`, ActivityBoard.tsx:209; /api/messaging no longer returns `texts` | 1 |
| 2 | DONE | Marketing > SEO says "0 shown" while the sites have 110 live pages | /api/dashboard/<slug> returns 82 + 28 items from cache, but a no-store request hits GitHub unauthenticated (60/h, exhausted) and `if (!r.ok) continue` returns an empty list with no failure flagged; SeoBoard also reads `sourcesFailed` as a number but it is an array. Same bug empties client dashboards | 1 |
| 3 | DONE | Deep link /#view=personal lands on Overview instead of Personal | page.tsx role gate: `hiddenViews` has "personal" until /api/me answers, so the effect bounces the deep-linked view to command | 1 |
| 4 | DONE | Agents view shows a green dot + "All systems nominal" directly under a red "Something needs attention: 5 problems" banner | contradictory status and a live-style dot (hard rule); MissionOps.tsx:329 | 1 |
| 5 | DONE | Today board lists unconnected things: "Google Calendar: not configured (GOOGLE_CALENDAR_ICS_URL)", "Stripe: not configured (STRIPE_SECRET_KEY)", and an orange "engine currently has NO live delivery step" paragraph | hard rule: dashboards show only what works; TodayBoard.tsx:586 | 1 |
| 6 | DONE | CRM > Email at 375: message cards and the source caption run past the right edge | visual_app overflow: 1008 elements past the edge on /#view=email 375; screenshot shows clipped card text | 1 |
| 7 | DONE | Pill filter groups wrap into tall rounded blobs at 375 (CRM Email filters, Call Room status/tier/sheet pills) | screenshots _hash_view-email-375, calls-375 | 1 |
| 8 | DONE | Call Room counts glued to labels: "Booked2", "Not called yet1076", "Tier A196", "Everything1078" | _hash_view-calls-1440 | 1 |
| 9 | DONE | Home does not show leads or calls: Overview has only "$1,250 making this month" + "3 active clients", then an onboarding card | THE ONE CONVERSION needs today's leads + calls + money at a glance, one click to act | 1 |
| 10 | DONE | Content column jumps: Call Room and SEO render as a centered narrow column (left edge 110-200px right of the pill tabs) while every other board is full width | _hash_view-calls-1440, _hash_view-seo-1440 vs clients/email | 1 |
| 11 | DONE | Clients board uses emoji as icons (office, house, phone, envelope) | _hash_view-clients-1440; hard rule J4 | 1 |
| 12 | DONE | Agents ops map: node names overflow their circles ("PROSPECTO", "REPLY-TRI", "CHRONICLE") | _hash_view-agent-1440 | 1 |
| 13 | DONE | Calendar header says "$3,750.00" for September while the tiles below say Outstanding $0.00 / Paid $0.00 | the header sums unsent drafts; unlabeled, reads as money due | 1 |
| 14 | DONE | Knowledge 3D graph throws `reading 'tick'` intermittently; /mission hydration mismatch intermittently | probe at 1440/375 | 1 |
| 15 | DONE | Dark theme (Obsidian) sweep of every view for contrast and pre-V2 leftovers | not yet captured | 1 |
| 16 | DONE | Call Room lead cards use a heavy near-black 1px outline (pre-V2) instead of the soft v2-card surface | .visual/round-7/_hash_view-calls-1440 | 1 |
| 17 | DONE | Em dashes left in visible copy across boards (and as empty-cell placeholders) | hard rule J3; grep of app/components | 1 |
| 18 | OPEN | Home has no single filled primary action (judge A): e.g. a Wing-blue 'Call next lead' on the Calls tile | judge 2026-09-28, round-16 | 0 |
| 19 | OPEN | Floating Da Boss chip, Nimbus orb (and dev N badge) overlap page content at the bottom of the viewport at 1440 and 375 | judge 2026-09-28; reserve a bottom gutter in the scroll area | 0 |
| 20 | OPEN | Dark theme: accent-blue links and small accent text measure 4.0:1 on dark cards | round-11 contrast; brand hue, needs Jack's OK to lighten | 0 |

