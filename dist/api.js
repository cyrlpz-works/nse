import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

// The SDK is loaded from a CDN so the site stays a plain static deploy (GitHub Pages).
// It is imported lazily: if the CDN or the database is unreachable the app still
// renders, and boot() reports the missing backend instead of breaking the page.
const SDK_URL = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
const QUERY_TIMEOUT_MS = 12000;
const MAX_POST = 1200;
const SUBMIT_COOLDOWN_MS = 60000;
const ONLINE_WITHIN_MS = 3 * 60 * 1000;

// Shape checks, not guesses about your project: a Supabase host label is lowercase, and an
// anon key is either the newer 'sb_publishable_…' API key or the older three-part eyJ… JWT.
// Left as a sample -- YOUR-REF, 'eyJ...' -- the site reports "not connected" instead of
// silently failing every request against a domain that does not exist, which reads like a
// broken database.
const URL_SHAPE = /^https:\/\/[a-z0-9][a-z0-9-]{2,62}\.supabase\.co\/?$/;
const PUBLISHABLE_KEY = /^sb_publishable_[A-Za-z0-9_-]{16,}$/;
const LEGACY_JWT = /^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/;
// Squad artwork is filed under a folder named after the squad, so an id that is not one is a typo
// or a hand-made request rather than a team -- and the bucket policy would refuse it anyway.
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The vocabularies the database checks writes against (supabase/schema.sql). They live here so
// the browser can explain a mistake before the request rather than after a rejected one; the
// database stays the enforcement point, and adding a value here without adding it there produces
// an 'invalid_input' refusal, not a row that gets past the rule.
export const RANK_TIERS = ['Unranked', 'Rookie', 'Veteran', 'Elite', 'Pro', 'Master', 'Grand Master', 'Legendary'];
export const MP_ROLES = ['Slayer', 'Objective', 'Anchor', 'All Around', 'Team Leader'];
export const BR_CLASSES = [
  'Clown', 'Defender', 'Desperado', 'Firefly', 'Hacker', 'Igniter', 'Jet Boost', 'Kinetic Station',
  'Mechanic', 'Medic', 'Misdirection', 'Ninja', 'Poltergeist', 'Pumped', 'Quick Strike',
  'Ravager Launcher', 'Refitter', 'Revive', 'Rewind', 'Scout', 'Shock Charge', 'Shock Wave',
  'Smoke Bomber', 'Spotter', 'Tactical Bouncer', 'Tactical Mirror', 'Teleporter', 'Shock Stick',
  'Toxic Overload', 'Trap Master', 'Trickster',
];
export const EXEC_POSITIONS = [
  'Founder', 'Co-Founder', 'Clan Master', 'Vice Clan Master', 'Secretary', 'Head Admin',
  'Admin', 'BR Handler', 'MP Handler', 'Monitoring Admin', 'Disciplinary Admin', 'Recruiter',
  'Editor',
];
export const CATEGORIES = ['General', 'Multiplayer', 'Battle Royale', 'Ranked', 'Loadouts',
  'Tips & Guides', 'Looking for Team', 'Team Recruitment'];
export const rankPosition = (tier) => RANK_TIERS.indexOf(tier);

