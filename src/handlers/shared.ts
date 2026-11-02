import { randomUUID } from 'node:crypto';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, PermissionFlagsBits, type ButtonInteraction, type ChatInputCommandInteraction, type Client, type EmbedBuilder, type Interaction, type SendableChannels } from 'discord.js';
import { getTournamentById } from '../services/tournaments.js';
import { Colors, EPHEMERAL, UserError, isStaff, notice } from '../util.js';
import { getMatchView, listMatchViews, isByeMatch, roundTitle, type MatchView } from '../services/bracket.js';
import { getMembers, getTeamById } from '../services/teams.js';
import { casterChannelId, casterRoleId, logChannelId, matchCategoryId, staffRoleId } from '../services/settings.js';
import { onDiscord, who } from '../services/players.js';
import { syncTeamRoles } from './roles.js';
import { pollScores, type ScoredGame } from '../services/scoring.js';
import { emit } from '../webhooks.js';
import { markOk } from '../status.js';
import { forfeitDisqualified, listGames } from '../services/series.js';
import { syncArenas, type ReadyEvent } from '../services/arenas.js';
import { winsNeeded } from '../services/series.js';
import type { Tournament } from '../services/tournaments.js';
import { db } from '../db.js';

// ---- Confirmations -------------------------------------------------------

type Pending = { userId: string; run: (button: ButtonInteraction) => Promise<void> };
const pendingConfirmations = new Map<string, Pending>();

export async function askConfirm(i: ChatInputCommandInteraction, title: string, description: string, run: Pending['run'], confirmLabel = 'Confirm'): Promise<void> {
  const token = randomUUID();
  pendingConfirmations.set(token, { userId: i.user.id, run });
  setTimeout(() => pendingConfirmations.delete(token), 5 * 60_000).unref();
  await i.reply({
    embeds: [notice(title, description, Colors.warning)],
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`confirm:yes:${token}`).setLabel(confirmLabel).setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`confirm:no:${token}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary)
    )],
    flags: EPHEMERAL
  });
}

export async function handleConfirmButton(button: ButtonInteraction, action: string, token: string): Promise<void> {
  const pending = pendingConfirmations.get(token);
  if (!pending) throw new UserError('That confirmation expired. Run the command again.');
  if (pending.userId !== button.user.id) throw new UserError('That button isn’t for you.');
  pendingConfirmations.delete(token);
  if (action === 'no') {
    await button.update({ embeds: [notice('Cancelled', 'Nothing was changed.', Colors.muted)], components: [] });
    return;
  }
  // Answer the click right away: the work can take longer than Discord's 3 seconds, and may delete the channel
  // the prompt is in (e.g. deleting a tournament from a match channel), so the final edit is best effort.
  await button.deferUpdate();
  button.update = ((options: Parameters<ButtonInteraction['update']>[0]) => button.editReply(options as never).catch(() => null)) as never;
  await pending.run(button);
}

// ---- Staff ---------------------------------------------------------------

export function requireStaff(i: Interaction): void {
  if (!isStaff(i, staffRoleId())) throw new UserError('Only tournament staff can do that.');
}

export function staffCheck(i: Interaction): boolean {
  return isStaff(i, staffRoleId());
}

// ---- Logging + DMs --------------------------------------------------------

export async function logEvent(client: Client, title: string, description: string, color: number = Colors.info): Promise<void> {
  const logId = logChannelId();
  if (!logId) return;
  const channel = await client.channels.fetch(logId).catch(() => null);
  if (channel?.isSendable()) await channel.send({ embeds: [notice(title, description, color).setTimestamp()], allowedMentions: { parse: [] } }).catch(() => null);
}

export async function dm(client: Client, userId: string, payload: { embeds: EmbedBuilder[]; components?: ActionRowBuilder<ButtonBuilder>[] }): Promise<boolean> {
  if (!onDiscord(userId)) return false;
  const user = await client.users.fetch(userId).catch(() => null);
  if (!user) return false;
  return user.send(payload).then(() => true).catch(() => false);
}

/**
 * Frees arenas from finished matches, gives free arenas to ready matches (whitelisting both
 * teams in Orion Drift), and DMs both captains once their match is playable.
 * Call this after anything that changes the bracket. Also runs on a timer to retry failures.
 */
export async function notifyReadyMatches(client: Client): Promise<void> {
  // Disqualified teams forfeit any match that becomes ready; a forfeit can ready the next one, so do this first.
  const forfeits = forfeitDisqualified();
  for (const f of forfeits) {
    const names = db.prepare('SELECT (SELECT name FROM teams WHERE id = ?) AS w, (SELECT name FROM teams WHERE id = ?) AS l').get(f.winnerId, f.loserId) as { w: string | null; l: string | null };
    await logEvent(client, 'Forfeit', `Match #${f.matchId}: **${names.l ?? 'a disqualified team'}** forfeits, **${names.w}** advances.`, Colors.warning);
  }
  for (const tid of new Set(forfeits.map(f => f.tournamentId))) {
    await announceChampionIfDone(client, tid, (db.prepare('SELECT channel_id AS c FROM tournaments WHERE id = ?').get(tid) as { c: string | null }).c);
  }
  await announceEvents(client, await syncArenas());
  markOk('sync');
  await openWaitingRooms(client);
  await archiveFinishedThreads(client);
  await refreshBrackets(client);
}

