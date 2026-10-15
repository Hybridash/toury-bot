import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, type ButtonInteraction, type ChatInputCommandInteraction } from 'discord.js';
import { Colors, EPHEMERAL, UserError, notice, plural, requireGuild } from '../util.js';
import { getMatchView, openMatchesForTeam } from '../services/bracket.js';
import { listGames, recordGameWin, winsNeeded } from '../services/series.js';
import { listArenas, whitelistFor } from '../services/arenas.js';
import { createGameReport, getReport, setReportStatus } from '../services/reports.js';
import { assertTeamNotBanned } from '../services/bans.js';
import { getTeamById, requireCaptain, requireOwnTeam } from '../services/teams.js';
import {
  STATUS_LABEL, confirmedCount, listRegistrations, listTournaments, requireTournament, signUp, withdraw, type Tournament
} from '../services/tournaments.js';
import { announceChampionIfDone, bracketEmbeds, logEvent, notifyReadyMatches, staffCheck } from './shared.js';

export function tournamentSummary(t: Tournament): string {
  const starts = t.startsAt && (t.status === 'SIGNUPS' || t.status === 'CLOSED') ? ` • starts <t:${Math.floor(t.startsAt / 1000)}:R>` : '';
  return `${STATUS_LABEL[t.status]}${starts} • ${t.region === 'ANY' ? 'Any region' : t.region} • ${t.format === 'DOUBLE' ? 'Double' : 'Single'} elim • `
    + `${t.bestOf === 1 ? 'Bo1' : `Bo${t.bestOf}`} • ${confirmedCount(t.id)}/${t.maxTeams} teams • ${t.minRoster === t.maxRoster ? t.minRoster : `${t.minRoster}–${t.maxRoster}`} players per team`;
}

export async function sendBracket(i: ChatInputCommandInteraction | ButtonInteraction, t: Tournament, ephemeral = false): Promise<void> {
  const embeds = bracketEmbeds(t);
  const flags = ephemeral ? EPHEMERAL : undefined;
  await i.reply({ embeds: [embeds[0]], flags, allowedMentions: { parse: [] } });
  for (const embed of embeds.slice(1)) await i.followUp({ embeds: [embed], flags, allowedMentions: { parse: [] } });
}

export async function tournamentCommand(i: ChatInputCommandInteraction): Promise<void> {
  const guildId = requireGuild(i);
  const sub = i.options.getSubcommand();

  if (sub === 'list') {
    const tournaments = listTournaments(guildId).slice(0, 20);
    await i.reply({ embeds: [notice('Tournaments', tournaments.length
      ? tournaments.map(t => `**${t.name}**\n${tournamentSummary(t)}`).join('\n\n')
      : 'No tournaments yet. Staff can make one with `/tournament-admin create`.')] });
    return;
  }

  const t = requireTournament(guildId, i.options.getString('tournament', true));

  if (sub === 'info') {
    const regs = listRegistrations(t.id);
    const confirmed = regs.filter(r => r.status === 'CONFIRMED');
    const pending = regs.filter(r => r.status === 'PENDING');
    const champ = t.championTeamId ? getTeamById(t.championTeamId)?.name : null;
    const embed = new EmbedBuilder().setTitle(t.name).setColor(Colors.info).setDescription(tournamentSummary(t) + (champ ? `\n🏆 Champion: **${champ}**` : ''))
      .addFields({
        name: `Teams (${confirmed.length})`,
        value: (confirmed.map((r, n) => `${r.seed ?? n + 1}. **${r.teamName}** — ${plural(r.rosterSize, 'player')}`).join('\n') || 'No teams yet.').slice(0, 1024)
      });
    if (pending.length) embed.addFields({ name: `Waiting for approval (${pending.length})`, value: pending.map(r => `**${r.teamName}**`).join(', ').slice(0, 1024) });
    if (t.requireApproval && t.status === 'SIGNUPS') embed.setFooter({ text: 'Signups need staff approval.' });
    await i.reply({ embeds: [embed], allowedMentions: { parse: [] } });
    return;
  }

  if (sub === 'bracket') {
    if (t.status !== 'RUNNING' && t.status !== 'COMPLETE') throw new UserError(`**${t.name}** hasn’t started yet, so there’s no bracket.`);
    await sendBracket(i, t);
    return;
  }

  const team = requireCaptain(guildId, i.user.id);

  if (sub === 'signup') {
    await assertTeamNotBanned(team.id, team.name);
    const status = signUp(t, team);
    await logEvent(i.client, 'Tournament signup', `**${team.name}** signed up for **${t.name}**${status === 'PENDING' ? ' (waiting for approval)' : ''}.`);
    await i.reply({ embeds: [status === 'PENDING'
      ? notice('Signup sent', `**${team.name}** asked to join **${t.name}**. Staff will approve or deny it soon.`, Colors.warning)
      : notice('Signed up!', `**${team.name}** is in **${t.name}**. Rosters lock once the bracket starts.`, Colors.success)] });
    return;
  }

  if (sub === 'withdraw') {
    withdraw(t, team);
    await logEvent(i.client, 'Tournament withdrawal', `**${team.name}** withdrew from **${t.name}**.`, Colors.warning);
    await i.reply({ embeds: [notice('Withdrawn', `**${team.name}** is no longer signed up for **${t.name}**.`, Colors.muted)] });
  }
}

