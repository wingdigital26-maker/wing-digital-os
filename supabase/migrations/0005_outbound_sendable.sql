-- ═══════════════════════════════════════════════════════════════════════════
-- 0005_outbound_sendable.sql — the read-only "safe to send" queue for the
-- sending contract (docs/SENDING-CONTRACT.md) that a friend is building the
-- SMTP sender against.
--
-- IMPORTANT — WHICH DATABASE THIS RUNS AGAINST
-- `outbound` is NOT in this OS's own Supabase project (the one 0001-0004
-- migrate). It lives in the separate "Sonar" Supabase project that
-- app/api/crm/route.ts talks to via SONAR_SUPABASE_URL / SONAR_SUPABASE_SERVICE_KEY
-- (see that file's `creds()`). This migration must be applied to THAT project,
-- not the OS project. It deliberately does not reference is_staff(), profiles,
-- or anything else from 0001-0004 — none of that is known to exist there.
--
-- `outbound` itself has no tracked CREATE TABLE anywhere in this codebase or
-- any sibling repo (ghl-cli, social-scraper-handoff, seo-factory, creative-tools,
-- github-tools were all checked). It was created ad hoc in the Supabase SQL
-- editor. The columns below are the ones app/api/crm/route.ts and the writer
-- (social-scraper-handoff/ingest/watch_social.py) actually read and write:
-- id, client, channel, direction, recipient, recipient_handle, recipient_url,
-- subject, body, personalization, evidence_url, status, tier, created_at,
-- reviewed_at, sent_at.
--
-- WHY A VIEW, NOT A TABLE
-- Nothing here writes anything, ever. A view recomputes "safe to send" from
-- `outbound` on every read, so the sendable set can never drift out of sync
-- with an approval or an edit the way a copied/materialized table could.
--
-- WHAT "SENDABLE" MEANS HERE
--   * status = 'approved'        -- a human looked at it and approved it,
--                                    via the CRM board's Approve button
--                                    (app/api/crm/route.ts POST action=approve).
--   * channel = 'email'          -- the writer also drafts non-email replies
--                                    (see watch_social.py: `recipient` on a
--                                    social-channel row is a POST TITLE, not an
--                                    address). Only email rows are safe to hand
--                                    to an SMTP sender.
--   * recipient looks like an email address, non-empty, after trimming.
--   * body is present and non-empty -- app/api/crm/route.ts already flags
--     body-less rows as "MISSING" in the UI; this view refuses to export them
--     rather than handing the sender an empty message.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- KNOWN GAP — SUPPRESSION IS **NOT** ENFORCED BY THIS VIEW
--
-- The build brief asked for a do-not-contact / suppression filter here. It
-- does not exist to filter on, and this migration will not invent one.
--
-- What was actually found, by searching every repo on this machine:
--   * The OS's own crm_contacts.do_not_contact (0004_crm.sql) lives in a
--     DIFFERENT Supabase project than `outbound`. Postgres cannot join across
--     projects, so this view has no way to reach it.
--   * The Sonar project (where `outbound` lives) has no suppression table,
--     no suppression column on `outbound`, `crm_clients`, or any other table
--     in that project. Nothing was found to filter on.
--   * The "8 suppressed contacts" reference traces to
--     C:\Users\wjack\ghl-cli\wing_suppression.py / smtp_sender.py's
--     load_suppression(), which is a FILE (outreach_logs/suppression.txt /
--     suppression.json) on Jack's local disk, read by smtp_sender.py itself
--     before every send. That check already runs client-side, inside
--     smtp_sender.py's SmtpPool.send() -- see is_suppressed() there -- and it
--     is not reachable from SQL.
--
-- Net effect: a row can appear in outbound_sendable and still be blocked at
-- send time by smtp_sender.py's own suppression gate. That gate is real and
-- already enforced, it is just not visible from this database. See
-- docs/SENDING-CONTRACT.md, "Open gap: suppression," for what closing this
-- properly would require.
-- ═══════════════════════════════════════════════════════════════════════════

drop view if exists public.outbound_sendable;

create view public.outbound_sendable as
select
    o.id,                    -- stable id; echo back in the send-result report
    o.recipient  as "to",    -- smtp_sender.py batch JSONL field name: "to"
    o.subject,                -- smtp_sender.py batch JSONL field name: "subject"
    o.body,                    -- smtp_sender.py batch JSONL field name: "body"
    o.id         as pid,      -- smtp_sender.py batch JSONL field name: "pid"
                               -- (the row id; smtp_sender.py treats any field
                               -- other than to/subject/body as pass-through
                               -- metadata it logs and echoes back)
    o.client,
    o.channel,
    o.tier,
    o.created_at,
    o.reviewed_at
from public.outbound o
where o.status = 'approved'
  and o.channel = 'email'
  and o.recipient is not null
  and btrim(o.recipient) <> ''
  and o.recipient ~* '^[A-Za-z0-9._%+''-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$'
  and o.body is not null
  and btrim(o.body) <> '';

comment on view public.outbound_sendable is
  'Read-only, human-approved, email-channel, address-validated, non-empty-body '
  'subset of outbound. Backs GET /api/outbound/export in wing-digital-os and the '
  'contract at docs/SENDING-CONTRACT.md. Does NOT enforce suppression -- see the '
  'gap noted in this migration file. Never written to.';

-- ---------- access ----------
-- `outbound` itself is queried today only via the Sonar project's service-role
-- key (see app/api/crm/route.ts creds()), which bypasses RLS entirely -- there
-- is no evidence RLS or an is_staff()-style function exists on this project at
-- all. This view cannot assume otherwise, so its real protection is: only the
-- service role can select from it, and the export route (own key, see
-- app/api/outbound/export/route.ts) is what stands between that service role
-- and the open internet. If `outbound` gains RLS + a staff function later,
-- grant select to `authenticated` here as well -- until then, service_role only.
revoke all on public.outbound_sendable from public, anon, authenticated;
grant select on public.outbound_sendable to service_role;
