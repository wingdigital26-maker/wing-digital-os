# autoswarm changelog — NIMBUS
(round digests, newest at bottom)


## Round 1 — 2026-09-16 — NIMBUS — score 56 → 58 (+2)
| Lane | Change | Rung | Proof |
|---|---|---|---|
| automation | nimbusWatch could-not-check message now names the real Vercel public/ bundling cause + exact next.config fix | L4 (functional) | tsc clean; traced path |
| functionality | glance attempt() Promise.race: added no-op .catch to kill unhandled-rejection risk on late source failure | L2 | tsc clean; safety-traced |
| correctness/chat | no changes needed — all jarvis tools have live handlers, no dead GHL, no fabricated data, fail-closed | L2 | tsc clean |
| audit | triage re-scored L2→L3 (autonomous investigate+fix via Claude CLI, safety-railed, ledgered) | — | read source |
| safety | clean pass — no findings | — | — |
| regression | no test suite; tsc --noEmit clean | — | tsc 0 |
Committed this round. Score 56→58 (+2) from triage rung correction. Ready to arm (Jack): auto-triage-on-new-problem (would make triage L4). Backlog: next.config outputFileTracingIncludes vs cleaner data source for client-publishing check; triage-log.jsonl has no reader; run_agent outreach path shells local daily_outreach.py (retire?).

## Round 2 — 2026-09-16 — NIMBUS — score 58 → 58 (no rung moved; real hardening shipped)
| Lane | Change | Rung | Proof |
|---|---|---|---|
| functionality | nimbusWatch: skip live.html (runtime-templated dashboard, var DATA=null+fetch) so it stops being a false could-not-check | L4 (honesty fix) | LIVE: glance unknowns [] / headline dropped "1 check could not run" |
| automation | cron: auto-triage-on-NEW-problem wired ready-but-GATED behind NIMBUS_AUTO_TRIAGE=1 (off); phone push protected by try/catch | L3 (plumbing; PC-only ceiling) | tsc clean; startTriage cloud path = no push (verified) |
| observability | problems+watch routes: readLedgerTriage() fallback so triage verdicts survive serverless cold start (in-mem→ledger→null, fail-closed) | L3 (observability) | tsc clean; watch 200; safety-confirmed fail-closed |
| audit | jarvisTools deep-read: chat CEILING@L3 earned (no dormant proactive path); auto-triage-on-cloud-cron = dead end (PC-only) | — | 1311 lines read |
| safety | clean pass — no findings | — | — |
| regression | no test suite; tsc --noEmit clean | — | tsc 0 |
| live-run | glance ?k=→200 (unknowns now []); watch ?k=→200, unauth→401 | — | ✓ |
Committed. Score 58→58 (honest: functionality+observability+gated plumbing, no mechanism/rung change). Ready to arm (Jack): NIMBUS_AUTO_TRIAGE=1 — but note it no-ops in cloud (triage PC-only); real value needs a PC-side triage poller (Jack decision). Backlog: /api/nimbus/problems appears unused by any UI caller; next.config outputFileTracingIncludes for prod client-publishing check.

## Round 3 — 2026-09-16 — NIMBUS — score 58 → 58 (plateau near ceiling; two real fixes shipped)
| Lane | Change | Rung | Proof |
|---|---|---|---|
| functionality | nimbusWatch: checkClientPublishingCloud() — prod check that was a permanent no-op now live-fetches client blogs (rejected sitemap lastmod as fake-healthy); judges Renewal for real, honest unknown for Hero's | L4 (prod no-op → functional) | LIVE: renewalhealth.life/blog.html prints Sep 16/15/14; Hero's no day-date → unknown |
| chat/safety | jarvisTools run_agent: FAIL-OPEN bug — omitted dryRun defaulted to a LIVE daily_outreach.py send; flipped to dryRun!==false (dry by default) + honest confirm copy | L2 (fail-open→fail-closed) | tsc clean; safety-confirmed strictly safer |
| audit | 5/6 watch checks confirmed cloud-durable; only checkClientPublishing was fs-based (now fixed) | — | per-check table |
| safety | clean pass — confirmed fail-open→fail-closed + SSRF-safe (hardcoded URLs) fail-closed | — | — |
| regression | no test suite; tsc clean; local glance 200 (7 problems, no could-not-check) | — | tsc 0 |
| live-run | cloud check data source proven live (Renewal dated, Hero's unknown); local watch regression 200 | — | ✓ |
Committed. Score 58→58 (honest plateau — pieces already at correct rungs; real safety + prod-functionality hardening). Backlog: next.config outputFileTracingIncludes now OPTIONAL (cloud check no longer needs public/ bundled); /api/nimbus/problems unused by UI.
