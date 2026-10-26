# Wing Command Center: progress

Branch: `claude/nice-einstein-4auqhu` (built on `cloud-hosting`, the branch the OS ships from).

## Done
- Storage adapter (lib/command/db.ts) on plain Postgres via COMMAND_DB_URL, schema auto-applied, migration 0034.
- Auth: per-user codes (COMMAND_CODE_*), member role limited to /command in proxy.ts.
- Notify module (Twilio, ntfy, email fallback; off until env set).
- APIs: login/logout, problems (+comments, screenshot, digest), daily check, prospects (CSV + laptop sync), call outcomes, roofer check-ins, client meta, billing, websites, deals, onboarding, weekly numbers, agent runs, calendar.

## Next
- Screens under app/command/*.

## Resume step
`git pull`, then build the screens under app/command (layout first).
