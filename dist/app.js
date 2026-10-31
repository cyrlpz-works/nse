import {
  api, isConfigured, signIn, signUpAccount, signOutAsAdmin, hasAdminSession, myUserId, myProfile,
  RANK_TIERS, MP_ROLES, BR_CLASSES, EXEC_POSITIONS, CATEGORIES, youTubeId,
} from './api.js';

// The ladder has no subdivisions any more: a tier is the whole rank, and a Legendary carries the
// points that place them on the leaderboard.
const RANK_RP = {
  Unranked: 'not placed yet', Rookie: '0 – 1,000', Veteran: '1,001 – 2,000', Elite: '2,001 – 3,000',
  Pro: '3,001 – 4,500', Master: '4,501 – 6,000', 'Grand Master': '6,001 – 8,000', Legendary: '8,001+',
};
const MAX_POST = 1200;
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
const AVATAR_EDGE = 256;
const POST_IMAGE_EDGE = 1200;

const state = {
  route: 'home',
  teams: [],
  posts: [],
  nextOffset: 0,
  hasMore: false,
  stats: null,
  category: 'General',
  search: '',
  sort: 'new',
  teamSearch: '',
  teamMode: '',
  memberSearch: '',
  adminSearch: '',
  leaderboard: [],
  members: [],
  openComments: new Set(),
  commentsByPost: new Map(),
  loadingComments: new Set(),
  offline: false,
  isAdmin: false,
  myUserId: null,
  profile: null,
  // What the composer is holding: an uploaded screenshot URL and a video link. The file itself is
  // uploaded before the post is sent, so a refused post never leaves an orphan behind -- it only
  // costs one object in the bucket, which the README notes how to prune.
  draftImage: null,
  draftVideo: null,
  uploading: false,
};

const isSignedIn = () => Boolean(state.myUserId);
// A captain runs exactly one squad's roster. The test is the account id stored on that squad row,
// which is the same value the database compares -- so this only decides what gets drawn, never
// what is allowed.
const canCaptain = (team) => state.isAdmin || (isSignedIn() && team.captain_user_id === state.myUserId);

/* ---------------- helpers ---------------- */
const $ = (id) => document.getElementById(id);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const HTTPS_ONLY = /^https:\/\/[A-Za-z0-9.\-_]+(:\d+)?(\/[^\s]*)?$/;
// An <img src> and an <a href> are both places where a stored "url" could turn into script or a
// javascript: link, so anything that is not a plain https address is treated as no url at all.
const safeUrl = (value) => {
  const text = String(value ?? '').trim();
  return HTTPS_ONLY.test(text) ? text : null;
};

function initials(name) {
  const parts = String(name || '?').trim().split(/[\s._-]+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts[0][0] + (parts[1]?.[0] ?? '')).toUpperCase();
}

// Every face on the site is the same one: the profile's avatar if it has one, otherwise initials
// of the IGN. A member row, a post byline, the header and the member card all call this.
function avatarMarkup(person, extraClass = '') {
  const url = safeUrl(person?.avatar_url);
  const name = person?.ign || person?.name || 'Member';
  if (url) return `<img class="avatar avatar-img ${extraClass}" src="${esc(url)}" alt="" loading="lazy">`;
  return `<span class="avatar ${extraClass}" aria-hidden="true">${esc(initials(name))}</span>`;
}

function timeAgo(iso) {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return 'recently';
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 45) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(then).toLocaleDateString();
}

const HEART = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-7.5-4.6-9.3-9A5.1 5.1 0 0 1 12 6.2 5.1 5.1 0 0 1 21.3 12c-1.8 4.4-9.3 9-9.3 9Z"/></svg>';
const BUBBLE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h16v11H9l-5 4V4Z"/></svg>';

function toast(message, isError = false) {
  const node = document.createElement('div');
  node.className = `toast${isError ? ' error' : ''}`;
  node.textContent = message;
  $('toasts').appendChild(node);
  setTimeout(() => { node.style.opacity = '0'; node.style.transition = 'opacity .3s'; }, 3200);
  setTimeout(() => node.remove(), 3600);
}

const ERRORS = {
  invalid_input: 'Please check the highlighted fields.',
  profile_required: 'Save your profile once — your IGN is what your posts are filed under.',
  sign_in_required: 'Sign in with your own account first. Posts, comments, hearts and roster changes all belong to an account.',
  post_too_long: 'That post is too long (max 1200 characters).',
  too_short: 'Wait a minute before sending another one.',
  not_found: 'That entry no longer exists.',
  duplicate_name: 'A squad with that name already exists.',
  admin_required: 'Only the site admin can do that.',
  permission_denied: 'The database refused that — it is someone else’s row, or it needs the site admin.',
  captain_required: 'Only this squad’s captain can change its roster.',
  not_a_member: 'You are not on that squad’s roster.',
  cannot_withdraw: 'Only your own queued post can be pulled back. Once it is published, ask the admin.',
  heart_self: 'You cannot heart your own profile.',
  legendary_points: 'Legendary needs your ranked points, or the leaderboard has nothing to place you by.',
  video_not_youtube: 'Only a YouTube link works here — youtube.com/watch?v=… or youtu.be/…',
  image_too_large: 'That image is too big. Use a screenshot under 8 MB.',
  upload_failed: 'The image could not be uploaded. Try again, or post without it.',
  image_failed: 'The browser could not read that image. Try a PNG or JPG screenshot.',
  account_exists: 'That email already has an account. Sign in instead of creating one.',
  email_invalid: 'That email address was refused. Use a real address — a gmail or similar, not a made-up domain.',
  sign_up_failed: 'The account could not be created. Try again, or add this account in Supabase → Authentication → Users.',
  email_confirmation: 'That account still needs its email confirmed. Supabase can turn confirmation off in Authentication → Providers.',
  auth_failed: 'That email or password is not correct.',
  backend_missing: 'This site is not connected to its database yet.',
  database_unavailable: 'The database refused that request.',
  network_error: 'Cannot reach the community database. Check your connection.',
  timeout: 'The server took too long. Try again.',
};
const explain = (error) => {
  if (error?.message === 'rank_too_low') {
    return `This squad needs ${error.required || 'a higher rank'} and your profile says ${error.mine || 'Unranked'}. Set your real rank on the Profile page, or ask for a squad you qualify for.`;
  }
  return ERRORS[error?.message] || 'Something went wrong. Please try again.';
};

const rankLine = (profile) => {
  if (!profile) return 'Unranked';
  const points = Number.isFinite(Number(profile.rank_points)) ? ` · ${Number(profile.rank_points).toLocaleString()} pts` : '';
  return `${profile.rank || 'Unranked'}${points}`;
};
const roleLine = (profile) => {
  if (!profile?.main_mode) return 'No main mode yet';
  return `${profile.main_mode}${profile.role_label ? ` · ${profile.role_label}` : ''}`;
};
const standingLine = (profile) => (profile?.standing === 'executive'
  ? `EXECUTIVE · ${profile.exec_position || 'position not set'}`
  : 'MEMBER');

