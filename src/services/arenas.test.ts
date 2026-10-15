import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../db.js';
import { setOrionApi, type GameEndEvent, type OrionApi, type SlotTeam } from '../integrations/orion.js';
import { registerPlayer } from './players.js';
import { acceptInvite, createInvite, createTeam, type Team } from './teams.js';
import { addTeamAsStaff, createTournament, rollbackStart, signUp, startTournament, withdraw, type Tournament } from './tournaments.js';
import { addArena, manualWhitelist, syncArenas, whitelistFor } from './arenas.js';
import { setSetting, threadChannelId } from './settings.js';
import { recordGameWin, seriesState } from './series.js';
import { pollScores, rescoreMatch } from './scoring.js';
import { teamHistory, teamRecord } from './stats.js';
import { bannedAmong, clearBanCache } from './bans.js';
import { listGames, forfeitDisqualified, undoLastGame } from './series.js';
import { normalizeSlot } from './arenas.js';
import { disqualifyTeam } from './tournaments.js';
import { refreshWhitelistForUser } from './arenas.js';
import type { MatchRow } from './bracket.js';

/** Fake Orion Drift: tracks who is whitelisted in which arena slot. */
class FakeOrion implements OrionApi {
  listBans: OrionApi['listBans'] = async () => [];
  slots = new Map<string, { team0: string[]; team1: string[] }>(); // `${station}:${slot}`
  unknown = new Set<string>(['ghostplayer']);
  failNextSet = false;
  events: GameEndEvent[] = [];
  async findUserId(username: string) { return this.unknown.has(username.toLowerCase()) ? undefined : `id-${username.toLowerCase()}`; }
  async banUser() {}
  async unbanUser() {}
  async setSlot(station: string, slot: string, team0: SlotTeam | null, team1: SlotTeam | null) {
    if (this.failNextSet) { this.failNextSet = false; throw new Error('boom'); }
    this.slots.set(`${station}:${slot}`, { team0: team0?.players.map(p => p.toLowerCase()) ?? [], team1: team1?.players.map(p => p.toLowerCase()) ?? [] });
  }
  async listGameEnds() { return this.events; }
  members(station: string, slot = 'Arena') {
    const entry = this.slots.get(`${station}:${slot}`);
    return entry ? [...entry.team0, ...entry.team1].sort() : [];
  }
}

let guildCounter = 0;
let fake: FakeOrion;

function setupTournament(teamCount: number, rosterSize: number, bestOf: number, arenas: number) {
  const guild = `arena-guild-${++guildCounter}`;
  const teams: Team[] = [];
  for (let t = 0; t < teamCount; t++) {
    const prefix = `${guild}-t${t}`;
    registerPlayer(`${prefix}-p0`, `${prefix}-p0`, 'NA', 'UTC');
    const team = createTeam(guild, `${prefix}-p0`, `Team ${t}`);
    for (let p = 1; p < rosterSize; p++) {
      registerPlayer(`${prefix}-p${p}`, `${prefix}-p${p}`, 'NA', 'UTC');
      acceptInvite(createInvite(team, `${prefix}-p0`, `${prefix}-p${p}`, '@x').id, `${prefix}-p${p}`);
    }
    teams.push(team);
  }
  for (let a = 1; a <= arenas; a++) addArena(guild, `Arena ${a}`, `${guild}-fleet${a}`, 'Arena');
  const tournament: Tournament = createTournament(guild, { name: 'Cup', region: 'NA', format: 'SINGLE', maxTeams: 16, minRoster: rosterSize, maxRoster: rosterSize, requireApproval: false, bestOf }, 'staff');
  for (const team of teams) signUp(tournament, team);
  startTournament(tournament, false);
  return { guild, teams, tournament };
}

function readyMatches(tournamentId: number): MatchRow[] {
  return db.prepare("SELECT * FROM matches WHERE tournament_id = ? AND status = 'READY' ORDER BY id").all(tournamentId) as MatchRow[];
}

beforeEach(() => {
  fake = new FakeOrion();
  setOrionApi(fake);
});

