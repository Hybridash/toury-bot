import { describe, expect, it } from 'vitest';
import { db } from '../db.js';
import { registerPlayer, requirePlayer, updatePlayer, normalizeTimezone, searchTimezones } from './players.js';
import {
  acceptInvite, createInvite, createTeam, declineInvite, disbandTeam, getMembers, getTeamOfUser, kickMember, leaveTeam, renameTeam, transferCaptain
} from './teams.js';
import { createTournament, listRegistrations, reviewRegistration, signUp, startTournament, withdraw } from './tournaments.js';
import { recordResult, type MatchRow } from './bracket.js';
import { bracketEmbeds } from '../handlers/shared.js';
import { getTournamentById } from './tournaments.js';

const G = 'guild-1';

describe('profiles', () => {
  it('requires registration and validates timezones', () => {
    expect(() => requirePlayer('nobody')).toThrow(/register/);
    expect(normalizeTimezone('america/chicago')).toBe('America/Chicago');
    expect(normalizeTimezone('Mars/Olympus')).toBeUndefined();
    expect(searchTimezones('chicago')).toContain('America/Chicago');
    registerPlayer('p-a', 'AlphaVR', 'NA', 'America/Chicago');
    expect(() => registerPlayer('p-a', 'Again', 'NA', 'UTC')).toThrow(/already have a profile/);
    expect(() => registerPlayer('p-x', 'alphavr', 'NA', 'UTC')).toThrow(/already registered/);
    expect(updatePlayer('p-a', { timezone: 'America/New_York' }).timezone).toBe('America/New_York');
  });
});

describe('teams', () => {
  it('handles create, invite, accept, decline, kick, leave, transfer, rename, disband', () => {
    registerPlayer('p-b', 'Bravo', 'NA', 'UTC');
    registerPlayer('p-c', 'Charlie', 'NA', 'UTC');
    registerPlayer('p-eu', 'Euro', 'EU', 'Europe/Berlin');

    expect(() => createTeam(G, 'unregistered', 'Ghosts')).toThrow(/register/);
    const team = createTeam(G, 'p-a', 'Night Owls');
    expect(team.captainId).toBe('p-a');
    expect(team.region).toBe('NA');
    expect(() => createTeam(G, 'p-b', 'night owls')).toThrow(/already exists/);
    expect(() => createTeam(G, 'p-a', 'Second')).toThrow(/already on a team/);

    expect(() => createInvite(team, 'p-a', 'p-eu', '@Euro')).toThrow(/EU/);
    expect(() => createInvite(team, 'p-a', 'unregistered', '@x')).toThrow(/hasn't registered/);

    const inviteB = createInvite(team, 'p-a', 'p-b', '@Bravo');
    expect(() => acceptInvite(inviteB.id, 'p-c')).toThrow(/isn’t for you/);
    acceptInvite(inviteB.id, 'p-b');
    expect(getTeamOfUser(G, 'p-b')?.id).toBe(team.id);
    expect(() => acceptInvite(inviteB.id, 'p-b')).toThrow(/no longer available/);

    const inviteC = createInvite(team, 'p-a', 'p-c', '@Charlie');
    declineInvite(inviteC.id, 'p-c');
    expect(getTeamOfUser(G, 'p-c')).toBeUndefined();

    kickMember(team, 'p-b');
    expect(getMembers(team.id).map(m => m.userId)).toEqual(['p-a']);
    expect(() => kickMember(team, 'p-a')).toThrow();
    expect(() => leaveTeam(team, 'p-a')).toThrow(/Captains can’t leave/);

    acceptInvite(createInvite(team, 'p-a', 'p-b', '@Bravo').id, 'p-b');
    transferCaptain(team, 'p-b');
    const renamed = renameTeam({ ...team, captainId: 'p-b' }, 'Day Owls');
    expect(renamed.name).toBe('Day Owls');
    expect(renamed.captainId).toBe('p-b');

    const members = disbandTeam(renamed);
    expect(members.sort()).toEqual(['p-a', 'p-b']);
    expect(getTeamOfUser(G, 'p-a')).toBeUndefined();
  });
});

describe('tournament flow', () => {
  it('signs teams up, locks rosters, and plays to a champion', () => {
    const teams = [];
    for (let n = 0; n < 6; n++) {
      registerPlayer(`cap-${n}`, `Cap${n}`, 'NA', 'UTC');
      registerPlayer(`mate-${n}`, `Mate${n}`, 'NA', 'UTC');
      const team = createTeam(G, `cap-${n}`, `Squad ${n}`);
      acceptInvite(createInvite(team, `cap-${n}`, `mate-${n}`, '@mate').id, `mate-${n}`);
      teams.push(team);
    }
    registerPlayer('cap-eu', 'CapEU', 'EU', 'UTC');
    const euTeam = createTeam(G, 'cap-eu', 'Euro Squad');

    const t = createTournament(G, { name: 'Fall Cup', region: 'NA', format: 'DOUBLE', maxTeams: 8, minRoster: 2, maxRoster: 3, requireApproval: true, bestOf: 1 }, 'staff');
    expect(() => signUp(t, euTeam)).toThrow(/EU/);
    for (const team of teams) expect(signUp(t, team)).toBe('PENDING');
    expect(() => signUp(t, teams[0])).toThrow(/already signed up/);
    for (const team of teams.slice(0, 5)) reviewRegistration(t, team.id, true);
    withdraw(t, teams[4]);
    expect(listRegistrations(t.id, 'CONFIRMED')).toHaveLength(4);

    // Invite blocked once full for this tournament (max 3)
    registerPlayer('extra-1', 'Extra1', 'NA', 'UTC');
    registerPlayer('extra-2', 'Extra2', 'NA', 'UTC');
    acceptInvite(createInvite(teams[0], 'cap-0', 'extra-1', '@e1').id, 'extra-1');
    expect(() => createInvite(teams[0], 'cap-0', 'extra-2', '@e2')).toThrow(/full/);

    const seeded = startTournament(t, false);
    expect(seeded).toHaveLength(4);
    expect(() => kickMember(teams[0], 'mate-0')).toThrow(/locked/);
    expect(() => disbandTeam(teams[0])).toThrow(/locked/);
    // Team 5 was still pending, so its signup got cleared and it is free.
    expect(() => kickMember(teams[5], 'mate-5')).not.toThrow();

    const embedsBefore = bracketEmbeds(getTournamentById(t.id)!);
    expect(embedsBefore[0].data.fields?.length).toBeGreaterThan(0);

    for (let guard = 0; guard < 50; guard++) {
      const ready = db.prepare("SELECT * FROM matches WHERE tournament_id = ? AND status = 'READY' LIMIT 1").get(t.id) as MatchRow | undefined;
      if (!ready) break;
      recordResult(ready.id, ready.team1_id!, 2, 1);
    }
    const done = getTournamentById(t.id)!;
    expect(done.status).toBe('COMPLETE');
    expect(done.championTeamId).toBe(teams[0].id);
    expect(bracketEmbeds(done)[0].data.description).toContain('Champion');
    // Rosters unlock once the tournament is over.
    expect(() => kickMember(teams[0], 'mate-0')).not.toThrow();
  });
});
