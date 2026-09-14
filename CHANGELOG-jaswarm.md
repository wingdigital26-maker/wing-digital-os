
## 2026-09-14 — jaswarm Round 1 (Hero's social posting system)
| Lane | Change | Proof |
|---|---|---|
| visual | SocialBoard: per-platform chip + accent-rail visual language, hover/focus/active states (new SocialBoard.css) | tsc 0 err, 375px wraps, clean build |
| content | Hero's junk-removal social strategy.md + 11-pillar post_bank.json (ghl-cli/heros_social, not in git) | json valid, 0 prices/0 em dashes |
| system | Generator engine.py (plan/draft/export) + brand gate.py + heros-social-engine skill (ghl-cli, not in git) | end-to-end run: plan 8, draft 4/4 pass |
| practicality | Info panel now tells staff drafts also arrive from the post engine for review | reachable via nav Marketing>Social |
| safety | clean — no findings (minor export week-validation noted, non-exploitable) | — |
| regression | gate hardened: phone-number CTAs + word-spelled prices now caught (were bypassing) | 4 violations FAIL, 2 legit PASS; tsc 0; build ✓ |

## 2026-09-14 — jaswarm Round 2 (Hero's social system: close the loop)
| Lane | Change | Proof |
|---|---|---|
| visual | SocialBoard: filter-by-platform bar (real counts, useMemo, auto-fallback to All, hidden on single-platform boards) | tsc 0 err · 375px wraps · build ✓ |
| system | engine.py `push` subcommand: dry-run default, --live gated on WING_OS_STAFF_TOKEN, path traversal hardened via parse_week | dry-run sends nothing; ../etc rejected; no-token refused |
| content | strategy.md 4-week starter calendar (8/wk, all 11 pillars) + top pillars to 3 examples | JSON valid · 0 prices/em dashes/phones · all pillars >=2 |
| practicality | generator->board handoff now closable (`push --live`) + Round 1 info-panel hint | Social reachable via nav ✓ |
| safety | clean — token env-only never printed, no SSRF, TLS intact, no XSS | — |
| regression | Round 1 gate fixes still hold (5 FAIL / 2 legit PASS); full build ✓ | build exit 0 |

## 2026-09-14 — jaswarm Round 3 (Hero's social system: polish + defense-in-depth)
| Lane | Change | Proof |
|---|---|---|
| visual | Composer: platform-aware character counter (--orange near cap, --red over, guidance-only, aria-live) | tsc 0 err · 375px no collide · build ✓ |
| system | engine.py re-lints at export/push time (closes stored-gate tamper gap) + read-only `check --week` auditor | tamper caption SKIPPED by check/export/push; --week traversal rejected |
| content | strategy.md: 5-shot photo/video capture SOP + copy-paste hashtag & local-tag bank | 0 em dashes/prices/phones |
| practicality | `check` gives a per-post lint audit before anything is pushed | read-only, reachable via CLI + skill |
| safety | clean — counter is presentational, re-lint warning leaks no caption/token, check read-only | — |
| regression | Round 1 gate rules hold (phone/price FAIL); full clean build | build exit 0 |

## 2026-09-14 — jaswarm Round 4 (Hero's social system: photo hint end-to-end)
| Lane | Change | Proof |
|---|---|---|
| system | engine.py maps each post's image_hint into the POST `notes` field so the photo hint rides onto the board | export/push bodies carry notes; tamper guard intact |
| visual | Composer gains a "Notes for the poster" input; cards show a distinct photo-hint row when notes exist | tsc 0 err · 375px wraps · build ✓ |
| api | /api/social POST now accepts + stores optional `notes` (staff-gated, nullableText, capped 2000) | build ✓ · safety clean |
| content | strategy.md OPERATOR RUNBOOK: the exact weekly draft->review->attach->post->mark cycle | 0 em dashes/prices/phones |
| practicality | photo hint now flows generator -> board card, closing the "which photo?" gap | reachable via Marketing>Social |
| safety | clean — notes parameterized (no SQLi), rendered as escaped text (no XSS), staff-gated | — |
| regression | gate rules + tamper re-lint hold; full clean build | build exit 0 |

