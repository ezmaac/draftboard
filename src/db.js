const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const file = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'draftboard.db');
fs.mkdirSync(path.dirname(file), { recursive: true });
const db = new DatabaseSync(file);

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name  TEXT NOT NULL,
  email         TEXT,
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
  order_type  TEXT NOT NULL DEFAULT 'snake',     -- snake | linear
  status      TEXT NOT NULL DEFAULT 'setup',     -- setup | live | complete
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
  time      TEXT NOT NULL,    -- HH:MM 24h
  opponent  TEXT NOT NULL,    -- team abbreviation
  notes     TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS picks (
  id            INTEGER PRIMARY KEY,
  draft_id      INTEGER NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
  overall       INTEGER NOT NULL,   -- 1-based
  round         INTEGER NOT NULL,
  pick_in_round INTEGER NOT NULL,
  user_id       INTEGER NOT NULL REFERENCES users(id),
  game_id       INTEGER NOT NULL REFERENCES games(id),
  made_by       INTEGER REFERENCES users(id),  -- differs from user_id when picked on someone's behalf
  seconds_taken REAL NOT NULL,
  picked_at     INTEGER NOT NULL,
  UNIQUE (draft_id, overall),
  UNIQUE (draft_id, game_id)
);
`);

module.exports = db;
