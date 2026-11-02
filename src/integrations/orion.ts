import 'dotenv/config';
import { UserError } from '../util.js';

/**
 * Orion Drift API client. Only uses endpoints marked ✅ VERIFIED in the API docs.
 * The API key is read from ORION_API_KEY and is never logged.
 */

export interface OrionBan {
  ban_id: string;
  user_id: string;
  username: string;
  fleet_id?: string;
  timestamp: string;
  expiration: string | null;
  reason: string;
  revoked: boolean;
}

/** One side of a match as written into an arena's config. */
export interface SlotTeam {
  name: string;
  players: string[];
}

export interface GameEndEvent {
  idx: number;
  slot: string;
  trigger: string;
  timestamp: string;
  playerCount: number;
  /** In-game score for [team0, team1] when the game ended. */
  scores: [number, number];
}

export interface OrionApi {
  /** Resolves an Orion Drift username to its user ID (exact, case-insensitive). */
  findUserId(username: string, fleetIds: string[]): Promise<string | undefined>;
  banUser(fleetId: string, userId: string, reason: string, durationHours: number): Promise<void>;
  unbanUser(fleetId: string, userId: string): Promise<void>;
  listBans(fleetId: string): Promise<OrionBan[]>;
  /**
   * Sets who may enter one arena (a gamemode slot like "Beta 02" on a station): team 0 and team 1 get their
   * usernames whitelisted. Passing null for both closes the arena to everyone. Throws if the station doesn't confirm the change.
   */
  setSlot(stationId: string, slot: string, team0: SlotTeam | null, team1: SlotTeam | null): Promise<void>;
  /** Recent "game ended" events on a station, newest first. */
  listGameEnds(stationId: string): Promise<GameEndEvent[]>;
  /** Gives a fleet role to a player by username; Orion Drift removes it again after `hours`. */
  grantRole?(fleetId: string, roleId: string, username: string, hours: number): Promise<void>;
}

// Note: the separator for several usernames in one whitelist is assumed to be a comma. Change here if Orion Drift uses another.
const WHITELIST_SEPARATOR = ',';
/** Closed-arena value: a name nobody has, so an arena between matches lets no one in. */
const NOBODY = 'ares-nobody';

function slotKey(slot: string, field: string): string {
  return `loadedgamemodes.${slot.toLowerCase()}.modulestate.dashboardconfigoverrides.${field}`;
}

function whitelistValue(team: SlotTeam | null): string {
  return team?.players.length ? team.players.join(WHITELIST_SEPARATOR) : NOBODY;
}

export class OrionApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

const STATUS_MESSAGES: Record<number, string> = {
  400: 'Bad request',
  401: 'The API key is invalid or is missing a permission (scope) for this',
  403: 'The API key isn’t allowed to do this',
  404: 'Not found (check the fleet ID / user)',
  422: 'The API rejected the request format',
  429: 'Rate limited by Orion Drift — try again in a moment',
  500: 'Orion Drift server error'
};

function describe(status: number, body: string): string {
  const base = STATUS_MESSAGES[status] ?? (status >= 500 ? STATUS_MESSAGES[500] : `HTTP ${status}`);
  const detail = body.replace(/\s+/g, ' ').trim().slice(0, 200);
  return detail ? `${base} (${status}): ${detail}` : `${base} (${status})`;
}

class HttpOrionApi implements OrionApi {
  constructor(private readonly baseUrl: string, private readonly apiKey: string) {}

