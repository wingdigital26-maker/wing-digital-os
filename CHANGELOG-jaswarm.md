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
