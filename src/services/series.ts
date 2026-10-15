import { db } from '../db.js';
import { UserError } from '../util.js';
import { getMatch, recordResult } from './bracket.js';

export interface SeriesState {
  matchId: number;
  bestOf: number;
  winsNeeded: number;
  team1Wins: number;
  team2Wins: number;
  gamesPlayed: number;
  finished: boolean;
  seriesWinnerId: number | null;
}

export interface GameRow {
  game_number: number;
  winner_id: number;
  reported_by: string;
  confirmed_by: string;
  /** In-game score for the match's first / second team, when known. */
  score1: number | null;
  score2: number | null;
  created_at: string;
}

export function winsNeeded(bestOf: number): number {
  return Math.floor(bestOf / 2) + 1;
}

export function bestOfFor(matchId: number): number {
  const row = db.prepare('SELECT t.best_of FROM matches m JOIN tournaments t ON t.id = m.tournament_id WHERE m.id = ?').get(matchId) as { best_of: number } | undefined;
  return row?.best_of ?? 1;
}

export function seriesState(matchId: number): SeriesState {
  const match = getMatch(matchId);
  if (!match) throw new UserError(`Match #${matchId} doesn’t exist.`);
  const bestOf = bestOfFor(matchId);
  const needed = winsNeeded(bestOf);
  return {
    matchId,
    bestOf,
    winsNeeded: needed,
    team1Wins: match.team1_wins,
    team2Wins: match.team2_wins,
    gamesPlayed: match.team1_wins + match.team2_wins,
    finished: match.status === 'COMPLETE',
    seriesWinnerId: match.status === 'COMPLETE' ? match.winner_id : null
  };
}

export function listGames(matchId: number): GameRow[] {
  return db.prepare('SELECT game_number, winner_id, reported_by, confirmed_by, score1, score2, created_at FROM match_games WHERE match_id = ? ORDER BY game_number').all(matchId) as GameRow[];
}

/**
 * Records one game win. When a team reaches the wins needed (2 in a best of 3),
 * the series ends and the bracket advances.
 */
