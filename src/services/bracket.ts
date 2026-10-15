import { db } from '../db.js';
import { UserError } from '../util.js';

export type Format = 'SINGLE' | 'DOUBLE';
export type BracketSide = 'W' | 'L' | 'GF';
export type MatchStatus = 'WAITING' | 'READY' | 'COMPLETE';

export interface MatchRow {
  id: number;
  tournament_id: number;
  bracket: BracketSide;
  round: number;
  position: number;
  team1_id: number | null;
  team2_id: number | null;
  team1_bye: number;
  team2_bye: number;
  winner_id: number | null;
  score1: number | null;
  score2: number | null;
  status: MatchStatus;
  notified: number;
  next_win_id: number | null;
  next_win_slot: number | null;
  next_lose_id: number | null;
  next_lose_slot: number | null;
  arena_id: number | null;
  team1_wins: number;
  team2_wins: number;
}

export function nextPowerOfTwo(n: number): number {
  let size = 1;
  while (size < n) size *= 2;
  return size;
}

/** Standard bracket seeding, e.g. size 8 → [1, 8, 4, 5, 2, 7, 3, 6]. Top seeds get the byes. */
export function seedOrder(size: number): number[] {
  let order = [1];
  while (order.length < size) {
    const total = order.length * 2;
    order = order.flatMap(seed => [seed, total + 1 - seed]);
  }
  return order;
}

type Node = { key: string; bracket: BracketSide; round: number; position: number; win?: { key: string; slot: 1 | 2 }; lose?: { key: string; slot: 1 | 2 } };
const key = (bracket: BracketSide, round: number, position: number) => `${bracket}:${round}:${position}`;
const slotFor = (position: number): 1 | 2 => (position % 2 === 1 ? 1 : 2);

/**
 * Builds the whole bracket for a tournament. `teamIds` must be in seed order (index 0 = seed 1).
 * Byes are filled automatically and advance on their own.
 */
export function generateBracket(tournamentId: number, teamIds: number[], format: Format): void {
  if (teamIds.length < 2) throw new UserError('A tournament needs at least 2 teams to start.');
  if (format === 'DOUBLE' && teamIds.length < 3) throw new UserError('Double elimination needs at least 3 teams.');
  const existing = db.prepare('SELECT COUNT(*) AS count FROM matches WHERE tournament_id = ?').get(tournamentId) as { count: number };
  if (existing.count) throw new UserError('This tournament already has a bracket.');

  const size = Math.max(2, nextPowerOfTwo(teamIds.length));
  const rounds = Math.log2(size);
  const nodes: Node[] = [];

  for (let round = 1; round <= rounds; round++) {
    const count = size / 2 ** round;
    for (let position = 1; position <= count; position++) {
      const node: Node = { key: key('W', round, position), bracket: 'W', round, position };
      if (round < rounds) node.win = { key: key('W', round + 1, Math.ceil(position / 2)), slot: slotFor(position) };
      else if (format === 'DOUBLE') node.win = { key: key('GF', 1, 1), slot: 1 };
      if (format === 'DOUBLE') {
        // Round 1 losers pair up in losers round 1. Later losers drop into the even losers rounds,
        // in reverse order so teams don't immediately replay someone they just met.
        node.lose = round === 1
          ? { key: key('L', 1, Math.ceil(position / 2)), slot: slotFor(position) }
          : { key: key('L', 2 * (round - 1), count - position + 1), slot: 2 };
      }
      nodes.push(node);
    }
  }

  if (format === 'DOUBLE') {
    const losersRounds = 2 * (rounds - 1);
    for (let round = 1; round <= losersRounds; round++) {
      const count = size / 2 ** (Math.ceil(round / 2) + 1);
      for (let position = 1; position <= count; position++) {
        const node: Node = { key: key('L', round, position), bracket: 'L', round, position };
        if (round === losersRounds) node.win = { key: key('GF', 1, 1), slot: 2 };
        else if (round % 2 === 1) node.win = { key: key('L', round + 1, position), slot: 1 };
        else node.win = { key: key('L', round + 1, Math.ceil(position / 2)), slot: slotFor(position) };
        nodes.push(node);
      }
    }
    nodes.push({ key: key('GF', 1, 1), bracket: 'GF', round: 1, position: 1 });
  }

  db.transaction(() => {
    const insert = db.prepare('INSERT INTO matches (tournament_id, bracket, round, position) VALUES (?, ?, ?, ?)');
    const ids = new Map<string, number>();
    for (const node of nodes) ids.set(node.key, Number(insert.run(tournamentId, node.bracket, node.round, node.position).lastInsertRowid));
    const link = db.prepare('UPDATE matches SET next_win_id = ?, next_win_slot = ?, next_lose_id = ?, next_lose_slot = ? WHERE id = ?');
    for (const node of nodes) {
      link.run(node.win ? ids.get(node.win.key)! : null, node.win?.slot ?? null, node.lose ? ids.get(node.lose.key)! : null, node.lose?.slot ?? null, ids.get(node.key)!);
    }
    const order = seedOrder(size);
    for (let position = 1; position <= size / 2; position++) {
      const matchId = ids.get(key('W', 1, position))!;
      const seedA = order[2 * position - 2], seedB = order[2 * position - 1];
      place(matchId, 1, seedA <= teamIds.length ? teamIds[seedA - 1] : null);
      place(matchId, 2, seedB <= teamIds.length ? teamIds[seedB - 1] : null);
    }
  })();
}

export function getMatch(id: number): MatchRow | undefined {
  return db.prepare('SELECT * FROM matches WHERE id = ?').get(id) as MatchRow | undefined;
}

