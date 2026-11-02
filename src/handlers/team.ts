import { basename } from 'node:path';
import { ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, type ButtonInteraction, type ChatInputCommandInteraction, type ModalSubmitInteraction } from 'discord.js';
import { teamRecord } from '../services/stats.js';
import { Colors, EPHEMERAL, UserError, notice, requireGuild } from '../util.js';
import { getPlayer, localTime, registerPlayer, validateMetaUsername, who, type Region } from '../services/players.js';
import {
  acceptInvite, createInvite, declineInvite, getInvite, getMembers, getTeamByName, kickMember,
  leaveTeam, listPendingInvites, lockingTournament, requireCaptain, requireOwnTeam, transferCaptain, getTeamById, type Team
} from '../services/teams.js';
import { tournamentsForTeam } from '../services/tournaments.js';
import { askConfirm, dm, logEvent } from './shared.js';
import { dropTeamRoles, syncTeamRoles } from './roles.js';

function inviteButtons(inviteId: number, teamName: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`invite:accept:${inviteId}`).setLabel(`Join ${teamName}`.slice(0, 80)).setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`invite:decline:${inviteId}`).setLabel('Decline').setStyle(ButtonStyle.Secondary)
  );
}

export function teamEmbed(team: Team): EmbedBuilder {
  const members = getMembers(team.id);
  const roster = members.map(m => {
    const crown = m.userId === team.captainId ? '👑 ' : '';
    const details = m.metaUsername ? ` — ${m.metaUsername}${m.timezone ? ` • ${m.timezone} (${localTime(m.timezone)})` : ''}` : '';
    return `${crown}${who(m.userId)}${details}`;
  }).join('\n');
  const entries = tournamentsForTeam(team.id);
  const lock = lockingTournament(team.id);
  const rec = teamRecord(team.id);
  return new EmbedBuilder()
    .setTitle(team.name)
    .setColor(Colors.info)
    .addFields(
      { name: 'Region', value: team.region, inline: true },
      { name: 'Captain', value: `<@${team.captainId}>`, inline: true },
      { name: 'Players', value: String(members.length), inline: true },
      { name: 'Roster', value: roster || 'Empty' },
      ...(rec.matchesWon + rec.matchesLost ? [{ name: 'Record', value: `Matches ${rec.matchesWon}–${rec.matchesLost} • Games ${rec.gamesWon}–${rec.gamesLost}${rec.titles ? ` • 🏆 ${rec.titles} title${rec.titles === 1 ? '' : 's'}` : ''}` }] : []),
      ...(entries.length ? [{ name: 'Tournaments', value: entries.map(e => `**${e.name}** — ${e.registration === 'PENDING' ? 'waiting for approval' : e.status === 'RUNNING' ? 'playing' : 'signed up'}`).join('\n') }] : [])
    )
    .setThumbnail(team.logoPath ? `attachment://${basename(team.logoPath)}` : null)
    .setFooter(lock ? { text: `🔒 Roster locked while ${lock} is running` } : null);
}

export function teamLogoFiles(team: Team): AttachmentBuilder[] {
  return team.logoPath ? [new AttachmentBuilder(team.logoPath)] : [];
}

