import { db } from '../db.js';
import { UserError } from '../util.js';
import { getPlayer, offDiscordId, registerPlayer, requirePlayer, updatePlayer, validateMetaUsername, who, type Region } from './players.js';

export interface Team {
  id: number;
  guildId: string;
  name: string;
  captainId: string;
  region: string;
  logoPath: string | null;
  roleId: string | null;
  createdAt: string;
}

export interface TeamMember {
  userId: string;
  joinedAt: string;
  metaUsername: string | null;
  timezone: string | null;
}

export interface TeamInvite {
  id: number;
  teamId: number;
  teamName: string;
  guildId: string;
  userId: string;
  invitedBy: string;
  status: string;
}

const TEAM_SELECT = `SELECT t.id, t.guild_id AS guildId, t.name, t.captain_id AS captainId, t.region, t.logo_path AS logoPath, t.role_id AS roleId, t.created_at AS createdAt FROM teams t`;

export function getTeamById(id: number): Team | undefined {
  return db.prepare(`${TEAM_SELECT} WHERE t.id = ?`).get(id) as Team | undefined;
}

export function getTeamByName(guildId: string, name: string): Team | undefined {
  return db.prepare(`${TEAM_SELECT} WHERE t.guild_id = ? AND t.name = ?`).get(guildId, name.trim()) as Team | undefined;
}

export function getTeamOfUser(guildId: string, userId: string): Team | undefined {
  return db.prepare(`${TEAM_SELECT} JOIN team_members m ON m.team_id = t.id WHERE m.guild_id = ? AND m.user_id = ?`).get(guildId, userId) as Team | undefined;
}

export function isOnAnyTeam(userId: string): boolean {
  return Boolean(db.prepare('SELECT 1 FROM team_members WHERE user_id = ? LIMIT 1').get(userId));
}

export function searchTeams(guildId: string, query: string, limit = 25): Team[] {
  return db.prepare(`${TEAM_SELECT} WHERE t.guild_id = ? AND t.name LIKE ? ORDER BY t.name LIMIT ?`).all(guildId, `%${query.trim()}%`, limit) as Team[];
}

export function getMembers(teamId: number): TeamMember[] {
  return db.prepare(`SELECT m.user_id AS userId, m.joined_at AS joinedAt, p.meta_username AS metaUsername, p.timezone
    FROM team_members m LEFT JOIN players p ON p.user_id = m.user_id
    WHERE m.team_id = ? ORDER BY m.joined_at, m.user_id`).all(teamId) as TeamMember[];
}

export function memberCount(teamId: number): number {
  return (db.prepare('SELECT COUNT(*) AS count FROM team_members WHERE team_id = ?').get(teamId) as { count: number }).count;
}

export function isMember(teamId: number, userId: string): boolean {
  return Boolean(db.prepare('SELECT 1 FROM team_members WHERE team_id = ? AND user_id = ?').get(teamId, userId));
}

