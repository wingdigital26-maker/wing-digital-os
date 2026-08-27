-- ═══════════════════════════════════════════════════════════════════════════
-- 0004_crm.sql — the contact database and sales pipeline.
--
-- WHY THIS EXISTS
-- GoHighLevel was retired 2026-08-22 and took the CRM with it. Since then there
-- has been no contact of record anywhere in the OS: the dial sheet logs call
-- outcomes into a static page, and nothing graduates a conversation into a deal.
-- This is the replacement, built on the OS Supabase project so it works with the
-- PC off, which is the whole point.
--
-- DESIGN RULES CARRIED OVER FROM THE SCRAPER WORK
--   * NULL means unknown. It never means zero, and it never means "none".
--     A review count of 0 that really meant "we did not look" corrupted 5,383
--     rows once already; the same mistake is not welcome here.
--   * Every field that came from a scrape carries where it came from and when
--     it was last confirmed, so a stored value can always be re-checked against
--     its source instead of being trusted forever.
--   * Nothing in here sends anything. This schema stores state; senders live
--     elsewhere and have their own pause and suppression gates.
--
-- ACCESS
-- This is internal sales data. Staff only, enforced server-side by RLS on every
-- table. A client portal user must never see the pipeline, so unlike clients or
-- health_scores there is deliberately NO has_client_access() path here.
-- ═══════════════════════════════════════════════════════════════════════════

-- ---------- stages ----------
-- Pipeline stages are rows, not an enum, so Jack can reorder or rename them
-- without a migration. is_won/is_lost mark the terminal columns.
create table if not exists public.crm_stages (
    id          bigserial primary key,
    key         text not null unique,
    label       text not null,
    sort        int  not null default 0,
    is_won      boolean not null default false,
    is_lost     boolean not null default false,
    created_at  timestamptz not null default now()
);

-- ---------- contacts ----------
-- One row per business. `contact_name` is the human; a business with no known
-- human keeps NULL there rather than repeating the business name, so "do we
-- have a real person to call" stays an answerable question.
create table if not exists public.crm_contacts (
    id              bigserial primary key,
    business_name   text not null,
    contact_name    text,
    title           text,
    email           text,
    phone           text,
    website         text,
    city            text,
    state           text,
    trade           text,

    -- Provenance. `source` is where the row came from (prospects-db, maps,
    -- referral, manual...), `source_ref` is the id in that system so a row can
    -- be traced back, and verified_at is when a human or a check last confirmed
    -- the identity. NULL verified_at = never verified, which is not the same as
    -- unverifiable.
    source          text,
    source_ref      text,
    verified_at     timestamptz,

    -- Suppression lives with the contact so every future sender can honour it
    -- from one place. The outreach suppression list stays authoritative for the
    -- cold lane; this flag is the CRM-side record of an explicit opt-out.
    do_not_contact  boolean not null default false,
    dnc_reason      text,

    notes           text,
    owner_id        uuid references public.profiles(id) on delete set null,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now(),

    -- One cloud row per business per source. Lets an importer re-run safely
    -- instead of duplicating the pipeline every time it syncs.
    unique (source, source_ref)
);

create index if not exists crm_contacts_business_idx on public.crm_contacts (lower(business_name));
create index if not exists crm_contacts_email_idx    on public.crm_contacts (lower(email));
create index if not exists crm_contacts_phone_idx    on public.crm_contacts (phone);

-- ---------- deals ----------
-- A deal is one opportunity with one contact. value_cents is integer cents, not
-- a float: money in floating point eventually reports a number nobody can
-- reconcile. NULL value = not yet quoted, which is different from a $0 deal.
create table if not exists public.crm_deals (
    id            bigserial primary key,
    contact_id    bigint not null references public.crm_contacts(id) on delete cascade,
    stage_id      bigint not null references public.crm_stages(id),
    title         text not null,
    value_cents   bigint,
    status        text not null default 'open'
                  check (status in ('open', 'won', 'lost')),
    expected_close date,
    won_at        timestamptz,
    lost_at       timestamptz,
    lost_reason   text,
    owner_id      uuid references public.profiles(id) on delete set null,
    created_at    timestamptz not null default now(),
    updated_at    timestamptz not null default now()
);

