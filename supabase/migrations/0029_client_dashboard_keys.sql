-- ═══════════════════════════════════════════════════════════════════════════
-- 0029_client_dashboard_keys.sql -- per-client access keys for the public
-- dashboard link.
--
-- Until now /dashboards/live.html?c=<slug> and its API were credential-free:
-- anyone who guessed a client's slug could read that client's data. This table
-- backs a required ?k=<key> on the dashboard route. The gate FAILS CLOSED --
-- no key or a wrong key returns 401 and no data is loaded.
--
-- One client can hold several keys (rotate without breaking a live link, hand a
-- distinct key to a distinct recipient, revoke one without touching the rest).
-- Keys are opaque and URL-safe, generated with crypto, never derived from the
-- slug.
--
-- ACCESS: staff-only via RLS, same as crm_*/potential_clients. There is NO
-- anon/public read policy on purpose -- the dashboard route reads this table
-- with the service key, so the key material never has to be exposed to anon.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.client_dashboard_keys (
    id              bigserial primary key,
    client_slug     text not null,
    key             text not null unique,        -- opaque, URL-safe, crypto-random
    label           text,                        -- who/what this key is for
    active          boolean not null default true,
    created_at      timestamptz not null default now(),
    last_used_at    timestamptz                  -- best-effort touch on a good read
);

create index if not exists client_dashboard_keys_slug_idx
  on public.client_dashboard_keys (client_slug);
-- (key already has a unique index from the unique constraint above)

alter table public.client_dashboard_keys enable row level security;

-- Staff-only, full access. No public/anon select policy: the dashboard route
-- uses the service key (which bypasses RLS), so anon never needs to read here.
drop policy if exists client_dashboard_keys_read on public.client_dashboard_keys;
create policy client_dashboard_keys_read on public.client_dashboard_keys
  for select using (public.is_staff());
drop policy if exists client_dashboard_keys_write on public.client_dashboard_keys;
create policy client_dashboard_keys_write on public.client_dashboard_keys
  for all using (public.is_staff()) with check (public.is_staff());
