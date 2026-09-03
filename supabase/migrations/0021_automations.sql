-- ═══════════════════════════════════════════════════════════════════════════
-- 0021_automations.sql — the trigger-to-action layer (the part of GoHighLevel
-- that was actually GoHighLevel).
--
-- WHY THIS EXISTS
-- By 2026-09-01 the OS had every GHL *noun* back: contacts, deals, messages,
-- bookings, sequences. What it did not have was the *verb*: "when X happens,
-- do Y" with nobody at the keyboard. A form on a client site, a missed call
-- on a client number, a booking, a stage change -- none of them could cause
-- anything. This migration adds:
--
--   events               every fact the OS notices, one row each, append-only
--   workflows            "when <trigger> then <actions>", per client or Wing
--   workflow_actions     ordered steps of a workflow, config in jsonb
--   workflow_runs        one row per (workflow, event); UNIQUE = idempotent
--   forms                lead-capture forms a client site posts to
--   form_submissions     the raw submission, forever, before any parsing
--   contact_tags         GHL-style tags on crm_contacts
--   tasks                follow-ups a workflow (or a human) creates
--   phone_calls          the voice ledger (missed-call text-back needs it)
--   voice_numbers        which Twilio number belongs to which client
--
-- DESIGN RULES (same as 0004 / 0014)
--   * NULL means unknown. Never zero, never "none".
--   * Nothing in here sends anything. The engine that reads these tables
--     writes DRAFT messages unless AUTOMATION_SEND_ENABLED is set on the
--     deployment AND the workflow is active AND the person has not opted out.
--   * A run row is created BEFORE its actions execute, so a crash mid-run
--     leaves evidence, and the UNIQUE (workflow_id, event_id) means the same
--     event can never fire the same workflow twice, whatever retries happen.
--   * Staff-only RLS everywhere. Public writes (forms, Twilio) go through
--     server routes with the service key that validate and rate-limit.
--
-- Runs against the OS Supabase project (OS_SUPABASE_*), NOT Sonar.
-- ═══════════════════════════════════════════════════════════════════════════

-- ---------- events ----------
create table if not exists public.events (
    id            bigserial primary key,
    -- dotted vocabulary, see lib/automations/types.ts EVENT_TYPES:
    --   form.submitted | contact.created | booking.created | sms.received |
    --   call.missed | call.logged | deal.stage_changed | task.completed | manual.trigger
    type          text not null,
    client_slug   text,
    contact_id    bigint references public.crm_contacts(id) on delete set null,
    payload       jsonb not null default '{}'::jsonb,
    occurred_at   timestamptz not null default now(),
    -- set when the engine has evaluated every workflow for it (even if none matched)
    processed_at  timestamptz,
    created_at    timestamptz not null default now()
);
create index if not exists events_unprocessed_idx on public.events (created_at) where processed_at is null;
create index if not exists events_type_idx on public.events (type, created_at desc);
create index if not exists events_contact_idx on public.events (contact_id, created_at desc);

-- ---------- workflows ----------
create table if not exists public.workflows (
    id             uuid primary key default gen_random_uuid(),
    name           text not null,
    -- which client this automation runs FOR; null = Wing Digital itself
    client_slug    text,
    -- draft | active | paused. Only active workflows ever run.
    status         text not null default 'draft'
                   check (status in ('draft', 'active', 'paused')),
    trigger_type   text not null,
    -- optional narrowing, e.g. {"form_slug":"contact"} {"outcome":"booked"}
    -- {"stage_key":"booked"}. Empty object = every event of that type.
    trigger_filter jsonb not null default '{}'::jsonb,
    description    text,
    created_at     timestamptz not null default now(),
    updated_at     timestamptz not null default now()
);
create index if not exists workflows_trigger_idx on public.workflows (trigger_type, status);

create table if not exists public.workflow_actions (
    id           uuid primary key default gen_random_uuid(),
    workflow_id  uuid not null references public.workflows(id) on delete cascade,
    step_order   int  not null,
    -- see lib/automations/types.ts ACTION_TYPES
    action_type  text not null,
    config       jsonb not null default '{}'::jsonb,
    created_at   timestamptz not null default now(),
    unique (workflow_id, step_order)
);