create index if not exists crm_deals_stage_idx   on public.crm_deals (stage_id);
create index if not exists crm_deals_contact_idx on public.crm_deals (contact_id);
create index if not exists crm_deals_status_idx  on public.crm_deals (status);

-- ---------- activities ----------
-- The timeline: calls, emails, notes, meetings. This is where a dial-sheet
-- outcome finally lands instead of dead-ending in a static page.
-- `source` records which surface wrote the row (dial-sheet, os-ui, importer),
-- so an automated write is never mistaken for something Jack did by hand.
create table if not exists public.crm_activities (
    id           bigserial primary key,
    contact_id   bigint references public.crm_contacts(id) on delete cascade,
    deal_id      bigint references public.crm_deals(id) on delete set null,
    kind         text not null
                 check (kind in ('call', 'email', 'sms', 'note', 'meeting', 'stage_change')),
    outcome      text,
    body         text,
    occurred_at  timestamptz not null default now(),
    source       text,
    created_by   uuid references public.profiles(id) on delete set null,
    created_at   timestamptz not null default now(),
    -- An activity must belong to something; an orphan row is unreachable in the
    -- UI and would quietly inflate every count.
    constraint crm_activities_has_parent check (contact_id is not null or deal_id is not null)
);

create index if not exists crm_activities_contact_idx  on public.crm_activities (contact_id, occurred_at desc);
create index if not exists crm_activities_occurred_idx on public.crm_activities (occurred_at desc);

-- ---------- updated_at maintenance ----------
create or replace function public.crm_touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists crm_contacts_touch on public.crm_contacts;
create trigger crm_contacts_touch before update on public.crm_contacts
  for each row execute function public.crm_touch_updated_at();

drop trigger if exists crm_deals_touch on public.crm_deals;
create trigger crm_deals_touch before update on public.crm_deals
  for each row execute function public.crm_touch_updated_at();

-- ---------- seed stages ----------
-- Mirrors how Wing actually sells: a scraped lead becomes a conversation,
-- a conversation becomes a booked call, a call becomes a proposal, a proposal
-- closes. Seeded only when empty so a re-run never clobbers Jack's edits.
insert into public.crm_stages (key, label, sort, is_won, is_lost)
select * from (values
    ('new',        'New',          10, false, false),
    ('contacted',  'Contacted',    20, false, false),
    ('replied',    'Replied',      30, false, false),
    ('booked',     'Call Booked',  40, false, false),
    ('proposal',   'Proposal Out', 50, false, false),
    ('won',        'Won',          60, true,  false),
    ('lost',       'Lost',         70, false, true)
) as v(key, label, sort, is_won, is_lost)
where not exists (select 1 from public.crm_stages);

-- ---------- RLS: staff only, on every table ----------
alter table public.crm_stages     enable row level security;
alter table public.crm_contacts   enable row level security;
alter table public.crm_deals      enable row level security;
alter table public.crm_activities enable row level security;

drop policy if exists crm_stages_read on public.crm_stages;
create policy crm_stages_read on public.crm_stages
  for select using (public.is_staff());
drop policy if exists crm_stages_write on public.crm_stages;
create policy crm_stages_write on public.crm_stages
  for all using (public.is_staff()) with check (public.is_staff());

drop policy if exists crm_contacts_read on public.crm_contacts;
create policy crm_contacts_read on public.crm_contacts
  for select using (public.is_staff());
drop policy if exists crm_contacts_write on public.crm_contacts;
create policy crm_contacts_write on public.crm_contacts
  for all using (public.is_staff()) with check (public.is_staff());

drop policy if exists crm_deals_read on public.crm_deals;
create policy crm_deals_read on public.crm_deals
  for select using (public.is_staff());
drop policy if exists crm_deals_write on public.crm_deals;
create policy crm_deals_write on public.crm_deals
  for all using (public.is_staff()) with check (public.is_staff());

drop policy if exists crm_activities_read on public.crm_activities;
create policy crm_activities_read on public.crm_activities
  for select using (public.is_staff());
drop policy if exists crm_activities_write on public.crm_activities;
create policy crm_activities_write on public.crm_activities
  for all using (public.is_staff()) with check (public.is_staff());
