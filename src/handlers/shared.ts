import { randomUUID } from 'node:crypto';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, type ButtonInteraction, type ChatInputCommandInteraction, type Client, type EmbedBuilder, type Interaction } from 'discord.js';
import { config } from '../config.js';
import { getTournamentById } from '../services/tournaments.js';
import { Colors, EPHEMERAL, UserError, isStaff, notice } from '../util.js';
import { getMatchView, listMatchViews, isByeMatch, roundTitle, type MatchView } from '../services/bracket.js';
import { getTeamById } from '../services/teams.js';
import { logChannelId, staffRoleId, threadChannelId } from '../services/settings.js';
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
  await archiveFinishedThreads(client);
  await refreshBrackets(client);
}

/** Private thread per match with its arena and both rosters. Needs the tournament's channel (saved when it was started). */
async function createMatchThread(client: Client, view: MatchView, arenaName: string): Promise<void> {
  const row = db.prepare('SELECT m.thread_id AS threadId, t.channel_id AS channelId FROM matches m JOIN tournaments t ON t.id = m.tournament_id WHERE m.id = ?')
    .get(view.id) as { threadId: string | null; channelId: string | null } | undefined;
  const targetId = threadChannelId() ?? row?.channelId;
  if (!row || row.threadId || !targetId) return;
  const channel = await client.channels.fetch(targetId).catch(() => null);
  if (channel?.type !== ChannelType.GuildText) return;
  const thread = await channel.threads.create({
    name: `match-${view.id}-${view.team1_name}-vs-${view.team2_name}`.slice(0, 100), type: ChannelType.PrivateThread, invitable: false
  }).catch(() => null);
  if (!thread) return;
  db.prepare('UPDATE matches SET thread_id = ? WHERE id = ?').run(thread.id, view.id);
  const userIds = (db.prepare('SELECT user_id FROM team_members WHERE team_id IN (?, ?)').all(view.team1_id, view.team2_id) as Array<{ user_id: string }>).map(r => r.user_id);
  for (const id of userIds) await thread.members.add(id).catch(() => null);
  await thread.send({
    content: userIds.map(id => `<@${id}>`).join(' '),
    embeds: [notice(`Match #${view.id} — ${view.team1_name} vs ${view.team2_name}`,
      `🏟️ **Arena: ${arenaName}**\nOnly the players in this thread are whitelisted. ${view.best_of === 1 ? 'One game.' : `Best of ${view.best_of}.`}\nScores are tracked automatically; call staff here if something goes wrong.`, Colors.success)]
  }).catch(() => null);
}

export async function announceEvents(client: Client, events: ReadyEvent[]): Promise<void> {
  for (const event of events) {
    const view = getMatchView(event.matchId);
    if (!view) continue;
    const one = getTeamById(view.team1_id!), two = getTeamById(view.team2_id!);
    if (event.queued) {
      const text = `**${view.team1_name}** vs **${view.team2_name}** in **${view.tournament_name}** is ready, but every arena is busy. You’ll get another DM the moment one opens — no need to do anything.`;
      for (const team of [one, two]) if (team) await dm(client, team.captainId, { embeds: [notice(`Match #${view.id} is waiting for an arena`, text, Colors.warning)] });
      await logEvent(client, 'Match waiting for an arena', `Match #${view.id} (**${view.team1_name}** vs **${view.team2_name}**) has no free arena. Add more with \`/arena seed\`, or finish/delete whatever is using them (\`/arena list\`).`, Colors.warning);
      continue;
    }
    const needed = winsNeeded(view.best_of);
    const arenaLine = event.arenaName
      ? `\n🏟️ **Arena: ${event.arenaName}** — everyone on both rosters has been whitelisted, so only you two teams can get in.`
      : '';
    const failLine = event.failures.length
      ? `\n⚠️ Couldn’t whitelist: ${event.failures.map(f => `<@${f.userId}> (${f.metaUsername}) — ${f.reason}`).join('; ')}`
      : '';
    for (const [mine, theirs] of [[one, two], [two, one]] as const) {
      if (!mine || !theirs) continue;
      await dm(client, mine.captainId, { embeds: [notice(
        `Match #${view.id} is ready`,
        `**${mine.name}** vs **${theirs.name}** in **${view.tournament_name}** — ${view.best_of === 1 ? 'one game' : `best of ${view.best_of} (first to ${needed} wins)`}.`
        + `${arenaLine}\nTheir captain is <@${theirs.captainId}>. Scores are tracked automatically.${failLine}`,
        event.failures.length ? Colors.warning : Colors.success)] });
    }
    if (event.arenaName) {
      await createMatchThread(client, view, event.arenaName);
      await logEvent(client, 'Arena assigned', `Match #${view.id} (**${view.team1_name}** vs **${view.team2_name}**) → **${event.arenaName}**.${failLine}`,
        event.failures.length ? Colors.warning : Colors.info);
    }
  }
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
 * Deletes the tournament role (once) and archives any threads still open.
 * With `destroy` (tournament being deleted) the threads and the live bracket message are deleted instead.
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
    if (destroy) await thread?.delete('Tournament deleted').catch(() => null);
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
  if (match.status !== 'READY') return `\`#${match.id}\` ${a} vs ${b}`;
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
  const rows = db.prepare("SELECT id, name, channel_id AS channelId, starts_at AS startsAt, reminded FROM tournaments WHERE starts_at IS NOT NULL AND status IN ('SIGNUPS', 'CLOSED')")
    .all() as Array<{ id: number; name: string; channelId: string | null; startsAt: number; reminded: number }>;
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
