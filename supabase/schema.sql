-- Supabase (free tier) schema for the CODM community site.
-- Run the whole file in the Supabase dashboard: SQL Editor → New query → Run.
--
-- Two rules live here, not in the browser:
--   1. Moderation. An anonymous visitor can only ever insert rows already marked
--      'pending', and only a signed-in admin can flip a row to 'approved'.
--      A tampered request cannot publish itself, because the database ignores
--      whatever the browser claims about status.
--   2. Input shape. The CHECK constraints repeat the ladder and the length limits,
--      so a hand-made request cannot store a 50-page post or a rank that does not exist.

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

create table if not exists public.join_requests (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams (id) on delete cascade,
  visitor_id text not null check (char_length(visitor_id) between 8 and 64),
  nickname text not null check (char_length(nickname) between 2 and 24),
  created_at timestamptz not null default now(),
  unique (team_id, visitor_id)
);
create index if not exists join_requests_team_idx on public.join_requests (team_id);

-- ---------------- row level security ----------------
alter table public.posts enable row level security;
alter table public.comments enable row level security;
alter table public.likes enable row level security;
alter table public.teams enable row level security;
alter table public.join_requests enable row level security;

-- Each policy is dropped first so re-running this file repairs rather than fails.
drop policy if exists "posts readable" on public.posts;
drop policy if exists "posts queue" on public.posts;
drop policy if exists "posts admin write" on public.posts;
drop policy if exists "posts admin review" on public.posts;
drop policy if exists "posts admin delete" on public.posts;
drop policy if exists "comments readable" on public.comments;
drop policy if exists "comments queue" on public.comments;
drop policy if exists "comments admin write" on public.comments;
drop policy if exists "comments admin review" on public.comments;
drop policy if exists "comments admin delete" on public.comments;
drop policy if exists "likes readable" on public.likes;
drop policy if exists "likes on published" on public.likes;
drop policy if exists "likes admin" on public.likes;
drop policy if exists "teams readable" on public.teams;
drop policy if exists "teams admin write" on public.teams;
drop policy if exists "joins readable" on public.join_requests;
drop policy if exists "joins admin write" on public.join_requests;

-- Visitors read published content only; a signed-in admin also reads the queue.
create policy "posts readable" on public.posts
  for select using (status = 'approved' or auth.role() = 'authenticated');
-- Anyone can submit, but only as 'pending'.
create policy "posts queue" on public.posts
  for insert to anon with check (status = 'pending');
create policy "posts admin write" on public.posts
  for insert to authenticated with check (status in ('pending', 'approved'));
create policy "posts admin review" on public.posts
  for update to authenticated using (true) with check (status in ('pending', 'approved'));
create policy "posts admin delete" on public.posts
  for delete to authenticated using (true);

create policy "comments readable" on public.comments
  for select using (status = 'approved' or auth.role() = 'authenticated');
create policy "comments queue" on public.comments
  for insert to anon with check (status = 'pending');
create policy "comments admin write" on public.comments
  for insert to authenticated with check (status in ('pending', 'approved'));
create policy "comments admin review" on public.comments
  for update to authenticated using (true) with check (status in ('pending', 'approved'));
create policy "comments admin delete" on public.comments
  for delete to authenticated using (true);

-- Likes are counters, not content: public to read, and only on a published post.
create policy "likes readable" on public.likes for select using (true);
create policy "likes on published" on public.likes
  for insert to anon with check (
    exists (select 1 from public.posts p where p.id = post_id and p.status = 'approved')
  );
create policy "likes admin" on public.likes for all to authenticated using (true) with check (true);

-- Squads are published by the admin only.
create policy "teams readable" on public.teams for select using (true);
create policy "teams admin write" on public.teams for all to authenticated using (true) with check (true);
create policy "joins readable" on public.join_requests for select using (true);
create policy "joins admin write" on public.join_requests for all to authenticated using (true) with check (true);
