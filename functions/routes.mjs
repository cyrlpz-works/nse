export function application({ db, BackendError, env }) {
  const fail = (code, status) => { throw new BackendError(code, status); };
  const rows = result => {
    if (!result) fail('database_unavailable', 503);
    if (result.error) fail(result.error.code || 'database_unavailable', result.error.status || 503);
    return result.data ?? [];
  };
  const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
  const text = (value, { min = 1, max = 200 } = {}) => {
    if (typeof value !== 'string') return null;
    const clean = value.replace(/\r/g, '').trim();
    if (clean.length < min || clean.length > max) return null;
    if (clean.includes('\0')) return null;
    return clean;
  };
  const oneOf = (value, list, fallback) => (typeof value === 'string' && list.includes(value) ? value : fallback);
  const int = (value, min, max, fallback) => {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
  };
  const pageParam = (value, min, max, fallback) => {
    if (value === null || value === undefined || value === '') return fallback;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) fail('invalid_input', 400);
    return parsed;
  };

  const CATEGORIES = ['General', 'Multiplayer', 'Battle Royale', 'Ranked', 'Loadouts', 'Tips & Guides', 'Looking for Team', 'Team Recruitment'];
  const MODES = ['Multiplayer', 'Battle Royale', 'Zombies'];

  // Call of Duty Mobile ladder. Only the four numbered tiers carry subdivisions.
  const RANK_TIERS = ['Unranked', 'Rookie', 'Veteran', 'Elite', 'Pro', 'Master', 'Grand Master', 'Legendary'];

  // "Pro III" is a rank, "Grand Master" is one too — but "Master V" is not.
  function normalizeRank(value) {
    if (typeof value !== 'string') return null;
    const clean = value.trim().replace(/\s+/g, ' ');
    if (RANK_TIERS.includes(clean)) return clean;
    const match = /^(Rookie|Veteran|Elite|Pro) (I|II|III|IV|V)$/.exec(clean);
    return match ? `${match[1]} ${match[2]}` : null;
  }

  const safeEqual = (a, b) => {
    if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
    let diff = 0;
    for (let index = 0; index < a.length; index += 1) diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
    return diff === 0;
  };

  // Every write goes through this: the key lives in the site's Secret, never in source.
  function requireAdmin(request) {
    const configured = env?.get('ADMIN_KEY');
    if (!configured) fail('admin_key_missing', 503);
    if (!safeEqual(request.headers.get('x-admin-key') || '', configured)) fail('admin_required', 403);
  }

  const attempts = new Map();
  function noteAttempt(key) {
    const now = Date.now();
    const entry = attempts.get(key) || { count: 0, resetAt: now + 900000 };
    if (now > entry.resetAt) { entry.count = 0; entry.resetAt = now + 900000; }
    entry.count += 1;
    attempts.set(key, entry);
    if (attempts.size > 500) attempts.clear();
    if (entry.count > 8) fail('too_many_attempts', 429);
  }

  async function body(request, limit = 8192) {
    const type = request.headers.get('content-type') || '';
    if (!type.startsWith('application/json')) fail('invalid_input', 400);
    let raw = '';
    const reader = request.body?.getReader();
    if (!reader) fail('invalid_input', 400);
    let size = 0;
    let released = false;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit) { released = true; await reader.cancel(); reader.releaseLock(); fail('payload_too_large', 413); }
        raw += new TextDecoder().decode(value);
      }
    } catch (error) {
      if (error instanceof BackendError) throw error;
      fail('invalid_input', 400);
    } finally {
      if (!released) reader.releaseLock();
    }
    try { return JSON.parse(raw); } catch { fail('invalid_input', 400); }
  }

  function visitorOf(ctx, supplied) {
    const candidate = text(supplied, { min: 36, max: 36 });
    if (uuid(candidate)) return candidate;
    if (ctx.user?.user_id && uuid(ctx.user.user_id)) return ctx.user.user_id;
    fail('invalid_input', 400);
  }

  async function countRows(table, filters = []) {
    let query = db.from(table).select('id', { count: 'exact' });
    filters.forEach(([column, value]) => { query = query.eq(column, value); });
    const result = await query.limit(1);
    if (result?.error) fail(result.error.code || 'database_unavailable', result.error.status || 503);
    if (!Number.isSafeInteger(result?.count)) fail('count_unavailable', 503);
    return result.count;
  }

  async function loadPage(params, visitor) {
    const limit = pageParam(params.get('limit'), 1, 50, 20);
    const offset = pageParam(params.get('offset'), 0, 500, 0);
    const authorOnly = params.get('author_only') === 'true';

    let query = db.from('posts').select('id,content,category,author,rank,created_at,visitor_id');
    if (authorOnly) query = query.eq('visitor_id', visitor);
    const result = await query.order('created_at', { ascending: false }).range(offset, offset + limit);
    const items = rows(result);

    const ids = items.map(post => post.id);
    let likes = [];
    let comments = [];
    let mine = [];
    if (ids.length) {
      const gathered = await Promise.all([
        db.from('likes').select('post_id,visitor_id').in('post_id', ids).limit(5000),
        db.from('comments').select('post_id').in('post_id', ids).limit(5000),
        db.from('likes').select('post_id').eq('visitor_id', visitor).limit(2000),
      ]);
      likes = rows(gathered[0]);
      comments = rows(gathered[1]);
      mine = rows(gathered[2]);
    }

    const likeCount = new Map();
    likes.forEach(row => likeCount.set(row.post_id, (likeCount.get(row.post_id) || 0) + 1));
    const commentCount = new Map();
    comments.forEach(row => commentCount.set(row.post_id, (commentCount.get(row.post_id) || 0) + 1));
    const likedByMe = new Set(mine.map(row => row.post_id));

    const posts = items.map(post => ({
      id: post.id,
      content: post.content,
      category: post.category,
      author: post.author,
      rank: post.rank,
      created_at: post.created_at,
      likes: likeCount.get(post.id) || 0,
      comments: commentCount.get(post.id) || 0,
      liked_by_me: likedByMe.has(post.id),
    }));

    return Response.json({ posts, hasMore: items.length > limit, nextOffset: offset + Math.min(items.length, limit) });
  }

  async function createPost(input, visitor) {
    const content = text(input.content, { min: 3, max: 1200 });
    if (!content) fail('post_too_long', 413);
    const nickname = text(input.nickname, { min: 2, max: 24 });
    if (!nickname) fail('missing_nickname', 400);
    const record = {
      id: crypto.randomUUID(),
      visitor_id: visitor,
      author: nickname,
      rank: normalizeRank(input.rank) || 'Unranked',
      category: oneOf(input.category, CATEGORIES, 'General'),
      content,
      created_at: new Date().toISOString(),
    };
    rows(await db.from('posts').insert(record).select('id').limit(1));
    return Response.json({ id: record.id, created_at: record.created_at }, { status: 201 });
  }

  async function toggleLike(input, visitor) {
    const postId = text(input.post_id, { min: 36, max: 36 });
    if (!uuid(postId)) fail('invalid_input', 400);
    const existing = rows(await db.from('likes').select('id').eq('post_id', postId).eq('visitor_id', visitor).limit(1));
    if (existing.length) {
      rows(await db.from('likes').delete().eq('post_id', postId).eq('visitor_id', visitor).select('id').limit(1));
    } else {
      const post = rows(await db.from('posts').select('id').eq('id', postId).limit(1));
      if (!post.length) fail('not_found', 404);
      rows(await db.from('likes').insert({ id: crypto.randomUUID(), post_id: postId, visitor_id: visitor, created_at: new Date().toISOString() }).select('id').limit(1));
    }
    const total = await countRows('likes', [['post_id', postId]]);
    return Response.json({ liked: existing.length === 0, likes: total });
  }

  async function addComment(input, visitor) {
    const postId = text(input.post_id, { min: 36, max: 36 });
    if (!uuid(postId)) fail('invalid_input', 400);
    const content = text(input.content, { min: 2, max: 300 });
    if (!content) fail('invalid_input', 400);
    const nickname = text(input.nickname, { min: 2, max: 24 });
    if (!nickname) fail('missing_nickname', 400);
    const post = rows(await db.from('posts').select('id').eq('id', postId).limit(1));
    if (!post.length) fail('not_found', 404);
    rows(await db.from('comments').insert({
      id: crypto.randomUUID(), post_id: postId, visitor_id: visitor, author: nickname, content, created_at: new Date().toISOString(),
    }).select('id').limit(1));
    return Response.json({ ok: true }, { status: 201 });
  }

  async function listComments(postId) {
    if (!uuid(postId)) fail('invalid_input', 400);
    const comments = rows(await db.from('comments').select('id,author,content,created_at')
      .eq('post_id', postId).order('created_at', { ascending: true }).limit(200));
    return Response.json({ comments });
  }

  async function listTeams() {
    const [teams, joiners] = await Promise.all([
      db.from('teams').select('id,name,logo,description,game_mode,region,required_rank,status,leader,slot_count,created_at')
        .order('created_at', { ascending: false }).limit(100),
      db.from('join_requests').select('team_id,visitor_id,nickname,created_at').limit(2000),
    ]);
    const roster = new Map();
    rows(joiners).forEach(request => {
      if (!roster.has(request.team_id)) roster.set(request.team_id, []);
      roster.get(request.team_id).push(request);
    });
    const result = rows(teams).map(team => {
      const requests = roster.get(team.id) || [];
      const members = [{ name: team.leader, role: 'Founder' }, ...requests.map(request => ({ name: request.nickname, role: 'Requested' }))];
      return { ...team, members: members.length, roster: members.slice(0, team.slot_count) };
    });
    return Response.json({ teams: result });
  }

  async function createTeam(input, visitor) {
    const name = text(input.name, { min: 3, max: 40 });
    if (!name) fail('invalid_input', 400);
    const logo = text(input.logo, { min: 1, max: 4 });
    if (!logo) fail('invalid_input', 400);
    const nickname = text(input.nickname, { min: 2, max: 24 });
    if (!nickname) fail('missing_nickname', 400);
    const duplicate = rows(await db.from('teams').select('id').eq('name', name).limit(1));
    if (duplicate.length) fail('duplicate_name', 409);
    const record = {
      id: crypto.randomUUID(),
      name,
      logo,
      description: text(input.description, { min: 0, max: 300 }) || '',
      game_mode: oneOf(input.game_mode, MODES, 'Multiplayer'),
      region: text(input.region, { min: 2, max: 40 }) || 'Philippines',
      required_rank: oneOf(input.required_rank, RANK_TIERS, 'Master'),
      status: 'recruiting',
      leader: nickname,
      slot_count: int(input.slot_count, 1, 12, 5),
      founder_id: visitor,
      created_at: new Date().toISOString(),
    };
    rows(await db.from('teams').insert(record).select('id').limit(1));
    return Response.json({ id: record.id }, { status: 201 });
  }

  async function joinTeam(input, visitor) {
    const teamId = text(input.team_id, { min: 36, max: 36 });
    if (!uuid(teamId)) fail('invalid_input', 400);
    const nickname = text(input.nickname, { min: 2, max: 24 });
    if (!nickname) fail('missing_nickname', 400);
    const found = rows(await db.from('teams').select('id,status,slot_count,leader').eq('id', teamId).limit(1));
    if (!found.length) fail('not_found', 404);
    const team = found[0];
    const already = rows(await db.from('join_requests').select('id').eq('team_id', teamId).eq('visitor_id', visitor).limit(1));
    if (already.length) return Response.json({ ok: true, duplicated: true });
    const requests = await countRows('join_requests', [['team_id', teamId]]);
    const seatsUsed = 1 + requests;
    if (team.status !== 'recruiting' || seatsUsed > team.slot_count) fail('team_full', 409);
    rows(await db.from('join_requests').insert({
      id: crypto.randomUUID(), team_id: teamId, visitor_id: visitor, nickname, created_at: new Date().toISOString(),
    }).select('id').limit(1));
    return Response.json({ ok: true, duplicated: false }, { status: 201 });
  }

  async function stats() {
    const [posts, teams, comments, authors] = await Promise.all([
      countRows('posts'), countRows('teams'), countRows('comments'),
      db.from('posts').select('visitor_id').limit(500),
    ]);
    const unique = new Set(rows(authors).map(row => row.visitor_id));
    return Response.json({ posts, teams, comments, authors: unique.size });
  }

  async function adminCheck(request, input) {
    noteAttempt(text(input.visitor_id, { min: 1, max: 60 }) || 'anonymous');
    const configured = env?.get('ADMIN_KEY');
    if (!configured) fail('admin_key_missing', 503);
    if (!safeEqual(text(input.key, { min: 1, max: 200 }) || '', configured)) fail('admin_required', 403);
    return Response.json({ is_admin: true });
  }

  const MUTATIONS = new Set(['/api/posts', '/api/teams', '/api/join']);

  return async ctx => {
    const request = ctx.request;
    const url = new URL(request.url);
    // The gateway swaps the logical `app` name for the physical deployment name
    // and may strip /functions/v1 before invoking.
    const matched = url.pathname.match(/^\/(?:functions\/v1\/)?(?:app|app-d[0-9a-f]{32})(\/.*)?$/);
    if (!matched) fail('not_found', 404);
    const path = matched[1] || '/';
    const method = request.method.toUpperCase();
    const params = url.searchParams;

    if (path === '/api/health' && method === 'GET') return Response.json({ ok: true });

    if (method === 'GET') {
      if (path === '/api/teams') return listTeams();
      if (path === '/api/stats') return stats();
      if (path === '/api/comments') return listComments(params.get('post_id') || '');
      if (path === '/api/posts') return loadPage(params, visitorOf(ctx, params.get('visitor_id')));
      fail('not_found', 404);
    }

    if (method === 'POST') {
      const input = await body(request);
      if (path === '/api/admin/check') return adminCheck(request, input);
      // Visitors read; only the admin key can change anything.
      if (MUTATIONS.has(path)) requireAdmin(request);
      if (path === '/api/posts') {
        const visitor = visitorOf(ctx, input.visitor_id);
        if (input.op === 'create') return createPost(input, visitor);
        if (input.op === 'like') return toggleLike(input, visitor);
        if (input.op === 'comment') return addComment(input, visitor);
        fail('invalid_input', 400);
      }
      if (path === '/api/teams') {
        if (input.op === 'join') return joinTeam(input, visitorOf(ctx, input.visitor_id));
        return createTeam(input, visitorOf(ctx, input.visitor_id));
      }
      if (path === '/api/join') return joinTeam(input, visitorOf(ctx, input.visitor_id));
      fail('not_found', 404);
    }

    fail('method_not_allowed', 405);
  };
}
