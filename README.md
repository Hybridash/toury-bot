# Ares Tournament Bot

A Discord tournament bot for Orion Drift: staff-created teams, tournaments with best-of series, automatic arena whitelisting, and bans. It's built with TypeScript, discord.js v14 and SQLite.

## How it works for members

1. **Staff create teams.** `/team-admin create` takes the captain, team name, region and logo. `/team-admin add_player` puts a player straight on a team by Meta username; their Discord account is optional, so **players don't have to be in the server** (they're still whitelisted; they just can't get DMs or see match channels). `/team-admin remove_player` takes one off. Staff enter teams into tournaments with `/tournament-admin add`.
2. **Get on a team.** The captain invites you with `/team invite`; accept from the DM buttons or `/team invites`. The first time, you're asked for your Meta username.
3. **Captains manage the team** with `/team invite`, `/team kick` and `/team transfer`. Players can `/team leave`. Anyone can use `/team info`. Staff rename or disband teams with `/team-admin`.
4. **Enter a tournament.** `/tournament list` shows what's open, and staff add teams with `/tournament-admin add`.
5. **Play.** When staff start the tournament, everyone does a **ready check** by DM (players who can't be DMed are skipped, but each team needs at least one player who can click). Once all are ready, the bracket is built and both rosters are whitelisted into their arena (by Meta username), so only those two teams can join. Each match gets a **private channel** only those two teams (through their team roles) and staff can see. With an odd number of teams the top seeds get a bye. A team that's through to its next match (it won, or had a bye) gets that match's channel straight away with "waiting for Team A vs Team B to finish", and the opponent is let in when decided. Match channels are deleted when the tournament ends.
6. **Scores are automatic.** The bot reads each finished game from the arena. In a best of 3, the first team to 2 wins takes the match; the bracket updates, the arena closes, and it goes to the next match. Staff can fix a score with `/tournament-admin game` or `resolve`. `/match info` shows the series score.

### Rules the bot enforces
- One team per player per server. You can't invite players from a different region.
- Players can't change region while they're on a team.
- Signups check that the team's region matches the tournament region and that its roster size is within the tournament's limits.
- Once a tournament starts, rosters of the teams in it are locked: no invites, kicks, leaves or disbanding until it ends.
- Meta usernames and team names are unique (not case-sensitive).

## Staff (`/tournament-admin`)

Staff are members with **Manage Server** or **Administrator**, or anyone with the role set in `STAFF_ROLE_ID`.

| Command | What it does |
|---|---|
| `create` | Name, region (NA/EU/OCE/Any), single or double elimination, **best of 1/3/5/7** (default 3), max teams, min/max roster size, and optional approval of each signup |
| `deny` | Remove a team before the start |
| `close` / `reopen` | Close or reopen signups |
| `start` | Locks rosters, seeds teams (signup order or `shuffle:true`), builds the bracket and DMs the first matchups |
| `game` | Records a single game win (for disputed games) |
| `resolve` | Ends a whole match right away, for no-shows or forfeits |
| `delete` | Deletes the tournament and its bracket. Teams are kept |

Brackets work for any number of teams. If the team count isn't a power of two, the top seeds get byes, and teams with a bye move on automatically. Double elimination includes a grand-final reset if the team from the losers bracket wins the first final.

## Orion Drift: arenas, auto-whitelist, bans

Set `ORION_API_KEY` (and `ORION_FLEET_ID` for bans) in `.env`. The bot only uses the endpoints marked ✅ verified in the API docs.

### Arenas and the automatic whitelist
An **arena** is an Orion Drift fleet set to **allowlist-only**, plus the fleet role that has `fleet:join`. Add each one with `/arena add name:Arena 1 fleet_id:<fleet ID> role_id:<role ID>`. The bot checks that the fleet and role exist, and lists the fleet's roles if the role ID is wrong.

How it works for each match:
1. When a match is ready (for example Team 1 vs Team 2), the bot takes a free arena and gives that role to every player on both rosters. It uses their registered Meta username through `POST /v2/fleets/{fleet}/user_roles`.
2. Captains get a DM with the arena name. Any player who couldn't be whitelisted is listed, for example because their Meta username has no Orion Drift account. Staff can fix a wrong username in the database; the bot retries on its own.
3. When the match ends, the bot removes the role from those players (`DELETE /v1/fleets/{fleet}/users/{id}/role/{role}`) and gives the arena to the next waiting match.
4. If every arena is busy, ready matches wait in line. API errors are retried every minute.

**Important:**
- **Give each arena its own fleet.** A fleet role lets a player into the whole fleet. Two arenas sharing a fleet would let both matches into each other's arena, and the bot warns you if you set that up. The API docs show no per-station or per-district whitelist yet. If one turns up, arenas can be switched to use it.
- **Use a role that only the bot hands out.** At the end of a match, the bot removes the role from the players it added.

### Bans
- `/ban username reason hours` looks up the player's user ID, then bans them in `ORION_FLEET_ID` and in every arena fleet. Success is only reported after the API confirms it.
- `/unban username` finds the active ban in each fleet and revokes it.
- `/banlist` shows the active bans.

API errors (400/401/403/404/422/429/500) are shown to staff in plain language. Requests are logged as `[orion] METHOD path -> status`, and the API key is never logged.

## Setup

1. Install Node.js 20+ and run `npm install`.
2. Copy `.env.example` to `.env` and fill in `DISCORD_TOKEN` and `DISCORD_CLIENT_ID`. `STAFF_ROLE_ID` and `LOG_CHANNEL_ID` are optional.
3. Register the slash commands:
   - `npm run deploy:commands` registers them globally (they can take a while to show up), or
   - `npm run deploy:commands -- --guild` registers them instantly in the one server set by `DISCORD_GUILD_ID`.
4. Run `npm run dev`, or `npm run build && npm start`.

The bot only needs the **Guilds** intent (plus **Server Members Intent** toggled on in the portal for caster DMs). When you invite it, give it the `bot` and `applications.commands` scopes with **Send Messages**, **Embed Links**, **Manage Roles** and **Manage Channels**. The SQLite database is created automatically at `DATABASE_PATH`.

## Development

- `npm test` runs the bracket and flow tests (in-memory database).
- `npm run typecheck` checks the types.

```
src/
  index.ts            client + interaction router 
  commands.ts         slash command definitions
  db.ts               SQLite schema
  services/           players, teams, tournaments, bracket, reports (no Discord code)
  handlers/           one file per command group + autocomplete + shared helpers
```

## Running it for real

**Keep it online 24/7.** The bot scores games, frees arenas and serves the website API, so it must stay running. On a server (Linux VPS, etc.) with Node 24:
```
npm ci && npm run build
npm i -g pm2
pm2 start dist/index.js --name ares-bot && pm2 save && pm2 startup
```

**Backups.** The bot copies its database to `data/backups/` on start and every 6 hours, keeping the newest 14. Set `BACKUP_DIR` to put them elsewhere (ideally another disk). Copy that folder off the machine now and then.

**Ready check.** Sent only by DM. It survives bot restarts. Players with DMs closed block the start (staff are told who).

**No-show alert.** If no game finishes 15 minutes after an arena opens (`NOSHOW_MINUTES`), staff and the match thread are alerted once.

**Settings.** `/settings staff_role`, `log_channel`, `bracket_channel` (live bracket, scores, results), `match_category` (where match channels go), `casters` (admins only). These beat `STAFF_ROLE_ID` / `LOG_CHANNEL_ID` in `.env`.

**Casters.** `/settings casters role:@Caster` DMs everyone with that role: an hour before (if `starts_in_minutes` was set) with every team and roster, at the start with all first matches + arenas + byes, and then each match as it starts (round, arena, time, rosters). Add `channel:` to also ping the role there. DMing a role's members needs **Server Members Intent** switched on in the Discord Developer Portal (Bot tab); without it the bot says so in the log channel.

### Website API (read-only)
Needs a key in the `x-api-key` header. Make one with `npm run api:key -- website` (add `pii` as a second argument to include Discord IDs and timezones) and put the printed line into `API_KEYS` in `.env` (comma-separate several). The older single `API_KEY` still works and counts as a `pii` key.

| Setting | Meaning |
|---|---|
| `API_PORT` | port, default 3000 |
| `API_HOST` | address to listen on, default `0.0.0.0` (use `127.0.0.1` behind a proxy on the same machine) |
| `API_TLS_CERT`, `API_TLS_KEY` | file paths; turns on HTTPS directly |
| `API_TRUST_PROXY=1` | behind an HTTPS reverse proxy (nginx/Caddy): use its `x-forwarded-for` as the client address |
| `API_RATE_LIMIT` | requests per minute per client, default 120. Wrong keys: 10 per minute, then blocked |

Routes: `/health`, `/v1/tournaments`, `/v1/tournaments/:id`, `/v1/tournaments/:id/bracket`, `/v1/matches`, `/v1/matches/:id`, `/v1/teams`, `/v1/teams/:id`, `/v1/players`, `/v1/players/:username`, `/v1/arenas`. Call it from the website's server, never from visitors' browsers.

### Staff extras
- `/tournament-admin create … starts_in_minutes:90` posts an announcement and sends 60- and 10-minute reminders (channel + DM to every signed-up player).
- `/tournament-admin disqualify` removes a team from a running tournament; its current and later matches are forfeited and opponents advance.
- `/tournament-admin rescore match:<id>` re-reads a live match's arena results and records any missed games (safe to run twice).
- Banned players (Orion Drift bans in `ORION_FLEET_ID`) can't sign up, and block the ready check until their team is swapped. If Orion Drift is unreachable, nobody is blocked.
- Changing a Meta username mid-match rewrites that match's arena whitelist.
- Per-game scores are stored; `/team info` shows a team's record; the API has `/v1/teams/:id/stats`.
- Background failures (arena sync, scoring, reminders) are posted to the staff log channel. `GET /health` returns 503 if scoring or arena sync hasn't succeeded for 5 minutes, so you can point an uptime monitor at it.

### More staff tools
- `/tournament-admin undo_game match:<id>` removes the latest recorded game (and reopens a finished match while the next round hasn't started).
- Players can press **Dispute this result** under a game result: scoring pauses for that match and staff are alerted. `undo_game`, `game`, `resolve` or `rescore` ends the pause.
- `/tournament-admin start … seed_by:Past record` seeds by match wins then game difference.
- `/settings check` (also run at startup) lists anything missing in the setup.
- Backups: set `BACKUP_COPY_DIR` to also copy each backup to another disk or a synced folder.
- Rotate website keys without restarting: edit `API_KEYS` in `.env`, then `kill -HUP <pid>` (pm2: `pm2 sendSignal SIGHUP ares-bot`).
- Website docs for the dev: `docs/API.md`. Optional push events: `WEBHOOK_URL` + `WEBHOOK_SECRET`.