// ---- Match channels ----------------------------------------------------------

const MATCH_ACCESS = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory];
const creating = new Set<number>();
const channelWarned = new Set<number>();

function discordPlayers(...teamIds: Array<number | null>): string[] {
  return teamIds.flatMap(id => (id === null ? [] : getMembers(id).map(m => m.userId))).filter(onDiscord);
}

/**
 * Private channel per match: only the teams in it (through their team role), staff and the bot can see it.
 * Made as soon as the first team is known (so a team that is through can wait there); the second team is
 * let in when it arrives. Stored in matches.thread_id.
 */
async function ensureMatchChannel(client: Client, view: MatchView): Promise<SendableChannels | null> {
  const { threadId, channelId } = matchTargets(view.id);
  const teamIds = [view.team1_id, view.team2_id].filter((id): id is number => id !== null);
  for (const id of teamIds) await syncTeamRoles(client, id);
  const roleIds = [...teamIds.map(id => getTeamById(id)?.roleId), staffRoleId()].filter((id): id is string => Boolean(id));
  const name = `match-${view.id}-${view.team1_name ?? 'tbd'}-vs-${view.team2_name ?? 'tbd'}`.slice(0, 100);

  const existing = threadId ? await client.channels.fetch(threadId).catch(() => null) : null;
  if (existing?.type === ChannelType.GuildText) {
    for (const id of roleIds) await existing.permissionOverwrites.edit(id, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true }).catch(() => null);
    await existing.setName(name).catch(() => null);
    return existing;
  }
  if (existing?.isSendable()) return existing; // a thread from an older version of the bot
  if (creating.has(view.id)) return null;
  creating.add(view.id);
  try {
    const guild = await client.guilds.fetch(view.guild_id).catch(() => null);
    if (!guild || !client.user) return null;
    const home = channelId ? await client.channels.fetch(channelId).catch(() => null) : null;
    const parent = matchCategoryId() ?? (home && 'parentId' in home ? home.parentId : null);
    const channel = await guild.channels.create({
      name, type: ChannelType.GuildText, parent: parent ?? undefined, reason: `Match #${view.id}`,
      permissionOverwrites: [
        { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
        { id: client.user.id, allow: [...MATCH_ACCESS, PermissionFlagsBits.ManageChannels] },
        ...roleIds.map(id => ({ id, allow: MATCH_ACCESS }))
      ]
    }).catch(error => { console.error('[match channel]', error instanceof Error ? error.message : error); return null; });
    if (!channel) {
      if (channelWarned.has(view.id)) return null; // retried every minute; tell staff once
      channelWarned.add(view.id);
      await logEvent(client, 'Couldn’t create a match channel', `Match #${view.id}: give the bot **Manage Channels** and **Manage Roles** (and access to the match category).`, Colors.warning);
      return null;
    }
    db.prepare('UPDATE matches SET thread_id = ? WHERE id = ?').run(channel.id, view.id);
    return channel;
  } finally {
    creating.delete(view.id);
  }
}

/** The arena is open: let both teams into the match channel and tell them where to play. */
async function postMatchStart(client: Client, view: MatchView, arenaName: string): Promise<void> {
  const channel = await ensureMatchChannel(client, view);
  const offDiscord = [view.team1_id, view.team2_id].flatMap(id => (id === null ? [] : getMembers(id))).filter(m => !onDiscord(m.userId)).map(m => m.metaUsername);
  await channel?.send({
    content: discordPlayers(view.team1_id, view.team2_id).map(id => `<@${id}>`).join(' ') || undefined,
    embeds: [notice(`Match #${view.id} — ${view.team1_name} vs ${view.team2_name}`,
      `🏟️ **Arena: ${arenaName}**\nBoth rosters are whitelisted, so only your two teams can get in. ${view.best_of === 1 ? 'One game.' : `Best of ${view.best_of} (first to ${winsNeeded(view.best_of)}).`}`
      + `${offDiscord.length ? `\nAlso whitelisted (not on Discord): ${offDiscord.join(', ')}` : ''}\nScores are tracked automatically; call staff here if something goes wrong.`, Colors.success)]
  }).catch(() => null);
}

