import { db } from '../db.js';
import { UserError } from '../util.js';
import { getMatch } from './bracket.js';

export type ReportStatus = 'PENDING' | 'CONFIRMED' | 'DISPUTED' | 'CLOSED';

/** A captain's claim about who won one game of a series, waiting for the other captain. */
export interface MatchReport {
  id: number;
  match_id: number;
  reporter_id: string;
  reporter_team_id: number;
  winner_id: number;
  game_number: number;
  status: ReportStatus;
}

export function createGameReport(matchId: number, reporterId: string, reporterTeamId: number, winnerId: number): MatchReport {
  const match = getMatch(matchId);
  if (!match || match.status !== 'READY') throw new UserError(`Match #${matchId} isn’t ready for a result.`);
  const gameNumber = match.team1_wins + match.team2_wins + 1;
  const id = db.transaction(() => {
    db.prepare("UPDATE match_reports SET status = 'CLOSED' WHERE match_id = ? AND status IN ('PENDING', 'DISPUTED')").run(matchId);
    return Number(db.prepare(`INSERT INTO match_reports (match_id, reporter_id, reporter_team_id, winner_id, score1, score2, game_number)
      VALUES (?, ?, ?, ?, 0, 0, ?)`).run(matchId, reporterId, reporterTeamId, winnerId, gameNumber).lastInsertRowid);
  })();
  return getReport(id)!;
}

export function getReport(id: number): MatchReport | undefined {
  return db.prepare('SELECT id, match_id, reporter_id, reporter_team_id, winner_id, game_number, status FROM match_reports WHERE id = ?').get(id) as MatchReport | undefined;
}

export function setReportStatus(id: number, status: ReportStatus): void {
  db.prepare('UPDATE match_reports SET status = ? WHERE id = ?').run(status, id);
}
