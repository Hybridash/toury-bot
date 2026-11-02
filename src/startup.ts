import { db } from './db.js';
import { errorText, mainFleetId, orionOrNull, playerRole, stationId } from './integrations/orion.js';
import { parseKeys } from './api.js';
import { bracketChannelId, casterRoleId, logChannelId, staffRoleId } from './services/settings.js';

/** Setup self-check, run at startup and by /settings check. Lines start with ✅ (fine) or ⚠️ (needs attention). */
export async function runChecks(): Promise<{ ok: boolean; lines: string[] }> {
  const lines: string[] = [];
  const good = (text: string) => lines.push(`✅ ${text}`);
  const warn = (text: string) => lines.push(`⚠️ ${text}`);

  const api = orionOrNull();
  if (api) good('Orion Drift API key is set'); else warn('`ORION_API_KEY` is missing in `.env`: bans, whitelisting and scoring won’t work.');
  if (mainFleetId()) good('`ORION_FLEET_ID` is set'); else warn('`ORION_FLEET_ID` is missing: `/ban`, `/unban`, `/banlist` and the ban check won’t work.');
  if (playerRole()) good(`Players get the Orion Drift Tournament Player role when they’re whitelisted into an arena (lasts ${playerRole()!.hours}h)`); else warn('`ORION_PLAYER_ROLE_ID` is missing: players won’t get the fleet:join role.');
  const station = stationId();
  if (!station) warn('`ORION_STATION_ID` is missing: arenas can’t be added with `/arena seed`.');
  else if (api) {
    try { await api.listGameEnds(station); good('Station reachable (game results can be read)'); }
    catch (error) { warn(`Can’t read the station \`${station}\`: ${errorText(error)}`); }
  }
  const arenas = (db.prepare('SELECT COUNT(*) AS c FROM arenas WHERE enabled = 1').get() as { c: number }).c;
  if (arenas) good(`${arenas} arena(s) enabled`); else warn('No arenas yet: run `/arena seed`. Tournaments can’t start without one.');
  if (logChannelId()) good('Staff log channel is set'); else warn('No staff log channel: set one with `/settings log_channel` so alerts reach staff.');
  if (bracketChannelId()) good('Bracket channel is set'); else lines.push('ℹ️ No bracket channel: the live bracket goes to the channel where the tournament is started (`/settings bracket_channel`).');
  if (casterRoleId()) good('Caster role is set (casters get DMs; needs Server Members Intent on in the Developer Portal)'); else lines.push('ℹ️ No caster role: `/settings casters`.');
  if (staffRoleId()) good('Staff role is set'); else lines.push('ℹ️ No staff role set: only Manage Server / Administrator count as staff (`/settings staff_role`).');
  if (!parseKeys(process.env).length) lines.push('ℹ️ No website API key: the API is off (`npm run api:key -- website`).');
  return { ok: !lines.some(l => l.startsWith('⚠️')), lines };
}