export function recordGameWin(matchId: number, winnerId: number, reportedBy: string, confirmedBy: string, expectedGame?: number, scores?: { score1: number; score2: number }): SeriesState {
  db.transaction(() => {
    const match = getMatch(matchId);
    if (!match) throw new UserError(`Match #${matchId} doesn’t exist.`);
    if (match.status === 'COMPLETE') throw new UserError(`Match #${matchId} is already finished.`);
    if (match.status !== 'READY') throw new UserError(`Match #${matchId} is still waiting on teams.`);
    if (winnerId !== match.team1_id && winnerId !== match.team2_id) throw new UserError('The winner has to be one of the two teams in this match.');
    const gameNumber = match.team1_wins + match.team2_wins + 1;
    if (expectedGame !== undefined && expectedGame !== gameNumber) throw new UserError(`That report was for game ${expectedGame}, but the series is already on game ${gameNumber}.`);

    db.prepare('INSERT INTO match_games (match_id, game_number, winner_id, reported_by, confirmed_by, score1, score2) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(matchId, gameNumber, winnerId, reportedBy, confirmedBy, scores?.score1 ?? null, scores?.score2 ?? null);
    const team1Wins = match.team1_wins + (winnerId === match.team1_id ? 1 : 0);
    const team2Wins = match.team2_wins + (winnerId === match.team2_id ? 1 : 0);
    db.prepare('UPDATE matches SET team1_wins = ?, team2_wins = ? WHERE id = ?').run(team1Wins, team2Wins, matchId);

    const needed = winsNeeded(bestOfFor(matchId));
    if (team1Wins >= needed || team2Wins >= needed) {
      recordResult(matchId, team1Wins >= needed ? match.team1_id! : match.team2_id!, team1Wins, team2Wins);
    }
  })();
  return seriesState(matchId);
}

/** Staff override: ends the series right away with the given game counts. */
export function forceSeriesResult(matchId: number, winnerId: number, team1Wins: number, team2Wins: number): void {
  db.transaction(() => {
    db.prepare('UPDATE matches SET team1_wins = ?, team2_wins = ? WHERE id = ?').run(team1Wins, team2Wins, matchId);
    recordResult(matchId, winnerId, team1Wins, team2Wins);
  })();
}

/**
 * Ends every ready match that involves a disqualified team, in favour of the opponent. Repeats because
 * a forfeit can make the next match ready against another disqualified team.
 */
export function forfeitDisqualified(): Array<{ matchId: number; tournamentId: number; winnerId: number; loserId: number }> {
  const done: Array<{ matchId: number; tournamentId: number; winnerId: number; loserId: number }> = [];
  for (;;) {
    const m = db.prepare(`SELECT id, tournament_id AS tid, team1_id AS t1, team2_id AS t2, d1, d2 FROM (
        SELECT m.*, EXISTS(SELECT 1 FROM registrations r WHERE r.tournament_id = m.tournament_id AND r.team_id = m.team1_id AND r.disqualified = 1) AS d1,
          EXISTS(SELECT 1 FROM registrations r WHERE r.tournament_id = m.tournament_id AND r.team_id = m.team2_id AND r.disqualified = 1) AS d2
        FROM matches m WHERE m.status = 'READY') WHERE d1 = 1 OR d2 = 1 LIMIT 1`).get() as { id: number; tid: number; t1: number; t2: number; d1: number; d2: number } | undefined;
    if (!m) return done;
    const winnerId = m.d1 ? m.t2 : m.t1;
    const needed = winsNeeded(bestOfFor(m.id));
    forceSeriesResult(m.id, winnerId, winnerId === m.t1 ? needed : 0, winnerId === m.t1 ? 0 : needed);
    done.push({ matchId: m.id, tournamentId: m.tid, winnerId, loserId: winnerId === m.t1 ? m.t2 : m.t1 });
  }
}

/**
 * Staff fix for a wrongly recorded game: removes the latest game and reopens the match if it had finished.
 * A finished match can only be reopened while the next match(es) it fed haven't started.
 */
export function undoLastGame(matchId: number): { gameNumber: number | null; reopened: boolean } {
  let gameNumber: number | null = null, reopened = false;
  db.transaction(() => {
    const match = getMatch(matchId);
    if (!match) throw new UserError(`Match #${matchId} doesn’t exist.`);
    if (match.status === 'WAITING') throw new UserError(`Match #${matchId} hasn’t started.`);
    const last = db.prepare('SELECT game_number FROM match_games WHERE match_id = ? ORDER BY game_number DESC LIMIT 1').get(matchId) as { game_number: number } | undefined;
    if (match.status === 'READY' && !last) throw new UserError(`Match #${matchId} has no recorded games to undo.`);

    if (match.status === 'COMPLETE') {
      if (match.bracket === 'GF') throw new UserError('Grand final results can’t be undone automatically. Delete and rebuild, or fix it by hand.');
      const nexts = [[match.next_win_id, match.next_win_slot], [match.next_lose_id, match.next_lose_slot]] as const;
      for (const [nextId] of nexts) {
        const next = nextId ? getMatch(nextId) : undefined;
        if (next && (next.status === 'COMPLETE' || next.arena_id !== null || next.team1_wins + next.team2_wins > 0)) {
          throw new UserError(`Match #${next.id} (the next round) has already started, so this result can’t be undone. Undo that one first.`);
        }
      }
      for (const [nextId, slot] of nexts) {
        if (!nextId) continue;
        const [teamCol, byeCol] = slot === 1 ? ['team1_id', 'team1_bye'] : ['team2_id', 'team2_bye'];
        db.prepare(`UPDATE matches SET ${teamCol} = NULL, ${byeCol} = 0, status = CASE WHEN status = 'READY' THEN 'WAITING' ELSE status END WHERE id = ?`).run(nextId);
      }
      db.prepare("UPDATE matches SET winner_id = NULL, score1 = NULL, score2 = NULL, status = 'READY', arena_id = NULL, arena_assigned_at = NULL, notified = 0 WHERE id = ?").run(matchId);
      db.prepare("UPDATE tournaments SET status = 'RUNNING', champion_team_id = NULL WHERE id = ? AND status = 'COMPLETE'").run(match.tournament_id);
      reopened = true;
    }
    if (last) {
      db.prepare('DELETE FROM match_games WHERE match_id = ? AND game_number = ?').run(matchId, last.game_number);
      gameNumber = last.game_number;
    }
    const wins = (teamId: number | null) => (db.prepare('SELECT COUNT(*) AS c FROM match_games WHERE match_id = ? AND winner_id = ?').get(matchId, teamId) as { c: number }).c;
    db.prepare('UPDATE matches SET team1_wins = ?, team2_wins = ?, disputed = 0, noshow_alerted = 0 WHERE id = ?').run(wins(match.team1_id), wins(match.team2_id), matchId);
  })();
  return { gameNumber, reopened };
}
