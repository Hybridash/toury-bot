import { EmbedBuilder, type ChatInputCommandInteraction } from 'discord.js';
import { Colors, EPHEMERAL, UserError, notice, requireGuild } from '../util.js';
import { errorText, isActiveBan, mainFleetId, orion, stationId, type OrionBan } from '../integrations/orion.js';
import {
  addArena, getArenaByName, listArenas, manualWhitelist, removeArena, seedArenas, setArenaEnabled
} from '../services/arenas.js';
import { logEvent, notifyReadyMatches, requireStaff } from './shared.js';

function cleanUsername(input: string): string {
  const name = input.trim();
  if (!name || name.length > 64) throw new UserError('Enter a valid Orion Drift username.');
  return name;
}

function fleetsForGuild(_guildId: string): string[] {
  const fleet = mainFleetId();
  if (!fleet) throw new UserError('No fleet to ban in. Set `ORION_FLEET_ID` in `.env`.');
  return [fleet];
}

// ---- /ban /unban /banlist ---------------------------------------------------

export async function banCommand(i: ChatInputCommandInteraction): Promise<void> {
  const guildId = requireGuild(i);
  requireStaff(i);
  const api = orion();
  const username = cleanUsername(i.options.getString('username', true));
  const reason = i.options.getString('reason', true).trim();
  const hours = i.options.getInteger('hours', true);
  const fleets = fleetsForGuild(guildId);
  await i.deferReply({ flags: EPHEMERAL });

  const userId = await api.findUserId(username, fleets);
  if (!userId) throw new UserError(`No Orion Drift player called **${username}** was found. Check the spelling.`);

  const results = await Promise.all(fleets.map(async fleetId => {
    try { await api.banUser(fleetId, userId, reason, hours); return { fleetId, ok: true as const }; }
    catch (error) { return { fleetId, ok: false as const, error: errorText(error) }; }
  }));
  const ok = results.filter(r => r.ok).length;
  const failed = results.filter(r => !r.ok);
  if (!ok) throw new UserError(`The ban didn’t go through:\n${failed.map(f => `• \`${f.fleetId}\`: ${'error' in f ? f.error : ''}`).join('\n')}`);

  const duration = hours % 24 === 0 ? `${hours / 24} day${hours === 24 ? '' : 's'}` : `${hours} hour${hours === 1 ? '' : 's'}`;
  await logEvent(i.client, 'Player banned', `<@${i.user.id}> banned **${username}** for ${duration}. Reason: ${reason}`, Colors.danger);
  await i.editReply({ embeds: [notice('Player banned', `**${username}** is banned for **${duration}** in ${ok} fleet${ok === 1 ? '' : 's'}.\nReason: ${reason}`
    + (failed.length ? `\n⚠️ Failed in: ${failed.map(f => `\`${f.fleetId}\` (${'error' in f ? f.error : ''})`).join(', ')}` : ''), failed.length ? Colors.warning : Colors.success)] });
}

export async function unbanCommand(i: ChatInputCommandInteraction): Promise<void> {
  const guildId = requireGuild(i);
  requireStaff(i);
  const api = orion();
  const username = cleanUsername(i.options.getString('username', true));
  const fleets = fleetsForGuild(guildId);
  await i.deferReply({ flags: EPHEMERAL });

  const lines: string[] = [];
  let unbanned = 0;
  for (const fleetId of fleets) {
    try {
      // The ban list gives us the user ID directly, so no username lookup is needed.
      const ban = (await api.listBans(fleetId)).find(b => b.username?.toLowerCase() === username.toLowerCase() && isActiveBan(b));
      if (!ban) { lines.push(`\`${fleetId}\`: no active ban`); continue; }
      await api.unbanUser(fleetId, ban.user_id);
      unbanned++;
      lines.push(`\`${fleetId}\`: ✅ unbanned`);
    } catch (error) {
      lines.push(`\`${fleetId}\`: ❌ ${errorText(error)}`);
    }
  }
  if (!unbanned) throw new UserError(`Nothing was unbanned for **${username}**:\n${lines.join('\n')}`);
  await logEvent(i.client, 'Player unbanned', `<@${i.user.id}> unbanned **${username}**.`, Colors.success);
  await i.editReply({ embeds: [notice('Player unbanned', `**${username}** was unbanned.\n${lines.join('\n')}`, Colors.success)] });
}

