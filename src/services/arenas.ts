import { db } from '../db.js';
import { UserError } from '../util.js';
import { errorText, mainFleetId, orionOrNull, stationId } from '../integrations/orion.js';

/**
 * Arenas + automatic whitelisting.
 *
 * An arena is one gamemode slot (e.g. "Beta 02") on the tournament station. Slots are always whitelist-only.
 * When a match is ready, the bot takes a free arena and writes team 0 / team 1 usernames into that slot's whitelist.
 * When the match ends, it closes the slot to everyone and frees the arena for the next match.
 * (DB columns: arenas.fleet_id holds the station ID, arenas.role_id holds the slot name.)
 */

export interface Arena {
  id: number;
  guildId: string;
  name: string;
  stationId: string;
  slot: string;
  enabled: number;
}

export interface WhitelistFailure {
  userId: string;
  metaUsername: string;
  reason: string;
}

export interface ReadyEvent {
  matchId: number;
  /** Set when the match is ready but every arena is busy; it will be announced again when one frees up. */
  queued?: boolean;
  arenaName: string | null;
  failures: WhitelistFailure[];
}

type WhitelistRow = {
  id: number; match_id: number; arena_id: number | null; fleet_id: string; role_id: string;
  user_id: string; meta_username: string; orion_user_id: string | null; status: string; last_error: string | null;
};

const ARENA_SELECT = 'SELECT id, guild_id AS guildId, name, fleet_id AS stationId, role_id AS slot, enabled FROM arenas';

export function listArenas(guildId: string): Array<Arena & { matchId: number | null }> {
  return db.prepare(`SELECT a.id, a.guild_id AS guildId, a.name, a.fleet_id AS stationId, a.role_id AS slot, a.enabled,
      (SELECT m.id FROM matches m WHERE m.arena_id = a.id AND m.status = 'READY' LIMIT 1) AS matchId
    FROM arenas a WHERE a.guild_id = ? ORDER BY a.id`).all(guildId) as Array<Arena & { matchId: number | null }>;
}

export function getArenaByName(guildId: string, name: string): Arena | undefined {
  return db.prepare(`${ARENA_SELECT} WHERE guild_id = ? AND name = ?`).get(guildId, name.trim()) as Arena | undefined;
}

export function searchArenas(guildId: string, query: string): Arena[] {
  return db.prepare(`${ARENA_SELECT} WHERE guild_id = ? AND name LIKE ? ORDER BY id LIMIT 25`).all(guildId, `%${query.trim()}%`) as Arena[];
}

/** Orion Drift slot names are zero-padded ("Beta 01"); accept "Beta 1" too. */
export function normalizeSlot(slot: string): string {
  const m = /^\s*([A-Za-z]+)\s*0*(\d+)\s*$/.exec(slot);
  return m ? `${m[1][0].toUpperCase()}${m[1].slice(1).toLowerCase()} ${m[2].padStart(2, '0')}` : slot.trim();
}

/** Repairs arenas that were added with an unpadded slot ("Beta 1" -> "Beta 01"). Safe to run every start. */
export function fixArenaSlots(): number {
  let fixed = 0;
  for (const row of db.prepare('SELECT id, role_id AS slot FROM arenas').all() as Array<{ id: number; slot: string }>) {
    const good = normalizeSlot(row.slot);
    if (good !== row.slot) { db.prepare('UPDATE arenas SET role_id = ? WHERE id = ?').run(good, row.id); fixed++; }
  }
  return fixed;
}

export function addArena(guildId: string, rawName: string, station: string, slot: string): Arena {
  const name = rawName.trim().replace(/\s+/g, ' ');
  if (name.length < 1 || name.length > 32) throw new UserError('Arena names must be 1–32 characters.');
  if (getArenaByName(guildId, name)) throw new UserError(`An arena called **${name}** already exists.`);
  const result = db.prepare('INSERT INTO arenas (guild_id, name, fleet_id, role_id) VALUES (?, ?, ?, ?)').run(guildId, name, station.trim(), normalizeSlot(slot));
  return db.prepare(`${ARENA_SELECT} WHERE id = ?`).get(Number(result.lastInsertRowid)) as Arena;
}

/** Adds Alpha/Beta/Gamma 1–3 (slots "Alpha 01" … "Gamma 03") on the configured station. Skips ones that exist. */
export function seedArenas(guildId: string): Arena[] {
  const station = stationId();
  if (!station) throw new UserError('Set `ORION_STATION_ID` in `.env` and restart the bot first.');
  const added: Arena[] = [];
  for (const group of ['Alpha', 'Beta', 'Gamma']) {
    for (let n = 1; n <= 3; n++) {
      if (!getArenaByName(guildId, `${group} ${n}`)) added.push(addArena(guildId, `${group} ${n}`, station, `${group} 0${n}`));
    }
  }
  return added;
}

