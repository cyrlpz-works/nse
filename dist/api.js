import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

// The SDK is loaded from a CDN so the site stays a plain static deploy (GitHub Pages).
// It is imported lazily: if the CDN or the database is unreachable the app still
// renders, and boot() reports the missing backend instead of breaking the page.
const SDK_URL = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
const QUERY_TIMEOUT_MS = 12000;
const MAX_POST = 1200;
const SUBMIT_COOLDOWN_MS = 60000;

export function isConfigured() {
  return /^https?:\/\/.{6,}/.test(SUPABASE_URL) && String(SUPABASE_ANON_KEY).length > 20;
}

function uid() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

export function getVisitorId() {
  let id = localStorage.getItem('jt.visitor');
  if (!id) { id = uid(); localStorage.setItem('jt.visitor', id); }
  return id;
}

let clientTask = null;
function client() {
  if (!isConfigured()) return Promise.reject(new Error('backend_missing'));
  if (!clientTask) {
    clientTask = import(SDK_URL)
      .then(module => {
        const createClient = module.createClient ?? module.default?.createClient;
        if (!createClient) throw new Error('backend_missing');
        return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
          auth: { persistSession: true, autoRefreshToken: true },
        });
      })
      .catch(error => { clientTask = null; throw error; });
  }
  return clientTask;
}

// Row level security rejects a write the caller has no business making; PostgREST
// reports that as 42501, which means "this needs the signed-in admin". A failure with
// no SQLSTATE code is the request itself never arriving (offline, DNS, blocked CDN).
function databaseError({ code, message }) {
  if (!code) return Object.assign(new Error('network_error'), { detail: message });
  const known = { '23505': 'duplicate_name', '23514': 'invalid_input', '42501': 'admin_required' };
  const error = new Error(known[code] || 'database_unavailable');
  error.pgCode = code;
  error.detail = message;
  return error;
}

async function run(builder) {
  let timer;
  try {
    const result = await Promise.race([
      builder,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), QUERY_TIMEOUT_MS); }),
    ]);
    if (result?.error) throw databaseError(result.error);
    return result;
  } finally {
    clearTimeout(timer);
  }
}

async function isSignedIn(db) {
  const session = await db.auth.getSession();
  return Boolean(session.data?.session?.user);
}

const clamp = (value, max) => String(value ?? '').trim().slice(0, max);

// Visitors queue content for review; a signed-in admin publishes straight to the feed.
async function insertRow(table, row) {
  const db = await client();
  const status = await isSignedIn(db) ? 'approved' : 'pending';
  const result = await run(db.from(table).insert({ ...row, status }).select('id,status'));
  return result.data?.[0] ?? { status };
}

// A per-device pause keeps one browser from burying the admin in duplicate submissions.
function assertCooldown(table) {
  const key = `jt.last.${table}`;
  const last = Number(localStorage.getItem(key)) || 0;
  const left = Math.ceil((SUBMIT_COOLDOWN_MS - (Date.now() - last)) / 1000);
  if (left > 0) {
    const error = new Error('too_short');
    error.waitSeconds = left;
    throw error;
  }
  localStorage.setItem(key, String(Date.now()));
}

const publishedOnly = (db, table) => db.from(table).eq('status', 'approved');

export async function signInAsAdmin(email, password) {
  const db = await client();
  const attempt = await db.auth.signInWithPassword({ email: clamp(email, 100).toLowerCase(), password });
  if (attempt.error) throw new Error('auth_failed');
  return true;
}

export async function signOutAsAdmin() {
  if (!isConfigured()) return;
  try { (await client()).auth.signOut(); } catch { /* already disconnected */ }
}

export async function hasAdminSession() {
  if (!isConfigured()) return false;
  try { return await isSignedIn(await client()); } catch { return false; }
}

