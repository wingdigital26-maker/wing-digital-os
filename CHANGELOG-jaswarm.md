
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
