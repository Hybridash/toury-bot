import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../db.js';
import { setOrionApi, type OrionApi, type SlotTeam } from '../integrations/orion.js';
import { registerPlayer } from '../services/players.js';
import { createTeam } from '../services/teams.js';
import { addArena } from '../services/arenas.js';
import { createTournament, signUp, getTournamentById } from '../services/tournaments.js';
import { beginReadyCheck, handleReadyButton } from './start.js';

/** Just enough of Discord and Orion Drift to run the start flow end to end. */
class FakeOrion implements OrionApi {
  unknown = new Set<string>();
  slots = new Map<string, SlotTeam[]>();
  async findUserId(name: string) { return this.unknown.has(name.toLowerCase()) ? undefined : `id-${name}`; }
  async banUser() {}
  async unbanUser() {}
  async listBans() { return []; }
  async setSlot(station: string, slot: string, a: SlotTeam | null, b: SlotTeam | null) { this.slots.set(`${station}:${slot}`, [a, b].filter((t): t is SlotTeam => Boolean(t))); }
  async listGameEnds() { return []; }
}

function fakeDiscord(opts: { blockedDms?: Set<string> } = {}) {
  const log = { dms: [] as string[], channelSends: 0, rolesCreated: 0, rolesDeleted: 0, rolesGiven: [] as string[], threads: [] as string[], threadMembers: [] as string[] };
  const thread = { id: 'thread-1', members: { add: async (id: string) => { log.threadMembers.push(id); } }, send: async () => ({}) };
  const channel = {
    id: 'chan-1', type: 0, isSendable: () => true, isTextBased: () => true,
    guild: { members: { me: { permissions: { has: () => true } } } },
    permissionsFor: () => ({ has: () => true }),
    send: async () => { log.channelSends++; return { id: `msg-${log.channelSends}`, channelId: 'chan-1' }; },
    threads: { create: async (o: { name: string }) => { log.threads.push(o.name); return thread; } }
  };
  const client = {
    users: { fetch: async (id: string) => ({ send: async () => {
      if (opts.blockedDms?.has(id)) throw new Error('DMs closed');
      log.dms.push(id);
      return { id: `dm-${id}`, channelId: `dmchan-${id}`, edit: async () => ({}) };
    } }) },
    channels: { fetch: async (id: string) => (id === 'chan-1' ? channel : null) },
    guilds: { fetch: async () => ({
      roles: { create: async () => { log.rolesCreated++; return { id: 'role-1' }; }, delete: async () => { log.rolesDeleted++; } },
      members: { fetch: async (id: string) => ({ roles: { add: async () => { log.rolesGiven.push(id); } } }) }
    }) }
  };
  return { client: client as never, channel: channel as never, log };
}

let counter = 0;
function setup(usernames: [string, string]) {
  const guild = `start-guild-${++counter}`;
  const teams = usernames.map((name, i) => {
    registerPlayer(`${guild}-u${i}`, name, 'NA', 'UTC');
    return createTeam(guild, `${guild}-u${i}`, `Team ${i}`);
  });
  addArena(guild, 'Alpha 1', 'station-1', 'Alpha 01');
  const t = createTournament(guild, { name: 'Cup', region: 'NA', format: 'SINGLE', maxTeams: 8, minRoster: 1, maxRoster: 1, requireApproval: false, bestOf: 3 }, 'staff');
  for (const team of teams) signUp(t, team);
  return { guild, tournament: t, userIds: [`${guild}-u0`, `${guild}-u1`] };
}

const click = (userId: string, tournamentId: number, client: never) =>
  handleReadyButton({ customId: `ready:yes:${tournamentId}`, user: { id: userId }, client, deferUpdate: async () => {} } as never, client);

let orion: FakeOrion;
beforeEach(() => { orion = new FakeOrion(); setOrionApi(orion); });

describe('start flow', () => {
  it('DMs everyone, waits for all to click Ready, then builds the bracket, role, whitelist and thread', async () => {
    const { tournament, userIds } = setup(['StartA', 'StartB']);
    const { client, channel, log } = fakeDiscord();
    await beginReadyCheck(client, channel, tournament.id, 'signup');
    expect(log.dms.sort()).toEqual([...userIds].sort());
    expect(log.channelSends).toBe(0); // nothing about the ready check on the server

    await click(userIds[0], tournament.id, client);
    expect(getTournamentById(tournament.id)!.status).not.toBe('RUNNING'); // one player isn't enough
    await click(userIds[1], tournament.id, client);

    expect(getTournamentById(tournament.id)!.status).toBe('RUNNING');
    expect(log.rolesCreated).toBe(1);
    expect(log.rolesGiven.sort()).toEqual([...userIds].sort());
    const slot = orion.slots.get('station-1:Alpha 01')!;
    expect(slot.map(t => t.players)).toEqual([['StartA'], ['StartB']]);
    expect(log.threads).toHaveLength(1);
    expect(log.channelSends).toBeGreaterThan(0); // the bracket message
    expect(db.prepare('SELECT bracket_message_id AS id FROM tournaments WHERE id = ?').get(tournament.id)).toEqual({ id: 'msg-1' });
  });

  it('cancels (and can be retried) when a player has DMs closed', async () => {
    const { tournament, userIds } = setup(['DmA', 'DmB']);
    const { client, channel } = fakeDiscord({ blockedDms: new Set([userIds[1]]) });
    await beginReadyCheck(client, channel, tournament.id, 'signup');
    expect(getTournamentById(tournament.id)!.status).toBe('SIGNUPS');
    const open = fakeDiscord();
    await beginReadyCheck(open.client, open.channel, tournament.id, 'signup'); // not stuck on "already running"
    expect(open.log.dms).toHaveLength(2);
  });

  it('undoes the start, removes the role and tells nobody they are in when a player cannot be whitelisted', async () => {
    const { tournament, userIds } = setup(['RealOne', 'GhostTwo']);
    orion.unknown.add('ghosttwo');
    const { client, channel, log } = fakeDiscord();
    await beginReadyCheck(client, channel, tournament.id, 'signup');
    await click(userIds[0], tournament.id, client);
    await click(userIds[1], tournament.id, client);

    expect(getTournamentById(tournament.id)!.status).toBe('CLOSED');
    expect(db.prepare('SELECT COUNT(*) AS c FROM matches WHERE tournament_id = ?').get(tournament.id)).toEqual({ c: 0 });
    expect(log.rolesCreated).toBe(1);
    expect(log.rolesDeleted).toBe(1);
    expect(log.threads).toHaveLength(0);
    const closed = orion.slots.get('station-1:Alpha 01')!;
    expect(closed.every(t => t.players.length === 0) || closed.length === 0).toBe(true); // arena left closed
  });

  it('rejects a click from someone who is not in the tournament', async () => {
    const { tournament } = setup(['OutA', 'OutB']);
    const { client, channel } = fakeDiscord();
    await beginReadyCheck(client, channel, tournament.id, 'signup');
    await expect(click('stranger', tournament.id, client)).rejects.toThrow(/not on a team/);
  });
});
