import { Client, Events, GatewayIntentBits, type ButtonInteraction, type ChatInputCommandInteraction, type ModalSubmitInteraction } from 'discord.js';
import { config } from './config.js';
import './db.js';
import { startApi } from './api.js';
import { startBackups } from './backup.js';
import { runChecks } from './startup.js';
import { fixArenaSlots } from './services/arenas.js';
import { db } from './db.js';
import { logEvent } from './handlers/shared.js';
import { EPHEMERAL, UserError, replyError } from './util.js';
import { staffCheck } from './handlers/shared.js';
import { handleInviteButton, handleInviteModal, teamCommand } from './handlers/team.js';
import { playerCommand } from './handlers/player.js';
import { teamAdminCommand } from './handlers/teamadmin.js';
import { matchCommand, tournamentCommand } from './handlers/tournament.js';
import { adminCommand } from './handlers/admin.js';
import { settingsCommand } from './handlers/settings.js';
import { helpCommand } from './handlers/help.js';
import { arenaCommand, banCommand, banlistCommand, lockArenas, unbanCommand } from './handlers/orion.js';
import { handleAutocomplete } from './handlers/autocomplete.js';
import { handleReadyButton, restoreReadyChecks } from './handlers/start.js';
import { handleConfirmButton, handleDisputeButton, guarded, notifyReadyMatches, scoreFinishedGames, sendReminders } from './handlers/shared.js';

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

/** Non-staff only ever get private replies; staff replies stay public so everyone sees tournament activity. */
function makePrivateForMembers(i: ChatInputCommandInteraction | ButtonInteraction | ModalSubmitInteraction): void {
  if (staffCheck(i)) return;
  for (const method of ['reply', 'deferReply', 'followUp'] as const) {
    const original = (i[method] as (o: any) => Promise<unknown>).bind(i);
    (i as any)[method] = (options: any) => original(typeof options === 'string' ? { content: options, flags: EPHEMERAL } : { ...options, flags: EPHEMERAL });
  }
}

async function onCommand(i: ChatInputCommandInteraction): Promise<void> {
  try {
    if (!i.inGuild()) throw new UserError('Use this bot inside a server.');
    makePrivateForMembers(i);
    switch (i.commandName) {
      case 'team': return await teamCommand(i);
      case 'player': return await playerCommand(i);
      case 'team-admin': return await teamAdminCommand(i);
      case 'tournament': return await tournamentCommand(i);
      case 'match': return await matchCommand(i);
      case 'tournament-admin': return await adminCommand(i);
      case 'ban': return await banCommand(i);
      case 'unban': return await unbanCommand(i);
      case 'banlist': return await banlistCommand(i);
      case 'arena': return await arenaCommand(i);
      case 'settings': return await settingsCommand(i);
      case 'help': return await helpCommand(i);
    }
  } catch (error) {
    await replyError(i, error);
  }
}

async function onButton(i: ButtonInteraction): Promise<void> {
  try {
    makePrivateForMembers(i);
    const [scope, action, id] = i.customId.split(':');
    if (scope === 'dispute') return await handleDisputeButton(i, id);
    if (scope === 'ready') return await handleReadyButton(i, i.client);
    if (scope === 'confirm') return await handleConfirmButton(i, action, id);
    if (scope === 'invite') return await handleInviteButton(i, action, id);
  } catch (error) {
    await replyError(i, error);
  }
}

async function onModal(i: ModalSubmitInteraction): Promise<void> {
  try {
    makePrivateForMembers(i);
    const [scope, , id] = i.customId.split(':');
    if (scope === 'invitemodal') return await handleInviteModal(i, id);
  } catch (error) {
    await replyError(i, error);
  }
}

client.once(Events.ClientReady, ready => {
  console.log(`Logged in as ${ready.user.tag}`);
  // Catch up on anything that happened while the bot was offline, then keep retrying
  // failed whitelists / access removals every minute.
  const fixedSlots = fixArenaSlots();
  if (fixedSlots) console.log(`[arenas] fixed ${fixedSlots} slot name(s)`);
  void runChecks().then(({ ok, lines }) => {
    console.log(`[setup]\n${lines.join('\n')}`);
    if (!ok) return logEvent(ready, 'Setup needs attention', lines.filter(l => l.startsWith('⚠️')).join('\n'), 0xfaa61a);
  }).catch(console.error);
  void restoreReadyChecks(ready).catch(console.error);
  const sync = guarded(ready, 'arena sync', () => notifyReadyMatches(ready));
  sync();
  setInterval(sync, 60_000).unref();
  setInterval(guarded(ready, 'scoring', () => scoreFinishedGames(ready)), 20_000).unref();
  setInterval(guarded(ready, 'reminders', () => sendReminders(ready)), 60_000).unref();
  // Every arena without a match stays whitelist-only with nobody on it, so only tournament players can play.
  const lock = guarded(ready, 'arena lock', () => lockArenas(ready));
  lock();
  setInterval(lock, 10 * 60_000).unref();
});

client.on(Events.InteractionCreate, interaction => {
  if (interaction.isChatInputCommand()) void onCommand(interaction);
  else if (interaction.isAutocomplete()) void handleAutocomplete(interaction);
  else if (interaction.isButton()) void onButton(interaction);
  else if (interaction.isModalSubmit()) void onModal(interaction);
});

startApi();
startBackups();

// Clean shutdown (pm2 restart / Ctrl+C): stop talking to Discord, then close the database so nothing is half-written.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => { console.log(`[bot] ${signal}, shutting down`); void client.destroy(); db.close(); process.exit(0); });
}

void client.login(config.token);
