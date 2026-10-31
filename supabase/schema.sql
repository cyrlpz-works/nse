-- Supabase (free tier) schema for the TRIAS CODM community site.
-- Run the whole file in the Supabase dashboard: SQL Editor → New query → Run.
-- Re-running it is safe: new columns use "add column if not exists" and every policy is dropped
-- and recreated. No rows are deleted.
--
-- Four rules live here, not in the browser:
--   1. Moderation. A visitor can only ever insert rows marked 'pending'. Only an account listed
--      in public.site_admins can publish, approve, reject or delete.
--   2. Admin identity. Being signed in is NOT enough. Sign-ups stay open so team captains can
--      have logins, so authority comes from the site_admins table rather than from the role.
--   3. Squad management. A team's captain may accept or reject join requests and remove members
--      of their own team only. They cannot edit the team's details or touch anything else.
--   4. Input shape. The CHECK constraints repeat the rank ladder and the length limits, so a
--      hand-made request cannot store a 50-page post or a rank that does not exist.
--
-- Visitor-side write rules deliberately omit `to anon`. Supabase used to hand out an `anon`
-- JWT that PostgREST mapped to the anon role; the newer sb_publishable_... keys are opaque, and
-- the role the database sees depends on the project. A rule written `to anon` can silently stop
-- matching, and the symptom is confusing: an honest pending insert is refused with exactly the
-- same message as a tampered one. The WITH CHECK expression is what enforces moderation, so it
-- has to apply to every non-admin role.

-- ---------------- tables ----------------
create table if not exists public.posts (
  id uuid primary key default gen_random_uuid(),
  visitor_id text not null check (char_length(visitor_id) between 8 and 64),
  author text not null check (char_length(author) between 2 and 24),
  rank text not null default 'Unranked'
    check (rank ~ '^(Unranked|(Rookie|Veteran|Elite|Pro)( (I|II|III|IV|V))?|Master|Grand Master|Legendary)$'),
  category text not null default 'General'
    check (category in ('General', 'Multiplayer', 'Battle Royale', 'Ranked', 'Loadouts',
                        'Tips & Guides', 'Looking for Team', 'Team Recruitment')),
  content text not null check (char_length(content) between 3 and 1200),
  status text not null default 'pending' check (status in ('pending', 'approved')),
  created_at timestamptz not null default now()
);
create index if not exists posts_status_idx on public.posts (status);
create index if not exists posts_visitor_idx on public.posts (visitor_id);
create index if not exists posts_created_idx on public.posts (created_at desc);

create table if not exists public.comments (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.posts (id) on delete cascade,
  visitor_id text not null check (char_length(visitor_id) between 8 and 64),
  author text not null check (char_length(author) between 2 and 24),
  content text not null check (char_length(content) between 2 and 300),
  status text not null default 'pending' check (status in ('pending', 'approved')),
  created_at timestamptz not null default now()
);
create index if not exists comments_post_idx on public.comments (post_id);
create index if not exists comments_status_idx on public.comments (status);

create table if not exists public.likes (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.posts (id) on delete cascade,
  visitor_id text not null check (char_length(visitor_id) between 8 and 64),
  created_at timestamptz not null default now(),
  unique (post_id, visitor_id)
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
    check (required_rank in ('Unranked', 'Rookie', 'Veteran', 'Elite', 'Pro', 'Master', 'Grand Master', 'Legendary')),
  status text not null default 'recruiting' check (status in ('recruiting', 'full', 'archived')),
  leader text not null check (char_length(leader) between 2 and 24),
  slot_count integer not null default 5 check (slot_count between 2 and 12),
  created_at timestamptz not null default now()
);
create index if not exists teams_created_idx on public.teams (created_at desc);

-- One row per application or membership. 'pending' = applied, 'accepted' = in the squad,
-- 'rejected' = declined or removed. Both live in one table because every captain action is then
-- a plain update, and a row level rule can only inspect an update, not an intention.
create table if not exists public.join_requests (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams (id) on delete cascade,
  visitor_id text not null check (char_length(visitor_id) between 8 and 64),
  nickname text not null check (char_length(nickname) between 2 and 24),
  status text not null default 'pending' check (status in ('pending', 'accepted', 'rejected')),
  created_at timestamptz not null default now(),
  unique (team_id, visitor_id)
);
create index if not exists join_requests_team_idx on public.join_requests (team_id);

-- The people allowed to approve posts, publish squads and name captains.
create table if not exists public.site_admins (
  user_id uuid primary key,
  email text not null,
  created_at timestamptz not null default now()
);

-- Squad columns added to tables that already hold your real rows. A captain is an account rather
-- than a device id on purpose: visitor ids are readable through the public API, so a rule built
-- on them could be replayed by whoever reads them.
alter table public.teams add column if not exists captain_user_id uuid;
alter table public.teams add column if not exists captain_nick text
  check (captain_nick is null or char_length(captain_nick) between 2 and 24);
alter table public.join_requests add column if not exists status text not null default 'pending'
  check (status in ('pending', 'accepted', 'rejected'));
