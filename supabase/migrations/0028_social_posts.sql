-- ═══════════════════════════════════════════════════════════════════════════
-- 0028_social_posts.sql -- draft and schedule social posts, per client.
--
-- One row per social post a staff member drafts for a client: a caption, an
-- optional image URL, which platform it is for, and when they plan to put it
-- up. Staff move a post draft -> scheduled -> posted, where "posted" is a
-- HUMAN saying "I posted this manually just now".
--
-- CRITICAL: this table is DRAFT AND SCHEDULE ONLY. Nothing in this OS ever
-- publishes to any social network, and no social API is connected. "posted"
-- is a human note, not an automated action. See docs/SENDING-CONTRACT.md.
--
-- NULL means unknown. scheduled_for NULL = an unscheduled draft. posted_at
-- NULL = not yet marked posted. image_url NULL = no image on this post.
--
-- ACCESS: internal content data, staff only via RLS, same as crm_*.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.social_posts (
    id              bigserial primary key,
    client_slug     text,
    platform        text not null default 'other'
                    check (platform in ('facebook','instagram','google','nextdoor','other')),
    caption         text not null,
    image_url       text,
    scheduled_for   timestamptz,
    status          text not null default 'draft'
                    check (status in ('draft','scheduled','posted','archived')),
    posted_at       timestamptz,
    notes           text,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now()
);

create index if not exists social_posts_status_idx     on public.social_posts (status);
create index if not exists social_posts_client_idx     on public.social_posts (client_slug);
create index if not exists social_posts_scheduled_idx  on public.social_posts (scheduled_for);
create index if not exists social_posts_created_idx    on public.social_posts (created_at desc);

drop trigger if exists social_posts_touch on public.social_posts;
create trigger social_posts_touch before update on public.social_posts
  for each row execute function public.crm_touch_updated_at();

alter table public.social_posts enable row level security;

drop policy if exists social_posts_read on public.social_posts;
create policy social_posts_read on public.social_posts
  for select using (public.is_staff());
drop policy if exists social_posts_write on public.social_posts;
create policy social_posts_write on public.social_posts
  for all using (public.is_staff()) with check (public.is_staff());
