-- ═══════════════════════════════════════════════════════════════════════════
-- 0027_reviews.sql -- ask a happy client for a review, then track what came back.
--
-- One row per review request. After a job closes for a client, staff queue a
-- request to one of that client's contacts. Queuing records INTENT only: this
-- table never sends anything. The actual text or email goes out through the
-- existing automations pipe, and only when Jack arms it. A queued row is a
-- note that says "we mean to ask this person", nothing more.
--
-- The life of a row: queued -> requested (the ask went out) -> received (they
-- left a star rating) or dismissed (we gave up on it). rating stays NULL until
-- a real star count comes back. NULL means "we do not know yet", never 0 stars.
--
-- Per-client average and recent reviews are read straight off this table, so a
-- client's rating is always the real reviews we recorded, never a made-up
-- number.
--
-- ACCESS: internal client data, staff only via RLS, same as crm_* and clients.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.reviews (
    id              bigserial primary key,
    client_slug     text not null,                 -- which client the job was for
    contact_id      bigint references public.crm_contacts(id) on delete set null,
    channel         text not null default 'sms'
                    check (channel in ('sms','email')),
    status          text not null default 'queued'
                    check (status in ('queued','requested','received','dismissed')),
    rating          int check (rating between 1 and 5),   -- NULL until received
    review_text     text,
    platform        text check (platform in ('google','facebook','site','other')),
    requested_at    timestamptz,                   -- when the ask actually went out
    received_at     timestamptz,                   -- when the rating came back
    notes           text,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now()
);

create index if not exists reviews_client_idx  on public.reviews (client_slug);
create index if not exists reviews_status_idx  on public.reviews (status);
create index if not exists reviews_created_idx on public.reviews (created_at desc);

drop trigger if exists reviews_touch on public.reviews;
create trigger reviews_touch before update on public.reviews
  for each row execute function public.crm_touch_updated_at();

alter table public.reviews enable row level security;

drop policy if exists reviews_read on public.reviews;
create policy reviews_read on public.reviews
  for select using (public.is_staff());
drop policy if exists reviews_write on public.reviews;
create policy reviews_write on public.reviews
  for all using (public.is_staff()) with check (public.is_staff());
