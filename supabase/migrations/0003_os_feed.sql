-- Agent notification feed. Scheduled Claude Code agents POST their results to
-- /api/notify, which writes one row here (and pushes when level = 'push').
-- Service-key only, matching 0002: RLS enabled with no policies, so PostgREST
-- anon requests return nothing.

create table if not exists os_feed (
  id bigint generated always as identity primary key,
  agent text not null,
  title text not null,
  body text,
  url text,                                    -- OS path the entry opens, e.g. /mission
  level text not null default 'feed',          -- feed | push
  created_at timestamptz not null default now()
);
alter table os_feed enable row level security;

create index if not exists os_feed_created_at_idx on os_feed (created_at desc);
