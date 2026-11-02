import { ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits, type ButtonInteraction, type Client, type Message, type SendableChannels } from 'discord.js';
import { db } from '../db.js';
import { Colors, UserError, notice } from '../util.js';
import { listArenas, syncArenas, type ReadyEvent } from '../services/arenas.js';
import { getMatchView } from '../services/bracket.js';
import { getTournamentById, listRegistrations, startTournament, type Seeding } from '../services/tournaments.js';
import { emit } from '../webhooks.js';
import { bannedAmong } from '../services/bans.js';
import { bracketChannelId } from '../services/settings.js';
import { onDiscord, who } from '../services/players.js';
import { announceEvents, bracketEmbeds, castersSchedule, fitOneMessage, logEvent, openWaitingRooms, pingCasters } from './shared.js';

/**
 * Start flow: ready check -> build bracket -> whitelist round 1 in Orion Drift.
 * If any whitelist fails, the bracket is undone, access is removed, and staff get the details.
 */

const READY_MINUTES = 10;
/** Stored in ready_checks.shuffle as the index into this list (0 = signup order, 1 = random, 2 = past record). */
const SEEDINGS: Seeding[] = ['signup', 'random', 'record'];

interface Check {
  tournamentId: number;
  seeding: Seeding;
  channel: SendableChannels;
  /** The DM each player clicks Ready in. Nothing is posted on the server. */
  dms: Array<{ userId: string; message: Message }>;
  expiresAt: number;
  /** userId -> player + team info */
  players: Map<string, { team: string; meta: string }>;
  ready: Set<string>;
  timer?: NodeJS.Timeout;
}

const checks = new Map<number, Check>();

function participants(tournamentId: number): Check['players'] {
  const rows = db.prepare(`SELECT tm.user_id AS userId, t.name AS team, p.meta_username AS meta
    FROM registrations r JOIN teams t ON t.id = r.team_id JOIN team_members tm ON tm.team_id = t.id
    LEFT JOIN players p ON p.user_id = tm.user_id
    WHERE r.tournament_id = ? AND r.status = 'CONFIRMED' ORDER BY t.name, tm.joined_at`).all(tournamentId) as Array<{ userId: string; team: string; meta: string | null }>;
  return new Map(rows.map(r => [r.userId, { team: r.team, meta: r.meta ?? '?' }]));
}

function render(check: Check, title: string, color: number) {
  const t = getTournamentById(check.tournamentId)!;
  const teams = new Map<string, string[]>();
  for (const [id, p] of check.players) teams.set(p.team, [...(teams.get(p.team) ?? []), `${check.ready.has(id) ? '✅' : '⏳'} ${who(id)}`]);
  const lines = [...teams].map(([team, members]) => `**${team}** — ${members.join(' ')}`);
  return notice(title, `**${t.name}**: ${check.ready.size}/${check.players.size} ready\n\n${lines.join('\n')}`.slice(0, 4000), color);
}

function readyRow(tournamentId: number, disabled = false) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`ready:yes:${tournamentId}`).setLabel('Ready').setStyle(ButtonStyle.Success).setDisabled(disabled));
}

/** Fails early (before anyone is DMed) if the bot can't make the role and match channels, or post the bracket. */
async function requireBotPermissions(client: Client, channel: SendableChannels): Promise<void> {
  const problems: string[] = [];
  const guild = 'guild' in channel ? channel.guild : null;
  const me = guild?.members.me;
  if (!guild || !me) return;
  if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) problems.push('**Manage Roles** (team and tournament roles, match channel access)');
  if (!me.permissions.has(PermissionFlagsBits.ManageChannels)) problems.push('**Manage Channels** (private match channels)');
  const bracketId = bracketChannelId();
  if (bracketId && !(await client.channels.fetch(bracketId).catch(() => null))?.isSendable()) problems.push(`posting in the bracket channel <#${bracketId}> (check \`/settings bracket_channel\`)`);
  if (problems.length) throw new UserError(`I’m missing permissions, so I can’t start yet:\n${problems.map(p => `• ${p}`).join('\n')}`);
}