create table if not exists public.workflow_runs (
    id           bigserial primary key,
    workflow_id  uuid not null references public.workflows(id) on delete cascade,
    event_id     bigint not null references public.events(id) on delete cascade,
    contact_id   bigint references public.crm_contacts(id) on delete set null,
    -- running | done | failed | skipped
    status       text not null default 'running',
    -- [{step_order, action_type, ok, note}] appended per action
    log          jsonb not null default '[]'::jsonb,
    error        text,
    started_at   timestamptz not null default now(),
    finished_at  timestamptz,
    unique (workflow_id, event_id)
);
create index if not exists workflow_runs_recent_idx on public.workflow_runs (started_at desc);

-- ---------- forms ----------
create table if not exists public.forms (
    id            uuid primary key default gen_random_uuid(),
    -- URL slug a site posts to: /api/forms/<slug>. Letters, digits, dashes.
    slug          text not null unique,
    name          text not null,
    client_slug   text,
    -- [{key, label, type, required}] purely descriptive; the endpoint accepts
    -- any fields and stores them all in form_submissions.data.
    fields        jsonb not null default '[]'::jsonb,
    -- where an HTML (non-fetch) post is redirected after success
    redirect_url  text,
    -- active | paused. A paused form answers 410 and stores nothing.
    status        text not null default 'active'
                  check (status in ('active', 'paused')),
    submissions   int not null default 0,
    created_at    timestamptz not null default now(),
    updated_at    timestamptz not null default now()
);

create table if not exists public.form_submissions (
    id           bigserial primary key,
    form_id      uuid not null references public.forms(id) on delete cascade,
    contact_id   bigint references public.crm_contacts(id) on delete set null,
    data         jsonb not null,
    ip           text,
    user_agent   text,
    source_url   text,
    created_at   timestamptz not null default now()
);
create index if not exists form_submissions_form_idx on public.form_submissions (form_id, created_at desc);

-- ---------- tags ----------
create table if not exists public.contact_tags (
    contact_id   bigint not null references public.crm_contacts(id) on delete cascade,
    tag          text not null,
    created_at   timestamptz not null default now(),
    primary key (contact_id, tag)
);
create index if not exists contact_tags_tag_idx on public.contact_tags (tag);

-- ---------- tasks ----------
create table if not exists public.tasks (
    id             bigserial primary key,
    contact_id     bigint references public.crm_contacts(id) on delete cascade,
    deal_id        bigint references public.crm_deals(id) on delete set null,
    client_slug    text,
    title          text not null,
    body           text,
    due_at         timestamptz,
    done_at        timestamptz,
    assigned_email text,
    -- workflow:<uuid> | os-ui | script
    source         text,
    created_at     timestamptz not null default now()
);
create index if not exists tasks_open_idx on public.tasks (due_at) where done_at is null;

-- ---------- voice ----------
create table if not exists public.voice_numbers (
    -- the Twilio number in E.164
    number        text primary key,
    client_slug   text,
    -- where inbound calls ring (the owner's cell), E.164
    forward_to    text,
    -- spoken before the dial; null = ring straight through
    greeting      text,
    -- seconds to ring forward_to before it counts as missed
    ring_seconds  int not null default 20,
    created_at    timestamptz not null default now()
);

create table if not exists public.phone_calls (
    id             bigserial primary key,
    provider_sid   text unique,
    contact_id     bigint references public.crm_contacts(id) on delete set null,
    client_slug    text,
    direction      text not null check (direction in ('inbound', 'outbound')),
    from_number    text,
    to_number      text,
    -- ringing | in-progress | completed | missed | busy | failed | no-answer | voicemail
    status         text not null default 'ringing',
    duration_sec   int,
    recording_url  text,
    started_at     timestamptz not null default now(),
    ended_at       timestamptz
);
create index if not exists phone_calls_recent_idx on public.phone_calls (started_at desc);
create index if not exists phone_calls_from_idx on public.phone_calls (from_number);

-- ---------- updated_at maintenance (reuses 0004's function) ----------
drop trigger if exists workflows_touch on public.workflows;
create trigger workflows_touch before update on public.workflows
  for each row execute function public.crm_touch_updated_at();
drop trigger if exists forms_touch on public.forms;
create trigger forms_touch before update on public.forms
  for each row execute function public.crm_touch_updated_at();

-- ---------- RLS: staff only, every table ----------
do $$
declare t text;
begin
  foreach t in array array[
    'events','workflows','workflow_actions','workflow_runs','forms',
    'form_submissions','contact_tags','tasks','voice_numbers','phone_calls'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I_staff on public.%I', t, t);
    execute format(
      'create policy %I_staff on public.%I for all using (public.is_staff()) with check (public.is_staff())',
      t, t
    );
  end loop;
end $$;
