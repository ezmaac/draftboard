// REQUIREMENTS §13 item 7: playoff drafts by round and game, single-seat Final, reuse-or-redraw order.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, league, rejects } = require('./helpers');

let server, admin, clients, ids, early;
before(async () => {
  server = await startServer();
  ({ admin, clients, ids } = await league(server));
});
after(() => server?.stop());

const SEASON = '2030-31';
const playoffDraft = (body) => admin.post('/api/drafts', { season: SEASON, kind: 'playoff', mode: 'live', order_type: 'snake', user_ids: [ids.quinn, ids.abela, ids.pope], ...body });

test('rounds 1–3 with home ice yes/no/yes give 11 pair games, order drawn at random by the server', async () => {
  const { id } = await playoffDraft({
    name: 'Playoffs R1-3',
    rounds: [{ round: 1, home_ice: true, opponent: 'BOS' }, { round: 2, home_ice: false }, { round: 3, home_ice: true, price: 500 }],
  });
  early = id;
  const s = await admin.get(`/api/drafts/${id}`);
  assert.equal(s.games.length, 11);
  assert.equal(s.draft.total_picks, 11);
  assert.ok(s.games.every(g => !g.single), 'rounds 1-3 are pairs');
  assert.deepEqual(s.games.filter(g => g.round === 1).map(g => g.game_no), [1, 2, 5, 7]);
  assert.deepEqual(s.games.filter(g => g.round === 2).map(g => g.game_no), [3, 4, 6]);
  assert.ok(s.games.filter(g => g.round === 1).every(g => g.opponent === 'BOS'));
  assert.ok(s.games.filter(g => g.round === 2).every(g => g.opponent === 'TBD' && g.date === ''), 'dates/opponents can be filled in later');
  assert.equal(s.games.find(g => g.round === 1 && g.game_no === 5).notes, 'if necessary');
  assert.match(s.draft.notes, /drawn at random by the app/);
  assert.deepEqual(s.order.map(o => o.user_id).sort(), [ids.quinn, ids.abela, ids.pope].sort());
});

test('a round cannot be drafted twice in the same season', async () => {
  await rejects(playoffDraft({ name: 'Dup', rounds: [{ round: 2, home_ice: true }] }), 400, /Round 2 is already in another/);
});

test('round 4 (the Final): single seats, 8 picks, reusing the earlier order; one partner can take both seats', async () => {
  const prior = await admin.get(`/api/drafts/playoff-prior?season=${SEASON}`);
  assert.equal(prior.id, early);
  const { id } = await playoffDraft({ name: 'Final', rounds: [{ round: 4, home_ice: true }], playoff_order: 'reuse' });
  let s = await admin.get(`/api/drafts/${id}`);
  assert.equal(s.games.length, 4);
  assert.ok(s.games.every(g => g.single && g.seats === 2));
  assert.equal(s.draft.total_picks, 8);
  assert.deepEqual(s.order.map(o => o.user_id), prior.order.map(o => o.user_id));
  assert.match(s.draft.notes, /carried over/);

  await admin.post(`/api/drafts/${id}/start`);
  s = await admin.get(`/api/drafts/${id}`);
  const by = uid => Object.values(clients).find(c => c.user.id === uid);
  const g = s.games[0];
  // Snake with 3 partners: the third partner picks 3rd and 4th — both seats of the same game.
  for (let i = 0; i < 2; i++) s = await by(s.on_clock.user_id).post(`/api/drafts/${id}/pick`, { game_id: s.games[1 + i].id });
  const third = s.on_clock.user_id;
  s = await by(third).post(`/api/drafts/${id}/pick`, { game_id: g.id });
  assert.equal(s.on_clock.user_id, third);
  s = await by(third).post(`/api/drafts/${id}/pick`, { game_id: g.id });
  const seats = s.picks.filter(p => p.game_id === g.id);
  assert.deepEqual(seats.map(p => [p.user_id, p.seat]), [[third, 1], [third, 2]]);
  await rejects(by(s.on_clock.user_id).post(`/api/drafts/${id}/pick`, { game_id: g.id }), 409, /already taken/);
});

test('redraw instead of reuse when the order is edited in setup', async () => {
  const { id } = await admin.post('/api/drafts', { name: 'Other season', season: '2031-32', kind: 'playoff', user_ids: [ids.quinn, ids.abela], rounds: [{ round: 1, home_ice: false }] });
  const s = await admin.put(`/api/drafts/${id}/order`, { user_ids: [ids.quinn, ids.abela, ids.pope], playoff_order: 'random' });
  assert.equal(s.order.length, 3);
  assert.match(s.draft.notes, /drawn at random/);
  assert.equal(await admin.get('/api/drafts/playoff-prior?season=2031-32&before=' + id), null);
});

test('playoff games: fill in date and opponent later, add a game, no duplicate round/game', async () => {
  const s0 = await admin.get(`/api/drafts/${early}`);
  const g = s0.games.find(x => x.round === 2 && x.game_no === 3);
  let s = await admin.put(`/api/drafts/${early}/games/${g.id}`, { date: '2031-05-01', opponent: 'Florida Panthers' });
  const edited = s.games.find(x => x.id === g.id);
  assert.equal(edited.opponent, 'FLA');
  assert.equal(edited.round, 2);
  await rejects(admin.post(`/api/drafts/${early}/games`, { round: 1, game_no: 1 }), 409, /already in this draft/);
  await rejects(admin.post(`/api/drafts/${early}/games`, { round: 5, game_no: 1 }), 400, /round must be 1-4/);
});
