-- ═══════════════════════════════════════════════════════════════════════════
-- 0013_call_room_sections.sql -- everything around the dialing
--
-- 0012 gave the room a dial list. This adds the parts that make it an outbound
-- SECTION rather than a single screen:
--
--   * Leads that were audited and REJECTED now live here too, flagged and with
--     the reason attached. Previously only serviceable leads synced, which made
--     the quality pass invisible: you could not tell "we found 65 leads" from
--     "we found 100 and 35 were unsellable". Keeping the rejects makes the
--     filtering auditable, stops the same dead company being re-imported every
--     scrape, and answers "why aren't we calling X" without a re-run.
--
--   * A place to record where a batch of leads came from and when, so the
--     Sources screen reports facts instead of guesses.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.call_leads
  add column if not exists excluded boolean not null default false,
  add column if not exists excluded_reason text;

-- The dial list filters on this constantly.
create index if not exists call_leads_excluded_idx
  on public.call_leads (excluded, status);

-- Batch provenance. One row per import run.
create table if not exists public.call_lead_batches (
  id           uuid primary key default gen_random_uuid(),
  source       text not null,
  imported_at  timestamptz not null default now(),
  total        integer not null default 0,
  serviceable  integer not null default 0,
  excluded     integer not null default 0,
  note         text
);

create index if not exists call_lead_batches_time_idx
  on public.call_lead_batches (imported_at desc);

alter table public.call_lead_batches enable row level security;

drop policy if exists call_batches_read on public.call_lead_batches;
create policy call_batches_read on public.call_lead_batches
  for select using (public.is_call_user());
