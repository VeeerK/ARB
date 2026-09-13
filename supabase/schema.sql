-- =====================================================================
-- ARB online: profiles, leaderboards, rooms, matchmaking
--
-- Run once in the Supabase SQL editor on a fresh project. Players never
-- write to a table directly: every score and room change goes through a
-- security-definer function that validates it, and points and stars are
-- computed here from the time a level took (same formulas as
-- src/levels.js scoreFor() and src/progress.js starsFor()).
--
-- Dashboard settings this expects:
--   Authentication > Sign In / Providers: Email on, anonymous sign-ins on
--   Authentication > URL Configuration: the site URL and its redirect URLs
-- =====================================================================

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------
-- Profiles (one per auth user, anonymous included)
-- ---------------------------------------------------------------------
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  nickname text not null check (nickname ~ '^[A-Za-z0-9_]{3,16}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index profiles_nickname_key on public.profiles (lower(nickname));

create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_try int := 0;
begin
  loop
    v_try := v_try + 1;
    begin
      insert into public.profiles (id, nickname)
      values (new.id, 'Player' || lpad((floor(random() * 1000000))::int::text, 6, '0'))
      on conflict (id) do nothing;
      exit;
    exception when unique_violation then
      if v_try > 20 then raise; end if;
    end;
  end loop;
  return new;
end $$;

create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

-- users that already exist
insert into public.profiles (id, nickname)
select id, 'Player' || substr(replace(id::text, '-', ''), 1, 8) from auth.users
on conflict do nothing;

create function public.set_nickname(p_nickname text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'Not signed in'; end if;
  if p_nickname is null or p_nickname !~ '^[A-Za-z0-9_]{3,16}$' then
    raise exception 'Nickname must be 3-16 letters, numbers or _';
  end if;
  update public.profiles set nickname = p_nickname, updated_at = now() where id = v_uid;
  return jsonb_build_object('nickname', p_nickname);
exception when unique_violation then
  raise exception 'That nickname is taken';
end $$;

-- ---------------------------------------------------------------------
-- Reference data: levels and game modes
-- ---------------------------------------------------------------------
create table public.levels (
  id text primary key,
  pack text not null,
  difficulty text not null check (difficulty in ('easy', 'medium', 'hard')),
  points int not null,
  par numeric not null
);

insert into public.levels (id, pack, difficulty, points, par) values
('square-easy','square','easy',100,20),     ('square-medium','square','medium',160,28),     ('square-hard','square','hard',240,40),
('circle-easy','circle','easy',100,22),     ('circle-medium','circle','medium',160,30),     ('circle-hard','circle','hard',250,45),
('triangle-easy','triangle','easy',100,22), ('triangle-medium','triangle','medium',160,30), ('triangle-hard','triangle','hard',240,40),
('pair-easy','pair','easy',170,32),         ('pair-medium','pair','medium',240,44),         ('pair-hard','pair','hard',360,70),
('stack-easy','stack','easy',210,40),       ('stack-medium','stack','medium',290,52),       ('stack-hard','stack','hard',420,82),
('snowman-easy','snowman','easy',210,40),   ('snowman-medium','snowman','medium',300,55),   ('snowman-hard','snowman','hard',440,88),
('house-easy','house','easy',220,42),       ('house-medium','house','medium',320,60),       ('house-hard','house','hard',460,90),
('traffic-easy','traffic','easy',220,42),   ('traffic-medium','traffic','medium',360,68),   ('traffic-hard','traffic','hard',480,92),
('tree-easy','tree','easy',250,48),         ('tree-medium','tree','medium',410,80),         ('tree-hard','tree','hard',560,105),
('tower-easy','tower','easy',260,48),       ('tower-medium','tower','medium',440,82),       ('tower-hard','tower','hard',640,120);

create table public.game_modes (
  id text primary key,
  name text not null,
  kind text not null check (kind in ('build', 'arcade')),
  min_players smallint not null default 1,
  max_players smallint not null default 8,
  ranked boolean not null default true,   -- has a high-score board
  score_cap int not null default 1000000
);

insert into public.game_modes (id, name, kind, min_players, max_players, ranked) values
('ladder','Level ladder','build',1,8,false),
('rush','Shape Rush','build',1,8,true),
('memory','Memory','build',1,8,true),
('copy','Copy the shape','build',1,8,true),
('balance','Balance scale','build',1,8,true),
('blockfall','Blockfall','arcade',1,8,true),
('breaker','Brick Breaker','arcade',1,8,true),
('invaders','Shape Invaders','arcade',1,8,true),
('pong','Air Pong','arcade',2,2,false),
('snake','Glow Worm','arcade',1,8,true),
('simon','Copycat','arcade',1,8,true),
('pop','Pop Rush','arcade',1,8,true);

create function public.level_points(p_points int, p_par numeric, p_seconds numeric) returns int
language sql immutable set search_path = '' as $$
  select round(p_points * least(2.0, greatest(0.4, p_par / greatest(p_seconds, 0.1))))::int
$$;

create function public.level_stars(p_par numeric, p_seconds numeric) returns smallint
language sql immutable set search_path = '' as $$
  select (case when p_seconds is null then 0
               when p_seconds <= p_par * 0.6 then 3
               when p_seconds <= p_par then 2
               else 1 end)::smallint
$$;

-- ---------------------------------------------------------------------
-- Level ladder records
-- ---------------------------------------------------------------------
create table public.level_records (
  user_id uuid not null references public.profiles(id) on delete cascade,
  level_id text not null references public.levels(id),
  best_points int not null,
  best_time numeric(6,1) not null,
  stars smallint not null check (stars between 0 and 3),
  plays int not null default 1,
  updated_at timestamptz not null default now(),
  primary key (user_id, level_id)
);
create index level_records_board_idx on public.level_records (level_id, best_time);

create function public.submit_level(p_level_id text, p_seconds numeric) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_lv public.levels;
  v_pts int;
  v_stars smallint;
  v_prev public.level_records;
  v_rec public.level_records;
begin
  if v_uid is null then raise exception 'Not signed in'; end if;
  select * into v_lv from public.levels where id = p_level_id;
  if not found then raise exception 'Unknown level'; end if;
  if p_seconds is null or p_seconds < 0.5 or p_seconds > v_lv.par * 2.5 then
    raise exception 'Invalid time';
  end if;

  v_pts := public.level_points(v_lv.points, v_lv.par, p_seconds);
  v_stars := public.level_stars(v_lv.par, p_seconds);
  select * into v_prev from public.level_records where user_id = v_uid and level_id = p_level_id;

  insert into public.level_records as r (user_id, level_id, best_points, best_time, stars)
  values (v_uid, p_level_id, v_pts, round(p_seconds, 1), v_stars)
  on conflict (user_id, level_id) do update set
    best_points = greatest(r.best_points, excluded.best_points),
    best_time   = least(r.best_time, excluded.best_time),
    stars       = greatest(r.stars, excluded.stars),
    plays       = r.plays + 1,
    updated_at  = now()
  returning * into v_rec;

  return jsonb_build_object(
    'points', v_pts, 'stars', v_stars,
    'new_best', v_prev.user_id is not null and v_pts > v_prev.best_points,
    'best_points', v_rec.best_points, 'best_time', v_rec.best_time, 'best_stars', v_rec.stars);
end $$;

-- ---------------------------------------------------------------------
-- Daily challenge (first attempt only)
-- ---------------------------------------------------------------------
create table public.daily_results (
  user_id uuid not null references public.profiles(id) on delete cascade,
  day date not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  score int,
  built smallint,
  stars smallint[],
  total_stars smallint,
  primary key (user_id, day)
);
create index daily_board_idx on public.daily_results (day, score desc) where finished_at is not null;

-- Call when the daily run begins. ranked=false means this player already used their attempt.
create function public.start_daily(p_day date) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_today date := (now() at time zone 'utc')::date;
  v_row public.daily_results;
begin
  if v_uid is null then raise exception 'Not signed in'; end if;
  if p_day not between v_today - 1 and v_today + 1 then raise exception 'That daily is not open'; end if;

  insert into public.daily_results (user_id, day) values (v_uid, p_day) on conflict do nothing;
  if found then return jsonb_build_object('ranked', true); end if;

  select * into v_row from public.daily_results where user_id = v_uid and day = p_day;
  return jsonb_build_object('ranked', false, 'finished', v_row.finished_at is not null,
                            'score', v_row.score, 'stars', to_jsonb(v_row.stars));
end $$;

-- p_runs: [{ "level_id": "square-easy", "seconds": 12.3 }, { "level_id": "...", "seconds": null }, ...] (5 entries, in order)
create function public.submit_daily(p_day date, p_runs jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_row public.daily_results;
  v_item jsonb;
  v_lv public.levels;
  v_secs numeric;
  v_i int := 0;
  v_want text[] := array['easy', 'easy', 'medium', 'medium', 'hard'];
  v_packs text[] := '{}';
  v_score int := 0;
  v_built int := 0;
  v_stars smallint[] := '{}';
  v_total_secs numeric := 0;
begin
  if v_uid is null then raise exception 'Not signed in'; end if;
  select * into v_row from public.daily_results where user_id = v_uid and day = p_day for update;
  if not found then raise exception 'Daily not started'; end if;
  if v_row.finished_at is not null then raise exception 'Daily already submitted'; end if;
  if jsonb_typeof(p_runs) <> 'array' or jsonb_array_length(p_runs) <> 5 then
    raise exception 'Invalid daily result';
  end if;

  for v_item in select e from jsonb_array_elements(p_runs) with ordinality as t(e, n) order by n loop
    v_i := v_i + 1;
    select * into v_lv from public.levels where id = v_item->>'level_id';
    if not found or v_lv.difficulty <> v_want[v_i] or v_lv.pack = any(v_packs) then
      raise exception 'Invalid daily levels';
    end if;
    v_packs := v_packs || v_lv.pack;

    if v_item->'seconds' is null or jsonb_typeof(v_item->'seconds') = 'null' then
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

  -- can't have spent more time building than has passed since the run started
  if extract(epoch from now() - v_row.started_at) + 5 < v_total_secs then
    raise exception 'Invalid time';
  end if;

  update public.daily_results
     set finished_at = now(), score = v_score, built = v_built, stars = v_stars,
         total_stars = (select sum(x) from unnest(v_stars) as x)
   where user_id = v_uid and day = p_day;

  return jsonb_build_object('score', v_score, 'built', v_built, 'stars', to_jsonb(v_stars));
end $$;

-- ---------------------------------------------------------------------
-- High scores for every other game / mode
-- ---------------------------------------------------------------------
create table public.game_bests (
  user_id uuid not null references public.profiles(id) on delete cascade,
  mode text not null references public.game_modes(id),
  best int not null check (best >= 0),
  runs int not null default 1,
  updated_at timestamptz not null default now(),
  primary key (user_id, mode)
);
create index game_bests_board_idx on public.game_bests (mode, best desc);

create function public.submit_score(p_mode text, p_score int) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_gm public.game_modes;
  v_prev int;
  v_best int;
begin
  if v_uid is null then raise exception 'Not signed in'; end if;
  select * into v_gm from public.game_modes where id = p_mode and ranked;
  if not found then raise exception 'No leaderboard for that mode'; end if;
  if p_score is null or p_score < 0 or p_score > v_gm.score_cap then raise exception 'Invalid score'; end if;

  select best into v_prev from public.game_bests where user_id = v_uid and mode = p_mode;

  insert into public.game_bests as g (user_id, mode, best) values (v_uid, p_mode, p_score)
  on conflict (user_id, mode) do update set
    best = greatest(g.best, excluded.best),
    runs = g.runs + 1,
    updated_at = case when excluded.best > g.best then now() else g.updated_at end
  returning best into v_best;

  return jsonb_build_object('best', v_best, 'new_best', p_score > 0 and p_score > coalesce(v_prev, 0));
end $$;

-- ---------------------------------------------------------------------
-- Leaderboards (top N, plus the caller's own row wherever they rank)
-- ---------------------------------------------------------------------
-- p_difficulty: null = all 30 levels, or 'easy' | 'medium' | 'hard'
create function public.get_ladder_board(p_difficulty text default null, p_limit int default 50)
returns table (rank bigint, nickname text, stars bigint, points bigint, levels bigint, is_me boolean)
language sql stable security definer set search_path = '' as $$
  with totals as (
    select lr.user_id, sum(lr.stars) as stars, sum(lr.best_points) as points, count(*) as levels
    from public.level_records lr
    join public.levels l on l.id = lr.level_id
    where p_difficulty is null or l.difficulty = p_difficulty
    group by lr.user_id
  ), ranked as (
    select rank() over (order by t.stars desc, t.points desc) as rank,
           p.nickname, t.stars, t.points, t.levels,
           coalesce(t.user_id = auth.uid(), false) as is_me
    from totals t join public.profiles p on p.id = t.user_id
  )
  select * from ranked where rank <= least(p_limit, 100) or is_me order by rank
$$;

create function public.get_level_board(p_level_id text, p_limit int default 50)
returns table (rank bigint, nickname text, best_time numeric, best_points int, stars smallint, is_me boolean)
language sql stable security definer set search_path = '' as $$
  select * from (
    select rank() over (order by lr.best_time, lr.best_points desc) as rank,
           p.nickname, lr.best_time, lr.best_points, lr.stars,
           coalesce(lr.user_id = auth.uid(), false) as is_me
    from public.level_records lr join public.profiles p on p.id = lr.user_id
    where lr.level_id = p_level_id
  ) b
  where b.rank <= least(p_limit, 100) or b.is_me
  order by b.rank
$$;

create function public.get_daily_board(p_day date, p_limit int default 50)
returns table (rank bigint, nickname text, score int, built smallint, stars smallint[], is_me boolean)
language sql stable security definer set search_path = '' as $$
  select * from (
    select rank() over (order by d.score desc, d.total_stars desc, d.finished_at - d.started_at) as rank,
           p.nickname, d.score, d.built, d.stars,
           coalesce(d.user_id = auth.uid(), false) as is_me
    from public.daily_results d join public.profiles p on p.id = d.user_id
    where d.day = p_day and d.finished_at is not null
  ) b
  where b.rank <= least(p_limit, 100) or b.is_me
  order by b.rank
$$;

create function public.get_mode_board(p_mode text, p_limit int default 50)
returns table (rank bigint, nickname text, best int, runs int, is_me boolean)
language sql stable security definer set search_path = '' as $$
  select * from (
    select rank() over (order by g.best desc, g.updated_at) as rank,
           p.nickname, g.best, g.runs,
           coalesce(g.user_id = auth.uid(), false) as is_me
    from public.game_bests g join public.profiles p on p.id = g.user_id
    where g.mode = p_mode
  ) b
  where b.rank <= least(p_limit, 100) or b.is_me
  order by b.rank
$$;

-- ---------------------------------------------------------------------
-- Rooms
-- ---------------------------------------------------------------------
create table public.rooms (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  host_id uuid not null references public.profiles(id) on delete cascade,
  visibility text not null default 'private' check (visibility in ('public', 'private')),
  status text not null default 'lobby' check (status in ('lobby', 'playing')),
  mode text not null references public.game_modes(id),
  settings jsonb not null default '{}'::jsonb
    check (jsonb_typeof(settings) = 'object' and pg_column_size(settings) < 4000),
  max_players smallint not null default 8 check (max_players between 2 and 8),
  player_count smallint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index rooms_open_idx on public.rooms (status, visibility, mode);

create table public.room_players (
  room_id uuid not null references public.rooms(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  joined_at timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  primary key (room_id, user_id)
);
create unique index room_players_one_room on public.room_players (user_id);
create index room_players_seen_idx on public.room_players (last_seen);

-- keep player_count right, hand host to the longest-waiting player, delete empty rooms
create function public.room_players_changed() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_room_id uuid := coalesce(new.room_id, old.room_id);
  v_count int;
begin
  select count(*) into v_count from public.room_players where room_id = v_room_id;
  if v_count = 0 then
    delete from public.rooms where id = v_room_id;
    return null;
  end if;

  update public.rooms set player_count = v_count, updated_at = now() where id = v_room_id;

  if tg_op = 'DELETE' then
    update public.rooms
       set host_id = (select user_id from public.room_players
                      where room_id = v_room_id order by joined_at limit 1)
     where id = v_room_id and host_id = old.user_id;
  end if;
  return null;
end $$;

create trigger room_players_changed
after insert or delete on public.room_players
for each row execute function public.room_players_changed();

create function public.sweep_rooms() returns void
language sql security definer set search_path = '' as $$
  delete from public.room_players where last_seen < now() - interval '90 seconds';
$$;

create function public.new_room_code() returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_alphabet text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   -- 32 chars, no 0/O/1/I
  v_code text;
begin
  loop
    v_code := '';
    for i in 1..6 loop
      v_code := v_code || substr(v_alphabet, 1 + (get_byte(extensions.gen_random_bytes(1), 0) % 32), 1);
    end loop;
    exit when not exists (select 1 from public.rooms where code = v_code);
  end loop;
  return v_code;
end $$;

create function public.room_json(p_room_id uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', r.id, 'code', r.code, 'host_id', r.host_id, 'visibility', r.visibility,
    'status', r.status, 'mode', r.mode, 'settings', r.settings,
    'max_players', r.max_players, 'player_count', r.player_count,
    'players', coalesce((
      select jsonb_agg(jsonb_build_object('user_id', rp.user_id, 'nickname', p.nickname, 'joined_at', rp.joined_at)
                       order by rp.joined_at)
      from public.room_players rp join public.profiles p on p.id = rp.user_id
      where rp.room_id = r.id), '[]'::jsonb))
  from public.rooms r where r.id = p_room_id
$$;

create function public.create_room(
  p_mode text, p_visibility text default 'private', p_max_players int default 8, p_settings jsonb default '{}'::jsonb
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_gm public.game_modes;
  v_room_id uuid;
begin
  if v_uid is null then raise exception 'Not signed in'; end if;
  select * into v_gm from public.game_modes where id = p_mode;
  if not found then raise exception 'Unknown game mode'; end if;
  if p_visibility not in ('public', 'private') then raise exception 'Invalid visibility'; end if;

  perform pg_advisory_xact_lock(4242);
  perform public.sweep_rooms();
  delete from public.room_players where user_id = v_uid;

  insert into public.rooms (code, host_id, visibility, mode, settings, max_players)
  values (public.new_room_code(), v_uid, p_visibility, p_mode, coalesce(p_settings, '{}'::jsonb),
          least(greatest(coalesce(p_max_players, 8), 2), v_gm.max_players))
  returning id into v_room_id;

  insert into public.room_players (room_id, user_id) values (v_room_id, v_uid);
  return public.room_json(v_room_id);
end $$;

create function public.join_room(p_code text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_room public.rooms;
begin
  if v_uid is null then raise exception 'Not signed in'; end if;
  perform pg_advisory_xact_lock(4242);
  perform public.sweep_rooms();

  select * into v_room from public.rooms where code = upper(btrim(p_code));
  if not found then raise exception 'Room not found'; end if;

  if exists (select 1 from public.room_players where room_id = v_room.id and user_id = v_uid) then
    update public.room_players set last_seen = now() where room_id = v_room.id and user_id = v_uid;
    return public.room_json(v_room.id);
  end if;

  if v_room.status <> 'lobby' then raise exception 'That game has already started'; end if;
  if v_room.player_count >= v_room.max_players then raise exception 'Room is full'; end if;

  delete from public.room_players where user_id = v_uid;
  insert into public.room_players (room_id, user_id) values (v_room.id, v_uid);
  return public.room_json(v_room.id);
end $$;

create function public.leave_room() returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform pg_advisory_xact_lock(4242);
  delete from public.room_players where user_id = auth.uid();
end $$;

-- Call every ~20s while in a room. Returns the room, or null if you were dropped.
create function public.room_heartbeat() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_room_id uuid;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  perform pg_advisory_xact_lock(4242);
  update public.room_players set last_seen = now() where user_id = auth.uid() returning room_id into v_room_id;
  perform public.sweep_rooms();
  if v_room_id is null then return null; end if;
  return public.room_json(v_room_id);
end $$;

create function public.update_room(
  p_room_id uuid, p_mode text default null, p_visibility text default null,
  p_max_players int default null, p_settings jsonb default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_room public.rooms;
  v_gm public.game_modes;
  v_visibility text;
  v_max int;
begin
  perform pg_advisory_xact_lock(4242);
  select * into v_room from public.rooms where id = p_room_id;
  if not found then raise exception 'Room not found'; end if;
  if v_room.host_id is distinct from auth.uid() then raise exception 'Only the host can change the room'; end if;
  if v_room.status <> 'lobby' then raise exception 'Wait for the game to end'; end if;

  select * into v_gm from public.game_modes where id = coalesce(p_mode, v_room.mode);
  if not found then raise exception 'Unknown game mode'; end if;

  v_visibility := coalesce(p_visibility, v_room.visibility);
  if v_visibility not in ('public', 'private') then raise exception 'Invalid visibility'; end if;

  v_max := least(greatest(coalesce(p_max_players, v_room.max_players), 2), v_gm.max_players);
  if v_max < v_room.player_count then
    raise exception '% allows % players and there are % in the room', v_gm.name, v_max, v_room.player_count;
  end if;

  update public.rooms
     set mode = v_gm.id, visibility = v_visibility, max_players = v_max,
         settings = coalesce(p_settings, settings), updated_at = now()
   where id = p_room_id;
  return public.room_json(p_room_id);
end $$;

-- p_status: 'playing' to start, 'lobby' when the match ends
create function public.set_room_status(p_room_id uuid, p_status text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_room public.rooms;
  v_gm public.game_modes;
begin
  perform pg_advisory_xact_lock(4242);
  select * into v_room from public.rooms where id = p_room_id;
  if not found then raise exception 'Room not found'; end if;
  if v_room.host_id is distinct from auth.uid() then raise exception 'Only the host can do that'; end if;
  if p_status not in ('lobby', 'playing') then raise exception 'Invalid status'; end if;

  if p_status = 'playing' then
    select * into v_gm from public.game_modes where id = v_room.mode;
    if v_room.player_count < v_gm.min_players then
      raise exception '% needs at least % players', v_gm.name, v_gm.min_players;
    end if;
  end if;

  update public.rooms set status = p_status, updated_at = now() where id = p_room_id;
  return public.room_json(p_room_id);
end $$;

create function public.kick_player(p_room_id uuid, p_user_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform pg_advisory_xact_lock(4242);
  if not exists (select 1 from public.rooms where id = p_room_id and host_id = auth.uid()) then
    raise exception 'Only the host can do that';
  end if;
  if p_user_id = auth.uid() then raise exception 'You cannot kick yourself'; end if;
  delete from public.room_players where room_id = p_room_id and user_id = p_user_id;
  return public.room_json(p_room_id);
end $$;

-- Public lobby browser. p_modes null = all modes.
create function public.list_public_rooms(p_modes text[] default null)
returns table (code text, mode text, player_count smallint, max_players smallint, host text, settings jsonb, created_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select r.code, r.mode, r.player_count, r.max_players, p.nickname, r.settings, r.created_at
  from public.rooms r
  join public.profiles p on p.id = r.host_id
  where r.visibility = 'public'
    and r.status = 'lobby'
    and (p_modes is null or r.mode = any(p_modes))
    and exists (select 1 from public.room_players rp
                where rp.room_id = r.id and rp.last_seen > now() - interval '90 seconds')
  order by (r.player_count >= r.max_players), r.player_count desc, r.created_at
  limit 100
$$;

-- CoD-style: pick modes, join the fullest open public room, or open a new one.
create function public.quick_match(p_modes text[]) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_modes text[];
  v_room public.rooms;
  v_gm public.game_modes;
  v_room_id uuid;
begin
  if v_uid is null then raise exception 'Not signed in'; end if;
  select array_agg(id) into v_modes from public.game_modes where id = any(p_modes);
  if v_modes is null then raise exception 'Pick at least one game mode'; end if;

  perform pg_advisory_xact_lock(4242);
  perform public.sweep_rooms();
  delete from public.room_players where user_id = v_uid;

  select * into v_room from public.rooms r
   where r.visibility = 'public' and r.status = 'lobby'
     and r.mode = any(v_modes) and r.player_count < r.max_players
   order by r.player_count desc, r.created_at
   limit 1;

  if found then
    insert into public.room_players (room_id, user_id) values (v_room.id, v_uid);
    return public.room_json(v_room.id);
  end if;

  select * into v_gm from public.game_modes
   where id = v_modes[1 + floor(random() * array_length(v_modes, 1))::int];

  insert into public.rooms (code, host_id, visibility, mode, max_players)
  values (public.new_room_code(), v_uid, 'public', v_gm.id, v_gm.max_players)
  returning id into v_room_id;

  insert into public.room_players (room_id, user_id) values (v_room_id, v_uid);
  return public.room_json(v_room_id);
end $$;

-- ---------------------------------------------------------------------
-- Row level security: read your own rows; all writes go through functions
-- ---------------------------------------------------------------------
alter table public.profiles      enable row level security;
alter table public.levels        enable row level security;
alter table public.game_modes    enable row level security;
alter table public.level_records enable row level security;
alter table public.daily_results enable row level security;
alter table public.game_bests    enable row level security;
alter table public.rooms         enable row level security;
alter table public.room_players  enable row level security;

create policy "read own profile" on public.profiles
  for select to authenticated using (id = (select auth.uid()));
create policy "read levels" on public.levels
  for select to anon, authenticated using (true);
create policy "read game modes" on public.game_modes
  for select to anon, authenticated using (true);
create policy "read own level records" on public.level_records
  for select to authenticated using (user_id = (select auth.uid()));
create policy "read own daily results" on public.daily_results
  for select to authenticated using (user_id = (select auth.uid()));
create policy "read own game bests" on public.game_bests
  for select to authenticated using (user_id = (select auth.uid()));
create policy "read own room membership" on public.room_players
  for select to authenticated using (user_id = (select auth.uid()));

-- Realtime: only members of a room can use channel "room:<room id>" (client must use { private: true })
create policy "room members receive" on realtime.messages
  for select to authenticated
  using (
    realtime.messages.extension in ('broadcast', 'presence')
    and exists (select 1 from public.room_players rp
                where rp.user_id = (select auth.uid())
                  and (select realtime.topic()) = 'room:' || rp.room_id::text)
  );
create policy "room members send" on realtime.messages
  for insert to authenticated
  with check (
    realtime.messages.extension in ('broadcast', 'presence')
    and exists (select 1 from public.room_players rp
                where rp.user_id = (select auth.uid())
                  and (select realtime.topic()) = 'room:' || rp.room_id::text)
  );

-- ---------------------------------------------------------------------
-- Function permissions
-- ---------------------------------------------------------------------
-- internal only
revoke execute on function public.handle_new_user()                  from public, anon, authenticated;
revoke execute on function public.room_players_changed()             from public, anon, authenticated;
revoke execute on function public.sweep_rooms()                      from public, anon, authenticated;
revoke execute on function public.new_room_code()                    from public, anon, authenticated;
revoke execute on function public.room_json(uuid)                    from public, anon, authenticated;
revoke execute on function public.level_points(int, numeric, numeric) from public, anon, authenticated;
revoke execute on function public.level_stars(numeric, numeric)      from public, anon, authenticated;

-- signed-in players (anonymous included)
revoke execute on function public.set_nickname(text)                          from public, anon;
revoke execute on function public.submit_level(text, numeric)                 from public, anon;
revoke execute on function public.start_daily(date)                           from public, anon;
revoke execute on function public.submit_daily(date, jsonb)                   from public, anon;
revoke execute on function public.submit_score(text, int)                     from public, anon;
revoke execute on function public.create_room(text, text, int, jsonb)         from public, anon;
revoke execute on function public.join_room(text)                             from public, anon;
revoke execute on function public.leave_room()                                from public, anon;
revoke execute on function public.room_heartbeat()                            from public, anon;
revoke execute on function public.update_room(uuid, text, text, int, jsonb)   from public, anon;
revoke execute on function public.set_room_status(uuid, text)                 from public, anon;
revoke execute on function public.kick_player(uuid, uuid)                     from public, anon;
revoke execute on function public.quick_match(text[])                         from public, anon;

grant execute on function public.set_nickname(text)                          to authenticated;
grant execute on function public.submit_level(text, numeric)                 to authenticated;
grant execute on function public.start_daily(date)                           to authenticated;
grant execute on function public.submit_daily(date, jsonb)                   to authenticated;
grant execute on function public.submit_score(text, int)                     to authenticated;
grant execute on function public.create_room(text, text, int, jsonb)         to authenticated;
grant execute on function public.join_room(text)                             to authenticated;
grant execute on function public.leave_room()                                to authenticated;
grant execute on function public.room_heartbeat()                            to authenticated;
grant execute on function public.update_room(uuid, text, text, int, jsonb)   to authenticated;
grant execute on function public.set_room_status(uuid, text)                 to authenticated;
grant execute on function public.kick_player(uuid, uuid)                     to authenticated;
grant execute on function public.quick_match(text[])                         to authenticated;

-- anyone, even before signing in
revoke execute on function public.get_ladder_board(text, int)  from public;
revoke execute on function public.get_level_board(text, int)   from public;
revoke execute on function public.get_daily_board(date, int)   from public;
revoke execute on function public.get_mode_board(text, int)    from public;
revoke execute on function public.list_public_rooms(text[])    from public;
grant execute on function public.get_ladder_board(text, int)  to anon, authenticated;
grant execute on function public.get_level_board(text, int)   to anon, authenticated;
grant execute on function public.get_daily_board(date, int)   to anon, authenticated;
grant execute on function public.get_mode_board(text, int)    to anon, authenticated;
grant execute on function public.list_public_rooms(text[])    to anon, authenticated;
