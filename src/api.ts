import { createServer as createHttp } from 'node:http';
import { createServer as createHttps } from 'node:https';
import { readFileSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { parse } from 'dotenv';
import { db } from './db.js';
import { getMatchView, listMatchViews, type MatchView } from './services/bracket.js';
import { listGames } from './services/series.js';
import { teamHistory, teamRecord } from './services/stats.js';
import { health } from './status.js';

/**
 * Read-only JSON API for the tournament website. Every route except /health needs the header `x-api-key: <API_KEY>`.
 * Exposes the bot's data (players, teams, tournaments, matches, arenas). Never returns the bot token, Orion key or .env values.
 *
 * Keys: API_KEYS="name:key[:pii],name2:key2" (and the older single API_KEY, which counts as a "pii" key).
 * Keys without ":pii" get everything except Discord IDs and timezones, so a key used by a public website can't leak them.
 */

const PII_FIELDS = new Set(['discordId', 'captainDiscordId', 'timezone']);

function strip(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(strip);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([k]) => !PII_FIELDS.has(k)).map(([k, v]) => [k, strip(v)]));
  }
  return value;
}

const matchJson = (m: MatchView) => ({
  id: m.id, tournamentId: m.tournament_id, bracket: m.bracket, round: m.round, position: m.position, status: m.status, bestOf: m.best_of,
  team1: m.team1_id === null ? null : { id: m.team1_id, name: m.team1_name, wins: m.team1_wins },
  team2: m.team2_id === null ? null : { id: m.team2_id, name: m.team2_name, wins: m.team2_wins },
  winnerId: m.winner_id, arena: m.arena_name ?? null
});

const tournamentCols = 'id, name, region, format, status, best_of AS bestOf, max_teams AS maxTeams, min_roster AS minRoster, max_roster AS maxRoster, champion_team_id AS championTeamId, starts_at AS startsAt, created_at AS createdAt';

const playerCols = `p.user_id AS discordId, p.meta_username AS username, p.region, p.timezone, p.created_at AS createdAt,
  (SELECT tm.team_id FROM team_members tm WHERE tm.user_id = p.user_id) AS teamId`;

function teamWithMembers(id: number) {
  const team = db.prepare('SELECT t.id, t.name, t.region, t.created_at AS createdAt, t.captain_id AS captainDiscordId, (SELECT p.meta_username FROM players p WHERE p.user_id = t.captain_id) AS captain FROM teams t WHERE t.id = ?').get(id);
  if (!team) return undefined;
  const members = db.prepare('SELECT p.user_id AS discordId, p.meta_username AS username FROM team_members tm JOIN players p ON p.user_id = tm.user_id WHERE tm.team_id = ? ORDER BY tm.joined_at').all(id);
  return { ...team, members };
}

const MAX_PAGE = 500;

/** List responses are plain arrays; ?limit= (default 100, max 500) and ?offset= page through them, and X-Total-Count has the full size. */
function page(rows: unknown[], query: URLSearchParams): { status: number; body: unknown; total: number } {
  const limit = Math.min(Math.max(Number(query.get('limit')) || 100, 1), MAX_PAGE);
  const offset = Math.max(Number(query.get('offset')) || 0, 0);
  return { status: 200, body: rows.slice(offset, offset + limit), total: rows.length };
}

