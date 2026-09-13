-- =====================================================================
-- ARB online, part 2: anti-cheat
--
-- Run once in the Supabase SQL editor, AFTER schema.sql.
--
--   1. Proof   scores arrive only through the submit-run Edge Function, which
--              re-checks level boards; the record_* functions below can only
--              be called by that function (service_role).
--   2. Tickets a run asks for a ticket when it starts (start_run); a result
--              must spend an unused ticket, and can't claim more time than has
--              passed since the ticket was issued.
--   3. Review  suspicious results are stored but FLAGGED, and held off the
--              boards until reviewed. Players can be hidden, reported, and are
--              rate limited.
--   4. Ranked  only real (non-guest) accounts appear on the boards. Guest
--              scores are kept and count once the guest adds an email.
--
-- Reviewing (SQL editor):
--   select * from admin.review;          -- flagged results
--   select * from admin.open_reports;    -- player reports
--   approve a result:  update public.game_bests set flagged = false, flags = '{}'
--                        where user_id = '<id>' and mode = '<mode>';
--                      (same for public.level_records / public.daily_results)
--   hide a player:     update public.profiles set hidden = true where nickname = '<name>';
--   close reports:     update public.reports set resolved = true where target = '<id>';
-- =====================================================================

-- ---------------------------------------------------------------------
-- The old write path: replaced by tickets + submit-run
-- ---------------------------------------------------------------------
drop function if exists public.submit_level(text, numeric);
drop function if exists public.submit_daily(date, jsonb);
drop function if exists public.submit_score(text, int);
drop function if exists public.start_daily(date);

-- ---------------------------------------------------------------------
-- New columns
-- ---------------------------------------------------------------------
alter table public.profiles add column hidden boolean not null default false;

alter table public.level_records
  add column flagged boolean not null default false,
  add column flags text[] not null default '{}';
alter table public.daily_results
  add column flagged boolean not null default false,
  add column flags text[] not null default '{}',
  add column run_id uuid;
alter table public.game_bests
  add column flagged boolean not null default false,
  add column flags text[] not null default '{}';

-- min_seconds: a run shorter than this is rejected.
-- rate_cap:    points per second above this is flagged (null = no check).
alter table public.game_modes
  add column min_seconds int not null default 5,
  add column rate_cap numeric;

update public.game_modes set min_seconds = 40, rate_cap = 120 where id = 'rush';
update public.game_modes set min_seconds = 15, rate_cap = 120 where id in ('memory', 'copy', 'balance');
update public.game_modes set min_seconds = 40 where id = 'pop';

-- ---------------------------------------------------------------------
-- Run tickets
-- ---------------------------------------------------------------------
create table public.runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  mode text not null,                       -- 'level' | 'daily' | game_modes.id
  level_id text references public.levels(id),
  day date,
  started_at timestamptz not null default now(),
  used_at timestamptz
);
create index runs_user_recent_idx on public.runs (user_id, started_at desc);
alter table public.runs enable row level security;   -- no policies: functions only

create function public.start_run(p_mode text, p_level_id text default null, p_day date default null)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_id uuid := gen_random_uuid();
  v_today date := (now() at time zone 'utc')::date;
  v_recent int;
  v_ranked boolean := true;
begin
  if v_uid is null then raise exception 'Not signed in'; end if;

  if p_mode = 'level' then
    if not exists (select 1 from public.levels where id = p_level_id) then raise exception 'Unknown level'; end if;
  elsif p_mode = 'daily' then
    if p_day is null or p_day not between v_today - 1 and v_today + 1 then raise exception 'That daily is not open'; end if;
  elsif not exists (select 1 from public.game_modes where id = p_mode and ranked) then
    raise exception 'No leaderboard for that mode';
  end if;

  select count(*) into v_recent from public.runs
   where user_id = v_uid and started_at > now() - interval '10 minutes';
  if v_recent >= 60 then raise exception 'Too many runs started. Take a short break.'; end if;

  -- The daily's first ticket is the only one that can ever be ranked.
  if p_mode = 'daily' then
    insert into public.daily_results (user_id, day, run_id) values (v_uid, p_day, v_id)
    on conflict do nothing;
    v_ranked := found;
  end if;

  insert into public.runs (id, user_id, mode, level_id, day)
  values (v_id, v_uid, p_mode, case when p_mode = 'level' then p_level_id end, p_day);

  delete from public.runs where user_id = v_uid and started_at < now() - interval '1 day';

  return jsonb_build_object('run', case when v_ranked then v_id end, 'ranked', v_ranked);
