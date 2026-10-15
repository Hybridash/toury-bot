import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApiHandler, findKey, parseKeys, rateLimiter } from './api.js';
import { db } from './db.js';
import { sign } from './webhooks.js';
import { registerPlayer } from './services/players.js';
import { createTeam } from './services/teams.js';

let server: Server;
let base = '';

beforeAll(async () => {
  registerPlayer('api-user-1', 'ApiPlayer', 'NA', 'America/Chicago');
  createTeam('api-guild', 'api-user-1', 'Api Team');
  const keys = parseKeys({ API_KEYS: 'public:pubkey,admin:adminkey:pii' } as NodeJS.ProcessEnv);
  server = createServer(createApiHandler(keys));
  await new Promise<void>(resolve => server.listen(0, resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => { server.close(); });

const get = (path: string, key?: string) => fetch(base + path, { headers: key ? { 'x-api-key': key } : {} });

describe('api keys', () => {
  it('parses named keys, the pii flag and the legacy API_KEY', () => {
    const keys = parseKeys({ API_KEYS: 'a:k1, b:k2:pii', API_KEY: 'old' } as NodeJS.ProcessEnv);
    expect(keys).toEqual([{ name: 'a', key: 'k1', pii: false }, { name: 'b', key: 'k2', pii: true }, { name: 'default', key: 'old', pii: true }]);
    expect(findKey(keys, 'k2')?.name).toBe('b');
    expect(findKey(keys, 'nope')).toBeUndefined();
    expect(findKey(keys, undefined)).toBeUndefined();
  });
});

describe('api', () => {
  it('needs a valid key, except /health', async () => {
    expect((await get('/health')).status).toBe(200);
    expect((await get('/v1/teams')).status).toBe(401);
    expect((await get('/v1/teams', 'wrong')).status).toBe(401);
    expect((await get('/v1/teams', 'pubkey')).status).toBe(200);
  });

  it('is read-only', async () => {
    expect((await fetch(base + '/v1/teams', { method: 'POST', headers: { 'x-api-key': 'adminkey' } })).status).toBe(405);
  });

  it('hides Discord IDs and timezones from keys without pii', async () => {
    const pub = await (await get('/v1/players', 'pubkey')).json() as Array<Record<string, unknown>>;
    expect(pub[0]).toMatchObject({ username: 'ApiPlayer' });
    expect(pub[0]).not.toHaveProperty('discordId');
    expect(pub[0]).not.toHaveProperty('timezone');
    const teams = JSON.stringify(await (await get('/v1/teams', 'pubkey')).json());
    expect(teams).not.toContain('api-user-1');

    const full = await (await get('/v1/players', 'adminkey')).json() as Array<Record<string, unknown>>;
    expect(full[0]).toMatchObject({ discordId: 'api-user-1', timezone: 'America/Chicago' });
  });

  it('only lets pii keys look players up by Discord ID', async () => {
    expect((await get('/v1/players/api-user-1', 'pubkey')).status).toBe(404);
    expect((await get('/v1/players/ApiPlayer', 'pubkey')).status).toBe(200);
    expect((await get('/v1/players/api-user-1', 'adminkey')).status).toBe(200);
  });

  it('rejects bad ids and unknown routes', async () => {
    expect((await get('/v1/matches/abc', 'pubkey')).status).toBe(400);
    expect((await get('/v1/tournaments/999', 'pubkey')).status).toBe(404);
    expect((await get('/nope', 'pubkey')).status).toBe(404);
    expect(db.prepare('SELECT COUNT(*) AS c FROM players').get()).toBeTruthy();
  });
});

describe('rate limiter', () => {
  it('allows the limit per window, then blocks, then resets', () => {
    let now = 0;
    const hit = rateLimiter(3, 1000, () => now);
    expect([hit('ip'), hit('ip'), hit('ip'), hit('ip')]).toEqual([true, true, true, false]);
    expect(hit('other')).toBe(true);
    now = 1001;
    expect(hit('ip')).toBe(true);
  });
});

describe('pagination and webhooks', () => {
  it('pages list endpoints with limit/offset and reports the total', async () => {
    for (let n = 0; n < 3; n++) registerPlayer(`page-${n}`, `PagePlayer${n}`, 'NA', 'UTC');
    const all = await get('/v1/players?limit=2', 'pubkey');
    expect((await all.json() as unknown[]).length).toBe(2);
    expect(Number(all.headers.get('x-total-count'))).toBeGreaterThanOrEqual(4);
    const rest = await (await get('/v1/players?limit=500&offset=2', 'pubkey')).json() as unknown[];
    expect(rest.length).toBe(Number(all.headers.get('x-total-count')) - 2);
  });

  it('signs webhook bodies so the website can verify them', () => {
    expect(sign('{"a":1}', 'secret')).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(sign('{"a":1}', 'secret')).toBe(sign('{"a":1}', 'secret'));
    expect(sign('{"a":2}', 'secret')).not.toBe(sign('{"a":1}', 'secret'));
  });
});
