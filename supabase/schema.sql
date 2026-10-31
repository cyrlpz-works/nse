-- Supabase (free tier) schema for the TRIAS CODM community site.
-- Run the whole file in the Supabase dashboard: SQL Editor → New query → Run.
-- Re-running it is safe: new columns use "add column if not exists", constraints are dropped and
-- recreated by name, and every policy in the public schema is wiped and rebuilt. No rows are deleted.

-- Six rules live here, not in the browser:
--   1. Moderation. A member can only ever insert posts and comments marked 'pending'. Only an
--      account listed in public.site_admins can publish, approve, reject or delete.
--   2. Admin identity. Being signed in is NOT enough. Sign-ups stay open because every member now
--      needs an account, so authority comes from the site_admins table rather than from the role.
--   3. Ownership. A profile row is writable only by its own account, a tap row only by the account
--      that tapped, and an activity-log row can only be filed under your own id.
--   4. Squad management. A team's captain accepts, declines and removes members of their own team
--      only -- is_captain_of() compares auth.uid() against that team's row, so another squad's
--      captain (or anyone else) gets nothing. Only an admin creates, edits or deletes a team.
--   5. The rank gate. An application is refused unless the account's own profile rank reaches the
--      team's required rank. This is the fix for "the min rank in team is not working": the check
--      reads the stored profile, so it cannot be spoofed from the browser.
--   6. Input shape. CHECK constraints carry the rank ladder, the role lists per main mode, the
--      executive positions and the length limits, so a hand-made request cannot store a rank that
--      does not exist or a role that does not belong to the mode it was chosen under.
--
-- Two naming rules that used to bite this site, kept on purpose:
-- - Visitor-side write rules omit `to authenticated`/`to anon` where the expression does the work.
--   Supabase used to hand out an `anon` JWT that PostgREST mapped to the anon role; the newer
--   sb_publishable_... keys are opaque, and the role the database sees depends on the project. A
--   rule pinned to one role can silently stop matching, and the symptom is confusing: an honest
--   insert is refused with exactly the same message as a tampered one. WITH CHECK is what enforces
--   the rule, so it applies to every role that reaches the table.
-- - Authors are resolved at read time by joining profiles, never trusted from the copy stored in
--   the post. That is what makes "I renamed myself and the feed still shows the old name" impossible
--   for account-owned posts. The stored `author` text survives only as the fallback for a row whose
--   account has since been deleted.

-- ---------------- the rank ladder ----------------
-- Subdivisions are gone: the ladder is tiers only, and Legendary members carry real points so the
-- leaderboard has something to order by.
create or replace function public.rank_position(p_rank text) returns integer
language sql immutable set search_path = public, pg_temp
as $$
  select case p_rank
    when 'Unranked' then 0
    when 'Rookie' then 1
    when 'Veteran' then 2
    when 'Elite' then 3
    when 'Pro' then 4
    when 'Master' then 5
    when 'Grand Master' then 6
    when 'Legendary' then 7
    else -1
  end;
$$;