/** The match that will fill the empty side of `view`, if any. */
function feederFor(view: MatchView): MatchView | undefined {
  const slot = view.team1_id === null ? 1 : 2;
  const row = db.prepare('SELECT id FROM matches WHERE (next_win_id = ? AND next_win_slot = ?) OR (next_lose_id = ? AND next_lose_slot = ?) LIMIT 1')
    .get(view.id, slot, view.id, slot) as { id: number } | undefined;
  return row ? getMatchView(row.id) : undefined;
}

/**
 * A team is through to its next match (it won, or had a bye) but the opponent isn't known yet:
 * open the match channel for it now and say which match it is waiting on.
 */
export async function openWaitingRooms(client: Client): Promise<void> {
  const rows = db.prepare(`SELECT m.id FROM matches m JOIN tournaments t ON t.id = m.tournament_id
    WHERE t.status = 'RUNNING' AND m.status = 'WAITING' AND m.thread_id IS NULL AND (m.team1_id IS NULL) != (m.team2_id IS NULL)`).all() as Array<{ id: number }>;
  for (const { id } of rows) {
    const view = getMatchView(id);
    if (!view) continue;
    const channel = await ensureMatchChannel(client, view);
    if (!channel) continue;
    const team = view.team1_name ?? view.team2_name;
    const feeder = feederFor(view);
    const waitingOn = !feeder ? 'your opponent'
      : feeder.team1_id !== null && feeder.team2_id !== null ? `**${feeder.team1_name} vs ${feeder.team2_name}** (match #${feeder.id})`
      : `the winner of match #${feeder.id}`;
    await channel.send({
      content: discordPlayers(view.team1_id ?? view.team2_id).map(u => `<@${u}>`).join(' ') || undefined,
      embeds: [notice(`⏳ ${team} — waiting for your next match`,
        `You’re through to match #${view.id}. Waiting for ${waitingOn} to finish.\nYou’ll get your arena here the moment your opponent is decided — no need to do anything.`, Colors.info)]
    }).catch(() => null);
  }
}

export async function announceEvents(client: Client, events: ReadyEvent[], opts: { casters?: boolean } = {}): Promise<void> {
  for (const event of events) {
    const view = getMatchView(event.matchId);
    if (!view) continue;
    const one = getTeamById(view.team1_id!), two = getTeamById(view.team2_id!);
    if (event.queued) {
      const text = `**${view.team1_name}** vs **${view.team2_name}** in **${view.tournament_name}** is ready, but every arena is busy. You’ll get another DM the moment one opens — no need to do anything.`;
      for (const userId of discordPlayers(view.team1_id, view.team2_id)) await dm(client, userId, { embeds: [notice(`Match #${view.id} is waiting for an arena`, text, Colors.warning)] });
      await logEvent(client, 'Match waiting for an arena', `Match #${view.id} (**${view.team1_name}** vs **${view.team2_name}**) has no free arena. Add more with \`/arena seed\`, or finish/delete whatever is using them (\`/arena list\`).`, Colors.warning);
      continue;
    }
    const needed = winsNeeded(view.best_of);
    const arenaLine = event.arenaName
      ? `\n🏟️ **Arena: ${event.arenaName}** — everyone on both rosters has been whitelisted, so only you two teams can get in.`
      : '';
    const failLine = event.failures.length
      ? `\n⚠️ Couldn’t whitelist: ${event.failures.map(f => `${who(f.userId)} (${f.metaUsername}) — ${f.reason}`).join('; ')}`
      : '';
    for (const [mine, theirs] of [[one, two], [two, one]] as const) {
      if (!mine || !theirs) continue;
      for (const userId of discordPlayers(mine.id)) await dm(client, userId, { embeds: [notice(
        `Match #${view.id} is ready`,
        `**${mine.name}** vs **${theirs.name}** in **${view.tournament_name}** — ${view.best_of === 1 ? 'one game' : `best of ${view.best_of} (first to ${needed} wins)`}.`
        + `${arenaLine}\nTheir captain is <@${theirs.captainId}>. Scores are tracked automatically.${failLine}`,
        event.failures.length ? Colors.warning : Colors.success)] });
    }
    for (const f of event.failures) {
      await dm(client, f.userId, { embeds: [notice('⚠️ Check your Meta username', `You couldn’t be whitelisted into ${event.arenaName ? `**${event.arenaName}**` : 'your arena'} for match #${view.id} (**${view.team1_name}** vs **${view.team2_name}**): `
        + `there’s no Orion Drift account called **${f.metaUsername}**.\nMake sure your Meta username is exactly right. If you can’t get into the arena, fix it with \`/player edit meta_username:<your exact Meta username>\` and you’ll be let in automatically within a minute.`, Colors.warning)] });
    }
    if (event.arenaName) {
      await postMatchStart(client, view, event.arenaName);
      if (opts.casters !== false) await pingCasters(client, view.guild_id, `🎙️ Match #${view.id} is starting — ${view.team1_name} vs ${view.team2_name}`, matchBrief(view, event.arenaName));
      await logEvent(client, 'Arena assigned', `Match #${view.id} (**${view.team1_name}** vs **${view.team2_name}**) → **${event.arenaName}**.${failLine}`,
        event.failures.length ? Colors.warning : Colors.info);
    }
  }
}

