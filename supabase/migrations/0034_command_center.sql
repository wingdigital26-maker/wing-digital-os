-- Wing Command Center (team dashboard at /command).
--
-- Plain Postgres on purpose: it runs on ANY Postgres the adapter is pointed at
-- (a new Supabase project, Vercel Postgres / Neon, or the OS project once its
-- REST restriction is lifted). lib/command/db.ts applies this same SQL on first
-- use, so running it by hand is optional. Every statement is idempotent.
--
-- No row here is ever shown to anyone without a Command Center login.

create table if not exists cc_prospects (
  id              text primary key,          -- 'db:<prospects.db id>' or 'csv:<hash>'
  business        text not null,
  contact         text,
  phone           text,
  email           text,
  website         text,
  city            text,
  niche           text,
  source          text,                      -- 'laptop-sync' | 'csv' | batch tag
  hook            text,                      -- a line to open the call with
  last_outcome    text,                      -- latest outcome, denormalised for the list
  last_called_at  timestamptz,
  next_call_date  date,
  notes           text,
  archived        boolean not null default false,
  imported_at     timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists cc_prospects_next on cc_prospects (next_call_date);

create table if not exists cc_call_outcomes (
  id              bigserial primary key,
  prospect_id     text not null references cc_prospects(id) on delete cascade,
  outcome         text not null check (outcome in ('no_answer','voicemail','call_back','meeting','not_interested')),
  note            text,
  next_call_date  date,
  by_user         text not null,
  created_at      timestamptz not null default now()
);
create index if not exists cc_call_outcomes_at on cc_call_outcomes (created_at desc);

create table if not exists cc_client_meta (
  slug            text primary key,
  display_name    text,
  plan            text,
  mrr             numeric,
  crm_url         text,
  next_action     text,
  is_roofer       boolean,
  roofer_contact  text,
  roofer_phone    text,
  active          boolean not null default true,
  updated_by      text,
  updated_at      timestamptz not null default now()
);

create table if not exists cc_roofer_touches (
  id              bigserial primary key,
  client_slug     text not null,
  channel         text not null check (channel in ('call','text','visit')),
  mood            text not null check (mood in ('happy','ok','unhappy')),
  problems        text,
  note            text,
  problem_id      bigint,
  by_user         text not null,
  created_at      timestamptz not null default now()
);
create index if not exists cc_roofer_touches_client on cc_roofer_touches (client_slug, created_at desc);

create table if not exists cc_problems (
  id              bigserial primary key,
  client_slug     text,
  reported_by     text not null,
  urgency         text not null default 'normal' check (urgency in ('low','normal','urgent')),
  body            text not null,
  screenshot      text,                      -- data: URL, served only through the gated API
  status          text not null default 'open' check (status in ('open','working','fixed')),
  owner           text,
  source          text not null default 'manual',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  fixed_at        timestamptz
);
create index if not exists cc_problems_status on cc_problems (status, created_at desc);

create table if not exists cc_problem_comments (
  id              bigserial primary key,
  problem_id      bigint not null references cc_problems(id) on delete cascade,
  by_user         text not null,
  body            text not null,
  created_at      timestamptz not null default now()
);

create table if not exists cc_website_jobs (
  id              bigserial primary key,
  client          text not null,
  brief_url       text,
  status          text not null default 'brief_sent' check (status in ('brief_sent','building','review','delivered','cancelled')),
  due_date        date,
  delivered_url   text,
  delivered_at    date,
  paid            boolean not null default false,
  price           numeric,
  notes           text,
  created_by      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create table if not exists cc_deals (
  id              bigserial primary key,
  business        text not null,
  contact         text,
  phone           text,
  email           text,
  stage           text not null default 'lead' check (stage in ('lead','meeting','proposal','signed','onboarding','live','lost')),
  product         text,                      -- 'roof-command' | 'seo' | 'website' | free text
  value_monthly   numeric,
  owner           text,
  notes           text,
  client_slug     text,                      -- set once live, links to the vault client
  prospect_id     text,
  created_at      timestamptz not null default now(),
  stage_changed_at timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create table if not exists cc_onboarding (
  deal_id         bigint not null references cc_deals(id) on delete cascade,
  item_key        text not null,
  done            boolean not null default false,
  done_by         text,
  done_at         timestamptz,
  primary key (deal_id, item_key)
);

create table if not exists cc_billing (
  client_key      text primary key,          -- vault slug, or 'deal:<id>'
  status          text not null check (status in ('paid','due','late')),
  amount          numeric,
  due_date        date,
  note            text,
  updated_by      text,
  updated_at      timestamptz not null default now()
);

create table if not exists cc_checks (
  id              bigserial primary key,
  client_slug     text not null,
  color           text not null,             -- green | yellow | red | unknown
  checked_at      timestamptz,               -- when sentinel wrote the page
  stale           boolean not null default false,
  summary         text,
  recorded_at     timestamptz not null default now()
);
create index if not exists cc_checks_client on cc_checks (client_slug, recorded_at desc);

create table if not exists cc_agent_runs (
  id              bigserial primary key,
  agent           text not null,
  client_slug     text,
  status          text not null,             -- ok | failed | skipped
  published       integer,
  note            text,
  ran_at          timestamptz not null default now()
);
create index if not exists cc_agent_runs_agent on cc_agent_runs (agent, ran_at desc);

create table if not exists cc_weekly_numbers (
  week_start      date not null,
  person          text not null,
  metric          text not null,
  value           numeric not null,
  updated_by      text,
  updated_at      timestamptz not null default now(),
  primary key (week_start, person, metric)
);

create table if not exists cc_notifications (
  id              bigserial primary key,
  kind            text not null,
  body            text not null,
  result          jsonb,
  created_at      timestamptz not null default now()
);
