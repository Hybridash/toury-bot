import { EmbedBuilder, MessageFlags, PermissionFlagsBits, type Interaction, type RepliableInteraction } from 'discord.js';

/** An error whose message is safe and useful to show the member. */
export class UserError extends Error {}

export const Colors = {
  info: 0x5865f2,
  success: 0x57f287,
  warning: 0xfaa61a,
  danger: 0xed4245,
  muted: 0x99aab5
} as const;

export const EPHEMERAL = MessageFlags.Ephemeral;

export function notice(title: string, description: string, color: number = Colors.info): EmbedBuilder {
  return new EmbedBuilder().setTitle(title).setDescription(description).setColor(color);
}

export function isStaff(i: Interaction, staffRoleId?: string): boolean {
  if (!i.inGuild()) return false;
  if (i.memberPermissions?.has(PermissionFlagsBits.Administrator) || i.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return true;
  if (!staffRoleId) return false;
  const roles = i.member?.roles;
  if (!roles) return false;
  return Array.isArray(roles) ? roles.includes(staffRoleId) : roles.cache.has(staffRoleId);
}

export function requireGuild(i: Interaction): string {
  if (!i.guildId) throw new UserError('Use this command inside a server.');
  return i.guildId;
}

export async function replyError(i: RepliableInteraction, error: unknown): Promise<void> {
  const message = error instanceof UserError ? error.message : 'Something went wrong. Try again in a moment.';
  if (!(error instanceof UserError)) console.error(error);
  const payload = { embeds: [notice('Error', message, Colors.danger)], flags: EPHEMERAL } as const;
  try {
    if (i.replied || i.deferred) await i.followUp(payload);
    else await i.reply(payload);
  } catch {
    // The interaction may have expired; nothing else to do.
  }
}

export function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}