alter table public.join_requests add column if not exists user_id uuid;
alter table public.join_requests add column if not exists decided_by uuid;
alter table public.join_requests add column if not exists decided_at timestamptz;
create index if not exists teams_captain_idx on public.teams (captain_user_id);
create index if not exists join_requests_status_idx on public.join_requests (team_id, status);
create index if not exists join_requests_user_idx on public.join_requests (user_id);

-- ---------------- who is who ----------------
-- The two questions the policies below ask over and over. Each reads only what a signed-in
-- account proves through its JWT, so nothing in a request body can claim its way into either.
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
alter table public.posts enable row level security;
alter table public.comments enable row level security;
alter table public.likes enable row level security;
alter table public.teams enable row level security;
alter table public.join_requests enable row level security;
alter table public.site_admins enable row level security;

-- Supabase grants these by default; repeated so a project created with different defaults
-- reaches the policies below instead of failing on privileges first.
grant usage on schema public to anon, authenticated;
grant select on public.posts, public.comments, public.likes, public.teams, public.join_requests,
  public.site_admins to anon, authenticated;
grant insert, update, delete on public.posts, public.comments, public.likes to anon, authenticated;
-- Applying to a squad is an anonymous act, so the insert has to reach the anon role; deciding an
-- application is an account's act, so update stays with authenticated. Squads themselves are
-- written only by an admin, which the policies below narrow further.
grant insert on public.join_requests to anon, authenticated;
grant update on public.join_requests to authenticated;
grant insert, update, delete on public.teams to authenticated;
grant execute on function public.is_site_admin() to anon, authenticated;
grant execute on function public.is_captain_of(uuid) to anon, authenticated;

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

-- Readers see published content; an admin also reads the queue.
create policy "posts readable" on public.posts
  for select using (status = 'approved' or public.is_site_admin());
-- Anyone can submit, but only as 'pending'.
create policy "posts queue" on public.posts
  for insert with check (status = 'pending');
create policy "posts admin write" on public.posts
  for insert with check (status = 'approved' and public.is_site_admin());
create policy "posts admin review" on public.posts
  for update using (public.is_site_admin())
  with check (public.is_site_admin() and status in ('pending', 'approved'));
create policy "posts admin delete" on public.posts
  for delete using (public.is_site_admin());

create policy "comments readable" on public.comments
  for select using (status = 'approved' or public.is_site_admin());
create policy "comments queue" on public.comments
  for insert with check (status = 'pending');
create policy "comments admin write" on public.comments
  for insert with check (status = 'approved' and public.is_site_admin());
create policy "comments admin review" on public.comments
  for update using (public.is_site_admin())
  with check (public.is_site_admin() and status in ('pending', 'approved'));
create policy "comments admin delete" on public.comments
  for delete using (public.is_site_admin());

-- Likes are counters, not content: public to read, and only on a published post.
create policy "likes readable" on public.likes for select using (true);
create policy "likes on published" on public.likes
  for insert with check (
    exists (select 1 from public.posts p where p.id = post_id and p.status = 'approved')
  );
-- A visitor must be able to take their like back. A visitor has no server-side identity, so this
-- delete rule cannot be narrower than 'any row' -- the README records what that costs.
create policy "likes undoable" on public.likes for delete using (true);
create policy "likes admin" on public.likes
  for all using (public.is_site_admin()) with check (public.is_site_admin());

-- Squad cards are public; only an admin creates, edits or archives one -- which is also how a
-- captain gets named.
create policy "teams readable" on public.teams for select using (true);
create policy "teams admin write" on public.teams
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
-- Applying needs no account: the row is always recorded as unapproved.
create policy "joins apply" on public.join_requests
  for insert with check (status = 'pending');
-- The captain of that team accepts, declines and removes. The rule compares auth.uid() with the
-- team row, so a decided_by value copied from somebody else buys an attacker nothing.
create policy "joins captain decides" on public.join_requests
  for update using (public.is_captain_of(team_id))
  with check (
    public.is_captain_of(team_id)
    and status in ('accepted', 'rejected')
    and decided_by = auth.uid()
  );
create policy "joins admin write" on public.join_requests
  for all using (public.is_site_admin()) with check (public.is_site_admin());

-- site_admins is a lookup table for the rules above, so those checks work for anybody reading a
-- squad. It lists the account ids and emails of the people running the site.
create policy "admins readable" on public.site_admins for select using (true);
create policy "admins admin only" on public.site_admins
  for all using (public.is_site_admin()) with check (public.is_site_admin());

-- ---------------- one-time bootstrap ----------------
-- Name yourself admin, or the Approval tab stays hidden and nothing can be published.
-- Look your account id up first:   select id, email from auth.users;
-- Then insert it with your own values -- do not leave a sample behind:
--
--   insert into public.site_admins (user_id, email)
--   values ('<id from that query>', '<that email>')
--   on conflict (user_id) do update set email = excluded.email;
--
-- A captain can only become an admin through this table, added by someone already in it.