/* ---------------- routing ---------------- */
function currentRoute() {
  const hash = location.hash.replace(/^#\/?/, '');
  const team = hash.match(/^teams\/([0-9a-fA-F-]{36})$/);
  if (team) return { view: 'team', id: team[1] };
  if (['home', 'community', 'teams', 'members', 'ranks', 'profile', 'approval'].includes(hash)) return { view: hash };
  return { view: 'home' };
}

function paintRoute() {
  const route = currentRoute();
  state.route = route.view;
  document.querySelectorAll('.view').forEach(node => node.classList.remove('is-active'));
  const target = $(`view-${route.view}`);
  if (target) target.classList.add('is-active');

  document.querySelectorAll('[data-nav]').forEach(node => {
    const destination = node.dataset.nav;
    const isCurrent = destination === route.view || (destination === 'teams' && route.view === 'team');
    if (node.classList.contains('nav-link')) {
      if (isCurrent) node.setAttribute('aria-current', 'page');
      else node.removeAttribute('aria-current');
    }
  });

  if (route.view === 'team') renderTeamDetail(route.id);
  if (route.view === 'profile') renderProfile();
  if (route.view === 'home') renderHome();
  if (route.view === 'community') renderFeed();
  if (route.view === 'teams') renderTeamGrid();
  if (route.view === 'members') renderMembers();
  if (route.view === 'ranks') renderLeaderboard();
  if (route.view === 'approval') { renderModeration(); renderCaptainBoard(); renderAdminConsole(); }
  window.scrollTo({ top: 0, behavior: 'auto' });
}

function navigate(view) { location.hash = `#/${view}`; }

/* ---------------- header ---------------- */
function paintHeader() {
  const name = state.profile?.ign || 'Guest';
  $('headerName').textContent = name;
  $('headerRank').textContent = state.profile ? rankLine(state.profile) : 'Set your rank';
  const avatarHost = $('headerAvatar');
  const url = safeUrl(state.profile?.avatar_url);
  if (url) {
    avatarHost.outerHTML = `<img class="avatar avatar-img" id="headerAvatar" src="${esc(url)}" alt="" aria-hidden="true">`;
  } else {
    const current = $('headerAvatar');
    if (current.tagName === 'IMG') {
      current.outerHTML = `<span class="avatar accent" id="headerAvatar" aria-hidden="true">${esc(initials(name))}</span>`;
    } else current.textContent = initials(name);
  }
  // The composer's own face. A stored url goes into an <img src>, never into an inline
  // `style="background-image: url(...)"` — a url is not escaped for CSS, and a value that closes
  // the declaration early would be read as a style rule by the browser.
  const composerAvatar = $('composerAvatar');
  if (composerAvatar) {
    const wantUrl = safeUrl(state.profile?.avatar_url) || '';
    if (composerAvatar.dataset.avatar !== wantUrl) {
      const node = document.createElement(wantUrl ? 'img' : 'span');
      node.id = 'composerAvatar';
      node.className = `avatar accent${wantUrl ? ' avatar-img' : ''}`;
      node.setAttribute('aria-hidden', 'true');
      node.dataset.avatar = wantUrl;
      if (wantUrl) { node.src = wantUrl; node.alt = ''; node.loading = 'lazy'; }
      else node.textContent = initials(name);
      composerAvatar.replaceWith(node);
    } else if (!wantUrl) composerAvatar.textContent = initials(name);
  }
  paintAdminUi();
}

function paintAdminUi() {
  const button = $('adminButton');
  const signedInAs = state.isAdmin ? 'admin' : isSignedIn() ? 'member' : 'guest';
  button.textContent = signedInAs === 'admin' ? 'Signed in as admin' : signedInAs === 'member' ? 'Signed in' : 'Sign in';
  button.classList.toggle('is-on', signedInAs !== 'guest');
  button.setAttribute('aria-label', signedInAs === 'admin'
    ? 'Signed in as the site admin. Click to sign out'
    : signedInAs === 'member'
      ? 'Signed in with your own account. Click to sign out'
      : 'Sign in — your own account, or the site admin account');

  $('approvalNav').hidden = !state.isAdmin;
  $('openCreateTeam').hidden = state.offline || !state.isAdmin;
  // Everything that writes is an account's act now, so the composer is shown only to someone who
  // has signed in. The database is what enforces it; this is so the button is not a dead end.
  $('postForm').hidden = state.offline || !isSignedIn();
  $('composerGate').hidden = state.offline || isSignedIn();
  const notice = $('modeNotice');
  notice.hidden = state.offline;
  notice.textContent = state.offline
    ? (isConfigured()
      ? 'The community database could not be reached, so the feed and squads stay empty and nothing can be published.'
      : 'This site is not connected to its database yet, so the feed and squads stay empty. Add the project URL and anon key in dist/config.js.')
    : 'Everything here belongs to an account: post, comment, tap and ask to join a squad while signed in. The admin approves every post before it reaches the feed, publishes squads and names captains. A captain runs only their own squad’s roster.';
  renderModeration();
}

/* ---------------- shared renderers ---------------- */
function videoMarkup(url) {
  const id = youTubeId(safeUrl(url) || '');
  if (!id) return '';
  return `
    <div class="video-facade" data-video-panel="${esc(id)}">
      <button class="btn btn-ghost btn-sm" type="button" data-play="${esc(id)}" aria-label="Load the YouTube clip">
        ▶ Load clip
      </button>
      <a class="field-hint" href="${esc(safeUrl(url))}" target="_blank" rel="noopener noreferrer nofollow">Open on YouTube</a>
    </div>`;
}

function imageMarkup(post) {
  const url = safeUrl(post.image_url);
  if (!url) return '';
  return `<a class="post-image-link" href="${esc(url)}" target="_blank" rel="noopener noreferrer nofollow">
    <img class="post-image" src="${esc(url)}" alt="Screenshot posted by ${esc(post.author)}" loading="lazy">
  </a>`;
}

function postNode(post) {
  const article = document.createElement('article');
  article.className = 'card post-card';
  article.dataset.id = post.id;

  const pending = post.status === 'pending';
  const open = !pending && state.openComments.has(post.id);
  const cached = state.commentsByPost.get(post.id);
  // A queued row is visible to its author and the admin; a published one can only be deleted by
  // the admin, which is exactly what the database will allow.
  const mine = isSignedIn() && post.user_id === state.myUserId;

  const actions = pending ? `
    <button class="icon-btn danger" type="button" data-withdraw="post:${esc(post.id)}">Pull it back</button>` : `
    <button class="icon-btn${post.my_taps ? ' is-on' : ''}" type="button" data-tap="${esc(post.id)}"
      title="Tap to heart this post — as many times as you like" aria-label="Heart this post, ${post.taps} hearts">
      ${HEART}<span aria-hidden="true">${post.taps}</span>
    </button>
    ${post.my_taps ? `<button class="icon-btn" type="button" data-untap="${esc(post.id)}"
      title="Take one heart back" aria-label="Take one heart back">−${post.my_taps}</button>` : ''}
    <button class="icon-btn" type="button" data-comments="${esc(post.id)}" aria-expanded="${open ? 'true' : 'false'}"
      title="Show comments" aria-label="Show comments, ${post.comments} comments">
      ${BUBBLE}<span aria-hidden="true">${post.comments}</span>
    </button>
    ${state.isAdmin ? `<button class="icon-btn danger" type="button" data-moderate="reject:post:${esc(post.id)}">Delete</button>` : ''}`;

  article.innerHTML = `
    <div class="post-head">
      <button class="avatar-btn" type="button" ${post.user_id ? `data-member="${esc(post.user_id)}"` : 'disabled'}>
        ${avatarMarkup({ avatar_url: post.avatar_url, ign: post.author })}
      </button>
      <div class="post-head-text">
        <div class="post-author">
          ${post.user_id
            ? `<button class="link-like name-link" type="button" data-member="${esc(post.user_id)}">${esc(post.author)}</button>`
            : esc(post.author)}
          <span class="badge pink">${esc(post.rank)}</span>
          ${mine && !pending ? '<span class="badge">yours</span>' : ''}
        </div>
        <div class="post-sub">
          <span class="badge">${esc(post.category)}</span>
          <time datetime="${esc(post.created_at)}">${esc(timeAgo(post.created_at))}</time>
        </div>
      </div>
    </div>
    ${pending ? '<p class="pending-flag">Waiting for admin approval — only you and the admin can see this post.</p>' : ''}
    ${post.content ? `<p class="post-body">${esc(post.content)}</p>` : ''}
    ${imageMarkup(post)}
    ${videoMarkup(post.video_url)}
    ${actions ? `<div class="post-actions">${actions}</div>` : ''}
    <div class="comments${open ? ' is-open' : ''}" data-comments-panel="${esc(post.id)}">
      ${open ? commentsMarkup(cached, state.loadingComments.has(post.id)) : ''}
    </div>`;
  if (open) attachCommentComposer(article, post.id);
  return article;
}

function commentsMarkup(list, loading) {
  if (loading || !list) return '<p class="comment-empty">Loading comments…</p>';
  if (!list.length) return '<p class="comment-empty">No comments yet.</p>';
  return list.map(c => `
    <div class="comment">
      ${avatarMarkup(c)}
      <p><b>${esc(c.author)}</b><br><span>${esc(c.content)}</span></p>
      <time>${esc(timeAgo(c.created_at))}</time>
    </div>`).join('');
}

function teamCard(team) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'card team-card';
  button.dataset.team = team.id;
  const recruiting = team.status === 'recruiting';
  button.innerHTML = `
    <div class="team-card-top">
      <span class="avatar accent" aria-hidden="true">${esc(team.logo)}</span>
      <span class="badge ${recruiting ? 'ok' : 'warn'}">${recruiting ? 'Recruiting' : 'Full'}</span>
    </div>
    <h3>${esc(team.name)}</h3>
    <p>${esc(team.description || 'No description yet.')}</p>
    <div class="team-meta">
      <i>${esc(team.game_mode)}</i>
      <i>${esc(team.region)}</i>
      <i>${team.members.length}/${team.slot_count} members</i>
      <i>Min rank: ${esc(team.required_rank)}</i>
      <i>${team.captain_nick ? `Captain: ${esc(team.captain_nick)}` : 'No captain yet'}</i>
    </div>`;
  return button;
}

function emptyBlock(message) {
  const node = document.createElement('div');
  node.className = 'empty';
  node.textContent = message;
  return node;
}

function skeletonBlock(count) {
  const wrap = document.createElement('div');
  wrap.className = 'stack';
  for (let i = 0; i < count; i += 1) {
    const bar = document.createElement('div');
    bar.className = 'skeleton';
    bar.style.height = '96px';
    bar.style.marginBottom = '0.75rem';
    wrap.appendChild(bar);
  }
  return wrap;
}

/* ---------------- home ---------------- */
const squadsEmptyCopy = () => (state.isAdmin
  ? 'No squads yet — create the first one.'
  : 'No squads published yet.');

function renderHome() {
  const stats = state.stats || { posts: state.posts.length, teams: state.teams.length, members: 0, comments: 0, online: 0 };
  $('homeStats').innerHTML = [
    ['Posts shared', stats.posts],
    ['Squads', stats.teams],
    ['Members', stats.members],
    ['Online now', stats.online],
  ].map(([label, value]) => `
    <div class="stat"><b>${Number(value) || 0}</b><span>${esc(label)}</span></div>`).join('');

  const recruiting = state.teams.filter(t => t.status === 'recruiting');
  $('recruitingCount').textContent = `${recruiting.length} open roster${recruiting.length === 1 ? '' : 's'}`;

  const teamsHost = $('homeTeams');
  teamsHost.replaceChildren();
  const featured = (recruiting.length ? recruiting : state.teams).slice(0, 3);
  if (!featured.length) teamsHost.appendChild(emptyBlock(squadsEmptyCopy()));
  featured.forEach(team => teamsHost.appendChild(teamCard(team)));

  const leaders = state.leaderboard.slice(0, 5);
  const leaderHost = $('homeLeaders');
  leaderHost.replaceChildren();
  if (!leaders.length) { leaderHost.appendChild(emptyBlock('No members yet.')); }
  else leaderHost.innerHTML = leaders.map(entry => `
    <div class="leader">
      <span class="leader-rank">#${entry.place}</span>
      <button class="avatar-btn" type="button" data-member="${esc(entry.user_id)}">${avatarMarkup(entry)}</button>
      <button class="link-like leader-name" type="button" data-member="${esc(entry.user_id)}">${esc(entry.ign)}</button>
      <span class="leader-score">${esc(entry.rank)} · ${(Number(entry.rank_points) || 0).toLocaleString()} pts</span>
    </div>`).join('');

  const online = state.members.filter(person => person.online);
  $('homeOnlineCount').textContent = `${online.length} signed in recently`;
  const onlineHost = $('homeOnline');
  onlineHost.replaceChildren();
  if (!online.length) onlineHost.appendChild(emptyBlock('Nobody has been seen in the last few minutes.'));
  else online.slice(0, 12).forEach(person => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'avatar-btn online-dot is-online';
    button.dataset.member = person.user_id;
    button.title = `${person.ign} · ${person.rank}`;
    button.innerHTML = avatarMarkup(person);
    onlineHost.appendChild(button);
  });

  const feedHost = $('homeFeed');
  feedHost.replaceChildren();
  const latest = state.posts.slice(0, 3);
  if (!latest.length) { feedHost.appendChild(emptyBlock('No posts yet.')); return; }
  latest.forEach(post => feedHost.appendChild(postNode(post)));
}

