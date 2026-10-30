# JAS TRIAS · CODM Community

Community hub for a Call of Duty Mobile squad community: a post feed with likes and
comments, team/squad pages with join requests, and a device-local player profile.
**Anyone can post, nothing appears until the admin approves it.**

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
functions/       unused Edge Function from the earlier Qoder Sites plan (not deployed)
schema.sql       the app.* schema that Edge Function used (reference only)
dev/             local-only helpers; never published
```

## Connect the site to Supabase (one-time, free)

1. [supabase.com](https://supabase.com) → New project. Any region, the free plan.
2. SQL Editor → New query → paste the whole contents of `supabase/schema.sql` → **Run**.
3. Authentication → Providers → Email: turn **Confirm email** off (there is only one admin).
4. Authentication → Users → Add user: the admin email and a long password.
5. Project Settings → API: copy the **Project URL** and the **anon public** key.
6. Put both values in `dist/config.js`, commit, and let Pages rebuild.

The anon key is meant to be public — it identifies the project, it does not grant access.
Every request is checked against the policies in `supabase/schema.sql`, and the browser's
role is `anon` until the admin signs in.

## Running it locally

```bash
node dev/preview-server.mjs 4173     # http://127.0.0.1:4173 serves dist/
node dev/local-check.mjs             # contract checks for the unused functions/ path
```

With empty values in `dist/config.js` the site still renders: it shows the design, empty
feed and squads, and one notice explaining that no database is connected. Nothing is
posted, so there are no error toasts.

## Admin sign in and moderation

The **Admin sign in** button opens a normal email + password dialog handled by Supabase
Auth; the session lives in `localStorage` and refreshes itself. Signing in makes the browser
`authenticated`, and only that role may set a row to `approved`, publish squads or record join
requests. There is no shared key to leak and nothing to rotate in the page itself.

| Action | Who can do it | Where it is enforced |
| --- | --- | --- |
| Read the feed, squads, stats, comment threads | anyone | RLS: `status = 'approved'` |
| Submit a post or a comment | anyone | RLS: anon may only insert `status = 'pending'` |
| Like / unlike a post | anyone, on approved posts | RLS + `unique (post_id, visitor_id)` |
| See the approval queue | signed-in admin | RLS: pending rows are hidden from `anon` |
| Approve a queued item | signed-in admin | RLS: only `authenticated` may update |
| Reject (delete) a queued item | signed-in admin | RLS: only `authenticated` may delete |
| Publish a squad, add a join request | signed-in admin | RLS: `teams` / `join_requests` writes are admin-only |

A rejected post also loses its comments and likes — both tables reference `posts (id)` with
`on delete cascade`. Approved posts appear in the feed for every visitor within the 60-second
refresh the page already does.

Known limits of this design, stated plainly:
- An anonymous visitor cannot see their own queued post (the database hides pending rows from
  `anon`), so the confirmation is the on-screen message "Sent to the admin".
- The 60-second pause between submissions is a per-device timer in the browser, not a server
  rate limit. The real protection against spam is that nothing publishes without approval.
- Anyone who knows the admin password has full write access. Keep it unique, and add a second
  admin user in Supabase instead of sharing it.
- Likes are counted from the like rows, so a visitor who clears their browser storage can like
  a post again — identity is a device-local UUID, not an account.

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
| Squads, join requests | `public.teams`, `public.join_requests` | yes |
| Your nickname, rank, bio | `localStorage` (`jt.profile`) | no, device-local |
| Visitor identity | `localStorage` (`jt.visitor`, UUID) | attribution for likes/joins |
| Admin session | `localStorage` (Supabase auth token) | signs this browser in as admin |
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
under the `/JAS-TRIAS-CODM-Community/` subpath. Pushing to `main` is the deploy:

```bash
git push origin main
```

Pages serves files only, so the community data must come from Supabase (steps above). The
`functions/` directory is the earlier Qoder Sites plan, which the account's backend quota
blocked; it is not reachable from Pages and nothing in `dist/` calls it.

## Editing notes

- Frontend is plain ES modules — no build step. `app.js` renders every view; `index.html`
  holds only shells and the create-squad and admin dialogs.
- `api.js` owns every database call, and `config.js` owns the two connection values; add
  queries there, not inline in `app.js`.
- All untrusted text is escaped in `app.js` (`esc()`); visitor content is never inserted as
  raw HTML, so a stored `<script>` in a post cannot run.
- Theme tokens live at the top of `styles.css` (`--pink`, `--bg`, …).