export function setArenaEnabled(arena: Arena, enabled: boolean): void {
  db.prepare('UPDATE arenas SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, arena.id);
}

export function removeArena(arena: Arena): void {
  const inUse = db.prepare("SELECT id FROM matches WHERE arena_id = ? AND status = 'READY'").get(arena.id) as { id: number } | undefined;
  if (inUse) throw new UserError(`**${arena.name}** is being used by match #${inUse.id}. Disable it instead, or wait for the match to finish.`);
  db.prepare('DELETE FROM arenas WHERE id = ?').run(arena.id);
}

export function whitelistFor(matchId: number): WhitelistRow[] {
  return db.prepare('SELECT * FROM match_whitelist WHERE match_id = ? ORDER BY id').all(matchId) as WhitelistRow[];
}

function setRow(id: number, status: string, lastError: string | null, orionUserId?: string | null): void {
  db.prepare(`UPDATE match_whitelist SET status = ?, last_error = ?, orion_user_id = COALESCE(?, orion_user_id), updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .run(status, lastError, orionUserId ?? null, id);
}

const LIVE_ROW = "w.status != 'REVOKED' AND (m.id IS NULL OR m.status != 'READY')";

/** True while the arena has a live match, or leftover access from a finished match that hasn't been closed yet. */
function arenaBusy(arenaId: number): boolean {
  const live = db.prepare("SELECT 1 FROM matches WHERE arena_id = ? AND status = 'READY' LIMIT 1").get(arenaId);
  if (live) return true;
  return Boolean(db.prepare(`SELECT 1 FROM match_whitelist w LEFT JOIN matches m ON m.id = w.match_id WHERE w.arena_id = ? AND ${LIVE_ROW} LIMIT 1`).get(arenaId));
}

/** Closes arenas whose match is over (or was deleted/rolled back) to everyone. */
async function closeStale(): Promise<void> {
  const api = orionOrNull();
  const arenaIds = db.prepare(`SELECT DISTINCT w.arena_id AS id FROM match_whitelist w LEFT JOIN matches m ON m.id = w.match_id WHERE ${LIVE_ROW}`).all() as Array<{ id: number | null }>;
  for (const { id } of arenaIds) {
    const arena = id === null ? undefined : db.prepare(`${ARENA_SELECT} WHERE id = ?`).get(id) as Arena | undefined;
    if (arena) {
      if (!api) continue;
      try { await api.setSlot(arena.stationId, arena.slot, null, null); } catch { continue; } // stays marked, retried next sync
    }
    db.prepare(`UPDATE match_whitelist SET status = 'REVOKED', last_error = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE arena_id IS ? AND status != 'REVOKED' AND match_id NOT IN (SELECT id FROM matches WHERE status = 'READY')`).run(id);
  }
  // Whitelist records of matches that no longer exist (deleted tournaments) are no longer needed once access is closed.
  db.prepare("DELETE FROM match_whitelist WHERE status = 'REVOKED' AND match_id NOT IN (SELECT id FROM matches)").run();
}

/** Players are found by user search first, then by searching the tournament fleet's members. */
function fleetsToSearch(): string[] {
  const fleet = mainFleetId();
  return fleet ? [fleet] : [];
}

/** Writes both rosters into the match's arena and records per-player results. */
async function applyMatch(matchId: number, arena: Arena): Promise<WhitelistFailure[]> {
  const api = orionOrNull();
  const match = db.prepare('SELECT m.team1_id AS t1, m.team2_id AS t2, a.name AS n1, b.name AS n2 FROM matches m JOIN teams a ON a.id = m.team1_id JOIN teams b ON b.id = m.team2_id WHERE m.id = ?')
    .get(matchId) as { t1: number; t2: number; n1: string; n2: string };
  const players = db.prepare(`SELECT tm.user_id AS userId, tm.team_id AS teamId, p.meta_username AS metaUsername
    FROM team_members tm JOIN players p ON p.user_id = tm.user_id WHERE tm.team_id IN (?, ?) ORDER BY tm.team_id, tm.joined_at`).all(match.t1, match.t2) as Array<{ userId: string; teamId: number; metaUsername: string }>;

  const rows = new Map<string, WhitelistRow>();
  for (const player of players) {
    db.prepare(`INSERT INTO match_whitelist (match_id, arena_id, fleet_id, role_id, user_id, meta_username, status) VALUES (?, ?, ?, ?, ?, ?, 'PENDING')
      ON CONFLICT (match_id, user_id) DO UPDATE SET arena_id = excluded.arena_id, fleet_id = excluded.fleet_id, role_id = excluded.role_id,
        meta_username = excluded.meta_username, status = 'PENDING', last_error = NULL`)
      .run(matchId, arena.id, arena.stationId, arena.slot, player.userId, player.metaUsername);
    rows.set(player.userId, db.prepare('SELECT * FROM match_whitelist WHERE match_id = ? AND user_id = ?').get(matchId, player.userId) as WhitelistRow);
  }
  const fail = (player: { userId: string; metaUsername: string }, status: string, reason: string, shown = reason): WhitelistFailure => {
    setRow(rows.get(player.userId)!.id, status, reason);
    return { userId: player.userId, metaUsername: player.metaUsername, reason: shown };
  };

  if (!api) return players.map(p => fail(p, 'ERROR', 'Orion Drift API not configured', 'Orion Drift API isn’t set up'));
  const failures: WhitelistFailure[] = [];
  const missing = new Set<string>();
  for (const player of players) {
    const orionUserId = await api.findUserId(player.metaUsername, fleetsToSearch());
    if (!orionUserId) {
      missing.add(player.userId);
      failures.push(fail(player, 'NOT_FOUND', 'No Orion Drift account with that username', 'no Orion Drift account has that username — fix it with `/profile edit`'));
    } else {
      setRow(rows.get(player.userId)!.id, 'PENDING', null, orionUserId);
    }
  }
  // Players staff added by hand (/arena whitelist) are stored as "manual:<name>" rows with the team side they belong to.
  const manual = db.prepare("SELECT meta_username AS metaUsername, team_slot AS side FROM match_whitelist WHERE match_id = ? AND user_id LIKE 'manual:%'").all(matchId) as Array<{ metaUsername: string; side: number }>;
  const names = (teamId: number) => [...players.filter(p => p.teamId === teamId).map(p => p.metaUsername),
    ...manual.filter(m => m.side === (teamId === match.t1 ? 0 : 1)).map(m => m.metaUsername)];
  try {
    await api.setSlot(arena.stationId, arena.slot, { name: match.n1, players: names(match.t1) }, { name: match.n2, players: names(match.t2) });
    for (const player of players) if (!missing.has(player.userId)) setRow(rows.get(player.userId)!.id, 'GRANTED', null);
    db.prepare("UPDATE match_whitelist SET status = 'GRANTED', last_error = NULL WHERE match_id = ? AND user_id LIKE 'manual:%'").run(matchId);
  } catch (error) {
    db.prepare("UPDATE match_whitelist SET status = 'ERROR', last_error = ? WHERE match_id = ? AND user_id LIKE 'manual:%'").run(errorText(error), matchId);
    for (const player of players) if (!missing.has(player.userId)) failures.push(fail(player, 'ERROR', errorText(error)));
  }
  return failures;
}

/** Staff fix-up: let one extra player into (or take one back out of) a live match's arena. side 0 = team 1, side 1 = team 2. */
export async function manualWhitelist(matchId: number, username: string, side: 0 | 1, add: boolean): Promise<void> {
  const match = db.prepare("SELECT arena_id AS arenaId FROM matches WHERE id = ? AND status = 'READY'").get(matchId) as { arenaId: number | null } | undefined;
  if (!match) throw new UserError(`Match #${matchId} isn’t being played right now.`);
  const arena = match.arenaId === null ? undefined : db.prepare(`${ARENA_SELECT} WHERE id = ?`).get(match.arenaId) as Arena | undefined;
  if (!arena) throw new UserError(`Match #${matchId} doesn’t have an arena yet.`);
  const key = `manual:${username.toLowerCase()}`;
  if (add) {
    const api = orionOrNull();
    if (!api) throw new UserError('The Orion Drift API isn’t set up.');
    if (!await api.findUserId(username, fleetsToSearch())) throw new UserError(`No Orion Drift player called **${username}** was found. Check the spelling.`);
    db.prepare(`INSERT INTO match_whitelist (match_id, arena_id, fleet_id, role_id, user_id, meta_username, status, team_slot) VALUES (?, ?, ?, ?, ?, ?, 'PENDING', ?)
      ON CONFLICT (match_id, user_id) DO UPDATE SET team_slot = excluded.team_slot, meta_username = excluded.meta_username, status = 'PENDING'`)
      .run(matchId, arena.id, arena.stationId, arena.slot, key, username, side);
  } else if (!db.prepare('DELETE FROM match_whitelist WHERE match_id = ? AND user_id = ?').run(matchId, key).changes) {
    throw new UserError(`**${username}** wasn’t added by hand to match #${matchId}.`);
  }
  const failures = await serial(() => applyMatch(matchId, arena));
  const own = failures.find(f => f.metaUsername.toLowerCase() === username.toLowerCase());
  if (own && add) throw new UserError(`Couldn’t whitelist **${username}**: ${own.reason}`);
}

/** A player changed their Meta username: rewrite the whitelist of any live match they're in. */
export async function refreshWhitelistForUser(userId: string): Promise<void> {
  const matches = db.prepare(`SELECT m.id, m.arena_id AS arenaId FROM matches m JOIN team_members tm ON tm.team_id IN (m.team1_id, m.team2_id)
    WHERE tm.user_id = ? AND m.status = 'READY' AND m.arena_id IS NOT NULL`).all(userId) as Array<{ id: number; arenaId: number }>;
  for (const match of matches) {
    const arena = db.prepare(`${ARENA_SELECT} WHERE id = ?`).get(match.arenaId) as Arena | undefined;
    if (arena) await serial(() => applyMatch(match.id, arena));
  }
}

async function retryFailed(): Promise<void> {
  const matches = db.prepare(`SELECT DISTINCT m.id, m.arena_id AS arenaId FROM match_whitelist w JOIN matches m ON m.id = w.match_id
    LEFT JOIN players p ON p.user_id = w.user_id
    WHERE m.status = 'READY' AND m.arena_id IS NOT NULL
      AND (w.status = 'ERROR' OR (w.status = 'NOT_FOUND' AND p.meta_username IS NOT NULL AND p.meta_username != w.meta_username))`).all() as Array<{ id: number; arenaId: number }>;
  for (const match of matches) {
    const arena = db.prepare(`${ARENA_SELECT} WHERE id = ?`).get(match.arenaId) as Arena | undefined;
    if (arena) await applyMatch(match.id, arena);
  }
}

function matchPlayers(matchId: number): number {
  return (db.prepare('SELECT COUNT(*) AS c FROM matches m JOIN team_members tm ON tm.team_id IN (m.team1_id, m.team2_id) WHERE m.id = ?').get(matchId) as { c: number }).c;
}

async function assignWaitingMatches(): Promise<ReadyEvent[]> {
  const events: ReadyEvent[] = [];
  const waiting = db.prepare(`SELECT m.id, t.guild_id AS guildId, m.notified FROM matches m JOIN tournaments t ON t.id = m.tournament_id
    WHERE m.status = 'READY' AND m.arena_id IS NULL ORDER BY m.id`).all() as Array<{ id: number; guildId: string; notified: number }>;

  for (const match of waiting) {
    const arenas = db.prepare(`${ARENA_SELECT} WHERE guild_id = ? AND enabled = 1 ORDER BY id`).all(match.guildId) as Arena[];
    if (!arenas.length) {
      // No arenas set up for this server: just tell the captains the match is ready.
      if (!match.notified) {
        db.prepare('UPDATE matches SET notified = 1 WHERE id = ?').run(match.id);
        events.push({ matchId: match.id, arenaName: null, failures: [] });
      }
      continue;
    }
    const free = arenas.find(arena => !arenaBusy(arena.id));
    if (!free || !matchPlayers(match.id)) {
      // Stays queued until an arena frees up; say so once so players aren't left wondering.
      if (!match.notified) {
        db.prepare('UPDATE matches SET notified = 1 WHERE id = ?').run(match.id);
        events.push({ matchId: match.id, arenaName: null, queued: true, failures: [] });
      }
      continue;
    }

    db.prepare('UPDATE matches SET arena_id = ?, notified = 1, arena_assigned_at = ?, last_event_idx = 0 WHERE id = ?').run(free.id, new Date().toISOString(), match.id);
    events.push({ matchId: match.id, arenaName: free.name, failures: await applyMatch(match.id, free) });
  }
  return events;
}

async function runSync(): Promise<ReadyEvent[]> {
  await closeStale();
  await retryFailed();
  return assignWaitingMatches();
}

let chain: Promise<unknown> = Promise.resolve();

/**
 * Removes access from finished matches, retries failed whitelists, and gives free arenas
 * to matches that are ready. Runs one at a time. Returns matches that just became playable.
 */
export function syncArenas(): Promise<ReadyEvent[]> {
  return serial(runSync);
}

function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn);
  chain = next.catch(() => undefined);
  return next;
}