function saveCheck(check: Check): void {
  db.prepare(`INSERT INTO ready_checks (tournament_id, shuffle, channel_id, expires_at, ready, dms) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (tournament_id) DO UPDATE SET ready = excluded.ready, dms = excluded.dms`)
    .run(check.tournamentId, SEEDINGS.indexOf(check.seeding), check.channel.id, check.expiresAt, JSON.stringify([...check.ready]),
      JSON.stringify(check.dms.map(d => ({ userId: d.userId, channelId: d.message.channelId, messageId: d.message.id }))));
}

function forgetCheck(tournamentId: number): void {
  db.prepare('DELETE FROM ready_checks WHERE tournament_id = ?').run(tournamentId);
}

/** After a restart: put open ready checks back so players can keep clicking (and the timeout still applies). */
export async function restoreReadyChecks(client: Client): Promise<void> {
  const rows = db.prepare('SELECT * FROM ready_checks').all() as Array<{ tournament_id: number; shuffle: number; channel_id: string; expires_at: number; ready: string; dms: string }>;
  for (const row of rows) {
    const t = getTournamentById(row.tournament_id);
    const channel = await client.channels.fetch(row.channel_id).catch(() => null);
    if (!t || (t.status !== 'SIGNUPS' && t.status !== 'CLOSED') || !channel?.isSendable()) { forgetCheck(row.tournament_id); continue; }
    const saved = JSON.parse(row.dms) as Array<{ userId: string; channelId: string; messageId: string }>;
    const players = new Map([...participants(t.id)].filter(([id]) => saved.some(d => d.userId === id)));
    const check: Check = { tournamentId: t.id, seeding: SEEDINGS[row.shuffle] ?? 'signup', channel, players, ready: new Set(JSON.parse(row.ready) as string[]), dms: [], expiresAt: row.expires_at };
    for (const d of saved) {
      const dmChannel = await client.channels.fetch(d.channelId).catch(() => null);
      const message = dmChannel?.isTextBased() ? await dmChannel.messages.fetch(d.messageId).catch(() => null) : null;
      if (message) check.dms.push({ userId: d.userId, message });
    }
    checks.set(t.id, check);
    check.timer = setTimeout(() => void expire(client, check).catch(console.error), Math.max(0, check.expiresAt - Date.now()));
    check.timer.unref();
  }
}

async function preflight(client: Client, channel: SendableChannels, tournamentId: number) {
  const t = getTournamentById(tournamentId);
  if (!t) throw new UserError('That tournament no longer exists.');
  if (checks.has(tournamentId)) throw new UserError('A ready check is already running for this tournament.');
  if (!listArenas(t.guildId).some(a => a.enabled)) throw new UserError('Add at least one enabled arena with `/arena add` before starting — players are whitelisted into arenas.');
  await requireBotPermissions(client, channel);
  const players = participants(tournamentId);
  if (!players.size) throw new UserError('No confirmed teams to start.');
  const banned = (await bannedAmong([...players.values()].map(p => p.meta))).map(name => `• **${name}**`);
  if (banned.length) throw new UserError(`These players are banned from Orion Drift right now, so the tournament can’t start:\n${banned.join('\n')}\nRemove their team with \`/tournament-admin deny\` (and \`add\` a replacement).`);
  return { t, players };
}

/** Starts right away with no ready check. */
export async function forceStart(client: Client, channel: SendableChannels, tournamentId: number, seeding: Seeding): Promise<void> {
  await cancelReadyCheck(tournamentId); // an old ready check would block preflight and could start it twice
  await preflight(client, channel, tournamentId);
  await begin(client, { tournamentId, seeding, channel });
}

