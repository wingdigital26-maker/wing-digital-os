-- 24/7 monitoring: agent heartbeats, push subscriptions, alert dedupe log.
-- Applied 2026-08-20. All three tables are service-key only (no anon access):
-- RLS is enabled with no policies, so PostgREST anon requests return nothing.

create table if not exists agent_heartbeats (
  agent text primary key,
  status text not null default 'ok',          -- ok | error | disabled
  message text,
  last_beat timestamptz not null default now(),
  meta jsonb
);
alter table agent_heartbeats enable row level security;

create table if not exists push_subscriptions (
  id bigint generated always as identity primary key,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  user_agent text,
  created_at timestamptz not null default now(),
  last_ok timestamptz,
  failed_count int not null default 0
);
alter table push_subscriptions enable row level security;

-- One row per distinct problem key; used to dedupe pushes and to send
-- "recovered" notices when a problem clears.
create table if not exists watchdog_alerts (
  key text primary key,
  title text not null,
  body text,
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  last_pushed timestamptz,
  resolved_at timestamptz
);
alter table watchdog_alerts enable row level security;
