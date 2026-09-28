-- Outreach review queue + Instantly event log (2026-09-28).
--
-- The custom cold-email engine (ghl-cli: write_sequences.py -> qa_gate.py ->
-- instantly_sender.py push-queue) writes one JSON draft per lead per day. The
-- OS loads those drafts here so they can be reviewed, edited, approved or
-- rejected on /outreach, and records what Instantly then does with them.
--
-- Applied over the pooler (OS_DB_URL) by lib/outreach/store.ts on first use,
-- because Supabase REST has answered 402 since 2026-09-21. This file is the
-- same DDL for the record and for a fresh project. Idempotent.

create table if not exists outreach_drafts (
  id                bigserial primary key,
  tenant            text not null,
  lead_id           text not null,
  batch_date        date not null,
  round             int  not null default 1,
  company           text,
  contact_name      text,
  contact_email     text,
  website           text,
  city              text,
  trade             text,
  facts             jsonb not null default '[]',
  research          jsonb,
  steps             jsonb not null,            -- [{step, subject, body, delayDays}] as it will be pushed
  original_steps    jsonb not null,            -- as the engine wrote it, so edits stay visible
  engine_status     text,
  qa_status         text not null default 'pending' check (qa_status in ('passed','failed','pending')),
  qa_reasons        jsonb not null default '[]',
  approval_status   text not null default 'pending' check (approval_status in ('pending','approved','rejected')),
  approver          text,
  approved_at       timestamptz,
  rejected_reason   text,
  edited_by         text,
  edited_at         timestamptz,
  push_requested_at timestamptz,
  push_requested_by text,
  pushed_at         timestamptz,
  next_round_due    timestamptz,
  source_path       text,
  source_updated_at timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (tenant, lead_id, batch_date, round)
);
create index if not exists outreach_drafts_batch on outreach_drafts (batch_date desc, tenant);
create index if not exists outreach_drafts_email on outreach_drafts (lower(contact_email));

create table if not exists outreach_events (
  id                 bigserial primary key,
  event_type         text not null check (event_type in ('sent','opened','clicked','replied','auto_replied','bounced','unsubscribed','complaint','interested','not_interested','meeting_booked')),
  occurred_at        timestamptz not null,
  contact_email      text,
  tenant             text,
  campaign_id        text,
  mailbox            text,
  step               int,
  round              int,
  draft_id           bigint references outreach_drafts(id) on delete set null,
  lead_id            text,
  instantly_email_id text,
  thread_id          text,
  subject            text,
  body_text          text,
  interest           text,
  stop_reason        text,
  source             text not null check (source in ('poll','webhook','ingest')),
  dedupe_key         text not null unique,
  payload            jsonb,
  created_at         timestamptz not null default now()
);
create index if not exists outreach_events_time on outreach_events (occurred_at desc);
create index if not exists outreach_events_email on outreach_events (contact_email, occurred_at desc);
create index if not exists outreach_events_type on outreach_events (event_type, occurred_at desc);

-- One row per person per tenant: the round they are on and, once any stop
-- applies, why and when. Permanent stops (unsubscribed, negative_reply,
-- spam_complaint, hard_bounce) are never cleared by the OS.
create table if not exists outreach_leads (
  tenant          text not null,
  email           text not null,
  lead_id         text,
  company         text,
  contact_name    text,
  current_round   int not null default 1,
  last_sent_at    timestamptz,
  next_round_due  timestamptz,
  stop_reason     text check (stop_reason in ('unsubscribed','negative_reply','spam_complaint','hard_bounce','handoff')),
  stopped_at      timestamptz,
  stop_source     text,
  stop_detail     text,
  updated_at      timestamptz not null default now(),
  primary key (tenant, email)
);

-- The engine's per-mailbox circuit breaker, mirrored by the ingest.
create table if not exists outreach_mailbox_state (
  mailbox       text primary key,
  tenant        text,
  paused        boolean not null default false,
  paused_reason text,
  paused_at     timestamptz,
  updated_at    timestamptz not null default now()
);

-- Sync cursors and the last run's summary.
create table if not exists outreach_sync_state (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);
