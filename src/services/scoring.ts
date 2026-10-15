import { db } from '../db.js';
import { orionOrNull } from '../integrations/orion.js';
import { UserError } from '../util.js';
import { recordGameWin, type SeriesState } from './series.js';

/**
 * Automatic scoring. Orion Drift emits a "gamemode_stopped" event when a game ends; the trigger
 * "team0 match win" / "team1 match win" says who won ("round win" / "round reset" / "draw" are ignored).
 * team0 is the first team listed in the match, team1 the second (that's how the arena whitelist is written).
 */

export interface ScoredGame {
  matchId: number;
  winnerId: number;
  state: SeriesState;
}

const MATCH_WIN = /^team([01]) match win$/;

type Live = { id: number; team1_id: number; team2_id: number; stationId: string; slot: string; assignedAt: string; lastIdx: number };

export interface PollResult {
  games: ScoredGame[];
  /** Matches where a game ended in a draw with players present (not counted; staff/players need to replay). */
  draws: number[];
  /** True if Orion Drift couldn't be reached for at least one station. */
  failed: boolean;
}

export async function pollScores(): Promise<PollResult> {
  const api = orionOrNull();
  const result: PollResult = { games: [], draws: [], failed: false };
  if (!api) return result;
  const live = db.prepare(`SELECT m.id, m.team1_id, m.team2_id, a.fleet_id AS stationId, a.role_id AS slot, m.arena_assigned_at AS assignedAt, m.last_event_idx AS lastIdx
    FROM matches m JOIN arenas a ON a.id = m.arena_id WHERE m.status = 'READY' AND m.disputed = 0 AND m.arena_assigned_at IS NOT NULL`).all() as Live[];

  for (const station of new Set(live.map(m => m.stationId))) {
    const events = await api.listGameEnds(station).catch(() => null);
    if (!events) { result.failed = true; continue; }
    for (const match of live.filter(m => m.stationId === station)) {
      const mine = events
        .filter(e => e.slot.toLowerCase() === match.slot.toLowerCase() && e.idx > match.lastIdx && Date.parse(e.timestamp) > Date.parse(match.assignedAt))
        .sort((a, b) => a.idx - b.idx);
      for (const event of mine) {
        db.prepare('UPDATE matches SET last_event_idx = ? WHERE id = ?').run(event.idx, match.id);
        if (event.trigger === 'draw' && event.playerCount > 0) result.draws.push(match.id);
        const win = MATCH_WIN.exec(event.trigger);
        if (!win) continue;
        const winnerId = win[1] === '0' ? match.team1_id : match.team2_id;
        try {
          const state = recordGameWin(match.id, winnerId, 'auto', 'auto', undefined, { score1: event.scores[0], score2: event.scores[1] });
          result.games.push({ matchId: match.id, winnerId, state });
          if (state.finished) break;
        } catch (error) {
          console.warn(`[scoring] match ${match.id}:`, error instanceof Error ? error.message : error);
          break;
        }
      }
    }
  }
  return result;
}

/**
 * Staff recovery: re-reads this match's arena events and records any "match win" games that were missed
 * (games already counted are skipped, so running it twice is safe).
 */
export async function rescoreMatch(matchId: number): Promise<ScoredGame[]> {
  const api = orionOrNull();
  const match = db.prepare(`SELECT m.id, m.team1_id, m.team2_id, a.fleet_id AS stationId, a.role_id AS slot, m.arena_assigned_at AS assignedAt, m.team1_wins + m.team2_wins AS played
    FROM matches m JOIN arenas a ON a.id = m.arena_id WHERE m.id = ? AND m.status = 'READY' AND m.arena_assigned_at IS NOT NULL`).get(matchId) as
    { id: number; team1_id: number; team2_id: number; stationId: string; slot: string; assignedAt: string; played: number } | undefined;
  if (!api || !match) throw new UserError(`Match #${matchId} isn’t running in an arena right now.`);
  db.prepare('UPDATE matches SET disputed = 0 WHERE id = ?').run(matchId); // staff looking at it ends the freeze
  const events = (await api.listGameEnds(match.stationId))
    .filter(e => e.slot.toLowerCase() === match.slot.toLowerCase() && Date.parse(e.timestamp) > Date.parse(match.assignedAt))
    .sort((a, b) => a.idx - b.idx);
  const wins = events.filter(e => MATCH_WIN.test(e.trigger));
  const recorded: ScoredGame[] = [];
  for (const event of wins.slice(match.played)) {
    const winnerId = MATCH_WIN.exec(event.trigger)![1] === '0' ? match.team1_id : match.team2_id;
    const state = recordGameWin(match.id, winnerId, 'rescore', 'rescore', undefined, { score1: event.scores[0], score2: event.scores[1] });
    recorded.push({ matchId: match.id, winnerId, state });
    if (state.finished) break;
  }
  if (events.length) db.prepare('UPDATE matches SET last_event_idx = ? WHERE id = ?').run(events[events.length - 1].idx, match.id);
  return recorded;
}