end $$;

-- Spend a ticket. Internal: called by the record_* functions.
create function public.claim_run(p_user uuid, p_run uuid, p_mode text) returns public.runs
language plpgsql security definer set search_path = '' as $$
declare v_run public.runs;
begin
  select * into v_run from public.runs where id = p_run and user_id = p_user for update;
  if not found then raise exception 'Unknown run'; end if;
  if v_run.mode <> p_mode then raise exception 'Wrong run'; end if;
  if v_run.used_at is not null then raise exception 'Run already submitted'; end if;
  update public.runs set used_at = now() where id = p_run;
  return v_run;
end $$;

-- True when this user counts on the boards: a real account, not hidden.
create function public.is_ranked_player(p_user uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.profiles p join auth.users u on u.id = p.id
    where p.id = p_user and not p.hidden and not coalesce(u.is_anonymous, false)
  )
$$;

-- ---------------------------------------------------------------------
-- Recording results (submit-run only)
-- ---------------------------------------------------------------------
create function public.record_level(
  p_user uuid, p_run uuid, p_level_id text, p_seconds numeric, p_flags text[] default '{}'
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_run public.runs;
  v_lv public.levels;
  v_secs numeric := round(p_seconds, 1);
  v_pts int;
  v_stars smallint;
  v_flags text[] := coalesce(p_flags, '{}');
  v_others int;
  v_best numeric;
  v_prev public.level_records;
  v_rec public.level_records;
  v_improves boolean;
begin
  v_run := public.claim_run(p_user, p_run, 'level');
  if v_run.level_id is distinct from p_level_id then raise exception 'Wrong run'; end if;

  select * into v_lv from public.levels where id = p_level_id;
  if p_seconds is null or p_seconds < 0.5 or p_seconds > v_lv.par * 2.5 then raise exception 'Invalid time'; end if;
  if extract(epoch from now() - v_run.started_at) + 2 < p_seconds then raise exception 'Invalid time'; end if;

  v_pts := public.level_points(v_lv.points, v_lv.par, p_seconds);
  v_stars := public.level_stars(v_lv.par, p_seconds);

  -- Twice as fast as the best ranked time, with a few people on the board.
  select count(*), min(lr.best_time) into v_others, v_best
    from public.level_records lr
   where lr.level_id = p_level_id and not lr.flagged and lr.user_id <> p_user
     and public.is_ranked_player(lr.user_id);
  if v_others >= 3 and v_secs < v_best * 0.5 then v_flags := v_flags || 'outlier'::text; end if;

  select * into v_prev from public.level_records where user_id = p_user and level_id = p_level_id;
  -- A suspicious run only taints the record if it is what set the record.
  v_improves := v_prev.user_id is null or v_pts > v_prev.best_points or v_secs < v_prev.best_time;

  insert into public.level_records as r (user_id, level_id, best_points, best_time, stars, flagged, flags)
  values (p_user, p_level_id, v_pts, v_secs, v_stars, cardinality(v_flags) > 0, v_flags)
  on conflict (user_id, level_id) do update set
    best_points = greatest(r.best_points, excluded.best_points),
    best_time   = least(r.best_time, excluded.best_time),
    stars       = greatest(r.stars, excluded.stars),
    plays       = r.plays + 1,
    updated_at  = now(),
    flagged     = r.flagged or (v_improves and excluded.flagged),
    flags       = case when v_improves and excluded.flagged
                       then array(select distinct unnest(r.flags || excluded.flags)) else r.flags end
  returning * into v_rec;

  return jsonb_build_object(
    'points', v_pts, 'stars', v_stars,
    'new_best', v_prev.user_id is not null and v_pts > v_prev.best_points,
    'best_points', v_rec.best_points, 'best_time', v_rec.best_time, 'best_stars', v_rec.stars,
    'flagged', v_rec.flagged);
end $$;

create function public.record_daily(
  p_user uuid, p_run uuid, p_day date, p_runs jsonb, p_flags text[] default '{}'
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_run public.runs;
  v_row public.daily_results;
  v_item jsonb;
  v_lv public.levels;
  v_secs numeric;
  v_score int := 0;
  v_built int := 0;
  v_stars smallint[] := '{}';
  v_total_secs numeric := 0;
  v_flags text[] := coalesce(p_flags, '{}');
  v_others int;
  v_top int;
begin
  v_run := public.claim_run(p_user, p_run, 'daily');
  if v_run.day is distinct from p_day then raise exception 'Wrong run'; end if;

  select * into v_row from public.daily_results where user_id = p_user and day = p_day for update;
  if not found or v_row.run_id is distinct from p_run then
    raise exception 'Only your first attempt at a daily is ranked';
  end if;
  if v_row.finished_at is not null then raise exception 'Daily already submitted'; end if;
  if jsonb_typeof(p_runs) <> 'array' or jsonb_array_length(p_runs) <> 5 then
    raise exception 'Invalid daily result';
  end if;

  -- submit-run has already matched the levels to the day's draw.
  for v_item in select e from jsonb_array_elements(p_runs) with ordinality as t(e, n) order by n loop
    select * into v_lv from public.levels where id = v_item->>'level_id';
    if not found then raise exception 'Invalid daily levels'; end if;
    if jsonb_typeof(v_item->'seconds') is distinct from 'number' then
      v_stars := v_stars || 0::smallint;
    else
      v_secs := (v_item->>'seconds')::numeric;
      if v_secs < 0.5 or v_secs > v_lv.par * 2.5 then raise exception 'Invalid time'; end if;
      v_score := v_score + public.level_points(v_lv.points, v_lv.par, v_secs);
      v_stars := v_stars || public.level_stars(v_lv.par, v_secs);
      v_built := v_built + 1;
      v_total_secs := v_total_secs + v_secs;
    end if;
  end loop;

  if extract(epoch from now() - v_run.started_at) + 5 < v_total_secs then
    raise exception 'Invalid time';
  end if;

  select count(*), max(d.score) into v_others, v_top
    from public.daily_results d
   where d.day = p_day and d.finished_at is not null and not d.flagged and d.user_id <> p_user
     and public.is_ranked_player(d.user_id);
  if v_others >= 3 and v_score > 2 * v_top then v_flags := v_flags || 'outlier'::text; end if;

  update public.daily_results
     set finished_at = now(), score = v_score, built = v_built, stars = v_stars,
         total_stars = (select sum(x) from unnest(v_stars) as x),
         flagged = cardinality(v_flags) > 0, flags = v_flags
   where user_id = p_user and day = p_day;

  return jsonb_build_object('score', v_score, 'built', v_built, 'stars', to_jsonb(v_stars),
                            'flagged', cardinality(v_flags) > 0);
end $$;

create function public.record_score(
  p_user uuid, p_run uuid, p_mode text, p_score int, p_flags text[] default '{}'
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_run public.runs;
  v_gm public.game_modes;
  v_elapsed numeric;
  v_flags text[] := coalesce(p_flags, '{}');
  v_others int;
  v_top int;
  v_prev int;
  v_improves boolean;
  v_rec public.game_bests;
begin
  v_run := public.claim_run(p_user, p_run, p_mode);
  select * into v_gm from public.game_modes where id = p_mode and ranked;
  if not found then raise exception 'No leaderboard for that mode'; end if;
  if p_score is null or p_score < 0 or p_score > v_gm.score_cap then raise exception 'Invalid score'; end if;

  v_elapsed := extract(epoch from now() - v_run.started_at);
  if v_elapsed < v_gm.min_seconds then raise exception 'Too quick to be a real run'; end if;
  if v_gm.rate_cap is not null and p_score / greatest(v_elapsed, 1) > v_gm.rate_cap then
    v_flags := v_flags || 'rate'::text;
  end if;

  select count(*), max(g.best) into v_others, v_top
    from public.game_bests g
   where g.mode = p_mode and not g.flagged and g.user_id <> p_user
     and public.is_ranked_player(g.user_id);
  if v_others >= 3 and p_score > 2 * v_top then v_flags := v_flags || 'outlier'::text; end if;

  select best into v_prev from public.game_bests where user_id = p_user and mode = p_mode;
  v_improves := v_prev is null or p_score > v_prev;

  insert into public.game_bests as g (user_id, mode, best, flagged, flags)
  values (p_user, p_mode, p_score, cardinality(v_flags) > 0, v_flags)
  on conflict (user_id, mode) do update set
    best = greatest(g.best, excluded.best),
    runs = g.runs + 1,
    updated_at = case when excluded.best > g.best then now() else g.updated_at end,
    flagged = g.flagged or (v_improves and excluded.flagged),
    flags = case when v_improves and excluded.flagged
                 then array(select distinct unnest(g.flags || excluded.flags)) else g.flags end
  returning * into v_rec;

  return jsonb_build_object('best', v_rec.best, 'new_best', p_score > 0 and p_score > coalesce(v_prev, 0),
                            'flagged', v_rec.flagged);
end $$;

-- ---------------------------------------------------------------------
-- Reports
-- ---------------------------------------------------------------------
create table public.reports (
  id bigint generated always as identity primary key,
  reporter uuid not null references public.profiles(id) on delete cascade,
  target uuid not null references public.profiles(id) on delete cascade,
  board text check (char_length(board) <= 60),
  reason text check (char_length(reason) <= 200),
  created_at timestamptz not null default now(),
  resolved boolean not null default false
);
create index reports_target_idx on public.reports (target) where not resolved;
alter table public.reports enable row level security;   -- no policies: functions only

create function public.report_player(p_nickname text, p_board text default null, p_reason text default null)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_target uuid;
  v_today int;
begin
  if v_uid is null then raise exception 'Not signed in'; end if;
  if coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) then
    raise exception 'Add your email to report players';
  end if;

  select id into v_target from public.profiles where lower(nickname) = lower(p_nickname);
  if not found then raise exception 'Player not found'; end if;
  if v_target = v_uid then raise exception 'You cannot report yourself'; end if;

  select count(*) into v_today from public.reports
   where reporter = v_uid and created_at > now() - interval '1 day';
  if v_today >= 10 then raise exception 'Report limit reached for today'; end if;

  if exists (select 1 from public.reports where reporter = v_uid and target = v_target and not resolved) then
    return jsonb_build_object('reported', true);
  end if;

  insert into public.reports (reporter, target, board, reason)
  values (v_uid, v_target, left(p_board, 60), left(p_reason, 200));
  return jsonb_build_object('reported', true);
end $$;

-- ---------------------------------------------------------------------
-- Leaderboards: ranked players only, plus your own row with its status
--   status: ranked | guest | review (flagged) | hidden
-- ---------------------------------------------------------------------
drop function if exists public.get_ladder_board(text, int);
drop function if exists public.get_level_board(text, int);
drop function if exists public.get_daily_board(date, int);
drop function if exists public.get_mode_board(text, int);

create function public.get_ladder_board(p_difficulty text default null, p_limit int default 50)
returns table (rank bigint, nickname text, stars bigint, points bigint, levels bigint, is_me boolean, status text)
language sql stable security definer set search_path = '' as $$
  with totals as (
    select lr.user_id,
           coalesce(sum(lr.stars) filter (where not lr.flagged), 0)::bigint as stars,
           coalesce(sum(lr.best_points) filter (where not lr.flagged), 0)::bigint as points,
           count(*) filter (where not lr.flagged) as levels
      from public.level_records lr
      join public.levels l on l.id = lr.level_id
     where p_difficulty is null or l.difficulty = p_difficulty
     group by lr.user_id
  ), entries as (
    select t.*, p.nickname, p.hidden, coalesce(u.is_anonymous, false) as guest
      from totals t
      join public.profiles p on p.id = t.user_id
      join auth.users u on u.id = t.user_id
  ), ranked as (
    select e.user_id, rank() over (order by e.stars desc, e.points desc) as rank
      from entries e
     where not e.guest and not e.hidden and e.levels > 0
  )
  select k.rank, e.nickname, e.stars, e.points, e.levels,
         coalesce(e.user_id = auth.uid(), false),
         case when e.guest then 'guest' when e.hidden then 'hidden'
              when k.rank is null then 'review' else 'ranked' end
    from entries e
    left join ranked k on k.user_id = e.user_id
   where k.rank <= least(p_limit, 100) or e.user_id = auth.uid()
   order by k.rank nulls last
$$;

create function public.get_level_board(p_level_id text, p_limit int default 50)
returns table (rank bigint, nickname text, best_time numeric, best_points int, stars smallint, is_me boolean, status text)
language sql stable security definer set search_path = '' as $$
  with entries as (
    select lr.user_id, lr.best_time, lr.best_points, lr.stars, lr.flagged,
           p.nickname, p.hidden, coalesce(u.is_anonymous, false) as guest
      from public.level_records lr
      join public.profiles p on p.id = lr.user_id
      join auth.users u on u.id = lr.user_id
     where lr.level_id = p_level_id
  ), ranked as (
    select e.user_id, rank() over (order by e.best_time, e.best_points desc) as rank
      from entries e
     where not e.guest and not e.hidden and not e.flagged
  )
  select k.rank, e.nickname, e.best_time, e.best_points, e.stars,
         coalesce(e.user_id = auth.uid(), false),
         case when e.guest then 'guest' when e.hidden then 'hidden'
              when k.rank is null then 'review' else 'ranked' end
    from entries e
    left join ranked k on k.user_id = e.user_id
   where k.rank <= least(p_limit, 100) or e.user_id = auth.uid()
   order by k.rank nulls last
$$;

create function public.get_daily_board(p_day date, p_limit int default 50)
returns table (rank bigint, nickname text, score int, built smallint, stars smallint[], is_me boolean, status text)
language sql stable security definer set search_path = '' as $$
  with entries as (
    select d.user_id, d.score, d.built, d.stars, d.total_stars, d.flagged,
           d.finished_at - d.started_at as took,
           p.nickname, p.hidden, coalesce(u.is_anonymous, false) as guest
      from public.daily_results d
      join public.profiles p on p.id = d.user_id
      join auth.users u on u.id = d.user_id
     where d.day = p_day and d.finished_at is not null
  ), ranked as (
    select e.user_id, rank() over (order by e.score desc, e.total_stars desc, e.took) as rank
      from entries e
     where not e.guest and not e.hidden and not e.flagged
  )
  select k.rank, e.nickname, e.score, e.built, e.stars,
         coalesce(e.user_id = auth.uid(), false),
         case when e.guest then 'guest' when e.hidden then 'hidden'
              when k.rank is null then 'review' else 'ranked' end
    from entries e
    left join ranked k on k.user_id = e.user_id
   where k.rank <= least(p_limit, 100) or e.user_id = auth.uid()
   order by k.rank nulls last
$$;

create function public.get_mode_board(p_mode text, p_limit int default 50)
returns table (rank bigint, nickname text, best int, runs int, is_me boolean, status text)
language sql stable security definer set search_path = '' as $$
  with entries as (
    select g.user_id, g.best, g.runs, g.updated_at, g.flagged,
           p.nickname, p.hidden, coalesce(u.is_anonymous, false) as guest
      from public.game_bests g
      join public.profiles p on p.id = g.user_id
      join auth.users u on u.id = g.user_id
     where g.mode = p_mode
  ), ranked as (
    select e.user_id, rank() over (order by e.best desc, e.updated_at) as rank
      from entries e
     where not e.guest and not e.hidden and not e.flagged
  )
  select k.rank, e.nickname, e.best, e.runs,
         coalesce(e.user_id = auth.uid(), false),
         case when e.guest then 'guest' when e.hidden then 'hidden'
              when k.rank is null then 'review' else 'ranked' end
    from entries e
    left join ranked k on k.user_id = e.user_id
   where k.rank <= least(p_limit, 100) or e.user_id = auth.uid()
   order by k.rank nulls last
$$;

-- ---------------------------------------------------------------------
-- Review views, in a schema the API does not expose
-- ---------------------------------------------------------------------
create schema if not exists admin;
revoke all on schema admin from public, anon, authenticated;

create view admin.review as
  select 'level' as board, p.nickname, lr.level_id as detail,
         lr.best_time || 's · ' || lr.best_points || ' pts' as result,
         lr.flags, lr.updated_at as happened_at, lr.user_id
    from public.level_records lr join public.profiles p on p.id = lr.user_id
   where lr.flagged
  union all
  select 'daily', p.nickname, d.day::text, d.score || ' pts · ' || d.built || '/5 built',
         d.flags, d.finished_at, d.user_id
    from public.daily_results d join public.profiles p on p.id = d.user_id
   where d.flagged
  union all
  select 'game', p.nickname, g.mode, g.best || ' pts',
         g.flags, g.updated_at, g.user_id
    from public.game_bests g join public.profiles p on p.id = g.user_id
   where g.flagged
  order by happened_at desc;

create view admin.open_reports as
  select r.id, t.nickname as target, r.target as target_id,
         count(*) over (partition by r.target) as reports_on_target,
         rp.nickname as reporter, r.board, r.reason, r.created_at
    from public.reports r
    join public.profiles t on t.id = r.target
    join public.profiles rp on rp.id = r.reporter
   where not r.resolved
   order by reports_on_target desc, r.created_at desc;

-- ---------------------------------------------------------------------
-- Permissions
-- ---------------------------------------------------------------------
revoke execute on function public.claim_run(uuid, uuid, text)       from public, anon, authenticated;
revoke execute on function public.is_ranked_player(uuid)            from public, anon, authenticated;

revoke execute on function public.record_level(uuid, uuid, text, numeric, text[]) from public, anon, authenticated;
revoke execute on function public.record_daily(uuid, uuid, date, jsonb, text[])   from public, anon, authenticated;
revoke execute on function public.record_score(uuid, uuid, text, int, text[])     from public, anon, authenticated;
grant execute on function public.record_level(uuid, uuid, text, numeric, text[]) to service_role;
grant execute on function public.record_daily(uuid, uuid, date, jsonb, text[])   to service_role;
grant execute on function public.record_score(uuid, uuid, text, int, text[])     to service_role;

revoke execute on function public.start_run(text, text, date)       from public, anon;
revoke execute on function public.report_player(text, text, text)   from public, anon;
grant execute on function public.start_run(text, text, date)        to authenticated;
grant execute on function public.report_player(text, text, text)    to authenticated;

revoke execute on function public.get_ladder_board(text, int) from public;
revoke execute on function public.get_level_board(text, int)  from public;
revoke execute on function public.get_daily_board(date, int)  from public;
revoke execute on function public.get_mode_board(text, int)   from public;
grant execute on function public.get_ladder_board(text, int) to anon, authenticated;
grant execute on function public.get_level_board(text, int)  to anon, authenticated;
grant execute on function public.get_daily_board(date, int)  to anon, authenticated;
grant execute on function public.get_mode_board(text, int)   to anon, authenticated;

-- Supabase's own helper, flagged by the security advisor.
do $$ begin
  revoke execute on function public.rls_auto_enable() from public, anon, authenticated;
exception when undefined_function then null;
end $$;
