# Ares Tournament Bot: website API

Read-only JSON over HTTP(S) with live tournament data. Call it from your **server**, never from visitors' browsers (the key must stay secret).

```
GET {BASE_URL}/v1/tournaments
x-api-key: <your key>
```

`{BASE_URL}` is where the bot is hosted (for example `https://api.example.com`). The bot's owner gives you the exact URL and your key.

## Rules

- Missing or wrong key → `401`. Only `GET` is allowed (`405` otherwise).
- Rate limit: about 120 requests per minute per client (`429` + `Retry-After`). Wrong keys are blocked after 10 tries a minute.
- Your key returns everything except Discord IDs and timezones; players are identified by their Meta username. `/v1/players/:username` accepts usernames only.
- List endpoints (`/tournaments`, `/matches`, `/teams`, `/players`) return a plain array. Use `?limit=` (default 100, max 500) and `?offset=`; the full count is in the `X-Total-Count` header.
- Cache responses on your server for 10 to 30 seconds instead of calling on every page view.
- Errors: `{ "error": "message" }`. Example (no key): `{"error":"missing or invalid x-api-key"}`

## Endpoints

| Route | Returns |
|---|---|
| `GET /health` | No key needed. `200`, or `503` if scoring / arena sync has not worked for 5 minutes. |
| `GET /v1/tournaments` | All tournaments, newest first. |
| `GET /v1/tournaments/:id` | One tournament plus its signed-up `teams`. |
| `GET /v1/tournaments/:id/bracket` | Every match of the tournament in bracket order. |
| `GET /v1/matches` | All matches. |
| `GET /v1/matches/:id` | One match with its `games` and arena `whitelist` status. |
| `GET /v1/teams` | All teams with captain and members. |
| `GET /v1/teams/:id` | One team. |
| `GET /v1/teams/:id/stats` | The team's record and match history. |
| `GET /v1/players` | All players. |
| `GET /v1/players/:username` | One player by Meta username. |
| `GET /v1/arenas` | Arenas and which match is in each. |

## Field notes

- Tournament `status`: `SIGNUPS`, `CLOSED`, `RUNNING`, `COMPLETE`. `format`: `SINGLE` or `DOUBLE`.
- Match `status`: `WAITING` (teams not decided), `READY` (being played), `COMPLETE`. `bracket`: `W` winners, `L` losers, `GF` grand final.
- `team1` / `team2` are `null` until known. `team1Score` / `team2Score` in `games` are in-game scores for the first / second team, and `null` for games staff entered by hand.
- A best of 3 ends when a team has 2 game wins (`bestOf` 5 → 3, 7 → 4).
- Team `history` is finished matches, newest first.

## Example responses

These were produced by running the real API against sample data (two teams of two, one game played).

### `GET /health`

```json
{
  "ok": true,
  "secondsSinceLastOk": {
    "scoring": null,
    "sync": null
  }
}
```

### `GET /v1/tournaments`

```json
[
  {
    "id": 1,
    "name": "Ares Cup",
    "region": "NA",
    "format": "SINGLE",
    "status": "RUNNING",
    "bestOf": 3,
    "maxTeams": 8,
    "minRoster": 2,
    "maxRoster": 2,
    "championTeamId": null,
    "startsAt": null,
    "createdAt": "2026-10-13 05:00:00"
  }
]
```

### `GET /v1/tournaments/1`

```json
{
  "id": 1,
  "name": "Ares Cup",
  "region": "NA",
  "format": "SINGLE",
  "status": "RUNNING",
  "bestOf": 3,
  "maxTeams": 8,
  "minRoster": 2,
  "maxRoster": 2,
  "championTeamId": null,
  "startsAt": null,
  "createdAt": "2026-10-13 05:00:00",
  "teams": [
    {
      "id": 1,
      "name": "Hybrids",
      "seed": 1,
      "status": "CONFIRMED"
    },
    {
      "id": 2,
      "name": "Rivals",
      "seed": 2,
      "status": "CONFIRMED"
    }
  ]
}
```

### `GET /v1/tournaments/1/bracket`

```json
[
  {
    "id": 1,
    "tournamentId": 1,
    "bracket": "W",
    "round": 1,
    "position": 1,
    "status": "READY",
    "bestOf": 3,
    "team1": {
      "id": 1,
      "name": "Hybrids",
      "wins": 1
    },
    "team2": {
      "id": 2,
      "name": "Rivals",
      "wins": 0
    },
    "winnerId": null,
    "arena": "Alpha 1"
  }
]
```

### `GET /v1/matches/1`

```json
{
  "id": 1,
  "tournamentId": 1,
  "bracket": "W",
  "round": 1,
  "position": 1,
  "status": "READY",
  "bestOf": 3,
  "team1": {
    "id": 1,
    "name": "Hybrids",
    "wins": 1
  },
  "team2": {
    "id": 2,
    "name": "Rivals",
    "wins": 0
  },
  "winnerId": null,
  "arena": "Alpha 1",
  "whitelist": [
    {
      "username": "Hybrid",
      "status": "GRANTED"
    }
  ],
  "games": [
    {
      "number": 1,
      "winnerId": 1,
      "team1Score": 6,
      "team2Score": 4,
      "at": "2026-10-13 06:10:00"
    }
  ]
}
```

### `GET /v1/teams/1`

```json
{
  "id": 1,
  "name": "Hybrids",
  "region": "NA",
  "createdAt": "2026-10-13 04:30:00",
  "captain": "Hybrid",
  "members": [
    {
      "username": "Hybrid"
    },
    {
      "username": "Soarvin"
    }
  ]
}
```

### `GET /v1/teams/1/stats`

```json
{
  "record": {
    "matchesWon": 0,
    "matchesLost": 0,
    "gamesWon": 1,
    "gamesLost": 0,
    "titles": 0
  },
  "history": []
}
```

### `GET /v1/players/Soarvin`

```json
{
  "username": "Soarvin",
  "region": "NA",
  "createdAt": "2026-10-13 04:00:00",
  "teamId": 1
}
```

### `GET /v1/arenas`

```json
[
  {
    "id": 1,
    "name": "Alpha 1",
    "slot": "Alpha 01",
    "enabled": 1,
    "matchId": 1
  }
]
```

## Webhooks (optional)

Instead of polling, the bot can POST an event to a URL on your server when something happens. Ask the bot's owner to enable it and give them your URL. Each request is JSON `{ "event", "at", "data" }`.

| Event | `data` fields |
|---|---|
| `game.finished` | `matchId, tournamentId, gameNumber, winnerTeamId, team1Id, team2Id, team1Wins, team2Wins, team1Score, team2Score` |
| `match.finished` | `matchId, tournamentId, winnerTeamId, team1Wins, team2Wins` |
| `tournament.started` | `tournamentId, name, teams[{id, name, seed}]` |
| `tournament.finished` | `tournamentId, championTeamId` |

Example body:

```json
{ "event": "game.finished", "at": "2026-10-13T06:10:00.000Z",
  "data": { "matchId": 1, "tournamentId": 1, "gameNumber": 1, "winnerTeamId": 1, "team1Id": 1, "team2Id": 2,
            "team1Wins": 1, "team2Wins": 0, "team1Score": 6, "team2Score": 4 } }
```

**Verify the sender:** the `x-signature` header is `sha256=` + the hex HMAC-SHA256 of the **raw request body** with the shared secret. Compare in constant time and reject mismatches. Reply `2xx` quickly; the bot retries once after 2 seconds, so a missed event is possible. Re-sync from the API now and then.
