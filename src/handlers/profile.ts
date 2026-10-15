import { EmbedBuilder, type ChatInputCommandInteraction, type User } from 'discord.js';
import { refreshWhitelistForUser } from '../services/arenas.js';
import { Colors, EPHEMERAL, UserError, requireGuild } from '../util.js';
import { getPlayer, localTime, normalizeTimezone, registerPlayer, requirePlayer, updatePlayer, validateMetaUsername, type Player, type Region } from '../services/players.js';
import { getTeamOfUser, isOnAnyTeam } from '../services/teams.js';
import { logEvent } from './shared.js';

function readTimezone(input: string): string {
  const timezone = normalizeTimezone(input);
  if (!timezone) throw new UserError(`**${input}** isn’t a timezone I know. Start typing your city and pick one from the list (e.g. \`America/Chicago\`).`);
  return timezone;
}

function profileEmbed(user: User, player: Player, guildId: string): EmbedBuilder {
  const team = getTeamOfUser(guildId, user.id);
  return new EmbedBuilder()
    .setAuthor({ name: user.username, iconURL: user.displayAvatarURL() })
    .setColor(Colors.info)
    .addFields(
      { name: 'Meta username', value: player.metaUsername, inline: true },
      { name: 'Region', value: player.region, inline: true },
      { name: 'Timezone', value: `${player.timezone}\n(${localTime(player.timezone)} there now)`, inline: true },
      { name: 'Team', value: team ? `**${team.name}**${team.captainId === user.id ? ' (captain)' : ''}` : 'No team yet', inline: false }
    );
}

export async function profileCommand(i: ChatInputCommandInteraction): Promise<void> {
  const guildId = requireGuild(i);
  const sub = i.options.getSubcommand();

  if (sub === 'register') {
    const metaUsername = validateMetaUsername(i.options.getString('meta_username', true));
    const region = i.options.getString('region', true) as Region;
    const timezone = readTimezone(i.options.getString('timezone', true));
    const player = registerPlayer(i.user.id, metaUsername, region, timezone);
    await logEvent(i.client, 'Player registered', `<@${i.user.id}> registered as **${player.metaUsername}** (${player.region}, ${player.timezone}).`);
    await i.reply({
      embeds: [profileEmbed(i.user, player, guildId).setTitle('✅ Profile registered')
        .setFooter({ text: 'Next: create a team with /team create, or wait for a captain to invite you.' })],
      flags: EPHEMERAL
    });
    return;
  }

  if (sub === 'edit') {
    const current = requirePlayer(i.user.id);
    const rawName = i.options.getString('meta_username');
    const region = i.options.getString('region') as Region | null;
    const rawTz = i.options.getString('timezone');
    if (!rawName && !region && !rawTz) throw new UserError('Pick at least one thing to change.');
    if (region && region !== current.region && isOnAnyTeam(i.user.id)) {
      throw new UserError('You can’t change region while you’re on a team, since teams are region-locked. Leave your team first.');
    }
    const player = updatePlayer(i.user.id, {
      metaUsername: rawName ? validateMetaUsername(rawName) : undefined,
      region: region ?? undefined,
      timezone: rawTz ? readTimezone(rawTz) : undefined
    });
    if (rawName) await refreshWhitelistForUser(i.user.id).catch(console.error); // keeps a live match's arena whitelist in step
    await logEvent(i.client, 'Profile updated', `<@${i.user.id}> updated their profile: **${player.metaUsername}** (${player.region}, ${player.timezone}).`);
    await i.reply({ embeds: [profileEmbed(i.user, player, guildId).setTitle('✅ Profile updated')], flags: EPHEMERAL });
    return;
  }

  const target = i.options.getUser('user') ?? i.user;
  const player = getPlayer(target.id);
  if (!player) throw new UserError(target.id === i.user.id ? 'You haven’t registered yet. Use `/profile register`.' : `${target} hasn’t registered a profile yet.`);
  await i.reply({ embeds: [profileEmbed(target, player, guildId).setTitle('Player profile')], flags: EPHEMERAL });
}
