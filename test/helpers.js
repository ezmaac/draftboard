// Shared set-up for the API tests: a server per test file, partners, and draft builders.
const assert = require('node:assert/strict');
const { startServer, ApiError } = require('../tools/lib/harness');

/**
 * Register partners in order; the first becomes the commissioner.
 * Returns { server, admin, clients: { name: Client }, ids: { name: id } }.
 */
async function league(server, names = ['quinn', 'abela', 'pope'], opts = {}) {
  const clients = {}, ids = {};
  for (const n of names) {
    const c = server.client();
    await c.register(n, { email: opts.emails ? `${n}@example.test` : undefined });
    clients[n] = c; ids[n] = c.user.id;
  }
  return { admin: clients[names[0]], clients, ids };
}

/** Games from the bundled official 2026-27 schedule (42 home games). */
async function bundledGames(admin) {
  const files = await admin.get('/api/schedules');
  const file = files.find(f => f.includes('2026-2027'));
  const { games, errors } = await admin.post('/api/schedule/preview', { source: 'bundled', file });
  assert.deepEqual(errors, []);
  return games;
}

/** `n` simple future (or past) regular-season games, one per day. */
function makeGames(n, { start = '2030-01-01', price = 200 } = {}) {
  const d0 = new Date(`${start}T12:00:00Z`);
  const teams = ['MTL', 'OTT', 'BOS', 'DET', 'BUF', 'TBL', 'FLA', 'NYR', 'CHI', 'EDM'];
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(d0.getTime() + i * 86400000).toISOString().slice(0, 10);
    return { date: d, time: '19:00', opponent: teams[i % teams.length], type: 'Regular Season', price: price + i };
  });
}

/** Create (and optionally start) a season draft. Returns the draft id. */
async function seasonDraft(admin, userIds, { games, start = true, name = 'Test Season Draft', season = '2030-31', ...rest } = {}) {
  const { id } = await admin.post('/api/drafts', { name, season, kind: 'season', mode: 'live', order_type: 'snake', user_ids: userIds, games, ...rest });
  if (start) await admin.post(`/api/drafts/${id}/start`);
  return id;
}

/** First game nobody has fully taken. */
const openGame = s => {
  const taken = {};
  for (const p of s.picks) taken[p.game_id] = (taken[p.game_id] || 0) + 1;
  return s.games.find(g => (taken[g.id] || 0) < (g.single ? g.seats : 1));
};

/** The client whose turn it is. */
const onClockClient = (s, clients) => Object.values(clients).find(c => c.user.id === s.on_clock.user_id);

/** Make picks (each by the partner on the clock) until `count` are made or the draft completes. */
async function pickN(admin, id, clients, count = Infinity) {
  let s = await admin.get(`/api/drafts/${id}`);
  for (let i = 0; i < count && s.draft.status === 'live'; i++) {
    s = await onClockClient(s, clients).post(`/api/drafts/${id}/pick`, { game_id: openGame(s).id });
  }
  return s;
}

/** Assert a request fails with the given status; returns the error body. */
async function rejects(promise, status, messageRe) {
  try { await promise; } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    assert.equal(e.status, status, e.message);
    if (messageRe) assert.match(e.data.error, messageRe);
    return e.data;
  }
  assert.fail(`Expected HTTP ${status} but the request succeeded`);
}

module.exports = { startServer, league, bundledGames, makeGames, seasonDraft, openGame, onClockClient, pickN, rejects };