export async function banlistCommand(i: ChatInputCommandInteraction): Promise<void> {
  const guildId = requireGuild(i);
  requireStaff(i);
  const api = orion();
  const fleets = fleetsForGuild(guildId);
  await i.deferReply({ flags: EPHEMERAL });
  const seen = new Map<string, OrionBan>();
  const errors: string[] = [];
  for (const fleetId of fleets) {
    try {
      for (const ban of await api.listBans(fleetId)) if (isActiveBan(ban) && !seen.has(ban.user_id)) seen.set(ban.user_id, ban);
    } catch (error) { errors.push(`\`${fleetId}\`: ${errorText(error)}`); }
  }
  const bans = [...seen.values()].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  const lines = bans.slice(0, 25).map(ban => {
    const until = ban.expiration ? `until <t:${Math.floor(new Date(ban.expiration.endsWith('Z') ? ban.expiration : `${ban.expiration}Z`).valueOf() / 1000)}:R>` : 'permanent';
    return `**${ban.username}** — ${until} — ${ban.reason || 'no reason'}`;
  });
  await i.editReply({ embeds: [new EmbedBuilder().setTitle(`Active bans (${bans.length})`).setColor(Colors.danger)
    .setDescription((lines.join('\n') || 'No active bans.').slice(0, 4000) + (bans.length > 25 ? `\n…and ${bans.length - 25} more` : ''))
    .setFooter(errors.length ? { text: `Some fleets failed: ${errors.join('; ')}`.slice(0, 2000) } : null)] });
}

// ---- /arena ------------------------------------------------------------------

export async function arenaCommand(i: ChatInputCommandInteraction): Promise<void> {
  const guildId = requireGuild(i);
  requireStaff(i);
  const sub = i.options.getSubcommand();

  if (sub === 'list') {
    const arenas = listArenas(guildId);
    await i.reply({ embeds: [notice('Arenas', arenas.length
      ? arenas.map(a => `**${a.name}** — ${!a.enabled ? '⏸️ disabled' : a.matchId ? `⚔️ match #${a.matchId}` : '✅ free'}\nSlot \`${a.slot}\``).join('\n\n')
      : 'No arenas yet. Run `/arena seed` to add Alpha/Beta/Gamma 1–3.')], flags: EPHEMERAL });
    return;
  }

  if (sub === 'seed') {
    const added = seedArenas(guildId);
    await logEvent(i.client, 'Arenas added', `<@${i.user.id}> added ${added.length} arenas.`);
    await i.reply({ embeds: [notice('Arenas added', added.length ? added.map(a => `• **${a.name}** → slot \`${a.slot}\``).join('\n') : 'All nine arenas already exist.', Colors.success)], flags: EPHEMERAL });
    return;
  }

  if (sub === 'add') {
    const station = i.options.getString('station_id') ?? stationId();
    if (!station) throw new UserError('Give a `station_id`, or set `ORION_STATION_ID` in `.env`.');
    const arena = addArena(guildId, i.options.getString('name', true), station, i.options.getString('slot', true));
    await logEvent(i.client, 'Arena added', `<@${i.user.id}> added arena **${arena.name}** (slot ${arena.slot}).`);
    await i.reply({ embeds: [notice('Arena added', `**${arena.name}** → slot \`${arena.slot}\`. Its whitelist stays closed until a match is given to it.`, Colors.success)], flags: EPHEMERAL });
    await notifyReadyMatches(i.client);
    return;
  }

  if (sub === 'whitelist' || sub === 'unwhitelist') {
    const username = cleanUsername(i.options.getString('username', true));
    const matchId = i.options.getInteger('match', true);
    const side = (i.options.getInteger('team', true) - 1) as 0 | 1;
    await i.deferReply();
    const added = sub === 'whitelist';
    await manualWhitelist(matchId, username, side, added);
    await logEvent(i.client, added ? 'Manual whitelist' : 'Manual unwhitelist', `<@${i.user.id}> ${added ? 'whitelisted' : 'removed'} **${username}** ${added ? 'into' : 'from'} match #${matchId}.`, Colors.warning);
    await i.editReply({ embeds: [notice(added ? 'Whitelisted' : 'Removed', `**${username}** ${added ? 'can now join' : 'can no longer join'} match #${matchId}’s arena.`, Colors.success)] });
    return;
  }

  const arena = getArenaByName(guildId, i.options.getString('name', true));
  if (!arena) throw new UserError('No arena with that name.');

  if (sub === 'enable' || sub === 'disable') {
    setArenaEnabled(arena, sub === 'enable');
    await i.reply({ embeds: [notice(sub === 'enable' ? 'Arena enabled' : 'Arena disabled', sub === 'enable'
      ? `**${arena.name}** can be given to matches again.`
      : `**${arena.name}** won’t get new matches. A match already in it keeps playing.`, Colors.info)], flags: EPHEMERAL });
    if (sub === 'enable') await notifyReadyMatches(i.client);
    return;
  }

  removeArena(arena);
  await logEvent(i.client, 'Arena removed', `<@${i.user.id}> removed arena **${arena.name}**.`, Colors.warning);
  await i.reply({ embeds: [notice('Arena removed', `**${arena.name}** was removed.`, Colors.muted)], flags: EPHEMERAL });
}
