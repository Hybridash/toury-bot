import { db } from '../db.js';

export interface TeamRecord {
  matchesWon: number;
  matchesLost: number;
  gamesWon: number;
  gamesLost: number;
  titles: number;
}

export function teamRecord(teamId: number): TeamRecord {
  const count = (sql: string) => (db.prepare(sql).get(teamId, teamId) as { c: number }).c;
  const finished = "FROM matches m WHERE m.status = 'COMPLETE' AND m.winner_id IS NOT NULL AND (m.team1_id = ? OR m.team2_id = ?)";
  const games = 'FROM match_games g JOIN matches m ON m.id = g.match_id WHERE (m.team1_id = ? OR m.team2_id = ?)';
  const won = (db.prepare(`SELECT COUNT(*) AS c ${finished} AND m.winner_id = ?`).get(teamId, teamId, teamId) as { c: number }).c;
  const played = count(`SELECT COUNT(*) AS c ${finished}`);
  const gamesWon = (db.prepare(`SELECT COUNT(*) AS c ${games} AND g.winner_id = ?`).get(teamId, teamId, teamId) as { c: number }).c;
  const gamesPlayed = count(`SELECT COUNT(*) AS c ${games}`);
  const titles = (db.prepare('SELECT COUNT(*) AS c FROM tournaments WHERE champion_team_id = ?').get(teamId) as { c: number }).c;
  return { matchesWon: won, matchesLost: played - won, gamesWon, gamesLost: gamesPlayed - gamesWon, titles };
}

export interface HistoryRow {
  matchId: number;
  tournament: string;
  opponent: string | null;
  won: boolean;
  teamGames: number;
  opponentGames: number;
}

/** Finished matches for a team, newest first. */
export function teamHistory(teamId: number, limit = 50): HistoryRow[] {
  const rows = db.prepare(`SELECT m.id AS matchId, t.name AS tournament, m.team1_id AS t1, m.team2_id AS t2, m.winner_id AS winnerId, m.team1_wins AS w1, m.team2_wins AS w2,
      a.name AS n1, b.name AS n2 FROM matches m JOIN tournaments t ON t.id = m.tournament_id LEFT JOIN teams a ON a.id = m.team1_id LEFT JOIN teams b ON b.id = m.team2_id
    WHERE m.status = 'COMPLETE' AND m.winner_id IS NOT NULL AND (m.team1_id = ? OR m.team2_id = ?) ORDER BY m.id DESC LIMIT ?`).all(teamId, teamId, limit) as
    Array<{ matchId: number; tournament: string; t1: number; t2: number; winnerId: number; w1: number; w2: number; n1: string | null; n2: string | null }>;
  return rows.map(r => {
    const first = r.t1 === teamId;
    return { matchId: r.matchId, tournament: r.tournament, opponent: first ? r.n2 : r.n1, won: r.winnerId === teamId, teamGames: first ? r.w1 : r.w2, opponentGames: first ? r.w2 : r.w1 };
  });
}