// ---- Casters ---------------------------------------------------------------

let casterListWarned = false;

/** Everyone with the caster role. Listing members needs the Server Members intent switched on in the Developer Portal. */
async function casterIds(client: Client, guildId: string, roleId: string): Promise<string[]> {
  const guild = await client.guilds.fetch(guildId).catch(() => null);
  const ids: string[] = [];
  try {
    for (let after = '0'; guild;) {
      const page = await guild.members.list({ limit: 1000, after });
      for (const m of page.values()) if (m.roles.cache.has(roleId)) ids.push(m.id);
      if (page.size < 1000) break;
      after = page.lastKey()!;
    }
  } catch (error) {
    if (!casterListWarned) {
      casterListWarned = true;
      await logEvent(client, 'Can’t DM casters', 'I can’t list who has the caster role. Turn on **Server Members Intent** for the bot in the Discord Developer Portal (Bot tab). Until then casters only get the channel ping, if one is set.', Colors.warning);
    }
    console.error('[casters]', error instanceof Error ? error.message : error);
  }
  return ids;
}

/** DMs everyone with the caster role, and pings the role in the caster channel if one is set. Does nothing until `/settings casters` is set. */
export async function pingCasters(client: Client, guildId: string, title: string, text: string): Promise<void> {
  const roleId = casterRoleId();
  if (!roleId) return;
  const embed = notice(title, text.slice(0, 4000), Colors.info);
  for (const id of await casterIds(client, guildId, roleId)) await dm(client, id, { embeds: [embed] });
  const channel = await channelOf(client, casterChannelId());
  await channel?.send({ content: `<@&${roleId}>`, embeds: [embed], allowedMentions: { roles: [roleId] } }).catch(() => null);
}

/** Sent to casters when the bracket is built: every first match with its arena, plus byes. */
export function castersSchedule(tournament: Tournament): string {
  const matches = listMatchViews(tournament.id);
  const playing = matches.filter(m => m.status === 'READY').map(m => `\`#${m.id}\` **${m.team1_name}** vs **${m.team2_name}** — ${m.arena_name ? `🏟️ ${m.arena_name}` : 'waiting for a free arena'}`);
  const byes = matches.filter(m => m.bracket === 'W' && m.round === 1 && isByeMatch(m) && m.winner_id !== null).map(m => `**${getTeamById(m.winner_id!)?.name}**`);
  return `**${tournament.name}** started <t:${Math.floor(Date.now() / 1000)}:t> • ${tournament.bestOf === 1 ? 'one game per match' : `best of ${tournament.bestOf}`}`
    + `\n\n**Playing now**\n${playing.join('\n') || '—'}${byes.length ? `\n\n**Byes (straight to round 2):** ${byes.join(', ')}` : ''}`
    + `\n\nYou’ll get a DM as each later match starts, with its round, arena and rosters.\n📊 ${bracketLink(tournament.id, tournament.guildId)}`;
}

function rosterLines(teamId: number | null): string {
  if (teamId === null) return 'TBD';
  const team = getTeamById(teamId);
  return getMembers(teamId).map(m => `${m.userId === team?.captainId ? '👑' : '•'} ${m.metaUsername ?? '(no Meta username)'}${onDiscord(m.userId) ? ` (<@${m.userId}>)` : ''}`).join('\n') || '*no players*';
}

function bracketLink(tournamentId: number, guildId: string): string {
  const t = db.prepare('SELECT channel_id AS c, bracket_message_id AS m FROM tournaments WHERE id = ?').get(tournamentId) as { c: string | null; m: string | null } | undefined;
  return t?.c && t.m ? `[Live bracket](https://discord.com/channels/${guildId}/${t.c}/${t.m})` : '`/tournament bracket`';
}

/** Everything a caster needs: tournament, round, arena, format, both rosters, where the bracket is. */
export function matchBrief(view: MatchView, arenaName: string): string {
  const startedAt = `<t:${Math.floor(Date.now() / 1000)}:t>`;
  const maxRound = (db.prepare('SELECT MAX(round) AS r FROM matches WHERE tournament_id = ? AND bracket = ?').get(view.tournament_id, view.bracket) as { r: number }).r;
  return `**${view.tournament_name}** — ${roundTitle(view, view.format, maxRound)}\n🏟️ **Arena:** ${arenaName}\n🕒 **Starting:** ${startedAt}\n🎮 ${view.best_of === 1 ? 'One game' : `Best of ${view.best_of} (first to ${winsNeeded(view.best_of)})`}`
    + `\n\n**${view.team1_name}**\n${rosterLines(view.team1_id)}\n\n**${view.team2_name}**\n${rosterLines(view.team2_id)}\n\n📊 ${bracketLink(view.tournament_id, view.guild_id)}`;
}