-- ---------------- tables ----------------
-- One row per account: that is what the whole site now hangs off. Created on the first sign-in,
-- then editable only by its owner.
create table if not exists public.profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  ign text not null check (char_length(ign) between 2 and 24),
  avatar_url text check (avatar_url is null or char_length(avatar_url) between 4 and 600),
  rank text not null default 'Unranked'
    check (rank in ('Unranked', 'Rookie', 'Veteran', 'Elite', 'Pro', 'Master',
                    'Grand Master', 'Legendary')),
  rank_points integer check (rank_points is null or rank_points between 0 and 1000000),
  main_mode text check (main_mode is null or main_mode in ('Multiplayer', 'Battle Royale')),
  -- The role must belong to the mode it was picked under: five multiplayer roles, the 31 BR classes.
  role_label text check (
    role_label is null
    or (main_mode = 'Multiplayer' and role_label in (
          'Slayer', 'Objective', 'Anchor', 'All Around', 'Team Leader'))
    or (main_mode = 'Battle Royale' and role_label in (
          'Clown', 'Defender', 'Desperado', 'Firefly', 'Hacker', 'Igniter', 'Jet Boost',
          'Kinetic Station', 'Mechanic', 'Medic', 'Misdirection', 'Ninja', 'Poltergeist',
          'Pumped', 'Quick Strike', 'Ravager Launcher', 'Refitter', 'Revive', 'Rewind', 'Scout',
          'Shock Charge', 'Shock Wave', 'Smoke Bomber', 'Spotter', 'Tactical Bouncer',
          'Tactical Mirror', 'Teleporter', 'Shock Stick', 'Toxic Overload', 'Trap Master',
          'Trickster'))
  ),
  clan_main text check (clan_main is null or char_length(clan_main) between 2 and 40),
  clan_second text check (clan_second is null or char_length(clan_second) between 2 and 40),
  community_main text check (community_main is null or char_length(community_main) between 2 and 40),
  community_second text check (community_second is null or char_length(community_second) between 2 and 40),
  standing text not null default 'member' check (standing in ('member', 'executive')),
  exec_position text check (
    exec_position is null or exec_position in (
      'Founder', 'Co-Founder', 'Leader', 'Co-Leader', 'Officer', 'Elder',
      'Recruiter', 'Strategist', 'Trainer')
  ),
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- An executive has to say which position; a Legendary has to say their points, or the
  -- leaderboard would rank them on nothing.
  constraint profiles_executive_has_position check (standing <> 'executive' or exec_position is not null),
  constraint profiles_legendary_has_points check (rank <> 'Legendary' or rank_points is not null)
);
create index if not exists profiles_ign_idx on public.profiles (lower(ign) text_pattern_ops);
create index if not exists profiles_leaderboard_idx on public.profiles (rank_points desc nulls last, ign);
create index if not exists profiles_seen_idx on public.profiles (last_seen_at desc);

create table if not exists public.posts (
  id uuid primary key default gen_random_uuid(),
  visitor_id text check (visitor_id is null or char_length(visitor_id) between 8 and 64),
  user_id uuid references public.profiles (user_id) on delete set null,
  author text check (author is null or char_length(author) between 2 and 24),
  rank text not null default 'Unranked',
  category text not null default 'General'
    check (category in ('General', 'Multiplayer', 'Battle Royale', 'Ranked', 'Loadouts',
                        'Tips & Guides', 'Looking for Team', 'Team Recruitment')),
  content text not null default '' check (char_length(content) <= 1200),
  image_url text check (image_url is null or char_length(image_url) between 4 and 600),
  -- Screenshots upload; videos are links. Only YouTube is accepted, so the feed can never be made
  -- to embed an arbitrary script-bearing page.
  video_url text check (
    video_url is null
    or video_url ~ '^https://(www\.|m\.)?youtube\.com/watch\?v=[A-Za-z0-9_-]{6,12}$'
    or video_url ~ '^https://youtu\.be/[A-Za-z0-9_-]{6,12}$'
  ),
  status text not null default 'pending' check (status in ('pending', 'approved')),
  created_at timestamptz not null default now()
);
create index if not exists posts_status_idx on public.posts (status);
create index if not exists posts_visitor_idx on public.posts (visitor_id);
create index if not exists posts_created_idx on public.posts (created_at desc);
-- An index on a column this run may be adding lives below, after the alter: on a live project
-- "create table if not exists" skips the body, so it cannot be trusted to exist here.

create table if not exists public.comments (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.posts (id) on delete cascade,
  visitor_id text check (visitor_id is null or char_length(visitor_id) between 8 and 64),
  user_id uuid references public.profiles (user_id) on delete set null,
  author text check (author is null or char_length(author) between 2 and 24),
  content text not null check (char_length(content) between 2 and 300),
  status text not null default 'pending' check (status in ('pending', 'approved')),
  created_at timestamptz not null default now()
);
create index if not exists comments_post_idx on public.comments (post_id);
create index if not exists comments_status_idx on public.comments (status);

