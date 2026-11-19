const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA_VERSION = 2;
const file = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'draftboard.db');
fs.mkdirSync(path.dirname(file), { recursive: true });
const db = new DatabaseSync(file);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

const version = db.prepare('PRAGMA user_version').get().user_version;
const hasTables = !!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'drafts'").get();
if (hasTables && version < SCHEMA_VERSION) {
  // Only pre-release v0.1 databases hit this; nobody has real data in them yet.
  // Keep accounts and rebuild the draft tables.
  console.warn('Upgrading database from prototype schema: draft data will be reset, accounts kept.');
  db.exec(`DROP TABLE IF EXISTS trade_items; DROP TABLE IF EXISTS trades; DROP TABLE IF EXISTS picks;
           DROP TABLE IF EXISTS games; DROP TABLE IF EXISTS draft_order; DROP TABLE IF EXISTS drafts;`);
  const cols = db.prepare('PRAGMA table_info(users)').all().map(c => c.name);
  if (!cols.includes('notify_email')) db.exec('ALTER TABLE users ADD COLUMN notify_email INTEGER NOT NULL DEFAULT 1');
}

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name  TEXT NOT NULL,
  email         TEXT,
  notify_email  INTEGER NOT NULL DEFAULT 1,
  color         TEXT NOT NULL DEFAULT '#1e5bc6',
  favorite_player TEXT,
  is_admin      INTEGER NOT NULL DEFAULT 0,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS drafts (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  season      TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'season',    -- season (preseason + regular) | playoff
  seat_mode   TEXT NOT NULL DEFAULT 'pair',      -- pair: a pick takes both seats | single: a pick takes one seat
  mode        TEXT NOT NULL DEFAULT 'live',      -- live: everyone together | async: email when on the clock
  order_type  TEXT NOT NULL DEFAULT 'snake',     -- snake | linear
  warn_secs   INTEGER NOT NULL DEFAULT 120,      -- clock warning (0 = none); never a hard limit
  status      TEXT NOT NULL DEFAULT 'setup',     -- setup | live | complete
  source      TEXT NOT NULL DEFAULT 'app',       -- app | import (historical, entered from a spreadsheet)
  created_by  INTEGER REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  started_at  INTEGER,
  completed_at INTEGER,
  clock_started_at INTEGER,   -- ms epoch when the current pick went on the clock
  paused_at   INTEGER,        -- ms epoch if the clock is paused
  paused_ms   INTEGER NOT NULL DEFAULT 0  -- paused time accumulated on the current pick
);

CREATE TABLE IF NOT EXISTS draft_order (
  draft_id INTEGER NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,           -- 1-based slot in round 1
  user_id  INTEGER NOT NULL REFERENCES users(id),
  PRIMARY KEY (draft_id, position)
);

CREATE TABLE IF NOT EXISTS games (
  id        INTEGER PRIMARY KEY,
  draft_id  INTEGER NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
  date      TEXT NOT NULL,    -- YYYY-MM-DD
  time      TEXT NOT NULL,    -- HH:MM 24h, Toronto time
  opponent  TEXT NOT NULL,    -- team abbreviation or TBD
  type      TEXT NOT NULL DEFAULT 'regular',  -- preseason | regular | playoff
  price     REAL,             -- for the pair of seats
  seats     INTEGER NOT NULL DEFAULT 2,
  notes     TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS picks (
  id            INTEGER PRIMARY KEY,
  draft_id      INTEGER NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
  overall       INTEGER NOT NULL,   -- 1-based
  round         INTEGER NOT NULL,
  pick_in_round INTEGER NOT NULL,
  user_id       INTEGER NOT NULL REFERENCES users(id),   -- who drafted it
  owner_id      INTEGER NOT NULL REFERENCES users(id),   -- who holds it now (changes with trades)
  game_id       INTEGER NOT NULL REFERENCES games(id),
  seat          INTEGER NOT NULL DEFAULT 0,  -- 0 = both seats (pair); 1..n = single seat
  made_by       INTEGER REFERENCES users(id),  -- differs from user_id when picked on someone's behalf
  seconds_taken REAL,               -- NULL for imported historical picks
  picked_at     INTEGER,
  UNIQUE (draft_id, overall),
  UNIQUE (draft_id, game_id, seat)
);

CREATE TABLE IF NOT EXISTS trades (
  id          INTEGER PRIMARY KEY,
  draft_id    INTEGER NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
  from_user   INTEGER NOT NULL REFERENCES users(id),
  to_user     INTEGER NOT NULL REFERENCES users(id),
  status      TEXT NOT NULL DEFAULT 'pending',  -- pending | accepted | declined | cancelled | expired
  message     TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL,
  resolved_at INTEGER
);

CREATE TABLE IF NOT EXISTS trade_items (
  trade_id INTEGER NOT NULL REFERENCES trades(id) ON DELETE CASCADE,
  pick_id  INTEGER NOT NULL REFERENCES picks(id) ON DELETE CASCADE,
  side     TEXT NOT NULL,   -- give (from_user -> to_user) | get (to_user -> from_user)
  PRIMARY KEY (trade_id, pick_id)
);
`);
// Additive columns (safe on existing databases).
const draftCols = db.prepare('PRAGMA table_info(drafts)').all().map(c => c.name);
if (!draftCols.includes('notes')) db.exec("ALTER TABLE drafts ADD COLUMN notes TEXT NOT NULL DEFAULT ''");
// 0 for imported seasons where only who-got-which-game was recorded, not the pick sequence.
if (!draftCols.includes('order_recorded')) db.exec('ALTER TABLE drafts ADD COLUMN order_recorded INTEGER NOT NULL DEFAULT 1');
const userCols = db.prepare('PRAGMA table_info(users)').all().map(c => c.name);
if (!userCols.includes('active')) db.exec('ALTER TABLE users ADD COLUMN active INTEGER NOT NULL DEFAULT 1');
// Profiles with draft history are "removed" rather than erased so past results stay intact.
if (!userCols.includes('deleted_at')) db.exec('ALTER TABLE users ADD COLUMN deleted_at INTEGER');
db.exec(`CREATE TABLE IF NOT EXISTS password_resets (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER
)`);
db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);

module.exports = db;