export async function beginReadyCheck(client: Client, channel: SendableChannels, tournamentId: number, seeding: Seeding): Promise<void> {
  const { t, players } = await preflight(client, channel, tournamentId);

  const check: Check = { tournamentId, seeding, channel, players: new Map(players), ready: new Set(), dms: [], expiresAt: Date.now() + READY_MINUTES * 60_000 };
  checks.set(tournamentId, check);
  // The ready check lives only in DMs. Players who can't be DMed (not on Discord, DMs closed) are skipped,
  // but every team needs at least one player who can click.
  const embed = render(check, '🔔 Ready check', Colors.warning);
  const skipped: string[] = [];
  for (const [id, p] of players) {
    const user = onDiscord(id) ? await client.users.fetch(id).catch(() => null) : null;
    const sent = await user?.send({ content: `**${t.name}** is about to start. Click Ready within ${READY_MINUTES} minutes!`, embeds: [embed], components: [readyRow(tournamentId)] }).catch(() => null);
    if (sent) check.dms.push({ userId: id, message: sent });
    else { check.players.delete(id); skipped.push(`• **${p.team}** — ${who(id)} (${p.meta})`); }
  }
  const unreachable = [...new Set([...players.values()].map(p => p.team))].filter(team => ![...check.players.values()].some(p => p.team === team));
  if (unreachable.length) {
    checks.delete(tournamentId);
    forgetCheck(tournamentId);
    await refresh(check, '❌ Ready check cancelled', Colors.danger, true);
    await logEvent(client, 'Ready check cancelled', `**${t.name}**: nobody on ${unreachable.map(n => `**${n}**`).join(', ')} can get the ready check by DM (not on Discord or DMs closed).\n${skipped.join('\n')}\nAsk at least one of them (ideally the captain) to allow DMs from server members, or swap the team with \`/tournament-admin deny\` + \`add\`.`, Colors.danger);
    return;
  }
  if (skipped.length) await logEvent(client, 'Ready check: some players skipped', `**${t.name}**: these players can’t get DMs, so they don’t need to click Ready (they are still whitelisted):\n${skipped.join('\n')}`.slice(0, 4000), Colors.warning);
  await Promise.all(check.dms.map(d => d.message.edit({ embeds: [render(check, '🔔 Ready check', Colors.warning)] }).catch(() => null)));
  saveCheck(check);
  check.timer = setTimeout(() => void expire(client, check).catch(console.error), READY_MINUTES * 60_000);
  check.timer.unref();
}

/** Updates the channel message and every DM copy. */
async function refresh(check: Check, title: string, color: number, done: boolean): Promise<void> {
  const payload = { embeds: [render(check, title, color)], components: [readyRow(check.tournamentId, done)] };
  await Promise.all(check.dms.map(d => d.message.edit(payload).catch(() => null)));
}

async function expire(client: Client, check: Check): Promise<void> {
  if (!checks.delete(check.tournamentId)) return;
  forgetCheck(check.tournamentId);
  const missing = [...check.players].filter(([id]) => !check.ready.has(id));
  await refresh(check, '❌ Ready check failed', Colors.danger, true);
  await logEvent(client, 'Ready check failed', `Not everyone was ready for **${getTournamentById(check.tournamentId)?.name}**. Missing:\n`
    + missing.map(([id, p]) => `• **${p.team}** — ${who(id)} (${p.meta})`).join('\n'), Colors.danger);
}

export async function handleReadyButton(i: ButtonInteraction, client: Client): Promise<void> {
  const tournamentId = Number(i.customId.split(':')[2]);
  const check = checks.get(tournamentId);
  if (!check) throw new UserError('This ready check is over.');
  if (!check.players.has(i.user.id)) throw new UserError('You’re not on a team in this tournament.');
  check.ready.add(i.user.id);
  const done = check.ready.size >= check.players.size;
  if (done) { clearTimeout(check.timer); checks.delete(tournamentId); forgetCheck(tournamentId); } else saveCheck(check);
  await i.deferUpdate();
  await refresh(check, done ? '✅ Everyone is ready — starting…' : '🔔 Ready check', done ? Colors.success : Colors.warning, done);
  if (done) await begin(i.client, check);
}

function teamOf(userId: string, guildId: string): string {
  return (db.prepare('SELECT t.name FROM team_members tm JOIN teams t ON t.id = tm.team_id WHERE tm.user_id = ? AND t.guild_id = ?').get(userId, guildId) as { name: string } | undefined)?.name ?? 'unknown team';
}

