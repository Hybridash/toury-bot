import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../db.js';
import { setOrionApi, type OrionApi, type SlotTeam } from '../integrations/orion.js';
import { registerPlayer } from '../services/players.js';
import { createTeam } from '../services/teams.js';
import { addArena } from '../services/arenas.js';
import { createTournament, signUp, getTournamentById } from '../services/tournaments.js';
import { beginReadyCheck, handleReadyButton } from './start.js';
import { addPlayerAsStaff } from '../services/teams.js';
import { recordGameWin } from '../services/series.js';
import { setSetting, staffRoleId } from '../services/settings.js';
import { notifyReadyMatches } from './shared.js';

/** Just enough of Discord and Orion Drift to run the start flow end to end. */
class FakeOrion implements OrionApi {
  unknown = new Set<string>();
  slots = new Map<string, SlotTeam[]>();
  async findUserId(name: string) { return this.unknown.has(name.toLowerCase()) ? undefined : `id-${name}`; }
  async banUser() {}
  async unbanUser() {}
  async listBans() { return []; }
  async setSlot(station: string, slot: string, a: SlotTeam | null, b: SlotTeam | null) { this.slots.set(`${station}:${slot}`, [a, b].filter((t): t is SlotTeam => Boolean(t))); }
  grants: string[] = [];
  async grantRole(_fleet: string, _role: string, name: string) { this.grants.push(name); }
  async listGameEnds() { return []; }
}

type Sent = { content?: string; embeds?: Array<{ data: { title?: string; description?: string } }> };

function fakeDiscord(opts: { blockedDms?: Set<string>; casters?: string[] } = {}) {
  const log = { dms: [] as string[], dmTexts: [] as string[], channelSends: 0, rolesCreated: [] as string[], rolesDeleted: 0, rolesGiven: [] as string[], bracketEdits: 0,
    channels: new Map<string, { name: string; overwrites: Array<{ id: string; deny?: unknown[] }>; sent: Sent[] }>() };
  const text = (o: Sent) => (o.embeds ?? []).map(e => `${e.data.title}\n${e.data.description}`).join('\n');
  const channel = {
    id: 'chan-1', type: 0, parentId: 'cat-1', isSendable: () => true, isTextBased: () => true,
    guild: { members: { me: { permissions: { has: () => true } } } },
    send: async () => { log.channelSends++; return { id: `msg-${log.channelSends}`, channelId: 'chan-1' }; },
    messages: { fetch: async () => ({ edit: async () => { log.bracketEdits++; } }) }
  };
  const made = new Map<string, object>();
  const guild = {
    id: 'guild',
    roles: {
      cache: { find: () => undefined },
      fetch: async (id: string) => (log.rolesCreated.some((_, n) => `role-${n + 1}` === id) ? { id } : null),
      create: async (o: { name: string }) => { log.rolesCreated.push(o.name); return { id: `role-${log.rolesCreated.length}` }; },
      delete: async () => { log.rolesDeleted++; }
    },
    members: {
      fetch: async (id: string) => ({ roles: { add: async () => { log.rolesGiven.push(id); }, remove: async () => {} } }),
      list: async () => new Map((opts.casters ?? []).map(id => [id, { id, roles: { cache: { has: () => true } } }]))
    },
    channels: { create: async (o: { name: string; permissionOverwrites: Array<{ id: string }> }) => {
      const id = `match-chan-${made.size + 1}`;
      const record = { name: o.name, overwrites: o.permissionOverwrites, sent: [] as Sent[] };
      log.channels.set(id, record);
      const ch = { id, type: 0, isSendable: () => true, isThread: () => false, delete: async () => { log.channels.delete(id); },
        setName: async (n: string) => { record.name = n; },
        permissionOverwrites: { edit: async (roleId: string) => { if (!record.overwrites.some(o => o.id === roleId)) record.overwrites.push({ id: roleId }); } },
        send: async (m: Sent) => { record.sent.push(m); return {}; } };
      made.set(id, ch);
      return ch;
    } }
  };
  const client = {
    user: { id: 'bot' },
    users: { fetch: async (id: string) => ({ send: async (m: Sent) => {
      if (opts.blockedDms?.has(id)) throw new Error('DMs closed');
      log.dms.push(id);
      log.dmTexts.push(`${id}: ${text(m)}`);
      return { id: `dm-${id}`, channelId: `dmchan-${id}`, edit: async () => ({}) };
    } }) },
    channels: { fetch: async (id: string) => (id === 'chan-1' ? channel : made.get(id) ?? null) },
    guilds: { fetch: async () => guild }
  };
  return { client: client as never, channel: channel as never, log, text };
}