/* ---------------- community feed ---------------- */
function visiblePosts() {
  const needle = state.search.trim().toLowerCase();
  let list = state.posts;
  if (needle) {
    list = list.filter(p =>
      p.content.toLowerCase().includes(needle) ||
      p.author.toLowerCase().includes(needle) ||
      p.category.toLowerCase().includes(needle));
  }
  if (state.sort === 'top') return [...list].sort((a, b) => b.taps - a.taps);
  return list;
}

function renderFeed() {
  renderChips();
  const list = visiblePosts();
  $('feedCount').textContent = `${state.posts.length} loaded · ${list.length} shown`;

  const host = $('feedList');
  host.replaceChildren();
  if (!list.length) {
    host.appendChild(emptyBlock(state.posts.length
      ? 'No posts match that search.'
      : 'The feed is empty. Start the first conversation.'));
  } else {
    list.forEach(post => host.appendChild(postNode(post)));
  }
  $('loadMore').hidden = !(state.hasMore && !state.search.trim());
}

/* ---------------- review queue + admin console ---------------- */
function queueNode(kind, item, meta) {
  const node = document.createElement('div');
  node.className = 'queue-item';
  node.innerHTML = `
    <div class="queue-text">
      <p class="queue-byline">${avatarMarkup(item)} <b>${esc(item.author)}</b> · ${meta} · ${esc(timeAgo(item.created_at))}</p>
      <p>${esc(item.content)}</p>
      ${item.image_url ? `<img class="post-image thumb" src="${esc(safeUrl(item.image_url) || '')}" alt="" loading="lazy">` : ''}
      ${item.video_url ? `<p class="field-hint">clip link: ${esc(item.video_url)}</p>` : ''}
    </div>
    <div class="queue-actions">
      <button class="btn btn-primary btn-sm" type="button" data-moderate="approve:${kind}:${esc(item.id)}">Approve</button>
      <button class="btn btn-ghost btn-sm" type="button" data-moderate="reject:${kind}:${esc(item.id)}">Reject</button>
    </div>`;
  return node;
}

function paintQueueBadge(total) {
  const badge = $('approvalCount');
  badge.textContent = total > 0 ? String(total) : '';
  badge.hidden = !(total > 0);
}

async function renderModeration() {
  const list = $('queueList');
  const count = $('queueCount');
  paintQueueBadge(0);
  if (state.offline || !state.isAdmin) {
    if (count) count.textContent = '';
    list.replaceChildren(emptyBlock(state.offline
      ? 'The database is unreachable, so nothing can be reviewed right now.'
      : 'The approval queue belongs to the site admin. Sign in with that account to open it.'));
    return;
  }
  list.replaceChildren(skeletonBlock(1));
  try {
    const queue = await api.moderation();
    const posts = queue.posts || [];
    const comments = queue.comments || [];
    const total = posts.length + comments.length;
    count.textContent = total ? `${total} waiting` : 'Nothing waiting';
    paintQueueBadge(total);
    if (!total) {
      list.replaceChildren(emptyBlock('Nothing waiting — the feed is clean.'));
      return;
    }
    list.replaceChildren(
      ...posts.map(item => queueNode('post', item,
        `<span class="badge pink">${esc(item.rank)}</span> <span class="badge">${esc(item.category)}</span>`)),
      ...comments.map(item => queueNode('comment', item,
        `commenting on <i>${esc(item.post_author || 'a removed post')}</i>: “${esc(item.post_excerpt)}”`)),
    );
  } catch (error) {
    count.textContent = '';
    list.replaceChildren(emptyBlock(explain(error)));
  }
}

const ACTION_LABELS = {
  sign_in: 'signed in', sign_out: 'signed out', profile_update: 'updated their profile',
  post_submit: 'posted', comment_submit: 'commented', post_tap: 'tapped a post',
  member_heart: 'hearted a member', join_apply: 'applied to a squad', join_accept: 'accepted a member',
  join_leave: 'left a squad', post_approve: 'approved a post', post_reject: 'rejected a post',
  record_delete: 'deleted an entry', team_create: 'created a squad', team_delete: 'deleted a squad',
  captain_assign: 'made a captain', captain_remove: 'removed a captain', member_remove: 'removed a member',
};

// The admin's own numbers: who is here, who has an account at all, and what the site has been used
// for lately. This is the only place the totals are shown -- a member sees the same list on the
// Members page without the log.
async function renderAdminConsole() {
  const statsHost = $('adminStats');
  const membersHost = $('adminMembers');
  const logHost = $('activityList');
  const count = $('activityCount');
  if (state.offline || !state.isAdmin) {
    statsHost.innerHTML = '';
    count.textContent = '';
    membersHost.replaceChildren(emptyBlock('Sign in as the site admin to see the member list and the activity log.'));
    logHost.replaceChildren();
    return;
  }
  membersHost.replaceChildren(skeletonBlock(1));
  try {
    const overview = await api.adminOverview(state.adminSearch);
    statsHost.innerHTML = [
      ['Accounts', overview.members.length],
      ['Online now', overview.online.length],
      ['Log entries', overview.log.length],
      ['Squads', state.teams.length],
    ].map(([label, value]) => `<div class="stat"><b>${Number(value) || 0}</b><span>${esc(label)}</span></div>`).join('');
    count.textContent = overview.log.length ? `last ${overview.log.length} events` : '';

    membersHost.replaceChildren();
    const people = overview.members;
    if (!people.length) {
      membersHost.appendChild(emptyBlock(state.adminSearch.trim()
        ? 'No member matches that nickname.'
        : 'No one has made an account yet.'));
    } else {
      const head = document.createElement('div');
      head.className = 'table-head';
      head.innerHTML = '<span>Nickname</span><span>Rank</span><span>Standing</span><span>Seen</span>';
      membersHost.appendChild(head);
      people.forEach(person => {
        const row = document.createElement('div');
        row.className = 'table-row';
        row.innerHTML = `
          <button class="link-like table-cell" type="button" data-member="${esc(person.user_id)}">${avatarMarkup(person)} ${esc(person.ign)}</button>
          <span class="table-cell">${esc(person.rank)}${person.rank_points ? ` · ${Number(person.rank_points).toLocaleString()} pts` : ''}</span>
          <span class="table-cell">${esc(standingLine(person))}</span>
          <span class="table-cell">${person.online ? '<em class="ok">online</em>' : esc(timeAgo(person.last_seen_at))}</span>`;
        membersHost.appendChild(row);
      });
    }

    logHost.replaceChildren();
    if (!overview.log.length) logHost.appendChild(emptyBlock('No activity recorded yet.'));
    else {
      const heading = document.createElement('h3');
      heading.className = 'panel-sub';
      heading.textContent = 'Activity log';
      logHost.appendChild(heading);
      overview.log.forEach(entry => {
        const line = document.createElement('p');
        line.className = 'log-line';
        line.innerHTML = `<b>${esc(entry.actor)}</b> ${esc(ACTION_LABELS[entry.action] || entry.action)}
          <time>${esc(timeAgo(entry.created_at))}</time>`;
        logHost.appendChild(line);
      });
    }
  } catch (error) {
    statsHost.innerHTML = '';
    membersHost.replaceChildren(emptyBlock(explain(error)));
    logHost.replaceChildren();
  }
}

async function moderate(op, kind, id, button) {
  button.disabled = true;
  try {
    await api.moderate({ op, kind, id });
    toast(op === 'approve' ? 'Approved — it is live in the feed.' : 'Deleted.');
    await Promise.all([loadPosts({ reset: true }), loadStats(), loadTeams(), loadLeaderboard()]);
    paintRoute();
    renderModeration();
  } catch (error) {
    toast(explain(error), true);
    renderModeration();
  } finally {
    button.disabled = false;
  }
}

function renderChips() {
  const host = $('categoryChips');
  if (host.childElementCount) return;
  CATEGORIES.forEach(category => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.textContent = category;
    chip.setAttribute('aria-pressed', String(category === state.category));
    chip.addEventListener('click', () => {
      state.category = category;
      host.querySelectorAll('.chip').forEach(c => c.setAttribute('aria-pressed', String(c.textContent === category)));
    });
    host.appendChild(chip);
  });
}