// ---- Automatic scoring ----------------------------------------------------

let polling = false;
let scoringFailures = 0;
const NOSHOW_MINUTES = Number(process.env.NOSHOW_MINUTES) || 15;

async function channelOf(client: Client, id: string | null | undefined) {
  const channel = id ? await client.channels.fetch(id).catch(() => null) : null;
  return channel?.isSendable() ? channel : null;
}

function matchTargets(matchId: number): { threadId: string | null; channelId: string | null } {
  return (db.prepare('SELECT m.thread_id AS threadId, t.channel_id AS channelId FROM matches m JOIN tournaments t ON t.id = m.tournament_id WHERE m.id = ?')
    .get(matchId) as { threadId: string | null; channelId: string | null } | undefined) ?? { threadId: null, channelId: null };
}

/** Posts one recorded game to the match thread (and the main channel when the series ends), then moves the bracket on. */
export async function announceGame(client: Client, game: ScoredGame): Promise<void> {
  const view = getMatchView(game.matchId);
  if (!view) return;
  const winner = game.winnerId === view.team1_id ? view.team1_name : view.team2_name;
  const score = `**${view.team1_name}** ${game.state.team1Wins} – ${game.state.team2Wins} **${view.team2_name}**`;
  const last = listGames(game.matchId).at(-1);
  const inGame = last?.score1 != null ? ` (${last.score1}–${last.score2} in game)` : '';
  const text = game.state.finished
    ? `Game ${game.state.gamesPlayed}: **${winner}** wins${inGame}.\n${score}\n🏅 **${winner}** wins${view.best_of > 1 ? ' the series' : ''} and moves on!`
    : `Game ${game.state.gamesPlayed}: **${winner}** wins${inGame}.\nSeries: ${score} (first to ${game.state.winsNeeded}).`;
  const { threadId, channelId } = matchTargets(game.matchId);
  const embed = { embeds: [notice(`Match #${view.id}`, text, Colors.success)], allowedMentions: { parse: [] as never[] } };
  const withDispute = { ...embed, components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`dispute:yes:${view.id}`).setLabel('Dispute this result').setStyle(ButtonStyle.Secondary))] };
  await (await channelOf(client, threadId ?? channelId))?.send(threadId ? withDispute : embed).catch(() => null);
  void emit('game.finished', { matchId: view.id, tournamentId: view.tournament_id, gameNumber: game.state.gamesPlayed, winnerTeamId: game.winnerId,
    team1Id: view.team1_id, team2Id: view.team2_id, team1Wins: game.state.team1Wins, team2Wins: game.state.team2Wins, team1Score: last?.score1 ?? null, team2Score: last?.score2 ?? null });
  if (game.state.finished) {
    void emit('match.finished', { matchId: view.id, tournamentId: view.tournament_id, winnerTeamId: game.winnerId, team1Wins: game.state.team1Wins, team2Wins: game.state.team2Wins });
    if (threadId) await (await channelOf(client, channelId))?.send(embed).catch(() => null); // also tell the main channel
    await logEvent(client, 'Match result', `Match #${view.id}: ${score} — **${winner}** advances.`, Colors.success);
    await notifyReadyMatches(client);
    await announceChampionIfDone(client, view.tournament_id, channelId);
  }
}

/** Reads finished games from Orion Drift, records them, and tells the match thread / staff. Runs on a timer. */
export async function scoreFinishedGames(client: Client): Promise<void> {
  if (polling) return;
  polling = true;
  try {
    const { games, draws, failed } = await pollScores();
    if (failed) {
      if (++scoringFailures === 5) await logEvent(client, 'Scoring is down', 'I can’t reach Orion Drift to read game results (5 tries in a row). Scores will catch up when it’s back; staff can also use `/tournament-admin rescore`.', Colors.danger);
    } else {
      scoringFailures = 0;
      markOk('scoring');
    }
    for (const game of games) await announceGame(client, game);
    for (const matchId of new Set(draws)) {
      const view = getMatchView(matchId);
      if (!view || view.status !== 'READY') continue;
      const { threadId, channelId } = matchTargets(matchId);
      const text = 'A game ended in a **draw**, so it wasn’t counted. Replay it, or call staff to set the result.';
      await (await channelOf(client, threadId ?? channelId))?.send({ embeds: [notice(`Match #${matchId}`, text, Colors.warning)] }).catch(() => null);
      await logEvent(client, 'Game drawn', `Match #${matchId} (**${view.team1_name}** vs **${view.team2_name}**): ${text}`, Colors.warning);
    }
    if (games.length) await refreshBrackets(client);
    await alertNoShows(client);
  } finally {
    polling = false;
  }
}

