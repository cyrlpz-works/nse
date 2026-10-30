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

const POST_PATH = '/functions/v1/app/api/posts';
const TEAMS_PATH = '/functions/v1/app/api/teams';
const uuid = () => globalThis.crypto.randomUUID();
const visitor = uuid();
const other = uuid();

await check('health', makeRequest('/functions/v1/app/api/health'));
await check('feed starts empty', makeRequest(`${POST_PATH}?visitor_id=${visitor}&limit=20&offset=0`),
  (status, data) => status === 200 && data.posts.length === 0 && data.hasMore === false);
await check('teams start empty', makeRequest(TEAMS_PATH),
  (status, data) => status === 200 && data.teams.length === 0);
await check('stats start at zero', makeRequest('/functions/v1/app/api/stats'),
  (status, data) => status === 200 && data.posts === 0 && data.teams === 0 && data.authors === 0 && data.comments === 0);

await check('write without admin key refused', makeRequest(POST_PATH, { method: 'POST', admin: false, body: { op: 'create', visitor_id: visitor, content: 'Visitor attempt.', nickname: 'nse tester' } }),
  (status, data) => status === 403 && data.error === 'admin_required');
await check('wrong admin key refused', makeRequest('/functions/v1/app/api/admin/check', { method: 'POST', admin: false, body: { visitor_id: visitor, key: 'guess-me' } }),
  (status, data) => status === 403 && data.error === 'admin_required');
await check('correct admin key unlocks', makeRequest('/functions/v1/app/api/admin/check', { method: 'POST', admin: false, body: { visitor_id: visitor, key: ADMIN_KEY } }),
  (status, data) => status === 200 && data.is_admin === true);

const created = await invoke({ request: makeRequest(POST_PATH, { method: 'POST', body: { op: 'create', visitor_id: visitor, content: 'Testing the shared feed.', category: 'Ranked', nickname: 'nse tester', rank: 'Pro III' } }), user: null });
const createdBody = await created.json();
const postId = createdBody.id;
await check('create post', created, () => created.status === 201 && /^[0-9a-f-]{36}$/.test(String(postId)), createdBody);
await check('rank keeps its subdivision', makeRequest(`${POST_PATH}?visitor_id=${visitor}&limit=20`),
  (status, data) => status === 200 && data.posts.some(post => post.id === postId && post.rank === 'Pro III'));
await check('impossible subdivision accepted', makeRequest(POST_PATH, { method: 'POST', body: { op: 'create', visitor_id: other, content: 'Master V is not a rank.', nickname: 'nse other', rank: 'Master V' } }),
  status => status === 201);
await check('bad rank falls back', makeRequest(`${POST_PATH}?visitor_id=${other}&limit=20`),
  (status, data) => status === 200 && data.posts.some(post => post.author === 'nse other' && post.rank === 'Unranked'));

await check('reject oversized post', makeRequest(POST_PATH, { method: 'POST', body: { op: 'create', visitor_id: visitor, content: 'x'.repeat(1201), nickname: 'nse tester' } }),
  (status, data) => status === 413 && data.error === 'post_too_long');
await check('create post needs nickname', makeRequest(POST_PATH, { method: 'POST', body: { op: 'create', visitor_id: other, content: 'valid content here' } }),
  (status, data) => status === 400 && data.error === 'missing_nickname');

await check('like on', makeRequest(POST_PATH, { method: 'POST', body: { op: 'like', visitor_id: visitor, post_id: postId } }),
  (status, data) => status === 200 && data.liked === true && data.likes === 1);
await check('like off', makeRequest(POST_PATH, { method: 'POST', body: { op: 'like', visitor_id: visitor, post_id: postId } }),
  (status, data) => status === 200 && data.liked === false && data.likes === 0);
await check('two visitors like once each', makeRequest(POST_PATH, { method: 'POST', body: { op: 'like', visitor_id: other, post_id: postId } }),
  (status, data) => status === 200 && data.liked === true && data.likes === 1);
await check('like unknown post', makeRequest(POST_PATH, { method: 'POST', body: { op: 'like', visitor_id: visitor, post_id: uuid() } }),
  (status, data) => status === 404 && data.error === 'not_found');
