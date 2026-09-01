-- ═══════════════════════════════════════════════════════════════════════════
-- 0016_reply_triage.sql — triage state for inbound rows in public.messages.
--
-- WHY THIS EXISTS
-- GHL's retirement killed the old reply-triage (it read GHL conversations).
-- The unified messages table (0014) is now the inbox of record; this table is
-- the triage ledger over it: ONE row per inbound message the triage agent has
-- looked at, carrying the classification and (for HOT/WARM) a draft reply.
--
-- DESIGN RULES
--   * Separate table, not columns on messages — the SMS pipe owns messages'
--     shape and this keeps triage state additive and droppable.
--   * message_id is UNIQUE: triage is idempotent, one verdict per message.
--   * DRAFT-ONLY: nothing here sends. status moves draft -> sent/dismissed
--     only by a human action from the OS Messages board.
--   * classification: hot | warm | cold | other. cold covers opt-out (handled
--     upstream by consent/suppression), not-interested, autoreplies.
--
-- ACCESS: staff-only RLS, exactly like messages (0014).
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.reply_triage (
    id              bigserial primary key,
    message_id      bigint not null unique references public.messages(id) on delete cascade,
    contact_id      bigint references public.crm_contacts(id) on delete set null,
    client_slug     text,
    channel         text,
    classification  text not null check (classification in ('hot', 'warm', 'cold', 'other')),
    classified_by   text not null default 'rules',   -- rules | model:<alias>
    confidence      text,                            -- high | low (rules hit vs fallback)
    draft           text,                            -- reply draft for hot/warm; NULL otherwise
    draft_model     text,                            -- llm_router alias/model that wrote the draft
    -- draft lifecycle: none (no draft) | draft (awaiting human) | sent | dismissed.
    -- Only a human, from the OS board, ever moves it past 'draft'.
    status          text not null default 'none' check (status in ('none', 'draft', 'sent', 'dismissed')),
    triaged_at      timestamptz not null default now(),
    handled_at      timestamptz,                     -- when a human acted on it
    notes           text
);

create index if not exists reply_triage_class_idx  on public.reply_triage (classification, triaged_at desc);
create index if not exists reply_triage_status_idx on public.reply_triage (status) where status = 'draft';
create index if not exists reply_triage_client_idx on public.reply_triage (client_slug, triaged_at desc);

alter table public.reply_triage enable row level security;

drop policy if exists reply_triage_read on public.reply_triage;
create policy reply_triage_read on public.reply_triage
  for select using (public.is_staff());
drop policy if exists reply_triage_write on public.reply_triage;
create policy reply_triage_write on public.reply_triage
  for all using (public.is_staff()) with check (public.is_staff());
