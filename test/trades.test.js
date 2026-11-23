// REQUIREMENTS §13 item 8: trades.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, league, makeGames, seasonDraft, pickN, rejects } = require('./helpers');

let server, admin, clients, ids, draftId, state;
const mine = (uid) => state.picks.filter(p => p.owner_id === uid);
const pastGame = (uid) => mine(uid).find(p => state.games.find(g => g.id === p.game_id).date < '2025-01-01');
const futureGames = (uid) => mine(uid).filter(p => state.games.find(g => g.id === p.game_id).date > '2029-01-01');
const refresh = async () => { state = await admin.get(`/api/drafts/${draftId}`); };

before(async () => {
  server = await startServer();
  ({ admin, clients, ids } = await league(server, ['quinn', 'abela', 'pope'], { emails: true }));
  // 9 future games plus 3 already played (one each, since the snake order hands them out in turn).
  const games = [...makeGames(3, { start: '2020-01-01' }), ...makeGames(9, { start: '2030-01-01' })];
  draftId = await seasonDraft(admin, [ids.quinn, ids.abela, ids.pope], { games });
  await refresh();
  await rejects(clients.quinn.post('/api/trades', { draft_id: draftId, to_user: ids.abela, give: [], get: [] }), 400, /once the draft is complete/);
  await pickN(admin, draftId, clients);
  await refresh();
  assert.equal(state.draft.status, 'complete');
});
after(() => server?.stop());

test('propose and accept: owners swap, the original pick is preserved, emails go out', async () => {
  const give = futureGames(ids.quinn)[0], get = futureGames(ids.abela)[0];
  const { id } = await clients.quinn.post('/api/trades', { draft_id: draftId, to_user: ids.abela, give: [give.id], get: [get.id], message: 'Swap?' });
  assert.match(server.log(), /to=abela@example\.test subject="🍁 Trade request from quinn"[\s\S]*Message: "Swap\?"/);
  await rejects(clients.quinn.post(`/api/trades/${id}/accept`), 403, /Not your trade/);
  await rejects(clients.pope.post(`/api/trades/${id}/accept`), 403);
  await clients.abela.post(`/api/trades/${id}/accept`);
  await refresh();
  const g = state.picks.find(p => p.id === give.id), r = state.picks.find(p => p.id === get.id);
  assert.equal(g.owner_id, ids.abela); assert.equal(g.user_id, ids.quinn, 'draft result kept');
  assert.equal(r.owner_id, ids.quinn); assert.equal(r.user_id, ids.abela);
  assert.match(server.log(), /to=quinn@example\.test subject="🍁 abela accepted your trade"/);
  const [t] = await clients.pope.get(`/api/trades?draft_id=${draftId}`);
  assert.equal(t.status, 'accepted');
  await rejects(clients.abela.post(`/api/trades/${id}/decline`), 400, /already accepted/);
});

test('decline and withdraw', async () => {
  const give = futureGames(ids.pope)[0];
  const a = await clients.pope.post('/api/trades', { draft_id: draftId, to_user: ids.quinn, give: [give.id] });   // one-sided give
  await clients.quinn.post(`/api/trades/${a.id}/decline`);
  const b = await clients.pope.post('/api/trades', { draft_id: draftId, to_user: ids.quinn, get: [futureGames(ids.quinn)[0].id] }); // one-sided request
  await rejects(clients.quinn.post(`/api/trades/${b.id}/cancel`), 403);
  await clients.pope.post(`/api/trades/${b.id}/cancel`);
  const list = await clients.quinn.get(`/api/trades?draft_id=${draftId}`);
  assert.equal(list.find(t => t.id === a.id).status, 'declined');
  assert.equal(list.find(t => t.id === b.id).status, 'cancelled');
});

test('accepting a trade expires other pending offers for the same games', async () => {
  const contested = futureGames(ids.pope)[1];
  const first = await clients.quinn.post('/api/trades', { draft_id: draftId, to_user: ids.pope, get: [contested.id] });
  const second = await clients.abela.post('/api/trades', { draft_id: draftId, to_user: ids.pope, get: [contested.id] });
  await clients.pope.post(`/api/trades/${first.id}/accept`);
  const list = await clients.quinn.get(`/api/trades?draft_id=${draftId}`);
  assert.equal(list.find(t => t.id === second.id).status, 'expired');
  await rejects(clients.pope.post(`/api/trades/${second.id}/accept`), 400, /already expired/);
  await refresh();
});

test('games already played, games you do not hold, and bad offers are refused', async () => {
  const played = pastGame(ids.quinn);
  assert.ok(played, 'quinn holds a game from 2020');
  await rejects(clients.quinn.post('/api/trades', { draft_id: draftId, to_user: ids.abela, give: [played.id] }), 400, /already been played/);
  await rejects(clients.quinn.post('/api/trades', { draft_id: draftId, to_user: ids.abela, give: [futureGames(ids.pope)[0].id] }), 409, /proposer no longer holds/);
  await rejects(clients.quinn.post('/api/trades', { draft_id: draftId, to_user: ids.quinn, give: [futureGames(ids.quinn)[0].id] }), 400, /yourself/);
  await rejects(clients.quinn.post('/api/trades', { draft_id: draftId, to_user: ids.abela }), 400, /at least one game/);
  const g = futureGames(ids.quinn)[0].id;
  await rejects(clients.quinn.post('/api/trades', { draft_id: draftId, to_user: ids.abela, give: [g, g] }), 400, /appears twice/);
});

test('a traded pick cannot be undone', async () => {
  const last = state.picks.at(-1);
  const owner = Object.values(clients).find(c => c.user.id === last.owner_id);
  const other = Object.values(clients).find(c => c.user.id !== last.owner_id);
  const { id } = await owner.post('/api/trades', { draft_id: draftId, to_user: other.user.id, give: [last.id] });
  await other.post(`/api/trades/${id}/accept`);
  await rejects(admin.post(`/api/drafts/${draftId}/undo`), 400, /traded and cannot be undone/);
});