## 2026-09-14 — jaswarm Round 5 (Hero's social system: schedulable + at-a-glance)
| Lane | Change | Proof |
|---|---|---|
| system | run_weekly.py schedulable wrapper: drafts + lint-audits the current ISO week, logs, posts NOTHING (docstring shows the Task Scheduler pattern, no task registered) | draft 8, lint 8/8, sent nothing; idempotent; engine em dashes normalized |
| visual | SocialBoard "This week" summary strip: honest draft/scheduled/posted counts + next scheduled pill, hidden on load error | tsc 0 err · 375px wraps · build ✓ |
| content | strategy.md "MEASURING WHAT WORKS (honestly)": ask-how-they-found-you tally, engagement proxy, no fabricated metrics | 0 em dashes/prices/phones |
| practicality | weekly cycle can now be scheduled (draft-only) and the week is visible at a glance on the board | reachable via Marketing>Social |
| safety | clean — run_weekly uses safe argv (no shell), self-computed week, no network, no secret | — |
| regression | gate rules + tamper re-lint hold post-edit; full clean build | build exit 0 |

## 2026-09-14 — jaswarm Round 6 (Hero's social system: the posting agent)
| Lane | Change | Proof |
|---|---|---|
| poster | NEW poster.py: fail-closed Meta Graph publisher. Posts NOTHING unless --live AND HEROS_SOCIAL_POST_ENABLED=1 AND tokens all present; reads only due scheduled posts from /api/social, re-lints, skips IG w/o image, ledger logs, marks posted | status + post dry-run send nothing; verifier: AND-gate holds; safety clean |
| content | NEW META_SETUP.md: how to get IG Business + FB Page tokens, .env var names only, no-password/ToS note, image + go-live requirements | 0 em dashes, 0 token values |
| visual | Scheduled cards show honest readiness ("Ready to post" / IG "Needs a photo"); column helper reconciled to say posting agent is separate + off until connected (no board auto-post) | tsc 0 err · build ✓ |
| practicality | owner can glance at Scheduled column and see what will/won't go out | reachable via Marketing>Social |
| safety | clean — no hardcoded secrets, tokens only in headers/body never URL, graph host hardcoded, TLS on, fail-closed | — |
| regression | honesty fix: removed present-tense "auto-poster publishes these" that contradicted the by-hand blurb; full clean build | build exit 0 |

## 2026-09-14 — jaswarm Round 7 (Hero's social: fine-detail + perf + gate tests)
| Lane | Change | Proof |
|---|---|---|
| visual | Level-4 polish: focus rings on all 6 composer fields, prefers-reduced-motion guard, unified card radii to 14px | tsc 0 · verify: fields intact |
| perf | Memoized PostCard (React.memo) + useCallback save/remove: composer typing now 0 card re-renders (was O(N)) | tsc 0 · verify: no stale card |
| tests | NEW test_gate.py (in ghl-cli): 93 assertions covering every brand rule + all 25 post_bank examples | 93/93 pass, exit 0 |
| practicality | no changes needed (polish round, board already reachable) | — |
| safety | clean — presentational/perf only, test file read-only | — |
| regression | gate tests 93/93 · tsc 0 · clean build | build exit 0 |
**Process note:** never give two parallel agents the same file. This round gave perf+visual both SocialBoard.tsx; they did not collide but it was luck. Logged in journal.

## 2026-09-14 — jaswarm Round 8 (Hero's social: caption quality / anti-slop)
| Lane | Change | Proof |
|---|---|---|
| content | All 11 pillar prompts rewritten for specificity (DFW suburbs, concrete items, forbid cliche openers/hashtag-stuffing) + 3 new brand_rules + sharper examples | JSON ok · gate 95/95 · 0 $/em-dash/phone |
| system | NEW quality.py anti-slop advisory (cliche openers, emoji/hashtag stuffing, ALL-CAPS, generic) wired into engine as non-blocking quality_notes | advisory-only (always exit 0) · never blocks export |
| visual | no changes needed (board dialed after round 7) | — |
| practicality | no changes needed (no UI/nav change) | board reachable ✓ |
| safety | clean — quality.py pure string analysis, gate path untouched, no secrets | — |
| regression | gate tests 95/95 · engine draft/export smoke ok · OS worktree unchanged (round-7 build stands) | 95/95 ✓ |
**Committed (code):** ghl-cli/heros_social (not a repo) · changelog only to ja/loop
