import { db } from '../db.js';
import { UserError } from '../util.js';
import { generateBracket, type Format } from './bracket.js';
import { teamRecord } from './stats.js';
import { memberCount, type Team } from './teams.js';

export type TournamentStatus = 'SIGNUPS' | 'CLOSED' | 'RUNNING' | 'COMPLETE';
export type RegistrationStatus = 'PENDING' | 'CONFIRMED';

export interface Tournament {
  id: number;
  guildId: string;
  name: string;
  region: string;
  format: Format;
  maxTeams: number;
  minRoster: number;
  maxRoster: number;
  requireApproval: number;
  bestOf: number;
  status: TournamentStatus;
  championTeamId: number | null;
  createdBy: string;
  createdAt: string;
  /** Planned start time (ms since epoch) for reminders; null if staff didn't set one. */
  startsAt: number | null;
}

export interface Registration {
  teamId: number;
  teamName: string;
  captainId: string;
  status: RegistrationStatus;
  seed: number | null;
  createdAt: string;
  rosterSize: number;
}

const SELECT = `SELECT id, guild_id AS guildId, name, region, format, max_teams AS maxTeams, min_roster AS minRoster,
  max_roster AS maxRoster, require_approval AS requireApproval, best_of AS bestOf, status, champion_team_id AS championTeamId,
  created_by AS createdBy, created_at AS createdAt, starts_at AS startsAt FROM tournaments`;

export const STATUS_LABEL: Record<TournamentStatus, string> = {
  SIGNUPS: '🟢 Signups open',
  CLOSED: '🟡 Signups closed',
  RUNNING: '🔵 In progress',
  COMPLETE: '🏁 Finished'
};

export interface CreateTournamentInput {
  name: string;
  region: string;
  format: Format;
  maxTeams: number;
  minRoster: number;
  maxRoster: number;
  requireApproval: boolean;
  bestOf: number;
  startsAt?: number;
}