export async function teamCommand(i: ChatInputCommandInteraction): Promise<void> {
  const guildId = requireGuild(i);
  const sub = i.options.getSubcommand();

  if (sub === 'invites') {
    const invites = listPendingInvites(guildId, i.user.id).slice(0, 5);
    if (!invites.length) {
      await i.reply({ embeds: [notice('No invites', 'You don’t have any team invites right now.', Colors.muted)], flags: EPHEMERAL });
      return;
    }
    await i.reply({
      embeds: [notice('Your team invites', invites.map(v => `**${v.teamName}** — invited by <@${v.invitedBy}>`).join('\n'))],
      components: invites.map(v => inviteButtons(v.id, v.teamName)),
      flags: EPHEMERAL
    });
    return;
  }

  if (sub === 'info') {
    const name = i.options.getString('team');
    const team = name ? getTeamByName(guildId, name) ?? getTeamById(Number(name)) : requireOwnTeam(guildId, i.user.id);
    if (!team || team.guildId !== guildId) throw new UserError(`No team called **${name}** was found.`);
    await i.reply({ embeds: [teamEmbed(team)], files: teamLogoFiles(team), allowedMentions: { parse: [] } });
    return;
  }

  if (sub === 'leave') {
    const team = requireOwnTeam(guildId, i.user.id);
    if (team.captainId === i.user.id) throw new UserError('Captains can’t leave. Hand off captain with `/team transfer`, or ask staff to disband the team.');
    await askConfirm(i, 'Leave team?', `Are you sure you want to leave **${team.name}**?`, async button => {
      leaveTeam(team, i.user.id);
      await dropTeamRoles(i.client, team, [i.user.id]);
      await logEvent(i.client, 'Player left team', `<@${i.user.id}> left **${team.name}**.`);
      await dm(i.client, team.captainId, { embeds: [notice('Player left', `<@${i.user.id}> left **${team.name}**.`, Colors.warning)] });
      await button.update({ embeds: [notice('Left team', `You left **${team.name}**.`, Colors.muted)], components: [] });
    }, 'Leave');
    return;
  }

  // Everything below is captain-only.
  const team = requireCaptain(guildId, i.user.id);

  if (sub === 'invite') {
    const user = i.options.getUser('player', true);
    if (user.bot) throw new UserError('Bots can’t join teams.');
    const invite = createInvite(team, i.user.id, user.id, `${user}`);
    const delivered = await dm(i.client, user.id, {
      embeds: [notice('Team invite', `<@${i.user.id}> invited you to join **${team.name}** (${team.region}) in **${i.guild?.name ?? 'the server'}**.`, Colors.info)],
      components: [inviteButtons(invite.id, team.name)]
    });
    await logEvent(i.client, 'Invite sent', `<@${i.user.id}> invited ${user} to **${team.name}**.`);
    await i.reply({
      embeds: [notice('Invite sent', `${user} was invited to **${team.name}**.\n${delivered ? 'They got a DM with buttons to accept.' : 'I couldn’t DM them, so they should run `/team invites` to accept.'}`, Colors.success)],
      flags: EPHEMERAL
    });
    return;
  }

  if (sub === 'kick') {
    const user = i.options.getUser('player', true);
    if (user.id === i.user.id) throw new UserError('You can’t kick yourself. Use `/team transfer`.');
    await askConfirm(i, 'Kick player?', `Remove ${user} from **${team.name}**?`, async button => {
      kickMember(team, user.id);
      await dropTeamRoles(i.client, team, [user.id]);
      await logEvent(i.client, 'Player kicked', `<@${i.user.id}> removed ${user} from **${team.name}**.`, Colors.warning);
      await dm(i.client, user.id, { embeds: [notice('Removed from team', `You were removed from **${team.name}**.`, Colors.warning)] });
      await button.update({ embeds: [notice('Player removed', `${user} is no longer on **${team.name}**.`, Colors.success)], components: [] });
    }, 'Kick');
    return;
  }

  if (sub === 'transfer') {
    const user = i.options.getUser('player', true);
    await askConfirm(i, 'Transfer captain?', `Make ${user} the captain of **${team.name}**? You’ll stay on the team as a player.`, async button => {
      transferCaptain(team, user.id);
      await syncTeamRoles(i.client, team.id);
      await logEvent(i.client, 'Captain changed', `<@${i.user.id}> made ${user} captain of **${team.name}**.`);
      await dm(i.client, user.id, { embeds: [notice('You’re captain now 👑', `<@${i.user.id}> made you captain of **${team.name}**.`, Colors.success)] });
      await button.update({ embeds: [notice('Captain transferred', `${user} is now captain of **${team.name}**.`, Colors.success)], components: [] });
    }, 'Transfer');
    return;
  }
}

export async function handleInviteButton(button: ButtonInteraction | ModalSubmitInteraction, action: string, rawId: string): Promise<void> {
  const inviteId = Number(rawId);
  if (!Number.isInteger(inviteId)) throw new UserError('That invite is invalid.');
  if (!button.isButton() && !button.isFromMessage()) throw new UserError('Something went wrong. Press Join again.');
  if (action === 'decline') {
    const invite = declineInvite(inviteId, button.user.id);
    const team = getTeamById(invite.teamId);
    if (team) await dm(button.client, team.captainId, { embeds: [notice('Invite declined', `<@${button.user.id}> declined the invite to **${team.name}**.`, Colors.muted)] });
    await button.update({ embeds: [notice('Invite declined', `You declined **${invite.teamName}**.`, Colors.muted)], components: [] });
    return;
  }
  if (!getPlayer(button.user.id)) {
    // First time: ask for their Meta username (arena whitelisting needs it) before joining.
    if (!button.isButton()) throw new UserError('Something went wrong. Press Join again.');
    await button.showModal(new ModalBuilder().setCustomId(`invitemodal:accept:${inviteId}`).setTitle('Join the team')
      .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId('meta_username').setLabel('Your Meta (Orion Drift) username').setStyle(TextInputStyle.Short).setMinLength(2).setMaxLength(32).setRequired(true))));
    return;
  }
  const team = acceptInvite(inviteId, button.user.id);
  await syncTeamRoles(button.client, team.id);
  await logEvent(button.client, 'Player joined team', `<@${button.user.id}> joined **${team.name}**.`, Colors.success);
  await dm(button.client, team.captainId, { embeds: [notice('New teammate', `<@${button.user.id}> joined **${team.name}**!`, Colors.success)] });
  await button.update({ embeds: [notice('Welcome to the team!', `You joined **${team.name}**.`, Colors.success)], components: [] });
}

/** Submit of the Meta-username form shown the first time someone accepts an invite. */
export async function handleInviteModal(modal: ModalSubmitInteraction, rawId: string): Promise<void> {
  const invite = getInvite(Number(rawId));
  const team = invite && getTeamById(invite.teamId);
  if (!invite || invite.userId !== modal.user.id || !team) throw new UserError('That invite is no longer available.');
  const player = getPlayer(modal.user.id) ?? registerPlayer(modal.user.id, validateMetaUsername(modal.fields.getTextInputValue('meta_username')), team.region as Region, 'UTC');
  await logEvent(modal.client, 'Player registered', `<@${modal.user.id}> registered as **${player.metaUsername}** (${player.region}).`);
  await handleInviteButton(modal, 'accept', rawId);
}
