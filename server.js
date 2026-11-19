const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const express = require('express');
const db = require('./src/db');
const mail = require('./src/mail');
const { TEAMS, BY_ABBR, findTeam } = require('./src/teams');
const { sampleSchedule, parseScheduleCsv, readCsv, normDate, normTime, normPrice, normType, normSeconds } = require('./src/schedule');

const PORT = Number(process.env.PORT) || 3000;
// Registration requires this code so only the ticket partners can sign up.
const INVITE_CODE = process.env.INVITE_CODE || 'goleafsgo';
const SESSION_DAYS = 30;
const SCHEDULE_DIR = path.join(__dirname, 'schedules');

const app = express();
app.set('trust proxy', 1); // behind Fly/Render/etc. so req.secure reflects HTTPS
app.use(express.json({ limit: '2mb' }));
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
const torontoToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto' }).format(new Date());
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function gameLabel(g) {
  const [y, m, d] = g.date.split('-').map(Number);
  const dow = DOW[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  const t = BY_ABBR[g.opponent];
  return `${dow} ${MON[m - 1]} ${d} vs ${t ? `${t.city} ${t.name}` : g.opponent}`;
}

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
  id: u.id, username: u.username, display_name: u.display_name, email: u.email, notify_email: !!u.notify_email,
  color: u.color, favorite_player: u.favorite_player, is_admin: !!u.is_admin, created_at: u.created_at,
});
const getUser = id => db.prepare('SELECT * FROM users WHERE id = ?').get(id);

function createSession(req, res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)')
    .run(token, userId, Date.now() + SESSION_DAYS * 86400000);
  res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}${req.secure ? '; Secure' : ''}`);
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

/** Who picks at a given 0-based overall pick index. Extra picks fall to the top of the order. */
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

const totalPicks = (draft, games) => (draft.seat_mode === 'single' ? games.reduce((a, g) => a + g.seats, 0) : games.length);

function draftState(id) {
  const draft = db.prepare('SELECT * FROM drafts WHERE id = ?').get(id);
  if (!draft) fail(404, 'Draft not found');
  const order = db.prepare(`SELECT o.position, o.user_id, u.display_name, u.username, u.color
                            FROM draft_order o JOIN users u ON u.id = o.user_id
                            WHERE o.draft_id = ? ORDER BY o.position`).all(id);
  const games = db.prepare('SELECT * FROM games WHERE draft_id = ? ORDER BY date, time').all(id);
  const picks = db.prepare('SELECT * FROM picks WHERE draft_id = ? ORDER BY overall').all(id);
  const total = totalPicks(draft, games);

  let onClock = null;
  const upcoming = [];
  if (draft.status === 'live' && order.length) {
    for (let i = picks.length; i < Math.min(total, picks.length + 1 + order.length * 2); i++) {
      const s = { overall: i + 1, ...slotFor(i, order, draft.order_type) };
      if (!onClock) onClock = s; else upcoming.push(s);
    }
  }
  return {
    draft: { ...draft, elapsed_ms: elapsedMs(draft), total_picks: total },
    order, games, picks, on_clock: onClock, upcoming,
    server_time: Date.now(),
  };
}

function notifyOnClock(id, reminder = false) {
  const s = draftState(id);
  if (!s.on_clock) return false;
  const u = getUser(s.on_clock.user_id);
  if (!u.email || !u.notify_email) return false;
  const last = s.picks.at(-1);
  const lastLine = last ? `Last pick: ${getUser(last.user_id).display_name} took ${gameLabel(s.games.find(g => g.id === last.game_id))}.\n` : '';
  mail.send(u.email, `${reminder ? 'Reminder: ' : ''}🍁 You're on the clock — ${s.draft.name}`,
    `Hi ${u.display_name},\n\nYou're on the clock for Round ${s.on_clock.round}, Pick ${s.on_clock.pick_in_round} of ${s.draft.name}.\n${lastLine}`,
    `/board/${id}`);
  return true;
}

// --- live updates via Server-Sent Events
const listeners = new Map(); // key -> Set(res)
function broadcast(key, event = 'update') {
  for (const res of listeners.get(String(key)) || []) res.write(`event: ${event}\ndata: {}\n\n`);
}

