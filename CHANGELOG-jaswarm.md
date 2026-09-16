# CHANGELOG — jaswarm on wing-digital-os


## Round 1 — 2026-09-15 (Jack's 7-item shell batch)
| Lane | Change | Proof |
|---|---|---|
| nav | Marketing SEO>Social; Clients=Clients+Dashboards; CRM drops Everything, Email default, +Contacts far right | a11y tree ✓ |
| command | basic MRR strip pushed to top; verbose hero MRR + bottom MRR tile removed | MRR $1,250 at top ✓ |
| visual | More pill moved bottom-left beside Da Boss; Da Boss chip shrunk; skeletons rebuilt (were invisible on light bg) | screenshot ✓ |
| perf | dropped unused d3/@types/d3; productionBrowserSourceMaps off (optimizePackageImports reverted — broke Turbopack dev) | build ✓ |
| regression | tsc 0 + clean `next build` 0 | ✓ |
Committed: 6a23f50 · Open: SW reload-loop is dev-only (SwRegister controllerchange); real perf win = hidden-view polling (Round 2) · Deployed to prod

## Round 2 — 2026-09-15 (perf: SW dev-loop + hidden-view polling)
| Lane | Change | Proof |
|---|---|---|
| perf:sw | SwRegister no-ops in dev (unregisters existing) - kills the dev reload loop; prod SW unchanged | console: 0 reload-loop errors (was 226+) |
| perf:polling | SonarBoard 120s poll + Call Room 20s poll gated on visibility (offsetParent/document.hidden); Storm/Competitor had no recurring polls | tsc 0 |
| regression | tsc 0 + clean next build 0 | ✓ |
Committed: (this round) · Deployed to prod

## Round 3 — 2026-09-16 (CRM section deep-dive)
| Lane | Change | Proof |
|---|---|---|
| crm-contacts | Contacts view: plain-text loading -> .skel skeleton blocks | tsc 0 |
| crm-email | Email (CRM default): added landing intro (eyebrow/title/one-liner) so it orients a first-timer | tsc 0 |
| crm-replies | Reply Inbox + Text (MessageLedger): plain-text loading -> .skel skeletons (list+panel) | tsc 0 |
| regression | tsc 0 + clean next build 0 | ✓ |
| safety | clean (presentational diff only) | — |
Open: SendQueueBoard/DeliverabilityBoard not yet reviewed (backlog).

## Round (dashboards) — 2026-09-16 (client dashboard template reorg)
| Lane | Change | Proof |
|---|---|---|
| dashboard | template.html reorganized into a narrative (content -> site health -> reputation/lists -> outreach -> plan-at-end), group dividers for scannability, tighter 375px margins; rebuilt heros (65 items) + jackson (20) | build.py exit 0, both render, Sept content shows |
| tokens/data | all __TOKEN__ placeholders + __DATA__ contract preserved | grep verified |
Next: sharpen the top summary / hero density (still generic above the fold).

## Round (dashboards) 2 — 2026-09-16 (top-of-page density)
| Lane | Change | Proof |
|---|---|---|
| dashboard | shrank oversized hero (~half height, one-line headline), rebuilt stat strip to uniform aligned auto-fit grid, added reviews-standing tile from real DATA (omitted when no profile); respected house rule vs 30-day metric | build.py ✓; heros 2 tiles (honest), jackson 4 tiles + 4.1 rating |
| tokens/data | placeholders + __DATA__ contract preserved | grep ✓ |
Open: jackson rating tile truncates "4.1..." (backlog).

## Round (dashboards) 3 — 2026-09-16 (rating tile fix)
| Lane | Change | Proof |
|---|---|---|
| dashboard | fixed rating tile clip: short "4.1★" value + review count in label; removed ellipsis clip, added .is-long font-step safety net; wrapped reviews table | build.py ✓; jackson shows "4.1★ / 14 reviews on your listing" |
Open (carry to next round): reviews section prominence, published-list scannability + mobile (R3 agent stalled before these).

## Round (dashboards) 4 — 2026-09-16 (published list + reviews honesty)
| Lane | Change | Proof |
|---|---|---|
| dashboard | published-list rows restyled (consistent rhythm, pill type-badges, aligned right-column dates, 480px wrap, pointer on linked rows); reviews section branches on hasProfile -> honest one-line empty state; heading "Reviews and reputation" | build.py ✓; heros list shows pill badges + month headers |
| tokens/data | all 10 __TOKEN__ + __DATA__ contract preserved (re-grepped) | ✓ |

## Round (dashboards) 5 — 2026-09-16 (component sizing + polish)
| Lane | Change | Proof |
|---|---|---|
| dashboard | lstats/chans grids auto-fit -> auto-fill with capped track widths (tiles/channel cards no longer balloon when few); subtle hover border on lstat/chan.live; reviews+outreach reviewed, already solid | build.py ✓; 10 tokens re-grepped |

## Round (dashboards) 6 — 2026-09-16 (chart legend + a11y)
| Lane | Change | Proof |
|---|---|---|
| dashboard | added chart legend row directly under the published chart (blog/service color key, only when >1 type); referral filter pills span->button + aria-pressed for keyboard/AT | build.py ✓; heros chart shows "Blog post / Service page" legend; 10 tokens re-grepped |
Deferred: full sitewide --t3 contrast audit (spot-checked fine).