// ---- Matches --------------------------------------------------------------

export async function matchCommand(i: ChatInputCommandInteraction): Promise<void> {
  const guildId = requireGuild(i);
  const sub = i.options.getSubcommand();
  const team = requireOwnTeam(guildId, i.user.id);

  if (sub === 'list') {
    const matches = openMatchesForTeam(team.id);
    await i.reply({
      embeds: [notice(`${team.name} — matches to play`, matches.length
        ? matches.map(m => {
          const opponentId = m.team1_id === team.id ? m.team2_id! : m.team1_id!;
          const opponent = getTeamById(opponentId);
          const ours = m.team1_id === team.id ? m.team1_wins : m.team2_wins, theirs = m.team1_id === team.id ? m.team2_wins : m.team1_wins;
          const series = m.best_of > 1 ? ` • series ${ours}–${theirs} (first to ${winsNeeded(m.best_of)})` : '';
          const arena = m.arena_name ? ` • 🏟️ ${m.arena_name}` : arenaPending(m.guild_id) ? ' • waiting for a free arena' : '';
          return `\`#${m.id}\` vs **${opponent?.name ?? 'TBD'}** (${m.tournament_name})${series}${arena} — captain <@${opponent?.captainId}>`;
        }).join('\n')
        : 'Nothing to play right now. You’ll get a DM when your next match is ready.')],
      flags: EPHEMERAL
    });
    return;
  }

  if (sub === 'info') {
    const matchId = i.options.getInteger('match', true);
    await i.reply({ embeds: [matchInfoEmbed(guildId, matchId)], flags: EPHEMERAL, allowedMentions: { parse: [] } });
    return;
  }

}

function arenaPending(guildId: string): boolean {
  return listArenas(guildId).some(a => a.enabled);
}

export function matchInfoEmbed(guildId: string, matchId: number): EmbedBuilder {
  const match = getMatchView(matchId);
  if (!match || match.guild_id !== guildId) throw new UserError(`Match #${matchId} doesn’t exist.`);
  const a = match.team1_name ?? 'TBD', b = match.team2_name ?? 'TBD';
  const games = listGames(matchId);
  const status = match.status === 'COMPLETE'
    ? `🏁 Finished — **${match.winner_id === match.team1_id ? a : b}** won ${match.team1_wins}–${match.team2_wins}`
    : match.status === 'READY' ? `⚔️ In progress — ${match.team1_wins}–${match.team2_wins}` : '⏳ Waiting on teams';
  const embed = new EmbedBuilder().setTitle(`Match #${match.id} — ${a} vs ${b}`).setColor(Colors.info)
    .setDescription(`${match.tournament_name} • ${match.best_of === 1 ? 'one game' : `best of ${match.best_of}`}\n${status}`)
    .addFields(
      { name: 'Arena', value: match.arena_name ?? (match.status === 'READY' && arenaPending(guildId) ? 'Waiting for a free arena' : '—'), inline: true },
      { name: 'Games', value: games.length ? games.map(g => `Game ${g.game_number}: **${g.winner_id === match.team1_id ? a : b}**${g.score1 != null ? ` (${g.score1}–${g.score2})` : ''}`).join('\n') : 'None played yet', inline: true }
    );
  const whitelist = whitelistFor(matchId);
  if (whitelist.length) {
    const failed = whitelist.filter(w => w.status === 'ERROR' || w.status === 'NOT_FOUND');
    embed.addFields({ name: 'Whitelist', value: failed.length
      ? `${whitelist.length - failed.length}/${whitelist.length} players whitelisted. Problems: ${failed.map(f => `${f.meta_username} (${f.last_error ?? f.status})`).join(', ')}`.slice(0, 1024)
      : `${whitelist.filter(w => w.status === 'GRANTED').length ? `All ${whitelist.length} players whitelisted` : `Access removed for all ${whitelist.length} players`}` });
  }
  return embed;
}

/** The Sign Up button on a tournament announcement. */
export async function handleSignupButton(i: ButtonInteraction, rawId: string): Promise<void> {
  const guildId = requireGuild(i);
  const t = listTournaments(guildId).find(x => x.id === Number(rawId));
  if (!t) throw new UserError('That tournament no longer exists.');
  const team = requireCaptain(guildId, i.user.id);
  await assertTeamNotBanned(team.id, team.name);
  const status = signUp(t, team);
  await logEvent(i.client, 'Tournament signup', `**${team.name}** signed up for **${t.name}**${status === 'PENDING' ? ' (waiting for approval)' : ''}.`);
  await i.reply({ embeds: [status === 'PENDING'
    ? notice('Signup sent', `**${team.name}** asked to join **${t.name}**. Staff will approve or deny it soon.`, Colors.warning)
    : notice('Signed up!', `**${team.name}** is in **${t.name}**. Rosters lock once the bracket starts.`, Colors.success)], flags: EPHEMERAL });
}
