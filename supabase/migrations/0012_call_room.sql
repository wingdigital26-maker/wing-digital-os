-- ═══════════════════════════════════════════════════════════════════════════
-- 0012_call_room.sql -- the Cold Call Room
--
-- Jack wants people other than himself dialing his leads. That needs three
-- things the OS did not have:
--
--   1. A role that can ONLY call. A caller signs in with their own email and
--      reaches the call room and nothing else. They must never see MRR, the
--      client list, Sonar, Jarvis, or any other client's data. The existing
--      os_role enum had admin/staff/client; 'staff' is full OS access, which is
--      far too much for a contract dialer. Hence a new 'caller' role.
--
--   2. A lead table the callers share. Every caller sees every lead -- that is
--      what Jack asked for -- but two people must not dial the same business at
--      the same moment, so a lead can be CLAIMED for a short window.
--
--   3. An activity log that records WHO called WHAT and what happened, because
--      with multiple dialers "did anyone call this yet" stops being answerable
--      from memory.
--
-- Writes all happen server-side through the service key in /api/calls/*, which
-- re-checks the role on every request. The RLS below is defense in depth for
-- the day someone points an anon key at this project.
-- ═══════════════════════════════════════════════════════════════════════════

-- ---------- 1. the caller role ----------
-- Additive to the existing enum. Safe to re-run.
do $$
begin
  if not exists (
    select 1 from pg_enum e
    join pg_type t on t.oid = e.enumtypid
    where t.typname = 'os_role' and e.enumlabel = 'caller'
  ) then
    alter type os_role add value 'caller';
  end if;
end $$;

-- ---------- 2. leads ----------
create table if not exists public.call_leads (
  id           uuid primary key default gen_random_uuid(),

  -- Who to call.
  company      text not null,
  contact_name text,
  title        text,
  phone        text,
  email        text,
  website      text,
  linkedin     text,
  city         text,
  state        text default 'TX',

  -- Why they are worth calling. Written by the enrichment pass, read by the
  -- caller on screen so they open with something real instead of a script.
  vertical     text,
  employees    integer,
  revenue      numeric,
  score        integer default 0,
  signals      text,          -- "headcount down 50% in 12mo = demand problem"

  -- Provenance. Never lose where a lead came from.
  source       text,          -- 'apollo-2026-08-29'
  external_id  text,          -- id in the origin system, for re-sync

  -- Working state.
  status       text not null default 'new',
    -- new | contacted | callback | booked | not_interested | bad_number | dnc
  claimed_by   uuid references auth.users(id) on delete set null,
  -- Denormalized on purpose. auth.users is not readable from the app's schema,
  -- so without this the UI could only say "someone else is calling this" and
  -- never who. In a shared room that ambiguity is the whole problem.
  claimed_by_email text,
  claimed_at   timestamptz,
  last_outcome text,
  last_called_at timestamptz,
  call_count   integer not null default 0,
  next_action_at timestamptz,

  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- One row per real business. Re-importing the same lead updates it instead of
-- creating a duplicate for someone to waste a dial on.
--
-- This is a generated column with a PLAIN unique index rather than the obvious
-- `create unique index on call_leads (lower(company))`. PostgREST upserts
-- (?on_conflict=...) can only target a real column, not an expression index --
-- an expression index returns 42P10 "no unique or exclusion constraint matching
-- the ON CONFLICT specification" and the whole import fails.
alter table public.call_leads
  add column if not exists company_key text
  generated always as (lower(btrim(company))) stored;

create unique index if not exists call_leads_company_key_uniq
  on public.call_leads (company_key);

create index if not exists call_leads_status_idx on public.call_leads (status);
create index if not exists call_leads_score_idx  on public.call_leads (score desc);
create index if not exists call_leads_claim_idx  on public.call_leads (claimed_at);

-- ---------- 3. activity ----------
create table if not exists public.call_activity (
  id          bigserial primary key,
  lead_id     uuid not null references public.call_leads(id) on delete cascade,
  user_id     uuid references auth.users(id) on delete set null,
  user_email  text,             -- denormalized so history survives a deleted user
  outcome     text not null,    -- same vocabulary as call_leads.status
  notes       text,
  duration_sec integer,
  next_action_at timestamptz,
  created_at  timestamptz not null default now()
);

create index if not exists call_activity_lead_idx on public.call_activity (lead_id, created_at desc);
create index if not exists call_activity_user_idx on public.call_activity (user_id, created_at desc);

-- ---------- 4. role helper ----------
-- Anyone allowed in the call room: admins and staff (Jack and internal) plus
-- the dedicated callers. Deliberately does NOT include 'client'.
create or replace function public.is_call_user()
returns boolean language sql security definer stable set search_path = public as $$
  select exists (select 1 from public.profiles p
                 where p.id = auth.uid()
                   and p.role in ('admin','staff','caller'));
$$;

-- ---------- 5. RLS ----------
alter table public.call_leads    enable row level security;
alter table public.call_activity enable row level security;

-- Every caller sees every lead. That is the ask: a shared room, not siloed lists.
drop policy if exists call_leads_read on public.call_leads;
create policy call_leads_read on public.call_leads
  for select using (public.is_call_user());

-- Callers may update working state on any lead (claim it, disposition it).
-- They cannot insert or delete leads -- only the importer (service key) does.
drop policy if exists call_leads_update on public.call_leads;
create policy call_leads_update on public.call_leads
  for update using (public.is_call_user()) with check (public.is_call_user());

-- Activity: everyone in the room can read the full history (so nobody
-- re-dials a business someone else just spoke to) and write their own rows.
drop policy if exists call_activity_read on public.call_activity;
create policy call_activity_read on public.call_activity
  for select using (public.is_call_user());

drop policy if exists call_activity_insert on public.call_activity;
create policy call_activity_insert on public.call_activity
  for insert with check (public.is_call_user() and user_id = auth.uid());

-- ---------- 6. keep updated_at honest ----------
create or replace function public.touch_call_lead()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists call_leads_touch on public.call_leads;
create trigger call_leads_touch before update on public.call_leads
  for each row execute function public.touch_call_lead();