describe('best-of series', () => {
  it('needs 2 game wins in a best of 3, then advances the bracket', () => {
    const { tournament } = setupTournament(2, 1, 3, 0);
    const [match] = readyMatches(tournament.id);
    let state = recordGameWin(match.id, match.team1_id!, 'a', 'b');
    expect(state).toMatchObject({ team1Wins: 1, team2Wins: 0, finished: false, winsNeeded: 2 });
    state = recordGameWin(match.id, match.team2_id!, 'a', 'b');
    expect(state).toMatchObject({ team1Wins: 1, team2Wins: 1, finished: false });
    state = recordGameWin(match.id, match.team1_id!, 'a', 'b');
    expect(state).toMatchObject({ team1Wins: 2, team2Wins: 1, finished: true, seriesWinnerId: match.team1_id });
    const t = db.prepare('SELECT status, champion_team_id FROM tournaments WHERE id = ?').get(tournament.id) as { status: string; champion_team_id: number };
    expect(t.status).toBe('COMPLETE');
    expect(t.champion_team_id).toBe(match.team1_id);
    expect(() => recordGameWin(match.id, match.team1_id!, 'a', 'b')).toThrow(/already finished/);
  });

  it('rejects a stale report for a game that was already counted', () => {
    const { tournament } = setupTournament(2, 1, 3, 0);
    const [match] = readyMatches(tournament.id);
    recordGameWin(match.id, match.team1_id!, 'a', 'b', 1);
    expect(() => recordGameWin(match.id, match.team1_id!, 'a', 'b', 1)).toThrow(/game 2/);
    expect(seriesState(match.id).team1Wins).toBe(1);
  });

  it('best of 1 ends after one game', () => {
    const { tournament } = setupTournament(2, 1, 1, 0);
    const [match] = readyMatches(tournament.id);
    expect(recordGameWin(match.id, match.team2_id!, 'a', 'b').finished).toBe(true);
  });
});

