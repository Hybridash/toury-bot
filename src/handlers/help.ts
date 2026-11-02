import { EmbedBuilder, type ChatInputCommandInteraction } from 'discord.js';
import { Colors, EPHEMERAL } from '../util.js';
import { staffCheck } from './shared.js';

export async function helpCommand(i: ChatInputCommandInteraction): Promise<void> {
  const embed = new EmbedBuilder()
    .setTitle('Tournament bot — how it works')
    .setColor(Colors.info)
    .addFields(
      { name: '1. Get on a team', value: 'Staff create teams and pick the captain. Captains get the Captain role and every player gets their team’s role. Captains invite players with `/team invite`; accept the invite from your DM or `/team invites` (the first time, you’ll be asked for your Meta username).' },
      { name: 'Captain tools', value: '`/team invite` • `/team kick` • `/team transfer`' },
      { name: 'Everyone', value: '`/team info` • `/team leave` • `/player edit` (change your Meta username)' },
      { name: '2. Tournaments', value: '`/tournament list` to see what’s running. Staff enter teams into tournaments.' },
      { name: '3. Play', value: 'You’ll get a DM when your match is ready, with your **arena** — both rosters get whitelisted automatically, so only your two teams can join. Matches are usually best of 3 (first to 2 wins).' },
      { name: '4. Scores are automatic', value: 'The bot reads each finished game from the arena and updates the series. When a team hits the wins needed, it moves on in the bracket. `/match info` shows the series score. If something goes wrong, ask staff.' }
    );
  if (staffCheck(i)) {
    embed.addFields(
      { name: 'Staff: first-time setup', value: '`/settings check` shows what’s missing. Then `/settings log_channel` / `bracket_channel` (live bracket + scores) / `match_category` / `staff_role` / `casters` (DMs the caster role every matchup, arena and time), and `/arena seed` for the 9 arenas.' },
      { name: 'Staff: running a tournament', value: '`/tournament-admin create` (add `starts_in_minutes` for reminders) → `/team-admin create` (captain, name, region, logo) and `/team-admin add_player` (Meta username; Discord account optional — they don’t have to be in this server) for each team → `/tournament-admin add` → `close` → `start` (`seed_by` signup / record / random).\n'
        + '`start` DMs every player a **ready check**. When all are ready the bot builds the bracket, makes the tournament role, whitelists round 1 and opens a private channel per match (only those two teams + staff see it). Odd team counts give the top seeds a bye; a team that is through waits in its next match’s channel until the opponent is decided. Anyone who can’t be whitelisted gets a DM to fix their Meta username with `/player edit` (they’re let in automatically once it’s right), and the log channel lists them.' },
      { name: 'Staff: when something goes wrong', value: '`/tournament-admin undo_game` (remove a wrong game) • `game` (add one) • `resolve` (end a match) • `rescore` (re-read missed games) • `disqualify` (forfeit a team).\n'
        + 'Players can press **Dispute** under a result; scoring pauses for that match until you act.\n'
        + '`/arena whitelist` / `unwhitelist` adds or removes a player by hand in a live match.' },
      { name: 'Staff: moderation', value: '`/ban`, `/unban`, `/banlist` (applied in Orion Drift). Banned players can’t start a ready check.' }
    );
  }
  await i.reply({ embeds: [embed], flags: EPHEMERAL });
}
