# TRIAS · CODM Community

Community hub for a Call of Duty Mobile squad community: a news feed of text, screenshots and
clips, member profiles, squads with join requests, a points leaderboard, and an admin-run
approval queue.

**Everything that writes belongs to an account.** Visitors read the site freely; to post,
comment, tap a heart, ask to join a squad or edit a profile you sign in first. Nothing a member
publishes reaches the feed until the site admin approves it, so nudity and spam stop at the
Approval page. Squad captains run their own roster and choose their own squad logo and banner --
and nothing else.

The live site is static **GitHub Pages** plus a free **Supabase** project (Postgres with row
level security, Auth for accounts, Storage for pictures). No server code runs on Pages, and none
is needed: the database enforces moderation, ownership and the input rules by itself.

Live: https://cyrlpz-works.github.io/TRIAS-Community/

## Layout

```
dist/            published website (index.html, styles.css, app.js, api.js, config.js)
dist/config.js   the two Supabase values — the only file you edit to connect the site
supabase/        schema.sql: tables, RLS policies, CHECK rules, storage buckets (run this in Supabase)
index.html       redirect stub so GitHub Pages opens the app in dist/
legacy/          the original single-file page, kept for reference
dev/             preview-server.mjs — serves dist/ locally; never published
```

`supabase/schema.sql` is the only file that belongs in the Supabase SQL Editor — it is written
for Supabase's `public` schema and its own `auth.uid()` / `storage.foldername()` helpers.

## Connect the site to Supabase (one-time, free)

