-- ═══════════════════════════════════════════════════════════════════════════
-- CRITICAL. Applied live to the Sonar project (klzmpjregrcxumaxfsug).
--
-- Found by adversarial verification on 2026-08-27, BEFORE any mail was sent.
--
-- `public.outbound` had row level security disabled AND still carried the
-- default PostgREST grants to `anon` and `authenticated`. The Supabase anon key
-- is a PUBLISHABLE key by design, meant to be safe to embed client side. So
-- anyone holding it could:
--
--   1. read every prospect address and full message body for every client, and
--   2. INSERT a row with status='approved' that landed straight in
--      outbound_sendable and would have been picked up and mailed by the sender
--      under a real client's name, with no human approval anywhere in the loop.
--
-- This was proved live: an anon-key insert produced row 76, which immediately
-- appeared in outbound_sendable. The whole approve/policy/suppression design was
-- sound and resisted every SQL-level attack, and was simply bypassed by going
-- around the view to the base table.
--
-- 0006 revoked anon on the new tables and the view but never touched `outbound`
-- itself, and never enabled RLS anywhere. Both halves are fixed here.
--
-- Everything legitimate uses the service role, which bypasses RLS:
--   - ingest/watch_social.py writes drafts with SUPABASE_SERVICE_KEY
--   - app/api/crm, /api/outbound/export, /api/outbound/sent all use
--     SONAR_SUPABASE_SERVICE_KEY
-- so nothing that should work stops working.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Revoke the publishable-key access ──────────────────────────────────────
revoke all on public.outbound            from anon, authenticated;
revoke all on public.crm_clients         from anon, authenticated;
revoke all on public.suppression         from anon, authenticated;
revoke all on public.client_send_policy  from anon, authenticated;
revoke all on public.outbound_sendable   from anon, authenticated;

-- Sequences too. INSERT rights are useless without them, but leaving them is
-- untidy and they are part of the same default grant set.
revoke all on all sequences in schema public from anon, authenticated;

-- ── Defense in depth: RLS on, with no permissive policy ────────────────────
-- Grants are the primary gate. RLS is the second one, so a future migration
-- that re-grants by accident (or a Supabase default that reappears) does not
-- silently reopen the hole. No policies are created deliberately: service_role
-- bypasses RLS, and nothing else has any business reading these tables.
alter table public.outbound            enable row level security;
alter table public.suppression         enable row level security;
alter table public.client_send_policy  enable row level security;
alter table public.crm_clients         enable row level security;

alter table public.outbound            force row level security;
alter table public.suppression         force row level security;
alter table public.client_send_policy  force row level security;
alter table public.crm_clients         force row level security;

comment on table public.outbound is
  'Drafted and approved outbound messages. service_role ONLY. RLS is enabled
   with no policies on purpose: an anon-key insert here once reached the send
   queue as a pre-approved message. Never grant anon or authenticated on this
   table, and never add a permissive policy without re-reading migration 0008.';
