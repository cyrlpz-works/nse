# JAS TRIAS · CODM Community

Community hub for a Call of Duty Mobile squad community: a post feed with likes and
comments, team/squad pages with join requests, and a device-local player profile.
**Only the admin can publish** — visitors read the site.

The live site is published as a **Qoder Site** (static frontend + one Edge Function + a
hosted Postgres schema). The same source lives in this repository.

## Layout

```
dist/          published website (index.html, styles.css, app.js, api.js)
functions/     Edge Function: index.ts entry + routes.mjs business logic
schema.sql     reviewed migration for the app.* tables (reference copy)
index.html     redirect stub so GitHub Pages opens the app in dist/
legacy/        the original single-file page, kept for reference
dev/           local-only helpers; never published
```

## Running it locally

```bash
node dev/preview-server.mjs 4173     # http://127.0.0.1:4173  (admin key: local-admin)
node dev/local-check.mjs             # 31 API contract checks
```

The preview server serves `dist/` and runs the real `functions/routes.mjs` against an
in-memory adapter, so the whole flow (post → like → comment → team → join) works without
cloud credentials. That adapter does not prove real database behaviour.

## Admin mode

`POST /api/admin/check` compares the typed key with the `ADMIN_KEY` Secret inside the
Function. On success the browser keeps the key in `sessionStorage` (`jt.admin`) for that tab
and sends it as `x-admin-key` on every write. The Function re-checks the header on each
mutation, so hiding the buttons is only the visible half — the server is the actual gate.

| Route | Who can use it |
| --- | --- |
| `GET /api/posts`, `/api/teams`, `/api/stats`, `/api/comments` | anyone |
| `POST` create post / like / comment / create team / join | admin key only |

A visitor sees the feed and rosters with counts, the read-only notice, and their own local
profile — no composer, no create-team button, no join button.

Notes and limits of this design:
- The key is held in that browser tab; anyone with the admin's unlocked session can post.
- Failed unlocks are capped at 8 per visitor per 15 minutes (best effort, in-process).
- With no `ADMIN_KEY` Secret configured, every write fails closed with `admin_key_missing`.
- Rename or rotate the key in Site Settings whenever the community grows.

## Ranked ladder

Validated in `functions/routes.mjs` (`normalizeRank`) and shown in the profile editor and
profile panel (`RANK_LADDER` in `dist/app.js`).

| Tier | Subdivisions | Ranked points |
| --- | --- | --- |
| Rookie | I – V | 0 – 1,000 |
| Veteran | I – V | 1,001 – 2,000 |
| Elite | I – V | 2,001 – 3,000 |
| Pro | I – V | 3,001 – 4,500 |
| Master | N/A | 4,501 – 6,000 |
| Grand Master | N/A | 6,001 – 8,000 |
| Legendary | N/A | 8,001+ |

`Unranked` is also accepted. A post stores the full label, e.g. `Pro III`; a squad's
`required_rank` is a tier only. Anything that is not on this ladder — `Diamond`, `Master V` —
falls back to `Unranked` instead of being stored.

## How data is stored

| Data | Where | Shared between visitors |
| --- | --- | --- |
| Posts, comments, likes | `app.posts`, `app.comments`, `app.likes` | yes |
| Squads, join requests | `app.teams`, `app.join_requests` | yes |
| Your nickname, rank, bio | `localStorage` (`jt.profile`) | no, device-local |
| Visitor identity | `localStorage` (`jt.visitor`, UUID) | attribution for likes/joins |
| Admin key | `sessionStorage` (`jt.admin`) for this tab | compared with the site Secret |

The browser only ever calls same-origin `/functions/v1/app/...`. Database credentials stay
inside the Function; the site's declared `accessPolicies` are private, so nothing reaches
Postgres without going through `routes.mjs`.

The site starts **empty on purpose**: no demo squads, no sample posts. First content comes
from the admin.

Guards implemented in the Function: whitelist-checked categories and rank tiers, length
limits (1200 chars per post, 300 per comment, 40 per team name), UUID-shaped visitor IDs,
duplicate squad-name rejection, and idempotent join requests with slot-capacity checks.

## Publishing

Publication is handled by Qoder Sites (`prepare_site` → migration → `publish_site`) rather
than a hand-run build. `dist/` is the `webDirectory` and `functions/` the `functionDirectory`.
GitHub Pages cannot run the Edge Function. `dist/` is Pages-safe — the asset links are relative,
so it renders correctly under a `/repo-name/` subpath — and the app detects the missing service on
first load: it shows the design with read-only empty states and a notice instead of error toasts.
Pages is a look-and-no-data preview; the shared feed needs the backend below.

One-time cloud setup, in order: enable the database + Functions backend for the site, apply
`schema.sql` as a reviewed migration, prepare the site with `databaseAccess: read_write`,
`functionDirectory: functions` and `secretNames: ["ADMIN_KEY"]`, enter the admin key in Site
Settings, then publish. Until that backend exists, only the local preview has shared data.

## Editing notes

- Frontend is plain ES modules — no build step. `app.js` renders every view; `index.html`
  holds only shells and the create-team and admin dialogs.
- `api.js` owns the fetch contract; add endpoints there, not inline in `app.js`.
- All untrusted text is escaped in `app.js` (`esc()`); the page is safe against stored XSS
  because content is never inserted as raw HTML.
- Theme tokens live at the top of `styles.css` (`--pink`, `--bg`, …).