// ---------------------------------------------------------------- auth routes

app.get('/healthz', (_req, res) => res.send('ok'));

app.post('/api/register', (req, res) => {
  const { username, password, display_name, invite_code, email } = req.body || {};
  if (invite_code !== INVITE_CODE) fail(403, 'Invalid invite code');
  if (!/^[a-z0-9_.-]{3,24}$/i.test(username || '')) fail(400, 'Username: 3-24 letters, numbers, _ . -');
  if (!password || password.length < 6) fail(400, 'Password must be at least 6 characters');
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) fail(409, 'Username taken');
  const first = !db.prepare('SELECT 1 FROM users LIMIT 1').get();
  const palette = ['#1e5bc6', '#e0a526', '#2fa36b', '#c8463d', '#8e5bd6', '#2a9fb8'];
  const count = db.prepare('SELECT COUNT(*) c FROM users').get().c;
  const r = db.prepare(`INSERT INTO users (username, display_name, email, password_hash, is_admin, color)
                        VALUES (?, ?, ?, ?, ?, ?)`)
    .run(username, (display_name || username).slice(0, 40), email?.trim() || null, hashPassword(password), first ? 1 : 0, palette[count % palette.length]);
  createSession(req, res, r.lastInsertRowid);
  res.json({ user: publicUser(getUser(r.lastInsertRowid)) });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE username = ?').get(username || '');
  if (!u || !checkPassword(password || '', u.password_hash)) fail(401, 'Wrong username or password');
  createSession(req, res, u.id);
  res.json({ user: publicUser(u) });
});

