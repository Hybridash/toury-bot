import { db } from '../db.js';
import { config } from '../config.js';

/** Settings staff change with /settings. A saved value beats the matching .env default. */
export type SettingKey = 'staff_role_id' | 'log_channel_id' | 'match_category_id' | 'bracket_channel_id' | 'captain_role_id' | 'caster_role_id' | 'caster_channel_id';

function read(key: SettingKey): string | undefined {
  return (db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value;
}

export function setSetting(key: SettingKey, value: string | null): void {
  if (value === null) db.prepare('DELETE FROM settings WHERE key = ?').run(key);
  else db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, value);
}

export const captainRoleId = (): string | undefined => read('captain_role_id');
export const staffRoleId = (): string | undefined => read('staff_role_id') ?? config.staffRoleId;
export const logChannelId = (): string | undefined => read('log_channel_id') ?? config.logChannelId;
/** Category private match channels are created in. Unset = the category of the bracket channel. */
export const matchCategoryId = (): string | undefined => read('match_category_id');
/** Where the live bracket, results and champion are posted. Unset = the channel where the tournament was started. */
export const bracketChannelId = (): string | undefined => read('bracket_channel_id');
/** Everyone with the caster role gets a DM (and the optional channel a ping) before a tournament starts and whenever a match starts. */
export const casterRoleId = (): string | undefined => read('caster_role_id');
export const casterChannelId = (): string | undefined => read('caster_channel_id');
