// Credential-free local harness: runs the real functions/routes.mjs against the
// shared in-memory adapter and prints the API contract results.
import { application } from '../functions/routes.mjs';
import { createFakeDb, BackendError } from './fake-db.mjs';

const ADMIN_KEY = 'test-admin-key';
const db = createFakeDb();
const env = { get: (name) => (name === 'ADMIN_KEY' ? ADMIN_KEY : undefined) };
const handle = application({ db, BackendError, env });

// Mirrors the deployed entry point's error boundary.
const invoke = context => handle(context).catch(error => {
  if (!(error instanceof BackendError) && process.env.DEBUG) console.error(`[debug] ${error?.stack}`);
  return Response.json(
    { error: error instanceof BackendError ? error.code : 'internal_error' },
    { status: error instanceof BackendError ? error.status : 500 },
  );
});

function makeRequest(path, { method = 'GET', body, admin = true } = {}) {
  const headers = {};
  if (body) headers['content-type'] = 'application/json';
  if (admin) headers['x-admin-key'] = ADMIN_KEY;
  return new Request(`https://site.example${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
}

const results = [];
async function check(label, source, assert, payloadOverride) {
  try {
    // Accepts a Request, a Promise<Response>, or a Response.
    const candidate = await source;
    const isResponse = candidate instanceof Response;
    const response = isResponse ? candidate : await invoke({ request: candidate, user: null, requestId: 'local' });
    const payload = payloadOverride !== undefined ? payloadOverride
      : await response.clone().json().catch(() => null);
    const ok = assert ? assert(response.status, payload) : response.ok;
    results.push({ label, status: response.status, ok, payload });
  } catch (error) {
    results.push({ label, status: error.status || 500, ok: false, payload: { error: error.code || error.message } });
  }
}

// Resolves a request and returns its JSON body, for threading ids through a flow.
async function send(request) {
  const response = await invoke({ request, user: null });
  return { response, body: await response.json().catch(() => null) };
}

const POST_PATH = '/functions/v1/app/api/posts';
const TEAMS_PATH = '/functions/v1/app/api/teams';
const MODERATION_PATH = '/functions/v1/app/api/moderation';
const uuid = () => globalThis.crypto.randomUUID();
const feed = (visitorId, extra = '') => makeRequest(`${POST_PATH}?visitor_id=${visitorId}&limit=20${extra}`);

// The cooldown keys on visitor_id, so each submission that must succeed uses a fresh id.
const submit = (visitorId, content, extra = {}, admin = false) => makeRequest(POST_PATH, {
  method: 'POST',
  admin,
  body: { op: 'create', visitor_id: visitorId, content, nickname: 'nse tester', ...extra },
});

await check('health', makeRequest('/functions/v1/app/api/health'));
const reader = uuid();
await check('feed starts empty', feed(reader),
  (status, data) => status === 200 && data.posts.length === 0 && data.hasMore === false);
await check('teams start empty', makeRequest(TEAMS_PATH),
  (status, data) => status === 200 && data.teams.length === 0);
await check('stats start at zero', makeRequest('/functions/v1/app/api/stats'),
  (status, data) => status === 200 && data.posts === 0 && data.teams === 0 && data.authors === 0 && data.comments === 0);
await check('queue starts empty', makeRequest(MODERATION_PATH),
  (status, data) => status === 200 && data.posts.length === 0 && data.comments.length === 0);

/* ---------------- admin identity ---------------- */
const author = uuid();
await check('wrong admin key refused', makeRequest('/functions/v1/app/api/admin/check', { method: 'POST', admin: false, body: { visitor_id: author, key: 'guess-me' } }),
  (status, data) => status === 403 && data.error === 'admin_required');
await check('correct admin key unlocks', makeRequest('/functions/v1/app/api/admin/check', { method: 'POST', admin: false, body: { visitor_id: author, key: ADMIN_KEY } }),
  (status, data) => status === 200 && data.is_admin === true);

/* ---------------- visitor post enters the queue ---------------- */
const first = await send(submit(author, 'Testing the shared feed.', { category: 'Ranked', rank: 'Pro III' }));
const postId = first.body.id;
await check('visitor post accepted as pending', first.response,
  () => first.response.status === 201 && first.body.status === 'pending' && /^[0-9a-f-]{36}$/.test(String(postId)), first.body);
await check('pending post hidden from the feed', feed(uuid()),
  (status, data) => status === 200 && data.posts.length === 0);
await check('pending post hidden from stats', makeRequest('/functions/v1/app/api/stats'),
  (status, data) => status === 200 && data.posts === 0 && data.authors === 0);
await check('pending post visible to its author', feed(author, '&author_only=true'),
  (status, data) => status === 200 && data.posts.length === 1 && data.posts[0].status === 'pending' && data.posts[0].rank === 'Pro III');
await check('liking a pending post fails', makeRequest(POST_PATH, { method: 'POST', admin: false, body: { op: 'like', visitor_id: uuid(), post_id: postId } }),
  (status, data) => status === 404 && data.error === 'not_found');

/* ---------------- the queue itself ---------------- */
await check('queue needs the admin key', makeRequest(MODERATION_PATH, { admin: false }),
  (status, data) => status === 403 && data.error === 'admin_required');
await check('queue lists the pending post', makeRequest(MODERATION_PATH),
  (status, data) => status === 200 && data.posts.length === 1 && data.posts[0].id === postId && data.posts[0].author === 'nse tester');
await check('approve needs the admin key', makeRequest(MODERATION_PATH, { method: 'POST', admin: false, body: { op: 'approve', kind: 'post', id: postId } }),
  (status, data) => status === 403 && data.error === 'admin_required');
await check('approve publishes it', makeRequest(MODERATION_PATH, { method: 'POST', body: { op: 'approve', kind: 'post', id: postId } }),
  (status, data) => status === 200 && data.status === 'approved');
await check('approved post reaches the feed', feed(uuid()),
  (status, data) => status === 200 && data.posts.length === 1
    && data.posts[0].id === postId && data.posts[0].status === 'approved' && data.posts[0].rank === 'Pro III');
await check('approved post counted in stats', makeRequest('/functions/v1/app/api/stats'),
  (status, data) => status === 200 && data.posts === 1 && data.authors === 1);
await check('approving twice reports nothing to do', makeRequest(MODERATION_PATH, { method: 'POST', body: { op: 'approve', kind: 'post', id: postId } }),
  (status, data) => status === 404 && data.error === 'not_found');

/* ---------------- visitor comment also waits ---------------- */
const commenter = uuid();
const comment = await send(makeRequest(POST_PATH, {
  method: 'POST', admin: false,
  body: { op: 'comment', visitor_id: commenter, post_id: postId, content: 'Nice grab.', nickname: 'nse commenter' },
}));
await check('visitor comment accepted as pending', comment.response,
  () => comment.response.status === 201 && comment.body.status === 'pending', comment.body);
await check('pending comment hidden from thread', makeRequest(`/functions/v1/app/api/comments?post_id=${postId}`),
  (status, data) => status === 200 && data.comments.length === 0);
await check('pending comment not counted', feed(uuid()),
  (status, data) => status === 200 && data.posts[0].comments === 0);
await check('queue lists the pending comment', makeRequest(MODERATION_PATH),
  (status, data) => status === 200 && data.comments.length === 1
    && data.comments[0].post_author === 'nse tester' && data.comments[0].post_excerpt.includes('Testing the shared feed'));
const commentQueue = await invoke({ request: makeRequest(MODERATION_PATH), user: null });
const pendingComment = (await commentQueue.json()).comments[0];
await check('approve publishes the comment', makeRequest(MODERATION_PATH, { method: 'POST', body: { op: 'approve', kind: 'comment', id: pendingComment.id } }),
  (status, data) => status === 200 && data.status === 'approved');
await check('approved comment shows in thread', makeRequest(`/functions/v1/app/api/comments?post_id=${postId}`),
  (status, data) => status === 200 && data.comments.length === 1 && data.comments[0].author === 'nse commenter');
await check('approved comment counted in feed', feed(uuid()),
  (status, data) => status === 200 && data.posts[0].comments === 1);

/* ---------------- rejection deletes ---------------- */
const spammer = uuid();
const spam = await send(submit(spammer, 'buy followers at spam dot example'));
await check('reject removes the post', makeRequest(MODERATION_PATH, { method: 'POST', body: { op: 'reject', kind: 'post', id: spam.body.id } }),
  status => status === 200);
await check('rejected post gone for its author', feed(spammer, '&author_only=true'),
  (status, data) => status === 200 && data.posts.length === 0);
await check('rejected item leaves the queue', makeRequest(MODERATION_PATH),
  (status, data) => status === 200 && data.posts.length === 0 && data.comments.length === 0);

/* ---------------- submission guards ---------------- */
await check('back-to-back post blocked', submit(author, 'Second post immediately.'),
  (status, data) => status === 429 && data.error === 'too_short');
const secondComment = makeRequest(POST_PATH, {
  method: 'POST', admin: false,
  body: { op: 'comment', visitor_id: commenter, post_id: postId, content: 'Also great.', nickname: 'nse commenter' },
});
await check('back-to-back comment blocked', secondComment,
  (status, data) => status === 429 && data.error === 'too_short');
await check('reject oversized post', submit(uuid(), 'x'.repeat(1201)),
  (status, data) => status === 413 && data.error === 'post_too_long');
await check('post needs a nickname', makeRequest(POST_PATH, { method: 'POST', admin: false, body: { op: 'create', visitor_id: uuid(), content: 'valid content here' } }),
  (status, data) => status === 400 && data.error === 'missing_nickname');
const pendingTarget = await send(submit(uuid(), 'this one is still waiting'));
await check('comment on a pending post fails', makeRequest(POST_PATH, {
  method: 'POST', admin: false,
  body: { op: 'comment', visitor_id: uuid(), post_id: pendingTarget.body.id, content: 'responding early', nickname: 'nse other' },
}), (status, data) => status === 404 && data.error === 'not_found');
const oddRank = await send(submit(uuid(), 'Master V is not a rank.', { rank: 'Master V' }));
await check('impossible rank accepted as pending', oddRank.response, () => oddRank.response.status === 201 && oddRank.body.status === 'pending', oddRank.body);
await send(makeRequest(MODERATION_PATH, { method: 'POST', body: { op: 'approve', kind: 'post', id: oddRank.body.id } }));
await check('bad rank falls back to Unranked', feed(uuid()),
  (status, data) => status === 200 && data.posts.some(post => post.id === oddRank.body.id && post.rank === 'Unranked'));

/* ---------------- admin posts skip the queue ---------------- */
const adminPost = await send(submit(uuid(), 'Announcement from the admin.', {}, true));
await check('admin post publishes at once', adminPost.response,
  () => adminPost.response.status === 201 && adminPost.body.status === 'approved', adminPost.body);
await check('admin post is in the feed immediately', feed(uuid()),
  (status, data) => status === 200 && data.posts.some(post => post.id === adminPost.body.id));

/* ---------------- visitor likes ---------------- */
await check('visitor likes an approved post', makeRequest(POST_PATH, { method: 'POST', admin: false, body: { op: 'like', visitor_id: uuid(), post_id: postId } }),
  (status, data) => status === 200 && data.liked === true && data.likes >= 1);
const liker = uuid();
await check('second visitor likes too', makeRequest(POST_PATH, { method: 'POST', admin: false, body: { op: 'like', visitor_id: liker, post_id: postId } }),
  (status, data) => status === 200 && data.liked === true);
await check('liking again removes the like', makeRequest(POST_PATH, { method: 'POST', admin: false, body: { op: 'like', visitor_id: liker, post_id: postId } }),
  (status, data) => status === 200 && data.liked === false);
await check('like unknown post', makeRequest(POST_PATH, { method: 'POST', admin: false, body: { op: 'like', visitor_id: uuid(), post_id: uuid() } }),
  (status, data) => status === 404 && data.error === 'not_found');

/* ---------------- squads stay admin-only ---------------- */
const team = await send(makeRequest(TEAMS_PATH, {
  method: 'POST',
  body: { visitor_id: author, name: 'NSE Labas', logo: 'LB', game_mode: 'Battle Royale', region: 'Philippines', required_rank: 'Pro', description: 'Weekend scrims.', slot_count: 6, nickname: 'nse tester' },
}));
await check('create team', team.response, () => team.response.status === 201 && !!team.body.id, team.body);
await check('team tier stored', makeRequest(TEAMS_PATH),
  (status, data) => status === 200 && data.teams.some(entry => entry.id === team.body.id && entry.required_rank === 'Pro'));
await check('visitor cannot create a team', makeRequest(TEAMS_PATH, {
  admin: false, method: 'POST',
  body: { visitor_id: uuid(), name: 'Visitor Squad', logo: 'VS', nickname: 'nse other', slot_count: 4 },
}), (status, data) => status === 403 && data.error === 'admin_required');
await check('visitor cannot record a join', makeRequest(TEAMS_PATH, {
  admin: false, method: 'POST',
  body: { op: 'join', visitor_id: uuid(), team_id: team.body.id, nickname: 'nse other' },
}), (status, data) => status === 403 && data.error === 'admin_required');
await check('duplicate team name', makeRequest(TEAMS_PATH, { method: 'POST', body: { visitor_id: uuid(), name: 'NSE Labas', logo: 'LB', nickname: 'nse other', slot_count: 4 } }),
  (status, data) => status === 409 && data.error === 'duplicate_name');
const joiner = uuid();
await check('join team', makeRequest(TEAMS_PATH, { method: 'POST', body: { op: 'join', visitor_id: joiner, team_id: team.body.id, nickname: 'nse other' } }),
  (status, data) => status === 201 && data.duplicated === false);
await check('join again is idempotent', makeRequest(TEAMS_PATH, { method: 'POST', body: { op: 'join', visitor_id: joiner, team_id: team.body.id, nickname: 'nse other' } }),
  (status, data) => status === 200 && data.duplicated === true);
await check('roster reflects join', makeRequest(TEAMS_PATH),
  (status, data) => {
    const joined = data.teams.find(entry => entry.id === team.body.id);
    return status === 200 && joined.members === 2 && joined.roster.length === 2;
  });

/* ---------------- misc contract ---------------- */
await check('reject unknown visitor', makeRequest(`${POST_PATH}?visitor_id=not-a-uuid`),
  (status, data) => status === 400 && data.error === 'invalid_input');
await check('reject unknown route', makeRequest('/functions/v1/app/api/nope'),
  (status, data) => status === 404 && data.error === 'not_found');
await check('reject bad moderation kind', makeRequest(MODERATION_PATH, { method: 'POST', body: { op: 'approve', kind: 'team', id: uuid() } }),
  (status, data) => status === 400 && data.error === 'invalid_input');
await check('reads need no admin key', makeRequest(TEAMS_PATH, { admin: false }),
  (status, data) => status === 200 && Array.isArray(data.teams));
await check('reject DELETE', makeRequest(`${TEAMS_PATH}?visitor_id=${author}`, { method: 'DELETE' }),
  status => status === 405);

// Fail closed: with no ADMIN_KEY Secret nothing admin-only works, but visitor
// submissions still land in the queue rather than on the public feed.
const locked = application({ db: createFakeDb(), BackendError, env: { get: () => undefined } });
const guarded = request => locked({ request, user: null }).catch(error => Response.json({ error: error.code }, { status: error.status }));
await check('missing secret blocks moderation', guarded(makeRequest(MODERATION_PATH)),
  (status, data) => status === 503 && data.error === 'admin_key_missing');
await check('missing secret blocks squads', guarded(makeRequest(TEAMS_PATH, { method: 'POST', body: { visitor_id: uuid(), name: 'No Secret', logo: 'NS', nickname: 'nse tester', slot_count: 4 } })),
  (status, data) => status === 503 && data.error === 'admin_key_missing');
const lockedPost = await guarded(submit(uuid(), 'Queued while unconfigured.'));
const lockedPostBody = await lockedPost.json();
await check('missing secret still queues posts', lockedPost,
  () => lockedPost.status === 201 && lockedPostBody.status === 'pending', lockedPostBody);

const failed = results.filter(entry => !entry.ok);
for (const entry of results) {
  const flag = entry.ok ? 'PASS' : 'FAIL';
  const detail = entry.ok ? '' : ` → ${JSON.stringify(entry.payload).slice(0, 260)}`;
  console.log(`${flag}  [${entry.status}] ${entry.label}${detail}`);
}
console.log(`\n${results.length - failed.length}/${results.length} contract checks passed`);
process.exitCode = failed.length ? 1 : 0;