/* ---------------- members ---------------- */
function memberCardMarkup(person) {
  return `
    <span class="member-card-top">
      ${avatarMarkup(person, 'lg')}
      <span class="online-dot${person.online ? ' is-online' : ''}" title="${person.online ? 'online now' : 'seen ' + timeAgo(person.last_seen_at)}"></span>
    </span>
    <b class="member-name">${esc(person.ign)}</b>
    <span class="badge pink">${esc(person.rank)}${person.rank_points ? ` · ${Number(person.rank_points).toLocaleString()}` : ''}</span>
    <span class="member-sub">${esc(roleLine(person))}</span>
    <span class="member-sub">${esc(standingLine(person))}</span>
    ${person.clan_main || person.community_main ? `
      <span class="member-affil">
        ${person.clan_main ? `<i>clan: ${esc(person.clan_main)}${person.clan_second ? ` · ${esc(person.clan_second)}` : ''}</i>` : ''}
        ${person.community_main ? `<i>commu: ${esc(person.community_main)}${person.community_second ? ` · ${esc(person.community_second)}` : ''}</i>` : ''}
      </span>` : ''}
    <span class="member-hearts">${HEART}<b>${person.hearts}</b></span>`;
}

function renderMembers() {
  const host = $('memberGrid');
  const needle = state.memberSearch.trim().toLowerCase();
  const list = state.members.filter(person => !needle || person.ign.toLowerCase().includes(needle));
  const online = state.members.filter(person => person.online);
  $('membersCount').textContent = `${state.members.length} member${state.members.length === 1 ? '' : 's'}`;
  $('onlinePill').textContent = `${online.length} online now`;
  host.replaceChildren();
  if (!list.length) {
    host.appendChild(emptyBlock(state.members.length
      ? 'No member matches that nickname.'
      : 'No one has made an account yet. Create one from the Sign in button, and they will show up here.'));
    return;
  }
  list.forEach(person => {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'card member-card';
    card.dataset.member = person.user_id;
    card.innerHTML = memberCardMarkup(person);
    host.appendChild(card);
  });
}

// The card the user asked for: face, IGN, member or executive, and the two groups they belong to.
async function openMemberDialog(userId) {
  const dialog = $('memberDialog');
  const body = $('memberDialogBody');
  $('memberDialogTitle').textContent = 'Member profile';
  body.replaceChildren(skeletonBlock(1));
  dialog.showModal();
  try {
    const card = await api.memberCard(userId);
    const person = card.profile;
    $('memberDialogTitle').textContent = person.ign;
    body.innerHTML = `
      <div class="member-hero">
        ${avatarMarkup(person, 'xl')}
        <div>
          <h3 class="member-ign">${esc(person.ign)}</h3>
          <p class="member-tag${person.online ? ' is-online' : ''}">${person.online ? 'Online now' : `Seen ${esc(timeAgo(person.last_seen_at))}`}</p>
          <p class="member-stance">${esc(standingLine(person))}</p>
        </div>
      </div>
      <div class="member-facts">
        <div><b>${esc(person.rank)}</b><small>rank${person.rank_points ? ` · ${Number(person.rank_points).toLocaleString()} pts` : ' · no points yet'}</small></div>
        <div><b>${esc(person.main_mode || '—')}</b><small>main mode</small></div>
        <div><b>${esc(person.role_label || 'no role yet')}</b><small>${esc(person.main_mode === 'Battle Royale' ? 'class' : 'role')}</small></div>
        ${person.standing === 'executive' ? `<div><b>${esc(person.exec_position || '—')}</b><small>position in the clan</small></div>` : ''}
        <div><b>${card.hearts}</b><small>hearts received</small></div>
        <div><b>${card.posts}</b><small>posts published</small></div>
      </div>
      <div class="member-groups">
        <p><b>Clan</b> ${esc(person.clan_main || '—')}${person.clan_second ? `<span class="second">second: ${esc(person.clan_second)}</span>` : ''}</p>
        <p><b>Community</b> ${esc(person.community_main || '—')}${person.community_second ? `<span class="second">second: ${esc(person.community_second)}</span>` : ''}</p>
      </div>
      ${card.squads.length ? `
        <p class="field-hint">Squads</p>
        <div class="chip-row">
          ${card.squads.map(squad => `<button class="chip" type="button" data-team="${esc(squad.id)}">${esc(squad.logo)} ${esc(squad.name)}</button>`).join('')}
        </div>` : '<p class="field-hint">Not on any squad roster yet.</p>'}
      <div class="member-heart-row">
        <button class="btn btn-primary btn-sm" type="button" data-heart="${esc(person.user_id)}">
          ${HEART}<span>Heart${card.myTaps ? ` · yours ${card.myTaps}` : ''}</span>
        </button>
        <b id="memberHeartCount">${card.hearts}</b>
      </div>
      ${person.user_id === state.myUserId ? '<p class="field-hint">This is you. Edit it on the Profile page.</p>' : ''}`;
  } catch (error) {
    body.replaceChildren(emptyBlock(explain(error)));
  }
}

/* ---------------- leaderboard ---------------- */
function renderLeaderboard() {
  const host = $('rankList');
  host.replaceChildren();
  if (!state.leaderboard.length) {
    host.appendChild(emptyBlock('Nobody has saved a profile with points yet, so the ladder is empty. Set your rank on the Profile page.'));
    $('ranksCount').textContent = '';
    return;
  }
  $('ranksCount').textContent = `${state.leaderboard.length} ranked members`;
  const head = document.createElement('div');
  head.className = 'table-head rank-head';
  head.innerHTML = '<span>#</span><span>Member</span><span>Tier</span><span>Points</span><span>Role</span>';
  host.appendChild(head);
  state.leaderboard.forEach(entry => {
    const row = document.createElement('div');
    row.className = 'table-row rank-row';
    row.innerHTML = `
      <span class="table-cell place">${entry.place}</span>
      <button class="link-like table-cell" type="button" data-member="${esc(entry.user_id)}">
        ${avatarMarkup(entry)} ${esc(entry.ign)}
      </button>
      <span class="table-cell">${esc(entry.rank)}</span>
      <span class="table-cell points">${entry.rank_points ? Number(entry.rank_points).toLocaleString() : '—'}</span>
      <span class="table-cell">${esc(entry.role_label || entry.main_mode || '—')}</span>`;
    host.appendChild(row);
  });
}

/* ---------------- squads ---------------- */
function renderTeamGrid() {
  const modes = [...new Set(state.teams.map(t => t.game_mode).filter(Boolean))];
  const filter = $('teamModeFilter');
  if (filter.options.length === 1) {
    modes.forEach(mode => {
      const option = document.createElement('option');
      option.value = mode;
      option.textContent = mode;
      filter.appendChild(option);
    });
  }

  const needle = state.teamSearch.trim().toLowerCase();
  const list = state.teams.filter(team => {
    const matchesMode = !state.teamMode || team.game_mode === state.teamMode;
    const haystack = `${team.name} ${team.region} ${team.game_mode} ${team.description}`.toLowerCase();
    return matchesMode && (!needle || haystack.includes(needle));
  });

  $('teamsCount').textContent = `${list.length} of ${state.teams.length} squads`;
  const host = $('teamGrid');
  host.replaceChildren();
  if (!list.length) host.appendChild(emptyBlock(state.teams.length ? 'No squad matches that search.' : squadsEmptyCopy()));
  else list.forEach(team => host.appendChild(teamCard(team)));
}

function renderCaptainBoard() {
  const host = $('captainGrid');
  host.replaceChildren();
  if (!state.teams.length) { host.appendChild(emptyBlock(squadsEmptyCopy())); return; }
  state.teams.forEach(team => host.appendChild(teamCard(team)));
}