describe('arena whitelisting', () => {
  it('whitelists both 8-player rosters into one arena, and removes them when the match ends', async () => {
    const { tournament, guild } = setupTournament(2, 8, 3, 1);
    const ids = readyMatches(tournament.id).map(m => m.id);
    const events = (await syncArenas()).filter(e => ids.includes(e.matchId));
    expect(events).toHaveLength(1);
    expect(events[0].arenaName).toBe('Arena 1');
    expect(events[0].failures).toEqual([]);
    expect(fake.members(`${guild}-fleet1`)).toHaveLength(16);

    const [match] = readyMatches(tournament.id);
    recordGameWin(match.id, match.team1_id!, 'a', 'b');
    recordGameWin(match.id, match.team1_id!, 'a', 'b');
    await syncArenas();
    expect(fake.members(`${guild}-fleet1`)).toEqual([]);
    expect(whitelistFor(match.id).every(w => w.status === 'REVOKED')).toBe(true);
  });

  it('queues matches when every arena is busy, then hands the freed arena over', async () => {
    const { tournament, guild } = setupTournament(4, 2, 1, 1);
    const ids = readyMatches(tournament.id).map(m => m.id);
    const first = (await syncArenas()).filter(e => ids.includes(e.matchId));
    expect(first.filter(e => e.arenaName)).toHaveLength(1); // only one arena → second semifinal waits
    expect(first.filter(e => e.queued)).toHaveLength(1); // ...and its captains are told so, once
    expect((await syncArenas()).filter(e => ids.includes(e.matchId) && e.queued)).toHaveLength(0);
    const [a, b] = readyMatches(tournament.id);
    expect(a.arena_id).not.toBeNull();
    expect(b.arena_id).toBeNull();
    const playersInA = fake.members(`${guild}-fleet1`);
    expect(playersInA).toHaveLength(4);

    recordGameWin(a.id, a.team1_id!, 'x', 'y');
    const second = (await syncArenas()).filter(e => ids.includes(e.matchId));
    expect(second.map(e => e.matchId)).toEqual([b.id]);
    // Only match B's players are in the arena now.
    const nowIn = fake.members(`${guild}-fleet1`);
    expect(nowIn).toHaveLength(4);
    expect(nowIn.some(name => playersInA.includes(name))).toBe(false);
  });

  it('keeps access for a player whose team advances into the same arena', async () => {
    const { tournament, guild } = setupTournament(4, 1, 1, 1);
    await syncArenas();
    const [a, b] = readyMatches(tournament.id);
    recordGameWin(a.id, a.team1_id!, 'x', 'y');
    await syncArenas(); // B gets the arena
    recordGameWin(b.id, b.team1_id!, 'x', 'y');
    await syncArenas(); // final gets the arena; A's winner was revoked earlier and is re-granted
    const [final] = readyMatches(tournament.id);
    expect(final.arena_id).not.toBeNull();
    expect(fake.members(`${guild}-fleet1`)).toHaveLength(2);
  });

  it('reports players whose Meta username has no Orion account, and retries after they fix it', async () => {
    const { tournament, guild } = setupTournament(2, 1, 1, 1);
    const [match] = readyMatches(tournament.id);
    const ghost = db.prepare('SELECT user_id FROM team_members WHERE team_id = ?').get(match.team1_id) as { user_id: string };
    db.prepare("UPDATE players SET meta_username = 'GhostPlayer' WHERE user_id = ?").run(ghost.user_id);
    const events = (await syncArenas()).filter(e => e.matchId === match.id);
    expect(events[0].failures).toHaveLength(1);
    expect(events[0].failures[0].metaUsername).toBe('GhostPlayer');

    db.prepare("UPDATE players SET meta_username = 'RealPlayer' WHERE user_id = ?").run(ghost.user_id);
    await syncArenas();
    expect(fake.members(`${guild}-fleet1`)).toContain('realplayer');
  });

  it('retries a whitelist that failed because of an API error', async () => {
    const { guild, tournament } = setupTournament(2, 1, 1, 1);
    fake.failNextSet = true;
    const [match] = readyMatches(tournament.id);
    const events = (await syncArenas()).filter(e => e.matchId === match.id);
    expect(events[0].failures).toHaveLength(2); // the whole arena write failed, so both players are reported
    await syncArenas();
    expect(fake.members(`${guild}-fleet1`, 'Arena')).toHaveLength(2);
  });

  it('still removes access if the tournament is deleted mid-match', async () => {
    const { tournament, guild } = setupTournament(2, 2, 3, 1);
    await syncArenas();
    expect(fake.members(`${guild}-fleet1`)).toHaveLength(4);
    const matchIds = (db.prepare('SELECT id FROM matches WHERE tournament_id = ?').all(tournament.id) as Array<{ id: number }>).map(m => m.id);
    db.prepare('DELETE FROM tournaments WHERE id = ?').run(tournament.id);
    await syncArenas();
    expect(fake.members(`${guild}-fleet1`)).toEqual([]);
    expect(matchIds.flatMap(id => whitelistFor(id))).toEqual([]); // the whitelist records are gone too
  });
});

describe('automatic scoring', () => {
  it('scores a best-of-3 from "match win" events in the right arena, ignoring rounds and old events', async () => {
    const { tournament, guild } = setupTournament(2, 1, 3, 1);
    await syncArenas();
    const [match] = readyMatches(tournament.id);
    const future = (n: number) => new Date(Date.now() + n * 1000).toISOString();
    const ev = (idx: number, trigger: string, slot = 'Arena') => ({ idx, slot, trigger, timestamp: future(idx), playerCount: 2, scores: [6, 5] as [number, number] });
    fake.events = [
      ev(7, 'team1 match win'), ev(6, 'team0 round win'), ev(5, 'team0 match win'), ev(4, 'team0 match win', 'Other Slot'),
      { idx: 1, slot: 'Arena', trigger: 'team1 match win', timestamp: '2000-01-01T00:00:00Z', playerCount: 2, scores: [6, 5] as [number, number] } // before the match started
    ];
    const mine = async () => (await pollScores()).games.filter(g => g.matchId === match.id);
    let scored = await mine();
    expect(scored.map(g => g.winnerId)).toEqual([match.team1_id, match.team2_id]);
    expect(seriesState(match.id)).toMatchObject({ team1Wins: 1, team2Wins: 1, finished: false });

    expect(await mine()).toEqual([]); // same events aren't counted twice
    fake.events.unshift(ev(9, 'team0 match win'));
    scored = await mine();
    expect(scored[0].state).toMatchObject({ finished: true, seriesWinnerId: match.team1_id });
    expect(guild).toBeTruthy();
  });
});

