-- ═══════════════════════════════════════════════════════════════════════════
-- Send-safety scaffolding for the Sonar project (klzmpjregrcxumaxfsug), which
-- owns the `outbound` table. This is a DIFFERENT database from the OS project
-- (ikgnhieorzjaxtjoneye) that migrations 0001-0005 target, so nothing here can
-- join to crm_contacts. Suppression has to be mirrored in, not referenced.
--
-- Three objects, all serving one rule: a row is sendable only if we can PROVE
-- it is safe, never merely because nothing proved it unsafe.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. Suppression ─────────────────────────────────────────────────────────
-- Addresses that must never receive outbound mail: opted out, bounced, or a
-- client's own inbox. Mirrored from the OS project's crm_contacts.do_not_contact
-- by tools/sync_suppression.py, because Postgres cannot join across projects.
create table if not exists public.suppression (
    email      text primary key,
    reason     text,
    source     text,
    added_at   timestamptz not null default now()
);

comment on table public.suppression is
  'Do-not-contact addresses. Mirrored from the OS project. An empty table is NOT
   a licence to send: the export route treats an unreachable or unpopulated list
   as a reason to refuse.';

-- ── 2. Client send policy ──────────────────────────────────────────────────
-- Whether Wing is contractually permitted to send outbound ON BEHALF OF a given
-- client. This is not a preference toggle, it is contract scope expressed as
-- data. Hero's Junk Removal signed for SEO plus social and email TRACKING only:
-- their client page states "No outbound sending on their behalf". Enforcing that
-- in a policy document alone means one forgotten check breaches the agreement,
-- so it is enforced here instead.
--
-- DEFAULT DENY. A client absent from this table cannot send. Adding a client is
-- a deliberate act that should follow a real signed scope.
create table if not exists public.client_send_policy (
    client        text primary key,   -- matches outbound.client exactly
    may_send      boolean not null default false,
    scope_note    text,
    updated_at    timestamptz not null default now()
);

comment on table public.client_send_policy is
  'Contract scope as data. Absent client = may not send. Never default a new
   client to true.';

insert into public.client_send_policy (client, may_send, scope_note) values
  ('Hero''s Junk Removal', false,
   'Signed scope is SEO and content plus social and email TRACKING. Their client
    page states: "No outbound sending on their behalf. Wing does not cold-email
    for Hero''s." Do not flip this without a written scope change from the client.'),
  ('Jackson Roofing', true,
   'No outbound restriction recorded on their client page.'),
  ('Brilliant Fulfillment', false,
   'Outbound scope not confirmed. Holding at deny until Jack confirms, rather
    than assuming permission from the presence of drafted email rows.'),
  ('Northcomm Technologies', false,
   'App build engagement. No outreach scope on file.')
on conflict (client) do nothing;

-- ── 3. The sendable view ───────────────────────────────────────────────────
-- The ONLY thing /api/outbound/export reads. Every condition is a safety gate,
-- and each is written as a positive proof rather than an absence of evidence.
create or replace view public.outbound_sendable as
select
    o.id,
    o.id                as pid,        -- stable row identity for the sender's log
    o.client,
    o.channel,
    o.recipient         as "to",
    o.subject,
    o.body,
    o.tier,
    o.created_at,
    o.reviewed_at
from public.outbound o
join public.client_send_policy p
      on p.client = o.client
     and p.may_send is true            -- contract scope, default deny
where o.status = 'approved'            -- a human approved this exact row
  and o.direction = 'outbound'
  and o.channel = 'email'              -- social replies are posted, never mailed
  and o.recipient is not null
  and btrim(o.recipient) <> ''
  and o.recipient ~* '^[^@[:space:]]+@[^@[:space:]]+\.[a-z]{2,}$'
  and o.body is not null
  and btrim(o.body) <> ''              -- never send an empty message
  and o.sent_at is null                -- not already sent
  and lower(btrim(o.recipient)) not in (
        select lower(btrim(s.email)) from public.suppression s
      );

comment on view public.outbound_sendable is
  'Rows proven safe to send. Joins client_send_policy so a client without
   explicit permission can never appear here regardless of row status.';

revoke all on public.outbound_sendable from anon, authenticated;
grant select on public.outbound_sendable to service_role;
revoke all on public.suppression from anon, authenticated;
revoke all on public.client_send_policy from anon, authenticated;
