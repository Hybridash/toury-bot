import type { ChatInputCommandInteraction } from 'discord.js';
import { Colors, EPHEMERAL, UserError, isStaff, notice, requireGuild } from '../util.js';
import { logChannelId, setSetting, staffRoleId, threadChannelId, type SettingKey } from '../services/settings.js';
import { logEvent } from './shared.js';
import { runChecks } from '../startup.js';

const show = (value: string | undefined, mention: string) => (value ? `<${mention}${value}>` : '*not set*');

function summary(): string {
  return `**Staff role:** ${show(staffRoleId(), '@&')}\n**Log channel:** ${show(logChannelId(), '#')}\n**Match thread channel:** ${threadChannelId() ? show(threadChannelId(), '#') : '*not set — uses the channel where the tournament is started*'}`;
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

  if (sub !== 'view') {
    const value = sub === 'staff_role' ? i.options.getRole('role')?.id : i.options.getChannel('channel')?.id;
    setSetting(sub === 'staff_role' ? 'staff_role_id' : sub === 'log_channel' ? 'log_channel_id' : 'thread_channel_id' as SettingKey, value ?? null);
    await logEvent(i.client, 'Settings changed', `<@${i.user.id}> ${value ? 'updated' : 'cleared'} **${sub.replace('_', ' ')}**.`);
  }
  await i.reply({ embeds: [notice('Settings', summary(), Colors.info)], flags: EPHEMERAL, allowedMentions: { parse: [] } });
}
