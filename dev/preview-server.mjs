// Local preview: serves dist/ and runs the real Function routes on
// /functions/v1/app against an in-memory adapter. Nothing here ships.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { application } from '../functions/routes.mjs';
import { createFakeDb, BackendError } from './fake-db.mjs';

const root = resolve(import.meta.dirname, '..', 'dist');
const port = Number(process.argv[2]) || 4173;
// Stands in for the deployed site's ADMIN_KEY Secret so admin mode works locally.
const ADMIN_KEY = process.env.ADMIN_KEY || 'local-admin';
const handle = application({
  db: createFakeDb(),
  BackendError,
  env: { get: (name) => (name === 'ADMIN_KEY' ? ADMIN_KEY : undefined) },
});

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
};

const invoke = context => handle(context).catch(error => Response.json(
  {
    error: error instanceof BackendError ? error.code : 'internal_error',
    ...(process.env.DEBUG ? { debug: `${error?.name}: ${error?.message}`, stack: String(error?.stack).split('\n').slice(0, 4) } : {}),
  },
  { status: error instanceof BackendError ? error.status : 500 },
));

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);

  if (url.pathname.startsWith('/functions/')) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const headers = {};
    if (req.headers['content-type']) headers['content-type'] = req.headers['content-type'];
    if (req.headers['x-admin-key']) headers['x-admin-key'] = req.headers['x-admin-key'];
    const request = new Request(`https://local.example${url.pathname}${url.search}`, {
      method: req.method,
      headers,
      body: ['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method) ? Buffer.concat(chunks) : undefined,
    });
    const response = await invoke({ request, user: null, requestId: 'local' });
    res.writeHead(response.status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(await response.text());
    return;
  }

  const relative = url.pathname === '/' ? 'index.html' : normalize(url.pathname).replace(/^(\.\.[/\\])+/, '').replace(/^[/\\]/, '');
  const file = join(root, relative);
  if (!file.startsWith(root)) { res.writeHead(403).end('forbidden'); return; }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  }
});

server.listen(port, '127.0.0.1', () => console.log(`preview: http://127.0.0.1:${port}  (admin key: ${ADMIN_KEY})`));