function route(path: string, pii: boolean, query = new URLSearchParams()): { status: number; body: unknown; total?: number } {
  const parts = path.split('/').filter(Boolean);
  if (parts[0] !== 'v1') return { status: 404, body: { error: 'not found' } };
  const [, resource, rawId, sub] = parts;
  const id = rawId === undefined ? undefined : Number(rawId);
  if (rawId !== undefined && resource !== 'players' && !Number.isInteger(id)) return { status: 400, body: { error: 'id must be a number' } };

  if (resource === 'tournaments' && id === undefined) return page(db.prepare(`SELECT ${tournamentCols} FROM tournaments ORDER BY created_at DESC`).all(), query);
  if (resource === 'tournaments') {
    const t = db.prepare(`SELECT ${tournamentCols} FROM tournaments WHERE id = ?`).get(id);
    if (!t) return { status: 404, body: { error: 'tournament not found' } };
    if (sub === 'bracket') return { status: 200, body: listMatchViews(id!).map(matchJson) };
    if (sub) return { status: 404, body: { error: 'not found' } };
    const teams = db.prepare(`SELECT t.id, t.name, r.seed, r.status FROM registrations r JOIN teams t ON t.id = r.team_id WHERE r.tournament_id = ? ORDER BY COALESCE(r.seed, 9999), t.name`).all(id);
    return { status: 200, body: { ...t, teams } };
  }
  if (resource === 'matches' && id === undefined) {
    return page(db.prepare('SELECT id FROM matches ORDER BY tournament_id, id').all().map(r => matchJson(getMatchView((r as { id: number }).id)!)), query);
  }
  if (resource === 'players') {
    if (rawId === undefined) return page(db.prepare(`SELECT ${playerCols} FROM players p ORDER BY p.meta_username`).all(), query);
    const player = db.prepare(`SELECT ${playerCols} FROM players p WHERE p.meta_username = ?${pii ? ' OR p.user_id = ?' : ''}`).get(...(pii ? [rawId, rawId] : [rawId]));
    return player ? { status: 200, body: player } : { status: 404, body: { error: 'player not found' } };
  }
  if (resource === 'arenas') {
    return { status: 200, body: db.prepare(`SELECT a.id, a.name, a.role_id AS slot, a.enabled,
      (SELECT m.id FROM matches m WHERE m.arena_id = a.id AND m.status = 'READY') AS matchId FROM arenas a ORDER BY a.id`).all() };
  }
  if (resource === 'matches' && id !== undefined) {
    const m = getMatchView(id);
    if (!m) return { status: 404, body: { error: 'match not found' } };
    return { status: 200, body: { ...matchJson(m), whitelist: db.prepare('SELECT meta_username AS username, status FROM match_whitelist WHERE match_id = ?').all(id), games: listGames(id).map(g => ({ number: g.game_number, winnerId: g.winner_id, team1Score: g.score1, team2Score: g.score2, at: g.created_at })) } };
  }
  if (resource === 'teams' && id === undefined) {
    const ids = db.prepare('SELECT id FROM teams ORDER BY name').all() as Array<{ id: number }>;
    return page(ids.map(t => teamWithMembers(t.id)), query);
  }
  if (resource === 'teams' && sub === 'stats') {
    return db.prepare('SELECT 1 FROM teams WHERE id = ?').get(id)
      ? { status: 200, body: { record: teamRecord(id!), history: teamHistory(id!) } }
      : { status: 404, body: { error: 'team not found' } };
  }
  if (resource === 'teams') {
    const team = teamWithMembers(id!);
    return team ? { status: 200, body: team } : { status: 404, body: { error: 'team not found' } };
  }
  return { status: 404, body: { error: 'not found' } };
}

export interface ApiKey { name: string; key: string; pii: boolean }

export function parseKeys(env: NodeJS.ProcessEnv): ApiKey[] {
  const keys: ApiKey[] = [];
  for (const entry of (env.API_KEYS ?? '').split(',').map(e => e.trim()).filter(Boolean)) {
    const [name, key, flag] = entry.split(':');
    if (name && key) keys.push({ name, key, pii: flag === 'pii' });
  }
  if (env.API_KEY) keys.push({ name: 'default', key: env.API_KEY, pii: true });
  return keys;
}

export function findKey(keys: ApiKey[], given: string | undefined): ApiKey | undefined {
  const a = Buffer.from(given ?? '');
  let found: ApiKey | undefined;
  for (const k of keys) { // compare against every key so timing doesn't reveal which one matched
    const b = Buffer.from(k.key);
    if (a.length === b.length && timingSafeEqual(a, b)) found = k;
  }
  return found;
}

/** Fixed-window counter per client; `hit` returns false once the client is over the limit. */
export function rateLimiter(limit: number, windowMs: number, now: () => number = Date.now) {
  const hits = new Map<string, { count: number; reset: number }>();
  return (client: string): boolean => {
    const t = now();
    const entry = hits.get(client);
    if (!entry || entry.reset <= t) {
      if (hits.size > 10_000) for (const [k, v] of hits) if (v.reset <= t) hits.delete(k);
      hits.set(client, { count: 1, reset: t + windowMs });
      return true;
    }
    return ++entry.count <= limit;
  };
}

