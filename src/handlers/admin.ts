import { ActionRowBuilder, ButtonBuilder, ButtonStyle, type ChatInputCommandInteraction } from 'discord.js';
import { db } from '../db.js';
import { undoLastGame } from '../services/series.js';
import { rescoreMatch } from '../services/scoring.js';
import { Colors, EPHEMERAL, UserError, notice, requireGuild } from '../util.js';
import { getMatchView, type Format } from '../services/bracket.js';
import { forceSeriesResult, recordGameWin, winsNeeded } from '../services/series.js';
import { getTeamById, getTeamByName } from '../services/teams.js';
import {
  addTeamAsStaff, createTournament, type Seeding, deleteTournament, disqualifyTeam, getTournamentById, listRegistrations, requireTournament, reviewRegistration, setSignupsOpen, startTournament, withdraw
} from '../services/tournaments.js';
import { announceChampionIfDone, announceGame, askConfirm, cleanupTournament, bracketEmbeds, dm, logEvent, notifyReadyMatches, requireStaff } from './shared.js';
import { beginReadyCheck, cancelReadyCheck } from './start.js';
import { tournamentSummary } from './tournament.js';

export async function adminCommand(i: ChatInputCommandInteraction): Promise<void> {
  const guildId = requireGuild(i);
  requireStaff(i);
  const sub = i.options.getSubcommand();

  if (sub === 'create') {
    const t = createTournament(guildId, {
      name: i.options.getString('name', true),
      region: i.options.getString('region', true),
      format: i.options.getString('format', true) as Format,
      maxTeams: i.options.getInteger('max_teams', true),
      minRoster: i.options.getInteger('min_roster', true),
      maxRoster: i.options.getInteger('max_roster', true),
      requireApproval: i.options.getBoolean('require_approval') ?? false,
      bestOf: i.options.getInteger('best_of') ?? 3,
      startsAt: i.options.getInteger('starts_in_minutes') ? Date.now() + i.options.getInteger('starts_in_minutes', true) * 60_000 : undefined
    }, i.user.id);
    db.prepare('UPDATE tournaments SET channel_id = ? WHERE id = ?').run(i.channelId, t.id);
    await logEvent(i.client, 'Tournament created', `<@${i.user.id}> created **${t.name}**.`);
    await i.reply({
      embeds: [notice(`🏆 ${t.name}`, `${tournamentSummary(getTournamentById(t.id)!)}\n\nSignups are open! Captains: click **Sign Up** (or use \`/tournament signup\`).`, Colors.success)],
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId(`signup:yes:${t.id}`).setLabel('Sign Up').setStyle(ButtonStyle.Success))]
    });
    return;
  }

  if (sub === 'undo_game') {
    const matchId = i.options.getInteger('match', true);
    const view = getMatchView(matchId);
    if (!view || view.guild_id !== guildId) throw new UserError(`Match #${matchId} doesn’t exist.`);
    const { gameNumber, reopened } = undoLastGame(matchId);
    await logEvent(i.client, 'Game undone', `<@${i.user.id}> undid ${gameNumber ? `game ${gameNumber} of ` : 'the result of '}match #${matchId}${reopened ? ' (match reopened)' : ''}.`, Colors.warning);
    await i.reply({ embeds: [notice(`Match #${matchId}`, `${gameNumber ? `Game ${gameNumber} removed.` : 'Result removed.'}${reopened ? ' The match is back in play.' : ''} Series is now ${getMatchView(matchId)!.team1_wins}–${getMatchView(matchId)!.team2_wins}.`, Colors.warning)] });
    await notifyReadyMatches(i.client);
    return;
  }

  if (sub === 'rescore') {
    const matchId = i.options.getInteger('match', true);
    const view = getMatchView(matchId);
    if (!view || view.guild_id !== guildId) throw new UserError(`Match #${matchId} doesn’t exist.`);
    await i.deferReply();
    const recorded = await rescoreMatch(matchId);
    for (const game of recorded) await announceGame(i.client, game);
    await logEvent(i.client, 'Match rescored', `<@${i.user.id}> re-read match #${matchId}: ${recorded.length} missed game(s) recorded.`, Colors.warning);
    await i.editReply({ embeds: [notice(`Match #${matchId} rescored`, recorded.length ? `Recorded ${recorded.length} missed game(s).` : 'Nothing was missing — every finished game is already counted.', Colors.info)] });
    return;
  }

  if (sub === 'resolve' || sub === 'game') {
    const matchId = i.options.getInteger('match', true);
    db.prepare('UPDATE matches SET disputed = 0 WHERE id = ?').run(matchId);
    const match = getMatchView(matchId);
    if (!match || match.guild_id !== guildId) throw new UserError(`Match #${matchId} doesn’t exist.`);
    const winnerInput = i.options.getString('winner', true);
    const winner = getTeamById(Number(winnerInput)) ?? getTeamByName(guildId, winnerInput);
    if (!winner || (winner.id !== match.team1_id && winner.id !== match.team2_id)) throw new UserError('Pick one of the two teams in that match.');
    const winnerIsOne = winner.id === match.team1_id;

    if (sub === 'game') {
      const state = recordGameWin(matchId, winner.id, i.user.id, i.user.id);
      const score = `**${match.team1_name}** ${state.team1Wins} – ${state.team2Wins} **${match.team2_name}**`;
      await logEvent(i.client, 'Game set by staff', `Match #${matchId} game ${state.gamesPlayed}: **${winner.name}** — set by <@${i.user.id}>. Series ${score}.`, Colors.warning);
      await i.reply({ embeds: [notice(`Match #${matchId} — game ${state.gamesPlayed}`, state.finished
        ? `**${winner.name}** won game ${state.gamesPlayed}.\n${score}\n🏅 **${winner.name}** wins the series and moves on.`
        : `**${winner.name}** won game ${state.gamesPlayed}.\nSeries: ${score} (first to ${state.winsNeeded}).`, Colors.success)] });
      if (state.finished) {
        await notifyReadyMatches(i.client);
        await announceChampionIfDone(i.client, match.tournament_id, i.channelId);
      }
      return;
    }

    const needed = winsNeeded(match.best_of);
    const winGames = i.options.getInteger('winner_games') ?? needed;
    const loseGames = i.options.getInteger('loser_games') ?? (winnerIsOne ? match.team2_wins : match.team1_wins);
    if (winGames <= loseGames) throw new UserError('The winner needs more game wins than the loser.');
    if (match.status !== 'READY') throw new UserError(`Match #${matchId} isn’t being played right now.`);
    forceSeriesResult(matchId, winner.id, winnerIsOne ? winGames : loseGames, winnerIsOne ? loseGames : winGames);
    const line = `**${match.team1_name}** ${winnerIsOne ? winGames : loseGames} – ${winnerIsOne ? loseGames : winGames} **${match.team2_name}**`;
    await logEvent(i.client, 'Match resolved by staff', `Match #${matchId}: ${line} — set by <@${i.user.id}>.`, Colors.warning);
    await i.reply({ embeds: [notice(`Match #${matchId} — final`, `${line}\n🏅 **${winner.name}** wins (set by staff) and moves on in the bracket.`, Colors.success)] });
    await notifyReadyMatches(i.client);
    await announceChampionIfDone(i.client, match.tournament_id, i.channelId);
    return;
  }

  const t = requireTournament(guildId, i.options.getString('tournament', true));

  if (sub === 'add') {
    const input = i.options.getString('team', true);
    const team = getTeamById(Number(input)) ?? getTeamByName(guildId, input);
    if (!team || team.guildId !== guildId) throw new UserError(`No team called **${input}** was found.`);
    addTeamAsStaff(t, team);
    await logEvent(i.client, 'Team added', `<@${i.user.id}> added **${team.name}** to **${t.name}**.`);
    await i.reply({ embeds: [notice('Team added', `**${team.name}** is now in **${t.name}**.`, Colors.success)] });
    return;
  }

  if (sub === 'disqualify') {
    const input = i.options.getString('team', true);
    const team = getTeamById(Number(input)) ?? getTeamByName(guildId, input);
    if (!team || team.guildId !== guildId) throw new UserError(`No team called **${input}** was found.`);
    const reason = i.options.getString('reason', true);
    await askConfirm(i, 'Disqualify team?', `Disqualify **${team.name}** from **${t.name}**? Their current and future matches are forfeited and their opponents advance.`, async button => {
      disqualifyTeam(t, team);
      await logEvent(i.client, 'Team disqualified', `<@${i.user.id}> disqualified **${team.name}** from **${t.name}**. Reason: ${reason}`, Colors.danger);
      await dm(i.client, team.captainId, { embeds: [notice('Disqualified', `**${team.name}** was disqualified from **${t.name}**.\nReason: ${reason}`, Colors.danger)] });
      await button.update({ embeds: [notice('Disqualified', `**${team.name}** is out of **${t.name}**.`, Colors.muted)], components: [] });
      await notifyReadyMatches(i.client);
    }, 'Disqualify');
    return;
  }

  if (sub === 'approve' || sub === 'deny') {
    const input = i.options.getString('team', true);
    const team = getTeamById(Number(input)) ?? getTeamByName(guildId, input);
    if (!team || team.guildId !== guildId) throw new UserError(`No team called **${input}** was found.`);
    const registration = listRegistrations(t.id).find(r => r.teamId === team.id);
    if (!registration) throw new UserError(`**${team.name}** isn’t signed up for **${t.name}**.`);
    if (sub === 'approve') {
      reviewRegistration(t, team.id, true);
    } else if (registration.status === 'PENDING') {
      reviewRegistration(t, team.id, false);
    } else {
      withdraw(t, team);
    }
    const approved = sub === 'approve';
    await logEvent(i.client, approved ? 'Signup approved' : 'Team removed', `<@${i.user.id}> ${approved ? 'approved' : 'removed'} **${team.name}** ${approved ? 'for' : 'from'} **${t.name}**.`);
    await dm(i.client, team.captainId, { embeds: [approved
      ? notice('You’re in!', `**${team.name}** was approved for **${t.name}**.`, Colors.success)
      : notice('Tournament update', `**${team.name}** was not accepted into **${t.name}**.`, Colors.danger)] });
    await i.reply({ embeds: [notice(approved ? 'Approved' : 'Removed', `**${team.name}** ${approved ? 'is in' : 'is out of'} **${t.name}**.`, approved ? Colors.success : Colors.muted)], flags: EPHEMERAL });
    return;
  }

  if (sub === 'close' || sub === 'reopen') {
    setSignupsOpen(t, sub === 'reopen');
    await logEvent(i.client, sub === 'close' ? 'Signups closed' : 'Signups reopened', `**${t.name}** — by <@${i.user.id}>.`);
    await i.reply({ embeds: [notice(sub === 'close' ? 'Signups closed' : 'Signups reopened', `Signups for **${t.name}** are now ${sub === 'close' ? 'closed' : 'open'}.`, Colors.info)] });
    return;
  }

  if (sub === 'start') {
    const seeding = (i.options.getString('seed_by') as Seeding | null) ?? (i.options.getBoolean('shuffle') ? 'random' : 'signup');
    await askConfirm(i, 'Start tournament?', `DM every player of **${t.name}** a ready check? Once every player clicks Ready, rosters lock, the bracket is built${seeding === 'random' ? ' with random seeding' : seeding === 'record' ? ' seeded by past record' : ' in signup order'}, and players are whitelisted into arenas. If anyone can’t be whitelisted, it won’t start.`, async button => {
      if (!button.channel?.isSendable()) throw new UserError('I can’t post in this channel.');
      await button.update({ embeds: [notice('Ready check started', `Every player of **${t.name}** is being sent a ready check by DM. Staff alerts go to the log channel.`, Colors.info)], components: [] });
      await beginReadyCheck(i.client, button.channel, t.id, seeding);
    }, 'Start');
    return;
  }

  if (sub === 'delete') {
    await askConfirm(i, 'Delete tournament?', `Delete **${t.name}**, its signups, its bracket, match threads and role, and close the arenas it was using? Teams themselves are kept.`, async button => {
      await cancelReadyCheck(t.id);
      await cleanupTournament(i.client, t.id, true); // role, match threads, live bracket message
      deleteTournament(t);
      await notifyReadyMatches(i.client); // closes its arenas right away and hands them to waiting matches
      await logEvent(i.client, 'Tournament deleted', `<@${i.user.id}> deleted **${t.name}**.`, Colors.danger);
      await button.update({ embeds: [notice('Deleted', `**${t.name}** was deleted.`, Colors.muted)], components: [] });
    }, 'Delete');
  }
}
