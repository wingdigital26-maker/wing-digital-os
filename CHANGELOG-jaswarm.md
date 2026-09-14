
## 2026-09-14 — jaswarm Round 1 (Hero's social posting system)
| Lane | Change | Proof |
|---|---|---|
| visual | SocialBoard: per-platform chip + accent-rail visual language, hover/focus/active states (new SocialBoard.css) | tsc 0 err, 375px wraps, clean build |
| content | Hero's junk-removal social strategy.md + 11-pillar post_bank.json (ghl-cli/heros_social, not in git) | json valid, 0 prices/0 em dashes |
| system | Generator engine.py (plan/draft/export) + brand gate.py + heros-social-engine skill (ghl-cli, not in git) | end-to-end run: plan 8, draft 4/4 pass |
| practicality | Info panel now tells staff drafts also arrive from the post engine for review | reachable via nav Marketing>Social |
| safety | clean — no findings (minor export week-validation noted, non-exploitable) | — |
| regression | gate hardened: phone-number CTAs + word-spelled prices now caught (were bypassing) | 4 violations FAIL, 2 legit PASS; tsc 0; build ✓ |