  private async request<T>(method: string, path: string, body?: unknown, retried = false): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: { 'x-api-key': this.apiKey, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15_000)
      });
    } catch (error) {
      console.warn(`[orion] ${method} ${path} -> network error`);
      throw new OrionApiError(0, `Couldn’t reach Orion Drift (${error instanceof Error ? error.message : 'network error'})`);
    }
    console.log(`[orion] ${method} ${path} -> ${response.status}`);
    if (response.status === 429 && !retried) {
      const wait = Math.min(Number(response.headers.get('retry-after')) || 2, 10);
      await new Promise(resolve => setTimeout(resolve, wait * 1000));
      return this.request<T>(method, path, body, true);
    }
    const text = await response.text();
    if (!response.ok) throw new OrionApiError(response.status, describe(response.status, text));
    if (!text) return undefined as T;
    try { return JSON.parse(text) as T; } catch { return text as T; }
  }

  async findUserId(username: string, fleetIds: string[]): Promise<string | undefined> {
    const wanted = username.trim().toLowerCase();
    const search = await this.request<{ items?: Array<{ user_id: string; display_name?: string; username?: string }> }>(
      'GET', `/v1/user_search?search_string=${encodeURIComponent(username.trim())}`
    ).catch(() => undefined);
    const hit = search?.items?.find(u => (u.display_name ?? u.username ?? '').toLowerCase() === wanted);
    if (hit) return String(hit.user_id);
    for (const fleetId of fleetIds) {
      const list = await this.request<{ items?: Array<{ user_id: string; username?: string }> }>(
        'GET', `/v3/fleets/${encodeURIComponent(fleetId)}/users?search_string=${encodeURIComponent(username.trim())}&page=1&page_size=50`
      ).catch(() => undefined);
      const found = list?.items?.find(u => (u.username ?? '').toLowerCase() === wanted);
      if (found) return String(found.user_id);
    }
    return undefined;
  }

  async banUser(fleetId: string, userId: string, reason: string, durationHours: number): Promise<void> {
    await this.request('POST', `/v2/fleets/${encodeURIComponent(fleetId)}/users/${encodeURIComponent(userId)}/ban?duration=${Math.round(durationHours * 60)}`, { reason, duration_hours: durationHours });
  }

  async unbanUser(fleetId: string, userId: string): Promise<void> {
    await this.request('PATCH', `/v2/fleets/${encodeURIComponent(fleetId)}/users/${encodeURIComponent(userId)}/unban`);
  }

  async listBans(fleetId: string): Promise<OrionBan[]> {
    const result = await this.request<{ bans?: OrionBan[] }>('GET', `/v2/fleets/${encodeURIComponent(fleetId)}/bans?include_revoked=false&include_expired=false`);
    return result?.bans ?? [];
  }

  async setSlot(stationId: string, slot: string, team0: SlotTeam | null, team1: SlotTeam | null): Promise<void> {
    const values: Record<string, string> = {
      [slotKey(slot, 'busewhitelist')]: 'true',
      [slotKey(slot, 'buseteam0whitelist')]: 'true',
      [slotKey(slot, 'buseteam1whitelist')]: 'true',
      [slotKey(slot, 'team0whitelist')]: whitelistValue(team0),
      [slotKey(slot, 'team1whitelist')]: whitelistValue(team1),
      [slotKey(slot, 'team0name')]: team0?.name ?? 'Team 1',
      [slotKey(slot, 'team1name')]: team1?.name ?? 'Team 2'
    };
    const path = `/v2/stations/${encodeURIComponent(stationId)}/config`;
    await this.request('POST', path, values);
    // Don't trust the 200: read it back so a wrong format fails loudly instead of leaving an arena open or locked.
    const config = await this.request<Record<string, unknown>>('GET', path);
    for (const [key, value] of Object.entries(values)) {
      if (String(config?.[key]) !== value) throw new OrionApiError(0, `The station didn’t keep the setting for ${slot} (${key.split('.').pop()}).`);
    }
  }

  async grantRole(fleetId: string, roleId: string, username: string, hours: number): Promise<void> {
    await this.request('POST', `/v2/fleets/${encodeURIComponent(fleetId)}/user_roles`, { role_id: roleId, username, expires_hours: hours });
  }

  async listGameEnds(stationId: string): Promise<GameEndEvent[]> {
    const result = await this.request<{ items?: Array<{ idx: number; event_data: string; timestamp: string }> }>(
      'GET', `/v2/stations/${encodeURIComponent(stationId)}/server_events?event_type=gamemode_stopped&page_size=50`
    );
    const events: GameEndEvent[] = [];
    for (const item of result?.items ?? []) {
      try {
        const data = JSON.parse(item.event_data) as { slot_id?: string; event_trigger?: string; players?: unknown[]; scores?: Record<string, number> };
        if (data.slot_id && data.event_trigger) events.push({ idx: item.idx, slot: data.slot_id, trigger: data.event_trigger, timestamp: item.timestamp, playerCount: data.players?.length ?? 0, scores: [Number(data.scores?.['0']) || 0, Number(data.scores?.['1']) || 0] });
      } catch { /* skip events we can't read */ }
    }
    return events;
  }
}

let override: OrionApi | undefined;
let cached: OrionApi | undefined;

/** Lets tests swap in a fake client. */
export function setOrionApi(api: OrionApi | undefined): void {
  override = api;
}

export function orionConfigured(): boolean {
  return Boolean(override || process.env.ORION_API_KEY);
}

/** Returns the client, or null when ORION_API_KEY isn't set. */
export function orionOrNull(): OrionApi | null {
  if (override) return override;
  const key = process.env.ORION_API_KEY;
  if (!key) return null;
  cached ??= new HttpOrionApi((process.env.ORION_API_BASE_URL || 'https://api.oriondrift.net').replace(/\/+$/, ''), key);
  return cached;
}

export function orion(): OrionApi {
  const api = orionOrNull();
  if (!api) throw new UserError('The Orion Drift API isn’t set up. Add `ORION_API_KEY` to the bot’s `.env` and restart it.');
  return api;
}

/** The station whose gamemode slots are the arenas, from ORION_STATION_ID. */
export function stationId(): string | undefined {
  return process.env.ORION_STATION_ID || undefined;
}

/** Fleet role (with fleet:join) every tournament player gets, from ORION_PLAYER_ROLE_ID, and how long it lasts. */
export function playerRole(): { roleId: string; hours: number } | undefined {
  const roleId = process.env.ORION_PLAYER_ROLE_ID;
  return roleId ? { roleId, hours: Number(process.env.ORION_PLAYER_ROLE_HOURS) || 12 } : undefined;
}

/** The fleet used for bans, from ORION_FLEET_ID. */
export function mainFleetId(): string | undefined {
  return process.env.ORION_FLEET_ID || undefined;
}

export function errorText(error: unknown): string {
  if (error instanceof OrionApiError || error instanceof UserError) return error.message;
  return error instanceof Error ? error.message : 'Unknown error';
}

/** True while a ban is in force (not revoked, not expired). Orion Drift expirations are UTC without the trailing Z. */
export function isActiveBan(ban: OrionBan): boolean {
  if (ban.revoked) return false;
  if (!ban.expiration) return true;
  const expires = new Date(ban.expiration.endsWith('Z') ? ban.expiration : `${ban.expiration}Z`);
  return Number.isNaN(expires.valueOf()) || expires > new Date();
}