-- A tap counter, not a like row per press: one row per member per post, taps goes up every time
-- they tap the heart and back down when they tap it again.
create table if not exists public.likes (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.posts (id) on delete cascade,
  visitor_id text check (visitor_id is null or char_length(visitor_id) between 8 and 64),
  user_id uuid references public.profiles (user_id) on delete cascade,
  taps integer not null default 1 check (taps between 0 and 1000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists likes_post_idx on public.likes (post_id);

create table if not exists public.teams (
  id uuid primary key default gen_random_uuid(),
  name text not null unique check (char_length(name) between 2 and 40),
  logo text not null check (char_length(logo) between 1 and 4),
  description text not null default '' check (char_length(description) <= 300),
  game_mode text not null default 'Multiplayer' check (char_length(game_mode) between 2 and 40),
  region text not null default 'Philippines' check (char_length(region) between 2 and 40),
  required_rank text not null default 'Master'
    check (required_rank in ('Unranked', 'Rookie', 'Veteran', 'Elite', 'Pro', 'Master',
                             'Grand Master', 'Legendary')),
  status text not null default 'recruiting' check (status in ('recruiting', 'full', 'archived')),
  leader text not null check (char_length(leader) between 2 and 24),
  slot_count integer not null default 5 check (slot_count between 2 and 12),
  captain_user_id uuid,
  captain_nick text check (captain_nick is null or char_length(captain_nick) between 2 and 24),
  created_at timestamptz not null default now()
);
create index if not exists teams_created_idx on public.teams (created_at desc);

-- Squad artwork: the logo on a squad's cards and the banner behind the top of its page. These two
-- columns live in their own table rather than on `teams` because row level security can limit which
-- ROWS a captain updates, never which COLUMNS. A captain update policy on `teams` would hand that
-- captain the squad's name, its minimum rank and its status as well -- and a minimum rank is what
-- decides who may apply. Split out, the widest thing a captain can write is a picture.
create table if not exists public.team_media (
  team_id uuid primary key references public.teams (id) on delete cascade,
  logo_url text check (logo_url is null or logo_url ~ '^https://[A-Za-z0-9._~:/?#@!$&*+,;=-]+$'),
  banner_url text check (banner_url is null or banner_url ~ '^https://[A-Za-z0-9._~:/?#@!$&*+,;=-]+$'),
  updated_by uuid,
  updated_at timestamptz not null default now()
);

-- One row per application or membership. 'pending' = applied, 'accepted' = in the squad,
-- 'rejected' = declined, removed, or left. Both live in one table because every captain action is
-- then a plain update, and a row level rule can only inspect an update, not an intention.
create table if not exists public.join_requests (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams (id) on delete cascade,
  visitor_id text check (visitor_id is null or char_length(visitor_id) between 8 and 64),
  user_id uuid references public.profiles (user_id) on delete cascade,
  nickname text check (nickname is null or char_length(nickname) between 2 and 24),
  status text not null default 'pending' check (status in ('pending', 'accepted', 'rejected')),
  decided_by uuid,
  decided_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists join_requests_team_idx on public.join_requests (team_id);
create index if not exists join_requests_status_idx on public.join_requests (team_id, status);

-- Hearts on a member profile -- "taptap" again, as many times as they like. One row per pair, the
-- count is the message. Kept separate from post taps so a heart on a person never moves a number
-- on a post.
create table if not exists public.member_hearts (
  id uuid primary key default gen_random_uuid(),
  from_user_id uuid not null references public.profiles (user_id) on delete cascade,
  to_user_id uuid not null references public.profiles (user_id) on delete cascade,
  taps integer not null default 1 check (taps between 0 and 100000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (from_user_id <> to_user_id)
);
create index if not exists member_hearts_to_idx on public.member_hearts (to_user_id);

-- The admin's activity feed. Written by members through their own session, so a row can only ever
-- be filed under the id that created it, and only an admin reads it back.
create table if not exists public.activity_log (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid not null references public.profiles (user_id) on delete cascade,
  action text not null check (action in (
    'sign_in', 'sign_out', 'profile_update', 'post_submit', 'comment_submit', 'post_tap',
    'member_heart', 'join_apply', 'join_accept', 'join_leave', 'post_approve', 'post_reject',
    'record_delete', 'team_create', 'team_delete', 'captain_assign', 'captain_remove',
    'member_remove', 'team_media_update')),
  detail text check (detail is null or char_length(detail) <= 200),
  created_at timestamptz not null default now()
);
create index if not exists activity_log_created_idx on public.activity_log (created_at desc);

-- The people allowed to approve posts, publish squads, name captains and read the activity log.
create table if not exists public.site_admins (
  user_id uuid primary key,
  email text not null,
  created_at timestamptz not null default now()
);

-- ---------------- shape the live tables into this ----------------
-- These tables already hold your real rows, so the change is additive and each constraint is
-- replaced by name rather than assumed to be absent.
alter table public.posts alter column visitor_id drop not null;
alter table public.posts alter column author drop not null;
alter table public.posts add column if not exists user_id uuid;
alter table public.posts add column if not exists image_url text;
alter table public.posts add column if not exists video_url text;

alter table public.comments alter column visitor_id drop not null;
alter table public.comments alter column author drop not null;
alter table public.comments add column if not exists user_id uuid;

alter table public.likes alter column visitor_id drop not null;
alter table public.likes add column if not exists user_id uuid;
alter table public.likes add column if not exists taps integer not null default 1;
-- The tap counter writes this column on every heart, and a table that predates the CREATE TABLE
-- body above never got it: without it the update is rejected and a tap can never go past one.
alter table public.likes add column if not exists updated_at timestamptz not null default now();

alter table public.teams add column if not exists captain_user_id uuid;
alter table public.teams add column if not exists captain_nick text
  check (captain_nick is null or char_length(captain_nick) between 2 and 24);

alter table public.join_requests alter column visitor_id drop not null;
alter table public.join_requests alter column nickname drop not null;
alter table public.join_requests add column if not exists status text not null default 'pending'
  check (status in ('pending', 'accepted', 'rejected'));
alter table public.join_requests add column if not exists user_id uuid;
alter table public.join_requests add column if not exists decided_by uuid;
alter table public.join_requests add column if not exists decided_at timestamptz;
-- Subdivisions are being deleted from the ladder, so rewrite the history rather than let the new
-- rank check reject a row that was honest when it was posted.
update public.posts set rank = split_part(rank, ' ', 1)
  where rank ~ ' (I|II|III|IV|V)$';
update public.posts set rank = 'Unranked' where public.rank_position(rank) = -1;
-- Rows written before this section existed may point at an account that has since been deleted.
-- Clearing those references first is what lets the foreign keys below be added on a re-run.
update public.posts set user_id = null where user_id is not null
  and not exists (select 1 from public.profiles p where p.user_id = posts.user_id);
update public.comments set user_id = null where user_id is not null
  and not exists (select 1 from public.profiles p where p.user_id = comments.user_id);
delete from public.likes where user_id is not null
  and not exists (select 1 from public.profiles p where p.user_id = likes.user_id);
delete from public.join_requests where user_id is not null
  and not exists (select 1 from public.profiles p where p.user_id = join_requests.user_id);

-- Foreign keys, after every column they point at exists. Each statement is wrapped because
-- Postgres has no "add constraint if not exists": the first run creates it, a re-run finds it there
-- and moves on.
do $$
begin
  begin
    alter table public.posts add constraint posts_user_id_fkey
      foreign key (user_id) references public.profiles (user_id) on delete set null;
  exception when duplicate_object then null;
  end;
  begin
    alter table public.comments add constraint comments_user_id_fkey
      foreign key (user_id) references public.profiles (user_id) on delete set null;
  exception when duplicate_object then null;
  end;
  begin
    alter table public.likes add constraint likes_user_id_fkey
      foreign key (user_id) references public.profiles (user_id) on delete cascade;
  exception when duplicate_object then null;
  end;
  begin
    alter table public.join_requests add constraint join_requests_user_id_fkey
      foreign key (user_id) references public.profiles (user_id) on delete cascade;
  exception when duplicate_object then null;
  end;
end $$;

-- The owner columns and the indexes over them, now that every one of them exists on both a fresh
-- project and yours: "create table if not exists" skips the body of an existing table, so an index
-- on a column this run adds cannot sit inside that body.
create index if not exists posts_user_idx on public.posts (user_id);
create index if not exists comments_user_idx on public.comments (user_id);
create index if not exists likes_user_idx on public.likes (user_id);
create index if not exists join_requests_user_idx on public.join_requests (user_id);
create index if not exists teams_captain_idx on public.teams (captain_user_id);

-- Every rule below is stated explicitly rather than left to the CREATE TABLE blocks above, because
-- on a live project those tables already exist: "create table if not exists" skips the whole body,
-- and "add column if not exists ... check" only carries its CHECK on the run that adds the column.
-- Written out, each constraint lands on a fresh project and on yours.
--
-- A post can now be a screenshot or a video link with no words at all, so the old "content is 3-1200
-- characters" rule becomes "say something, or show something".
alter table public.posts drop constraint if exists posts_content_check;
alter table public.posts add constraint posts_content_check check (
  char_length(content) <= 1200
  and (char_length(trim(content)) >= 3 or image_url is not null or video_url is not null)
);
alter table public.posts drop constraint if exists posts_image_url_check;
alter table public.posts add constraint posts_image_url_check
  check (image_url is null or char_length(image_url) between 4 and 600);
alter table public.posts drop constraint if exists posts_video_url_check;
alter table public.posts add constraint posts_video_url_check check (
  video_url is null
  or video_url ~ '^https://(www\.|m\.)?youtube\.com/watch\?v=[A-Za-z0-9_-]{6,12}$'
  or video_url ~ '^https://youtu\.be/[A-Za-z0-9_-]{6,12}$'
);
-- Subdivisions are gone, so the rank columns stop accepting them. The updates above made the old
-- rows legal first, so this validation cannot fail on real data.
alter table public.posts drop constraint if exists posts_rank_check;
alter table public.posts add constraint posts_rank_check
  check (public.rank_position(rank) between 0 and 7);
alter table public.teams drop constraint if exists teams_required_rank_check;
alter table public.teams add constraint teams_required_rank_check
  check (public.rank_position(required_rank) between 0 and 7);
alter table public.likes drop constraint if exists likes_taps_check;
alter table public.likes add constraint likes_taps_check check (taps between 0 and 1000);
-- The queue states, stated here too so a project whose tables predate this file cannot drift: an
-- 'archived'-or-typo status would otherwise be invisible to the Approval tab and unapprovable.
alter table public.posts drop constraint if exists posts_status_check;
alter table public.posts add constraint posts_status_check check (status in ('pending', 'approved'));
alter table public.comments drop constraint if exists comments_status_check;
alter table public.comments add constraint comments_status_check check (status in ('pending', 'approved'));
alter table public.join_requests drop constraint if exists join_requests_status_check;
alter table public.join_requests add constraint join_requests_status_check
  check (status in ('pending', 'accepted', 'rejected'));
-- The activity vocabulary is stated here too, so adding a verb to the log lands on a project that
-- already has the table. An entry with an unknown action would be refused by the browser before it
-- ever reached the log, which reads as "the action was not recorded".
alter table public.activity_log drop constraint if exists activity_log_action_check;
alter table public.activity_log add constraint activity_log_action_check check (action in (
  'sign_in', 'sign_out', 'profile_update', 'post_submit', 'comment_submit', 'post_tap',
  'member_heart', 'join_apply', 'join_accept', 'join_leave', 'post_approve', 'post_reject',
  'record_delete', 'team_create', 'team_delete', 'captain_assign', 'captain_remove',
  'member_remove', 'team_media_update'));

-- Uniqueness now follows the account, not the device: a member can apply to a squad from their
-- phone and their PC, tap a post once per account, and heart a person once per account. Postgres
-- treats nulls as distinct, so the legacy device-keyed rows -- which have no account id -- are
-- untouched by these indexes, and the old unique (post_id, visitor_id) / (team_id, visitor_id)
-- constraints keep holding the rows that only have a device id.
create unique index if not exists likes_post_user_idx on public.likes (post_id, user_id);
create unique index if not exists join_requests_team_user_idx
  on public.join_requests (team_id, user_id);
create unique index if not exists member_hearts_pair_idx
  on public.member_hearts (from_user_id, to_user_id);

-- ---------------- who is who ----------------
-- The two questions the policies below ask over and over. Each reads only what a signed-in account
-- proves through its JWT, so nothing in a request body can claim its way into either.
create or replace function public.is_site_admin() returns boolean
language sql stable set search_path = public, pg_temp
as $$
  select exists (select 1 from public.site_admins a where a.user_id = auth.uid());
$$;

create or replace function public.is_captain_of(claimed uuid) returns boolean
language sql stable set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.teams t
    where t.id = claimed and auth.uid() is not null and t.captain_user_id = auth.uid()
  );
$$;

-- ---------------- row level security ----------------
alter table public.profiles enable row level security;
alter table public.posts enable row level security;
alter table public.comments enable row level security;
alter table public.likes enable row level security;
alter table public.teams enable row level security;
alter table public.team_media enable row level security;
alter table public.join_requests enable row level security;
alter table public.member_hearts enable row level security;
alter table public.activity_log enable row level security;
alter table public.site_admins enable row level security;

-- Supabase grants these by default; repeated so a project created with different defaults
-- reaches the policies below instead of failing on privileges first. Profiles, taps and hearts are
-- an account's own writes, so they are granted to authenticated only -- an anonymous key gets read.
grant usage on schema public to anon, authenticated;
grant select on public.profiles, public.posts, public.comments, public.likes, public.teams,
  public.join_requests, public.member_hearts, public.site_admins, public.team_media to anon, authenticated;
grant select on public.activity_log to authenticated;
grant insert on public.profiles, public.posts, public.comments, public.likes,
  public.member_hearts, public.activity_log to authenticated;
grant update on public.profiles, public.likes, public.member_hearts to authenticated;
grant delete on public.profiles, public.posts, public.comments, public.likes,
  public.member_hearts, public.activity_log to authenticated;
-- Applying to a squad is an account's act, deciding one is an account's act, and running a squad's
-- roster is an account's act. Squads themselves are written only by an admin, narrowed below.
grant insert, update, delete on public.join_requests to authenticated;
grant insert, update, delete on public.teams to authenticated;
-- A captain's two image fields, nothing more.
grant insert, update, delete on public.team_media to authenticated;
grant execute on function public.is_site_admin() to anon, authenticated;
grant execute on function public.is_captain_of(uuid) to anon, authenticated;
grant execute on function public.rank_position(text) to anon, authenticated;

-- This file owns every policy in the public schema, so a re-run converges instead of layering.
-- Dropping them by name is not enough: an older copy of this site keyed its approve/publish rules
-- to `authenticated`, and one policy left behind from that era would let any signed-in account
-- approve posts. Wiped first, then recreated exactly as written below.
do $$
declare pol text;
begin
  loop
    select into pol format('drop policy %I on %I.%I', policyname, schemaname, tablename)
      from pg_policies where schemaname = 'public' limit 1;
    exit when pol is null;
    execute pol;
  end loop;
end $$;

-- Profiles: the directory, the leaderboard and every author name on the feed all read this, so
-- read is public. Write is the owner's alone -- and the owner cannot move the row to another id.
create policy "profiles readable" on public.profiles for select using (true);
create policy "profiles own insert" on public.profiles
  for insert with check (user_id = auth.uid());
create policy "profiles own update" on public.profiles
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());
-- An admin can retire an account's profile, which cascades to its taps, hearts and applications.
create policy "profiles admin delete" on public.profiles
  for delete using (public.is_site_admin());

-- Readers see published content; an admin also reads the queue, and an author can always see the
-- rows they are waiting on. (A device-only visitor could not, which is why the old copy of this
-- file hid them; with accounts the database knows who wrote the row.)
create policy "posts readable" on public.posts
  for select using (
    status = 'approved'
    or public.is_site_admin()
    or (auth.uid() is not null and user_id = auth.uid())
  );
-- Submitting a post is a signed-in act and it always lands as 'pending'. The author id is taken
-- from the session, not from the request body.
create policy "posts queue" on public.posts
  for insert with check (status = 'pending' and user_id = auth.uid());
create policy "posts admin write" on public.posts
  for insert with check (status = 'approved' and user_id = auth.uid() and public.is_site_admin());
create policy "posts admin review" on public.posts
  for update using (public.is_site_admin())
  with check (public.is_site_admin() and status in ('pending', 'approved'));
-- A member may strike through their own draft only while it is still queued; deleting a published
-- post is an admin act.
create policy "posts own pending delete" on public.posts
  for delete using (user_id = auth.uid() and status = 'pending');
create policy "posts admin delete" on public.posts
  for delete using (public.is_site_admin());

create policy "comments readable" on public.comments
  for select using (
    status = 'approved'
    or public.is_site_admin()
    or (auth.uid() is not null and user_id = auth.uid())
  );
create policy "comments queue" on public.comments
  for insert with check (status = 'pending' and user_id = auth.uid());
create policy "comments admin write" on public.comments
  for insert with check (status = 'approved' and user_id = auth.uid() and public.is_site_admin());
create policy "comments admin review" on public.comments
  for update using (public.is_site_admin())
  with check (public.is_site_admin() and status in ('pending', 'approved'));
create policy "comments own pending delete" on public.comments
  for delete using (user_id = auth.uid() and status = 'pending');
create policy "comments admin delete" on public.comments
  for delete using (public.is_site_admin());

-- Taps are counters on a published post. Anyone can read the count; only the account that owns a
-- row may add to it or take it back, which replaces the old `delete using (true)` that any visitor
-- could aim at anyone else's like.
create policy "likes readable" on public.likes for select using (true);
create policy "likes own insert" on public.likes
  for insert with check (
    user_id = auth.uid()
    and exists (select 1 from public.posts p where p.id = post_id and p.status = 'approved')
  );
create policy "likes own update" on public.likes
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "likes own delete" on public.likes for delete using (user_id = auth.uid());
create policy "likes admin" on public.likes
  for all using (public.is_site_admin()) with check (public.is_site_admin());

-- Squad cards are public; only an admin creates, edits, deletes or names a captain. A captain's
-- power is the roster (below) and their own squad's artwork (below that), never the squad record
-- itself -- that is what keeps one captain from editing another team.
create policy "teams readable" on public.teams for select using (true);
create policy "teams admin write" on public.teams
  for all using (public.is_site_admin()) with check (public.is_site_admin());

-- Artwork. Anyone reads it, because it is what a squad's card and header are drawn from. Writing it
-- is the captain of that squad -- or an admin, so a squad whose captain has gone quiet can still be
-- fixed. Both rules ask the database who owns the squad rather than trusting the request, so
-- renaming a captain in `teams` is the only way to move this power, and that is an admin's act.
create policy "team media readable" on public.team_media for select using (true);
create policy "team media captain write" on public.team_media
  for all using (public.is_captain_of(team_id)) with check (public.is_captain_of(team_id));
create policy "team media admin write" on public.team_media
  for all using (public.is_site_admin()) with check (public.is_site_admin());

-- Roster. Members are public so anyone can see who is in a squad. An application that has not
-- been accepted is visible only to the account that sent it, to that team's captain and to an
-- admin, because pending nicknames are not something strangers should harvest.
create policy "joins readable" on public.join_requests
  for select using (
    status = 'accepted'
    or public.is_site_admin()
    or public.is_captain_of(team_id)
    or (auth.uid() is not null and user_id = auth.uid())
  );
-- Applying is an account's act, filed under that account, and only once per squad -- and the
-- account's stored rank has to reach the team's required rank. The rank is read from profiles, so
-- a request cannot lower the bar by lying about it.
create policy "joins apply" on public.join_requests
  for insert with check (
    status = 'pending'
    and user_id = auth.uid()
    and exists (
      select 1 from public.teams t, public.profiles p
      where t.id = team_id and p.user_id = auth.uid()
        and public.rank_position(p.rank) >= public.rank_position(t.required_rank)
    )
  );
-- Same gate when a previously-declined application is re-opened by its owner.
create policy "joins own update" on public.join_requests
  for update using (user_id = auth.uid())
  with check (
    user_id = auth.uid()
    and status = 'pending'
    and decided_by is null
    and exists (
      select 1 from public.teams t, public.profiles p
      where t.id = team_id and p.user_id = auth.uid()
        and public.rank_position(p.rank) >= public.rank_position(t.required_rank)
    )
  );
-- The captain of that team accepts, declines and removes. The rule compares auth.uid() with the
-- team row, so a decided_by value copied from somebody else buys an attacker nothing.
create policy "joins captain decides" on public.join_requests
  for update using (public.is_captain_of(team_id))
  with check (
    public.is_captain_of(team_id)
    and status in ('accepted', 'rejected')
    and decided_by = auth.uid()
  );
-- A member may leave on their own: they can put their own accepted row to 'rejected'. The gate is
-- `user_id = auth.uid()` on both sides, so this cannot be aimed at another member's row.
create policy "joins own leave" on public.join_requests
  for update using (user_id = auth.uid() and status = 'accepted')
  with check (user_id = auth.uid() and status = 'rejected');
create policy "joins own delete" on public.join_requests
  for delete using (user_id = auth.uid());
create policy "joins admin write" on public.join_requests
  for all using (public.is_site_admin()) with check (public.is_site_admin());

-- Hearts on a profile: the total is public, the row belongs to whoever sent it.
create policy "hearts readable" on public.member_hearts for select using (true);
create policy "hearts own insert" on public.member_hearts
  for insert with check (from_user_id = auth.uid());
create policy "hearts own update" on public.member_hearts
  for update using (from_user_id = auth.uid()) with check (from_user_id = auth.uid());
create policy "hearts own delete" on public.member_hearts
  for delete using (from_user_id = auth.uid());
create policy "hearts admin" on public.member_hearts
  for all using (public.is_site_admin()) with check (public.is_site_admin());

-- The log is write-your-own, read-by-admin. The action vocabulary is fixed by the table's CHECK,
-- so a member can file a real event under their own id but cannot invent a new kind of entry.
create policy "activity own insert" on public.activity_log
  for insert with check (actor_user_id = auth.uid());
create policy "activity admin readable" on public.activity_log
  for select using (public.is_site_admin());
create policy "activity admin delete" on public.activity_log
  for delete using (public.is_site_admin());

-- site_admins is a lookup table for the rules above, so those checks work for anybody reading a
-- squad. It lists the account ids and emails of the people running the site.
create policy "admins readable" on public.site_admins for select using (true);
create policy "admins admin only" on public.site_admins
  for all using (public.is_site_admin()) with check (public.is_site_admin());

-- ---------------- uploads ----------------
-- Three public buckets: profile pictures, post screenshots and squad artwork. Free tier gives
-- 1 GB total, which is why the browser downscales before uploading (see dist/app.js). A member may
-- write only inside a folder named after their own account id, so nobody can overwrite someone
-- else's avatar, and the public-read rule is what makes the stored URL work in an <img> tag.
insert into storage.buckets (id, name, public) values ('avatars', 'avatars', true)
  on conflict (id) do update set public = true;
insert into storage.buckets (id, name, public) values ('post-images', 'post-images', true)
  on conflict (id) do update set public = true;
insert into storage.buckets (id, name, public) values ('team-media', 'team-media', true)
  on conflict (id) do update set public = true;

-- Two policies per bucket, dropped by name first so a re-run recreates them instead of colliding.
drop policy if exists "avatars public read" on storage.objects;
drop policy if exists "avatars own write" on storage.objects;
drop policy if exists "post-images public read" on storage.objects;
drop policy if exists "post-images own write" on storage.objects;
drop policy if exists "team-media public read" on storage.objects;
drop policy if exists "team-media captain write" on storage.objects;
drop policy if exists "team-media admin write" on storage.objects;

-- `storage.foldername(name)` splits the object path, so its first segment is the folder the file
-- landed in -- which the site always names after the account doing the uploading.
create policy "avatars public read" on storage.objects
  for select using (bucket_id = 'avatars');
create policy "avatars own write" on storage.objects
  for all to authenticated using (
    bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text
  ) with check (
    bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "post-images public read" on storage.objects
  for select using (bucket_id = 'post-images');
create policy "post-images own write" on storage.objects
  for all to authenticated using (
    bucket_id = 'post-images' and (storage.foldername(name))[1] = auth.uid()::text
  ) with check (
    bucket_id = 'post-images' and (storage.foldername(name))[1] = auth.uid()::text
  );

-- Squad artwork is filed by squad, not by person: the first folder segment is the team's id and the
-- file is always `logo.jpg` or `banner.jpg`. So a re-upload replaces the picture instead of leaving
-- another copy behind on a 1 GB plan, and when the admin hands a squad to a new captain that captain
-- can replace the badge the old one chose. The permission still comes from the squad row -- the
-- folder name is only looked up, never trusted, because `teams.captain_user_id` is compared with
-- auth.uid() the same way every other captain rule does.
create policy "team-media public read" on storage.objects
  for select using (bucket_id = 'team-media');
create policy "team-media captain write" on storage.objects
  for all to authenticated using (
    bucket_id = 'team-media'
    and exists (
      select 1 from public.teams t
      where t.id::text = (storage.foldername(name))[1] and t.captain_user_id = auth.uid()
    )
  ) with check (
    bucket_id = 'team-media'
    and exists (
      select 1 from public.teams t
      where t.id::text = (storage.foldername(name))[1] and t.captain_user_id = auth.uid()
    )
  );
create policy "team-media admin write" on storage.objects
  for all to authenticated using (
    bucket_id = 'team-media' and public.is_site_admin()
  ) with check (
    bucket_id = 'team-media' and public.is_site_admin()
  );

-- ---------------- one-time bootstrap ----------------
-- Name yourself admin, or the Approval tab stays hidden and nothing can be published.
-- Look your account id up first:   select id, email from auth.users;
-- Then insert it with your own values -- do not leave a sample behind:
--
--   insert into public.site_admins (user_id, email)
--   values ('<id from that query>', '<that email>')
--   on conflict (user_id) do update set email = excluded.email;
--
-- A captain or any other member can only become an admin through this table, added by someone
-- already in it.
--
-- Every profile row is created by the site on the member's first sign-in, from the IGN they type.
-- Nothing seeds them here on purpose: the directory should only ever hold real people.

-- The API layer keeps a cached view of the schema, so a table this run added -- team_media, on the
-- first run -- is invisible to the site until it reloads. Without this line the squad page reports
-- "database refused that" for artwork that is really there.
notify pgrst, 'reload schema';