app.post('/api/logout', (req, res) => {
  if (req.sid) db.prepare('DELETE FROM sessions WHERE token = ?').run(req.sid);
  res.setHeader('Set-Cookie', 'sid=; Path=/; Max-Age=0');
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => res.json({ user: publicUser(req.user) || null, mail_enabled: mail.enabled }));

app.put('/api/me', auth, (req, res) => {
  const { display_name, email, color, favorite_player, notify_email } = req.body || {};
  if (color && !/^#[0-9a-f]{6}$/i.test(color)) fail(400, 'Colour must be a hex value like #1e5bc6');
  db.prepare(`UPDATE users SET display_name = COALESCE(?, display_name), email = ?, color = COALESCE(?, color),
              favorite_player = ?, notify_email = ? WHERE id = ?`)
    .run(display_name?.trim().slice(0, 40) || null, email?.trim() || null, color || null, favorite_player?.trim() || null,
      notify_email === false || notify_email === 'off' ? 0 : 1, req.user.id);
  res.json({ user: publicUser(getUser(req.user.id)) });
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
                (SELECT COALESCE(SUM(seats), 0) FROM games g WHERE g.draft_id = d.id) AS seat_count,
                (SELECT COUNT(*) FROM picks p WHERE p.draft_id = d.id) AS pick_count
    FROM drafts d ORDER BY d.status = 'complete', d.season DESC, d.id DESC`).all();
  res.json(rows.map(d => {
    const out = { ...d, total_picks: d.seat_mode === 'single' ? d.seat_count : d.game_count };
    if (d.status === 'live') { const s = draftState(d.id); out.on_clock = s.on_clock; out.elapsed_ms = s.draft.elapsed_ms; }
    return out;
  }));
});

// Schedules shipped in /schedules (e.g. the official Leafs CSV)
app.get('/api/schedules', auth, (_req, res) => {
  const files = fs.existsSync(SCHEDULE_DIR) ? fs.readdirSync(SCHEDULE_DIR).filter(f => f.endsWith('.csv')).sort().reverse() : [];
  res.json(files);
});

app.post('/api/schedule/preview', auth, admin, (req, res) => {
  const { source, csv, file, season_start } = req.body || {};
  if (source === 'csv') return res.json(parseScheduleCsv(csv));
  if (source === 'bundled') {
    const name = path.basename(String(file || ''));
    const full = path.join(SCHEDULE_DIR, name);
    if (!name.endsWith('.csv') || !fs.existsSync(full)) fail(404, 'Schedule file not found');
    return res.json(parseScheduleCsv(fs.readFileSync(full, 'utf8')));
  }
  if (source === 'none') return res.json({ games: [], errors: [] });
  res.json({ games: sampleSchedule(Number(season_start) || new Date().getFullYear()), errors: [] });
});

function cleanGame(g, kind) {
  const date = normDate(g.date);
  if (!date) fail(400, `Bad game date "${g.date}"`);
  const opp = g.opponent === 'TBD' ? 'TBD' : findTeam(g.opponent)?.abbr;
  if (!opp) fail(400, `Unknown opponent "${g.opponent}"`);
  const type = kind === 'playoff' ? 'playoff' : normType(g.type);
  return { date, time: normTime(g.time), opponent: opp, type, price: normPrice(g.price), notes: String(g.notes || '').slice(0, 80) };
}

app.post('/api/drafts', auth, admin, (req, res) => {
  const { name, season, kind, mode, order_type, warn_secs, user_ids, games } = req.body || {};
  if (!name?.trim()) fail(400, 'Name is required');
  if (!Array.isArray(user_ids) || user_ids.length < 2) fail(400, 'Choose at least two partners for the draft order');
  if (new Set(user_ids).size !== user_ids.length) fail(400, 'A partner appears twice in the draft order');
  if (!Array.isArray(games) || !games.length) fail(400, 'The schedule has no games');
  const k = kind === 'playoff' ? 'playoff' : 'season';
  const clean = games.map(g => cleanGame(g, k));
  const id = tx(() => {
    const d = db.prepare(`INSERT INTO drafts (name, season, kind, seat_mode, mode, order_type, warn_secs, created_by)
                          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(name.trim(), (season || '').trim(), k, k === 'playoff' ? 'single' : 'pair', mode === 'async' ? 'async' : 'live',
        order_type === 'linear' ? 'linear' : 'snake', Math.max(0, Number(warn_secs ?? 120) || 0), req.user.id);
    const draftId = Number(d.lastInsertRowid);
    const insO = db.prepare('INSERT INTO draft_order (draft_id, position, user_id) VALUES (?, ?, ?)');
    user_ids.forEach((uid, i) => insO.run(draftId, i + 1, uid));
    const insG = db.prepare('INSERT INTO games (draft_id, date, time, opponent, type, price, notes) VALUES (?, ?, ?, ?, ?, ?, ?)');
    clean.forEach(g => insG.run(draftId, g.date, g.time, g.opponent, g.type, g.price, g.notes));
    return draftId;
  });
  res.json({ id });
});