describe('manual whitelist', () => {
  it('adds a substitute to the right team and removes them again', async () => {
    const { tournament, guild } = setupTournament(2, 1, 1, 1);
    await syncArenas();
    const [match] = readyMatches(tournament.id);
    await manualWhitelist(match.id, 'SubPlayer', 1, true);
    const slot = fake.slots.get(`${guild}-fleet1:Arena`)!;
    expect(slot.team1).toContain('subplayer');
    expect(slot.team0).not.toContain('subplayer');
    await manualWhitelist(match.id, 'SubPlayer', 1, false);
    expect(fake.members(`${guild}-fleet1`)).toHaveLength(2);
    await expect(manualWhitelist(match.id, 'GhostPlayer', 0, true)).rejects.toThrow(/No Orion Drift player/);
  });
});

describe('start rollback and staff add', () => {
  it('rollbackStart removes the bracket so staff can swap a team and start again', () => {
    const { tournament, teams } = setupTournament(2, 1, 1, 0);
    expect(readyMatches(tournament.id)).toHaveLength(1);
    rollbackStart(tournament);
    expect(db.prepare('SELECT COUNT(*) AS c FROM matches WHERE tournament_id = ?').get(tournament.id)).toEqual({ c: 0 });
    expect(db.prepare('SELECT status FROM tournaments WHERE id = ?').get(tournament.id)).toEqual({ status: 'CLOSED' });
    const closed = { ...tournament, status: 'CLOSED' as const };
    withdraw(closed, teams[1]);
    expect(() => startTournament(closed, false)).toThrow(/at least 2/);
    addTeamAsStaff(closed, teams[1]);
    expect(() => addTeamAsStaff(closed, teams[1])).toThrow(/already in/);
    expect(startTournament(closed, false)).toHaveLength(2);
  });
});

describe('settings', () => {
  it('saved values beat .env defaults and can be cleared', () => {
    expect(threadChannelId()).toBeUndefined();
    setSetting('thread_channel_id', '123');
    expect(threadChannelId()).toBe('123');
    setSetting('thread_channel_id', null);
    expect(threadChannelId()).toBeUndefined();
  });
});

describe('disqualification', () => {
  it('forfeits the current match and every later one for a disqualified team', () => {
    const { tournament, teams } = setupTournament(4, 1, 1, 0);
    const running = { ...tournament, status: 'RUNNING' as const };
    const opponentId = (() => { const m = readyMatches(tournament.id).find(x => x.team1_id === teams[0].id || x.team2_id === teams[0].id)!; return m.team1_id === teams[0].id ? m.team2_id : m.team1_id; })();
    disqualifyTeam(running, teams[0]);
    expect(() => disqualifyTeam(running, teams[0])).toThrow(/already disqualified/);
    const forfeits = forfeitDisqualified();
    expect(forfeits.filter(f => f.tournamentId === tournament.id)).toHaveLength(1);
    expect(forfeits.find(f => f.tournamentId === tournament.id)!.winnerId).toBe(opponentId);
    // The other semifinal is played normally; then the final should auto-forfeit nothing (team 0 is already out).
    expect(forfeitDisqualified()).toEqual([]);
  });
});

