-- =====================================================================
-- ARB online, part 3: sign up / sign in, guest hand-over, guest cleanup
--
-- Run once in the Supabase SQL editor, AFTER 002_anticheat.sql.
--
--   1. account_exists   lets the sign-up and sign-in forms say "this email
--                       already has an account" / "doesn't have an account".
--   2. Guest hand-over  a guest who signs in to an existing account keeps
--                       their scores: the guest asks for a one-use ticket
--                       (start_guest_transfer), the account spends it once
--                       signed in (claim_guest), and the best of both is kept.
--   3. Cleanup          every night, guest accounts nobody has used for 5 days
--                       are deleted with all their data. "Used" means the game
--                       signed in or refreshed that guest's session. Real
--                       accounts are never touched.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Does this email belong to a real (non-guest) account?
-- ---------------------------------------------------------------------
create function public.account_exists(p_email text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from auth.users
     where lower(email) = lower(btrim(p_email)) and not coalesce(is_anonymous, false)
  )
$$;

-- ---------------------------------------------------------------------
-- 2. Guest hand-over
-- ---------------------------------------------------------------------
create table public.guest_transfers (
  token uuid primary key default gen_random_uuid(),
  guest_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.guest_transfers enable row level security;   -- no policies: functions only

-- Called by the guest, just before signing in to another account.
create function public.start_guest_transfer() returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_token uuid;
begin
  if v_uid is null then raise exception 'Not signed in'; end if;
  if not coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) then
    raise exception 'Only a guest can hand over their scores';
  end if;
  delete from public.guest_transfers where guest_id = v_uid or created_at < now() - interval '1 day';
  insert into public.guest_transfers (guest_id) values (v_uid) returning token into v_token;
  return v_token;
end $$;

-- Called by the account, once signed in. Moves the guest's results over
-- (keeping the better of each), takes the guest's nickname if the account
-- still has a default one, then deletes the guest.
create function public.claim_guest(p_token uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_guest uuid;
  v_guest_nick text;
  v_my_nick text;
begin
  if v_uid is null then raise exception 'Not signed in'; end if;
  if coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) then raise exception 'Sign in first'; end if;

  delete from public.guest_transfers
   where token = p_token and created_at > now() - interval '1 day'
  returning guest_id into v_guest;

  -- No ticket, or the guest became this very account by signing up.
  if v_guest is null or v_guest = v_uid then return jsonb_build_object('moved', false); end if;
  if not exists (select 1 from auth.users where id = v_guest and is_anonymous) then
    return jsonb_build_object('moved', false);
  end if;

  perform pg_advisory_xact_lock(4242);   -- same lock as rooms: the guest may be in one

  insert into public.level_records as r
         (user_id, level_id, best_points, best_time, stars, plays, updated_at, flagged, flags)
  select v_uid, level_id, best_points, best_time, stars, plays, updated_at, flagged, flags
    from public.level_records where user_id = v_guest
  on conflict (user_id, level_id) do update set
    best_points = greatest(r.best_points, excluded.best_points),
    best_time   = least(r.best_time, excluded.best_time),
    stars       = greatest(r.stars, excluded.stars),
    plays       = r.plays + excluded.plays,
    updated_at  = greatest(r.updated_at, excluded.updated_at),
    -- as in record_level: a flagged result only taints the record if it improves it
    flagged     = r.flagged or (excluded.flagged and (excluded.best_points > r.best_points or excluded.best_time < r.best_time)),
    flags       = case when excluded.flagged and (excluded.best_points > r.best_points or excluded.best_time < r.best_time)
                       then array(select distinct unnest(r.flags || excluded.flags)) else r.flags end;

  insert into public.game_bests as g (user_id, mode, best, runs, updated_at, flagged, flags)
  select v_uid, mode, best, runs, updated_at, flagged, flags
    from public.game_bests where user_id = v_guest
  on conflict (user_id, mode) do update set
    best       = greatest(g.best, excluded.best),
    runs       = g.runs + excluded.runs,
    updated_at = case when excluded.best > g.best then excluded.updated_at else g.updated_at end,
    flagged    = case when excluded.best > g.best then excluded.flagged else g.flagged end,
    flags      = case when excluded.best > g.best then excluded.flags else g.flags end;

  -- One ranked daily per day: the account's own attempt wins.
  insert into public.daily_results
         (user_id, day, started_at, finished_at, score, built, stars, total_stars, flagged, flags, run_id)
  select v_uid, day, started_at, finished_at, score, built, stars, total_stars, flagged, flags, run_id
    from public.daily_results where user_id = v_guest
  on conflict (user_id, day) do nothing;

  update public.runs set user_id = v_uid where user_id = v_guest;

  select nickname into v_guest_nick from public.profiles where id = v_guest;
  select nickname into v_my_nick from public.profiles where id = v_uid;

  delete from auth.users where id = v_guest;   -- cascades whatever the guest had left

  if v_my_nick ~* '^Player[0-9a-f]{6,8}$' and v_guest_nick !~* '^Player[0-9a-f]{6,8}$' then
    begin
      update public.profiles set nickname = v_guest_nick, updated_at = now() where id = v_uid;
    exception when unique_violation then null;
    end;
  end if;

  return jsonb_build_object('moved', true);
end $$;

-- ---------------------------------------------------------------------
-- 3. Delete guests unused for 5 days (runs nightly, see below)
-- ---------------------------------------------------------------------
create function public.wipe_idle_guests() returns int
language plpgsql security definer set search_path = '' as $$
declare v_count int;
begin
  perform pg_advisory_xact_lock(4242);
  delete from auth.users u
   where u.is_anonymous
     and greatest(u.created_at, u.last_sign_in_at) < now() - interval '5 days'
     and not exists (
       select 1 from auth.sessions s
        where s.user_id = u.id
          and greatest(s.created_at, s.updated_at, s.refreshed_at at time zone 'utc') > now() - interval '5 days'
     );
  get diagnostics v_count = row_count;
  delete from public.guest_transfers where created_at < now() - interval '1 day';
  return v_count;
end $$;

create extension if not exists pg_cron with schema pg_catalog;
select cron.schedule('wipe-idle-guests', '30 3 * * *', 'select public.wipe_idle_guests()');

-- ---------------------------------------------------------------------
-- Permissions
-- ---------------------------------------------------------------------
revoke execute on function public.account_exists(text)       from public;
grant  execute on function public.account_exists(text)       to anon, authenticated;

revoke execute on function public.start_guest_transfer()     from public, anon;
revoke execute on function public.claim_guest(uuid)          from public, anon;
grant  execute on function public.start_guest_transfer()     to authenticated;
grant  execute on function public.claim_guest(uuid)          to authenticated;

revoke execute on function public.wipe_idle_guests()         from public, anon, authenticated;
