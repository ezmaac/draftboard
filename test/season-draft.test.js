// REQUIREMENTS §13 items 2, 3, 4 and 6: season drafts, the clock, time outs, live updates, email mode, commissioner controls.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { startServer, league, bundledGames, makeGames, seasonDraft, openGame, pickN, rejects } = require('./helpers');

let server, admin, clients, ids, order;
before(async () => {
  server = await startServer();
  ({ admin, clients, ids } = await league(server, ['quinn', 'abela', 'pope'], { emails: true }));
  order = [ids.quinn, ids.abela, ids.pope];
});
after(() => server?.stop());

test('bundled 2026-27 schedule: 42 games, 14 picks each, snake order', async () => {
  const games = await bundledGames(admin);
  assert.equal(games.length, 42);
  const id = await seasonDraft(admin, order, { games, name: '2026-27 Season Draft', season: '2026-27' });
  let s = await admin.get(`/api/drafts/${id}`);
  assert.equal(s.draft.total_picks, 42);
  assert.equal(s.draft.status, 'live');
  // Snake: round 1 quinn, abela, pope; round 2 pope, abela, quinn.
  const seq = [s.on_clock, ...s.upcoming].slice(0, 6).map(x => x.user_id);
  assert.deepEqual(seq, [ids.quinn, ids.abela, ids.pope, ids.pope, ids.abela, ids.quinn]);
  s = await pickN(admin, id, clients);
  assert.equal(s.draft.status, 'complete');
  for (const uid of order) assert.equal(s.picks.filter(p => p.user_id === uid).length, 14);
});

test('next season order rotates last season’s order (last pick moves to first)', async () => {
  const { previous, suggested } = await admin.get('/api/drafts/next-order');
  assert.equal(previous.name, '2026-27 Season Draft');
  assert.deepEqual(suggested, [ids.pope, ids.quinn, ids.abela]);
});

test('linear order and leftover games go to the top of the order', async () => {
  const id = await seasonDraft(admin, order, { games: makeGames(7), order_type: 'linear' });
  const s = await admin.get(`/api/drafts/${id}`);
  assert.equal(s.draft.total_picks, 7);
  const seq = [s.on_clock, ...s.upcoming].map(x => x.user_id);
  assert.deepEqual(seq.slice(0, 7), [ids.quinn, ids.abela, ids.pope, ids.quinn, ids.abela, ids.pope, ids.quinn]);
  await admin.post(`/api/drafts/${id}/control`, { action: 'reset' });
  await admin.del(`/api/drafts/${id}`);
});

test('only the partner on the clock may pick; a taken game cannot be picked again', async () => {
  const id = await seasonDraft(admin, order, { games: makeGames(6) });
  let s = await admin.get(`/api/drafts/${id}`);
  const g = openGame(s);
  await rejects(clients.abela.post(`/api/drafts/${id}/pick`, { game_id: g.id }), 403, /not your pick/);
  s = await admin.post(`/api/drafts/${id}/pick`, { game_id: g.id });
  await rejects(clients.abela.post(`/api/drafts/${id}/pick`, { game_id: g.id }), 409, /already taken/);
  await rejects(clients.abela.post(`/api/drafts/${id}/pick`, { game_id: 999999 }), 404);
  await admin.post(`/api/drafts/${id}/control`, { action: 'reset' });
  await admin.del(`/api/drafts/${id}`);
});

test('clock: counts up with no limit, pauses, and a pick made while paused restarts it', async () => {
  const id = await seasonDraft(admin, order, { games: makeGames(6), warn_secs: 120 });
  let s = await admin.get(`/api/drafts/${id}`);
  assert.equal(s.draft.warn_secs, 120);
  await rejects(clients.pope.post(`/api/drafts/${id}/pause`), 403, /commissioner or the partner on the clock/);
  s = await clients.quinn.post(`/api/drafts/${id}/pause`);         // quinn is on the clock
  assert.ok(s.draft.paused_at);
  const frozen = s.draft.elapsed_ms;
  await new Promise(r => setTimeout(r, 150));
  s = await admin.get(`/api/drafts/${id}`);
  assert.equal(s.draft.elapsed_ms, frozen, 'paused time does not count');
  s = await clients.quinn.post(`/api/drafts/${id}/pick`, { game_id: openGame(s).id });
  assert.equal(s.draft.paused_at, null, 'the pick restarts the clock');
  assert.ok(s.picks[0].seconds_taken < 1, 'pick time excludes the paused time');
  assert.equal(s.on_clock.user_id, ids.abela);
  // Resume after pausing again
  s = await clients.abela.post(`/api/drafts/${id}/pause`);
  s = await clients.abela.post(`/api/drafts/${id}/pause`);
  assert.equal(s.draft.paused_at, null);
  await admin.post(`/api/drafts/${id}/control`, { action: 'reset' });
  await admin.del(`/api/drafts/${id}`);
});

