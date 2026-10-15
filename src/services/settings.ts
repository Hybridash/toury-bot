import { db } from '../db.js';
import { config } from '../config.js';

/** Settings staff change with /settings. A saved value beats the matching .env default. */
export type SettingKey = 'staff_role_id' | 'log_channel_id' | 'thread_channel_id';

function read(key: SettingKey): string | undefined {
  return (db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value;
}

export function setSetting(key: SettingKey, value: string | null): void {
  if (value === null) db.prepare('DELETE FROM settings WHERE key = ?').run(key);
  else db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, value);
}

export const staffRoleId = (): string | undefined => read('staff_role_id') ?? config.staffRoleId;
export const logChannelId = (): string | undefined => read('log_channel_id') ?? config.logChannelId;
/** Channel match threads are created in. Unset = the channel where the tournament was started. */
export const threadChannelId = (): string | undefined => read('thread_channel_id');
