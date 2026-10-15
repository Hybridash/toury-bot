import { UserError } from '../util.js';
import { isActiveBan, mainFleetId, orionOrNull } from '../integrations/orion.js';
import { getMembers } from './teams.js';

let cache: { at: number; names: Set<string> } | undefined;

async function activeBans(): Promise<Set<string> | null> {
  const api = orionOrNull(), fleet = mainFleetId();
  if (!api || !fleet) return null;
  if (cache && Date.now() - cache.at < 60_000) return cache.names;
  try {
    const names = new Set((await api.listBans(fleet)).filter(isActiveBan).map(b => b.username.toLowerCase()));
    cache = { at: Date.now(), names };
    return names;
  } catch {
    return null; // if Orion Drift is unreachable, don't block players
  }
}

/** The usernames (from those given) that are banned in Orion Drift right now. */
export async function bannedAmong(usernames: string[]): Promise<string[]> {
  const banned = await activeBans();
  return banned ? usernames.filter(u => banned.has(u.toLowerCase())) : [];
}

export function clearBanCache(): void {
  cache = undefined;
}

export async function assertNoBannedPlayers(usernames: string[], context: string): Promise<void> {
  const banned = await bannedAmong(usernames);
  if (banned.length) throw new UserError(`${context}: ${banned.map(b => `**${b}**`).join(', ')} ${banned.length === 1 ? 'is' : 'are'} banned from Orion Drift right now.`);
}

export async function assertTeamNotBanned(teamId: number, teamName: string): Promise<void> {
  await assertNoBannedPlayers(getMembers(teamId).map(m => m.metaUsername).filter((n): n is string => Boolean(n)), `**${teamName}** can’t enter`);
}
