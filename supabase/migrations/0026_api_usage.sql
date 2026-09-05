-- 0026_api_usage.sql -- bucketed rate-limit + daily spend ceiling counters.
--
-- WHY: docs/lecture_rate_limit.sql gave the lecture summariser a fail-closed
-- daily call and dollar cap. Jarvis (app/api/jarvis) now spends Anthropic money
-- from Vercel too and needs the same protection. The lecture table has no
-- bucket column, so putting Jarvis rows in it would count Jarvis calls against
-- the lecture route's 30/day global cap and break it. This is the same design
-- with one extra column: `bucket`. Every counter, cap and settle is scoped to
-- a bucket, so "jarvis" and any future money-spending route never see each
-- other's numbers.
--
-- Same guarantees as the lecture limiter: one plpgsql function under an
-- advisory transaction lock, PRE-CHARGE of the estimated cost, settle after.
-- Service key only: RLS on, no policies. Idempotent, safe to re-run.

create table if not exists public.api_usage (
  bucket      text        not null,
  day         date        not null,
  ip          text        not null,
  calls       integer     not null default 0,
  spend       numeric(12,6) not null default 0,
  win_start   timestamptz not null default now(),
  win_calls   integer     not null default 0,
  updated_at  timestamptz not null default now(),
  primary key (bucket, day, ip)
);
alter table public.api_usage enable row level security;

create or replace function public.api_rate_reserve(
  p_bucket      text,
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
  -- one lock per bucket so buckets never serialize each other
  perform pg_advisory_xact_lock(hashtext('api_usage:' || p_bucket));

  delete from api_usage where day < current_date - 7;

  select coalesce(sum(calls), 0), coalesce(sum(spend), 0)
    into v_day_calls, v_day_spend
    from api_usage where bucket = p_bucket and day = current_date;

  select u.calls, u.win_start, u.win_calls
    into v_ip_calls, v_win_start, v_win_calls
    from api_usage u
   where u.bucket = p_bucket and u.day = current_date and u.ip = p_ip;

  v_ip_calls  := coalesce(v_ip_calls, 0);
  v_win_calls := coalesce(v_win_calls, 0);
  if v_win_start is null or v_win_start < now() - make_interval(secs => p_burst_secs) then
    v_win_start := now();
    v_win_calls := 0;
  end if;

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

  insert into api_usage as u (bucket, day, ip, calls, spend, win_start, win_calls, updated_at)
  values (p_bucket, current_date, p_ip, 1, p_est, v_win_start, 1, now())
  on conflict (bucket, day, ip) do update
    set calls      = u.calls + 1,
        spend      = u.spend + p_est,
        win_start  = v_win_start,
        win_calls  = v_win_calls + 1,
        updated_at = now();

  return query select true, 'ok'::text, 0, v_ip_calls + 1, v_day_calls + 1, v_day_spend + p_est;
end;
$$;

create or replace function public.api_rate_settle(p_bucket text, p_ip text, p_delta numeric)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update api_usage
     set spend = greatest(0, spend + p_delta), updated_at = now()
   where bucket = p_bucket and day = current_date and ip = p_ip;
end;
$$;

revoke all on function public.api_rate_reserve(text, text, integer, integer, integer, integer, numeric, numeric) from public, anon, authenticated;
revoke all on function public.api_rate_settle(text, text, numeric) from public, anon, authenticated;
grant execute on function public.api_rate_reserve(text, text, integer, integer, integer, integer, numeric, numeric) to service_role;
grant execute on function public.api_rate_settle(text, text, numeric) to service_role;
