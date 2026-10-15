import { EmbedBuilder, type ChatInputCommandInteraction } from 'discord.js';
import { Colors, EPHEMERAL } from '../util.js';
import { staffCheck } from './shared.js';

export async function helpCommand(i: ChatInputCommandInteraction): Promise<void> {
  const embed = new EmbedBuilder()
    .setTitle('Tournament bot — how it works')
    .setColor(Colors.info)
    .addFields(
      { name: '1. Register (required)', value: '`/profile register` with your Meta username, region, and timezone. Nothing else works until you do this.' },
      { name: '2. Get on a team', value: '`/team create` to start one (you become captain), or accept an invite from a DM or `/team invites`.' },
      { name: 'Captain tools', value: '`/team invite` • `/team kick` • `/team transfer` • `/team rename` • `/team disband`' },
      { name: 'Everyone', value: '`/team info` • `/team leave` • `/profile view` • `/profile edit`' },
      { name: '3. Enter a tournament', value: '`/tournament list` to see what’s open, then the captain runs `/tournament signup`.' },
      { name: '4. Play', value: 'You’ll get a DM when your match is ready, with your **arena** — both rosters get whitelisted automatically, so only your two teams can join. Matches are usually best of 3 (first to 2 wins).' },
      { name: '5. Scores are automatic', value: 'The bot reads each finished game from the arena and updates the series. When a team hits the wins needed, it moves on in the bracket. `/match info` shows the series score. If something goes wrong, ask staff.' }
    );
  if (staffCheck(i)) {
    embed.addFields(
      { name: 'Staff: first-time setup', value: '`/settings check` shows what’s missing. Then `/settings log_channel` / `thread_channel` / `staff_role`, and `/arena seed` for the 9 arenas.' },
      { name: 'Staff: running a tournament', value: '`/tournament-admin create` (add `starts_in_minutes` for reminders) → captains sign up (button or `/tournament signup`) → `approve` / `deny` / `add` → `close` → `start` (`seed_by` signup / record / random).\n'
        + '`start` DMs every player a **ready check**. When all are ready the bot builds the bracket, makes the tournament role, whitelists round 1 and opens a private thread per match. If anyone can’t be whitelisted, nothing starts and the log channel says who.' },
      { name: 'Staff: when something goes wrong', value: '`/tournament-admin undo_game` (remove a wrong game) • `game` (add one) • `resolve` (end a match) • `rescore` (re-read missed games) • `disqualify` (forfeit a team).\n'
        + 'Players can press **Dispute** under a result; scoring pauses for that match until you act.\n'
        + '`/arena whitelist` / `unwhitelist` adds or removes a player by hand in a live match.' },
      { name: 'Staff: moderation', value: '`/ban`, `/unban`, `/banlist` (applied in Orion Drift). Banned players can’t sign up or start a ready check.' }
    );
  }
  await i.reply({ embeds: [embed], flags: EPHEMERAL });
}
