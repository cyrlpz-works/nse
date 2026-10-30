const BASE = '/functions/v1/app';

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

// The admin key is held for this browser tab only, and is sent back to the
// Function on every write; the Function compares it with its own Secret.
export function getAdminKey() {
  return sessionStorage.getItem('jt.admin') || '';
}
export function setAdminKey(key) {
  if (key) sessionStorage.setItem('jt.admin', key);
  else sessionStorage.removeItem('jt.admin');
}

async function request(path, { method = 'GET', body, query, timeout = 12000 } = {}) {
  const url = new URL(BASE + path, location.origin);
  const params = { visitor_id: getVisitorId(), ...(query || {}) };
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }

  const headers = {};
  if (body) headers['content-type'] = 'application/json';
  if (getAdminKey()) headers['x-admin-key'] = getAdminKey();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, {
      method,
      headers: Object.keys(headers).length ? headers : undefined,
      body: body ? JSON.stringify({ visitor_id: getVisitorId(), ...body }) : undefined,
      credentials: 'same-origin',
      signal: controller.signal,
    });
    let data = null;
    try { data = await response.json(); } catch { /* non-JSON failure below */ }
    if (!response.ok) {
      const error = new Error(data?.error || data?.code || `http_${response.status}`);
      error.status = response.status;
      throw error;
    }
    if (!data || typeof data !== 'object') throw new Error('bad_response');
    return data;
  } finally {
    clearTimeout(timer);
  }
}

export const api = {
  health: () => request('/api/health'),
  teams: () => request('/api/teams').then(r => r.teams || []),
  createTeam: (team) => request('/api/teams', { method: 'POST', body: team }),
  joinTeam: (teamId, nickname) => request('/api/teams', { method: 'POST', body: { op: 'join', team_id: teamId, nickname } }),
  posts: (query) => request('/api/posts', { query }),
  comments: (postId) => request('/api/comments', { query: { post_id: postId } }).then(r => r.comments || []),
  post: (body) => request('/api/posts', { method: 'POST', body: { op: 'create', ...body } }),
  like: (postId) => request('/api/posts', { method: 'POST', body: { op: 'like', post_id: postId } }),
  comment: (postId, body) => request('/api/posts', { method: 'POST', body: { op: 'comment', post_id: postId, ...body } }),
  stats: () => request('/api/stats'),
  adminCheck: (key) => request('/api/admin/check', { method: 'POST', body: { key } }),
};
