-- ═══════════════════════════════════════════════════════════════════════════
-- 0020_storm_response.sql — Storm Response (demo-only build, 2026-09-01)
--
-- Two tables behind the hail play:
--
--   storm_events — one row per NOAA/SPC hail report near DFW. Written by
--     scripts/storm_watch.py (SPC's public CSV, no key). Natural key
--     source_key dedupes re-polls of the same report.
--
--   storm_drafts — what Wing WOULD fire for an event: a Facebook post, a
--     geo-targeted ad spec, a Nextdoor post. status is 'draft' and nothing
--     in this build can move it anywhere else; no code path posts, boosts,
--     or spends. Approval/publish lanes come later, gated on Jack.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.storm_events (
  id          uuid primary key default gen_random_uuid(),
  event_time  timestamptz not null,
  lat         double precision not null,
  lon         double precision not null,
  -- Hail size in inches as SPC reports it (1.00, 1.75, ...).
  size_in     numeric(4,2),
  location    text,          -- SPC's place name, e.g. "2 N PROSPER"
  county      text,
  state       text,
  -- Cities/ZIPs the mapper judged affected, as jsonb array of
  -- {zip, city, distance_mi}.
  affected    jsonb,
  source      text not null default 'spc',
  source_key  text not null unique,
  raw         jsonb,
  created_at  timestamptz not null default now()
);

create index if not exists storm_events_time_idx on public.storm_events (event_time desc);

create table if not exists public.storm_drafts (
  id          uuid primary key default gen_random_uuid(),
  event_id    uuid not null references public.storm_events (id) on delete cascade,
  -- fb_post | ad_spec | nextdoor
  kind        text not null,
  -- Which client's voice the draft speaks in; null = generic/demo.
  client_slug text,
  content     jsonb not null,
  status      text not null default 'draft',
  created_at  timestamptz not null default now(),
  unique (event_id, kind, client_slug)
);

alter table public.storm_events enable row level security;
alter table public.storm_drafts enable row level security;

drop policy if exists storm_events_all on public.storm_events;
create policy storm_events_all on public.storm_events
  for all using (public.is_staff()) with check (public.is_staff());

drop policy if exists storm_drafts_all on public.storm_drafts;
create policy storm_drafts_all on public.storm_drafts
  for all using (public.is_staff()) with check (public.is_staff());
