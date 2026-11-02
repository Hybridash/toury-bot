import { db } from '../db.js';
import { UserError } from '../util.js';

export const REGIONS = ['NA', 'EU', 'OCE'] as const;
export type Region = (typeof REGIONS)[number];

export interface Player {
  userId: string;
  metaUsername: string;
  region: Region;
  timezone: string;
  createdAt: string;
  updatedAt: string;
}

const TIMEZONES: string[] = Array.from(new Set(['UTC', ...Intl.supportedValuesOf('timeZone')]));
const POPULAR_TIMEZONES = [
  'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Phoenix',
  'America/Anchorage', 'Pacific/Honolulu', 'America/Toronto', 'Europe/London', 'Europe/Paris',
  'Europe/Berlin', 'Europe/Madrid', 'Europe/Warsaw', 'Europe/Helsinki', 'Australia/Perth',
  'Australia/Adelaide', 'Australia/Brisbane', 'Australia/Sydney', 'Australia/Melbourne', 'Pacific/Auckland', 'UTC'
];

function cleanTz(input: string): string {
  return input.trim().toLowerCase().replace(/\s+/g, '_');
}

export function normalizeTimezone(input: string): string | undefined {
  const q = cleanTz(input);
  return TIMEZONES.find(tz => tz.toLowerCase() === q);
}

export function searchTimezones(query: string, limit = 25): string[] {
  const q = cleanTz(query);
  if (!q) return POPULAR_TIMEZONES.slice(0, limit);
  const starts = TIMEZONES.filter(tz => tz.toLowerCase().startsWith(q) || tz.toLowerCase().split('/').some(part => part.startsWith(q)));
  const contains = TIMEZONES.filter(tz => !starts.includes(tz) && tz.toLowerCase().includes(q));
  return [...starts, ...contains].slice(0, limit);
}

export function localTime(timezone: string, date = new Date()): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(date);
}

/** Players staff add by Meta username only (not in the Discord) get a stand-in id like "meta:name". */
export const offDiscordId = (metaUsername: string): string => `meta:${metaUsername.toLowerCase()}`;
export const onDiscord = (userId: string): boolean => !userId.startsWith('meta:');

/** A mention for Discord players, the Meta username for everyone else. */
export function who(userId: string): string {
  return onDiscord(userId) ? `<@${userId}>` : `**${getPlayer(userId)?.metaUsername ?? userId.slice(5)}** (no Discord)`;
}

const SELECT = `SELECT user_id AS userId, meta_username AS metaUsername, region, timezone, created_at AS createdAt, updated_at AS updatedAt FROM players`;

export function getPlayer(userId: string): Player | undefined {
  return db.prepare(`${SELECT} WHERE user_id = ?`).get(userId) as Player | undefined;
}

export function requirePlayer(userId: string, otherMention?: string): Player {
  const player = getPlayer(userId);
  if (!player) {
    throw new UserError(otherMention
      ? `${otherMention} isn’t registered yet.`
      : 'You aren’t registered yet. Accept a team invite to get registered.');
  }
  return player;
}

export function validateMetaUsername(input: string): string {
  const name = input.trim();
  if (name.length < 2 || name.length > 32) throw new UserError('Your Meta username must be 2–32 characters.');
  if (/[\n`@]/.test(name)) throw new UserError('Your Meta username can’t contain `@`, backticks, or line breaks.');
  return name;
}

function assertMetaUsernameFree(name: string, userId: string): void {
  const owner = db.prepare('SELECT user_id FROM players WHERE meta_username = ?').get(name) as { user_id: string } | undefined;
  if (owner && owner.user_id !== userId) throw new UserError(`The Meta username **${name}** is already registered to someone else.`);
}

export function registerPlayer(userId: string, metaUsername: string, region: Region, timezone: string): Player {
  if (getPlayer(userId)) throw new UserError('You already have a profile. Use `/player edit` to change it.');
  assertMetaUsernameFree(metaUsername, userId);
  db.prepare('INSERT INTO players (user_id, meta_username, region, timezone) VALUES (?, ?, ?, ?)').run(userId, metaUsername, region, timezone);
  return getPlayer(userId)!;
}

export function updatePlayer(userId: string, changes: { metaUsername?: string; region?: Region; timezone?: string }): Player {
  const current = requirePlayer(userId);
  if (changes.metaUsername) assertMetaUsernameFree(changes.metaUsername, userId);
  db.prepare(`UPDATE players SET meta_username = ?, region = ?, timezone = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?`)
    .run(changes.metaUsername ?? current.metaUsername, changes.region ?? current.region, changes.timezone ?? current.timezone, userId);
  return getPlayer(userId)!;
}

/** Registered Meta usernames, for autocomplete on staff commands like /ban. */
export function searchMetaUsernames(query: string, limit = 25): string[] {
  return (db.prepare('SELECT meta_username FROM players WHERE meta_username LIKE ? ORDER BY meta_username LIMIT ?').all(`%${query.trim()}%`, limit) as Array<{ meta_username: string }>)
    .map(r => r.meta_username);
}
