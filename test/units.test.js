// Unit tests for the pure modules: schedule CSV parsing, teams, preference cleaning.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseScheduleCsv, normDate, normTime, normPrice, normType, normSeconds } = require('../src/schedule');
const { findTeam } = require('../src/teams');
const { cleanPrefs, hasPrefs } = require('../src/suggest');

test('dates: 29-Sep-26, 2026-09-29 and 9/29/2026 all work', () => {
  assert.equal(normDate('29-Sep-26'), '2026-09-29');
  assert.equal(normDate('2026-09-29'), '2026-09-29');
  assert.equal(normDate('9/29/2026'), '2026-09-29');
  assert.equal(normDate('not a date'), null);
});

test('times, prices, types and pick durations', () => {
  assert.equal(normTime('7:00 PM'), '19:00');
  assert.equal(normTime('12:30 PM'), '12:30');
  assert.equal(normPrice('$404'), 404);
  assert.equal(normPrice('1,250'), 1250);
  assert.equal(normType('Pre-Season'), 'preseason');
  assert.equal(normType('Playoffs'), 'playoff');
  assert.equal(normType('Regular Season'), 'regular');
  assert.equal(normSeconds('1:42'), 102);
  assert.equal(normSeconds('30'), 30);
});

test('teams are found by full name, city, nickname or abbreviation', () => {
  for (const s of ['Montreal Canadiens', 'Montreal', 'Canadiens', 'MTL']) assert.equal(findTeam(s)?.abbr, 'MTL', s);
  assert.equal(findTeam('Nowhere FC'), null);
});

test('the bundled 2026-27 schedule parses cleanly: 42 home games', () => {
  const csv = fs.readFileSync(path.join(__dirname, '..', 'schedules', 'TML_2026-2027.csv'), 'utf8');
  const { games, errors } = parseScheduleCsv(csv);
  assert.deepEqual(errors, []);
  assert.equal(games.length, 42);
  assert.ok(games.every(g => /^\d{4}-\d{2}-\d{2}$/.test(g.date) && g.opponent && g.price > 0));
});

test('schedule CSV: minimal columns, away games skipped, bad rows reported', () => {
  const { games, errors } = parseScheduleCsv('Date,Opponent\n2030-01-01,Boston\n2030-01-02,@ Ottawa\n2030-01-03,Atlantis\nbad,MTL');
  assert.equal(games.length, 1);
  assert.equal(games[0].opponent, 'BOS');
  assert.equal(errors.length, 2);
  assert.match(parseScheduleCsv('foo,bar\n1,2').errors[0], /header row/);
});

test('cleanPrefs drops unknown and neutral values; hasPrefs detects any real preference', () => {
  const p = cleanPrefs({ opponents: ['MTL', 'XXX', 'MTL', 'BOS', 'OTT', 'DET', 'BUF', 'TOR'], days: { 6: 'prefer', 9: 'avoid', 1: 'meh' }, min_gap: 99, cost: 'low' });
  assert.deepEqual(p.opponents, ['MTL', 'BOS', 'OTT', 'DET', 'BUF']);
  assert.deepEqual(p.days, { 6: 'prefer' });
  assert.equal(p.min_gap, 14);
  assert.equal(p.cost, 'any');
  assert.ok(hasPrefs(p));
  assert.ok(!hasPrefs(cleanPrefs({})));
  assert.deepEqual(cleanPrefs({ avoid_dates: [{ from: '2030-01-05', to: '2030-01-01' }] }).avoid_dates[0], { from: '2030-01-05', to: '2030-01-05', label: '' });
});
