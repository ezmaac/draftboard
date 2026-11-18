const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const db = require('./src/db');
const { TEAMS } = require('./src/teams');
const { sampleSchedule, parseScheduleCsv } = require('./src/schedule');

const PORT = Number(process.env.PORT) || 3000;
// Registration requires this code so only the ticket partners can sign up.
const INVITE_CODE = process.env.INVITE_CODE || 'goleafsgo';
const SESSION_DAYS = 30;

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------- helpers

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, msg) => { throw new HttpError(status, msg); };
const tx = fn => {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
};

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pw, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
function checkPassword(pw, stored) {
  const [salt, hash] = stored.split(':');
  const test = crypto.scryptSync(pw, salt, 64);
  return crypto.timingSafeEqual(test, Buffer.from(hash, 'hex'));
}

function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map(c => c.trim().split('=')).filter(p => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
}

const publicUser = u => u && ({
  id: u.id, username: u.username, display_name: u.display_name, email: u.email,
  color: u.color, favorite_player: u.favorite_player, is_admin: !!u.is_admin, created_at: u.created_at,
});

function createSession(res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)')
    .run(token, userId, Date.now() + SESSION_DAYS * 86400000);
  res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}`);
}

app.use((req, _res, next) => {
  const sid = parseCookies(req.headers.cookie).sid;
  if (sid) {
    const row = db.prepare(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
                            WHERE s.token = ? AND s.expires_at > ?`).get(sid, Date.now());
    if (row) { req.user = row; req.sid = sid; }
  }
  next();
});

const auth = (req, _res, next) => (req.user ? next() : next(new HttpError(401, 'Please log in')));
const admin = (req, _res, next) => (req.user?.is_admin ? next() : next(new HttpError(403, 'Commissioner only')));

// ---------------------------------------------------------------- draft logic

/** Who picks at a given 0-based overall pick index. */
function slotFor(overallIdx, order, orderType) {
  const n = order.length;
  const round = Math.floor(overallIdx / n) + 1;
  let idx = overallIdx % n;
  if (orderType === 'snake' && round % 2 === 0) idx = n - 1 - idx;
  return { round, pick_in_round: (overallIdx % n) + 1, user_id: order[idx].user_id };
}

function elapsedMs(d, now = Date.now()) {
  if (!d.clock_started_at) return 0;
  const pausedNow = d.paused_at ? now - d.paused_at : 0;
  return Math.max(0, now - d.clock_started_at - d.paused_ms - pausedNow);
}

function draftState(id) {
  const draft = db.prepare('SELECT * FROM drafts WHERE id = ?').get(id);
  if (!draft) fail(404, 'Draft not found');
  const order = db.prepare(`SELECT o.position, o.user_id, u.display_name, u.username, u.color
                            FROM draft_order o JOIN users u ON u.id = o.user_id
                            WHERE o.draft_id = ? ORDER BY o.position`).all(id);
  const games = db.prepare('SELECT * FROM games WHERE draft_id = ? ORDER BY date, time').all(id);
  const picks = db.prepare('SELECT * FROM picks WHERE draft_id = ? ORDER BY overall').all(id);

  let onClock = null;
  const upcoming = [];
  if (draft.status === 'live' && order.length) {
    for (let i = picks.length; i < Math.min(games.length, picks.length + 1 + order.length * 2); i++) {
      const s = { overall: i + 1, ...slotFor(i, order, draft.order_type) };
      if (!onClock) onClock = s; else upcoming.push(s);
    }
  }
  return {
    draft: { ...draft, elapsed_ms: elapsedMs(draft) },
    order, games, picks, on_clock: onClock, upcoming,
    server_time: Date.now(),
  };
}

// --- live updates via Server-Sent Events
const listeners = new Map(); // draftId -> Set(res)
function broadcast(draftId, event = 'update') {
  for (const res of listeners.get(Number(draftId)) || []) res.write(`event: ${event}\ndata: {}\n\n`);
}

// ---------------------------------------------------------------- auth routes

