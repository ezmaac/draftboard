// REQUIREMENTS §13 item 9 and §6.2: bundled Ticket Tracker history and single-draft CSV import.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, league, rejects } = require('./helpers');

let server, admin, ids;
before(async () => {
  server = await startServer();
  ({ admin, ids } = await league(server, ['mark', 'dave', 'sam']));
});
after(() => server?.stop());

test('bundled history lists 23 seasons and the spreadsheet partner names', async () => {
  const { seasons, partner_names } = await admin.get('/api/history/bundled');
  assert.equal(seasons.length, 23);
  assert.equal(seasons.reduce((a, s) => a + s.picks, 0), 974);
  assert.deepEqual([...partner_names].sort(), ['Abela', 'Pope', 'Q']);
});

test('unmatched spreadsheet names are reported instead of importing', async () => {
  const r = await admin.req('POST', '/api/history/bundled', { seasons: ['2026-27'], aliases: {} });
  assert.equal(r.status, 400);
  assert.deepEqual([...r.data.unmatched].sort(), ['Abela', 'Pope', 'Q']);
});

test('importing every season gives 974 picks and the sheet’s ticket values', async () => {
  const { seasons } = await admin.get('/api/history/bundled');
  const aliases = { Q: ids.mark, Abela: ids.dave, Pope: ids.sam };
  const { results } = await admin.post('/api/history/bundled', { seasons: seasons.map(s => s.season), aliases });
  assert.deepEqual(results.filter(r => r.error), []);
  assert.equal(results.reduce((a, r) => a + r.picks, 0), 974);

  const summary = await admin.get('/api/history/summary');
  const value = (season, uid) => Math.round(summary.find(r => r.season === season && r.user_id === uid).value);
  assert.equal(value('2026-27', ids.mark), 3732);
  assert.equal(value('2026-27', ids.dave), 3708);
  assert.equal(value('2026-27', ids.sam), 3940);
  // Every season's totals match the workbook's Ticket Value where it was recorded.
  for (const m of seasons) {
    for (const [name, v] of Object.entries(m.ticket_value || {})) {
      if (v == null) continue;
      // The converter records where the sheet's own formula was wrong, e.g. "leaves out Pope's 2025-04-17 game ($230)".
      const fix = (m.report || []).map(r => new RegExp(`leaves out ${name}'s [^(]*\\(\\$(\\d+)\\)`).exec(r)).find(Boolean);
      assert.equal(value(m.season, aliases[name]), Math.round(v) + (fix ? Number(fix[1]) : 0), `${m.season} ${name}`);
    }
  }
  const again = await admin.post('/api/history/bundled', { seasons: ['2026-27'], aliases });
  assert.equal(again.results[0].skipped, 'already imported');
});

test('seasons without a recorded pick order are flagged', async () => {
  const drafts = await admin.get('/api/drafts');
  const recorded = drafts.filter(d => d.source === 'import' && d.order_recorded).map(d => d.season).sort();
  assert.deepEqual(recorded, ['2002-03', '2019-20', '2021-22', '2026-27']);
});

test('imported drafts cannot be edited with the draft controls, but can be deleted', async () => {
  const d = (await admin.get('/api/drafts')).find(x => x.source === 'import');
  await rejects(admin.post(`/api/drafts/${d.id}/undo`), 400, /Imported drafts/);
  await rejects(admin.post(`/api/drafts/${d.id}/control`, { action: 'restart' }), 400, /Imported drafts/);
});

test('single past-draft CSV import', async () => {
  const csv = [
    'Pick,Partner,Date,Team,Time,Price,Seconds',
    '1,mark,7-Oct-25,Montreal Canadiens,7:00 PM,$404,',
    '2,dave,11-Oct-25,Ottawa Senators,7:00 PM,$304,1:42',
    '3,sam,2025-10-14,BOS,7:30 PM,$250,30',
    ',,10/20/2025,Detroit Red Wings,,$100,',
  ].join('\n');
  const r = await admin.post('/api/drafts/import', { name: 'Old draft', season: '2025-26b', csv });
  assert.equal(r.picks, 3);
  assert.equal(r.order_recorded, true);
  const s = await admin.get(`/api/drafts/${r.id}`);
  assert.equal(s.games.length, 4, 'undrafted games are kept');
  assert.equal(s.picks[1].seconds_taken, 102);
  assert.deepEqual(s.order.map(o => o.user_id), [ids.mark, ids.dave, ids.sam]);
  const bad = await admin.req('POST', '/api/drafts/import', { name: 'Bad', csv: 'Partner,Date,Team\nghost,2025-10-01,MTL\nmark,nope,MTL' });
  assert.equal(bad.status, 400);
  assert.deepEqual(bad.data.unmatched, ['ghost']);
  await admin.del(`/api/drafts/${r.id}`);
});
