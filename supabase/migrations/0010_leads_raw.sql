-- ═══════════════════════════════════════════════════════════════════════════
-- leads_raw: the wide gate. Applied live to the Sonar project.
--
-- The old design filtered at DISCOVERY, so anything the gates disliked was gone
-- before a human or a model ever saw it. That threw away the evidence needed to
-- tell "we found nothing" apart from "we rejected everything", and it made the
-- gates unfalsifiable.
--
-- New shape, per Jack 2026-08-27: collect EVERYTHING, keep it, categorize it,
-- then message only what qualifies. This table is the keep-everything step.
-- Nothing here is a lead yet. It is raw observed material.
--
-- Measured reachability the same day, so nobody re-tries the closed doors:
--   Reddit      403 to everything, direct, JSON, old.reddit, and via r.jina.ai
--   TikTok      connection reset direct, 403 via reader proxy
--   Instagram   200 but a login wall
--   Nextdoor    blocked direct and via reader proxy
--   Craigslist  readable
--   estatesales.net       readable, carries real future-dated sales
--   Dallas Open Data      readable, public records
-- Reddit and Nextdoor CONTENT is still reachable indirectly through a search
-- index (site: queries), which is how the existing scraper gets it. Direct
-- scraping of those hosts is not an option and should not be re-attempted.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.leads_raw (
    id            bigserial primary key,

    -- Provenance. Every row must be traceable back to something real.
    source        text not null,        -- 'craigslist' | 'search-index' | 'estatesales' | 'open-data'
    platform      text,                 -- 'reddit' | 'nextdoor' | 'facebook' | 'craigslist' | ...
    url           text not null,        -- the real permalink. No row without one.
    title         text,
    body          text,
    author_handle text,
    location_text text,                 -- whatever location the source itself stated

    -- Freshness. The lesson of 2026-08-27: a stale lead is not a lead. The one
    -- candidate that passed every gate was 18 days old and worthless. posted_at
    -- is NULL when the source genuinely does not state a date, which is itself
    -- information and must never be defaulted to now().
    posted_at     timestamptz,
    event_date    date,                 -- for dated future events (estate sales, permits)

    -- Discovery context.
    client        text,                 -- which client this was collected for
    query         text,                 -- the exact query that surfaced it
    collected_at  timestamptz not null default now(),

    -- Categorization, written later by the AI pass. All NULL until judged.
    -- category distinguishes the things that used to be collapsed into "reject":
    --   consumer_lead   someone personally wants this service
    --   partner         a business that needs this service repeatedly
    --   competitor      someone offering the same service
    --   noise           unrelated
    category      text,
    urgency       text,                 -- 'now' | 'dated' | 'someday' | null
    confidence    numeric,
    reason        text,
    quote         text,                 -- verbatim from the post. No quote, no qualify.
    judged_at     timestamptz,
    judge_status  text,                 -- 'judged' | 'not_assessed'. Never conflate the two.

    unique (url, client)
);

create index if not exists leads_raw_unjudged on public.leads_raw (client, collected_at)
  where category is null;
create index if not exists leads_raw_category on public.leads_raw (client, category, urgency);
create index if not exists leads_raw_posted on public.leads_raw (posted_at desc nulls last);

comment on table public.leads_raw is
  'Everything collected, before judgement. Rows are kept even when rejected so
   the funnel is auditable and the gates are falsifiable. category NULL means
   not yet judged, which is different from judged and found to be noise.';

comment on column public.leads_raw.posted_at is
  'When the SOURCE says it was posted. NULL means the source did not say. Never
   default this to collection time: that would make every stale post look fresh,
   which is exactly the bug that made an 18 day old job look like a live lead.';

-- Same lockdown as everything else in this project. service_role only. See
-- migration 0008 for why: an anon key insert once reached the send queue.
revoke all on public.leads_raw from anon, authenticated;
revoke all on sequence public.leads_raw_id_seq from anon, authenticated;
alter table public.leads_raw enable row level security;
alter table public.leads_raw force row level security;