app.post('/api/register', (req, res) => {
  const { username, password, display_name, invite_code } = req.body || {};
  if (invite_code !== INVITE_CODE) fail(403, 'Invalid invite code');
  if (!/^[a-z0-9_.-]{3,24}$/i.test(username || '')) fail(400, 'Username: 3-24 letters, numbers, _ . -');
  if (!password || password.length < 6) fail(400, 'Password must be at least 6 characters');
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) fail(409, 'Username taken');
  const first = !db.prepare('SELECT 1 FROM users LIMIT 1').get();
  const palette = ['#1e5bc6', '#e0a526', '#2fa36b', '#c8463d', '#8e5bd6', '#2a9fb8'];
  const count = db.prepare('SELECT COUNT(*) c FROM users').get().c;
  const r = db.prepare(`INSERT INTO users (username, display_name, password_hash, is_admin, color)
                        VALUES (?, ?, ?, ?, ?)`)
    .run(username, (display_name || username).slice(0, 40), hashPassword(password), first ? 1 : 0, palette[count % palette.length]);
  createSession(res, r.lastInsertRowid);
  res.json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(r.lastInsertRowid)) });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE username = ?').get(username || '');
  if (!u || !checkPassword(password || '', u.password_hash)) fail(401, 'Wrong username or password');
  createSession(res, u.id);
  res.json({ user: publicUser(u) });
});

app.post('/api/logout', (req, res) => {
  if (req.sid) db.prepare('DELETE FROM sessions WHERE token = ?').run(req.sid);
  res.setHeader('Set-Cookie', 'sid=; Path=/; Max-Age=0');
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => res.json({ user: publicUser(req.user) || null }));

app.put('/api/me', auth, (req, res) => {
  const { display_name, email, color, favorite_player } = req.body || {};
  if (color && !/^#[0-9a-f]{6}$/i.test(color)) fail(400, 'Colour must be a hex value like #1e5bc6');
  db.prepare(`UPDATE users SET display_name = COALESCE(?, display_name), email = ?, color = COALESCE(?, color),
              favorite_player = ? WHERE id = ?`)
    .run(display_name?.trim().slice(0, 40) || null, email?.trim() || null, color || null, favorite_player?.trim() || null, req.user.id);
  res.json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id)) });
});