export function validateTeamName(input: string): string {
  const name = input.trim().replace(/\s+/g, ' ');
  if (name.length < 2 || name.length > 32) throw new UserError('Team names must be 2–32 characters.');
  if (/[`@\n]/.test(name)) throw new UserError('Team names can’t contain `@`, backticks, or line breaks.');
  return name;
}

export function requireOwnTeam(guildId: string, userId: string): Team {
  const team = getTeamOfUser(guildId, userId);
  if (!team) throw new UserError('You’re not on a team. Ask staff to create one, or accept an invite with `/team invites`.');
  return team;
}

export function requireCaptain(guildId: string, userId: string): Team {
  const team = requireOwnTeam(guildId, userId);
  if (team.captainId !== userId) throw new UserError(`Only the captain of **${team.name}** can do that.`);
  return team;
}

/** Name of the running tournament that currently locks this team's roster, if any. */
export function lockingTournament(teamId: number): string | undefined {
  const row = db.prepare(`SELECT t.name FROM registrations r JOIN tournaments t ON t.id = r.tournament_id
    WHERE r.team_id = ? AND r.status = 'CONFIRMED' AND t.status = 'RUNNING' LIMIT 1`).get(teamId) as { name: string } | undefined;
  return row?.name;
}

export function assertRosterUnlocked(team: Team): void {
  const tournament = lockingTournament(team.id);
  if (tournament) throw new UserError(`**${team.name}**’s roster is locked while **${tournament}** is running.`);
}

/** Smallest max-roster limit among tournaments this team is currently entered in. */
export function rosterLimit(teamId: number): { limit: number; tournament: string } | undefined {
  const row = db.prepare(`SELECT t.max_roster AS limitSize, t.name FROM registrations r JOIN tournaments t ON t.id = r.tournament_id
    WHERE r.team_id = ? AND r.status IN ('PENDING', 'CONFIRMED') AND t.status IN ('SIGNUPS', 'CLOSED', 'RUNNING')
    ORDER BY t.max_roster ASC LIMIT 1`).get(teamId) as { limitSize: number; name: string } | undefined;
  return row ? { limit: row.limitSize, tournament: row.name } : undefined;
}

function assertNameFree(guildId: string, name: string, exceptTeamId?: number): void {
  const existing = getTeamByName(guildId, name);
  if (existing && existing.id !== exceptTeamId) throw new UserError(`A team named **${existing.name}** already exists.`);
}

export function createTeam(guildId: string, captainId: string, rawName: string, region?: string): Team {
  const teamRegion = region ?? requirePlayer(captainId).region;
  const name = validateTeamName(rawName);
  if (getTeamOfUser(guildId, captainId)) throw new UserError('You’re already on a team. Leave it before creating a new one.');
  assertNameFree(guildId, name);
  const id = db.transaction(() => {
    const result = db.prepare('INSERT INTO teams (guild_id, name, captain_id, region) VALUES (?, ?, ?, ?)').run(guildId, name, captainId, teamRegion);
    db.prepare('INSERT INTO team_members (team_id, guild_id, user_id) VALUES (?, ?, ?)').run(result.lastInsertRowid, guildId, captainId);
    return Number(result.lastInsertRowid);
  })();
  return getTeamById(id)!;
}

export function setTeamRole(teamId: number, roleId: string | null): void {
  db.prepare('UPDATE teams SET role_id = ? WHERE id = ?').run(roleId, teamId);
}

export function setTeamLogo(teamId: number, logoPath: string): void {
  db.prepare('UPDATE teams SET logo_path = ? WHERE id = ?').run(logoPath, teamId);
}

export function renameTeam(team: Team, rawName: string): Team {
  const name = validateTeamName(rawName);
  assertNameFree(team.guildId, name, team.id);
  db.prepare('UPDATE teams SET name = ? WHERE id = ?').run(name, team.id);
  return getTeamById(team.id)!;
}

function assertRoomForOneMore(team: Team): void {
  const limit = rosterLimit(team.id);
  if (limit && memberCount(team.id) >= limit.limit) {
    throw new UserError(`**${team.name}** is full: **${limit.tournament}** allows at most ${limit.limit} players per team.`);
  }
}

export function createInvite(team: Team, invitedBy: string, userId: string, userMention: string): TeamInvite {
  if (userId === invitedBy) throw new UserError('You can’t invite yourself.');
  assertRosterUnlocked(team);
  const target = getPlayer(userId); // unregistered players give their Meta username when they accept
  if (target && target.region !== team.region) throw new UserError(`${userMention} is registered in **${target.region}**, but **${team.name}** is a **${team.region}** team.`);
  const theirTeam = getTeamOfUser(team.guildId, userId);
  if (theirTeam) throw new UserError(theirTeam.id === team.id ? `${userMention} is already on your team.` : `${userMention} is already on **${theirTeam.name}**.`);
  assertRoomForOneMore(team);
  db.prepare(`INSERT INTO team_invites (team_id, user_id, invited_by, status) VALUES (?, ?, ?, 'PENDING')
    ON CONFLICT (team_id, user_id) DO UPDATE SET invited_by = excluded.invited_by, status = 'PENDING', created_at = CURRENT_TIMESTAMP`)
    .run(team.id, userId, invitedBy);
  const row = db.prepare('SELECT id FROM team_invites WHERE team_id = ? AND user_id = ?').get(team.id, userId) as { id: number };
  return getInvite(row.id)!;
}

export function getInvite(id: number): TeamInvite | undefined {
  return db.prepare(`SELECT v.id, v.team_id AS teamId, t.name AS teamName, t.guild_id AS guildId, v.user_id AS userId, v.invited_by AS invitedBy, v.status
    FROM team_invites v JOIN teams t ON t.id = v.team_id WHERE v.id = ?`).get(id) as TeamInvite | undefined;
}

export function listPendingInvites(guildId: string, userId: string): TeamInvite[] {
  return db.prepare(`SELECT v.id, v.team_id AS teamId, t.name AS teamName, t.guild_id AS guildId, v.user_id AS userId, v.invited_by AS invitedBy, v.status
    FROM team_invites v JOIN teams t ON t.id = v.team_id
    WHERE t.guild_id = ? AND v.user_id = ? AND v.status = 'PENDING' ORDER BY v.created_at DESC`).all(guildId, userId) as TeamInvite[];
}

function requirePendingInvite(inviteId: number, userId: string): TeamInvite {
  const invite = getInvite(inviteId);
  if (!invite || invite.status !== 'PENDING') throw new UserError('That invite is no longer available.');
  if (invite.userId !== userId) throw new UserError('That invite isn’t for you.');
  return invite;
}

export function acceptInvite(inviteId: number, userId: string): Team {
  const invite = requirePendingInvite(inviteId, userId);
  const player = requirePlayer(userId);
  const team = getTeamById(invite.teamId)!;
  const current = getTeamOfUser(team.guildId, userId);
  if (current) throw new UserError(`You’re already on **${current.name}**. Leave it before joining another team.`);
  if (player.region !== team.region) throw new UserError(`You’re registered in **${player.region}**, but **${team.name}** is a **${team.region}** team.`);
  assertRosterUnlocked(team);
  assertRoomForOneMore(team);
  db.transaction(() => {
    db.prepare('INSERT INTO team_members (team_id, guild_id, user_id) VALUES (?, ?, ?)').run(team.id, team.guildId, userId);
    db.prepare("UPDATE team_invites SET status = 'ACCEPTED' WHERE id = ?").run(invite.id);
  })();
  return team;
}

/**
 * Staff put a player straight onto a team (no invite). Without a Discord account the player is stored by
 * Meta username only: they still get whitelisted, they just can't get DMs, roles or see match channels.
 */
export function addPlayerAsStaff(team: Team, rawMeta: string, userId?: string): string {
  const meta = validateMetaUsername(rawMeta);
  const id = userId ?? offDiscordId(meta);
  assertRosterUnlocked(team);
  const owner = db.prepare('SELECT user_id AS id FROM players WHERE meta_username = ?').get(meta) as { id: string } | undefined;
  if (owner && owner.id !== id) throw new UserError(`The Meta username **${meta}** already belongs to ${who(owner.id)}.`);
  const current = getTeamOfUser(team.guildId, id);
  if (current) throw new UserError(current.id === team.id ? `${who(id)} is already on **${team.name}**.` : `${who(id)} is already on **${current.name}**.`);
  assertRoomForOneMore(team);
  db.transaction(() => {
    if (!getPlayer(id)) registerPlayer(id, meta, team.region as Region, 'UTC');
    else updatePlayer(id, { metaUsername: meta, region: team.region as Region });
    db.prepare('INSERT INTO team_members (team_id, guild_id, user_id) VALUES (?, ?, ?)').run(team.id, team.guildId, id);
  })();
  return id;
}

/** Staff take a player (found by Meta username) off a team. Returns their id. */
export function removePlayerAsStaff(team: Team, meta: string): string {
  const player = db.prepare('SELECT user_id AS id FROM players WHERE meta_username = ?').get(meta.trim()) as { id: string } | undefined;
  if (!player || !isMember(team.id, player.id)) throw new UserError(`**${meta}** isn’t on **${team.name}**.`);
  if (player.id === team.captainId) throw new UserError('That’s the captain. Make someone else captain first.');
  kickMember(team, player.id);
  return player.id;
}

export function declineInvite(inviteId: number, userId: string): TeamInvite {
  const invite = requirePendingInvite(inviteId, userId);
  db.prepare("UPDATE team_invites SET status = 'DECLINED' WHERE id = ?").run(invite.id);
  return invite;
}

export function kickMember(team: Team, userId: string): void {
  if (userId === team.captainId) throw new UserError('You can’t kick yourself. Use `/team transfer`.');
  if (!isMember(team.id, userId)) throw new UserError('That player isn’t on your team.');
  assertRosterUnlocked(team);
  db.prepare('DELETE FROM team_members WHERE team_id = ? AND user_id = ?').run(team.id, userId);
}

export function leaveTeam(team: Team, userId: string): void {
  if (userId === team.captainId) throw new UserError('Captains can’t leave. Hand off captain with `/team transfer`, or ask staff to disband the team.');
  assertRosterUnlocked(team);
  db.prepare('DELETE FROM team_members WHERE team_id = ? AND user_id = ?').run(team.id, userId);
}

export function transferCaptain(team: Team, newCaptainId: string): void {
  if (newCaptainId === team.captainId) throw new UserError('You’re already the captain.');
  if (!isMember(team.id, newCaptainId)) throw new UserError('The new captain has to be on your team.');
  db.prepare('UPDATE teams SET captain_id = ? WHERE id = ?').run(newCaptainId, team.id);
}

export function disbandTeam(team: Team): string[] {
  assertRosterUnlocked(team);
  const members = getMembers(team.id).map(m => m.userId);
  db.prepare('DELETE FROM teams WHERE id = ?').run(team.id);
  return members;
}

export function teamDisplayName(teamId: number | null): string {
  if (teamId === null) return 'TBD';
  return getTeamById(teamId)?.name ?? '(disbanded team)';
}

export function playerLabel(userId: string): string {
  const player = getPlayer(userId);
  return player ? `${who(userId)} (${player.metaUsername})` : who(userId);
}
