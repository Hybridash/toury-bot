import type { ChatInputCommandInteraction } from 'discord.js';
import { refreshWhitelistForUser } from '../services/arenas.js';
import { Colors, EPHEMERAL, UserError, notice, requireGuild } from '../util.js';
import { getPlayer, registerPlayer, updatePlayer, validateMetaUsername, type Region } from '../services/players.js';
import { getTeamOfUser } from '../services/teams.js';
import { logEvent, staffCheck } from './shared.js';

/** /player edit: set the Meta username the bot whitelists. Players change their own, captains their team's, staff anyone's. */
export async function playerCommand(i: ChatInputCommandInteraction): Promise<void> {
  const guildId = requireGuild(i);
  const target = i.options.getUser('user') ?? i.user;
  const team = getTeamOfUser(guildId, target.id);
  if (target.id !== i.user.id && !staffCheck(i) && team?.captainId !== i.user.id) throw new UserError('Only your captain or staff can edit someone else’s Meta username.');
  if (!team) throw new UserError(target.id === i.user.id ? 'You need to be on a team to set your Meta username.' : `${target} isn’t on a team.`);
  const metaUsername = validateMetaUsername(i.options.getString('meta_username', true));
  const player = getPlayer(target.id)
    ? updatePlayer(target.id, { metaUsername })
    : registerPlayer(target.id, metaUsername, team.region as Region, 'UTC');
  await refreshWhitelistForUser(target.id).catch(console.error); // keeps a live match's arena whitelist in step
  await logEvent(i.client, 'Meta username updated', `<@${i.user.id}> set ${target}’s Meta username to **${player.metaUsername}**.`);
  await i.reply({ embeds: [notice('Meta username saved', `${target}’s Meta username is now **${player.metaUsername}**.`, Colors.success)], flags: EPHEMERAL, allowedMentions: { parse: [] } });
}
