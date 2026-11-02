import type { ChatInputCommandInteraction } from 'discord.js';
import { Colors, EPHEMERAL, UserError, isStaff, notice, requireGuild } from '../util.js';
import { bracketChannelId, casterChannelId, casterRoleId, logChannelId, matchCategoryId, setSetting, staffRoleId, type SettingKey } from '../services/settings.js';
import { logEvent } from './shared.js';
import { runChecks } from '../startup.js';

const show = (value: string | undefined, mention: string) => (value ? `<${mention}${value}>` : '*not set*');

function summary(): string {
  return `**Staff role:** ${show(staffRoleId(), '@&')}\n**Log channel:** ${show(logChannelId(), '#')}\n**Bracket channel:** ${bracketChannelId() ? show(bracketChannelId(), '#') : '*not set — uses the channel where the tournament is started*'}`
    + `\n**Match channel category:** ${matchCategoryId() ? show(matchCategoryId(), '#') : '*not set — same category as the bracket channel*'}`
    + `\n**Casters:** ${casterRoleId() ? `${show(casterRoleId(), '@&')} (DMed)${casterChannelId() ? ` + pinged in ${show(casterChannelId(), '#')}` : ''}` : '*not set*'}`;
}

export async function settingsCommand(i: ChatInputCommandInteraction): Promise<void> {
  requireGuild(i);
  // Only people with Manage Server / Administrator, so a bad staff role can't lock admins out.
  if (!isStaff(i)) throw new UserError('Only admins (Manage Server) can change settings.');
  const sub = i.options.getSubcommand();

  if (sub === 'check') {
    await i.deferReply({ flags: EPHEMERAL });
    const { ok, lines } = await runChecks();
    await i.editReply({ embeds: [notice(ok ? 'Setup looks good' : 'Setup needs attention', lines.join('\n'), ok ? Colors.success : Colors.warning)] });
    return;
  }

  if (sub === 'casters') {
    const role = i.options.getRole('role')?.id ?? null, channel = i.options.getChannel('channel')?.id ?? null;
    if (channel && !role) throw new UserError('Give the caster role too (or nothing, to turn caster DMs off).');
    setSetting('caster_role_id', role);
    setSetting('caster_channel_id', channel);
    await logEvent(i.client, 'Settings changed', `<@${i.user.id}> ${role ? 'updated' : 'cleared'} **casters**.`);
  } else if (sub !== 'view') {
    const value = sub === 'staff_role' ? i.options.getRole('role')?.id : i.options.getChannel('channel')?.id;
    const keys: Record<string, SettingKey> = { staff_role: 'staff_role_id', log_channel: 'log_channel_id', bracket_channel: 'bracket_channel_id', match_category: 'match_category_id' };
    setSetting(keys[sub], value ?? null);
    await logEvent(i.client, 'Settings changed', `<@${i.user.id}> ${value ? 'updated' : 'cleared'} **${sub.replace('_', ' ')}**.`);
  }
  await i.reply({ embeds: [notice('Settings', summary(), Colors.info)], flags: EPHEMERAL, allowedMentions: { parse: [] } });
}