export function isConfigured() {
  const key = String(SUPABASE_ANON_KEY).trim();
  return URL_SHAPE.test(String(SUPABASE_URL).trim())
    && (PUBLISHABLE_KEY.test(key) || LEGACY_JWT.test(key));
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
  const known = { '23505': 'duplicate_name', '23514': 'invalid_input', '42501': 'permission_denied' };
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

async function currentUserId(db) {
  const session = await db.auth.getSession();
  return session.data?.session?.user?.id ?? null;
}

// Being signed in is not the test. Sign-ups stay open because every member now needs an account,
// so the database's site_admins table is the only thing that makes someone an admin. A missing
// table (a project that has not run the newest schema) answers 'no' rather than throwing, which
// leaves the site readable instead of broken.
async function isSiteAdmin(db) {
  const uid = await currentUserId(db);
  if (!uid) return false;
  try {
    const hit = await run(db.from('site_admins').select('user_id').eq('user_id', uid).limit(1));
    return Boolean(hit.data?.length);
  } catch {
    return false;
  }
}

const clamp = (value, max) => String(value ?? '').trim().slice(0, max);
const oneOf = (value, list, fallback = null) => (list.includes(value) ? value : fallback);
// The same shape the database checks team_media against: a plain https address, and nothing that
// could break out of the css url() the banner is painted with.
const HTTPS_URL = /^https:\/\/[A-Za-z0-9._~:/?#@!$&*+,;=-]+$/;
const mediaUrl = (value) => {
  const text = String(value ?? '').trim();
  return text ? (HTTPS_URL.test(text) ? text : null) : null;
};

const PROFILE_FIELDS = 'user_id,ign,avatar_url,rank,rank_points,main_mode,role_label,clan_main,clan_second,community_main,community_second,standing,exec_position,last_seen_at,created_at,updated_at';

async function readProfile(db, uid) {
  if (!uid) return null;
  try {
    const found = await run(db.from('profiles').select(PROFILE_FIELDS).eq('user_id', uid).limit(1));
    return found.data?.[0] ?? null;
  } catch {
    return null;
  }
}

// The author name and avatar on a post come from the profile, so a rename is reflected the next
// time the feed is read. `profiles` is embedded rather than looked up separately: one request per
// page of feed, and the copy stored on the row remains the fallback for a deleted account.
const POST_EMBED = 'id,user_id,author,rank,category,content,image_url,video_url,status,created_at,profiles(user_id,ign,avatar_url,rank,rank_points,main_mode,role_label,standing,exec_position)';

// A queued row is now visible to its author, but nothing is ever read back after an INSERT by
// someone who cannot see it -- an invisible RETURNING is reported by PostgREST as an RLS
// violation (42501), which used to look exactly like a member being refused permission to post.
async function insertRow(table, row, { asMember = false } = {}) {
  const db = await client();
  // The admin view publishes straight away; the member view sends even the admin's own account
  // through the queue a member uses, which is why the caller passes the view down.
  const status = !asMember && await isSiteAdmin(db) ? 'approved' : 'pending';
  await run(db.from(table).insert({ ...row, status }));
  return { status };
}

// A per-device pause keeps one browser from burying the admin in duplicate submissions. The real
// protection is that nothing publishes without approval; this only saves the queue from noise.
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

// supabase-js only allows filters after a select, so this wraps an already-selected query
// rather than a table name.
const approved = (query) => query.eq('status', 'approved');

// Best-effort bookkeeping for the admin's activity log. It never fails the action it follows: a
// refused or timed-out log entry is not a reason to tell someone their post did not go through.
async function logActivity(action, detail) {
  try {
    const db = await client();
    const uid = await currentUserId(db);
    if (!uid) return;
    await run(db.from('activity_log').insert({ actor_user_id: uid, action, detail: clamp(detail, 200) }));
  } catch { /* the log is not worth losing a submission over */ }
}

// Signs an account in and reports what it is allowed to do. A captain and a plain member sign in
// through the same door as the admin and must not be told they run the site.
export async function signIn(email, password) {
  const db = await client();
  const attempt = await db.auth.signInWithPassword({ email: clamp(email, 100).toLowerCase(), password });
  if (attempt.error) throw new Error('auth_failed');
  const uid = attempt.data.session?.user?.id ?? null;
  const result = { admin: await isSiteAdmin(db), profile: await readProfile(db, uid), userId: uid };
  await logActivity('sign_in', result.profile?.ign || '');
  return result;
}

// Creating an account is the same act as creating a profile: without an IGN the row cannot exist,
// and nothing on the site could attribute anything to them.
export async function signUpAccount(email, password, ign) {
  const db = await client();
  const name = clamp(ign, 24);
  if (name.length < 2) throw new Error('invalid_input');
  const created = await db.auth.signUp({ email: clamp(email, 100).toLowerCase(), password });
  if (created.error) {
    // Supabase says which rule the address tripped; a rejected address is not a wrong
    // password, and naming it is the difference between a member trying again and giving up.
    const why = `${created.error.code || ''} ${created.error.message || ''}`;
    if (/already|registered/i.test(why)) throw new Error('account_exists');
    if (/invalid|validation/i.test(why)) throw new Error('email_invalid');
    throw new Error('sign_up_failed');
  }
  if (!created.data?.session) throw new Error('email_confirmation');
  const uid = created.data.session.user.id;
  await run(db.from('profiles').insert({ user_id: uid, ign: name }));
  await logActivity('sign_in', name);
  return { admin: await isSiteAdmin(db), profile: await readProfile(db, uid), userId: uid };
}

export async function myUserId() {
  if (!isConfigured()) return null;
  try { return await currentUserId(await client()); } catch { return null; }
}

export async function myProfile() {
  if (!isConfigured()) return null;
  try { return await readProfile(await client(), await myUserId()); } catch { return null; }
}

export async function signOutAsAdmin() {
  if (!isConfigured()) return;
  await logActivity('sign_out', '');
  // Awaited on purpose: signOut() clears the session the next request would otherwise still
  // carry, and a composer submit that races it is sent as the admin, which publishes the row
  // instead of queueing it.
  try { await (await client()).auth.signOut(); } catch { /* already disconnected */ }
}

export async function hasAdminSession() {
  if (!isConfigured()) return false;
  try { return await isSiteAdmin(await client()); } catch { return false; }
}

// The signed-in account's own profile, which every write on this site is attributed to.
async function requireProfile(db) {
  const uid = await currentUserId(db);
  if (!uid) throw new Error('sign_in_required');
  const profile = await readProfile(db, uid);
  if (!profile) throw new Error('profile_required');
  return profile;
}

export const api = {
  health: async () => {
    const db = await client();
    await run(db.from('posts').select('id', { count: 'exact', head: true }));
    return { ok: true };
  },

  /* ---------------- profile ---------------- */
  // A profile row is the account's public card. Inserting happens only through signUpAccount or
  // through the first save here, so a sign-in created before this schema still gets a card.
  async saveProfile(patch) {
    const db = await client();
    const uid = await currentUserId(db);
    if (!uid) throw new Error('sign_in_required');
    const ign = clamp(patch.ign, 24);
    if (ign.length < 2) throw new Error('invalid_input');

    const rank = oneOf(patch.rank, RANK_TIERS, 'Unranked');
    const mainMode = oneOf(patch.mainMode, ['Multiplayer', 'Battle Royale']);
    const roles = mainMode === 'Battle Royale' ? BR_CLASSES : MP_ROLES;
    // Switching mode drops a role that belongs to the other list rather than sending a pair the
    // database CHECK will refuse.
    const roleLabel = mainMode ? oneOf(patch.roleLabel, roles) : null;
    const standing = oneOf(patch.standing, ['member', 'executive'], 'member');
    const execPosition = standing === 'executive' ? oneOf(patch.execPosition, EXEC_POSITIONS) : null;
    if (standing === 'executive' && !execPosition) throw new Error('invalid_input');
    const points = patch.rankPoints === null || patch.rankPoints === undefined || patch.rankPoints === ''
      ? null : Math.min(1000000, Math.max(0, Math.round(Number(patch.rankPoints))));
    if (rank === 'Legendary' && points === null) throw new Error('legendary_points');
    if (points !== null && !Number.isFinite(Number(patch.rankPoints))) throw new Error('invalid_input');

    const row = {
      user_id: uid,
      ign,
      rank,
      rank_points: points,
      main_mode: mainMode,
      role_label: roleLabel,
      standing,
      exec_position: execPosition,
      clan_main: clamp(patch.clanMain, 40) || null,
      clan_second: clamp(patch.clanSecond, 40) || null,
      community_main: clamp(patch.communityMain, 40) || null,
      community_second: clamp(patch.communitySecond, 40) || null,
      avatar_url: clamp(patch.avatarUrl, 600) || null,
      updated_at: new Date().toISOString(),
    };
    const existing = await readProfile(db, uid);
    if (existing) {
      await run(db.from('profiles').update(row).eq('user_id', uid));
    } else {
      try {
        await run(db.from('profiles').insert(row));
      } catch (error) {
        if (error.pgCode !== '23505') throw error;
        await run(db.from('profiles').update(row).eq('user_id', uid));
      }
    }
    await logActivity('profile_update', ign);
    return readProfile(db, uid);
  },

  // Presence: a heartbeat, not a connection. "Online" means a tab was open in the last few
  // minutes, which is what a static site on free hosting can honestly claim.
  async beat() {
    try {
      const db = await client();
      const uid = await currentUserId(db);
      if (!uid) return null;
      const stamp = new Date().toISOString();
      await run(db.from('profiles').update({ last_seen_at: stamp }).eq('user_id', uid));
      return stamp;
    } catch { return null; }
  },

  /* ---------------- members ---------------- */
  async members(query = '') {
    const db = await client();
    // % and _ are wildcards in PostgREST's ilike, so a search typed as "100%" would otherwise
    // match everything. Dropping them from the needle keeps the search literal.
    const needle = clamp(query, 40).replace(/[%_]/g, '').trim();
    let builder = db.from('profiles').select(PROFILE_FIELDS);
    if (needle) builder = builder.ilike('ign', `%${needle}%`);
    const found = await run(builder.order('ign').limit(120));
    const people = found.data || [];
    const hearts = new Map();
    const ids = people.map(person => person.user_id);
    if (ids.length) {
      const rows = await run(db.from('member_hearts').select('to_user_id,taps').in('to_user_id', ids).limit(5000));
      (rows.data || []).forEach(row => hearts.set(row.to_user_id, (hearts.get(row.to_user_id) || 0) + (row.taps || 0)));
    }
    const cutoff = new Date(Date.now() - ONLINE_WITHIN_MS).toISOString();
    return people.map(person => ({
      ...person,
      hearts: hearts.get(person.user_id) || 0,
      online: Boolean(person.last_seen_at) && person.last_seen_at > cutoff,
    }));
  },

  // One member's card: who they are, who they hearted them, and which squads they are on.
  async memberCard(userId) {
    const db = await client();
    const found = await run(db.from('profiles').select(PROFILE_FIELDS).eq('user_id', userId).limit(1));
    const person = found.data?.[0];
    if (!person) throw new Error('not_found');
    const [hearts, squads, posts] = await Promise.all([
      run(db.from('member_hearts').select('taps').eq('to_user_id', userId).limit(5000)),
      run(db.from('join_requests').select('team_id,status,teams(name,logo,game_mode)')
        .eq('user_id', userId).eq('status', 'accepted').limit(20)),
      run(db.from('posts').select('id', { count: 'exact', head: true }).eq('user_id', userId).eq('status', 'approved')),
    ]);
    const mine = await currentUserId(db);
    let myTaps = 0;
    if (mine && mine !== userId) {
      const own = await run(db.from('member_hearts').select('taps')
        .eq('to_user_id', userId).eq('from_user_id', mine).limit(1));
      myTaps = own.data?.[0]?.taps || 0;
    }
    return {
      profile: person,
      hearts: (hearts.data || []).reduce((total, row) => total + (row.taps || 0), 0),
      myTaps,
      posts: posts.count ?? 0,
      squads: (squads.data || [])
        .filter(row => row.teams)
        .map(row => ({ id: row.team_id, name: row.teams.name, logo: row.teams.logo, game_mode: row.teams.game_mode })),
    };
  },

  // "Taptap": every press adds one heart. One row per pair holds the count, so a member cannot
  // bury someone by re-using another person's row -- the write is theirs by policy.
  async heartMember(targetUserId) {
    const db = await client();
    const uid = await currentUserId(db);
    if (!uid) throw new Error('sign_in_required');
    if (uid === targetUserId) throw new Error('heart_self');
    const own = await run(db.from('member_hearts').select('id,taps')
      .eq('from_user_id', uid).eq('to_user_id', targetUserId).limit(1));
    const row = own.data?.[0];
    if (row) {
      await run(db.from('member_hearts').update({ taps: (row.taps || 0) + 1, updated_at: new Date().toISOString() })
        .eq('id', row.id));
    } else {
      try {
        await run(db.from('member_hearts').insert({ from_user_id: uid, to_user_id: targetUserId, taps: 1 }));
      } catch (error) {
        // Two taps in the same instant: keep the single row and count on top of it.
        if (error.pgCode !== '23505') throw error;
        const again = await run(db.from('member_hearts').select('id,taps')
          .eq('from_user_id', uid).eq('to_user_id', targetUserId).limit(1));
        const winner = again.data?.[0];
        if (winner) {
          await run(db.from('member_hearts').update({ taps: (winner.taps || 0) + 1 }).eq('id', winner.id));
        }
      }
    }
    const total = await run(db.from('member_hearts').select('taps').eq('to_user_id', targetUserId).limit(5000));
    const count = (total.data || []).reduce((sum, entry) => sum + (entry.taps || 0), 0);
    await logActivity('member_heart', targetUserId);
    return { hearts: count };
  },

  /* ---------------- media ---------------- */
  // Screenshots and avatars are uploaded by the member's own account into a folder named after
  // that account id, which is what the storage policy checks. Resizing happens in the browser
  // before this is called, because the free tier gives the whole project 1 GB.
  async uploadImage(bucket, blob) {
    const db = await client();
    const uid = await currentUserId(db);
    if (!uid) throw new Error('sign_in_required');
    if (!['avatars', 'post-images'].includes(bucket)) throw new Error('invalid_input');
    // An avatar has one fixed name and replaces itself, so changing your picture a dozen times
    // does not leave a dozen copies on a 1 GB plan. Post screenshots are kept as separate objects
    // because each one is a different picture; an admin can prune them from the Supabase dashboard.
    const avatar = bucket === 'avatars';
    const path = avatar ? `${uid}/avatar.jpg` : `${uid}/${Date.now()}.jpg`;
    const uploaded = await db.storage.from(bucket).upload(path, blob, {
      contentType: 'image/jpeg',
      upsert: avatar,
    });
    if (uploaded.error) {
      const why = String(uploaded.error.message || '').toLowerCase();
      if (/size|too large/.test(why)) throw new Error('image_too_large');
      throw new Error('upload_failed');
    }
    return db.storage.from(bucket).getPublicUrl(path).data.publicUrl;
  },

  // Squad artwork goes to a folder named after the squad, with one fixed file name per kind, so
  // uploading a new logo replaces the old one instead of leaving it on the free 1 GB plan. Which
  // folders a given account may write is decided by the bucket policy in supabase/schema.sql --
  // it reads the squad's captain from the teams table, so this call cannot aim itself at another
  // team's badge no matter what it is given.
  async uploadTeamImage(teamId, kind, blob) {
    if (!isConfigured()) throw new Error('backend_missing');
    if (!['logo', 'banner'].includes(kind)) throw new Error('invalid_input');
    if (!UUID_SHAPE.test(String(teamId))) throw new Error('invalid_input');
    const db = await client();
    if (!(await currentUserId(db))) throw new Error('sign_in_required');
    const path = `${teamId}/${kind}.jpg`;
    const uploaded = await db.storage.from('team-media').upload(path, blob, {
      contentType: 'image/jpeg',
      upsert: true,
    });
    if (uploaded.error) {
      const why = String(uploaded.error.message || '').toLowerCase();
      if (/size|too large/.test(why)) throw new Error('image_too_large');
      if (/not allowed|policy|forbidden|unauthorized/.test(why)) throw new Error('permission_denied');
      throw new Error('upload_failed');
    }
    return db.storage.from('team-media').getPublicUrl(path).data.publicUrl;
  },

  // One field at a time, merged with what is already stored: the row holds both images, and
  // writing only the logo must not blank the banner. Changing a squad's name, minimum rank or
  // status is not possible through this call at all -- those columns live on `teams`.
  async saveTeamMedia(teamId, patch) {
    if (!isConfigured()) throw new Error('backend_missing');
    if (!UUID_SHAPE.test(String(teamId))) throw new Error('invalid_input');
    const kinds = ['logo_url', 'banner_url'].filter(key => key in patch);
    if (!kinds.length) throw new Error('invalid_input');
    const values = {};
    for (const key of kinds) {
      const next = patch[key];
      if (next === null || next === '') {
        values[key] = null;
        continue;
      }
      const url = mediaUrl(next);
      if (!url) throw new Error('invalid_input');
      values[key] = url;
    }
    const db = await client();
    const uid = await currentUserId(db);
    if (!uid) throw new Error('sign_in_required');
    const found = await run(db.from('team_media').select('logo_url,banner_url').eq('team_id', teamId).limit(1));
    const stored = found.data?.[0] || {};
    await run(db.from('team_media').upsert({
      team_id: teamId,
      logo_url: values.logo_url ?? stored.logo_url ?? null,
      banner_url: values.banner_url ?? stored.banner_url ?? null,
      updated_by: uid,
      updated_at: new Date().toISOString(),
    }));
    await logActivity('team_media_update', `${teamId} ${kinds.map(key => (values[key] ? 'set' : 'cleared')).join(', ')}`);
    return { ok: true };
  },

  /* ---------------- feed ---------------- */
  async posts({ offset = 0, limit = 20, mine = false } = {}) {
    const db = await client();
    const uid = await currentUserId(db);
    const size = Math.min(50, Math.max(1, Number(limit) || 20));
    const from = Math.max(0, Number(offset) || 0);
    let query = db.from('posts').select(POST_EMBED)
      .order('created_at', { ascending: false });
    // "Mine" is the queue view of your own submissions, published or still waiting; the rest of
    // the feed only ever shows approved rows.
    query = mine ? (uid ? query.eq('user_id', uid) : approved(query)) : approved(query);
    const result = await run(query.range(from, from + size - 1));
    const rows = result.data || [];
    const ids = rows.map(row => row.id);
    const tapTotals = new Map();
    const myTaps = new Map();
    const commentCounts = new Map();
    if (ids.length) {
      // Counted here rather than embedded in the post query, so the feed does not
      // depend on PostgREST relationship inference to render at all.
      const [likes, comments] = await Promise.all([
        run(db.from('likes').select('post_id,user_id,taps').in('post_id', ids).limit(5000)),
        run(approved(db.from('comments').select('post_id')).in('post_id', ids).limit(5000)),
      ]);
      (likes.data || []).forEach(like => {
        tapTotals.set(like.post_id, (tapTotals.get(like.post_id) || 0) + (like.taps || 1));
        if (uid && like.user_id === uid) myTaps.set(like.post_id, like.taps || 1);
      });
      (comments.data || []).forEach(comment => {
        commentCounts.set(comment.post_id, (commentCounts.get(comment.post_id) || 0) + 1);
      });
    }
    return {
      posts: rows.map(row => ({
        id: row.id,
        // The profile wins so a rename is live on every post immediately; the stored copy is the
        // fallback for a row whose account has been deleted.
        author: row.profiles?.ign || row.author || 'Former member',
        rank: row.profiles?.rank || row.rank || 'Unranked',
        avatar_url: row.profiles?.avatar_url || null,
        user_id: row.user_id,
        category: row.category,
        content: row.content,
        image_url: row.image_url,
        video_url: row.video_url,
        status: row.status,
        created_at: row.created_at,
        comments: commentCounts.get(row.id) || 0,
        taps: tapTotals.get(row.id) || 0,
        my_taps: myTaps.get(row.id) || 0,
      })),
      hasMore: rows.length === size,
      nextOffset: from + rows.length,
    };
  },

  // Adds `delta` taps to the caller's own row on a post, and keeps the row even at zero so the
  // count never goes missing. Only the owner of a row can write it (likes own update).
  async tapPost(postId, delta = 1) {
    const db = await client();
    const uid = await currentUserId(db);
    if (!uid) throw new Error('sign_in_required');
    const step = Number(delta) > 0 ? 1 : -1;
    const own = await run(db.from('likes').select('id,taps')
      .eq('post_id', postId).eq('user_id', uid).limit(1));
    const row = own.data?.[0];
    if (row) {
      const next = Math.max(0, (row.taps || 0) + step);
      await run(db.from('likes').update({ taps: next, updated_at: new Date().toISOString() }).eq('id', row.id));
    } else {
      if (step < 0) throw new Error('not_found');
      try {
        await run(db.from('likes').insert({ post_id: postId, user_id: uid, taps: 1 }));
      } catch (error) {
        if (error.pgCode !== '23505') throw error;
        const again = await run(db.from('likes').select('id,taps')
          .eq('post_id', postId).eq('user_id', uid).limit(1));
        const winner = again.data?.[0];
        if (winner) await run(db.from('likes').update({ taps: (winner.taps || 0) + 1 }).eq('id', winner.id));
      }
    }
    const rows = await run(db.from('likes').select('user_id,taps').eq('post_id', postId).limit(5000));
    const total = (rows.data || []).reduce((sum, entry) => sum + (entry.taps || 0), 0);
    const mine = (rows.data || []).find(entry => entry.user_id === uid)?.taps || 0;
    if (step > 0) await logActivity('post_tap', postId);
    return { taps: total, my_taps: mine };
  },

  comments: async (postId) => {
    const db = await client();
    const result = await run(approved(db.from('comments')
      .select('id,user_id,author,content,created_at,profiles(user_id,ign,avatar_url)'))
      .eq('post_id', postId)
      .order('created_at')
      .limit(100));
    return (result.data || []).map(row => ({
      id: row.id,
      author: row.profiles?.ign || row.author || 'Former member',
      avatar_url: row.profiles?.avatar_url || null,
      content: row.content,
      created_at: row.created_at,
    }));
  },

  async post({ content, category, imageUrl, videoUrl, asMember = false }) {
    const db = await client();
    const profile = await requireProfile(db);
    const text = String(content ?? '').trim().slice(0, MAX_POST);
    const image = clamp(imageUrl, 600) || null;
    const video = clamp(videoUrl, 600) || null;
    if (text.length < 3 && !image && !video) throw new Error('invalid_input');
    if (text.length > MAX_POST) throw new Error('post_too_long');
    if (video && !youTubeId(video)) throw new Error('video_not_youtube');
    if (asMember || !(await isSiteAdmin(db))) assertCooldown('posts');
    const result = await insertRow('posts', {
      user_id: profile.user_id,
      // A snapshot for the case where the account is deleted later; the live profile is what the
      // feed reads while it exists.
      author: profile.ign,
      rank: profile.rank,
      category: oneOf(category, CATEGORIES, 'General'),
      content: text,
      image_url: image,
      video_url: video,
    }, { asMember });
    await logActivity('post_submit', profile.ign);
    return result;
  },

  async comment(postId, content, { asMember = false } = {}) {
    const db = await client();
    const profile = await requireProfile(db);
    const text = String(content ?? '').trim().slice(0, 300);
    if (text.length < 2) throw new Error('invalid_input');
    if (asMember || !(await isSiteAdmin(db))) assertCooldown('comments');
    const result = await insertRow('comments', {
      post_id: postId,
      user_id: profile.user_id,
      author: profile.ign,
      content: text,
    }, { asMember });
    await logActivity('comment_submit', profile.ign);
    return result;
  },

  // Deleting your own row while it is still waiting for review. A published post only an admin
  // can take away, which is what the policy enforces.
  async withdraw(kind, id) {
    const table = { post: 'posts', comment: 'comments' }[kind];
    if (!table || !id) throw new Error('invalid_input');
    const db = await client();
    const uid = await currentUserId(db);
    if (!uid) throw new Error('sign_in_required');
    const result = await run(db.from(table).delete().eq('id', id).eq('user_id', uid).eq('status', 'pending').select('id'));
    if (!result.data?.length) throw new Error('cannot_withdraw');
    return { ok: true };
  },

  /* ---------------- directory numbers ---------------- */
  async stats() {
    const db = await client();
    const [posts, comments, teams, members] = await Promise.all([
      run(db.from('posts').select('id', { count: 'exact', head: true }).eq('status', 'approved')),
      run(db.from('comments').select('id', { count: 'exact', head: true }).eq('status', 'approved')),
      run(db.from('teams').select('id', { count: 'exact', head: true })),
      run(db.from('profiles').select('user_id', { count: 'exact', head: true })),
    ]);
    const cutoff = new Date(Date.now() - ONLINE_WITHIN_MS).toISOString();
    const online = await run(db.from('profiles').select('user_id').gt('last_seen_at', cutoff).limit(500));
    return {
      posts: posts.count ?? 0,
      comments: comments.count ?? 0,
      teams: teams.count ?? 0,
      members: members.count ?? 0,
      online: online.data?.length ?? 0,
    };
  },

  // The leaderboard: rank points decide it, and the tier is shown so a Master with no points is
  // not sorted above a Legendary by accident.
  async leaderboard() {
    const db = await client();
    const found = await run(db.from('profiles')
      .select('user_id,ign,avatar_url,rank,rank_points,main_mode,role_label,standing,exec_position')
      .order('rank_points', { ascending: false, nullsFirst: false })
      .order('ign')
      .limit(100));
    const rows = found.data || [];
    return rows.map((row, index) => ({ ...row, place: index + 1 }));
  },

  /* ---------------- squads ---------------- */
  async teams() {
    const db = await client();
    const result = await run(db.from('teams')
      .select('id,name,logo,description,game_mode,region,required_rank,status,leader,slot_count,captain_user_id,captain_nick,created_at')
      .order('created_at', { ascending: false })
      .limit(100));
    const teams = result.data || [];
    const ids = teams.map(team => team.id);
    let entries = [];
    let artwork = [];
    if (ids.length) {
      const found = await run(db.from('join_requests')
        .select('id,team_id,nickname,status,user_id,created_at,profiles(user_id,ign,avatar_url,rank)')
        .in('team_id', ids)
        .order('created_at')
        .limit(2000));
      entries = found.data || [];
      // Awaited without run(): a project that has not yet been given the team_media table answers
      // with a missing relation, and a squad page with no artwork is worth more than a squad page
      // that refuses to load.
      const media = await db.from('team_media')
        .select('team_id,logo_url,banner_url')
        .in('team_id', ids)
        .limit(ids.length);
      artwork = media.data || [];
    }
    return teams.map(team => {
      const media = artwork.find(row => row.team_id === team.id);
      team.logo_url = media?.logo_url || null;
      team.banner_url = media?.banner_url || null;
      const mine = entries.filter(entry => entry.team_id === team.id);
      const members = mine
        .filter(entry => entry.status === 'accepted')
        .map(entry => ({
          id: entry.id,
          name: entry.profiles?.ign || entry.nickname || 'Former member',
          avatar_url: entry.profiles?.avatar_url || null,
          rank: entry.profiles?.rank || null,
          role: 'Member',
          user_id: entry.user_id,
        }));
      // A squad starts with nobody on it -- not even the admin who published it. Slots fill only
      // when an application is accepted, so the roster count on the card is real membership.
      team.members = members;
      // Pending applications are hidden by row level security from everyone except their
      // author, the team's captain and an admin, so an empty list is the normal answer.
      team.applicants = mine
        .filter(entry => entry.status === 'pending')
        .map(entry => ({
          id: entry.id,
          name: entry.profiles?.ign || entry.nickname || 'Former member',
          avatar_url: entry.profiles?.avatar_url || null,
          rank: entry.profiles?.rank || null,
          role: 'Applicant',
          user_id: entry.user_id,
          created_at: entry.created_at,
        }));
      return team;
    });
  },

  async createTeam(team) {
    const name = clamp(team.name, 40);
    if (name.length < 2) throw new Error('invalid_input');
    if (!isConfigured()) throw new Error('backend_missing');
    const db = await client();
    if (!(await isSiteAdmin(db))) throw new Error('admin_required');
    try {
      const result = await run(db.from('teams').insert({
        name,
        logo: clamp(team.logo, 4) || name.slice(0, 2).toUpperCase(),
        description: clamp(team.description, 300),
        game_mode: clamp(team.game_mode, 40) || 'Multiplayer',
        region: clamp(team.region, 40) || 'Philippines',
        required_rank: oneOf(team.required_rank, RANK_TIERS, 'Master'),
        status: 'recruiting',
        leader: clamp(team.leader, 24) || 'Admin',
        slot_count: Math.min(12, Math.max(2, Number(team.slot_count) || 5)),
      }).select('id'));
      await logActivity('team_create', name);
      return result.data?.[0];
    } catch (error) {
      if (error.pgCode === '23505') throw new Error('duplicate_name');
      throw error;
    }
  },

  // Removing a squad is an admin act; the roster rows go with it (on delete cascade).
  async deleteTeam(teamId) {
    const db = await client();
    if (!(await isSiteAdmin(db))) throw new Error('admin_required');
    const found = await run(db.from('teams').select('name').eq('id', teamId).limit(1));
    const name = found.data?.[0]?.name;
    if (!name) throw new Error('not_found');
    await run(db.from('teams').delete().eq('id', teamId));
    await logActivity('team_delete', name);
    return { ok: true, name };
  },

  // Applying is an account's act: the rank gate reads your stored profile, and the database
  // refuses the row if it is below the squad's minimum. The pre-check here only exists to say
  // why, in words, instead of reporting a refusal.
  async joinTeam(teamId) {
    const db = await client();
    const profile = await requireProfile(db);
    const team = await run(db.from('teams').select('id,name,required_rank,status,slot_count').eq('id', teamId).limit(1));
    const target = team.data?.[0];
    if (!target) throw new Error('not_found');
    if (rankPosition(profile.rank) < rankPosition(target.required_rank)) {
      const error = new Error('rank_too_low');
      error.required = target.required_rank;
      error.mine = profile.rank;
      throw error;
    }
    try {
      // No row is read back: the insert either lands in that squad's applications or it does not.
      await run(db.from('join_requests').insert({ team_id: teamId, user_id: profile.user_id, nickname: profile.ign }));
      await logActivity('join_apply', target.name);
      return { duplicated: false };
    } catch (error) {
      if (error.pgCode === '23505') return { duplicated: true };
      if (error.pgCode === '42501') throw new Error('rank_too_low');
      throw error;
    }
  },

  // Leaving on your own: your accepted row, set to 'rejected' with no decision-maker. The policy
  // only lets the owner write it.
  async leaveTeam(teamId) {
    const db = await client();
    const uid = await currentUserId(db);
    if (!uid) throw new Error('sign_in_required');
    const result = await run(db.from('join_requests')
      .update({ status: 'rejected', decided_by: null, decided_at: new Date().toISOString() })
      .eq('team_id', teamId).eq('user_id', uid).eq('status', 'accepted')
      .select('id'));
    if (!result.data?.length) throw new Error('not_a_member');
    await logActivity('join_leave', teamId);
    return { ok: true };
  },

  // A captain accepts, declines or removes. The database compares the signed-in account with
  // the team's captain, so a refusal arrives as zero rows rather than an error message.
  async decideJoin(id, decision) {
    const status = decision === 'accepted' ? 'accepted' : 'rejected';
    const db = await client();
    const uid = await currentUserId(db);
    if (!uid) throw new Error('sign_in_required');
    const result = await run(db.from('join_requests')
      .update({ status, decided_by: uid, decided_at: new Date().toISOString() })
      .eq('id', id)
      .in('status', ['pending', 'accepted'])
      .select('id'));
    if (!result.data?.length) throw new Error('captain_required');
    await logActivity(status === 'accepted' ? 'join_accept' : 'member_remove', id);
    return { ok: true, status };
  },

  // Only an admin names a captain, and only the database can add someone to site_admins.
  // A null account clears the role, which is how a wrong assignment gets undone.
  async assignCaptain(teamId, userId, nickname) {
    const db = await client();
    if (!(await isSiteAdmin(db))) throw new Error('admin_required');
    const uid = await currentUserId(db);
    const result = await run(db.from('teams')
      .update({ captain_user_id: userId || null, captain_nick: userId ? clamp(nickname, 24) : null })
      .eq('id', teamId)
      .select('id'));
    if (!result.data?.length) throw new Error('not_found');
    // Naming an applicant captain also accepts that person's own pending row: a captain who is
    // still only asking to join is nonsense on the roster. The admin policy permits the write.
    if (userId) {
      await run(db.from('join_requests')
        .update({ status: 'accepted', decided_by: uid, decided_at: new Date().toISOString() })
        .eq('team_id', teamId).eq('user_id', userId).eq('status', 'pending'));
    }
    await logActivity(userId ? 'captain_assign' : 'captain_remove', clamp(nickname, 24) || teamId);
    return { ok: true };
  },

  /* ---------------- admin ---------------- */
  async moderation() {
    const db = await client();
    const [pendingPosts, pendingComments] = await Promise.all([
      run(db.from('posts').select(`id,user_id,author,rank,category,content,image_url,video_url,created_at,profiles(user_id,ign,avatar_url)`)
        .eq('status', 'pending').order('created_at').limit(100)),
      run(db.from('comments').select('id,post_id,user_id,author,content,created_at,profiles(user_id,ign,avatar_url)')
        .eq('status', 'pending').order('created_at').limit(100)),
    ]);
    const comments = pendingComments.data || [];
    const parentIds = [...new Set(comments.map(entry => entry.post_id))];
    const parents = new Map();
    if (parentIds.length) {
      const found = await run(db.from('posts').select('id,author,content').in('id', parentIds).limit(100));
      (found.data || []).forEach(post => parents.set(post.id, post));
    }
    const named = (row) => row.profiles?.ign || row.author || 'Former member';
    return {
      posts: (pendingPosts.data || []).map(row => ({ ...row, author: named(row), avatar_url: row.profiles?.avatar_url || null })),
      comments: comments.map(entry => ({
        ...entry,
        author: named(entry),
        avatar_url: entry.profiles?.avatar_url || null,
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
    if (op === 'approve') await logActivity('post_approve', `${kind} ${id}`);
    if (op === 'reject') await logActivity('record_delete', `${kind} ${id}`);
    return { ok: true };
  },

  // The admin's console: everyone signed up, who is online now, and the recent activity log.
  async adminOverview(query = '') {
    const db = await client();
    if (!(await isSiteAdmin(db))) throw new Error('admin_required');
    const cutoff = new Date(Date.now() - ONLINE_WITHIN_MS).toISOString();
    const [members, online, log] = await Promise.all([
      api.members(query),
      run(db.from('profiles').select('user_id,ign,avatar_url,last_seen_at').gt('last_seen_at', cutoff)
        .order('last_seen_at', { ascending: false }).limit(200)),
      run(db.from('activity_log')
        .select('id,action,detail,created_at,actor_user_id,profiles(user_id,ign)')
        .order('created_at', { ascending: false }).limit(120)),
    ]);
    return {
      totalMembers: members.length,
      members,
      online: online.data || [],
      log: (log.data || []).map(entry => ({
        ...entry,
        actor: entry.profiles?.ign || 'Deleted account',
      })),
    };
  },
};

// A YouTube watch or short link, in the two shapes the database CHECK accepts. Parsing it here
// means the composer can say "that is not a YouTube link" instead of the row coming back refused.
export function youTubeId(value) {
  const url = String(value ?? '').trim();
  const direct = url.match(/^https:\/\/youtu\.be\/([A-Za-z0-9_-]{6,12})$/);
  if (direct) return direct[1];
  const watch = url.match(/^https:\/\/(www\.|m\.)?youtube\.com\/watch\?v=([A-Za-z0-9_-]{6,12})$/);
  return watch ? watch[2] : null;
}
