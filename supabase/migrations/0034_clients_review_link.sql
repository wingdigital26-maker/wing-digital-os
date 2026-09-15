-- ═══════════════════════════════════════════════════════════════════════════
-- 0034_clients_review_link.sql -- the real "leave a review" link per client.
--
-- app/api/reviews/send/route.ts has always sent review-request copy with NO
-- actual link to click ("no fabricated links (the clients table has no
-- review URL to offer)" -- its own code comment). This column is that link:
-- the real Google Business Profile short link Jack or the client hands us,
-- never guessed or constructed from a place ID.
--
-- NULL is the honest default -- a client with no link on file must not be
-- queued for a review request (route.ts / queue_review_requests.py both fail
-- closed on a missing link rather than send a linkless ask). Populating this
-- is a one-time manual copy-paste per client, not something this migration
-- does for you.
--
-- Additive and idempotent, matches 0031's pattern: existing rows keep
-- google_review_url NULL until someone fills it in.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.clients
  add column if not exists google_review_url text;