export const api = {
  health: async () => {
    const db = await client();
    await run(db.from('posts').select('id', { count: 'exact', head: true }));
    return { ok: true };
  },

  async posts({ offset = 0, limit = 20, author_only = false } = {}) {
    const db = await client();
    const visitor = getVisitorId();
    const size = Math.min(50, Math.max(1, Number(limit) || 20));
    const from = Math.max(0, Number(offset) || 0);
    let query = db.from('posts')
      .select('id,visitor_id,author,rank,category,content,status,created_at')
      .order('created_at', { ascending: false });
    // An anonymous reader never sees unapproved rows — including their own, which the
    // database hides. The author_only view is therefore "my published posts".
    query = author_only ? query.eq('visitor_id', visitor) : query.eq('status', 'approved');
    const result = await run(query.range(from, from + size - 1));
    const rows = result.data || [];
    const ids = rows.map(row => row.id);
    const likeCounts = new Map();
    const commentCounts = new Map();
    const liked = new Set();
    if (ids.length) {
      // Counted here rather than embedded in the post query, so the feed does not
      // depend on PostgREST relationship inference to render at all.
      const [likes, comments] = await Promise.all([
        run(db.from('likes').select('post_id,visitor_id').in('post_id', ids).limit(5000)),
        run(publishedOnly(db, 'comments').select('post_id').in('post_id', ids).limit(5000)),
      ]);
      (likes.data || []).forEach(like => {
        likeCounts.set(like.post_id, (likeCounts.get(like.post_id) || 0) + 1);
        if (like.visitor_id === visitor) liked.add(like.post_id);
      });
      (comments.data || []).forEach(comment => {
        commentCounts.set(comment.post_id, (commentCounts.get(comment.post_id) || 0) + 1);
      });
    }
    return {
      posts: rows.map(row => ({
        id: row.id,
        author: row.author,
        rank: row.rank,
        category: row.category,
        content: row.content,
        status: row.status,
        created_at: row.created_at,
        comments: commentCounts.get(row.id) || 0,
        likes: likeCounts.get(row.id) || 0,
        liked_by_me: liked.has(row.id),
      })),
      hasMore: rows.length === size,
      nextOffset: from + rows.length,
    };
  },

  async like(postId) {
    const db = await client();
    const visitor = getVisitorId();
    const mine = await run(db.from('likes').select('id').eq('post_id', postId).eq('visitor_id', visitor).limit(1));
    const existing = mine.data?.[0];
    if (existing) {
      await run(db.from('likes').delete().eq('id', existing.id).eq('visitor_id', visitor));
    } else {
      try {
        await run(db.from('likes').insert({ post_id: postId, visitor_id: visitor }).select('id'));
      } catch (error) {
        // Two tabs of the same visitor can click at once; the unique pair keeps one like.
        if (error.pgCode !== '23505') throw error;
      }
    }
    const total = await run(db.from('likes').select('id', { count: 'exact', head: true }).eq('post_id', postId));
    return { liked: !existing, likes: total.count ?? 0 };
  },

  comments: async (postId) => {
    const db = await client();
    const result = await run(publishedOnly(db, 'comments')
      .eq('post_id', postId)
      .select('id,author,content,created_at')
      .order('created_at')
      .limit(100));
    return result.data || [];
  },

  async post({ content, category, nickname, rank }) {
    const text = String(content ?? '').trim();
    if (text.length < 3) throw new Error('invalid_input');
    if (text.length > MAX_POST) throw new Error('post_too_long');
    const author = clamp(nickname, 24);
    if (!author || author === 'Guest') throw new Error('missing_nickname');
    const db = await client();
    if (!(await isSignedIn(db))) assertCooldown('posts');
    return insertRow('posts', {
      visitor_id: getVisitorId(),
      author,
      rank: clamp(rank, 24) || 'Unranked',
      category: clamp(category, 40) || 'General',
      content: text,
    });
  },

  async comment(postId, { content, nickname }) {
    const text = String(content ?? '').trim();
    if (text.length < 2) throw new Error('invalid_input');
    const author = clamp(nickname, 24);
    if (!author || author === 'Guest') throw new Error('missing_nickname');
    const db = await client();
    if (!(await isSignedIn(db))) assertCooldown('comments');
    return insertRow('comments', { post_id: postId, visitor_id: getVisitorId(), author, content: text.slice(0, 300) });
  },

  async stats() {
    const db = await client();
    const [posts, comments, teams, writers] = await Promise.all([
      run(db.from('posts').select('id', { count: 'exact', head: true }).eq('status', 'approved')),
      run(db.from('comments').select('id', { count: 'exact', head: true }).eq('status', 'approved')),
      run(db.from('teams').select('id', { count: 'exact', head: true })),
      run(db.from('posts').select('visitor_id').eq('status', 'approved').limit(1000)),
    ]);
    return {
      posts: posts.count ?? 0,
      comments: comments.count ?? 0,
      teams: teams.count ?? 0,
      authors: new Set((writers.data || []).map(row => row.visitor_id)).size,
    };
  },

  async teams() {
    const db = await client();
    const result = await run(db.from('teams')
      .select('id,name,logo,description,game_mode,region,required_rank,status,leader,slot_count,created_at')
      .order('created_at', { ascending: false })
      .limit(100));
    const teams = result.data || [];
    const ids = teams.map(team => team.id);
    let applicants = [];
    if (ids.length) {
      const found = await run(db.from('join_requests')
        .select('team_id,nickname,created_at').in('team_id', ids).order('created_at').limit(2000));
      applicants = found.data || [];
    }
    return teams.map(team => {
      const roster = [{ name: team.leader, role: 'Founder' }];
      applicants
        .filter(entry => entry.team_id === team.id)
        .forEach(entry => roster.push({ name: entry.nickname, role: 'Applicant' }));
      team.roster = roster;
      team.members = roster.length;
      return team;
    });
  },

  async createTeam(team) {
    const name = clamp(team.name, 40);
    if (name.length < 2) throw new Error('invalid_input');
    if (!isConfigured()) throw new Error('backend_missing');
    const db = await client();
    if (!(await isSignedIn(db))) throw new Error('admin_required');
    try {
      const result = await run(db.from('teams').insert({
        name,
        logo: clamp(team.logo, 4) || name.slice(0, 2).toUpperCase(),
        description: clamp(team.description, 300),
        game_mode: clamp(team.game_mode, 40) || 'Multiplayer',
        region: clamp(team.region, 40) || 'Philippines',
        required_rank: clamp(team.required_rank, 24) || 'Master',
        status: 'recruiting',
        leader: clamp(team.leader, 24) || 'Guest',
        slot_count: Math.min(12, Math.max(2, Number(team.slot_count) || 5)),
      }).select('id'));
      return result.data?.[0];
    } catch (error) {
      if (error.pgCode === '23505') throw new Error('duplicate_name');
      throw error;
    }
  },

  async joinTeam(teamId, nickname) {
    const db = await client();
    if (!(await isSignedIn(db))) throw new Error('admin_required');
    try {
      await run(db.from('join_requests')
        .insert({ team_id: teamId, visitor_id: getVisitorId(), nickname: clamp(nickname, 24) })
        .select('id'));
      return { duplicated: false };
    } catch (error) {
      if (error.pgCode === '23505') return { duplicated: true };
      throw error;
    }
  },

  async moderation() {
    const db = await client();
    const [pendingPosts, pendingComments] = await Promise.all([
      run(db.from('posts').select('id,author,rank,category,content,created_at').eq('status', 'pending').order('created_at').limit(100)),
      run(db.from('comments').select('id,post_id,author,content,created_at').eq('status', 'pending').order('created_at').limit(100)),
    ]);
    const comments = pendingComments.data || [];
    const parentIds = [...new Set(comments.map(entry => entry.post_id))];
    const parents = new Map();
    if (parentIds.length) {
      const found = await run(db.from('posts').select('id,author,content').in('id', parentIds).limit(100));
      (found.data || []).forEach(post => parents.set(post.id, post));
    }
    return {
      posts: pendingPosts.data || [],
      comments: comments.map(entry => ({
        ...entry,
        post_author: parents.get(entry.post_id)?.author ?? '',
        post_excerpt: String(parents.get(entry.post_id)?.content ?? '').slice(0, 90),
      })),
    };
  },

  async moderate({ op, kind, id }) {
    const table = { post: 'posts', comment: 'comments' }[kind];
    if (!table || !id) throw new Error('invalid_input');
    const db = await client();
    const builder = op === 'approve'
      ? db.from(table).update({ status: 'approved' }).eq('id', id).eq('status', 'pending')
      : op === 'reject'
        ? db.from(table).delete().eq('id', id)
        : null;
    if (!builder) throw new Error('invalid_input');
    const result = await run(builder.select('id'));
    if (!result.data?.length) throw new Error('not_found');
    return { ok: true };
  },
};
