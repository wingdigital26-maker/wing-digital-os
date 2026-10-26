# Wing Command Center: progress

Branch: `claude/nice-einstein-4auqhu`, built on `cloud-hosting` (the branch the OS actually ships
from; `main` has no `app/lib/nav.ts` and is not deployed). Setup and screen guide: docs/COMMAND_CENTER.md.

## Done
- Storage adapter (lib/command/db.ts): plain Postgres via COMMAND_DB_URL, schema applied on first use,
  same SQL in supabase/migrations/0034_command_center.sql.
- Sign-in: per-user codes (COMMAND_CODE_JACK/GRANT/DYLAN) on the OS session cookie; Grant and Dylan get
  role "member", which proxy.ts limits to /command. Jack's OS login works too. Fails closed.
- Notify (lib/command/notify.ts): Twilio first, ntfy and email fallback, off until env is set, every
  attempt logged in cc_notifications.
- Screens: Home, Clients (+detail with history, notes, billing), Daily checks, Cold calls (+CSV upload),
  Roofer check-ins, Problems (+comments, screenshot, digest), Calendar, Pipeline (+day 0 to 14
  onboarding), SEO, Websites (+handoff standard), Team, Setup.
- Machine routes: /api/command/check, /api/command/digest, /api/command/prospects/sync,
  /api/command/agent-run (Bearer COMMAND_MACHINE_KEY).
- scripts/command_center/sync_prospects.py (laptop, prospects.db read-only).
- Nav: Team group + COMMAND_CENTER_PAGES in app/lib/nav.ts only.
- Verified locally: lint, typecheck, production build, phone-width click-through, fail-closed auth,
  sync idempotency, ntfy fallback.

## Next (needs Jack)
- Set the env vars in docs/COMMAND_CENTER.md (COMMAND_DB_URL first), redeploy the preview.
- Twilio number + A2P 10DLC or toll-free verification; Wing Team calendar on wingdigital26.
- Create the /schedule morning routine; run the laptop sync.

## Resume step
Open the preview, sign in at /command/login, and walk Setup (/command/setup) top to bottom.
