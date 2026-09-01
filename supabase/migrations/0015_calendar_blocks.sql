-- ═══════════════════════════════════════════════════════════════════════════
-- 0015_calendar_blocks.sql — manual time-blocks on the OS calendar
--
-- Jack wants to lay blocks onto the Calendar section by hand — a study block,
-- a call block, a work block — the way his class-schedule app draws classes.
-- Every other lane on that calendar is read-only from some source system;
-- this table is the first thing the calendar OWNS.
--
-- One row = one block. A block either sits on a single date, or (recurrence =
-- 'weekly') repeats every week on that date's weekday from that date forward.
-- Expansion into dated instances happens in the app; the table stores only
-- what Jack typed.
--
-- Runs against the OS Supabase project (the one 0001-0004 and 0012-0014
-- migrate), NOT Sonar. Writes go through /api/blocks with the service key;
-- the RLS below is defense in depth, staff-only via the existing is_staff().
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.calendar_blocks (
  id          uuid primary key default gen_random_uuid(),
  title       text not null,
  -- The block's anchor date. For a weekly repeat this is the FIRST occurrence;
  -- the weekday to repeat on is derived from it.
  date        date not null,
  start_time  time not null,
  end_time    time not null,
  -- Category drives the colour in the UI: study | call | work | personal | other.
  category    text not null default 'work',
  notes       text,
  -- null = one-off. 'weekly' = repeats every week on date's weekday, from date
  -- forward. Text (not an enum) so richer rules can arrive without a migration.
  recurrence  text,
  created_at  timestamptz not null default now()
);

create index if not exists calendar_blocks_date_idx on public.calendar_blocks (date);

-- Sanity: a block must end after it starts.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'calendar_blocks_time_order'
  ) then
    alter table public.calendar_blocks
      add constraint calendar_blocks_time_order check (end_time > start_time);
  end if;
end $$;

-- ---------- RLS: staff only, same pattern as the rest of the OS ----------
alter table public.calendar_blocks enable row level security;

drop policy if exists calendar_blocks_read on public.calendar_blocks;
create policy calendar_blocks_read on public.calendar_blocks
  for select using (public.is_staff());

drop policy if exists calendar_blocks_write on public.calendar_blocks;
create policy calendar_blocks_write on public.calendar_blocks
  for all using (public.is_staff()) with check (public.is_staff());