function renderTeamDetail(teamId) {
  const team = state.teams.find(t => t.id === teamId);
  const host = $('teamDetail');
  if (!team) {
    host.replaceChildren();
    host.appendChild(emptyBlock('That squad could not be found.'));
    return;
  }
  const recruiting = team.status === 'recruiting';
  const roster = team.members;
  const applicants = team.applicants || [];
  const slots = Math.max(team.slot_count, roster.length);
  const openSlots = Math.max(0, slots - roster.length);
  const manages = canCaptain(team);
  const removable = roster.filter(entry => entry.id);
  const candidates = [...roster, ...applicants].filter(entry => entry.user_id);
  const isCaptainHere = Boolean(state.myUserId) && team.captain_user_id === state.myUserId;
  const iAmIn = roster.some(entry => entry.user_id === state.myUserId);
  const myRank = state.profile?.rank || 'Unranked';
  const qualifies = RANK_TIERS.indexOf(myRank) >= RANK_TIERS.indexOf(team.required_rank);
  const currentCaptainName = team.captain_nick
    || [...roster, ...applicants].find(entry => entry.user_id === team.captain_user_id)?.name
    || 'an account no longer on this roster';

  host.innerHTML = `
    <div class="banner"></div>
    <div class="panel-head">
      <span class="avatar" aria-hidden="true">${esc(team.logo)}</span>
      <div class="panel-head-text">
        <h2 id="teamDetailName">${esc(team.name)}</h2>
        <p>${team.captain_nick ? `Captain: <strong style="color:var(--text)">${esc(team.captain_nick)}</strong>` : `Led by ${esc(team.leader)}`}</p>
      </div>
      <span class="badge ${recruiting ? 'ok' : 'warn'}">${recruiting ? 'Recruiting' : 'Full roster'}</span>
    </div>
    <div class="panel-body">
      <div class="panel-grid">
        <section>
          <h3>About</h3>
          <p>${esc(team.description || 'This squad has not written a description yet.')}</p>
        </section>
        <section>
          <h3>Looking for</h3>
          <p>${esc(team.game_mode)} · ${esc(team.region)}<br>Minimum rank: <strong style="color:var(--text)">${esc(team.required_rank)}</strong><br>
          Open slots: <strong style="color:var(--text)">${openSlots}</strong> of ${slots}</p>
        </section>
      </div>
      <div class="divider"></div>
      <h3 class="panel-sub">Roster</h3>
      <div class="roster">
        ${Array.from({ length: slots }, (_, i) => {
          const entry = roster[i];
          if (!entry) return '<div class="slot open"><span class="avatar" aria-hidden="true">+</span><p><b>Open slot</b><small>unclaimed</small></p></div>';
          const label = team.captain_user_id && entry.user_id === team.captain_user_id ? 'Captain' : entry.role;
          return `
            <div class="slot">
              <button class="avatar-btn" type="button" ${entry.user_id ? `data-member="${esc(entry.user_id)}"` : 'disabled'}>
                ${avatarMarkup(entry)}
              </button>
              <p>${entry.user_id
                ? `<button class="link-like name-link" type="button" data-member="${esc(entry.user_id)}">${esc(entry.name)}</button>`
                : esc(entry.name)}<small>${esc(label)}</small></p>
            </div>`;
        }).join('')}
      </div>
      <div class="divider"></div>
      <button class="btn btn-primary btn-block" type="button" data-join="${esc(team.id)}" ${recruiting ? '' : 'disabled'}>
        ${recruiting ? 'Request a join slot' : 'Roster is full'}
      </button>
      <p class="field-hint">${recruiting
        ? `${isSignedIn()
          ? (qualifies
            ? `You meet the ${esc(team.required_rank)} minimum. This squad’s captain decides who gets in${isCaptainHere ? ' — that is you' : ''}.`
            : `This squad needs ${esc(team.required_rank)} and your profile says ${esc(myRank)}. Set your real rank on the Profile page to apply.`)
          : 'Sign in with your own account to apply — the squad needs to know who is asking.'}
          ${iAmIn ? 'You are already on this roster.' : ''}`
        : 'This squad is not taking applications right now.'}</p>
      ${iAmIn ? `
        <button class="btn btn-ghost btn-block" type="button" data-leave="${esc(team.id)}">Leave this squad</button>
        <p class="field-hint">Leaving is your own decision — no captain or admin needed, and it only touches your row.</p>` : ''}
      ${manages ? `
        <div class="divider"></div>
        <h3 class="panel-sub">Roster decisions${state.isAdmin && !isCaptainHere ? ' (admin)' : ''}</h3>
        <p class="field-hint">Only ${team.captain_nick ? esc(team.captain_nick) : 'this squad’s captain'} and the site admin can change this roster. Another squad’s captain sees none of these controls.</p>
        ${applicants.length ? applicants.map(entry => `
          <div class="queue-item">
            <div class="queue-text">
              <p class="queue-byline">${avatarMarkup(entry)} <b>${esc(entry.name)}</b> · ${esc(entry.rank || 'rank not set')} · applied ${esc(timeAgo(entry.created_at))}${entry.user_id ? '' : ' · no account linked'}</p>
            </div>
            <div class="queue-actions">
              <button class="btn btn-primary btn-sm" type="button" data-decide="accepted:${esc(entry.id)}">Accept</button>
              <button class="btn btn-ghost btn-sm" type="button" data-decide="rejected:${esc(entry.id)}">Decline</button>
            </div>
          </div>`).join('') : '<p class="field-hint">No applications are waiting.</p>'}
        ${removable.length ? `
          <p class="field-hint" style="margin-top:1rem">Members you can take off the roster:</p>
          ${removable.map(entry => `
          <div class="queue-item">
            <div class="queue-text"><p class="queue-byline">${avatarMarkup(entry)} <b>${esc(entry.name)}</b> · member</p></div>
            <div class="queue-actions">
              <button class="btn btn-ghost btn-sm" type="button" data-decide="rejected:${esc(entry.id)}">Remove</button>
            </div>
          </div>`).join('')}` : ''}` : ''}
      ${state.isAdmin ? `
        <div class="divider"></div>
        <h3 class="panel-sub">Assign the captain</h3>
        <p class="field-hint">Only you can hand a squad to someone. A captain manages that one roster — applications, members — and nothing else. They need an account of their own, which they get from “Create an account” in the sign-in dialog.</p>
        ${team.captain_user_id ? `
        <div class="queue-item">
          <div class="queue-text"><p class="queue-byline"><b>${esc(currentCaptainName)}</b> · holds the captain role now</p></div>
          <div class="queue-actions"><button class="btn btn-ghost btn-sm" type="button" data-captain-clear="${esc(team.id)}">Remove as captain</button></div>
        </div>` : ''}
        ${candidates.length ? candidates.map(entry => {
          const current = team.captain_user_id === entry.user_id;
          return `
          <div class="queue-item">
            <div class="queue-text"><p class="queue-byline">${avatarMarkup(entry)} <b>${esc(entry.name)}</b> · ${esc(entry.role)}${current ? ' · current captain' : ''}</p></div>
            <div class="queue-actions">
              <button class="btn ${current ? 'btn-ghost' : 'btn-primary'} btn-sm" type="button"
                data-captain-user="${esc(entry.user_id)}" data-captain-team="${esc(team.id)}" data-captain-nick="${esc(entry.name)}"
                ${current ? 'disabled' : ''}>${current ? 'Current captain' : 'Make captain'}</button>
            </div>
          </div>`;
        }).join('') : '<p class="field-hint">Nobody on this roster or in its applications has a linked account yet.</p>'}

        <div class="divider"></div>
        <h3 class="panel-sub">Delete this squad</h3>
        <p class="field-hint">Removes the squad and its applications. This cannot be undone from the site.</p>
        <button class="btn btn-ghost btn-block danger" type="button" data-delete-team="${esc(team.id)}">Remove team</button>` : ''}
    </div>`;
}

/* ---------------- profile ---------------- */
function renderProfile() {
  const host = $('profilePanel');
  if (!isSignedIn()) {
    host.innerHTML = `
      <div class="panel-body">
        <h3>Sign in to use your profile</h3>
        <p>Everything on this site — posts, comments, hearts, squad applications — is filed under a real account now, so a rename follows you everywhere and the leaderboard is honest.</p>
        <button class="btn btn-primary" type="button" data-open-auth>Sign in or create an account</button>
      </div>`;
    return;
  }
  const p = state.profile;
  if (!p) {
    host.innerHTML = `
      <div class="panel-body">
        <h3>Set up your profile</h3>
        <p>Your IGN is the name that shows on every post you make, and it is what the Members page and the leaderboard list.</p>
        <div id="profileEditorMount"></div>
      </div>`;
    $('profileEditorMount').appendChild(profileFormMarkup(null));
    attachProfileForm($('profileEditorMount').firstChild);
    return;
  }
  host.innerHTML = `
    <div class="banner"></div>
    <div class="panel-head">
      ${avatarMarkup(p, 'xl')}
      <div class="panel-head-text">
        <h2 id="profile-name">${esc(p.ign)}</h2>
        <p>${esc(rankLine(p))} · ${esc(roleLine(p))}</p>
        <p class="member-tag">${esc(standingLine(p))}</p>
      </div>
      <button class="btn btn-ghost btn-sm" type="button" id="editProfile">Edit profile</button>
    </div>
    <div class="panel-body">
      <div class="panel-grid">
        <section>
          <h3>Groups</h3>
          <div class="roster" style="grid-template-columns:1fr">
            <div class="slot"><p><b>${esc(p.clan_main || 'No main clan')}</b><small>main clan${p.clan_second ? ' · second: ' + esc(p.clan_second) : ''}</small></p></div>
            <div class="slot"><p><b>${esc(p.community_main || 'No main community')}</b><small>main community${p.community_second ? ' · second: ' + esc(p.community_second) : ''}</small></p></div>
            <div class="slot"><p><b>${esc(p.main_mode || 'No main mode')}</b><small>${esc(p.role_label || 'no role chosen')}</small></p></div>
          </div>
        </section>
        <section>
          <h3>This account</h3>
          <p>Signed in as <strong style="color:var(--text)">${esc(p.ign)}</strong>.<br>
          ${state.isAdmin ? 'This account is a <strong style="color:var(--text)">site admin</strong>: it approves posts, publishes squads and names captains.' : 'This account is a member.'}
          ${p.last_seen_at ? `<br>Last seen ${esc(timeAgo(p.last_seen_at))}.` : ''}</p>
        </section>
      </div>
      <div class="divider"></div>
      <h3 class="panel-sub">Ranked ladder</h3>
      <div class="ladder">
        ${RANK_TIERS.map(tier => `
          <div class="ladder-row${tier === p.rank ? ' is-current' : ''}">
            <b>${esc(tier)}</b>
            <span>${esc(RANK_RP[tier] || '')}</span>
          </div>`).join('')}
      </div>
      <div class="divider"></div>
      <h3 class="panel-sub">Your posts</h3>
      <div id="myPosts" style="margin-top:.75rem"></div>
    </div>`;

  $('editProfile').addEventListener('click', openProfileEditor);
  loadMyPosts(host.querySelector('#myPosts'));
}

async function loadMyPosts(container) {
  container.replaceChildren(skeletonBlock(1));
  try {
    const result = await api.posts({ mine: true, limit: 10 });
    const mine = result.posts || [];
    container.replaceChildren();
    if (!mine.length) { container.appendChild(emptyBlock('You have not posted yet.')); return; }
    mine.forEach(post => container.appendChild(postNode(post)));
  } catch {
    container.replaceChildren();
    container.appendChild(emptyBlock('Could not load your posts.'));
  }
}

function selectMarkup(id, options, selected, placeholder = '') {
  const rows = placeholder ? `<option value="">${esc(placeholder)}</option>` : '';
  return `<select class="input select" id="${id}">${rows}${options
    .map(option => `<option${option === selected ? ' selected' : ''}>${esc(option)}</option>`).join('')}</select>`;
}

