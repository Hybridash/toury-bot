import type { Client, Guild } from 'discord.js';
import { captainRoleId, setSetting } from '../services/settings.js';
import { getMembers, getTeamById, setTeamRole, type Team } from '../services/teams.js';
import { onDiscord } from '../services/players.js';

/**
 * Discord roles for teams: one shared "Captain" role plus one role per team, named after it.
 * Everything here is best effort: a missing Manage Roles permission must never break team commands,
 * so failures are logged and swallowed.
 */

async function guildOf(client: Client, team: Team): Promise<Guild | null> {
  return client.guilds.fetch(team.guildId).catch(() => null);
}

async function ensureCaptainRole(guild: Guild): Promise<string | null> {
  const saved = captainRoleId();
  if (saved && (await guild.roles.fetch(saved).catch(() => null))) return saved;
  const role = guild.roles.cache.find(r => r.name === 'Captain') ?? await guild.roles.create({ name: 'Captain', reason: 'Team captains' });
  setSetting('captain_role_id', role.id);
  return role.id;
}

async function ensureTeamRole(guild: Guild, team: Team): Promise<string> {
  if (team.roleId && (await guild.roles.fetch(team.roleId).catch(() => null))) return team.roleId;
  const role = await guild.roles.create({ name: team.name, reason: `Team ${team.name}` });
  setTeamRole(team.id, role.id);
  return role.id;
}

async function attempt(task: () => Promise<unknown>): Promise<void> {
  await task().catch(error => console.error('[roles]', error instanceof Error ? error.message : error));
}

/** Gives the captain the Captain role and everyone on the team the team role (creating the team role if needed). */
export function syncTeamRoles(client: Client, teamId: number): Promise<void> {
  return attempt(async () => {
    const team = getTeamById(teamId);
    const guild = team && await guildOf(client, team);
    if (!team || !guild) return;
    const teamRole = await ensureTeamRole(guild, team);
    const captainRole = await ensureCaptainRole(guild);
    for (const m of getMembers(team.id)) {
      if (!onDiscord(m.userId)) continue;
      const member = await guild.members.fetch(m.userId).catch(() => null);
      if (!member) continue;
      await member.roles.add(teamRole);
      if (captainRole) await (m.userId === team.captainId ? member.roles.add(captainRole) : member.roles.remove(captainRole));
    }
  });
}

/** Takes the team role (and Captain role) off someone who left, was kicked, or whose team was disbanded. */
export function dropTeamRoles(client: Client, team: Team, userIds: string[]): Promise<void> {
  return attempt(async () => {
    const guild = await guildOf(client, team);
    if (!guild) return;
    const roles = [team.roleId, captainRoleId()].filter((id): id is string => Boolean(id));
    for (const userId of userIds) await guild.members.fetch(userId).then(m => m.roles.remove(roles)).catch(() => null);
  });
}

export function renameTeamRole(client: Client, team: Team): Promise<void> {
  return attempt(async () => {
    const guild = await guildOf(client, team);
    if (guild && team.roleId) await guild.roles.edit(team.roleId, { name: team.name });
  });
}

/** Deletes the team role. Call dropTeamRoles first so the Captain role comes off the captain. */
export function deleteTeamRole(client: Client, team: Team): Promise<void> {
  return attempt(async () => {
    const guild = await guildOf(client, team);
    if (guild && team.roleId) await guild.roles.delete(team.roleId, `Team ${team.name} disbanded`);
  });
}
