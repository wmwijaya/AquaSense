'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { merge, validate } = require('./merge');

const PORT = +process.env.PORT || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const PUBLIC = path.join(__dirname, '..', 'public');
const SESSION_DAYS = 30;
const MAX_BODY = 1024 * 1024;

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'aquasense.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL,
    salt BLOB NOT NULL, hash BLOB NOT NULL, created INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS docs (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    json TEXT NOT NULL, updated INTEGER NOT NULL);
  PRAGMA foreign_keys = ON;
`);
const q = {
  userByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
  addUser: db.prepare('INSERT INTO users (email, salt, hash, created) VALUES (?, ?, ?, ?)'),
  delUser: db.prepare('DELETE FROM users WHERE id = ?'),
  addSession: db.prepare('INSERT INTO sessions (token_hash, user_id, expires) VALUES (?, ?, ?)'),
  session: db.prepare('SELECT u.id, u.email FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires > ?'),
  delSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
  purge: db.prepare('DELETE FROM sessions WHERE expires <= ?'),
  doc: db.prepare('SELECT json FROM docs WHERE user_id = ?'),
  putDoc: db.prepare('INSERT INTO docs (user_id, json, updated) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET json = excluded.json, updated = excluded.updated'),
};
db.exec('PRAGMA foreign_keys = ON');

/* ---------- helpers ---------- */
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const scrypt = (pw, salt) => crypto.scryptSync(pw, salt, 64);
const json = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
};
const fail = (status, message) => Object.assign(new Error(message), { status });

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > MAX_BODY) { reject(fail(413, 'payload too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks)) : {}); } catch { reject(fail(400, 'invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function cookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(/;\s*/).filter(Boolean).map(c => {
    const i = c.indexOf('='); return [c.slice(0, i), decodeURIComponent(c.slice(i + 1))];
  }));
}
const isHttps = req => process.env.COOKIE_SECURE === '1' || req.headers['x-forwarded-proto'] === 'https';
function sessionCookie(req, token, maxAge) {
  return `as_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${isHttps(req) ? '; Secure' : ''}`;
}
function currentUser(req) {
  const t = cookies(req).as_session;
  return t ? q.session.get(sha(t), Date.now()) : null;
}
function startSession(req, res, userId, body) {
  const token = crypto.randomBytes(32).toString('base64url');
  q.addSession.run(sha(token), userId, Date.now() + SESSION_DAYS * 864e5);
  json(res, 200, body, { 'Set-Cookie': sessionCookie(req, token, SESSION_DAYS * 86400) });
}

// Naive in-memory throttle for auth endpoints: 10 attempts / 15 min / IP.
const attempts = new Map();
function throttle(req) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
  const now = Date.now(), list = (attempts.get(ip) || []).filter(t => now - t < 15 * 60e3);
  if (list.length >= 10) throw fail(429, 'terlalu banyak percobaan, coba lagi nanti');
  list.push(now); attempts.set(ip, list);
}

function credentials(body) {
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 254) throw fail(400, 'email tidak valid');
  if (password.length < 8 || password.length > 200) throw fail(400, 'kata sandi minimal 8 karakter');
  return { email, password };
}
function verify(user, password) {
  const h = scrypt(password, user.salt);
  return h.length === user.hash.length && crypto.timingSafeEqual(h, user.hash);
}

/* ---------- API ---------- */
const routes = {
  'POST /api/register': async (req, res) => {
    throttle(req);
    const { email, password } = credentials(await readBody(req));
    if (q.userByEmail.get(email)) throw fail(409, 'email sudah terdaftar');
    const salt = crypto.randomBytes(16);
    const { lastInsertRowid } = q.addUser.run(email, salt, scrypt(password, salt), Date.now());
    startSession(req, res, Number(lastInsertRowid), { email });
  },
  'POST /api/login': async (req, res) => {
    throttle(req);
    const { email, password } = credentials(await readBody(req));
    const user = q.userByEmail.get(email);
    if (!user || !verify(user, password)) throw fail(401, 'email atau kata sandi salah');
    startSession(req, res, user.id, { email });
  },
  'POST /api/logout': async (req, res) => {
    const t = cookies(req).as_session;
    if (t) q.delSession.run(sha(t));
    json(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, '', 0) });
  },
  'GET /api/me': async (req, res) => {
    const u = currentUser(req);
    json(res, 200, { email: u ? u.email : null });
  },
  'POST /api/sync': async (req, res) => {
    const u = currentUser(req);
    if (!u) throw fail(401, 'belum masuk');
    const incoming = validate((await readBody(req)).data);
    const row = q.doc.get(u.id);
    const merged = merge(row ? JSON.parse(row.json) : {}, incoming);
    q.putDoc.run(u.id, JSON.stringify(merged), Date.now());
    json(res, 200, { data: merged });
  },
  'POST /api/delete-account': async (req, res) => {
    const u = currentUser(req);
    if (!u) throw fail(401, 'belum masuk');
    const user = q.userByEmail.get(u.email);
    if (!verify(user, String((await readBody(req)).password || ''))) throw fail(401, 'kata sandi salah');
    q.delUser.run(u.id);
    json(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, '', 0) });
  },
};

/* ---------- static files ---------- */
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };
function serveStatic(req, res) {
  let rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.join(PUBLIC, path.normalize(rel));
  if (!file.startsWith(PUBLIC + path.sep)) return json(res, 403, { error: 'forbidden' });
  fs.readFile(file, (err, buf) => {
    if (err) return json(res, 404, { error: 'not found' });
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : buf);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url, 'http://x');
    if (pathname.startsWith('/api/')) {
      const handler = routes[`${req.method} ${pathname}`];
      if (!handler) throw fail(404, 'not found');
      if (req.method === 'POST' && !(req.headers['content-type'] || '').startsWith('application/json')) throw fail(415, 'content-type must be application/json');
      return await handler(req, res);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') throw fail(405, 'method not allowed');
    serveStatic(req, res);
  } catch (e) {
    if (!e.status) console.error(e);
    if (!res.headersSent) json(res, e.status || 500, { error: e.status ? e.message : 'server error' });
  }
});

setInterval(() => q.purge.run(Date.now()), 3600e3).unref();
if (require.main === module) {
  server.listen(PORT, HOST, () => console.log(`AquaSense on http://${HOST}:${PORT}  (data: ${DATA_DIR})`));
}
module.exports = server;