function profileFormMarkup(p) {
  const wrapper = document.createElement('div');
  wrapper.innerHTML = `
    <form class="profile-form" id="profileForm">
      <div class="field">
        <label for="pfAvatar">Face (your avatar)</label>
        <div class="avatar-picker">
          <span id="pfAvatarPreview">${avatarMarkup(p || {}, 'xl')}</span>
          <label class="file-btn" for="pfAvatarInput">
            <input class="sr-only" type="file" id="pfAvatarInput" accept="image/png,image/jpeg,image/webp">
            Choose picture
          </label>
          <button class="btn btn-ghost btn-sm" type="button" id="pfAvatarClear" ${p?.avatar_url ? '' : 'hidden'}>Remove</button>
        </div>
        <p class="field-hint" id="pfAvatarHint">A square picture works best. It is resized in your browser before uploading, so the site stays inside the free storage limit.</p>
      </div>
      <div class="field">
        <label for="pfIgn">IGN (nickname)</label>
        <input class="input" id="pfIgn" maxlength="24" required value="${esc(p?.ign || '')}" placeholder="your in-game name">
        <p class="field-hint">This is the name on every post and comment you make. Change it here and the feed changes with it.</p>
      </div>
      <div class="field-row">
        <div class="field">
          <label for="pfRank">Current rank tier</label>
          ${selectMarkup('pfRank', RANK_TIERS, p?.rank || 'Unranked')}
          <p class="field-hint" id="rankHint"></p>
        </div>
        <div class="field">
          <label for="pfPoints">Ranked points</label>
          <input class="input" id="pfPoints" type="number" min="0" max="1000000" step="1"
            value="${p?.rank_points ?? ''}" placeholder="e.g. 8420">
          <p class="field-hint">Needed for Legendary — it is what the leaderboard sorts by.</p>
        </div>
      </div>
      <div class="field-row">
        <div class="field">
          <label for="pfMode">Main mode</label>
          ${selectMarkup('pfMode', ['Multiplayer', 'Battle Royale'], p?.main_mode, 'Choose one')}
        </div>
        <div class="field">
          <label for="pfRole" id="pfRoleLabel">Role</label>
          <span id="pfRoleHost">${selectMarkup('pfRole', MP_ROLES, p?.role_label, 'Choose your role')}</span>
        </div>
      </div>
      <div class="field-row">
        <div class="field">
          <label for="pfStanding">Standing</label>
          ${selectMarkup('pfStanding', ['member', 'executive'], p?.standing || 'member')}
        </div>
        <div class="field" id="pfExecField" ${p?.standing === 'executive' ? '' : 'hidden'}>
          <label for="pfExec">Position in the clan</label>
          ${selectMarkup('pfExec', EXEC_POSITIONS, p?.exec_position, 'Choose a position')}
        </div>
      </div>
      <div class="field-row">
        <div class="field">
          <label for="pfClanMain">Main clan</label>
          <input class="input" id="pfClanMain" maxlength="40" value="${esc(p?.clan_main || '')}" placeholder="clan name">
        </div>
        <div class="field">
          <label for="pfClanSecond">Second clan</label>
          <input class="input" id="pfClanSecond" maxlength="40" value="${esc(p?.clan_second || '')}" placeholder="optional">
        </div>
      </div>
      <div class="field-row">
        <div class="field">
          <label for="pfCommMain">Main community</label>
          <input class="input" id="pfCommMain" maxlength="40" value="${esc(p?.community_main || '')}" placeholder="community name">
        </div>
        <div class="field">
          <label for="pfCommSecond">Second community</label>
          <input class="input" id="pfCommSecond" maxlength="40" value="${esc(p?.community_second || '')}" placeholder="optional">
        </div>
      </div>
      <div style="display:flex;gap:.6rem;justify-content:flex-end">
        <button class="btn btn-ghost" type="button" id="pfCancel">Cancel</button>
        <button class="btn btn-primary" type="submit" id="pfSubmit">Save profile</button>
      </div>
    </form>`;
  return wrapper;
}

// The mode decides which list the role select offers, which is the same rule the database CHECK
// applies: a BR class cannot be saved on a Multiplayer profile and vice versa.
function syncRoleSelect(mode, selected) {
  const host = document.getElementById('pfRoleHost');
  const label = document.getElementById('pfRoleLabel');
  if (!host) return;
  const isBR = mode === 'Battle Royale';
  const options = isBR ? BR_CLASSES : MP_ROLES;
  const keep = options.includes(selected) ? selected : '';
  label.textContent = isBR ? 'Class' : 'Role';
  host.innerHTML = selectMarkup('pfRole', options, keep, isBR ? 'Choose your class' : 'Choose your role');
}

function attachProfileForm(form) {
  let avatarUrl = state.profile?.avatar_url || null;
  let pendingAvatar = null;

  const rankSelect = form.querySelector('#pfRank');
  const hint = form.querySelector('#rankHint');
  const syncRankHint = () => {
    const tier = rankSelect.value;
    hint.textContent = `${tier}: ${RANK_RP[tier] || ''}. ${tier === 'Legendary' ? 'Points are required.' : 'Points are optional unless you want the leaderboard.'}`;
  };
  rankSelect.addEventListener('change', syncRankHint);
  syncRankHint();

  const modeSelect = form.querySelector('#pfMode');
  const syncMode = () => syncRoleSelect(modeSelect.value, form.querySelector('#pfRole')?.value);
  modeSelect.addEventListener('change', syncMode);
  syncMode();

  const standingSelect = form.querySelector('#pfStanding');
  const execField = form.querySelector('#pfExecField');
  const syncStanding = () => { execField.hidden = standingSelect.value !== 'executive'; };
  standingSelect.addEventListener('change', syncStanding);
  syncStanding();

  const preview = form.querySelector('#pfAvatarPreview');
  const clearButton = form.querySelector('#pfAvatarClear');
  const paintPreview = (url) => {
    preview.innerHTML = avatarMarkup({ avatar_url: url, ign: form.querySelector('#pfIgn').value || 'You' }, 'xl');
    clearButton.hidden = !url;
  };
  form.querySelector('#pfAvatarInput').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      const hintNode = form.querySelector('#pfAvatarHint');
      hintNode.textContent = 'Resizing your picture…';
      const blob = await toJpeg(file, AVATAR_EDGE, 0.85);
      pendingAvatar = blob;
      paintPreview(URL.createObjectURL(blob));
      hintNode.textContent = 'Saved with the form — the picture is uploaded when you press Save profile.';
    } catch (error) {
      toast(explain(error), true);
    }
  });
  clearButton.addEventListener('click', () => {
    avatarUrl = null;
    pendingAvatar = null;
    paintPreview(null);
  });
  form.querySelector('#pfIgn').addEventListener('input', () => {
    if (!pendingAvatar) paintPreview(avatarUrl);
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = form.querySelector('#pfSubmit');
    button.disabled = true;
    button.textContent = 'Saving…';
    try {
      if (pendingAvatar) {
        avatarUrl = await api.uploadImage('avatars', pendingAvatar);
        pendingAvatar = null;
      }
      const saved = await api.saveProfile({
        ign: form.querySelector('#pfIgn').value,
        rank: rankSelect.value,
        rankPoints: form.querySelector('#pfPoints').value,
        mainMode: modeSelect.value,
        roleLabel: form.querySelector('#pfRole')?.value,
        standing: standingSelect.value,
        execPosition: form.querySelector('#pfExec')?.value,
        clanMain: form.querySelector('#pfClanMain').value,
        clanSecond: form.querySelector('#pfClanSecond').value,
        communityMain: form.querySelector('#pfCommMain').value,
        communitySecond: form.querySelector('#pfCommSecond').value,
        avatarUrl,
      });
      state.profile = saved;
      state.myUserId = saved?.user_id || state.myUserId;
      paintHeader();
      await Promise.all([loadMembers(), loadLeaderboard()]);
      renderProfile();
      toast('Profile saved. Your name is now this everywhere on the site.');
    } catch (error) {
      toast(explain(error), true);
      button.disabled = false;
      button.textContent = 'Save profile';
    }
  });
  form.querySelector('#pfCancel')?.addEventListener('click', () => renderProfile());
}

function openProfileEditor() {
  const host = $('profilePanel');
  const form = profileFormMarkup(state.profile);
  host.appendChild(form);
  attachProfileForm(form);
  form.querySelector('#pfIgn').focus();
  form.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* ---------------- image pipeline ---------------- */
// Decode, downscale, re-encode as JPEG. Doing this in the browser is the only reason a free 1 GB
// bucket lasts: a raw phone screenshot is several megabytes, the resized one is a couple hundred KB.
async function toJpeg(file, maxEdge, quality) {
  if (!file.type.startsWith('image/')) throw new Error('image_failed');
  if (file.size > MAX_UPLOAD_BYTES) throw new Error('image_too_large');
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error('image_failed');
  }
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();
  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
  if (!blob) throw new Error('image_failed');
  return blob;
}

/* ---------------- data loading ---------------- */
async function loadProfileState() {
  state.profile = await myProfile();
}

async function loadTeams() {
  try { state.teams = await api.teams(); }
  catch { state.teams = []; if (!state.offline) toast('Squads could not be loaded.', true); }
}

async function loadPosts({ reset = true } = {}) {
  const offset = reset ? 0 : state.nextOffset;
  const result = await api.posts({ offset, limit: 20 });
  const incoming = result.posts || [];
  state.posts = reset ? incoming : [...state.posts, ...incoming];
  state.hasMore = Boolean(result.hasMore);
  state.nextOffset = Number(result.nextOffset) || incoming.length;
}

async function loadStats() {
  try { state.stats = await api.stats(); }
  catch { state.stats = null; }
}

async function loadMembers() {
  try { state.members = await api.members(); }
  catch { state.members = []; }
}

async function loadLeaderboard() {
  try { state.leaderboard = await api.leaderboard(); }
  catch { state.leaderboard = []; }
}