/** One alert per match: it has had an arena for a while and nobody has finished a game. */
async function alertNoShows(client: Client): Promise<void> {
  const cutoff = new Date(Date.now() - NOSHOW_MINUTES * 60_000).toISOString();
  const rows = db.prepare(`SELECT id FROM matches WHERE status = 'READY' AND arena_id IS NOT NULL AND noshow_alerted = 0
    AND team1_wins + team2_wins = 0 AND arena_assigned_at < ?`).all(cutoff) as Array<{ id: number }>;
  for (const { id } of rows) {
    db.prepare('UPDATE matches SET noshow_alerted = 1 WHERE id = ?').run(id);
    const view = getMatchView(id);
    if (!view) continue;
    const text = `No game has finished in match #${id} (**${view.team1_name}** vs **${view.team2_name}**, ${view.arena_name}) ${NOSHOW_MINUTES} minutes after the arena opened. Is a team missing? Staff can end it with \`/tournament-admin resolve\`.`;
    await logEvent(client, 'Possible no-show', text, Colors.warning);
    const { threadId } = matchTargets(id);
    await (await channelOf(client, threadId))?.send({ embeds: [notice('Is everyone here?', `It’s been ${NOSHOW_MINUTES} minutes and no game has finished yet. Staff have been told.`, Colors.warning)] }).catch(() => null);
  }
}

// ---- Cleanup ---------------------------------------------------------------

/** Archives the private thread of every finished match. */
async function archiveFinishedThreads(client: Client): Promise<void> {
  const rows = db.prepare("SELECT id, thread_id AS threadId FROM matches WHERE status = 'COMPLETE' AND thread_id IS NOT NULL AND thread_archived = 0").all() as Array<{ id: number; threadId: string }>;
  for (const row of rows) {
    const thread = await client.channels.fetch(row.threadId).catch(() => null);
    if (thread?.isThread() && !thread.archived) await thread.setArchived(true).catch(() => null);
    db.prepare('UPDATE matches SET thread_archived = 1 WHERE id = ?').run(row.id);
  }
}

/**
 * Deletes the tournament role (once) and the match channels (old-style threads are archived).
 * With `destroy` (tournament being deleted) the live bracket message is deleted too.
 */
export async function cleanupTournament(client: Client, tournamentId: number, destroy = false): Promise<void> {
  const t = db.prepare('SELECT guild_id AS guildId, role_id AS roleId, channel_id AS channelId, bracket_message_id AS bracketId FROM tournaments WHERE id = ?').get(tournamentId) as
    { guildId: string; roleId: string | null; channelId: string | null; bracketId: string | null } | undefined;
  if (!t) return;
  if (t.roleId) {
    const guild = await client.guilds.fetch(t.guildId).catch(() => null);
    await guild?.roles.delete(t.roleId, 'Tournament finished').catch(() => null);
    db.prepare('UPDATE tournaments SET role_id = NULL WHERE id = ?').run(tournamentId);
  }
  const threads = db.prepare('SELECT thread_id AS threadId FROM matches WHERE tournament_id = ? AND thread_id IS NOT NULL').all(tournamentId) as Array<{ threadId: string }>;
  for (const { threadId } of threads) {
    const thread = await client.channels.fetch(threadId).catch(() => null);
    if (destroy || (thread && !thread.isThread())) await thread?.delete(destroy ? 'Tournament deleted' : 'Tournament finished').catch(() => null);
    else if (thread?.isThread() && !thread.archived) await thread.setArchived(true).catch(() => null);
  }
  if (destroy && t.channelId && t.bracketId) {
    const channel = await client.channels.fetch(t.channelId).catch(() => null);
    const message = channel?.isTextBased() ? await channel.messages.fetch(t.bracketId).catch(() => null) : null;
    await message?.delete().catch(() => null);
  }
}

// ---- Live bracket message ---------------------------------------------------

const lastBracket = new Map<number, string>();

/** A message holds 10 embeds. For a huge bracket, show the first 9 and point to /tournament bracket for the rest. */
export function fitOneMessage(embeds: EmbedBuilder[]): EmbedBuilder[] {
  if (embeds.length <= 10) return embeds;
  return [...embeds.slice(0, 9), notice('Bracket too big for one message', 'Use `/tournament bracket` to see every round.', Colors.muted)];
}

/** The bracket is posted once when a tournament starts; this keeps that one message up to date. */
export async function refreshBrackets(client: Client): Promise<void> {
  const rows = db.prepare("SELECT id, channel_id AS channelId, bracket_message_id AS messageId, status FROM tournaments WHERE bracket_message_id IS NOT NULL AND channel_id IS NOT NULL")
    .all() as Array<{ id: number; channelId: string; messageId: string; status: string }>;
  for (const row of rows) {
    const t = getTournamentById(row.id);
    if (!t) continue;
    const embeds = fitOneMessage(bracketEmbeds(t));
    const fingerprint = JSON.stringify(embeds.map(e => e.toJSON()));
    if (lastBracket.get(row.id) === fingerprint) continue;
    const channel = await client.channels.fetch(row.channelId).catch(() => null);
    const message = channel?.isTextBased() ? await channel.messages.fetch(row.messageId).catch(() => null) : null;
    if (!message) { db.prepare('UPDATE tournaments SET bracket_message_id = NULL WHERE id = ?').run(row.id); continue; }
    await message.edit({ embeds, allowedMentions: { parse: [] } }).catch(() => null);
    lastBracket.set(row.id, fingerprint);
    if (row.status === 'COMPLETE') db.prepare('UPDATE tournaments SET bracket_message_id = NULL WHERE id = ?').run(row.id); // final state shown, stop editing
  }
}

