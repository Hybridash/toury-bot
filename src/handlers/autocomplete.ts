import type { AutocompleteInteraction } from 'discord.js';
import { getMatchView } from '../services/bracket.js';
import { searchMetaUsernames, searchTimezones } from '../services/players.js';
import { searchArenas } from '../services/arenas.js';
import { searchTeams } from '../services/teams.js';
import { findTournament, listRegistrations, searchTournaments, type TournamentStatus } from '../services/tournaments.js';

type Choice = { name: string; value: string };

const tournamentStatusesFor: Record<string, TournamentStatus[] | undefined> = {
  'tournament:bracket': ['RUNNING', 'COMPLETE'],
  'tournament-admin:deny': ['SIGNUPS', 'CLOSED'],
  'tournament-admin:close': ['SIGNUPS'],
  'tournament-admin:reopen': ['CLOSED'],
  'tournament-admin:start': ['SIGNUPS', 'CLOSED'],
  'tournament-admin:disqualify': ['RUNNING']
};

export async function handleAutocomplete(i: AutocompleteInteraction): Promise<void> {
  const focused = i.options.getFocused(true);
  const query = String(focused.value ?? '');
  const sub = i.options.getSubcommand(false) ?? '';
  const guildId = i.guildId;
  let choices: Choice[] = [];

  if (focused.name === 'timezone') {
    choices = searchTimezones(query).map(tz => ({ name: tz.replaceAll('_', ' '), value: tz }));
  } else if (guildId && focused.name === 'tournament') {
    choices = searchTournaments(guildId, query, tournamentStatusesFor[`${i.commandName}:${sub}`]).map(t => ({ name: t.name, value: t.name }));
  } else if (guildId && focused.name === 'team' && i.commandName === 'tournament-admin' && sub !== 'add') {
    const t = findTournament(guildId, i.options.getString('tournament') ?? '');
    if (t) {
      const wanted = listRegistrations(t.id);
      choices = wanted
        .filter(r => r.teamName.toLowerCase().includes(query.toLowerCase()))
        .map(r => ({ name: `${r.teamName}${r.status === 'PENDING' ? ' (pending)' : ''}`, value: String(r.teamId) }));
    }
  } else if (guildId && focused.name === 'team') {
    choices = searchTeams(guildId, query).map(t => ({ name: t.name, value: t.name }));
  } else if (focused.name === 'username') {
    choices = searchMetaUsernames(query).map(name => ({ name, value: name }));
  } else if (guildId && focused.name === 'name' && i.commandName === 'arena') {
    choices = searchArenas(guildId, query).map(a => ({ name: `${a.name}${a.enabled ? '' : ' (disabled)'}`, value: a.name }));
  } else if (guildId && focused.name === 'winner') {
    const match = getMatchView(i.options.getInteger('match') ?? 0);
    if (match && match.guild_id === guildId) {
      choices = [[match.team1_id, match.team1_name], [match.team2_id, match.team2_name]]
        .filter((pair): pair is [number, string] => pair[0] !== null && pair[1] !== null)
        .map(([id, name]) => ({ name, value: String(id) }));
    }
  }

  await i.respond(choices.slice(0, 25).map(c => ({ name: c.name.slice(0, 100), value: c.value.slice(0, 100) }))).catch(() => null);
}
