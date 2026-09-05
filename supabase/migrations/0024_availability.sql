-- ═══════════════════════════════════════════════════════════════════════════
-- 0024_availability.sql — booking availability that respects the team
--
-- Until now /api/booking offered every Mon-Fri 9-5 Central slot to the public
-- link, ignoring everyone's classes. This migration gives the booking engine
-- what it needs to be honest about who is actually free:
--
--   1. availability — one row per person (jack | maddox | grant). Weekly
--      office hours as jsonb in Central time, e.g.
--        {"mon":[["09:00","17:00"]], "tue":[["09:00","12:00"],["13:00","17:00"]]}
--      plus takes_bookings so a person can step out of the public rota
--      without losing their hours. Seeded Mon-Fri 09:00-17:00 for all three.
--
--   2. bookings.assigned_to — which person the public booking landed on
--      (text, nullable; NULL = unknown / legacy row, treated as blocking
--      everyone). The route picks a free person at insert time.
--
--   3. bookings_slot_unique becomes unique on (starts_at, assigned_to) so two
--      people CAN hold the same half hour with different callers, while the
--      same person can never be double-booked. NULL assigned_to is coalesced
--      to '' so unassigned legacy rows keep the old one-per-slot rule.
--
-- Runs against the OS Supabase project (OS_SUPABASE_*), NOT Sonar. Idempotent.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─────────────────────────── availability ───────────────────────────
create table if not exists public.availability (
  person          text primary key check (person in ('jack', 'maddox', 'grant')),
  -- Weekly hours in America/Chicago. Keys mon..sun, each a list of
  -- [start, end] "HH:MM" pairs. A missing or empty key = closed that day.
  hours           jsonb not null default '{}'::jsonb,
  takes_bookings  boolean not null default true,
  updated_at      timestamptz not null default now()
);

insert into public.availability (person, hours, takes_bookings)
values
  ('jack',
   '{"mon":[["09:00","17:00"]],"tue":[["09:00","17:00"]],"wed":[["09:00","17:00"]],"thu":[["09:00","17:00"]],"fri":[["09:00","17:00"]]}'::jsonb,
   true),
  ('maddox',
   '{"mon":[["09:00","17:00"]],"tue":[["09:00","17:00"]],"wed":[["09:00","17:00"]],"thu":[["09:00","17:00"]],"fri":[["09:00","17:00"]]}'::jsonb,
   true),
  ('grant',
   '{"mon":[["09:00","17:00"]],"tue":[["09:00","17:00"]],"wed":[["09:00","17:00"]],"thu":[["09:00","17:00"]],"fri":[["09:00","17:00"]]}'::jsonb,
   true)
on conflict (person) do nothing;

-- RLS: staff only, same pattern as calendar_blocks (0015).
alter table public.availability enable row level security;

drop policy if exists availability_read on public.availability;
create policy availability_read on public.availability
  for select using (public.is_staff());

drop policy if exists availability_write on public.availability;
create policy availability_write on public.availability
  for all using (public.is_staff()) with check (public.is_staff());

-- ─────────────────────────── bookings.assigned_to ───────────────────────────
alter table public.bookings
  add column if not exists assigned_to text;

create index if not exists bookings_assigned_idx
  on public.bookings (assigned_to, starts_at);

-- ─────────────────────────── slot uniqueness per person ─────────────────────
drop index if exists public.bookings_slot_unique;

create unique index if not exists bookings_slot_unique
  on public.bookings (starts_at, coalesce(assigned_to, ''))
  where status <> 'cancelled';
