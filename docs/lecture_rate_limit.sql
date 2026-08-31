-- Rate-limit + spend-ceiling counters for app/api/lecture/summarize.
--
-- WHY THIS EXISTS: the summarize route spends real Anthropic money per call and
-- is reachable with a bearer token that necessarily lives in browser
-- localStorage on a PUBLIC GitHub Pages origin. Vercel functions are stateless
-- and horizontally scaled, so an in-process counter would only limit ONE
-- instance. This table is the shared, durable counter every instance agrees on.
--
-- APPLY THIS TO THE OS SUPABASE PROJECT (ikgnhieorzjaxtjoneye) BEFORE SETTING
-- LECTURE_API_SECRET IN VERCEL. Until it exists the route fails CLOSED (503):
-- refusing a lecture summary is cheaper than an uncapped spend.
--
-- Idempotent: safe to re-run.

create table if not exists public.lecture_usage (
  day         date        not null,
  ip          text        not null,
  calls       integer     not null default 0,
  spend       numeric(12,6) not null default 0,
  win_start   timestamptz not null default now(),  -- short burst window start
  win_calls   integer     not null default 0,
  updated_at  timestamptz not null default now(),
  primary key (day, ip)
);

-- No policies are defined on purpose. Only the service key (which bypasses RLS)
-- touches this table; anon/authenticated get nothing.
alter table public.lecture_usage enable row level security;

-- Reserve one call slot, atomically, across every serverless instance.
--
-- Everything happens under one advisory transaction lock, so concurrent
-- requests are serialized and the caps are true global caps, not per-instance
-- approximations.
--
-- p_est is a PRE-CHARGE of the estimated dollar cost. The real cost is only
-- known after the model answers, so we charge an estimate up front and settle
-- the difference afterwards with lecture_rate_settle(). That is what keeps a
-- burst of concurrent calls from all reading the same "spend so far" and
-- collectively blowing past the ceiling.
create or replace function public.lecture_rate_reserve(
  p_ip          text,
  p_burst_limit integer,
  p_burst_secs  integer,
  p_ip_limit    integer,
  p_day_limit   integer,
  p_spend_limit numeric,
  p_est         numeric
)
returns table (
  allowed     boolean,
  reason      text,
  retry_after integer,
  ip_calls    integer,
  day_calls   integer,
  day_spend   numeric
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_day_calls  integer := 0;
  v_day_spend  numeric := 0;
  v_ip_calls   integer := 0;
  v_win_start  timestamptz;
  v_win_calls  integer := 0;
  v_midnight   integer;
begin
  perform pg_advisory_xact_lock(802451771);

  delete from lecture_usage where day < current_date - 7;

  select coalesce(sum(calls), 0), coalesce(sum(spend), 0)
    into v_day_calls, v_day_spend
    from lecture_usage where day = current_date;

  select u.calls, u.win_start, u.win_calls
    into v_ip_calls, v_win_start, v_win_calls
    from lecture_usage u
   where u.day = current_date and u.ip = p_ip;

  v_ip_calls  := coalesce(v_ip_calls, 0);
  v_win_calls := coalesce(v_win_calls, 0);
  if v_win_start is null or v_win_start < now() - make_interval(secs => p_burst_secs) then
    v_win_start := now();
    v_win_calls := 0;
  end if;

  -- seconds until the daily counters roll over (UTC midnight)
  v_midnight := greatest(
    1,
    ceil(extract(epoch from ((current_date + 1)::timestamptz - now())))::integer
  );

  if v_win_calls >= p_burst_limit then
    return query select false, 'burst'::text,
      greatest(1, ceil(extract(epoch from (v_win_start + make_interval(secs => p_burst_secs) - now())))::integer),
      v_ip_calls, v_day_calls, v_day_spend;
    return;
  elsif v_ip_calls >= p_ip_limit then
    return query select false, 'ip_daily'::text, v_midnight, v_ip_calls, v_day_calls, v_day_spend;
    return;
  elsif v_day_calls >= p_day_limit then
    return query select false, 'global_daily'::text, v_midnight, v_ip_calls, v_day_calls, v_day_spend;
    return;
  elsif v_day_spend + p_est > p_spend_limit then
    return query select false, 'spend'::text, v_midnight, v_ip_calls, v_day_calls, v_day_spend;
    return;
  end if;

  insert into lecture_usage as u (day, ip, calls, spend, win_start, win_calls, updated_at)
  values (current_date, p_ip, 1, p_est, v_win_start, 1, now())
  on conflict (day, ip) do update
    set calls      = u.calls + 1,
        spend      = u.spend + p_est,
        win_start  = v_win_start,
        win_calls  = v_win_calls + 1,
        updated_at = now();

  return query select true, 'ok'::text, 0, v_ip_calls + 1, v_day_calls + 1, v_day_spend + p_est;
end;
$$;

-- Reconcile the pre-charged estimate against what the call actually cost.
-- p_delta = actual - estimate, and is negative when the call was cheaper than
-- estimated or failed outright. Spend is clamped at zero.
create or replace function public.lecture_rate_settle(p_ip text, p_delta numeric)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update lecture_usage
     set spend = greatest(0, spend + p_delta), updated_at = now()
   where day = current_date and ip = p_ip;
end;
$$;

revoke all on function public.lecture_rate_reserve(text, integer, integer, integer, integer, numeric, numeric) from public, anon, authenticated;
revoke all on function public.lecture_rate_settle(text, numeric) from public, anon, authenticated;
grant execute on function public.lecture_rate_reserve(text, integer, integer, integer, integer, numeric, numeric) to service_role;
grant execute on function public.lecture_rate_settle(text, numeric) to service_role;
