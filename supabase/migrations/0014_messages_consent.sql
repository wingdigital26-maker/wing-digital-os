-- ═══════════════════════════════════════════════════════════════════════════
-- 0014_messages_consent.sql — the unified sent-message ledger + SMS consent.
--
-- WHY THIS EXISTS
-- GHL's retirement (2026-08-22) took the last record of "what did we actually
-- send this person". Email now goes out through Apollo and the Wing SMTP pipe,
-- and the Twilio SMS pipe is being built — none of them shared a ledger. This
-- is that ledger: ONE row per message, either channel, either direction, tied
-- to the existing crm_contacts table (0004) when the person is known.
--
-- DESIGN RULES (same as 0004)
--   * NULL means unknown, never zero and never "none".
--   * contact_id is nullable ON PURPOSE: an inbound SMS from a number we have
--     never seen still gets logged. Refusing to store it would silently drop
--     real replies.
--   * client_slug rides on every row so the board can compartmentalize by the
--     client a message was sent FOR. No client name is ever hardcoded.
--   * Nothing in here sends anything. The send endpoint logs BEFORE calling
--     Twilio so a crash mid-send still leaves evidence a send was attempted.
--
-- ACCESS: internal sales data, staff-only RLS exactly like the crm_* tables.
-- Server routes use the service key; no client portal path exists here.
-- ═══════════════════════════════════════════════════════════════════════════

-- ---------- messages ----------
create table if not exists public.messages (
    id                bigserial primary key,
    contact_id        bigint references public.crm_contacts(id) on delete set null,
    client_slug       text,
    channel           text not null check (channel in ('sms', 'email')),
    direction         text not null check (direction in ('outbound', 'inbound')),
    -- E.164 phone numbers for SMS, email addresses for email. Named to_addr /
    -- from_addr because "to" and "from" are miserable SQL identifiers.
    to_addr           text,
    from_addr         text,
    body              text,
    -- queued -> sent -> delivered | failed | undelivered (Twilio's vocabulary,
    -- reused for email so one chip set covers the board). Inbound rows are
    -- 'received'. Not a CHECK constraint: Twilio adds statuses without asking,
    -- and rejecting a status update loses the truth it carried.
    status            text not null default 'queued',
    provider_sid      text,
    error             text,
    created_at        timestamptz not null default now(),
    status_updated_at timestamptz,
    -- When a human looked at an inbound message in the OS. NULL = unread.
    read_at           timestamptz
);

create index if not exists messages_contact_idx  on public.messages (contact_id, created_at desc);
create index if not exists messages_client_idx   on public.messages (client_slug, created_at desc);
create index if not exists messages_created_idx  on public.messages (created_at desc);
create index if not exists messages_sid_idx      on public.messages (provider_sid);
create index if not exists messages_addr_idx     on public.messages (to_addr);
create index if not exists messages_unread_idx   on public.messages (direction, read_at) where read_at is null;

-- ---------- consent ----------
-- The A2P paper trail: who agreed to be texted, when, how, and the proof.
-- A STOP writes a REVOKED row (revoked_at set) rather than deleting the grant,
-- because "they opted out on this date" is itself the compliance record.
-- address is stored alongside contact_id because a STOP arrives as a phone
-- number, which may or may not match a known contact — the revocation must be
-- honored either way.
create table if not exists public.consent (
    id          bigserial primary key,
    contact_id  bigint references public.crm_contacts(id) on delete set null,
    address     text,                 -- the phone (or email) the consent is about
    channel     text not null check (channel in ('sms', 'email')),
    granted_at  timestamptz,
    revoked_at  timestamptz,
    method      text,                 -- how consent was obtained/revoked: web-form, verbal, sms-stop...
    proof       text,                 -- pointer to the evidence (form URL, message id, note)
    created_at  timestamptz not null default now()
);

create index if not exists consent_contact_idx on public.consent (contact_id);
create index if not exists consent_addr_idx    on public.consent (address, channel);

-- ---------- RLS: staff only, matching the crm_* tables in 0004 ----------
alter table public.messages enable row level security;
alter table public.consent  enable row level security;

drop policy if exists messages_read on public.messages;
create policy messages_read on public.messages
  for select using (public.is_staff());
drop policy if exists messages_write on public.messages;
create policy messages_write on public.messages
  for all using (public.is_staff()) with check (public.is_staff());

drop policy if exists consent_read on public.consent;
create policy consent_read on public.consent
  for select using (public.is_staff());
drop policy if exists consent_write on public.consent;
create policy consent_write on public.consent
  for all using (public.is_staff()) with check (public.is_staff());