// Add a game to a draft that hasn't finished (e.g. a playoff home game once it's scheduled).
app.post('/api/drafts/:id/games', auth, admin, (req, res) => {
  const d = db.prepare('SELECT * FROM drafts WHERE id = ?').get(req.params.id);
  if (!d) fail(404, 'Draft not found');
  if (d.status === 'complete') fail(400, 'Draft is complete');
  const g = cleanGame(req.body || {}, d.kind);
  db.prepare('INSERT INTO games (draft_id, date, time, opponent, type, price, notes) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(d.id, g.date, g.time, g.opponent, g.type, g.price, g.notes);
  broadcast(d.id);
  res.json(draftState(d.id));
});

app.delete('/api/drafts/:id', auth, admin, (req, res) => {
  const d = db.prepare('SELECT status, source FROM drafts WHERE id = ?').get(req.params.id);
  if (!d) fail(404, 'Draft not found');
  if (d.status === 'complete' && d.source !== 'import') fail(400, 'Completed drafts are kept for history');
  db.prepare('DELETE FROM drafts WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.get('/api/drafts/:id', auth, (req, res) => res.json(draftState(req.params.id)));

app.get('/api/events/:key', auth, (req, res) => {
  const key = String(req.params.key);
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('retry: 3000\n\n');
  if (!listeners.has(key)) listeners.set(key, new Set());
  listeners.get(key).add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => { clearInterval(ping); listeners.get(key)?.delete(res); });
});

app.post('/api/drafts/:id/start', auth, admin, (req, res) => {
  const d = db.prepare('SELECT * FROM drafts WHERE id = ?').get(req.params.id);
  if (!d) fail(404, 'Draft not found');
  if (d.status !== 'setup') fail(400, 'Draft already started');
  const now = Date.now();
  db.prepare("UPDATE drafts SET status = 'live', started_at = ?, clock_started_at = ?, paused_ms = 0, paused_at = NULL WHERE id = ?")
    .run(now, now, d.id);
  if (d.mode === 'async') notifyOnClock(d.id);
  broadcast(d.id); broadcast('home');
  res.json(draftState(d.id));
});

app.post('/api/drafts/:id/pick', auth, (req, res) => {
  const id = Number(req.params.id);
  const gameId = Number(req.body?.game_id);
  let done = false, mode;
  tx(() => {
    const s = draftState(id);
    mode = s.draft.mode;
    if (s.draft.status !== 'live') fail(400, 'Draft is not live');
    if (!s.on_clock) fail(400, 'No pick on the clock');
    const onBehalf = s.on_clock.user_id !== req.user.id;
    if (onBehalf && !req.user.is_admin) fail(403, "It's not your pick");
    const game = s.games.find(g => g.id === gameId);
    if (!game) fail(404, 'Game not found in this draft');
    const taken = s.picks.filter(p => p.game_id === gameId);
    const single = s.draft.seat_mode === 'single';
    if (single ? taken.length >= game.seats : taken.length) fail(409, 'That game is already taken');
    const seat = single ? taken.length + 1 : 0;
    const now = Date.now();
    const secs = elapsedMs(s.draft, now) / 1000;
    db.prepare(`INSERT INTO picks (draft_id, overall, round, pick_in_round, user_id, owner_id, game_id, seat, made_by, seconds_taken, picked_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, s.on_clock.overall, s.on_clock.round, s.on_clock.pick_in_round, s.on_clock.user_id, s.on_clock.user_id, gameId, seat, req.user.id, secs, now);
    done = s.picks.length + 1 >= s.draft.total_picks;
    db.prepare(`UPDATE drafts SET clock_started_at = ?, paused_ms = 0, paused_at = ?, status = ?, completed_at = ? WHERE id = ?`)
      .run(now, s.draft.paused_at ? now : null, done ? 'complete' : 'live', done ? now : null, id);
  });
  if (!done && mode === 'async') notifyOnClock(id);
  broadcast(id); broadcast('home');
  res.json(draftState(id));
});

// Re-send the "you're on the clock" email (useful for async drafts).
app.post('/api/drafts/:id/nudge', auth, (req, res) => {
  const sent = notifyOnClock(Number(req.params.id), true);
  if (!sent) fail(400, 'That partner has no email address or has notifications turned off');
  res.json({ ok: true, mail_enabled: mail.enabled });
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
    const d = db.prepare('SELECT * FROM drafts WHERE id = ?').get(id);
    if (d?.source === 'import') fail(400, 'Imported drafts cannot be edited here');
    const last = db.prepare('SELECT * FROM picks WHERE draft_id = ? ORDER BY overall DESC LIMIT 1').get(id);
    if (!last) fail(400, 'No picks to undo');
    if (db.prepare("SELECT 1 FROM trade_items i JOIN trades t ON t.id = i.trade_id WHERE i.pick_id = ? AND t.status = 'accepted'").get(last.id))
      fail(400, 'That pick has been traded and cannot be undone');
    db.prepare('DELETE FROM picks WHERE id = ?').run(last.id);
    // Put the previous picker back on the clock, keeping the time they had already used.
    const now = Date.now();
    db.prepare(`UPDATE drafts SET status = 'live', completed_at = NULL, clock_started_at = ?, paused_ms = 0, paused_at = NULL WHERE id = ?`)
      .run(now - Math.round((last.seconds_taken || 0) * 1000), id);
  });
  broadcast(id); broadcast('home');
  res.json(draftState(id));
});

// ---------------------------------------------------------------- historical import

const HISTORY_DIR = path.join(__dirname, 'history');

/**
 * Import a past draft from CSV. One row per pick. Columns:
 *   partner (username or display name), date, opponent/team — required
 *   pick/overall, time, price, type, seconds/time taken, notes — optional
 * Rows with no partner are games nobody drafted. If no row has a pick number, the
 * pick sequence is treated as unknown (only who-got-which-game is kept).
 * `aliases` maps spreadsheet names (e.g. "Q") to user ids; `order` lists round-1 order by name.
 * Throws HttpError; unmatched partner names come back in err.unmatched.
 */
function importDraft({ name, season, kind, order_type, csv, order, notes, aliases = {}, userId }) {
  if (!name?.trim()) fail(400, 'Name is required');
  const parsed = readCsv(csv || '', [['partner', 'player', 'owner', 'name', 'user', 'selector'], ['date'], ['opponent', 'team', 'opp']]);
  if (!parsed) fail(400, 'Need a header row with partner, date and opponent/team columns');
  const { col, rows } = parsed;
  const iP = col('partner', 'selector', 'player', 'owner', 'user', 'name'), iD = col('date'), iO = col('opponent', 'team', 'opp'),
    iN = col('overall', 'pick', '#'), iT = col('time'), iPr = col('price'), iTy = col('type'),
    iS = col('seconds', 'time taken', 'time_taken', 'duration'), iNo = col('notes', 'note');
  const users = db.prepare('SELECT * FROM users').all();
  const aliasKey = Object.fromEntries(Object.entries(aliases).map(([k, v]) => [k.trim().toLowerCase(), Number(v)]));
  const findUser = s => {
    const k = String(s).trim().toLowerCase();
    if (aliasKey[k]) return users.find(u => u.id === aliasKey[k]);
    return users.find(u => [u.username, u.display_name].some(x => x.toLowerCase() === k));
  };
  const errors = [], unmatched = new Set(), picks = [], extras = [];
  const k = kind === 'playoff' ? 'playoff' : 'season';
  for (const { line, cells } of rows) {
    const who = (cells[iP] || '').trim();
    const opp = cells[iO] || '';
    const team = /^tbd$/i.test(opp) ? { abbr: 'TBD' } : findTeam(opp);
    const date = normDate(cells[iD]);
    if (!team) { errors.push(`Row ${line}: unknown opponent "${opp}"`); continue; }
    if (!date) { errors.push(`Row ${line}: bad date "${cells[iD]}"`); continue; }
    const g = {
      date, opponent: team.abbr, time: iT >= 0 && iT !== iS && cells[iT] ? normTime(cells[iT]) : '', price: iPr >= 0 ? normPrice(cells[iPr]) : null,
      type: k === 'playoff' ? 'playoff' : normType(iTy >= 0 ? cells[iTy] : ''), notes: iNo >= 0 ? String(cells[iNo] || '').slice(0, 80) : '',
    };
    if (!who) { extras.push(g); continue; }
    const u = findUser(who);
    if (!u) { unmatched.add(who); continue; }
    picks.push({ ...g, user: u, overall: iN >= 0 ? Number(cells[iN]) || null : null, seconds: iS >= 0 ? normSeconds(cells[iS]) : null });
  }
  if (unmatched.size) { const e = new HttpError(400, `No account for: ${[...unmatched].join(', ')}`); e.unmatched = [...unmatched]; throw e; }
  if (errors.length) { const e = new HttpError(400, `${errors.length} problem(s) in the file`); e.errors = errors; throw e; }
  if (!picks.length) fail(400, 'No picks found');

  const recorded = picks.every(p => p.overall);
  picks.forEach((p, i) => (p.seq = i));
  picks.sort(recorded ? (a, b) => a.overall - b.overall : (a, b) => a.date.localeCompare(b.date) || a.seq - b.seq);
  let orderIds = [...new Set(picks.map(p => p.user.id))];
  if (Array.isArray(order) && order.length) {
    const named = [...new Set(order.map(n => findUser(n)?.id).filter(Boolean))];
    orderIds = [...named, ...orderIds.filter(id => !named.includes(id))];
  }
  const n = orderIds.length;
  return tx(() => {
    const d = db.prepare(`INSERT INTO drafts (name, season, kind, seat_mode, order_type, status, source, created_by, warn_secs, notes, order_recorded)
                          VALUES (?, ?, ?, ?, ?, 'complete', 'import', ?, 0, ?, ?)`)
      .run(name.trim(), (season || '').trim(), k, k === 'playoff' ? 'single' : 'pair', order_type === 'linear' ? 'linear' : 'snake', userId,
        String(notes || '').slice(0, 4000), recorded ? 1 : 0);
    const draftId = Number(d.lastInsertRowid);
    orderIds.forEach((uid, i) => db.prepare('INSERT INTO draft_order (draft_id, position, user_id) VALUES (?, ?, ?)').run(draftId, i + 1, uid));
    const gameIds = new Map(); // date|opp -> { id, seats used }
    const insG = db.prepare('INSERT INTO games (draft_id, date, time, opponent, type, price, notes) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const insP = db.prepare(`INSERT INTO picks (draft_id, overall, round, pick_in_round, user_id, owner_id, game_id, seat, made_by, seconds_taken, picked_at)
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL)`);
    picks.forEach((p, i) => {
      const key = `${p.date}|${p.opponent}|${p.time}`;
      let g = gameIds.get(key);
      if (!g) { g = { id: Number(insG.run(draftId, p.date, p.time, p.opponent, p.type, p.price, p.notes).lastInsertRowid), used: 0 }; gameIds.set(key, g); }
      g.used++;
      if (k !== 'playoff' && g.used > 1) fail(400, `${p.date} vs ${p.opponent} appears twice — for a season draft each game is one pick`);
      insP.run(draftId, i + 1, Math.floor(i / n) + 1, (i % n) + 1, p.user.id, p.user.id, g.id, k === 'playoff' ? g.used : 0, p.seconds);
    });
    extras.forEach(g => insG.run(draftId, g.date, g.time, g.opponent, g.type, g.price, g.notes));
    return { id: draftId, picks: picks.length, order_recorded: recorded };
  });
}

function sendImportError(res, e) {
  if (!(e instanceof HttpError)) throw e;
  res.status(e.status).json({ error: e.message, errors: e.errors, unmatched: e.unmatched });
}

app.post('/api/drafts/import', auth, admin, (req, res) => {
  try { res.json(importDraft({ ...req.body, userId: req.user.id })); }
  catch (e) { sendImportError(res, e); }
});

// Seasons converted from the partners' Ticket Tracker workbook (tools/convert_ticket_tracker.py).
function bundledManifest() {
  const f = path.join(HISTORY_DIR, 'manifest.json');
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : [];
}

function manifestNotes(m) {
  const lines = [];
  if (!m.pick_order_recorded) lines.push('The pick-by-pick order was not recorded this season — only who got each game.');
  if (m.freebie) lines.push(`Freebie: ${m.freebie}`);
  for (const r of m.report || []) if (!/^corrected|row order/.test(r)) lines.push(`Spreadsheet note: ${r}`);
  lines.push(`Imported from worksheet "${m.sheet.trim()}".`);
  return lines.join('\n');
}

app.get('/api/history/bundled', auth, admin, (_req, res) => {
  const imported = new Set(db.prepare("SELECT season FROM drafts WHERE source = 'import' AND kind = 'season'").all().map(r => r.season));
  const names = new Set();
  for (const m of bundledManifest()) m.order.forEach(n => names.add(n));
  res.json({ seasons: bundledManifest().map(m => ({ ...m, imported: imported.has(m.season) })), partner_names: [...names] });
});

app.post('/api/history/bundled', auth, admin, (req, res) => {
  const { seasons = [], aliases = {}, replace = false } = req.body || {};
  const manifest = bundledManifest();
  const results = [];
  for (const season of seasons) {
    const m = manifest.find(x => x.season === season);
    if (!m) { results.push({ season, error: 'not in bundled history' }); continue; }
    const existing = db.prepare("SELECT id FROM drafts WHERE source = 'import' AND kind = 'season' AND season = ?").all(season);
    if (existing.length && !replace) { results.push({ season, skipped: 'already imported' }); continue; }
    try {
      existing.forEach(d => db.prepare('DELETE FROM drafts WHERE id = ?').run(d.id));
      const csv = fs.readFileSync(path.join(HISTORY_DIR, path.basename(m.file)), 'utf8');
      const r = importDraft({ name: `${season} Season Draft`, season, kind: 'season', order_type: 'snake', csv, order: m.order, notes: manifestNotes(m), aliases, userId: req.user.id });
      results.push({ season, ...r });
    } catch (e) {
      if (!(e instanceof HttpError)) throw e;
      if (e.unmatched) return res.status(400).json({ error: e.message, unmatched: e.unmatched });
      results.push({ season, error: e.message, errors: e.errors });
    }
  }
  broadcast('home');
  res.json({ results });
});

// Games and value per partner per season, for the all-time view.
app.get('/api/history/summary', auth, (_req, res) => {
  res.json(db.prepare(`
    SELECT d.id AS draft_id, d.name, d.season, d.kind, d.status, d.source, p.owner_id AS user_id,
           COUNT(*) AS games, SUM(CASE WHEN p.seat = 0 THEN COALESCE(g.price, 0) * g.seats ELSE COALESCE(g.price, 0) END) AS value,
           SUM(CASE WHEN strftime('%w', g.date) IN ('0', '5', '6') THEN 1 ELSE 0 END) AS weekend,
           SUM(CASE WHEN strftime('%w', g.date) = '6' THEN 1 ELSE 0 END) AS saturday
    FROM picks p JOIN drafts d ON d.id = p.draft_id JOIN games g ON g.id = p.game_id
    GROUP BY d.id, p.owner_id ORDER BY d.season DESC, d.id DESC`).all());
});

// ---------------------------------------------------------------- trades

function tradeView(t) {
  const items = db.prepare(`SELECT i.side, p.id AS pick_id, p.seat, p.owner_id, g.date, g.time, g.opponent, g.price, g.type
                            FROM trade_items i JOIN picks p ON p.id = i.pick_id JOIN games g ON g.id = p.game_id
                            WHERE i.trade_id = ? ORDER BY g.date`).all(t.id);
  return { ...t, give: items.filter(i => i.side === 'give'), get: items.filter(i => i.side === 'get') };
}

function validateTradeItems(draftId, fromUser, toUser, give, get) {
  const today = torontoToday();
  const load = (ids, owner, who) => ids.map(pid => {
    const p = db.prepare('SELECT p.*, g.date FROM picks p JOIN games g ON g.id = p.game_id WHERE p.id = ? AND p.draft_id = ?').get(pid, draftId);
    if (!p) fail(400, 'A game in this trade is not part of the draft');
    if (p.owner_id !== owner) fail(409, `${who} no longer holds one of the games in this trade`);
    if (p.date < today) fail(400, 'Games that have already been played cannot be traded');
    return p;
  });
  load(give, fromUser, 'The proposer');
  load(get, toUser, 'The other partner');
}

app.get('/api/trades', auth, (req, res) => {
  const rows = req.query.draft_id
    ? db.prepare('SELECT * FROM trades WHERE draft_id = ? ORDER BY id DESC').all(req.query.draft_id)
    : db.prepare('SELECT * FROM trades ORDER BY id DESC LIMIT 200').all();
  res.json(rows.map(tradeView));
});

app.post('/api/trades', auth, (req, res) => {
  const { draft_id, to_user, give = [], get = [], message = '' } = req.body || {};
  const d = db.prepare('SELECT * FROM drafts WHERE id = ?').get(draft_id);
  if (!d) fail(404, 'Draft not found');
  if (d.status !== 'complete') fail(400, 'Trades open once the draft is complete');
  if (Number(to_user) === req.user.id) fail(400, "You can't trade with yourself");
  if (!db.prepare('SELECT 1 FROM draft_order WHERE draft_id = ? AND user_id = ?').get(draft_id, to_user)) fail(400, 'That partner is not in this draft');
  if (!give.length && !get.length) fail(400, 'Pick at least one game');
  if (new Set([...give, ...get]).size !== give.length + get.length) fail(400, 'A game appears twice');
  validateTradeItems(d.id, req.user.id, Number(to_user), give, get);
  const id = tx(() => {
    const t = db.prepare('INSERT INTO trades (draft_id, from_user, to_user, message, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(d.id, req.user.id, to_user, String(message).slice(0, 500), Date.now());
    const ins = db.prepare('INSERT INTO trade_items (trade_id, pick_id, side) VALUES (?, ?, ?)');
    give.forEach(p => ins.run(t.lastInsertRowid, p, 'give'));
    get.forEach(p => ins.run(t.lastInsertRowid, p, 'get'));
    return Number(t.lastInsertRowid);
  });
  const to = getUser(to_user);
  if (to.email && to.notify_email) {
    const t = tradeView(db.prepare('SELECT * FROM trades WHERE id = ?').get(id));
    const lines = arr => arr.map(i => `  • ${gameLabel(i)}${i.seat ? ` (seat ${i.seat})` : ''}`).join('\n') || '  (nothing)';
    mail.send(to.email, `🍁 Trade request from ${req.user.display_name}`,
      `${req.user.display_name} proposed a trade (${d.name}).\n\nYou would receive:\n${lines(t.give)}\n\nYou would give:\n${lines(t.get)}\n${t.message ? `\nMessage: "${t.message}"\n` : ''}`,
      '/trades');
  }
  broadcast('trades');
  res.json({ id });
});

app.post('/api/trades/:id/:action', auth, (req, res) => {
  const { action } = req.params;
  if (!['accept', 'decline', 'cancel'].includes(action)) fail(404, 'Unknown action');
  const t = db.prepare('SELECT * FROM trades WHERE id = ?').get(req.params.id);
  if (!t) fail(404, 'Trade not found');
  if (t.status !== 'pending') fail(400, `Trade is already ${t.status}`);
  if (action === 'cancel' ? t.from_user !== req.user.id : t.to_user !== req.user.id) fail(403, 'Not your trade to ' + action);
  const now = Date.now();
  if (action === 'accept') {
    tx(() => {
      const v = tradeView(t);
      validateTradeItems(t.draft_id, t.from_user, t.to_user, v.give.map(i => i.pick_id), v.get.map(i => i.pick_id));
      const setOwner = db.prepare('UPDATE picks SET owner_id = ? WHERE id = ?');
      v.give.forEach(i => setOwner.run(t.to_user, i.pick_id));
      v.get.forEach(i => setOwner.run(t.from_user, i.pick_id));
      db.prepare("UPDATE trades SET status = 'accepted', resolved_at = ? WHERE id = ?").run(now, t.id);
      // Any other pending offer involving these games is now stale.
      db.prepare(`UPDATE trades SET status = 'expired', resolved_at = ? WHERE status = 'pending' AND id IN (
                    SELECT trade_id FROM trade_items WHERE pick_id IN (SELECT pick_id FROM trade_items WHERE trade_id = ?))`).run(now, t.id);
    });
  } else {
    db.prepare('UPDATE trades SET status = ?, resolved_at = ? WHERE id = ?').run(action === 'cancel' ? 'cancelled' : 'declined', now, t.id);
  }
  if (action !== 'cancel') {
    const from = getUser(t.from_user);
    if (from.email && from.notify_email)
      mail.send(from.email, `🍁 ${req.user.display_name} ${action}ed your trade`, `${req.user.display_name} ${action}ed your trade request.`, '/trades');
  }
  broadcast('trades'); broadcast(t.draft_id);
  res.json({ ok: true });
});

// SPA fallback
app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.use((err, _req, res, _next) => {
  if (!(err instanceof HttpError)) console.error(err);
  res.status(err.status || 500).json({ error: err.status ? err.message : 'Server error' });
});

app.listen(PORT, () => console.log(`Leafs draft board on http://localhost:${PORT}${mail.enabled ? '' : ' (email not configured: messages are logged)'}`));