async function refreshAll() {
  await Promise.all([loadTeams(), loadStats(), loadMembers(), loadLeaderboard()]);
  try { await loadPosts({ reset: true }); }
  catch { if (!state.offline) toast('The feed could not be loaded.', true); }
  paintRoute();
}

/* ---------------- actions ---------------- */
async function publishPost() {
  const button = $('postSubmit');
  const text = $('postText').value.trim();
  const video = $('postVideo').value.trim();
  if (text.length < 3 && !state.draftImage && !video) { toast('Write something, or add a screenshot or a clip link.', true); return false; }

  // A video link that is not YouTube is caught here as words rather than as a refused row.
  if (video && !youTubeId(video)) { toast(explain(new Error('video_not_youtube')), true); return false; }

  button.disabled = true;
  button.textContent = 'Sending…';
  try {
    const result = await api.post({
      content: text,
      category: state.category,
      imageUrl: state.draftImage,
      videoUrl: video || null,
    });
    $('postText').value = '';
    $('postVideo').value = '';
    clearDraftImage();
    updateCharCount();
    await Promise.all([loadPosts({ reset: true }), loadStats()]);
    renderFeed();
    toast(result?.status === 'approved'
      ? 'Posted to the community feed.'
      : 'Sent to the admin — it appears in the feed once approved.');
    return true;
  } catch (error) {
    toast(explain(error), true);
    return false;
  } finally {
    button.disabled = false;
    button.textContent = state.isAdmin ? 'Publish post' : 'Send for approval';
  }
}

function clearDraftImage() {
  state.draftImage = null;
  const preview = $('mediaPreview');
  preview.hidden = true;
  preview.removeAttribute('src');
  $('clearMedia').hidden = true;
  $('mediaHint').hidden = true;
}

async function attachDraftImage(file) {
  const hint = $('mediaHint');
  if (!file) return;
  state.uploading = true;
  hint.hidden = false;
  hint.textContent = 'Resizing and uploading your screenshot…';
  $('clearMedia').hidden = true;
  try {
    const blob = await toJpeg(file, POST_IMAGE_EDGE, 0.82);
    const url = await api.uploadImage('post-images', blob);
    state.draftImage = url;
    const preview = $('mediaPreview');
    preview.src = url;
    preview.alt = 'Your screenshot preview';
    preview.hidden = false;
    hint.textContent = `${Math.round(blob.size / 1024)} KB after resizing. It goes with the post.`;
    $('clearMedia').hidden = false;
  } catch (error) {
    clearDraftImage();
    toast(explain(error), true);
  } finally {
    state.uploading = false;
  }
}

async function tapPost(postId, delta) {
  if (!isSignedIn()) { toast(explain(new Error('sign_in_required')), true); return; }
  const post = state.posts.find(p => p.id === postId);
  try {
    const result = await api.tapPost(postId, delta);
    if (post) { post.taps = Number(result.taps ?? post.taps); post.my_taps = Number(result.my_taps ?? post.my_taps); }
    renderFeedOrHome();
  } catch (error) {
    toast(explain(error), true);
  }
}

async function heartMember(userId, button) {
  if (!isSignedIn()) { toast(explain(new Error('sign_in_required')), true); return; }
  button.disabled = true;
  try {
    const result = await api.heartMember(userId);
    const total = $('memberHeartCount');
    if (total) total.textContent = String(result.hearts);
    const person = state.members.find(entry => entry.user_id === userId);
    if (person) person.hearts = result.hearts;
    toast('Taptap noted.');
  } catch (error) {
    toast(explain(error), true);
  } finally {
    button.disabled = false;
  }
}

async function toggleComments(postId) {
  if (state.openComments.has(postId)) state.openComments.delete(postId);
  else {
    state.openComments.add(postId);
    state.loadingComments.add(postId);
    refreshPostNode(postId);
    try { state.commentsByPost.set(postId, await api.comments(postId)); }
    catch { state.commentsByPost.set(postId, []); }
    finally { state.loadingComments.delete(postId); }
  }
  refreshPostNode(postId);
}

async function addComment(postId, content) {
  const post = state.posts.find(p => p.id === postId);
  try {
    const result = await api.comment(postId, content);
    if (result.status === 'approved') {
      if (post) post.comments += 1;
      state.commentsByPost.set(postId, await api.comments(postId));
      refreshPostNode(postId);
      toast('Comment added.');
    } else {
      toast('Sent to the admin for approval.');
    }
    await loadStats();
  } catch (error) {
    toast(explain(error), true);
  }
}

async function withdraw(kind, id, button) {
  button.disabled = true;
  try {
    await api.withdraw(kind, id);
    toast('Pulled back from the queue.');
    await Promise.all([loadPosts({ reset: true }), loadStats()]);
    renderProfile();
    renderFeedOrHome();
  } catch (error) {
    toast(explain(error), true);
    button.disabled = false;
  }
}

function refreshPostNode(postId) {
  const post = state.posts.find(p => p.id === postId);
  if (!post) return;
  // The same post can be on screen twice -- once in the home list, once in the feed -- and only
  // one of those views is visible. Replacing just the first match redrew the hidden copy, so an
  // opened comment thread appeared to do nothing.
  const nodes = document.querySelectorAll(`[data-id="${CSS.escape(postId)}"]`);
  nodes.forEach(node => node.replaceWith(postNode(post)));
}

function renderFeedOrHome() {
  if (state.route === 'community') renderFeed();
  else if (state.route === 'home') renderHome();
}

async function joinTeam(teamId) {
  if (!isSignedIn()) { toast(explain(new Error('sign_in_required')), true); openAuthDialog(); return; }
  const button = document.querySelector(`[data-join="${CSS.escape(teamId)}"]`);
  if (button) { button.disabled = true; button.textContent = 'Sending…'; }
  try {
    const result = await api.joinTeam(teamId);
    toast(result?.duplicated ? 'You already asked to join this squad.' : 'Join request sent to the squad.');
    await loadTeams();
    renderTeamDetail(teamId);
  } catch (error) {
    toast(explain(error), true);
    if (button) { button.disabled = false; button.textContent = 'Request a join slot'; }
  }
}

async function leaveTeam(teamId, button) {
  button.disabled = true;
  try {
    await api.leaveTeam(teamId);
    toast('You left the squad. Ask again any time if you want back in.');
    await Promise.all([loadTeams(), loadStats()]);
    renderTeamDetail(teamId);
  } catch (error) {
    toast(explain(error), true);
    button.disabled = false;
  }
}

// A captain (or the admin) accepts, declines or removes one row of a squad's roster.
async function decideJoin(id, decision, button) {
  button.disabled = true;
  try {
    await api.decideJoin(id, decision);
    toast(decision === 'accepted' ? 'Accepted — they are on the roster.' : 'Taken off the roster.');
    await Promise.all([loadTeams(), loadStats(), loadMembers()]);
    paintRoute();
  } catch (error) {
    toast(explain(error), true);
    button.disabled = false;
  }
}

async function assignCaptain(teamId, userId, nickname, button) {
  button.disabled = true;
  try {
    await api.assignCaptain(teamId, userId, nickname);
    await loadTeams();
    paintRoute();
    toast(userId ? `${nickname} now runs that squad’s roster.` : 'That squad has no captain now.');
  } catch (error) {
    toast(explain(error), true);
    button.disabled = false;
  }
}

async function deleteTeam(teamId, button) {
  if (!window.confirm('Remove this squad and every application to it? This cannot be undone.')) return;
  button.disabled = true;
  try {
    const result = await api.deleteTeam(teamId);
    toast(`${result.name} removed.`);
    navigate('teams');
    await loadTeams();
    renderTeamGrid();
    renderCaptainBoard();
  } catch (error) {
    toast(explain(error), true);
    button.disabled = false;
  }
}

async function createTeam(form) {
  const data = {
    name: form.teamName.value.trim(),
    logo: form.teamTag.value.trim(),
    game_mode: form.teamMode.value,
    region: form.teamRegion.value.trim() || 'Philippines',
    required_rank: form.teamRank.value,
    description: form.teamDesc.value.trim(),
    slot_count: Number(form.teamSlots.value) || 5,
    leader: state.profile?.ign || 'Admin',
  };
  try {
    await api.createTeam(data);
    await loadTeams();
    $('createTeamDialog').close();
    form.reset();
    navigate('teams');
    renderTeamGrid();
    toast('Squad published.');
  } catch (error) {
    toast(explain(error), true);
  }
}

/* ---------------- comment composer inside panel ---------------- */
function attachCommentComposer(node, postId) {
  const panel = node.querySelector(`[data-comments-panel="${CSS.escape(postId)}"]`);
  if (!panel || panel.querySelector('form')) return;
  if (!state.isAdmin) {
    const hint = document.createElement('p');
    hint.className = 'field-hint';
    hint.textContent = 'Your comment goes to the admin for approval before anyone else sees it.';
    panel.appendChild(hint);
  }
  const form = document.createElement('form');
  form.style.cssText = 'display:flex;gap:.5rem;margin-top:.6rem';
  form.innerHTML = `<input class="input" maxlength="300" placeholder="Write a comment…" aria-label="Write a comment" required>
    <button class="btn btn-primary btn-sm" type="submit">Send</button>`;
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const input = form.querySelector('input');
    const value = input.value.trim();
    if (value.length < 2) return;
    input.value = '';
    addComment(postId, value);
  });
  panel.appendChild(form);
}

/* ---------------- wiring ---------------- */
function updateCharCount() {
  const left = MAX_POST - $('postText').value.length;
  const node = $('charLeft');
  node.textContent = `${left} characters left`;
  node.classList.toggle('low', left < 120);
}

