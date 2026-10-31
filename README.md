# TRIAS · CODM Community

Community hub for a Call of Duty Mobile squad community: a post feed with likes and
comments, team/squad pages with join requests, and a device-local player profile.
**Anyone can post and comment, nothing appears until the admin approves it on the Approval
page. Squad captains run their own roster: accept, decline, remove.**

The live site is static **GitHub Pages** plus a free **Supabase** project (Postgres with
row level security, and Auth for the admin account). No server code runs on Pages, and none
is needed: the database enforces moderation and the input rules by itself.

## Layout

```
dist/            published website (index.html, styles.css, app.js, api.js, config.js)
dist/config.js   the two Supabase values — the only file you edit to connect the site
supabase/        schema.sql: tables, RLS policies, CHECK rules (run this in Supabase)
index.html       redirect stub so GitHub Pages opens the app in dist/
legacy/          the original single-file page, kept for reference
dev/             preview-server.mjs — serves dist/ locally; never published
```

`supabase/schema.sql` is the only file that belongs in the Supabase SQL Editor — it is written
for Supabase's `public` schema and its own `auth.uid()` / `auth.role()` helpers.

## Connect the site to Supabase (one-time, free)

1. [supabase.com](https://supabase.com) → New project. Any region, the free plan.
2. SQL Editor → New query → paste the whole contents of `supabase/schema.sql` → **Run**.
   Re-running it is safe: rows are kept, missing columns are added, and every policy in the
   `public` schema is dropped and recreated from this file.
3. Authentication → Providers → Email: turn **Confirm email** off, then create the admin:
4. Authentication → Users → Add user: the admin email and a long password.
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
**Create an account** button. That is intentional and it does not make them an admin: it is how
a team captain gets the login that proves their roster decisions. Turn confirmation back on
when you would rather create captain accounts yourself in the dashboard.

The anon key is meant to be public — it identifies the project, it does not grant access.
Every request is checked against the policies in `supabase/schema.sql`, and the browser's
role is `anon` until the admin signs in.

## Running it locally

```bash
node dev/preview-server.mjs 4173     # http://127.0.0.1:4173 serves dist/
```

It only serves files. `dist/` talks to Supabase directly, so the preview runs the real feed,
queue and sign-in against your project — no fake backend in the middle.

With empty values in `dist/config.js` the site still renders: it shows the design, empty
feed and squads, and one notice explaining that no database is connected. Nothing is
posted, so there are no error toasts.

## Sign in, approval and captains

The **Sign in** button opens a normal email + password dialog handled by Supabase Auth; the
session lives in `localStorage` and refreshes itself. Signing in alone buys nothing — the
database compares the account against `public.site_admins` (site admin) and against
`public.teams.captain_user_id` (squad captain). Authority lives in those two tables, so a
stranger who signs up through the same dialog is a stranger to the site.

| Action | Who can do it | Where it is enforced |
| --- | --- | --- |
| Read the feed, squads, stats, comment threads | anyone | RLS: `status = 'approved'` |
| Submit a post or a comment | anyone | RLS: insert allowed only with `status = 'pending'` |
| Like / unlike a post | anyone, on approved posts | RLS + `unique (post_id, visitor_id)` |
| Ask to join a squad | anyone | RLS: `join_requests` insert is `status = 'pending'` |
| See the approval queue | site admin | RLS: pending rows hidden from everyone else |
| Approve / reject (delete) a queued item | site admin | RLS: `posts` / `comments` writes need `is_site_admin()` |
| Publish or edit a squad card | site admin | RLS: `teams` writes need `is_site_admin()` |
| Accept, decline or remove a roster row of one squad | that squad's captain | RLS: `is_captain_of(team_id)` + `decided_by = auth.uid()` |
| Name a squad's captain | site admin | RLS: it is a `teams` update |
| Add someone to `site_admins` | an existing site admin | RLS: `admins admin only` |

A captain therefore cannot edit the squad's card, approve a post, or touch another squad: the
only row type they may update is a join request whose team lists their own account id. The
Approval page is a nav item that appears only for a signed-in site admin; approving there is
the same update the database would accept from anyone it recognises, so the page is a
convenience, not the security boundary.

A rejected post also loses its comments and likes — both tables reference `posts (id)` with
`on delete cascade`. Approved posts appear in the feed for every visitor within the 60-second
refresh the page already does.

Known limits of this design, stated plainly:
- To become a captain, a person needs an account **and** a row on the squad's roster or in its
  applications — that is the only place the site can read an account id from. The step before
  that (applying with an account) is a normal join request.
- A captain is one account per squad, and only an admin can move it — name a replacement or
  remove the role from the squad page.
- Taking a captain off the roster does **not** remove the captaincy; the role lives on the squad
  row, not on the membership row. Use "Remove as captain" for that.
- A declined applicant cannot send a second request to the same squad from the same device: the
  unique `(team_id, visitor_id)` index covers the row whichever status it ended in.
- An anonymous visitor cannot see their own queued post (the database hides pending rows from
  everyone but an admin), so the confirmation is the on-screen message "Sent to the admin".
- The 60-second pause between submissions is a per-device timer in the browser, not a server
  rate limit. The real protection against spam is that nothing publishes without approval.
- Anyone who knows the admin password has full write access. Keep it unique, and add a second
  row in `site_admins` instead of sharing it.
- Likes are counted from the like rows, so a visitor who clears their browser storage can like
  a post again — identity is a device-local UUID, not an account.
- Because that UUID is chosen by the browser, the database cannot tell whose like is whose, so
  the "undo your like" policy is deliberately `using (true)` for `anon`. Someone determined
  enough could clear other visitors' likes on a post; nothing published depends on like counts,
  and the feed itself cannot be altered this way. Tightening it means real visitor accounts.

## Ranked ladder

The ladder the site accepts is enforced twice: `rankLabel()` builds the label in
`dist/app.js` and a `CHECK` constraint rejects anything else in Postgres.

| Tier | Subdivisions | Ranked points |
| --- | --- | --- |
| Unranked | — | not placed yet |
| Rookie | I – V | 0 – 1,000 |
| Veteran | I – V | 1,001 – 2,000 |
| Elite | I – V | 2,001 – 3,000 |
| Pro | I – V | 3,001 – 4,500 |
| Master | N/A | 4,501 – 6,000 |
| Grand Master | N/A | 6,001 – 8,000 |
| Legendary | N/A | 8,001+ |

A post stores the full label, e.g. `Pro III`; a squad's `required_rank` is a tier only.
Anything else — `Diamond`, `Master V` — is rejected by the database.

## How data is stored

| Data | Where | Shared between visitors |
| --- | --- | --- |
| Posts, comments, likes | `public.posts`, `public.comments`, `public.likes` | yes |
| Squads, join requests, captains | `public.teams`, `public.join_requests` | yes |
| Who runs the site | `public.site_admins` | yes, read by the policies |
| Your nickname, rank, bio | `localStorage` (`jt.profile`) | no, device-local |
| Visitor identity | `localStorage` (`jt.visitor`, UUID) | attribution for likes/joins |
| Admin or captain session | `localStorage` (Supabase auth token) | proves which account this browser is |
| Submission timer | `localStorage` (`jt.last.*`) | courtesy cooldown only |

The browser talks to `https://<project>.supabase.co/rest/v1/...` through the Supabase SDK,
loaded from jsDelivr. There is no secret in the page beyond the anon key, and the service
role key is never used here — keep it out of this repository.

The site starts **empty on purpose**: no demo squads, no sample posts. The first posts come
from visitors and wait in the approval queue until the admin releases them.

Input rules enforced in Postgres: content length (3–1200 characters per post, 2–300 per
comment), the category whitelist, the rank ladder, author and nickname length, squad name
length and uniqueness, `slot_count` between 2 and 12, one like per visitor per post, and one
join request per visitor per squad.

## Publishing

GitHub Pages builds from the repository root (`build_type: legacy`); the root `index.html`
redirects to `dist/`. Asset links inside `dist/` are relative, so the site renders correctly
under whatever subpath the repository is published from (`/TRIAS-Community/` today). Pushing to
`main` is the deploy:

```bash
git push origin main
```

Pages serves files only, so the community data must come from Supabase (steps above). An
earlier plan put this logic in a Qoder Sites Edge Function; the account's backend quota blocked
it, and that code has been removed. Nothing in `dist/` expects a same-origin API.

## Editing notes

- Frontend is plain ES modules — no build step. `app.js` renders every view; `index.html`
  holds only shells and the create-squad and admin dialogs.
- `api.js` owns every database call, and `config.js` owns the two connection values; add
  queries there, not inline in `app.js`.
- All untrusted text is escaped in `app.js` (`esc()`); visitor content is never inserted as
  raw HTML, so a stored `<script>` in a post cannot run.
- Theme tokens live at the top of `styles.css` (`--pink`, `--bg`, …).