export function createTournament(guildId: string, input: CreateTournamentInput, createdBy: string): Tournament {
  const name = input.name.trim().replace(/\s+/g, ' ');
  if (name.length < 2 || name.length > 48) throw new UserError('Tournament names must be 2–48 characters.');
  if (input.minRoster > input.maxRoster) throw new UserError('Minimum roster size can’t be bigger than the maximum.');
  if (input.format === 'DOUBLE' && input.maxTeams < 3) throw new UserError('Double elimination needs room for at least 3 teams.');
  if (![1, 3, 5, 7].includes(input.bestOf)) throw new UserError('Series length must be best of 1, 3, 5, or 7.');
  if (findTournament(guildId, name)) throw new UserError(`A tournament named **${name}** already exists.`);
  const result = db.prepare(`INSERT INTO tournaments (guild_id, name, region, format, max_teams, min_roster, max_roster, require_approval, best_of, created_by, starts_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(guildId, name, input.region, input.format, input.maxTeams, input.minRoster, input.maxRoster, input.requireApproval ? 1 : 0, input.bestOf, createdBy, input.startsAt ?? null);
  return getTournamentById(Number(result.lastInsertRowid))!;
}

export function getTournamentById(id: number): Tournament | undefined {
  return db.prepare(`${SELECT} WHERE id = ?`).get(id) as Tournament | undefined;
}

export function findTournament(guildId: string, name: string): Tournament | undefined {
  return db.prepare(`${SELECT} WHERE guild_id = ? AND name = ?`).get(guildId, name.trim()) as Tournament | undefined;
}

export function requireTournament(guildId: string, name: string): Tournament {
  const tournament = findTournament(guildId, name);
  if (!tournament) throw new UserError(`No tournament called **${name}** was found.`);
  return tournament;
}

export function listTournaments(guildId: string): Tournament[] {
  return db.prepare(`${SELECT} WHERE guild_id = ?
    ORDER BY CASE status WHEN 'SIGNUPS' THEN 1 WHEN 'CLOSED' THEN 2 WHEN 'RUNNING' THEN 3 ELSE 4 END, created_at DESC`).all(guildId) as Tournament[];
}

export function searchTournaments(guildId: string, query: string, statuses?: TournamentStatus[]): Tournament[] {
  const statusFilter = statuses?.length ? ` AND status IN (${statuses.map(() => '?').join(', ')})` : '';
  return db.prepare(`${SELECT} WHERE guild_id = ? AND name LIKE ?${statusFilter} ORDER BY created_at DESC LIMIT 25`)
    .all(guildId, `%${query.trim()}%`, ...(statuses ?? [])) as Tournament[];
}

export function listRegistrations(tournamentId: number, status?: RegistrationStatus): Registration[] {
  return db.prepare(`SELECT r.team_id AS teamId, t.name AS teamName, t.captain_id AS captainId, r.status, r.seed, r.created_at AS createdAt,
      (SELECT COUNT(*) FROM team_members m WHERE m.team_id = t.id) AS rosterSize
    FROM registrations r JOIN teams t ON t.id = r.team_id
    WHERE r.tournament_id = ?${status ? ' AND r.status = ?' : ''}
    ORDER BY COALESCE(r.seed, 9999), r.created_at, t.name`).all(...(status ? [tournamentId, status] : [tournamentId])) as Registration[];
}

export function confirmedCount(tournamentId: number): number {
  return (db.prepare("SELECT COUNT(*) AS count FROM registrations WHERE tournament_id = ? AND status = 'CONFIRMED'").get(tournamentId) as { count: number }).count;
}

export function tournamentsForTeam(teamId: number): Array<{ name: string; status: TournamentStatus; registration: RegistrationStatus }> {
  return db.prepare(`SELECT t.name, t.status, r.status AS registration FROM registrations r JOIN tournaments t ON t.id = r.tournament_id
    WHERE r.team_id = ? AND t.status != 'COMPLETE' ORDER BY t.created_at`).all(teamId) as Array<{ name: string; status: TournamentStatus; registration: RegistrationStatus }>;
}

function getRegistrationStatus(tournamentId: number, teamId: number): RegistrationStatus | undefined {
  return (db.prepare('SELECT status FROM registrations WHERE tournament_id = ? AND team_id = ?').get(tournamentId, teamId) as { status: RegistrationStatus } | undefined)?.status;
}

export function signUp(tournament: Tournament, team: Team): RegistrationStatus {
  if (tournament.status !== 'SIGNUPS') throw new UserError(`Signups for **${tournament.name}** aren’t open.`);
  if (tournament.region !== 'ANY' && tournament.region !== team.region) {
    throw new UserError(`**${tournament.name}** is a **${tournament.region}** tournament and **${team.name}** is a **${team.region}** team.`);
  }
  if (getRegistrationStatus(tournament.id, team.id)) throw new UserError(`**${team.name}** is already signed up for **${tournament.name}**.`);
  const roster = memberCount(team.id);
  if (roster < tournament.minRoster) throw new UserError(`**${tournament.name}** needs at least ${tournament.minRoster} players per team. **${team.name}** has ${roster}.`);
  if (roster > tournament.maxRoster) throw new UserError(`**${tournament.name}** allows at most ${tournament.maxRoster} players per team. **${team.name}** has ${roster}.`);
  if (confirmedCount(tournament.id) >= tournament.maxTeams) throw new UserError(`**${tournament.name}** is full (${tournament.maxTeams} teams).`);
  const status: RegistrationStatus = tournament.requireApproval ? 'PENDING' : 'CONFIRMED';
  db.prepare('INSERT INTO registrations (tournament_id, team_id, status) VALUES (?, ?, ?)').run(tournament.id, team.id, status);
  return status;
}

export function withdraw(tournament: Tournament, team: Team): void {
  if (tournament.status === 'RUNNING' || tournament.status === 'COMPLETE') throw new UserError(`**${tournament.name}** has already started, so teams can’t withdraw. Ask staff for help.`);
  const removed = db.prepare('DELETE FROM registrations WHERE tournament_id = ? AND team_id = ?').run(tournament.id, team.id).changes;
  if (!removed) throw new UserError(`**${team.name}** isn’t signed up for **${tournament.name}**.`);
}

export function reviewRegistration(tournament: Tournament, teamId: number, approve: boolean): void {
  if (tournament.status === 'RUNNING' || tournament.status === 'COMPLETE') throw new UserError(`**${tournament.name}** has already started.`);
  if (getRegistrationStatus(tournament.id, teamId) !== 'PENDING') throw new UserError('That team doesn’t have a pending signup for this tournament.');
  if (approve) {
    if (confirmedCount(tournament.id) >= tournament.maxTeams) throw new UserError(`**${tournament.name}** is already full (${tournament.maxTeams} teams).`);
    db.prepare("UPDATE registrations SET status = 'CONFIRMED' WHERE tournament_id = ? AND team_id = ?").run(tournament.id, teamId);
  } else {
    db.prepare('DELETE FROM registrations WHERE tournament_id = ? AND team_id = ?').run(tournament.id, teamId);
  }
}

export function setSignupsOpen(tournament: Tournament, open: boolean): void {
  if (open && tournament.status !== 'CLOSED') throw new UserError(`Signups for **${tournament.name}** can only be reopened while they’re closed.`);
  if (!open && tournament.status !== 'SIGNUPS') throw new UserError(`Signups for **${tournament.name}** aren’t open.`);
  db.prepare('UPDATE tournaments SET status = ? WHERE id = ?').run(open ? 'SIGNUPS' : 'CLOSED', tournament.id);
}

/** Locks rosters, seeds teams, and builds the bracket. Returns the seeded teams. */
export type Seeding = 'signup' | 'random' | 'record';

export function startTournament(tournament: Tournament, seeding: Seeding | boolean = 'signup'): Registration[] {
  const mode: Seeding = seeding === true ? 'random' : seeding === false ? 'signup' : seeding;
  if (tournament.status !== 'SIGNUPS' && tournament.status !== 'CLOSED') throw new UserError(`**${tournament.name}** has already started.`);
  const teams = listRegistrations(tournament.id, 'CONFIRMED');
  const minimum = tournament.format === 'DOUBLE' ? 3 : 2;
  if (teams.length < minimum) throw new UserError(`**${tournament.name}** needs at least ${minimum} confirmed teams to start (it has ${teams.length}).`);
  const problems = teams.filter(team => team.rosterSize < tournament.minRoster || team.rosterSize > tournament.maxRoster);
  if (problems.length) {
    throw new UserError(`These teams don’t meet the roster size (${tournament.minRoster}–${tournament.maxRoster} players):\n`
      + problems.map(team => `• **${team.teamName}** has ${team.rosterSize}`).join('\n')
      + '\nThey need to fix their roster, or you can remove them with `/tournament-admin deny` first.');
  }
  const seeded = mode === 'random' ? shuffleCopy(teams) : mode === 'record' ? byRecord(teams) : teams;
  db.transaction(() => {
    db.prepare("DELETE FROM registrations WHERE tournament_id = ? AND status != 'CONFIRMED'").run(tournament.id);
    const setSeed = db.prepare('UPDATE registrations SET seed = ? WHERE tournament_id = ? AND team_id = ?');
    seeded.forEach((team, index) => setSeed.run(index + 1, tournament.id, team.teamId));
    db.prepare("UPDATE tournaments SET status = 'RUNNING' WHERE id = ?").run(tournament.id);
    generateBracket(tournament.id, seeded.map(team => team.teamId), tournament.format);
  })();
  return seeded.map((team, index) => ({ ...team, seed: index + 1 }));
}

/** Undoes startTournament when the arena whitelist fails, so staff can fix teams and start again. */
export function rollbackStart(tournament: Tournament): void {
  db.transaction(() => {
    db.prepare('DELETE FROM matches WHERE tournament_id = ?').run(tournament.id);
    db.prepare('UPDATE registrations SET seed = NULL WHERE tournament_id = ?').run(tournament.id);
    db.prepare("UPDATE tournaments SET status = 'CLOSED' WHERE id = ?").run(tournament.id);
  })();
}

/** Staff bring in a replacement team, skipping the signup checks except capacity. */
export function addTeamAsStaff(tournament: Tournament, team: Team): void {
  if (tournament.status !== 'SIGNUPS' && tournament.status !== 'CLOSED') throw new UserError(`**${tournament.name}** has already started.`);
  if (getRegistrationStatus(tournament.id, team.id) === 'CONFIRMED') throw new UserError(`**${team.name}** is already in **${tournament.name}**.`);
  if (confirmedCount(tournament.id) >= tournament.maxTeams) throw new UserError(`**${tournament.name}** is full (${tournament.maxTeams} teams). Remove a team first.`);
  db.prepare("INSERT INTO registrations (tournament_id, team_id, status) VALUES (?, ?, 'CONFIRMED') ON CONFLICT (tournament_id, team_id) DO UPDATE SET status = 'CONFIRMED'")
    .run(tournament.id, team.id);
}

/** Takes a team out of a running tournament: its current and future matches are forfeited (see forfeitDisqualified). */
export function disqualifyTeam(tournament: Tournament, team: Team): void {
  if (tournament.status !== 'RUNNING') throw new UserError(`**${tournament.name}** isn’t running. Use \`/tournament-admin deny\` to remove a team before it starts.`);
  const changed = db.prepare("UPDATE registrations SET disqualified = 1 WHERE tournament_id = ? AND team_id = ? AND disqualified = 0").run(tournament.id, team.id).changes;
  if (!changed) throw new UserError(`**${team.name}** isn’t in **${tournament.name}**, or is already disqualified.`);
}

export function deleteTournament(tournament: Tournament): void {
  db.prepare('DELETE FROM tournaments WHERE id = ?').run(tournament.id);
}

/** Best past record first (match wins, then game difference); teams with equal records keep signup order. */
function byRecord(teams: Registration[]): Registration[] {
  const score = (t: Registration) => { const r = teamRecord(t.teamId); return [r.matchesWon - r.matchesLost, r.gamesWon - r.gamesLost]; };
  return teams.map((t, i) => ({ t, i, s: score(t) })).sort((a, b) => b.s[0] - a.s[0] || b.s[1] - a.s[1] || a.i - b.i).map(x => x.t);
}

function shuffleCopy<T>(items: T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}