/* ---------------- sign in / create account ---------------- */
let authMode = 'signin';
function setAuthMode(mode) {
  authMode = mode;
  const signingIn = mode === 'signin';
  $('authDialogTitle').textContent = signingIn ? 'Sign in' : 'Create an account';
  $('adminSubmit').textContent = signingIn ? 'Sign in' : 'Create account';
  $('authToggle').textContent = signingIn ? 'Create an account' : 'I already have an account';
  $('authPassword').autocomplete = signingIn ? 'current-password' : 'new-password';
  $('authIgnField').hidden = signingIn;
  $('authHint').textContent = signingIn
    ? 'Every post, comment, heart and roster change is filed under the account you sign in with. The site admin approves posts, publishes squads and names captains through this same dialog.'
    : 'Your IGN is required — it is the name the feed shows, and the Members page lists. Creating an account does not make anyone an admin.';
}

function openAuthDialog() {
  $('authEmail').value = '';
  $('authPassword').value = '';
  $('authIgn').value = '';
  setAuthMode('signin');
  $('adminDialog').showModal();
  // The field is focused after the dialog is painted, so the browser scrolls the dialog itself
  // into the middle of the screen instead of jumping the page behind it.
  requestAnimationFrame(() => $('authEmail').focus());
}

async function applySession(result) {
  state.isAdmin = Boolean(result?.admin);
  state.myUserId = result?.userId || await myUserId();
  state.profile = result?.profile ?? await myProfile();
  paintHeader();
  await refreshAll();
}

async function signOutUser() {
  await signOutAsAdmin();
  state.isAdmin = false;
  state.myUserId = null;
  state.profile = null;
  paintHeader();
  await refreshAll();
  toast('Signed out — the queue, the roster tools and the composer are hidden again.');
}

function bindEvents() {
  document.addEventListener('click', (event) => {
    const nav = event.target.closest('[data-nav]');
    if (nav) { navigate(nav.dataset.nav); return; }

    const auth = event.target.closest('[data-open-auth]');
    if (auth) { openAuthDialog(); return; }

    const member = event.target.closest('[data-member]');
    if (member) { openMemberDialog(member.dataset.member); return; }

    const team = event.target.closest('[data-team]');
    if (team) { $('memberDialog').open && $('memberDialog').close(); navigate(`teams/${team.dataset.team}`); return; }

    const tap = event.target.closest('[data-tap]');
    if (tap) { tapPost(tap.dataset.tap, 1); return; }

    const untap = event.target.closest('[data-untap]');
    if (untap) { tapPost(untap.dataset.untap, -1); return; }

    const heart = event.target.closest('[data-heart]');
    if (heart) { heartMember(heart.dataset.heart, heart); return; }

    const play = event.target.closest('[data-play]');
    if (play) {
      // The iframe only appears once it is clicked for, so no third-party script runs on page load.
      const panel = document.querySelector(`[data-video-panel="${CSS.escape(play.dataset.play)}"]`);
      panel.innerHTML = `<iframe class="post-video" src="https://www.youtube-nocookie.com/embed/${esc(play.dataset.play)}"
        title="YouTube clip" loading="lazy" allow="accelerometer; encrypted-media; picture-in-picture"
        allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe>`;
      return;
    }

    const comments = event.target.closest('[data-comments]');
    if (comments) { toggleComments(comments.dataset.comments); return; }

    const review = event.target.closest('[data-moderate]');
    if (review) {
      const [op, kind, id] = review.dataset.moderate.split(':');
      moderate(op, kind, id, review);
      return;
    }

    const drop = event.target.closest('[data-withdraw]');
    if (drop) {
      const [kind, id] = drop.dataset.withdraw.split(':');
      withdraw(kind, id, drop);
      return;
    }

    const join = event.target.closest('[data-join]');
    if (join) { joinTeam(join.dataset.join); return; }

    const leave = event.target.closest('[data-leave]');
    if (leave) { leaveTeam(leave.dataset.leave, leave); return; }

    const decide = event.target.closest('[data-decide]');
    if (decide) {
      const [decision, id] = decide.dataset.decide.split(':');
      decideJoin(id, decision, decide);
      return;
    }

    const captain = event.target.closest('[data-captain-user]');
    if (captain) {
      assignCaptain(captain.dataset.captainTeam, captain.dataset.captainUser, captain.dataset.captainNick, captain);
      return;
    }

    const clearCaptain = event.target.closest('[data-captain-clear]');
    if (clearCaptain) {
      assignCaptain(clearCaptain.dataset.captainClear, null, null, clearCaptain);
      return;
    }

    const teamDelete = event.target.closest('[data-delete-team]');
    if (teamDelete) { deleteTeam(teamDelete.dataset.deleteTeam, teamDelete); return; }

    if (event.target.closest('[data-close-dialog]')) $('createTeamDialog').close();
    if (event.target.closest('[data-close-member]')) $('memberDialog').close();
  });

  $('postForm').addEventListener('submit', (event) => {
    event.preventDefault();
    if (state.uploading) { toast('Your screenshot is still uploading.', true); return; }
    publishPost();
  });

  $('postText').addEventListener('input', updateCharCount);
  $('postImage').addEventListener('change', (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    attachDraftImage(file);
  });
  $('clearMedia').addEventListener('click', clearDraftImage);

  $('feedSearch').addEventListener('input', (event) => { state.search = event.target.value; renderFeed(); });
  $('feedSort').addEventListener('change', (event) => { state.sort = event.target.value; renderFeed(); });
  $('teamSearch').addEventListener('input', (event) => { state.teamSearch = event.target.value; renderTeamGrid(); });
  $('teamModeFilter').addEventListener('change', (event) => { state.teamMode = event.target.value; renderTeamGrid(); });
  $('memberSearch').addEventListener('input', (event) => { state.memberSearch = event.target.value; renderMembers(); });
  $('adminSearch').addEventListener('input', (event) => {
    state.adminSearch = event.target.value;
    renderAdminConsole();
  });

  $('openCreateTeam').addEventListener('click', () => {
    $('createTeamDialog').showModal();
    requestAnimationFrame(() => $('teamName').focus());
  });
  $('createTeamForm').addEventListener('submit', (event) => { event.preventDefault(); createTeam(event.target); });

  $('loadMore').addEventListener('click', async (event) => {
    event.target.disabled = true;
    try { await loadPosts({ reset: false }); renderFeed(); }
    catch { toast('Could not load more posts.', true); }
    finally { event.target.disabled = false; }
  });

  // A member's own card, from the header or the composer avatar.
  $('headerUser').addEventListener('click', () => {
    if (isSignedIn()) navigate('profile');
    else openAuthDialog();
  });
  $('composerAvatarBtn').addEventListener('click', () => navigate('profile'));

  $('adminButton').addEventListener('click', async () => {
    if (state.isAdmin || isSignedIn()) { await signOutUser(); return; }
    openAuthDialog();
  });
  $('authToggle').addEventListener('click', () => setAuthMode(authMode === 'signin' ? 'signup' : 'signin'));
  $('adminForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const email = $('authEmail').value.trim();
    const password = $('authPassword').value;
    if (!email || !password) { toast('Enter your email and password.', true); return; }
    if (authMode === 'signup' && password.length < 6) { toast('A password needs at least 6 characters.', true); return; }
    const ign = $('authIgn').value.trim();
    if (authMode === 'signup' && ign.length < 2) { toast('Type your IGN — it is the name on your posts.', true); return; }
    const button = $('adminSubmit');
    const label = button.textContent;
    button.disabled = true;
    button.textContent = authMode === 'signin' ? 'Signing in…' : 'Creating…';
    try {
      const result = authMode === 'signin'
        ? await signIn(email, password)
        : await signUpAccount(email, password, ign);
      $('adminDialog').close();
      $('authPassword').value = '';
      await applySession(result);
      if (authMode === 'signin' && !result.profile) {
        navigate('profile');
        toast('Welcome back. Save your profile once and your IGN goes on everything you post.');
      } else {
        toast(result.admin
          ? 'Signed in as the admin — you can publish, approve, name captains and read the activity log.'
          : 'Signed in. Post, comment, tap and run the rosters of squads you captain.');
      }
    } catch (error) {
      toast(explain(error), true);
    } finally {
      button.disabled = false;
      button.textContent = label;
    }
  });
  document.querySelectorAll('[data-close-admin]').forEach(node =>
    node.addEventListener('click', () => $('adminDialog').close()));

  window.addEventListener('hashchange', paintRoute);
}

/* ---------------- boot ---------------- */
async function boot() {
  $('footerYear').textContent = String(new Date().getFullYear());
  state.myUserId = await myUserId();
  state.isAdmin = await hasAdminSession();
  if (state.myUserId) await loadProfileState();
  paintHeader();
  updateCharCount();
  bindEvents();

  $('homeStats').innerHTML = '<div class="skeleton" style="min-height:80px"></div>'.repeat(4);
  try { await api.health(); }
  catch { state.offline = true; }
  paintAdminUi();
  await refreshAll();

  // Keep the shared feed reasonably fresh without spamming the server, and keep this account
  // counted as online while the tab is actually being used.
  setInterval(async () => {
    if (document.hidden) return;
    try {
      await Promise.all([loadPosts({ reset: true }), loadTeams(), loadStats(), loadMembers(), loadLeaderboard()]);
      if (isSignedIn()) await api.beat();
      renderFeedOrHome();
      if (state.route === 'home') renderHome();
      if (state.route === 'teams') renderTeamGrid();
      if (state.route === 'team') renderTeamDetail(currentRoute().id);
      if (state.route === 'members') renderMembers();
      if (state.route === 'ranks') renderLeaderboard();
      if (state.isAdmin) {
        renderModeration();
        if (state.route === 'approval') { renderCaptainBoard(); renderAdminConsole(); }
      }
    } catch { /* keep current view */ }
  }, 60000);
}

boot();