describe('scores, stats, rescore', () => {
  it('stores in-game scores, builds team records, and rescore only adds games that were missed', async () => {
    const { tournament, teams } = setupTournament(2, 1, 3, 1);
    await syncArenas();
    const [match] = readyMatches(tournament.id);
    const future = (n: number) => new Date(Date.now() + n * 1000).toISOString();
    fake.events = [
      { idx: 11, slot: 'Arena', trigger: 'team0 match win', timestamp: future(1), playerCount: 2, scores: [6, 2] },
      { idx: 12, slot: 'Arena', trigger: 'team1 match win', timestamp: future(2), playerCount: 2, scores: [3, 6] },
      { idx: 13, slot: 'Arena', trigger: 'team0 match win', timestamp: future(3), playerCount: 2, scores: [7, 4] }
    ];
    recordGameWin(match.id, match.team1_id!, 'x', 'y'); // game 1 was already counted before the bot missed the rest
    const recorded = await rescoreMatch(match.id);
    expect(recorded).toHaveLength(2);
    expect(await rescoreMatch(match.id).catch(e => e.message)).toMatch(/isn’t running/); // series finished: nothing left to do
    expect(listGames(match.id).map(g => [g.score1, g.score2])).toEqual([[null, null], [3, 6], [7, 4]]);

    const winner = match.team1_id!;
    const record = teamRecord(winner);
    expect(record).toMatchObject({ matchesWon: 1, matchesLost: 0, gamesWon: 2, gamesLost: 1 });
    expect(teamHistory(winner)[0]).toMatchObject({ won: true, teamGames: 2, opponentGames: 1 });
    expect(teamRecord(teams.find(t => t.id !== winner)!.id)).toMatchObject({ matchesWon: 0, matchesLost: 1 });
  });
});

describe('ban check', () => {
  it('reports only players with an active ban, and never blocks if Orion Drift fails', async () => {
    process.env.ORION_FLEET_ID = 'fleet-x';
    fake.listBans = async () => [
      { ban_id: '1', user_id: 'u1', username: 'BadGuy', timestamp: '', expiration: null, reason: '', revoked: false },
      { ban_id: '2', user_id: 'u2', username: 'Expired', timestamp: '', expiration: '2000-01-01T00:00:00', reason: '', revoked: false },
      { ban_id: '3', user_id: 'u3', username: 'Revoked', timestamp: '', expiration: null, reason: '', revoked: true }
    ];
    clearBanCache();
    expect(await bannedAmong(['badguy', 'Expired', 'Revoked', 'Fine'])).toEqual(['badguy']);
    fake.listBans = async () => { throw new Error('down'); };
    clearBanCache();
    expect(await bannedAmong(['badguy'])).toEqual([]);
    delete process.env.ORION_FLEET_ID;
    clearBanCache();
  });
});

describe('username change during a match', () => {
  it('rewrites the live arena whitelist with the new name', async () => {
    const { tournament, guild } = setupTournament(2, 1, 1, 1);
    await syncArenas();
    const [match] = readyMatches(tournament.id);
    const member = db.prepare('SELECT user_id FROM team_members WHERE team_id = ?').get(match.team1_id) as { user_id: string };
    db.prepare("UPDATE players SET meta_username = 'BrandNewName' WHERE user_id = ?").run(member.user_id);
    await refreshWhitelistForUser(member.user_id);
    expect(fake.members(`${guild}-fleet1`)).toContain('brandnewname');
  });
});