1. [supabase.com](https://supabase.com) → New project. Any region, the free plan.
2. SQL Editor → New query → paste the whole contents of `supabase/schema.sql` → **Run**.
   Re-running it is safe: rows are kept, missing columns are added, and every policy in the
   `public` schema is dropped and recreated from this file. **Do this before deploying a new
   `dist/`** — the current frontend reads `profiles`, and against an un-migrated project the
   feed, squads and members all come back empty.
3. Authentication → Sign In / Providers → Email: turn **Confirm email** off. Without it, a
   member who signs up from the site has no session and cannot use the account they just made.
4. Authentication → Users → Add user: the admin email and a long, unique password.
5. SQL Editor → name that account as an admin. The site treats a merely signed-in account as a
   stranger until it has a row in `site_admins`:

   ```sql
   select id, email from auth.users;          -- read your own row
   insert into public.site_admins (user_id, email)
   values ('the id from that query', 'that email')
   on conflict (user_id) do update set email = excluded.email;
   ```

6. Project Settings → API: copy the **Project URL** and the **anon public** key.
7. Put both values in `dist/config.js`, commit, and let Pages rebuild.

With email confirmation off, anyone can also create their own account from the site's
**Create an account** button — that is how members, captains and the leaderboard get populated.
It does not make them an admin: only a row in `site_admins` does.

There are two doors in the header, and both speak to the same account system: **Sign in** is the
member door (sign in, sign up), **Admin** is a quiet one that signs an account in and then signs it
straight back out again unless it is listed in `site_admins`. Neither door grants a permission —
they only decide which words a visitor reads before typing a password.

The anon key is meant to be public — it identifies the project, it does not grant access.
Every request is checked against the policies in `supabase/schema.sql`. The **service_role**
key is never used by this site and must never appear in it.

## Running it locally

```bash
node dev/preview-server.mjs 4173     # http://127.0.0.1:4173 serves dist/
```

It only serves files. `dist/` talks to Supabase directly, so the preview runs the real feed,
profiles and sign-in against your project — no fake backend in the middle.

With empty values in `dist/config.js` the site still renders: it shows the design, an empty
feed and squads, and one notice explaining that no database is connected. Nothing is posted, so
there are no error toasts.

## Pages of the site

| Page | What is there |
| --- | --- |
| Home | stats, recruiting squads, the top five of the leaderboard, who is online, latest posts |
| Feed | the composer (text, screenshot, YouTube link) and every approved post |
| Squads | squad cards, filters, the squad page with its roster, applications and its own logo and banner. A squad starts empty — every slot is open until an application is accepted |
| Members | every account, searchable by IGN; tap a card for that player's profile |
| Ranks | the points leaderboard |
| Profile | your own account: face, IGN, rank and points, mode and role, standing, groups |
| Approval | admin only: the queue, member search, totals, the activity log, captain assignments |

## Accounts, profiles and what they can do

Signing in buys nothing by itself. The database compares the account against
`public.site_admins` (site admin) and against `public.teams.captain_user_id` (squad captain),
and every row you write is stamped with `auth.uid()`.

A profile is: an **avatar** (uploaded, resized in the browser before it is stored), an **IGN**
— the nickname that appears on your posts — a **rank tier** plus optional **rank points**
(points are required for Legendary because they are what the leaderboard sorts by), a **main
mode** with one role from that mode, a **standing** of member or executive (an executive picks a
position: Founder, Co-Founder, Leader, Co-Leader, Officer, Elder, Recruiter, Strategist,
Trainer), and two groups each with a second: **main clan / second clan** and **main community /
second community**.

| Action | Who can do it | Where it is enforced |
| --- | --- | --- |
| Read the feed, squads, members, leaderboard | anyone | RLS: `status = 'approved'` selects |
| Create an account and a profile | anyone | `profiles` insert/update is own row only |
| Post, comment, tap a heart, apply to a squad | a signed-in member | RLS: writes require `user_id = auth.uid()` |
| Have a post reach the feed | the site admin approves it | RLS: only `is_site_admin()` may set `status = 'approved'` |
| Delete a post (queued or published) | its author while queued; the admin any time | RLS: `posts` delete policies |
| Heart a post or a member several times | anyone signed in, once per account per target | `likes (post_id, user_id)` and `member_hearts (from_user_id, to_user_id)` are unique; a `taps` counter grows |
| Publish, edit or remove a squad | the site admin only | RLS: `teams` writes require `is_site_admin()` |
| Accept, decline, remove or name a roster row | that squad's captain, or the site admin | RLS: `is_captain_of(team_id)` + `decided_by = auth.uid()`, plus `joins admin write` for the admin |
| Set a squad's logo and banner | that squad's captain, or the admin | RLS: `team_media` writes require `is_captain_of(team_id)`; the `team-media` bucket folder is the squad id |
| Leave a squad you are in | you | RLS: `joins own leave` narrows it to your own accepted row |
| Join a squad | you, if your profile's rank reaches its minimum | RLS: `joins apply` compares `rank_position(profiles.rank)` with `teams.required_rank` |
| Name a squad's captain | the site admin | RLS: it is a `teams` update; naming an applicant also accepts that applicant's own pending row |
| Add someone to `site_admins` | an existing site admin | RLS: `admins admin only` |
| Read the activity log | the site admin | RLS: `activity_log` is admin-readable, member-insertable |

A captain therefore cannot rewrite a squad's card, approve a post, or touch another squad: the
rows they may update are the join requests of the one team that lists their account, plus that
team's two pictures. Those pictures live in their own table, `public.team_media`, for exactly this
reason -- row level security can filter which ROWS an account updates but never which COLUMNS, so
a captain write policy on `teams` would have handed that captain the squad's name and its minimum
rank along with the logo. The squad record itself stays writable only by an admin, which is what
keeps one captain out of another captain's roster.

A rename needs no repair pass. The feed, the comments, the members page and the leaderboard all
read the author's live `profiles` row, so changing your IGN in Profile changes it everywhere at
once. The `author` / `rank` columns on a post are a snapshot kept only for the case where the
account is deleted — then the byline falls back to "Former member" instead of breaking.

A rejected post loses its comments, likes and hearts — those tables reference `posts (id)` with
`on delete cascade`. Approved posts appear for every visitor within the 60-second refresh the
page already does.

## Ranked ladder

The ladder has no subdivisions any more: a tier is the whole rank. It is enforced twice — the
selects in `dist/app.js` and `public.rank_position(text)` / a `CHECK` constraint in Postgres,
which rejects anything outside this list.

| Tier | Ranked points |
| --- | --- |
| Unranked | not placed yet |
| Rookie | 0 – 1,000 |
| Veteran | 1,001 – 2,000 |
| Elite | 2,001 – 3,000 |
| Pro | 3,001 – 4,500 |
| Master | 4,501 – 6,000 |
| Grand Master | 6,001 – 8,000 |
| Legendary | 8,001+ — points are required |

Points are what the **Ranks** page sorts by, so a Legendary player who does not enter them has
nothing to be placed by. A squad's `required_rank` is a tier, and the database compares it with
each applicant's own profile rank when they apply.

## Roles by main mode

The mode decides which list the role select offers, and the same rule is a `CHECK` in the
database — a Battle Royale class cannot be saved on a Multiplayer profile.

- **Multiplayer**: Slayer, Objective, Anchor, All Around, Team Leader.
- **Battle Royale** (class): Clown, Defender, Desperado, Firefly, Hacker, Igniter, Jet Boost,
  Kinetic Station, Mechanic, Medic, Misdirection, Ninja, Poltergeist, Pumped, Quick Strike,
  Ravager Launcher, Refitter, Revive, Rewind, Scout, Shock Charge, Shock Wave, Smoke Bomber,
  Spotter, Tactical Bouncer, Tactical Mirror, Teleporter, Shock Stick, Toxic Overload,
  Trap Master, Trickster.

## How data is stored

| Data | Where | Shared between visitors |
| --- | --- | --- |
| Posts (text, screenshot, clip link) | `public.posts` | yes |
| Comments, post hearts | `public.comments`, `public.likes` | yes |
| Profiles: IGN, avatar, rank, points, mode, role, standing, groups | `public.profiles` | yes — this is what the feed reads |
| Member hearts | `public.member_hearts` | yes |
| Squads, join requests, captains | `public.teams`, `public.join_requests` | yes |
| A squad's logo and banner | `public.team_media` (two URLs; the files are in Storage) | yes |
| Who runs the site | `public.site_admins` | yes, read by the policies |
| Activity log | `public.activity_log` | admin-readable only |
| Picture files | Storage buckets `avatars`, `post-images` and `team-media` | public read; the first two are own-folder write, `team-media` is folder-per-squad and writable by that squad's captain |
| Session | `localStorage` (Supabase auth token) | proves which account this browser is |
| Submission timer | `localStorage` (`jt.last.*`) | courtesy cooldown only |

`visitor_id` columns still exist for rows written before accounts, and the old device-keyed
unique constraints still hold them; new rows are keyed by `user_id`.

Input rules enforced in Postgres: a post says something **or** shows something (text of 3–1200
characters, or an image, or a clip link), clip links are YouTube only (`youtube.com/watch?v=` /
`youtu.be/`), comments are 2–300 characters, the category whitelist, the rank ladder, IGN length
(2–24), executive requires a position, Legendary requires points, hearts and taps are counted
per account, squad name length and uniqueness, `slot_count` between 2 and 12, one application
per account per squad. A squad's `logo_url` / `banner_url` must be a plain `https://` address with
no spaces, quotes or parentheses in it, which is also what lets the banner be painted as a CSS
background without a stored value being able to break out of the declaration.

## Known limits, stated plainly

- **Pictures cost storage.** The free plan gives 1 GB in total. Avatars are resized to 256 px
  and stored at one fixed path per account, so changing your picture replaces it instead of
  piling up. Squad artwork is the same idea per squad: the logo is kept at 256 px and the banner
  at 1600 px, each at one fixed path inside a folder named after the squad, so a captain
  re-uploading replaces the file. Post screenshots are resized to 1200 px but each one is its own
  object, and deleting the post does not delete the file — the `post-images` bucket is pruned from
  the Supabase Storage dashboard when you want the space back. Deleting a squad removes its
  `team_media` row (cascade) but leaves its two files in the bucket.
- **"Online" is a heartbeat**, not a connection: the page stamps `last_seen_at` once a minute
  and anyone seen in the last three minutes shows as online. A browser left open on a table
  looks like a person.
- The 60-second pause between submissions is a per-device timer in the browser, not a server
  rate limit. The real protection against spam is that nothing publishes without approval.
- A declined applicant cannot send a second request to the same squad from the same account: the
  unique `(team_id, user_id)` index covers the row whichever status it ended in, and the site
  reports "You already asked to join this squad." There is no undo for a decline — a captain
  re-reading an application they turned down has to do it from the Supabase dashboard.
- Deleting an account from Supabase leaves its posts behind with the byline "Former member"
  (`on delete set null`); hearts, likes and roster rows go with it (`on delete cascade`).
- Anyone who knows the admin password has full write access. Keep it unique, and add a second
  row in `site_admins` instead of sharing it.
- The clip player is a click-to-load facade over `youtube-nocookie.com`, so no third-party
  script runs until someone asks for the video. Other video hosts are rejected by the database.
- A captain is one account per squad, and only an admin can move it. Taking a captain off the
  roster does not remove the captaincy — the role lives on the squad row; use "Remove as
  captain" for that.

## Publishing

GitHub Pages builds from the repository root (`build_type: legacy`); the root `index.html`
redirects to `dist/`. Asset links inside `dist/` are relative, so the site renders correctly
under whatever subpath the repository is published from (`/TRIAS-Community/` today). Pushing to
`main` is the deploy:

```bash
git push origin main
```

Pages caches every file for ten minutes, so a visitor can load a fresh page with an old script
and see a layout that has already been repaired. `dist/index.html` asks for `styles.css` and
`app.js` with a `?v=` number — **change that number in both places whenever either file
changes**, and the browser has no choice but to fetch the new one.

Pages serves files only, so the community data must come from Supabase (steps above). An
earlier plan put this logic in a Qoder Sites Edge Function; the account's backend quota blocked
it, and that code has been removed. Nothing in `dist/` expects a same-origin API.

## Editing notes

- Frontend is plain ES modules — no build step. `app.js` renders every view; `index.html`
  holds only shells and the create-squad, member and sign-in dialogs.
- `api.js` owns every database call, and `config.js` owns the two connection values; add
  queries there, not inline in `app.js`. The rank tiers, role lists and categories are exported
  from `api.js` so the selects and the database CHECKs cannot drift apart.
- All untrusted text is escaped in `app.js` (`esc()`), and any stored URL goes through
  `safeUrl()` first, so only an `https` address reaches an `src` or `href` — a visitor's post
  cannot become script.
- Writes never ask the API to echo the row back: a queued row is deliberately invisible to its
  author, and PostgREST reports an invisible `RETURNING` as a permission failure.
- Theme tokens live at the top of `styles.css` (`--pink`, `--bg`, …).
- `node --check` reports success for a `dist/*.js` file that no browser can load: it parses these
  as CommonJS and never reaches the module grammar. Check them the way the page does, with
  `node --experimental-vm-modules dev/parse-check.mjs dist/app.js`.
