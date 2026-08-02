-- ============ Wing Digital OS — Supabase schema (Phase 1) ============
-- Safe to run on the empty OS project. Does NOT touch the running OS app.

-- enums
do $$ begin
  create type os_role as enum ('admin','staff','client');
exception when duplicate_object then null; end $$;
do $$ begin
  create type client_phase as enum ('onboarding','build','active','paused','offboarded');
exception when duplicate_object then null; end $$;
do $$ begin
  create type run_status as enum ('ok','warning','crashed','needs_jack');
exception when duplicate_object then null; end $$;
do $$ begin
  create type pillar as enum ('green','yellow','red');
exception when duplicate_object then null; end $$;
do $$ begin
  create type access_scope as enum ('owner','viewer');
exception when duplicate_object then null; end $$;
do $$ begin
  create type deliverable_kind as enum ('audit','report','invoice','other');
exception when duplicate_object then null; end $$;

-- profiles (extends auth.users)
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name text,
  role os_role not null default 'client',
  created_at timestamptz not null default now()
);

-- clients
create table if not exists public.clients (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  ghl_location_id text,
  retainer numeric,
  phase client_phase not null default 'onboarding',
  created_at timestamptz not null default now()
);

-- client_users (portal login -> client mapping)
create table if not exists public.client_users (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  access access_scope not null default 'viewer',
  created_at timestamptz not null default now(),
  unique (user_id, client_id)
);

-- agent_runs
create table if not exists public.agent_runs (
  id uuid primary key default gen_random_uuid(),
  client_id uuid references public.clients(id) on delete set null,
  agent text not null,
  status run_status not null default 'ok',
  summary text,
  payload jsonb,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now()
);

-- health_scores (one row per client per day, history retained)
create table if not exists public.health_scores (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  date date not null,
  overall numeric,
  seo pillar, content pillar, website pillar, crm pillar, onboarding pillar,
  detail jsonb,
  created_at timestamptz not null default now(),
  unique (client_id, date)
);

-- deliverables (files live in Supabase Storage; this row points at them)
create table if not exists public.deliverables (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  title text not null,
  kind deliverable_kind not null default 'other',
  storage_path text,
  published boolean not null default false,
  created_at timestamptz not null default now()
);

-- ---------- role helpers (SECURITY DEFINER -> bypass RLS, no recursion) ----------
create or replace function public.is_staff()
returns boolean language sql security definer stable set search_path = public as $$
  select exists (select 1 from public.profiles p
                 where p.id = auth.uid() and p.role in ('admin','staff'));
$$;

create or replace function public.has_client_access(cid uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select public.is_staff()
      or exists (select 1 from public.client_users cu
                 where cu.user_id = auth.uid() and cu.client_id = cid);
$$;

-- ---------- enable RLS ----------
alter table public.profiles      enable row level security;
alter table public.clients       enable row level security;
alter table public.client_users  enable row level security;
alter table public.agent_runs    enable row level security;
alter table public.health_scores enable row level security;
alter table public.deliverables  enable row level security;

-- profiles: you see/edit your own row; staff see all
drop policy if exists profiles_self on public.profiles;
create policy profiles_self on public.profiles
  for select using (id = auth.uid() or public.is_staff());
drop policy if exists profiles_self_upd on public.profiles;
create policy profiles_self_upd on public.profiles
  for update using (id = auth.uid() or public.is_staff());

-- clients: staff all; portal user only their mapped client(s)
drop policy if exists clients_read on public.clients;
create policy clients_read on public.clients
  for select using (public.has_client_access(id));
drop policy if exists clients_write on public.clients;
create policy clients_write on public.clients
  for all using (public.is_staff()) with check (public.is_staff());

-- client_users: staff manage; user sees own mapping
drop policy if exists cu_read on public.client_users;
create policy cu_read on public.client_users
  for select using (user_id = auth.uid() or public.is_staff());
drop policy if exists cu_write on public.client_users;
create policy cu_write on public.client_users
  for all using (public.is_staff()) with check (public.is_staff());

-- agent_runs: staff all; portal user only their client's runs
drop policy if exists ar_read on public.agent_runs;
create policy ar_read on public.agent_runs
  for select using (public.is_staff() or (client_id is not null and public.has_client_access(client_id)));
drop policy if exists ar_write on public.agent_runs;
create policy ar_write on public.agent_runs
  for all using (public.is_staff()) with check (public.is_staff());

-- health_scores: staff all; portal user only their client's
drop policy if exists hs_read on public.health_scores;
create policy hs_read on public.health_scores
  for select using (public.has_client_access(client_id));
drop policy if exists hs_write on public.health_scores;
create policy hs_write on public.health_scores
  for all using (public.is_staff()) with check (public.is_staff());

-- deliverables: staff all; portal user only their client's PUBLISHED items
drop policy if exists dl_read on public.deliverables;
create policy dl_read on public.deliverables
  for select using (public.is_staff() or (public.has_client_access(client_id) and published));
drop policy if exists dl_write on public.deliverables;
create policy dl_write on public.deliverables
  for all using (public.is_staff()) with check (public.is_staff());

-- ---------- auto-create a profile when a new auth user signs up ----------
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, name) values (new.id, new.raw_user_meta_data->>'name')
  on conflict (id) do nothing;
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