test('time outs: any participant can call one; picks are blocked until time in', async () => {
  const outsider = server.client(); await outsider.register('outsider');
  const id = await seasonDraft(admin, order, { games: makeGames(6) });
  await rejects(outsider.post(`/api/drafts/${id}/timeout`, { action: 'start' }), 403, /Only partners in this draft/);
  let s = await clients.pope.post(`/api/drafts/${id}/timeout`, { action: 'start' });
  assert.equal(s.draft.timeout.by, ids.pope);
  assert.equal(s.draft.timeout.secs, 180, 'default length is 3 minutes');
  assert.ok(s.draft.paused_at, 'the clock stops');
  await rejects(clients.quinn.post(`/api/drafts/${id}/pick`, { game_id: openGame(s).id }), 409, /Time out called by pope/);
  await rejects(admin.post(`/api/drafts/${id}/pick`, { game_id: openGame(s).id }), 409, /Time out/);
  await rejects(clients.abela.post(`/api/drafts/${id}/timeout`, { action: 'start' }), 409, /already called/);
  await rejects(clients.abela.post(`/api/drafts/${id}/timeout`, { action: 'end' }), 403, /who called it or a commissioner/);
  await rejects(clients.quinn.post(`/api/drafts/${id}/pause`), 400, /time out is running/);
  // The board is still browsable.
  assert.equal((await clients.abela.get(`/api/drafts/${id}`)).games.length, 6);
  s = await clients.pope.post(`/api/drafts/${id}/timeout`, { action: 'end' });
  assert.equal(s.draft.timeout, null);
  assert.equal(s.draft.paused_at, null, 'clock restarts at time in');

  // A commissioner can end someone else's time out and change the length (clamped to 30s–30min).
  await clients.abela.post(`/api/drafts/${id}/timeout`, { action: 'start' });
  s = await admin.post(`/api/drafts/${id}/timeout`, { action: 'end' });
  assert.equal(s.draft.timeout, null);
  assert.equal((await admin.put(`/api/drafts/${id}/settings`, { timeout_secs: 5 })).draft.timeout_secs, 30);
  assert.equal((await admin.put(`/api/drafts/${id}/settings`, { timeout_secs: 99999 })).draft.timeout_secs, 1800);
  await rejects(clients.abela.put(`/api/drafts/${id}/settings`, { timeout_secs: 60 }), 403);

  // A time out that has run past its limit ends on its own.
  await clients.abela.post(`/api/drafts/${id}/timeout`, { action: 'start' });
  const db = new DatabaseSync(server.dbFile);
  db.prepare('UPDATE drafts SET timeout_ends_at = ? WHERE id = ?').run(Date.now() - 1000, id);
  db.close();
  s = await admin.get(`/api/drafts/${id}`);
  assert.equal(s.draft.timeout, null);
  assert.equal(s.draft.paused_at, null);
  await admin.post(`/api/drafts/${id}/control`, { action: 'reset' });
  await admin.del(`/api/drafts/${id}`);
});

test('commissioner controls: draft on behalf, undo, restart clock, restart draft, reset to setup, edit order', async () => {
  const id = await seasonDraft(admin, order, { games: makeGames(6) });
  let s = await admin.get(`/api/drafts/${id}`);
  s = await admin.post(`/api/drafts/${id}/pick`, { game_id: openGame(s).id });   // quinn (self)
  s = await admin.post(`/api/drafts/${id}/pick`, { game_id: openGame(s).id });   // on behalf of abela
  assert.equal(s.picks[1].user_id, ids.abela);
  assert.equal(s.picks[1].made_by, ids.quinn);
  await rejects(clients.abela.post(`/api/drafts/${id}/undo`), 403);
  s = await admin.post(`/api/drafts/${id}/undo`);
  assert.equal(s.picks.length, 1);
  assert.equal(s.on_clock.user_id, ids.abela, 'undo puts the previous partner back on the clock');
  s = await admin.post(`/api/drafts/${id}/control`, { action: 'reset_clock' });
  assert.ok(s.draft.elapsed_ms < 1000);
  s = await admin.post(`/api/drafts/${id}/control`, { action: 'restart' });
  assert.equal(s.picks.length, 0);
  assert.equal(s.draft.status, 'live');
  await rejects(admin.put(`/api/drafts/${id}/order`, { user_ids: [ids.pope, ids.quinn] }), 400, /Reset the draft to setup/);
  s = await admin.post(`/api/drafts/${id}/control`, { action: 'reset' });
  assert.equal(s.draft.status, 'setup');
  s = await admin.put(`/api/drafts/${id}/order`, { user_ids: [ids.pope, ids.quinn] });
  assert.deepEqual(s.order.map(o => o.user_id), [ids.pope, ids.quinn]);
  await rejects(admin.put(`/api/drafts/${id}/order`, { user_ids: [ids.pope] }), 400, /at least two/);
  await rejects(admin.put(`/api/drafts/${id}/order`, { user_ids: [ids.pope, ids.pope] }), 400, /twice/);
  await admin.del(`/api/drafts/${id}`);
});