export function createApiHandler(getKeys: ApiKey[] | (() => ApiKey[]), trustProxy = false) {
  const allow = rateLimiter(Number(process.env.API_RATE_LIMIT) || 120, 60_000); // requests per minute per client
  const allowBadAuth = rateLimiter(10, 60_000); // wrong-key attempts per minute per client
  return (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): void => {
    const started = Date.now();
    const forwarded = trustProxy ? String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() : '';
    const client = forwarded || req.socket.remoteAddress || 'unknown';
    let keyName = '-';
    const send = (status: number, body: unknown, extra: Record<string, string> = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', ...extra });
      res.end(JSON.stringify(body));
      if (req.url !== '/health') console.log(`[api] ${req.method} ${req.url?.split('?')[0]} ${status} key=${keyName} ip=${client} ${Date.now() - started}ms`);
    };
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    if (path === '/health') { const h = health(); return send(h.ok ? 200 : 503, h); }
    if (!allow(client)) return send(429, { error: 'too many requests' }, { 'Retry-After': '60' });
    if (req.method !== 'GET') return send(405, { error: 'read-only API' });
    const key = findKey(typeof getKeys === 'function' ? getKeys() : getKeys, req.headers['x-api-key'] as string | undefined);
    if (!key) return allowBadAuth(client) ? send(401, { error: 'missing or invalid x-api-key' }) : send(429, { error: 'too many failed attempts' }, { 'Retry-After': '60' });
    keyName = key.name;
    try {
      const { status, body, total } = route(path, key.pii, url.searchParams);
      send(status, key.pii ? body : strip(body), total === undefined ? {} : { 'X-Total-Count': String(total) });
    } catch (error) {
      console.error(error);
      send(500, { error: 'server error' });
    }
  };
}

function parseEnvFile(): Record<string, string> {
  return parse(readFileSync('.env'));
}

/** Starts the API when a key is configured. Port from API_PORT (default 3000); HTTPS when API_TLS_CERT and API_TLS_KEY (file paths) are set. */
export function startApi(): void {
  const keys = parseKeys(process.env);
  if (!keys.length) return;
  const port = Number(process.env.API_PORT) || 3000;
  // `kill -HUP <pid>` (or `pm2 sendSignal SIGHUP ares-bot`) re-reads API_KEYS / API_KEY from .env, so keys can be rotated without a restart.
  let current = keys;
  process.on('SIGHUP', () => {
    try {
      const fresh = parseEnvFile();
      current = parseKeys({ API_KEYS: fresh.API_KEYS, API_KEY: fresh.API_KEY } as NodeJS.ProcessEnv);
      console.log(`[api] reloaded keys: ${current.length}`);
    } catch (error) { console.error('[api] key reload failed', error); }
  });
  const handler = createApiHandler(() => current, process.env.API_TRUST_PROXY === '1');
  const tls = process.env.API_TLS_CERT && process.env.API_TLS_KEY;
  const server = tls
    ? createHttps({ cert: readFileSync(process.env.API_TLS_CERT!), key: readFileSync(process.env.API_TLS_KEY!) }, handler)
    : createHttp(handler);
  // A busy port (e.g. an old copy of the bot still running) shouldn't take the whole bot down: log it and carry on without the API.
  server.on('error', error => console.error(`[api] can't start on port ${port}: ${error.message}. The bot keeps running without the website API.`));
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.listen(port, process.env.API_HOST || '0.0.0.0', () => {
    console.log(`[api] listening on port ${port} (${tls ? 'HTTPS' : 'plain HTTP'}), ${keys.length} key(s)`);
    if (!tls && process.env.API_TRUST_PROXY !== '1') console.warn('[api] no HTTPS: put it behind an HTTPS proxy (set API_TRUST_PROXY=1) or set API_TLS_CERT / API_TLS_KEY');
  });
}