await check('comment then read', (async () => {
  await invoke({ request: makeRequest(POST_PATH, { method: 'POST', body: { op: 'comment', visitor_id: other, post_id: postId, content: 'Nice grab.', nickname: 'nse other' } }), user: null });
  return invoke({ request: makeRequest(`/functions/v1/app/api/comments?post_id=${postId}`), user: null });
})(), (status, data) => status === 200 && data.comments.length === 1 && data.comments[0].author === 'nse other');
await check('comments counted in feed', makeRequest(`${POST_PATH}?visitor_id=${visitor}&limit=20`),
  (status, data) => status === 200 && data.posts.some(post => post.id === postId && post.comments === 1));
await check('author_only filter', makeRequest(`${POST_PATH}?visitor_id=${other}&author_only=true&limit=20`),
  (status, data) => status === 200 && data.posts.every(post => post.author === 'nse other'));

const team = await invoke({ request: makeRequest(TEAMS_PATH, { method: 'POST', body: { visitor_id: visitor, name: 'NSE Labas', logo: 'LB', game_mode: 'Battle Royale', region: 'Philippines', required_rank: 'Pro', description: 'Weekend scrims.', slot_count: 6, nickname: 'nse tester' } }), user: null });
const teamBody = await team.json();
await check('create team', team, () => team.status === 201 && !!teamBody.id, teamBody);
await check('team tier stored', makeRequest(TEAMS_PATH),
  (status, data) => status === 200 && data.teams.some(entry => entry.id === teamBody.id && entry.required_rank === 'Pro'));
await check('duplicate team name', makeRequest(TEAMS_PATH, { method: 'POST', body: { visitor_id: other, name: 'NSE Labas', logo: 'LB', nickname: 'nse other', slot_count: 4 } }),
  (status, data) => status === 409 && data.error === 'duplicate_name');
await check('join team', makeRequest(TEAMS_PATH, { method: 'POST', body: { op: 'join', visitor_id: other, team_id: teamBody.id, nickname: 'nse other' } }),
  (status, data) => status === 201 && data.duplicated === false);
await check('join again is idempotent', makeRequest(TEAMS_PATH, { method: 'POST', body: { op: 'join', visitor_id: other, team_id: teamBody.id, nickname: 'nse other' } }),
  (status, data) => status === 200 && data.duplicated === true);
await check('roster reflects join', makeRequest(TEAMS_PATH),
  (status, data) => {
    const joined = data.teams.find(entry => entry.id === teamBody.id);
    return status === 200 && joined.members === 2 && joined.roster.length === 2;
  });
await check('reject unknown visitor', makeRequest(`${POST_PATH}?visitor_id=not-a-uuid`),
  (status, data) => status === 400 && data.error === 'invalid_input');
await check('reject unknown route', makeRequest('/functions/v1/app/api/nope'),
  (status, data) => status === 404 && data.error === 'not_found');
await check('reads need no admin key', makeRequest(TEAMS_PATH, { admin: false }),
  (status, data) => status === 200 && Array.isArray(data.teams));
await check('reject DELETE', makeRequest(`${TEAMS_PATH}?visitor_id=${visitor}`, { method: 'DELETE' }),
  status => status === 405);

// Fail closed: with no ADMIN_KEY Secret, a supplied key must still not write.
const locked = application({ db: createFakeDb(), BackendError, env: { get: () => undefined } });
await check('missing secret blocks writes', locked({ request: makeRequest(POST_PATH, { method: 'POST', body: { op: 'create', visitor_id: visitor, content: 'Should be blocked.', nickname: 'nse tester' } }), user: null })
  .catch(error => Response.json({ error: error.code }, { status: error.status })),
  (status, data) => status === 503 && data.error === 'admin_key_missing');

const failed = results.filter(entry => !entry.ok);
for (const entry of results) {
  const flag = entry.ok ? 'PASS' : 'FAIL';
  const detail = entry.ok ? '' : ` → ${JSON.stringify(entry.payload).slice(0, 260)}`;
  console.log(`${flag}  [${entry.status}] ${entry.label}${detail}`);
}
console.log(`\n${results.length - failed.length}/${results.length} contract checks passed`);
process.exitCode = failed.length ? 1 : 0;