test('games editor: add, edit and remove games; picked games and live drafts are protected', async () => {
  const id = await seasonDraft(admin, order, { games: makeGames(3), start: false });
  let s = await admin.post(`/api/drafts/${id}/games`, { date: '2030-03-01', opponent: 'Montreal Canadiens', price: 300 });
  assert.equal(s.games.length, 4);
  const added = s.games.find(g => g.date === '2030-03-01');
  assert.equal(added.opponent, 'MTL');
  s = await admin.put(`/api/drafts/${id}/games/${added.id}`, { opponent: 'OTT', price: 150 });
  assert.equal(s.games.find(g => g.id === added.id).opponent, 'OTT');
  await rejects(admin.post(`/api/drafts/${id}/games`, { date: 'not a date', opponent: 'MTL' }), 400, /Bad game date/);
  await rejects(admin.post(`/api/drafts/${id}/games`, { date: '2030-03-02', opponent: 'Nowhere FC' }), 400, /Unknown opponent/);
  s = await admin.del(`/api/drafts/${id}/games/${added.id}`);
  assert.equal(s.games.length, 3);
  await admin.post(`/api/drafts/${id}/start`);
  s = await admin.post(`/api/drafts/${id}/pick`, { game_id: s.games[0].id });
  await rejects(admin.del(`/api/drafts/${id}/games/${s.games[0].id}`), 400, /already picked/);
  await rejects(admin.del(`/api/drafts/${id}/games/${s.games[1].id}`), 400, /reset the draft to setup/);
  await admin.post(`/api/drafts/${id}/control`, { action: 'reset' });
  await admin.del(`/api/drafts/${id}`);
});

test('completed app drafts are kept for history', async () => {
  const id = await seasonDraft(admin, order, { games: makeGames(3) });
  await pickN(admin, id, clients);
  await rejects(admin.del(`/api/drafts/${id}`), 400, /kept for history/);
  assert.equal((await admin.post(`/api/drafts/${id}/control`, { action: 'reset' })).draft.status, 'setup');
  await admin.del(`/api/drafts/${id}`);
});

test('live updates: picks and presence reach other open boards instantly', async () => {
  const id = await seasonDraft(admin, order, { games: makeGames(6) });
  const abelaStream = await clients.abela.events(id);
  await abelaStream.waitFor(/event: presence\ndata: .*"online":\[[^\]]*\]/);
  const popeStream = await clients.pope.events(id);
  const m = await abelaStream.waitFor(new RegExp(`event: presence\\ndata: \\{"online":\\[(?=[^\\]]*\\b${ids.pope}\\b)[^\\]]*\\]`));
  assert.ok(m, 'abela sees pope join the draft room');
  abelaStream.clear();
  const s = await admin.get(`/api/drafts/${id}`);
  await admin.post(`/api/drafts/${id}/pick`, { game_id: openGame(s).id });
  await abelaStream.waitFor(/event: update/);
  await popeStream.waitFor(/event: update/);
  abelaStream.close(); popeStream.close();
  await admin.post(`/api/drafts/${id}/control`, { action: 'reset' });
  await admin.del(`/api/drafts/${id}`);
});

test('email drafts send “on the clock” emails (logged when SMTP is not set) and reminders', async () => {
  const id = await seasonDraft(admin, order, { games: makeGames(6), mode: 'async' });
  assert.match(server.log(), /to=quinn@example\.test subject="🍁 You're on the clock/);
  let s = await admin.get(`/api/drafts/${id}`);
  await admin.post(`/api/drafts/${id}/pick`, { game_id: openGame(s).id });
  assert.match(server.log(), /to=abela@example\.test subject="🍁 You're on the clock[\s\S]*Last pick: quinn took/);
  await clients.pope.post(`/api/drafts/${id}/nudge`);
  assert.match(server.log(), /to=abela@example\.test subject="Reminder: 🍁 You're on the clock/);
  // Partners who opt out are not emailed, and a reminder says so.
  await clients.abela.put('/api/me', { email: 'abela@example.test', notify_email: false });
  await rejects(clients.pope.post(`/api/drafts/${id}/nudge`), 400, /notifications turned off/);
  await clients.abela.put('/api/me', { email: 'abela@example.test', notify_email: true });
  await admin.post(`/api/drafts/${id}/control`, { action: 'reset' });
  await admin.del(`/api/drafts/${id}`);
});

test('the home list shows who is on the clock for live drafts', async () => {
  const id = await seasonDraft(admin, order, { games: makeGames(3) });
  const list = await clients.pope.get('/api/drafts');
  const d = list.find(x => x.id === id);
  assert.equal(d.on_clock.user_id, ids.quinn);
  assert.equal(d.total_picks, 3);
  await admin.post(`/api/drafts/${id}/control`, { action: 'reset' });
  await admin.del(`/api/drafts/${id}`);
});

test('a partner in an unfinished draft cannot be deleted', async () => {
  const id = await seasonDraft(admin, order, { games: makeGames(3), start: false });
  await rejects(admin.del(`/api/users/${ids.pope}`), 400, /Remove them from/);
  await admin.del(`/api/drafts/${id}`);
});
