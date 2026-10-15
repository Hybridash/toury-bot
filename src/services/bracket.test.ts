import { describe, expect, it } from 'vitest';
import { db } from '../db.js';
import { generateBracket, getMatch, recordResult, seedOrder, type Format, type MatchRow } from './bracket.js';

let nextTournament = 1;

function makeTournament(format: Format): number {
  const id = nextTournament++;
  db.prepare(`INSERT INTO tournaments (id, guild_id, name, region, format, max_teams, min_roster, max_roster, created_by)
    VALUES (?, 'g', ?, 'NA', ?, 64, 1, 5, 'u')`).run(id, `T${id}`, format);
  return id;
}

function status(tournamentId: number) {
  return db.prepare('SELECT status, champion_team_id AS champion FROM tournaments WHERE id = ?').get(tournamentId) as { status: string; champion: number | null };
}

/** Plays every ready match until the tournament ends. Returns losses per team. */
function playOut(tournamentId: number, pick: (m: MatchRow) => number) {
  const losses = new Map<number, number>();
  for (let guard = 0; guard < 1000; guard++) {
    const ready = db.prepare("SELECT * FROM matches WHERE tournament_id = ? AND status = 'READY' ORDER BY id LIMIT 1").get(tournamentId) as MatchRow | undefined;
    if (!ready) break;
    const winner = pick(ready);
    const loser = winner === ready.team1_id ? ready.team2_id! : ready.team1_id!;
    losses.set(loser, (losses.get(loser) ?? 0) + 1);
    recordResult(ready.id, winner, winner === ready.team1_id ? 2 : 0, winner === ready.team1_id ? 0 : 2);
  }
  return losses;
}

const random = (m: MatchRow) => (Math.random() < 0.5 ? m.team1_id! : m.team2_id!);

describe('seedOrder', () => {
  it('puts top seeds far apart', () => {
    expect(seedOrder(4)).toEqual([1, 4, 2, 3]);
    expect(seedOrder(8)).toEqual([1, 8, 4, 5, 2, 7, 3, 6]);
  });
});

describe('single elimination', () => {
  for (const count of [2, 3, 5, 8, 13, 16]) {
    it(`finishes with ${count} teams and everyone but the champ loses once`, () => {
      const t = makeTournament('SINGLE');
      const teams = Array.from({ length: count }, (_, i) => 1000 + i);
      generateBracket(t, teams, 'SINGLE');
      const losses = playOut(t, random);
      const result = status(t);
      expect(result.status).toBe('COMPLETE');
      expect(result.champion).not.toBeNull();
      for (const team of teams) expect(losses.get(team) ?? 0).toBe(team === result.champion ? 0 : 1);
    });
  }

  it('top seed wins when favourites always win', () => {
    const t = makeTournament('SINGLE');
    generateBracket(t, [1, 2, 3, 4, 5, 6], 'SINGLE');
    playOut(t, m => Math.min(m.team1_id!, m.team2_id!));
    expect(status(t).champion).toBe(1);
  });
});

describe('double elimination', () => {
  for (const count of [3, 4, 5, 6, 8, 11, 12, 16, 32]) {
    it(`finishes with ${count} teams and everyone but the champ loses twice`, () => {
      for (let run = 0; run < 20; run++) {
        const t = makeTournament('DOUBLE');
        const teams = Array.from({ length: count }, (_, i) => 2000 + i);
        generateBracket(t, teams, 'DOUBLE');
        const losses = playOut(t, random);
        const result = status(t);
        expect(result.status).toBe('COMPLETE');
        for (const team of teams) {
          if (team === result.champion) expect(losses.get(team) ?? 0).toBeLessThanOrEqual(1);
          else expect(losses.get(team)).toBe(2);
        }
        const stuck = db.prepare("SELECT COUNT(*) AS c FROM matches WHERE tournament_id = ? AND status != 'COMPLETE'").get(t) as { c: number };
        expect(stuck.c).toBe(0);
      }
    });
  }

  it('plays a grand final reset when the losers-bracket team wins the first final', () => {
    const t = makeTournament('DOUBLE');
    generateBracket(t, [1, 2, 3, 4], 'DOUBLE');
    // Lower id wins everything except the grand final, where team 2 (from losers) wins twice.
    playOut(t, m => (m.bracket === 'GF' ? 2 : Math.min(m.team1_id!, m.team2_id!)));
    const finals = db.prepare("SELECT * FROM matches WHERE tournament_id = ? AND bracket = 'GF' ORDER BY round").all(t) as MatchRow[];
    expect(finals).toHaveLength(2);
    expect(status(t).champion).toBe(2);
  });

  it('rejects results for matches that are not ready', () => {
    const t = makeTournament('DOUBLE');
    generateBracket(t, [1, 2, 3, 4], 'DOUBLE');
    const waiting = db.prepare("SELECT id FROM matches WHERE tournament_id = ? AND status = 'WAITING' LIMIT 1").get(t) as { id: number };
    expect(() => recordResult(waiting.id, 1, 1, 0)).toThrow();
    expect(getMatch(waiting.id)!.status).toBe('WAITING');
  });
});