// ---- Bracket display ------------------------------------------------------

function sideName(match: MatchView, slot: 1 | 2): string {
  const id = slot === 1 ? match.team1_id : match.team2_id;
  const name = slot === 1 ? match.team1_name : match.team2_name;
  if (id === null) return 'TBD';
  return name ?? '(disbanded team)';
}

function matchLine(match: MatchView): string {
  const a = sideName(match, 1), b = sideName(match, 2);
  if (match.status === 'COMPLETE' && match.winner_id !== null) {
    const aWon = match.winner_id === match.team1_id;
    const score = match.score1 !== null ? ` ${match.score1}–${match.score2}` : '';
    return `\`#${match.id}\` ${aWon ? `**${a}**` : `~~${a}~~`} vs ${aWon ? `~~${b}~~` : `**${b}**`}${score}`;
  }
  if (match.status !== 'READY') return `\`#${match.id}\` ${a} vs ${b}${(match.team1_id === null) !== (match.team2_id === null) ? ' — ⏳ waiting' : ''}`;
  const series = match.best_of > 1 ? ` (${match.team1_wins}–${match.team2_wins})` : '';
  return `\`#${match.id}\` ${a} vs ${b}${series} — ⚔️ ${match.arena_name ? `playing in ${match.arena_name}` : 'ready'}`;
}

/** Returns one or more messages' worth of embeds, each safely under Discord's limits. */
export function bracketEmbeds(tournament: Tournament): EmbedBuilder[] {
  const matches = listMatchViews(tournament.id);
  const maxRound = { W: 0, L: 0, GF: 0 };
  for (const m of matches) maxRound[m.bracket] = Math.max(maxRound[m.bracket], m.round);

  const sections: Array<{ title: string; lines: string[] }> = [];
  for (const m of matches) {
    if (isByeMatch(m)) continue;
    const title = roundTitle(m, tournament.format, maxRound[m.bracket]);
    const section = sections.at(-1);
    if (section?.title === title) section.lines.push(matchLine(m));
    else sections.push({ title, lines: [matchLine(m)] });
  }

  const champion = tournament.championTeamId ? getTeamById(tournament.championTeamId)?.name ?? '(disbanded team)' : null;
  const header = `${tournament.format === 'DOUBLE' ? 'Double' : 'Single'} elimination • ${tournament.region === 'ANY' ? 'Any region' : tournament.region}`
    + (champion ? `\n🏆 **Champion: ${champion}**` : '');

  const embeds: EmbedBuilder[] = [];
  let current = notice(`${tournament.name} — Bracket`, header, champion ? Colors.success : Colors.info);
  let size = header.length + 60, fields = 0;
  const push = (name: string, value: string) => {
    if (fields >= 24 || size + name.length + value.length > 5500) {
      embeds.push(current);
      current = notice(`${tournament.name} — Bracket (cont.)`, '​', Colors.info);
      size = 80; fields = 0;
    }
    current.addFields({ name, value });
    size += name.length + value.length; fields++;
  };
  for (const section of sections) {
    let chunk: string[] = [];
    let part = 0;
    for (const line of section.lines) {
      if ([...chunk, line].join('\n').length > 1000) {
        push(part++ ? `${section.title} (cont.)` : section.title, chunk.join('\n'));
        chunk = [];
      }
      chunk.push(line);
    }
    if (chunk.length) push(part ? `${section.title} (cont.)` : section.title, chunk.join('\n'));
  }
  if (!sections.length) current.addFields({ name: 'Matches', value: 'The bracket hasn’t been made yet.' });
  embeds.push(current);
  return embeds;
}

export async function announceChampionIfDone(client: Client, tournamentId: number, channelId: string | null): Promise<string | null> {
  const row = db.prepare('SELECT name, status, champion_team_id FROM tournaments WHERE id = ?').get(tournamentId) as { name: string; status: string; champion_team_id: number | null } | undefined;
  if (!row || row.status !== 'COMPLETE' || row.champion_team_id === null) return null;
  const champ = getTeamById(row.champion_team_id);
  const text = `🏆 **${champ?.name ?? 'The winning team'}** won **${row.name}**! GG to every team that played.`;
  void emit('tournament.finished', { tournamentId, championTeamId: row.champion_team_id });
  await logEvent(client, 'Tournament finished', text, Colors.success);
  await refreshBrackets(client);
  await cleanupTournament(client, tournamentId);
  if (channelId) {
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (channel?.isSendable()) await channel.send({ embeds: [notice('Tournament finished', text, Colors.success)] }).catch(() => null);
  }
  return text;
}

