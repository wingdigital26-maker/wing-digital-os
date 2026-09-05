-- ═══════════════════════════════════════════════════════════════════════════
-- 0025_potential_clients.sql -- "drop a website in, start a potential client".
--
-- One row per business website Jack pastes into the Clients area. The OS itself
-- fetches the public site (no paid API, no scraping service) and fills in what
-- it can read: name, phone, email, city, services, socials, and a handful of
-- yes/no signals about what the site has or lacks. Everything the site did not
-- say stays NULL. NULL means unknown, never "" and never 0.
--
-- Converting a row creates a crm_contacts row (+ a deal in the first stage) and
-- records the link in crm_contact_id, so "is this already in the CRM" is a real
-- question with a real answer instead of a name match.
--
-- ACCESS: internal sales data, staff only via RLS, same as crm_*.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.potential_clients (
    id              bigserial primary key,
    domain          text not null unique,        -- lowercase host, no www.
    website         text not null,               -- the URL we actually fetched
    name            text,
    phone           text,
    email           text,
    city            text,
    state           text,
    trade           text,
    services        jsonb not null default '[]'::jsonb,
    socials         jsonb not null default '{}'::jsonb,
    signals         jsonb not null default '{}'::jsonb,
    summary         text,
    status          text not null default 'new'
                    check (status in ('new','researched','contacted','proposal','won','lost')),
    notes           text,
    crm_contact_id  bigint references public.crm_contacts(id) on delete set null,
    researched_at   timestamptz,
    research_error  text,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now()
);

create index if not exists potential_clients_status_idx  on public.potential_clients (status);
create index if not exists potential_clients_created_idx on public.potential_clients (created_at desc);

drop trigger if exists potential_clients_touch on public.potential_clients;
create trigger potential_clients_touch before update on public.potential_clients
  for each row execute function public.crm_touch_updated_at();

alter table public.potential_clients enable row level security;

drop policy if exists potential_clients_read on public.potential_clients;
create policy potential_clients_read on public.potential_clients
  for select using (public.is_staff());
drop policy if exists potential_clients_write on public.potential_clients;
create policy potential_clients_write on public.potential_clients
  for all using (public.is_staff()) with check (public.is_staff());