describe('undo last game', () => {
  it('removes a game from a live match, and reopens a finished match while the next round has not started', () => {
    const { tournament } = setupTournament(4, 1, 3, 0);
    const [a, b] = readyMatches(tournament.id);
    recordGameWin(a.id, a.team1_id!, 'x', 'y');
    undoLastGame(a.id);
    expect(seriesState(a.id)).toMatchObject({ team1Wins: 0, team2Wins: 0, finished: false });
    expect(() => undoLastGame(a.id)).toThrow(/no recorded games/);

    recordGameWin(a.id, a.team1_id!, 'x', 'y'); recordGameWin(a.id, a.team1_id!, 'x', 'y'); // a finishes 2–0
    const finalBefore = db.prepare("SELECT id, team1_id, team2_id, status FROM matches WHERE tournament_id = ? AND round = 2").get(tournament.id) as { id: number; team1_id: number | null; team2_id: number | null; status: string };
    expect([finalBefore.team1_id, finalBefore.team2_id].includes(a.team1_id)).toBe(true);
    expect(undoLastGame(a.id)).toMatchObject({ gameNumber: 2, reopened: true });
    const finalAfter = db.prepare('SELECT team1_id, team2_id, status FROM matches WHERE id = ?').get(finalBefore.id) as { team1_id: number | null; team2_id: number | null; status: string };
    expect([finalAfter.team1_id, finalAfter.team2_id].includes(a.team1_id)).toBe(false);
    expect(finalAfter.status).toBe('WAITING');
    expect(seriesState(a.id)).toMatchObject({ team1Wins: 1, finished: false });

    // Once the next round has a game, the earlier result is locked in.
    recordGameWin(a.id, a.team1_id!, 'x', 'y');
    recordGameWin(b.id, b.team1_id!, 'x', 'y'); recordGameWin(b.id, b.team1_id!, 'x', 'y');
    recordGameWin(finalBefore.id, a.team1_id!, 'x', 'y');
    expect(() => undoLastGame(a.id)).toThrow(/already started/);
  });
});

describe('seeding by record', () => {
  it('puts the team with the better past record first', () => {
    const guild = `seed-guild-${++guildCounter}`;
    const make = (n: number) => { registerPlayer(`${guild}-${n}`, `${guild}-${n}`, 'NA', 'UTC'); return createTeam(guild, `${guild}-${n}`, `S${n}`); };
    const [t0, t1, t2] = [make(0), make(1), make(2)];
    // t2 has a past win; the others have no history.
    const old = createTournament(guild, { name: 'Old', region: 'NA', format: 'SINGLE', maxTeams: 4, minRoster: 1, maxRoster: 1, requireApproval: false, bestOf: 1 }, 'staff');
    signUp(old, t2); signUp(old, t1); startTournament(old, false);
    const m = db.prepare('SELECT * FROM matches WHERE tournament_id = ?').get(old.id) as MatchRow;
    recordGameWin(m.id, t2.id, 'x', 'y');
    const cup = createTournament(guild, { name: 'New', region: 'NA', format: 'SINGLE', maxTeams: 4, minRoster: 1, maxRoster: 1, requireApproval: false, bestOf: 1 }, 'staff');
    for (const t of [t0, t1, t2]) signUp(cup, t);
    const seeded = startTournament(cup, 'record');
    expect(seeded[0].teamId).toBe(t2.id);
    expect(seeded.slice(1).map(s => s.teamId)).toEqual([t0.id, t1.id]); // ties keep signup order
  });
});

describe('dispute freeze', () => {
  it('does not auto-score a disputed match until staff rescore it', async () => {
    const { tournament } = setupTournament(2, 1, 3, 1);
    await syncArenas();
    const [match] = readyMatches(tournament.id);
    const ts = new Date(Date.now() + 1000).toISOString();
    fake.events = [{ idx: 21, slot: 'Arena', trigger: 'team0 match win', timestamp: ts, playerCount: 2, scores: [6, 1] }];
    db.prepare('UPDATE matches SET disputed = 1 WHERE id = ?').run(match.id);
    expect((await pollScores()).games.filter(g => g.matchId === match.id)).toEqual([]);
    expect(await rescoreMatch(match.id)).toHaveLength(1); // staff re-read: the freeze ends and the game counts
    expect(db.prepare('SELECT disputed FROM matches WHERE id = ?').get(match.id)).toEqual({ disputed: 0 });
  });
});

describe('slot names', () => {
  it('pads slot numbers the way Orion Drift names them', () => {
    expect(normalizeSlot('Beta 1')).toBe('Beta 01');
    expect(normalizeSlot('alpha 03')).toBe('Alpha 03');
    expect(normalizeSlot('  GAMMA   2 ')).toBe('Gamma 02');
    expect(normalizeSlot('Custom Slot')).toBe('Custom Slot');
  });
});