/** Puts a team (or a bye when teamId is null) into one side of a match. */
function place(matchId: number, slot: number, teamId: number | null): void {
  const [teamCol, byeCol] = slot === 1 ? ['team1_id', 'team1_bye'] : ['team2_id', 'team2_bye'];
  db.prepare(`UPDATE matches SET ${teamCol} = ?, ${byeCol} = ? WHERE id = ?`).run(teamId, teamId === null ? 1 : 0, matchId);
  resolveIfFilled(matchId);
}

function resolveIfFilled(matchId: number): void {
  const match = getMatch(matchId)!;
  if (match.status !== 'WAITING') return;
  const oneFilled = match.team1_id !== null || match.team1_bye === 1;
  const twoFilled = match.team2_id !== null || match.team2_bye === 1;
  if (!oneFilled || !twoFilled) return;
  if (match.team1_id !== null && match.team2_id !== null) {
    db.prepare("UPDATE matches SET status = 'READY' WHERE id = ?").run(match.id);
    return;
  }
  // At least one side is a bye: the real team (if any) moves on without playing.
  complete(match, match.team1_id ?? match.team2_id, null, null);
}

function complete(match: MatchRow, winnerId: number | null, score1: number | null, score2: number | null): void {
  const loserId = winnerId === null ? null : winnerId === match.team1_id ? match.team2_id : match.team1_id;
  db.prepare("UPDATE matches SET winner_id = ?, score1 = ?, score2 = ?, status = 'COMPLETE' WHERE id = ?").run(winnerId, score1, score2, match.id);
  if (match.next_win_id) place(match.next_win_id, match.next_win_slot!, winnerId);
  if (match.next_lose_id) place(match.next_lose_id, match.next_lose_slot!, loserId);

  // Grand final: if the losers-bracket team beats the undefeated team, play a reset match.
  if (match.bracket === 'GF' && match.round === 1 && winnerId !== null && match.team1_id !== null && winnerId === match.team2_id) {
    db.prepare("INSERT INTO matches (tournament_id, bracket, round, position, team1_id, team2_id, status) VALUES (?, 'GF', 2, 1, ?, ?, 'READY')")
      .run(match.tournament_id, match.team1_id, match.team2_id);
    return;
  }
  if (!match.next_win_id) {
    db.prepare("UPDATE tournaments SET status = 'COMPLETE', champion_team_id = ? WHERE id = ?").run(winnerId, match.tournament_id);
  }
}

/** Records a played result. Scores are in match order (team1, team2). */
export function recordResult(matchId: number, winnerId: number, score1: number, score2: number): MatchRow {
  db.transaction(() => {
    const match = getMatch(matchId);
    if (!match) throw new UserError(`Match #${matchId} doesn’t exist.`);
    if (match.status === 'COMPLETE') throw new UserError(`Match #${matchId} is already finished.`);
    if (match.status !== 'READY') throw new UserError(`Match #${matchId} is still waiting on teams.`);
    if (winnerId !== match.team1_id && winnerId !== match.team2_id) throw new UserError('The winner has to be one of the two teams in this match.');
    complete(match, winnerId, score1, score2);
    db.prepare("UPDATE match_reports SET status = 'CLOSED' WHERE match_id = ? AND status IN ('PENDING', 'DISPUTED')").run(matchId);
  })();
  return getMatch(matchId)!;
}

export interface MatchView extends MatchRow { team1_name: string | null; team2_name: string | null; tournament_name: string; format: Format; guild_id: string; best_of: number; arena_name: string | null }

const VIEW_SELECT = `SELECT m.*, a.name AS team1_name, b.name AS team2_name, t.name AS tournament_name, t.format, t.guild_id, t.best_of, ar.name AS arena_name
  FROM matches m JOIN tournaments t ON t.id = m.tournament_id
  LEFT JOIN teams a ON a.id = m.team1_id LEFT JOIN teams b ON b.id = m.team2_id
  LEFT JOIN arenas ar ON ar.id = m.arena_id`;

export function getMatchView(id: number): MatchView | undefined {
  return db.prepare(`${VIEW_SELECT} WHERE m.id = ?`).get(id) as MatchView | undefined;
}

export function listMatchViews(tournamentId: number): MatchView[] {
  return db.prepare(`${VIEW_SELECT} WHERE m.tournament_id = ?
    ORDER BY CASE m.bracket WHEN 'W' THEN 1 WHEN 'L' THEN 2 ELSE 3 END, m.round, m.position`).all(tournamentId) as MatchView[];
}

export function openMatchesForTeam(teamId: number): MatchView[] {
  return db.prepare(`${VIEW_SELECT} WHERE m.status = 'READY' AND (m.team1_id = ? OR m.team2_id = ?) ORDER BY m.id`).all(teamId, teamId) as MatchView[];
}

export function roundTitle(match: Pick<MatchRow, 'bracket' | 'round'>, format: Format, maxRound: number): string {
  if (match.bracket === 'GF') return match.round === 1 ? 'Grand Final' : 'Grand Final Reset';
  if (match.bracket === 'L') return match.round === maxRound ? 'Losers Final' : `Losers Round ${match.round}`;
  const fromEnd = maxRound - match.round;
  if (format === 'DOUBLE') return fromEnd === 0 ? 'Winners Final' : `Winners Round ${match.round}`;
  if (fromEnd === 0) return 'Final';
  if (fromEnd === 1) return 'Semifinals';
  if (fromEnd === 2) return 'Quarterfinals';
  return `Round ${match.round}`;
}

export function isByeMatch(match: MatchRow): boolean {
  return match.team1_bye === 1 || match.team2_bye === 1;
}
