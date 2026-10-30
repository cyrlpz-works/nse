import { api, getVisitorId, getAdminKey, setAdminKey } from './api.js';

const CATEGORIES = ['General', 'Multiplayer', 'Battle Royale', 'Ranked', 'Loadouts', 'Tips & Guides', 'Looking for Team', 'Team Recruitment'];

// Call of Duty Mobile ranked ladder. `divisions: true` tiers carry I – V.
const RANK_LADDER = [
  { tier: 'Unranked', divisions: false, rp: 'not placed yet' },
  { tier: 'Rookie', divisions: true, rp: '0 – 1,000' },
  { tier: 'Veteran', divisions: true, rp: '1,001 – 2,000' },
  { tier: 'Elite', divisions: true, rp: '2,001 – 3,000' },
  { tier: 'Pro', divisions: true, rp: '3,001 – 4,500' },
  { tier: 'Master', divisions: false, rp: '4,501 – 6,000' },
  { tier: 'Grand Master', divisions: false, rp: '6,001 – 8,000' },
  { tier: 'Legendary', divisions: false, rp: '8,001+' },
];
const RANK_TIERS = RANK_LADDER.map(entry => entry.tier);
const DIVISIONS = ['I', 'II', 'III', 'IV', 'V'];
const tierInfo = (tier) => RANK_LADDER.find(entry => entry.tier === tier) || RANK_LADDER[0];
const MAX_POST = 1200;

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
  openComments: new Set(),
  commentsByPost: new Map(),
  loadingComments: new Set(),
  offline: false,
  isAdmin: false,
};

/* ---------------- profile (device-local) ---------------- */
const DEFAULT_PROFILE = {
  nickname: '', rank: 'Unranked', division: '', mode: 'Multiplayer', weapon: 'AR',
  team: '', role: 'Solo', bio: 'Competitive player • always grinding.', achievements: [],
};

function loadProfile() {
  try {
    const raw = JSON.parse(localStorage.getItem('jt.profile') || '{}');
    return { ...DEFAULT_PROFILE, ...raw };
  } catch { return { ...DEFAULT_PROFILE }; }
}
function saveProfile(patch) {
  profileStorage = { ...profileStorage, ...patch };
  localStorage.setItem('jt.profile', JSON.stringify(profileStorage));
  paintHeader();
}
let profileStorage = loadProfile();

const profileName = () => (profileStorage.nickname || '').trim() || 'Guest';
const rankLabel = () => {
  const info = tierInfo(profileStorage.rank);
  const division = info.divisions ? (profileStorage.division || '') : '';
  return division ? `${info.tier} ${division}` : info.tier;
};

/* ---------------- helpers ---------------- */
const $ = (id) => document.getElementById(id);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function initials(name) {
  const parts = String(name || '?').trim().split(/[\s._-]+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts[0][0] + (parts[1]?.[0] ?? '')).toUpperCase();
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
  missing_nickname: 'Set your nickname on the Profile page first.',
  post_too_long: 'That post is too long (max 1200 characters).',
  payload_too_large: 'That post is too long (max 1200 characters).',
  not_found: 'That entry no longer exists.',
  team_full: 'That squad already has a full roster.',
  admin_required: 'That admin key is not correct.',
  admin_key_missing: 'Admin mode is not configured on this site yet.',
  too_many_attempts: 'Too many attempts — wait a few minutes and try again.',
  network_error: 'Cannot reach the community server.',
  timeout: 'The server took too long. Try again.',
  bad_response: 'The server returned an unexpected reply.',
  http_404: 'This host does not run the community service, so posts and squads cannot load.',
  http_503: 'The community service is temporarily unavailable.',
};
const explain = (error) => ERRORS[error?.message] || 'Something went wrong. Please try again.';

/* ---------------- routing ---------------- */
const ROUTES = {
  home: () => 'home',
  community: () => 'community',
  teams: () => 'teams',
  team: (id) => ({ view: 'team', id }),
  profile: () => 'profile',
};

