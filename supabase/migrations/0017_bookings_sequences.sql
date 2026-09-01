-- ═══════════════════════════════════════════════════════════════════════════
-- 0017_bookings_sequences.sql — GHL-replacement scaffolding: bookings + sequences
--
-- Two greenfield modules land in this one migration because they ship together
-- (2026-09-01 swarm build):
--
--   1. bookings — the booking calendar's own table. A prospect opens a public
--      /book link, picks a slot, and a row lands here. The OS calendar renders
--      these as their own lane next to google/callbacks/blocks. Public writes
--      go through /api/booking with the SERVICE key (the route validates and
--      rate-limits); RLS below is staff-only defense in depth, same as
--      calendar_blocks in 0015.
--
--   2. sequences / sequence_steps / sequence_enrollments — the workflow
--      engine's spine. Until now the D1/D3 email cadence lived as hardcoded
--      templates in ghl-cli/sender.py AND a drifting TS port in
--      app/api/messaging/route.ts. These tables become the single source of
--      truth: the OS edits them, senders read them. Enrollment state (which
--      contact is on which step, when the next send is due) lives here too,
--      so "pause this person" is a row update, not a code change.
--
-- Runs against the OS Supabase project (OS_SUPABASE_*), NOT Sonar.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─────────────────────────── bookings ───────────────────────────
create table if not exists public.bookings (
  id           uuid primary key default gen_random_uuid(),
  -- Who booked. Email required so we can thread replies and dedupe.
  name         text not null,
  email        text not null,
  phone        text,
  -- The slot. Stored as timestamptz because bookings are real moments in time,
  -- unlike calendar_blocks' repeating local-time blocks.
  starts_at    timestamptz not null,
  ends_at      timestamptz not null,
  -- confirmed | cancelled | completed | no_show
  status       text not null default 'confirmed',
  -- Where the booking came from: public_link | manual | call_room
  source       text not null default 'public_link',
  -- Which client/brand the booking is for; null = Wing Digital itself.
  client_slug  text,
  notes        text,
  created_at   timestamptz not null default now()
);

create index if not exists bookings_starts_at_idx on public.bookings (starts_at);
create index if not exists bookings_email_idx on public.bookings (email);

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'bookings_time_order'
  ) then
    alter table public.bookings
      add constraint bookings_time_order check (ends_at > starts_at);
  end if;
end $$;

alter table public.bookings enable row level security;

drop policy if exists bookings_read on public.bookings;
create policy bookings_read on public.bookings
  for select using (public.is_staff());

drop policy if exists bookings_write on public.bookings;
create policy bookings_write on public.bookings
  for all using (public.is_staff()) with check (public.is_staff());

-- ─────────────────────────── sequences ───────────────────────────
create table if not exists public.sequences (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  -- Which client's voice this sequence sends in; null = Wing's own outreach.
  client_slug  text,
  -- draft | active | paused. Only 'active' sequences ever enroll or send.
  status       text not null default 'draft',
  description  text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table if not exists public.sequence_steps (
  id           uuid primary key default gen_random_uuid(),
  sequence_id  uuid not null references public.sequences (id) on delete cascade,
  -- 1-based position in the cadence.
  step_order   int  not null,
  -- Days to wait AFTER the previous step (or after enrollment for step 1).
  wait_days    int  not null default 0,
  -- email is the only live channel today; sms reserved for later.
  channel      text not null default 'email',
  subject      text,
  -- Body supports {{first_name}} {{company}} {{city}} merge tags — the same
  -- tags sender.py already substitutes. Plain text, no HTML.
  body         text not null,
  created_at   timestamptz not null default now(),
  unique (sequence_id, step_order)
);

create table if not exists public.sequence_enrollments (
  id            uuid primary key default gen_random_uuid(),
  sequence_id   uuid not null references public.sequences (id) on delete cascade,
  -- The person. Email is the join key across prospects/crm_contacts; we do not
  -- FK because contacts live in two projects.
  email         text not null,
  name          text,
  company       text,
  -- Last step COMPLETED (0 = enrolled, nothing sent yet).
  current_step  int  not null default 0,
  -- active | paused | completed | replied | unsubscribed | bounced
  status        text not null default 'active',
  -- When the next step is due. Senders poll: status='active' and
  -- next_send_at <= now(). Null once completed/stopped.
  next_send_at  timestamptz,
  enrolled_at   timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  -- One live enrollment per person per sequence.
  unique (sequence_id, email)
);

create index if not exists seq_enroll_due_idx
  on public.sequence_enrollments (status, next_send_at);

alter table public.sequences enable row level security;
alter table public.sequence_steps enable row level security;
alter table public.sequence_enrollments enable row level security;

drop policy if exists sequences_all on public.sequences;
create policy sequences_all on public.sequences
  for all using (public.is_staff()) with check (public.is_staff());

drop policy if exists sequence_steps_all on public.sequence_steps;
create policy sequence_steps_all on public.sequence_steps
  for all using (public.is_staff()) with check (public.is_staff());

drop policy if exists sequence_enrollments_all on public.sequence_enrollments;
create policy sequence_enrollments_all on public.sequence_enrollments
  for all using (public.is_staff()) with check (public.is_staff());