// ---- Reminders + background safety ------------------------------------------

const REMINDERS = [{ minutes: 60, bit: 1 }, { minutes: 10, bit: 2 }];

/** DMs every player (and posts in the tournament channel) 60 and 10 minutes before a tournament's planned start. */
export async function sendReminders(client: Client): Promise<void> {
  const rows = db.prepare("SELECT id, guild_id AS guildId, name, channel_id AS channelId, starts_at AS startsAt, reminded FROM tournaments WHERE starts_at IS NOT NULL AND status IN ('SIGNUPS', 'CLOSED')")
    .all() as Array<{ id: number; guildId: string; name: string; channelId: string | null; startsAt: number; reminded: number }>;
  for (const t of rows) {
    const minutesLeft = (t.startsAt - Date.now()) / 60_000;
    for (const { minutes, bit } of REMINDERS) {
      if (minutesLeft > minutes || t.reminded & bit || minutesLeft < -5) continue; // not yet, already sent, or way too late to matter
      db.prepare('UPDATE tournaments SET reminded = reminded | ? WHERE id = ?').run(bit, t.id);
      t.reminded |= bit;
      const text = `**${t.name}** starts <t:${Math.floor(t.startsAt / 1000)}:R>. Make sure your team is here and your DMs are open — you’ll get a ready check.`;
      await (await channelOf(client, t.channelId))?.send({ embeds: [notice('⏰ Tournament reminder', text, Colors.info)] }).catch(() => null);
      const players = db.prepare("SELECT DISTINCT tm.user_id AS id FROM registrations r JOIN team_members tm ON tm.team_id = r.team_id WHERE r.tournament_id = ? AND r.status = 'CONFIRMED'").all(t.id) as Array<{ id: string }>;
      for (const p of players) await dm(client, p.id, { embeds: [notice('⏰ Tournament reminder', text, Colors.info)] });
      if (minutes === 60) {
        const teams = db.prepare("SELECT tm.name, tm.id FROM registrations r JOIN teams tm ON tm.id = r.team_id WHERE r.tournament_id = ? AND r.status = 'CONFIRMED' ORDER BY r.seed, r.created_at").all(t.id) as Array<{ name: string; id: number }>;
        await pingCasters(client, t.guildId, `🎙️ ${t.name} starts in about an hour`,
          `Starts <t:${Math.floor(t.startsAt / 1000)}:R>. The bracket gets built when it starts; you'll be pinged here as each match begins with its round, arena and rosters.\n\n${teams.map(tm => `**${tm.name}**\n${rosterLines(tm.id)}`).join('\n\n') || '*No teams entered yet.*'}`);
      }
    }
  }
}

const lastAlert = new Map<string, number>();

/** Runs a background task; if it throws, logs it and tells staff (at most once per 10 minutes per task). */
export function guarded(client: Client, name: string, task: () => Promise<unknown>): () => void {
  return () => void task().catch(async error => {
    console.error(`[${name}]`, error);
    if (Date.now() - (lastAlert.get(name) ?? 0) < 10 * 60_000) return;
    lastAlert.set(name, Date.now());
    await logEvent(client, 'Background task failed', `**${name}** hit an error: ${error instanceof Error ? error.message : String(error)}`.slice(0, 1000), Colors.danger);
  });
}

/** A player flags the latest result: scoring freezes for that match and staff are told. */
export async function handleDisputeButton(i: ButtonInteraction, rawId: string): Promise<void> {
  const view = getMatchView(Number(rawId));
  if (!view) throw new UserError('That match no longer exists.');
  const onMatch = db.prepare('SELECT 1 FROM team_members WHERE user_id = ? AND team_id IN (?, ?)').get(i.user.id, view.team1_id, view.team2_id);
  if (!onMatch && !staffCheck(i)) throw new UserError('Only players in this match (or staff) can dispute it.');
  if (view.status === 'READY') db.prepare('UPDATE matches SET disputed = 1 WHERE id = ?').run(view.id);
  await logEvent(i.client, 'Result disputed', `<@${i.user.id}> disputed match #${view.id} (**${view.team1_name}** vs **${view.team2_name}**).`
    + (view.status === 'READY' ? ' Automatic scoring is **paused** for it. Fix it with `/tournament-admin undo_game`, `game` or `resolve`, or resume with `rescore`.' : ' The match had already finished.'), Colors.danger);
  await i.reply({ embeds: [notice('Dispute sent', view.status === 'READY' ? 'Staff have been told and scoring is paused for this match until they look.' : 'Staff have been told.', Colors.warning)] });
}
