// REQUIREMENTS §13 item 10: private preferences and the suggested next pick.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, league, makeGames, seasonDraft, openGame } = require('./helpers');

let server, admin, clients, ids, draftId;
before(async () => {
  server = await startServer();
  ({ admin, clients, ids } = await league(server));
  draftId = await seasonDraft(admin, [ids.quinn, ids.abela, ids.pope], { games: makeGames(12, { start: '2030-01-01' }) });
});
after(() => server?.stop());

test('no preferences → no suggestion', async () => {
  const r = await clients.abela.get(`/api/drafts/${draftId}/suggestion`);
  assert.deepEqual(r, { enabled: false, has_prefs: false });
});

test('preferences save and are only readable by their owner', async () => {
  const prefs = { opponents: ['OTT', 'BOS'], days: { 6: 'prefer' }, avoid_dates: [{ from: '2030-01-02', to: '2030-01-03', label: 'Trip' }], bogus: 1 };
  const r = await clients.abela.put('/api/me/prefs', { prefs });
  assert.equal(r.active, true);
  assert.deepEqual(r.prefs.opponents, ['OTT', 'BOS']);
  assert.equal(r.prefs.bogus, undefined, 'unknown fields are dropped');
  assert.deepEqual((await clients.abela.get('/api/me/prefs')).prefs.opponents, ['OTT', 'BOS']);
  // Nobody else sees them: not other partners, not the commissioner, not in user lists.
  assert.equal((await clients.pope.get('/api/me/prefs')).active, false);
  assert.equal((await admin.get('/api/me/prefs')).active, false);
  const users = await admin.get('/api/users');
  assert.ok(users.every(u => !('prefs' in u)));
  const state = await admin.get(`/api/drafts/${draftId}`);
  assert.ok(!JSON.stringify(state).includes('Trip'));
});

test('the suggestion is for the requester only and respects avoided dates', async () => {
  const r = await clients.abela.get(`/api/drafts/${draftId}/suggestion`);
  assert.equal(r.enabled, true);
  assert.equal(r.top.length, 3);
  assert.equal(r.picks_remaining, 4);
  const s = await admin.get(`/api/drafts/${draftId}`);
  const top = s.games.find(g => g.id === r.top[0].game_id);
  assert.ok(!['2030-01-02', '2030-01-03'].includes(top.date), 'avoided dates are not suggested first');
  assert.ok(r.top[0].reasons.length > 0);
  // Others asking get their own (none), never abela's.
  assert.equal((await clients.pope.get(`/api/drafts/${draftId}/suggestion`)).enabled, false);
  assert.equal((await admin.get(`/api/drafts/${draftId}/suggestion`)).enabled, false);
});

test('the suggestion updates after picks', async () => {
  let s = await admin.get(`/api/drafts/${draftId}`);
  const before = await clients.abela.get(`/api/drafts/${draftId}/suggestion`);
  // quinn takes abela's top suggestion.
  s = await clients.quinn.post(`/api/drafts/${draftId}/pick`, { game_id: before.top[0].game_id });
  const after = await clients.abela.get(`/api/drafts/${draftId}/suggestion`);
  assert.ok(!after.top.some(t => t.game_id === before.top[0].game_id), 'taken games are no longer suggested');
  assert.ok(openGame(s));
});

test('clearing preferences removes the suggestion', async () => {
  const r = await clients.abela.put('/api/me/prefs', { prefs: {} });
  assert.equal(r.active, false);
  assert.equal((await clients.abela.get(`/api/drafts/${draftId}/suggestion`)).enabled, false);
});
