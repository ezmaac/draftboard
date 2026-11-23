#!/usr/bin/env node
// Fill a throwaway database with demo data so the app can be tried or tested straight away.
//
//   npm run seed                     # creates data/dev.db
//   npm run seed -- --db /tmp/x.db   # somewhere else
//   npm run seed -- --force          # replace an existing file
//   npm run seed -- --no-history     # skip importing the 23 bundled seasons
//
// Then: DB_FILE=data/dev.db npm start
//
// It drives the real server over HTTP (via tools/lib/harness.js), so every rule is applied
// exactly as in the app. It never touches a database that already exists unless you pass --force.
const fs = require('node:fs');
const path = require('node:path');
const { startServer, ROOT } = require('./lib/harness');

const args = process.argv.slice(2);
const flag = f => args.includes(f);
const opt = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
if (flag('--help') || flag('-h')) { console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 13).map(l => l.replace(/^\/\/ ?/, '')).join('\n')); process.exit(0); }

const dbFile = path.resolve(opt('--db', path.join(ROOT, 'data', 'dev.db')));
const PASSWORD = 'leafs123';
const PARTNERS = [
  { username: 'quinn', display_name: 'Q' },       // first account = commissioner
  { username: 'abela', display_name: 'Abela' },
  { username: 'pope', display_name: 'Pope' },
];

async function main() {
  if (fs.existsSync(dbFile)) {
    if (!flag('--force')) {
      console.error(`${dbFile} already exists. Pass --force to replace it (its data will be deleted).`);
      process.exit(1);
    }
    for (const f of [dbFile, `${dbFile}-wal`, `${dbFile}-shm`]) fs.rmSync(f, { force: true });
  }
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });

  const server = await startServer({ dbFile });
  try {
    const clients = {};
    for (const p of PARTNERS) {
      const c = server.client();
      await c.register(p.username, { password: PASSWORD, display_name: p.display_name, email: `${p.username}@example.test` });
      clients[p.username] = c;
    }
    const admin = clients.quinn;
    const ids = Object.fromEntries(Object.entries(clients).map(([k, c]) => [k, c.user.id]));
    console.log(`Accounts: ${PARTNERS.map(p => p.username).join(', ')} (password "${PASSWORD}"); ${PARTNERS[0].username} is the commissioner.`);

    if (!flag('--no-history')) {
      const { seasons } = await admin.get('/api/history/bundled');
      const aliases = { Q: ids.quinn, Abela: ids.abela, Pope: ids.pope };
      const { results } = await admin.post('/api/history/bundled', { seasons: seasons.map(s => s.season), aliases });
      const bad = results.filter(r => r.error);
      if (bad.length) throw new Error(`History import failed: ${JSON.stringify(bad)}`);
      console.log(`History: imported ${results.length} seasons (${results.reduce((a, r) => a + r.picks, 0)} picks).`);
    }

    // Private preferences for Abela, so the suggested-pick panel shows when logged in as abela.
    await clients.abela.put('/api/me/prefs', { prefs: { opponents: ['MTL', 'BOS', 'OTT'], days: { 6: 'prefer', 1: 'avoid' }, spread: true } });

    // A live season draft from the bundled schedule, a few picks in.
    const files = await admin.get('/api/schedules');
    const file = files.find(f => f.includes('2026-2027')) || files[0];
    const { games } = await admin.post('/api/schedule/preview', { source: 'bundled', file });
    const { suggested } = await admin.get('/api/drafts/next-order');
    const { id } = await admin.post('/api/drafts', {
      name: 'Demo Season Draft', season: '2026-27', kind: 'season', mode: 'live', order_type: 'snake', warn_secs: 120, user_ids: suggested, games,
    });
    let s = await admin.post(`/api/drafts/${id}/start`);
    for (let i = 0; i < 5; i++) {
      const taken = new Set(s.picks.map(p => p.game_id));
      const game = s.games.filter(g => !taken.has(g.id)).sort((a, b) => (b.price || 0) - (a.price || 0))[0];
      const by = Object.values(clients).find(c => c.user.id === s.on_clock.user_id);
      s = await by.post(`/api/drafts/${id}/pick`, { game_id: game.id });
    }
    const next = PARTNERS.find(p => ids[p.username] === s.on_clock.user_id);
    console.log(`Draft: "Demo Season Draft" is live with ${s.picks.length} of ${s.draft.total_picks} picks made; ${next.username} is on the clock.`);

    // A playoff draft waiting in setup.
    await admin.post('/api/drafts', {
      name: 'Demo Playoffs R1-3', season: '2026-27', kind: 'playoff', mode: 'live', user_ids: suggested,
      rounds: [{ round: 1, home_ice: true }, { round: 2, home_ice: false }, { round: 3, home_ice: true }],
    });
    console.log('Draft: "Demo Playoffs R1-3" is in setup (11 games, order drawn at random).');
  } finally {
    await server.stop();
  }
  const rel = path.relative(ROOT, dbFile);
  console.log(`\nDone. Start the app on it with:\n  DB_FILE=${rel.startsWith('..') ? dbFile : rel} npm start`);
}

main().catch(e => { console.error(e.message || e); process.exit(1); });