app.put('/api/me/password', auth, (req, res) => {
  const { current, next } = req.body || {};
  if (!checkPassword(current || '', req.user.password_hash)) fail(401, 'Current password is wrong');
  if (!next || next.length < 6) fail(400, 'New password must be at least 6 characters');
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(next), req.user.id);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- data routes

app.get('/api/teams', (_req, res) => res.json(TEAMS));

app.get('/api/users', auth, (_req, res) => {
  res.json(db.prepare('SELECT * FROM users ORDER BY id').all().map(publicUser));
});

app.get('/api/drafts', auth, (_req, res) => {
  const rows = db.prepare(`
    SELECT d.*, (SELECT COUNT(*) FROM games g WHERE g.draft_id = d.id) AS game_count,
                (SELECT COUNT(*) FROM picks p WHERE p.draft_id = d.id) AS pick_count
    FROM drafts d ORDER BY d.id DESC`).all();
  res.json(rows);
});

app.post('/api/schedule/preview', auth, admin, (req, res) => {
  const { source, csv, season_start } = req.body || {};
  if (source === 'csv') return res.json(parseScheduleCsv(csv));
  res.json({ games: sampleSchedule(Number(season_start) || new Date().getFullYear()), errors: [] });
});

app.post('/api/drafts', auth, admin, (req, res) => {
  const { name, season, order_type, user_ids, games } = req.body || {};
  if (!name?.trim()) fail(400, 'Name is required');
  if (!Array.isArray(user_ids) || user_ids.length < 2) fail(400, 'Choose at least two partners for the draft order');
  if (new Set(user_ids).size !== user_ids.length) fail(400, 'A partner appears twice in the draft order');
  if (!Array.isArray(games) || !games.length) fail(400, 'The schedule has no games');
  const id = tx(() => {
    const d = db.prepare('INSERT INTO drafts (name, season, order_type, created_by) VALUES (?, ?, ?, ?)')
      .run(name.trim(), (season || '').trim(), order_type === 'linear' ? 'linear' : 'snake', req.user.id);
    const draftId = d.lastInsertRowid;
    const insO = db.prepare('INSERT INTO draft_order (draft_id, position, user_id) VALUES (?, ?, ?)');
    user_ids.forEach((uid, i) => insO.run(draftId, i + 1, uid));
    const insG = db.prepare('INSERT INTO games (draft_id, date, time, opponent, notes) VALUES (?, ?, ?, ?, ?)');
    games.forEach(g => insG.run(draftId, g.date, g.time || '19:00', g.opponent, g.notes || ''));
    return Number(draftId);
  });
  res.json({ id });
});

app.delete('/api/drafts/:id', auth, admin, (req, res) => {
  const d = db.prepare('SELECT status FROM drafts WHERE id = ?').get(req.params.id);
  if (!d) fail(404, 'Draft not found');
  if (d.status === 'complete') fail(400, 'Completed drafts are kept for history');
  db.prepare('DELETE FROM drafts WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.get('/api/drafts/:id', auth, (req, res) => res.json(draftState(req.params.id)));

app.get('/api/drafts/:id/events', auth, (req, res) => {
  const id = Number(req.params.id);
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.write('retry: 3000\n\n');
  if (!listeners.has(id)) listeners.set(id, new Set());
  listeners.get(id).add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => { clearInterval(ping); listeners.get(id)?.delete(res); });
});

app.post('/api/drafts/:id/start', auth, admin, (req, res) => {
  const d = db.prepare('SELECT * FROM drafts WHERE id = ?').get(req.params.id);
  if (!d) fail(404, 'Draft not found');
  if (d.status !== 'setup') fail(400, 'Draft already started');
  const now = Date.now();
  db.prepare("UPDATE drafts SET status = 'live', started_at = ?, clock_started_at = ?, paused_ms = 0, paused_at = NULL WHERE id = ?")
    .run(now, now, d.id);
  broadcast(d.id);
  res.json(draftState(d.id));
});

app.post('/api/drafts/:id/pick', auth, (req, res) => {
  const id = Number(req.params.id);
  const gameId = Number(req.body?.game_id);
  tx(() => {
    const s = draftState(id);
    if (s.draft.status !== 'live') fail(400, 'Draft is not live');
    if (!s.on_clock) fail(400, 'No pick on the clock');
    const onBehalf = s.on_clock.user_id !== req.user.id;
    if (onBehalf && !req.user.is_admin) fail(403, "It's not your pick");
    const game = s.games.find(g => g.id === gameId);
    if (!game) fail(404, 'Game not found in this draft');
    if (s.picks.some(p => p.game_id === gameId)) fail(409, 'That game is already taken');
    const now = Date.now();
    const secs = elapsedMs(s.draft, now) / 1000;
    db.prepare(`INSERT INTO picks (draft_id, overall, round, pick_in_round, user_id, game_id, made_by, seconds_taken, picked_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, s.on_clock.overall, s.on_clock.round, s.on_clock.pick_in_round, s.on_clock.user_id, gameId, req.user.id, secs, now);
    const done = s.picks.length + 1 >= s.games.length;
    db.prepare(`UPDATE drafts SET clock_started_at = ?, paused_ms = 0, paused_at = ?, status = ?, completed_at = ? WHERE id = ?`)
      .run(now, s.draft.paused_at ? now : null, done ? 'complete' : 'live', done ? now : null, id);
  });
  broadcast(id);
  res.json(draftState(id));
});

app.post('/api/drafts/:id/pause', auth, (req, res) => {
  const id = Number(req.params.id);
  const d = db.prepare('SELECT * FROM drafts WHERE id = ?').get(id);
  if (!d || d.status !== 'live') fail(400, 'Draft is not live');
  const now = Date.now();
  if (d.paused_at) db.prepare('UPDATE drafts SET paused_ms = paused_ms + ?, paused_at = NULL WHERE id = ?').run(now - d.paused_at, id);
  else db.prepare('UPDATE drafts SET paused_at = ? WHERE id = ?').run(now, id);
  broadcast(id);
  res.json(draftState(id));
});

app.post('/api/drafts/:id/undo', auth, admin, (req, res) => {
  const id = Number(req.params.id);
  tx(() => {
    const last = db.prepare('SELECT * FROM picks WHERE draft_id = ? ORDER BY overall DESC LIMIT 1').get(id);
    if (!last) fail(400, 'No picks to undo');
    db.prepare('DELETE FROM picks WHERE id = ?').run(last.id);
    // Put the previous picker back on the clock, keeping the time they had already used.
    const now = Date.now();
    db.prepare(`UPDATE drafts SET status = 'live', completed_at = NULL, clock_started_at = ?, paused_ms = 0, paused_at = NULL WHERE id = ?`)
      .run(now - Math.round(last.seconds_taken * 1000), id);
  });
  broadcast(id);
  res.json(draftState(id));
});

// SPA fallback
app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.use((err, _req, res, _next) => {
  if (!(err instanceof HttpError)) console.error(err);
  res.status(err.status || 500).json({ error: err.status ? err.message : 'Server error' });
});

app.listen(PORT, () => console.log(`Leafs draft board on http://localhost:${PORT}`));
