import 'dotenv/config';
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const databasePath = process.env.DATABASE_PATH || './data/tournament.sqlite';
if (databasePath !== ':memory:') mkdirSync(dirname(databasePath), { recursive: true });

export const db = new Database(databasePath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS players (
  user_id       TEXT PRIMARY KEY,
  meta_username TEXT NOT NULL COLLATE NOCASE UNIQUE,
  region        TEXT NOT NULL,
  timezone      TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS teams (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id   TEXT NOT NULL,
  name       TEXT NOT NULL COLLATE NOCASE,
  captain_id TEXT NOT NULL,
  region     TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (guild_id, name)
);

CREATE TABLE IF NOT EXISTS team_members (
  team_id   INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  guild_id  TEXT NOT NULL,
  user_id   TEXT NOT NULL,
  joined_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (team_id, user_id),
  UNIQUE (guild_id, user_id)
);

CREATE TABLE IF NOT EXISTS team_invites (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id    INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL,
  invited_by TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'PENDING',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (team_id, user_id)
);

CREATE TABLE IF NOT EXISTS tournaments (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id         TEXT NOT NULL,
  name             TEXT NOT NULL COLLATE NOCASE,
  region           TEXT NOT NULL,
  format           TEXT NOT NULL,
  max_teams        INTEGER NOT NULL,
  min_roster       INTEGER NOT NULL,
  max_roster       INTEGER NOT NULL,
  require_approval INTEGER NOT NULL DEFAULT 0,
  status           TEXT NOT NULL DEFAULT 'SIGNUPS',
  champion_team_id INTEGER,
  created_by       TEXT NOT NULL,
  created_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (guild_id, name)
);

CREATE TABLE IF NOT EXISTS registrations (
  tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  team_id       INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  status        TEXT NOT NULL,
  seed          INTEGER,
  created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tournament_id, team_id)
);

CREATE TABLE IF NOT EXISTS matches (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  tournament_id  INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  bracket        TEXT NOT NULL,
  round          INTEGER NOT NULL,
  position       INTEGER NOT NULL,
  team1_id       INTEGER,
  team2_id       INTEGER,
  team1_bye      INTEGER NOT NULL DEFAULT 0,
  team2_bye      INTEGER NOT NULL DEFAULT 0,
  winner_id      INTEGER,
  score1         INTEGER,
  score2         INTEGER,
  status         TEXT NOT NULL DEFAULT 'WAITING',
  notified       INTEGER NOT NULL DEFAULT 0,
  next_win_id    INTEGER,
  next_win_slot  INTEGER,
  next_lose_id   INTEGER,
  next_lose_slot INTEGER,
  UNIQUE (tournament_id, bracket, round, position)
);

CREATE TABLE IF NOT EXISTS match_reports (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id         INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  reporter_id      TEXT NOT NULL,
  reporter_team_id INTEGER NOT NULL,
  winner_id        INTEGER NOT NULL,
  score1           INTEGER NOT NULL,
  score2           INTEGER NOT NULL,
  status           TEXT NOT NULL DEFAULT 'PENDING',
  created_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- One game inside a best-of series.
CREATE TABLE IF NOT EXISTS match_games (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id     INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  game_number  INTEGER NOT NULL,
  winner_id    INTEGER NOT NULL,
  reported_by  TEXT NOT NULL,
  confirmed_by TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (match_id, game_number)
);

-- Bot-wide settings changed with /settings (this bot serves one server). Values here beat the .env defaults.
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- An open ready check, so a bot restart doesn't lose it.
CREATE TABLE IF NOT EXISTS ready_checks (
  tournament_id INTEGER PRIMARY KEY,
  shuffle       INTEGER NOT NULL,
  channel_id    TEXT NOT NULL,
  expires_at    INTEGER NOT NULL,
  ready         TEXT NOT NULL DEFAULT '[]',
  dms           TEXT NOT NULL DEFAULT '[]'
);

-- An arena = an Orion Drift fleet (set to allowlist-only) plus the role that lets people join it.
CREATE TABLE IF NOT EXISTS arenas (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id   TEXT NOT NULL,
  name       TEXT NOT NULL COLLATE NOCASE,
  fleet_id   TEXT NOT NULL,
  role_id    TEXT NOT NULL,
  enabled    INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (guild_id, name)
);

-- Who the bot whitelisted into which arena for which match. No FK to matches on purpose:
-- if a tournament is deleted, these rows stay so the bot can still remove the access.
CREATE TABLE IF NOT EXISTS match_whitelist (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id       INTEGER NOT NULL,
  arena_id       INTEGER,
  fleet_id       TEXT NOT NULL,
  role_id        TEXT NOT NULL,
  user_id        TEXT NOT NULL,
  meta_username  TEXT NOT NULL,
  orion_user_id  TEXT,
  status         TEXT NOT NULL DEFAULT 'PENDING',
  last_error     TEXT,
  updated_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (match_id, user_id)
);
`);

// Safe upgrades for databases created by the first version of this bot.
for (const sql of [
  'ALTER TABLE matches ADD COLUMN arena_id INTEGER',
  'ALTER TABLE matches ADD COLUMN thread_id TEXT',
  'ALTER TABLE matches ADD COLUMN disputed INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE registrations ADD COLUMN disqualified INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE match_games ADD COLUMN score1 INTEGER',
  'ALTER TABLE match_games ADD COLUMN score2 INTEGER',
  'ALTER TABLE tournaments ADD COLUMN starts_at INTEGER',
  'ALTER TABLE tournaments ADD COLUMN reminded INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE matches ADD COLUMN thread_archived INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE matches ADD COLUMN noshow_alerted INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE tournaments ADD COLUMN bracket_message_id TEXT',
  'ALTER TABLE match_whitelist ADD COLUMN team_slot INTEGER',
  'ALTER TABLE matches ADD COLUMN arena_assigned_at TEXT',
  'ALTER TABLE matches ADD COLUMN last_event_idx INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE tournaments ADD COLUMN channel_id TEXT',
  'ALTER TABLE tournaments ADD COLUMN role_id TEXT',
  'ALTER TABLE matches ADD COLUMN team1_wins INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE matches ADD COLUMN team2_wins INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE tournaments ADD COLUMN best_of INTEGER NOT NULL DEFAULT 1',
  'ALTER TABLE match_reports ADD COLUMN game_number INTEGER NOT NULL DEFAULT 1'
]) {
  try { db.exec(sql); } catch (error) {
    if (!/duplicate column name/i.test(String(error))) throw error; // only "already added" is fine; anything else is a real problem
  }
}