function currentRoute() {
  const hash = location.hash.replace(/^#\/?/, '');
  const team = hash.match(/^teams\/([0-9a-fA-F-]{36})$/);
  if (team) return { view: 'team', id: team[1] };
  if (['home', 'community', 'teams', 'profile'].includes(hash)) return { view: hash };
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
  window.scrollTo({ top: 0, behavior: 'auto' });
}

function navigate(view) { location.hash = `#/${view}`; }

/* ---------------- header ---------------- */
function paintHeader() {
  const name = profileName();
  $('headerName').textContent = name;
  $('headerRank').textContent = rankLabel();
  $('headerInitial').textContent = initials(name);
  $('composerAvatar').textContent = initials(name);
  paintAdminUi();
}

function paintAdminUi() {
  const button = $('adminButton');
  button.textContent = state.isAdmin ? 'Admin mode: on' : 'Admin mode';
  button.classList.toggle('is-on', state.isAdmin);
  button.setAttribute('aria-label', state.isAdmin
    ? 'Admin mode is on. Click to sign out of admin mode'
    : 'Open admin mode to publish content');
  const writingDisabled = state.offline || !state.isAdmin;
  $('postForm').hidden = writingDisabled;
  $('openCreateTeam').hidden = writingDisabled;
  const notice = $('modeNotice');
  notice.hidden = !writingDisabled;
  notice.textContent = state.offline
    ? 'This host serves the pages only — no community service runs here, so the feed and squads stay empty and nothing can be published. The live site needs its backend.'
    : 'Read-only community — the site admin publishes posts, comments, squads and join requests. Your profile stays on this device.';
}

/* ---------------- shared renderers ---------------- */
function postNode(post) {
  const article = document.createElement('article');
  article.className = 'card post-card';
  article.dataset.id = post.id;

  const open = state.openComments.has(post.id);
  const cached = state.commentsByPost.get(post.id);

  article.innerHTML = `
    <div class="post-head">
      <span class="avatar" aria-hidden="true">${esc(initials(post.author))}</span>
      <div class="post-head-text">
        <div class="post-author">
          ${esc(post.author)}
          <span class="badge pink">${esc(post.rank)}</span>
        </div>
        <div class="post-sub">
          <span class="badge">${esc(post.category)}</span>
          <time datetime="${esc(post.created_at)}">${esc(timeAgo(post.created_at))}</time>
        </div>
      </div>
    </div>
    <p class="post-body">${esc(post.content)}</p>
    <div class="post-actions">
      ${state.isAdmin
        ? `<button class="icon-btn" type="button" data-like="${esc(post.id)}" aria-pressed="${post.liked_by_me ? 'true' : 'false'}"
             title="Like this post" aria-label="Like this post, ${post.likes} likes">
             ${HEART}<span aria-hidden="true">${post.likes}</span>
           </button>`
        : `<span class="count-chip" title="Likes">${HEART}<span>${post.likes}</span></span>`}
      <button class="icon-btn" type="button" data-comments="${esc(post.id)}" aria-expanded="${open ? 'true' : 'false'}"
        title="Show comments" aria-label="Show comments, ${post.comments} comments">
        ${BUBBLE}<span aria-hidden="true">${post.comments}</span>
      </button>
    </div>
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
      <span class="avatar" aria-hidden="true">${esc(initials(c.author))}</span>
      <p><b>${esc(c.author)}</b><br><span>${esc(c.content)}</span></p>
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
      <i>${team.members}/${team.slot_count} members</i>
      <i>Min rank: ${esc(team.required_rank)}</i>
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
const squadsEmptyCopy = () => (state.offline
  ? 'No squads yet — this host does not run the community service.'
  : state.isAdmin ? 'No squads yet — create the first one.' : 'No squads published yet.');

function renderHome() {
  const stats = state.stats || { posts: state.posts.length, teams: state.teams.length, members: 0, comments: 0 };
  $('homeStats').innerHTML = [
    ['Posts shared', stats.posts],
    ['Squads', stats.teams],
    ['Players posting', stats.authors],
    ['Comments', stats.comments],
  ].map(([label, value]) => `
    <div class="stat"><b>${Number(value) || 0}</b><span>${esc(label)}</span></div>`).join('');

  const recruiting = state.teams.filter(t => t.status === 'recruiting');
  $('recruitingCount').textContent = `${recruiting.length} open roster${recruiting.length === 1 ? '' : 's'}`;

  const teamsHost = $('homeTeams');
  teamsHost.replaceChildren();
  const featured = (recruiting.length ? recruiting : state.teams).slice(0, 3);
  if (!featured.length) teamsHost.appendChild(emptyBlock(squadsEmptyCopy()));
  featured.forEach(team => teamsHost.appendChild(teamCard(team)));

  const leaders = topWriters(state.posts);
  const leaderHost = $('homeLeaders');
  leaderHost.replaceChildren();
  if (!leaders.length) leaderHost.appendChild(emptyBlock('No post writers yet.'));
  leaders.forEach((entry, index) => {
    const row = document.createElement('div');
    row.className = 'leader';
    row.innerHTML = `
      <span class="leader-rank">#${index + 1}</span>
      <span class="avatar" aria-hidden="true">${esc(initials(entry.name))}</span>
      <span class="leader-name">${esc(entry.name)}</span>
      <span class="leader-score">${entry.likes} likes · ${entry.posts} posts</span>`;
    leaderHost.appendChild(row);
  });

  const feedHost = $('homeFeed');
  feedHost.replaceChildren();
  const latest = state.posts.slice(0, 3);
  if (!latest.length) { feedHost.appendChild(emptyBlock(state.offline || !state.isAdmin ? 'No posts yet.' : 'The feed is empty. Post the first one.')); return; }
  latest.forEach(post => feedHost.appendChild(postNode(post)));
}

function topWriters(posts) {
  const tally = new Map();
  posts.forEach(post => {
    const key = post.author;
    const entry = tally.get(key) || { name: key, likes: 0, posts: 0 };
    entry.likes += post.likes;
    entry.posts += 1;
    tally.set(key, entry);
  });
  return [...tally.values()].sort((a, b) => b.likes - a.likes || b.posts - a.posts).slice(0, 5);
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
  if (state.sort === 'top') return [...list].sort((a, b) => b.likes - a.likes);
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
      : state.offline ? 'No posts yet — this host does not run the community service.' : 'The feed is empty. Start the first conversation.'));
  } else {
    list.forEach(post => host.appendChild(postNode(post)));
  }
  $('loadMore').hidden = !(state.hasMore && !state.search.trim());
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

/* ---------------- teams ---------------- */
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

function renderTeamDetail(teamId) {
  const team = state.teams.find(t => t.id === teamId);
  const host = $('teamDetail');
  if (!team) {
    host.replaceChildren();
    host.appendChild(emptyBlock('That squad could not be found.'));
    return;
  }
  const recruiting = team.status === 'recruiting';
  const slots = Math.max(team.slot_count, team.members);
  const roster = team.roster?.length ? team.roster : [{ name: team.leader, role: 'Founder' }];
  const filled = Math.min(roster.length, slots);

  host.innerHTML = `
    <div class="banner"></div>
    <div class="panel-head">
      <span class="avatar" aria-hidden="true">${esc(team.logo)}</span>
      <div class="panel-head-text">
        <h2 id="teamDetailName">${esc(team.name)}</h2>
        <p>Led by ${esc(team.leader)}</p>
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
          Open slots: <strong style="color:var(--text)">${Math.max(0, slots - filled)}</strong> of ${slots}</p>
        </section>
      </div>
      <div class="divider"></div>
      <h3 style="font-family:var(--font-display);font-size:.85rem;letter-spacing:.16em;text-transform:uppercase;color:var(--dim);margin-bottom:.6rem">Roster</h3>
      <div class="roster">
        ${Array.from({ length: slots }, (_, i) => {
          const entry = roster[i];
          return entry
            ? `<div class="slot"><span class="avatar" aria-hidden="true">${esc(initials(entry.name))}</span><p><b>${esc(entry.name)}</b><small>${esc(entry.role)}</small></p></div>`
            : `<div class="slot open"><span class="avatar" aria-hidden="true">+</span><p><b>Open slot</b><small>unclaimed</small></p></div>`;
        }).join('')}
      </div>
      <div class="divider"></div>
      ${state.isAdmin
        ? `<button class="btn btn-primary btn-block" type="button" data-join="${esc(team.id)}" ${recruiting ? '' : 'disabled'}>
             ${recruiting ? 'Add a join request' : 'Roster is full'}
           </button>`
        : `<p class="notice">Join requests are recorded by the site admin. Message the squad leader in the feed.</p>`}
    </div>`;
}

/* ---------------- profile ---------------- */
function renderProfile() {
  const host = $('profilePanel');
  const p = profileStorage;
  host.innerHTML = `
    <div class="banner"></div>
    <div class="panel-head">
      <span class="avatar" aria-hidden="true">${esc(initials(profileName()))}</span>
      <div class="panel-head-text">
        <h2 id="profile-name">${esc(profileName())}</h2>
        <p>${esc(rankLabel())}</p>
      </div>
      <button class="btn btn-ghost btn-sm" type="button" id="editProfile">Edit profile</button>
    </div>
    <div class="panel-body">
      <div class="panel-grid">
        <section>
          <h3>Player</h3>
          <div class="roster" style="grid-template-columns:1fr">
            <div class="slot"><p><b>${esc(p.mode)}</b><small>main mode</small></p></div>
            <div class="slot"><p><b>${esc(p.weapon)}</b><small>favorite weapon</small></p></div>
            <div class="slot"><p><b>${esc(p.team || 'No squad')}</b><small>${esc(p.role)}</small></p></div>
          </div>
        </section>
        <section>
          <h3>Bio</h3>
          <p>${esc(p.bio)}</p>
        </section>
      </div>
      <div class="divider"></div>
      <h3 style="font-family:var(--font-display);font-size:.85rem;letter-spacing:.16em;text-transform:uppercase;color:var(--dim)">Ranked ladder</h3>
      <div class="ladder">
        ${RANK_LADDER.map(entry => `
          <div class="ladder-row${entry.tier === p.rank ? ' is-current' : ''}">
            <b>${esc(entry.tier)}</b>
            <span>${esc(entry.divisions ? 'I – V' : 'N/A')}</span>
            <span>${esc(entry.tier === 'Unranked' ? '—' : `${entry.rp} RP`)}</span>
          </div>`).join('')}
      </div>
      <div class="divider"></div>
      <h3 style="font-family:var(--font-display);font-size:.85rem;letter-spacing:.16em;text-transform:uppercase;color:var(--dim)">Your posts on this device</h3>
      <div id="myPosts" style="margin-top:.75rem"></div>
    </div>`;

  $('editProfile').addEventListener('click', openProfileEditor);
  loadMyPosts(host.querySelector('#myPosts'));
}

async function loadMyPosts(container) {
  container.replaceChildren(skeletonBlock(1));
  try {
    const result = await api.posts({ author_only: true, limit: 10 });
    const mine = result.posts || [];
    container.replaceChildren();
    if (!mine.length) { container.appendChild(emptyBlock('You have not posted yet from this device.')); return; }
    mine.forEach(post => container.appendChild(postNode(post)));
  } catch {
    container.replaceChildren();
    container.appendChild(emptyBlock('Could not load your posts.'));
  }
}

function openProfileEditor() {
  document.getElementById('profileForm')?.parentElement.remove();
  const p = profileStorage;
  const host = $('profilePanel');
  const wrapper = document.createElement('div');
  wrapper.innerHTML = `
    <form class="panel-body" id="profileForm" style="border-top:1px solid var(--line)">
      <div class="field"><label for="pfNick">Nickname</label><input class="input" id="pfNick" maxlength="24" required value="${esc(p.nickname)}" placeholder="in-game name"></div>
      <div class="field">
        <label for="pfRank">Current rank tier</label>
        <select class="input select" id="pfRank">${RANK_TIERS.map(tier => `<option${tier === p.rank ? ' selected' : ''}>${tier}</option>`).join('')}</select>
        <p class="field-hint" id="rankHint"></p>
      </div>
      <div class="field" id="pfDivisionField">
        <label for="pfDivision">Subdivision</label>
        <select class="input select" id="pfDivision">
          <option value="">Not needed</option>
          ${DIVISIONS.map(d => `<option value="${d}"${d === p.division ? ' selected' : ''}>${d}</option>`).join('')}
        </select>
      </div>
      <div class="field"><label for="pfMode">Main mode</label><select class="input select" id="pfMode">${['Multiplayer', 'Battle Royale', 'Zombies'].map(m => `<option${m === p.mode ? ' selected' : ''}>${m}</option>`).join('')}</select></div>
      <div class="field"><label for="pfWeapon">Favorite weapon</label><input class="input" id="pfWeapon" maxlength="30" value="${esc(p.weapon)}"></div>
      <div class="field"><label for="pfTeam">Squad</label><input class="input" id="pfTeam" maxlength="40" value="${esc(p.team)}" placeholder="optional"></div>
      <div class="field"><label for="pfRole">Role</label><select class="input select" id="pfRole">${['Solo', 'Slayer', 'Objective', 'Support', 'Sniper', 'IGL', 'Leader'].map(r => `<option${r === p.role ? ' selected' : ''}>${r}</option>`).join('')}</select></div>
      <div class="field"><label for="pfBio">Bio</label><textarea class="textarea" id="pfBio" maxlength="160">${esc(p.bio)}</textarea></div>
      <div style="display:flex;gap:.6rem;justify-content:flex-end">
        <button class="btn btn-ghost" type="button" id="pfCancel">Cancel</button>
        <button class="btn btn-primary" type="submit">Save profile</button>
      </div>
    </form>`;
  host.appendChild(wrapper);

  const rankSelect = wrapper.querySelector('#pfRank');
  const divisionField = wrapper.querySelector('#pfDivisionField');
  const divisionSelect = wrapper.querySelector('#pfDivision');
  const hint = wrapper.querySelector('#rankHint');
  const syncRankFields = () => {
    const info = tierInfo(rankSelect.value);
    divisionField.hidden = !info.divisions;
    if (!info.divisions) divisionSelect.value = '';
    hint.textContent = `${info.tier}: ${info.tier === 'Unranked' ? 'no ranked points yet' : `${info.rp} RP`} · ${info.divisions ? 'subdivisions I – V' : 'no subdivision'}`;
  };
  rankSelect.addEventListener('change', syncRankFields);
  syncRankFields();

  wrapper.querySelector('#pfNick').focus();

  wrapper.querySelector('#pfCancel').addEventListener('click', () => { wrapper.remove(); renderProfile(); });
  wrapper.querySelector('#profileForm').addEventListener('submit', (event) => {
    event.preventDefault();
    const nickname = wrapper.querySelector('#pfNick').value.trim();
    if (nickname.length < 2) { toast('Nickname needs at least 2 characters.', true); return; }
    saveProfile({
      nickname,
      rank: rankSelect.value,
      division: tierInfo(rankSelect.value).divisions ? divisionSelect.value : '',
      mode: wrapper.querySelector('#pfMode').value,
      weapon: wrapper.querySelector('#pfWeapon').value.trim() || 'AR',
      team: wrapper.querySelector('#pfTeam').value.trim(),
      role: wrapper.querySelector('#pfRole').value,
      bio: wrapper.querySelector('#pfBio').value.trim() || DEFAULT_PROFILE.bio,
    });
    wrapper.remove();
    renderProfile();
    toast('Profile saved on this device.');
  });
}

/* ---------------- data loading ---------------- */
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

async function refreshAll() {
  await Promise.all([loadTeams(), loadStats()]);
  try { await loadPosts({ reset: true }); }
  catch { if (!state.offline) toast('The feed could not be loaded.', true); }
  paintRoute();
}

/* ---------------- actions ---------------- */
async function publishPost(content) {
  const button = $('postSubmit');
  button.disabled = true;
  button.textContent = 'Publishing…';
  try {
    await api.post({ content, category: state.category, nickname: profileName(), rank: rankLabel() });
    $('postText').value = '';
    updateCharCount();
    await loadPosts({ reset: true });
    await loadStats();
    renderFeed();
    toast('Posted to the community feed.');
    return true;
  } catch (error) {
    toast(explain(error), true);
    return false;
  } finally {
    button.disabled = false;
    button.textContent = 'Publish post';
  }
}

async function toggleLike(postId) {
  const post = state.posts.find(p => p.id === postId);
  if (!post) return;
  try {
    const result = await api.like(postId);
    post.liked_by_me = Boolean(result.liked);
    post.likes = Number(result.likes ?? post.likes);
    renderFeedOrHome();
  } catch (error) {
    toast(explain(error), true);
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
    await api.comment(postId, { content, nickname: profileName() });
    if (post) post.comments += 1;
    state.commentsByPost.set(postId, await api.comments(postId));
    refreshPostNode(postId);
  } catch (error) {
    toast(explain(error), true);
  }
}

function refreshPostNode(postId) {
  const existing = document.querySelector(`[data-id="${CSS.escape(postId)}"]`);
  const post = state.posts.find(p => p.id === postId);
  if (!existing || !post) return;
  existing.replaceWith(postNode(post));
}

function renderFeedOrHome() {
  if (state.route === 'community') renderFeed();
  else if (state.route === 'home') renderHome();
}

async function joinTeam(teamId) {
  const button = document.querySelector(`[data-join="${CSS.escape(teamId)}"]`);
  if (!profileStorage.nickname) { toast('Set your nickname first.', true); navigate('profile'); return; }
  if (button) { button.disabled = true; button.textContent = 'Sending…'; }
  try {
    const result = await api.joinTeam(teamId, profileName());
    toast(result?.duplicated ? 'You already asked to join this squad.' : 'Join request sent to the squad.');
    await loadTeams();
    renderTeamDetail(teamId);
  } catch (error) {
    toast(explain(error), true);
    if (button) { button.disabled = false; button.textContent = 'Request a join slot'; }
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
    leader: profileName(),
  };
  try {
    await api.createTeam({ ...data, nickname: profileName() });
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
  if (!state.isAdmin) return;
  const panel = node.querySelector(`[data-comments-panel="${CSS.escape(postId)}"]`);
  if (!panel || panel.querySelector('form')) return;
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

function bindEvents() {
  document.addEventListener('click', (event) => {
    const nav = event.target.closest('[data-nav]');
    if (nav) { navigate(nav.dataset.nav); return; }

    const team = event.target.closest('[data-team]');
    if (team) { navigate(`teams/${team.dataset.team}`); return; }

    const like = event.target.closest('[data-like]');
    if (like) { toggleLike(like.dataset.like); return; }

    const comments = event.target.closest('[data-comments]');
    if (comments) { toggleComments(comments.dataset.comments); return; }

    const join = event.target.closest('[data-join]');
    if (join) { joinTeam(join.dataset.join); return; }

    if (event.target.closest('[data-close-dialog]')) $('createTeamDialog').close();
  });

  $('postForm').addEventListener('submit', (event) => {
    event.preventDefault();
    const content = $('postText').value.trim();
    if (content.length < 3) { toast('Write something first.', true); return; }
    if (content.length > MAX_POST) { toast('That post is too long.', true); return; }
    publishPost(content);
  });

  $('postText').addEventListener('input', updateCharCount);

  $('feedSearch').addEventListener('input', (event) => { state.search = event.target.value; renderFeed(); });
  $('feedSort').addEventListener('change', (event) => { state.sort = event.target.value; renderFeed(); });
  $('teamSearch').addEventListener('input', (event) => { state.teamSearch = event.target.value; renderTeamGrid(); });
  $('teamModeFilter').addEventListener('change', (event) => { state.teamMode = event.target.value; renderTeamGrid(); });

  $('openCreateTeam').addEventListener('click', () => {
    if (!profileStorage.nickname) { toast('Set your nickname first so the squad has a leader.', true); navigate('profile'); return; }
    $('createTeamDialog').showModal();
  });
  $('createTeamForm').addEventListener('submit', (event) => { event.preventDefault(); createTeam(event.target); });

  $('loadMore').addEventListener('click', async (event) => {
    event.target.disabled = true;
    try { await loadPosts({ reset: false }); renderFeed(); }
    catch { toast('Could not load more posts.', true); }
    finally { event.target.disabled = false; }
  });

  $('headerUser').addEventListener('click', () => navigate('profile'));
  $('headerUser').style.cursor = 'pointer';

  $('adminButton').addEventListener('click', () => {
    if (state.isAdmin) { signOutAdmin(); return; }
    $('adminKey').value = '';
    $('adminDialog').showModal();
    $('adminKey').focus();
  });
  $('adminForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const key = $('adminKey').value.trim();
    if (!key) { toast('Enter the admin key first.', true); return; }
    const button = $('adminSubmit');
    button.disabled = true;
    button.textContent = 'Checking…';
    try {
      await api.adminCheck(key);
      setAdminKey(key);
      state.isAdmin = true;
      $('adminDialog').close();
      paintAdminUi();
      paintRoute();
      toast('Admin mode on — you can publish now.');
    } catch (error) {
      toast(explain(error), true);
    } finally {
      button.disabled = false;
      button.textContent = 'Unlock editing';
    }
  });
  document.querySelectorAll('[data-close-admin]').forEach(node =>
    node.addEventListener('click', () => $('adminDialog').close()));

  window.addEventListener('hashchange', paintRoute);
}

function signOutAdmin() {
  setAdminKey('');
  state.isAdmin = false;
  paintAdminUi();
  paintRoute();
  toast('Admin mode off — the site is read-only again.');
}

/* ---------------- boot ---------------- */
async function boot() {
  $('footerYear').textContent = String(new Date().getFullYear());
  state.isAdmin = Boolean(getAdminKey());
  paintHeader();
  updateCharCount();
  bindEvents();

  $('homeStats').innerHTML = '<div class="skeleton" style="min-height:80px"></div>'.repeat(4);
  try { await api.health(); }
  catch { state.offline = true; }
  paintAdminUi();
  await refreshAll();

  // Keep the shared feed reasonably fresh without spamming the server.
  setInterval(async () => {
    if (document.hidden) return;
    try {
      await loadPosts({ reset: true });
      await loadStats();
      renderFeedOrHome();
      if (state.route === 'home') renderHome();
    } catch { /* keep current view */ }
  }, 60000);
}

getVisitorId();
boot();