let counter = 0;
function setup(usernames: string[]) {
  const guild = `start-guild-${++counter}`;
  const teams = usernames.map((name, i) => {
    registerPlayer(`${guild}-u${i}`, name, 'NA', 'UTC');
    return createTeam(guild, `${guild}-u${i}`, `Team ${i}`);
  });
  addArena(guild, 'Alpha 1', 'station-1', 'Alpha 01');
  addArena(guild, 'Alpha 2', 'station-1', 'Alpha 02');
  const t = createTournament(guild, { name: 'Cup', region: 'NA', format: 'SINGLE', maxTeams: 8, minRoster: 1, maxRoster: 2, requireApproval: false, bestOf: 3 }, 'staff');
  for (const team of teams) signUp(t, team);
  return { guild, tournament: t, teams, userIds: usernames.map((_, i) => `${guild}-u${i}`) };
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
    expect(log.rolesCreated).toContain('Cup');
    expect(log.rolesGiven).toEqual(expect.arrayContaining(userIds));
    const slot = orion.slots.get('station-1:Alpha 01')!;
    expect(slot.map(t => t.players)).toEqual([['StartA'], ['StartB']]);
    expect(log.channels.size).toBe(1);
    if (process.env.ORION_PLAYER_ROLE_ID && process.env.ORION_FLEET_ID) expect(orion.grants.sort()).toEqual(['StartA', 'StartB']); // Orion Drift Tournament Player role, given with the arena whitelist
    const [matchChannel] = log.channels.values();
    expect(matchChannel.overwrites[0]).toMatchObject({ id: 'guild' }); // @everyone can't see it
    expect(matchChannel.overwrites.length).toBe(4 + (staffRoleId() ? 1 : 0)); // @everyone, bot, both team roles (+ staff)
    expect(log.channelSends).toBeGreaterThan(0); // the bracket message
    expect(db.prepare('SELECT bracket_message_id AS id FROM tournaments WHERE id = ?').get(tournament.id)).toEqual({ id: 'msg-1' });
  });

  it('cancels (and can be retried) when nobody on a team can be DMed', async () => {
    const { tournament, userIds } = setup(['DmA', 'DmB']);
    const { client, channel } = fakeDiscord({ blockedDms: new Set([userIds[1]]) });
    await beginReadyCheck(client, channel, tournament.id, 'signup');
    expect(getTournamentById(tournament.id)!.status).toBe('SIGNUPS');
    const open = fakeDiscord();
    await beginReadyCheck(open.client, open.channel, tournament.id, 'signup'); // not stuck on "already running"
    expect(open.log.dms).toHaveLength(2);
  });

  it('starts anyway when a player cannot be whitelisted, and DMs them to fix their Meta username', async () => {
    const { tournament, userIds } = setup(['RealOne', 'GhostTwo']);
    orion.unknown.add('ghosttwo');
    const { client, channel, log } = fakeDiscord();
    await beginReadyCheck(client, channel, tournament.id, 'signup');
    await click(userIds[0], tournament.id, client);
    await click(userIds[1], tournament.id, client);

    expect(getTournamentById(tournament.id)!.status).toBe('RUNNING');
    expect(log.channels.size).toBe(1);
    expect(log.dmTexts.some(t => t.startsWith(userIds[1]) && t.includes('/player edit') && t.includes('GhostTwo'))).toBe(true);
    expect(log.dmTexts.some(t => t.startsWith(userIds[0]) && t.includes('Check your Meta username'))).toBe(false);
  });

  it('rejects a click from someone who is not in the tournament', async () => {
    const { tournament } = setup(['OutA', 'OutB']);
    const { client, channel } = fakeDiscord();
    await beginReadyCheck(client, channel, tournament.id, 'signup');
    await expect(click('stranger', tournament.id, client)).rejects.toThrow(/not on a team/);
  });

  it('5 teams: the top seeds get byes and wait in their round-2 channel for the match that decides their opponent', async () => {
    const { tournament, userIds } = setup(['Five0', 'Five1', 'Five2', 'Five3', 'Five4']);
    const { client, channel, log, text } = fakeDiscord({ casters: ['caster-1'] });
    setSetting('caster_role_id', 'caster-role');
    try {
      await beginReadyCheck(client, channel, tournament.id, 'signup');
      for (const id of userIds) await click(id, tournament.id, client);
    } finally { setSetting('caster_role_id', null); }
    expect(getTournamentById(tournament.id)!.status).toBe('RUNNING');

    // Seeds 4 and 5 (Team 3, Team 4) play round 1; Team 1 vs Team 2 is ready at once (both had byes); Team 0 waits.
    const all = [...log.channels.values()].map(c => Object.assign(c, { name: c.name.toLowerCase().replaceAll(' ', '-') })); // Discord does this
    const live = all.filter(c => c.sent.some(m => text(m).includes('Arena:')));
    expect(live).toHaveLength(2);
    expect(live.some(c => c.name.endsWith('team-1-vs-team-2'))).toBe(true);
    expect(live.some(c => c.name.endsWith('team-3-vs-team-4'))).toBe(true);
    const waiting = all.find(c => c.name.includes('team-0-vs-tbd'))!;
    expect(text(waiting.sent[0])).toContain('Waiting for **Team 3 vs Team 4**');
    const staff = staffRoleId() ? 1 : 0;
    expect(waiting.overwrites).toHaveLength(3 + staff); // @everyone, bot, Team 0's role only (+ staff)

    // Casters got one schedule DM with both live matches, their arenas and the bye.
    const casterDm = log.dmTexts.filter(t => t.startsWith('caster-1'));
    expect(casterDm).toHaveLength(1);
    expect(casterDm[0]).toMatch(/Team 3.*Team 4.*Alpha/s);
    expect(casterDm[0]).toContain('Byes');

    // Team 3 wins: Team 3 is let into the waiting channel, which becomes the live match.
    const r1 = db.prepare("SELECT id, team1_id AS t1 FROM matches WHERE tournament_id = ? AND round = 1 AND status = 'READY'").get(tournament.id) as { id: number; t1: number };
    recordGameWin(r1.id, r1.t1, 'auto', 'auto');
    recordGameWin(r1.id, r1.t1, 'auto', 'auto');
    await notifyReadyMatches(client);
    expect(waiting.name.toLowerCase().replaceAll(' ', '-')).toContain('team-0-vs-team-3');
    expect(waiting.overwrites).toHaveLength(4 + staff);
    expect(text(waiting.sent.at(-1)!)).toContain('Arena:');
    expect(log.bracketEdits).toBeGreaterThan(0); // live bracket updated with the result
  });

  it('players added by Meta username only are whitelisted and do not need to click Ready', async () => {
    const { tournament, teams, userIds } = setup(['WithDiscordA', 'WithDiscordB']);
    addPlayerAsStaff(teams[0], 'NoDiscordGuy');
    const { client, channel, log } = fakeDiscord();
    await beginReadyCheck(client, channel, tournament.id, 'signup');
    expect(log.dms.sort()).toEqual([...userIds].sort()); // nobody tried to DM "meta:nodiscordguy"
    for (const id of userIds) await click(id, tournament.id, client);
    expect(getTournamentById(tournament.id)!.status).toBe('RUNNING');
    expect(orion.slots.get('station-1:Alpha 01')!.map(t => [...t.players].sort())).toEqual([['NoDiscordGuy', 'WithDiscordA'], ['WithDiscordB']]);
  });
});