async function begin(client: Client, check: Pick<Check, 'tournamentId' | 'seeding' | 'channel'>): Promise<void> {
  const t = getTournamentById(check.tournamentId)!;
  try {
    startTournament(t, check.seeding);
  } catch (error) {
    const reason = error instanceof UserError ? error.message : 'Unexpected error';
    await logEvent(client, 'Tournament did not start', `**${t.name}**: ${reason}`, Colors.danger);
    await check.channel.send({ embeds: [notice('Couldn’t start', reason, Colors.danger)] }).catch(() => null);
    return;
  }
  // Live bracket, results and the champion go to the bracket channel (or where start was run).
  const picked = bracketChannelId() ? await client.channels.fetch(bracketChannelId()!).catch(() => null) : null;
  const home = picked?.isSendable() ? picked : check.channel;
  db.prepare('UPDATE tournaments SET channel_id = ? WHERE id = ?').run(home.id, t.id);

  // Tournament role for every player on Discord, then the arena whitelist.
  const guild = await client.guilds.fetch(t.guildId).catch(() => null);
  if (guild) {
    const role = await guild.roles.create({ name: t.name.slice(0, 100), reason: `Tournament ${t.name}` }).catch(() => null);
    if (role) {
      db.prepare('UPDATE tournaments SET role_id = ? WHERE id = ?').run(role.id, t.id);
      for (const id of participants(t.id).keys()) if (onDiscord(id)) await guild.members.fetch(id).then(m => m.roles.add(role)).catch(() => null);
    } else {
      await logEvent(client, 'Couldn’t create tournament role', 'Give the bot the **Manage Roles** permission.', Colors.warning);
    }
  }


  const events = await syncArenas();
  const mine: ReadyEvent[] = [], others: ReadyEvent[] = [];
  for (const e of events) (getMatchView(e.matchId)?.tournament_id === t.id ? mine : others).push(e);
  await announceEvents(client, others);

  const failures = mine.flatMap(e => e.failures.map(f => ({ ...f, matchId: e.matchId })));
  // It starts anyway: those players were DMed to fix their Meta username, and the bot re-whitelists them when they do.
  if (failures.length) {
    const report = failures.map(f => `• **${teamOf(f.userId, t.guildId)}** — ${who(f.userId)} (${f.metaUsername}): ${f.reason}`).join('\n');
    await logEvent(client, 'Some players aren’t whitelisted', `**${t.name}** started, but these players couldn’t be whitelisted yet:\n${report}\n\n`
      + 'They were DMed to fix it with `/player edit`; the bot retries on its own. Players not on Discord: `/team-admin remove_player` + `add_player` won’t work mid-tournament, so use `/arena whitelist` with their right username.'.slice(0, 4000), Colors.warning);
  }

  void emit('tournament.started', { tournamentId: t.id, name: t.name, teams: listRegistrations(t.id).map(r => ({ id: r.teamId, name: r.teamName, seed: r.seed })) });
  await logEvent(client, 'Tournament started', `**${t.name}** started with ${listRegistrations(t.id).length} teams.`, Colors.success);
  const started = getTournamentById(t.id)!;
  const bracket = await home.send({ embeds: fitOneMessage(bracketEmbeds(started)), allowedMentions: { parse: [] } }).catch(() => null);
  if (bracket) db.prepare('UPDATE tournaments SET bracket_message_id = ? WHERE id = ?').run(bracket.id, t.id);
  await announceEvents(client, mine, { casters: false }); // casters get the whole schedule in one DM instead
  await pingCasters(client, t.guildId, `🎙️ ${t.name} is live — first matches`, castersSchedule(started));
  await openWaitingRooms(client); // teams with a bye wait in their round-2 channel
}

/** Cancels an open ready check (e.g. the tournament is being deleted). */
export async function cancelReadyCheck(tournamentId: number): Promise<void> {
  const check = checks.get(tournamentId);
  if (!check) { forgetCheck(tournamentId); return; }
  clearTimeout(check.timer);
  checks.delete(tournamentId);
  forgetCheck(tournamentId);
  await refresh(check, '❌ Ready check cancelled', Colors.danger, true);
}
