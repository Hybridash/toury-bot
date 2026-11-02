import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ChatInputCommandInteraction } from 'discord.js';
import { Colors, UserError, notice, requireGuild } from '../util.js';
import { getPlayer, registerPlayer, validateMetaUsername, type Region } from '../services/players.js';
import { addPlayerAsStaff, createTeam, disbandTeam, getTeamById, getTeamByName, removePlayerAsStaff, renameTeam, setTeamLogo } from '../services/teams.js';
import { who } from '../services/players.js';
import { db } from '../db.js';
import { askConfirm, dm, logEvent, requireStaff } from './shared.js';
import { deleteTeamRole, dropTeamRoles, renameTeamRole, syncTeamRoles } from './roles.js';
import { teamEmbed, teamLogoFiles } from './team.js';

const LOGO_DIR = join(dirname(process.env.DATABASE_PATH || './data/tournament.sqlite'), 'logos');
const LOGO_TYPES: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
const MAX_LOGO_BYTES = 8 * 1024 * 1024;

/** Discord attachment links expire, so the logo is copied to disk. */
async function downloadLogo(url: string, contentType: string | null): Promise<{ bytes: Buffer; ext: string }> {
  const ext = LOGO_TYPES[(contentType ?? '').split(';')[0]];
  if (!ext) throw new UserError('The logo must be a PNG, JPG, WEBP or GIF image.');
  const res = await fetch(url);
  if (!res.ok) throw new UserError('I couldn’t download that logo. Try uploading it again.');
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length > MAX_LOGO_BYTES) throw new UserError('The logo is too big (max 8 MB).');
  return { bytes, ext };
}

function findTeam(guildId: string, input: string) {
  const team = getTeamById(Number(input)) ?? getTeamByName(guildId, input);
  if (!team || team.guildId !== guildId) throw new UserError(`No team called **${input}** was found.`);
  return team;
}

export async function teamAdminCommand(i: ChatInputCommandInteraction): Promise<void> {
  const guildId = requireGuild(i);
  requireStaff(i);
  const sub = i.options.getSubcommand();

  if (sub === 'create') {
    const captain = i.options.getUser('captain', true);
    if (captain.bot) throw new UserError('A bot can’t be a captain.');
    const region = i.options.getString('region', true) as Region;
    const logo = i.options.getAttachment('logo', true);
    const metaInput = i.options.getString('captain_meta_username');
    if (!getPlayer(captain.id) && !metaInput) throw new UserError(`${captain} isn’t registered yet, so give their Meta username in \`captain_meta_username\`.`);
    await i.deferReply(); // logo download + roles + DM can take longer than Discord's 3 seconds
    const { bytes, ext } = await downloadLogo(logo.url, logo.contentType);
    // Create everything in one go so a bad name or taken username doesn't leave a half-made team.
    const team = db.transaction(() => {
      if (!getPlayer(captain.id)) registerPlayer(captain.id, validateMetaUsername(metaInput!), region, 'UTC');
      return createTeam(guildId, captain.id, i.options.getString('name', true), region);
    })();
    const logoPath = join(LOGO_DIR, `${team.id}.${ext}`);
    mkdirSync(LOGO_DIR, { recursive: true });
    writeFileSync(logoPath, bytes);
    setTeamLogo(team.id, logoPath);
    await syncTeamRoles(i.client, team.id);
    const created = getTeamById(team.id)!;
    await logEvent(i.client, 'Team created', `<@${i.user.id}> created **${team.name}** (${team.region}) with captain ${captain}.`);
    await dm(i.client, captain.id, { embeds: [notice('You’re a captain 👑', `Staff made you captain of **${team.name}** (${team.region}). Invite your players with \`/team invite\`.`, Colors.success)] });
    await i.editReply({ embeds: [teamEmbed(created)], files: teamLogoFiles(created), allowedMentions: { parse: [] } });
    return;
  }

  const team = findTeam(guildId, i.options.getString('team', true));

  if (sub === 'add_player') {
    const user = i.options.getUser('user');
    if (user?.bot) throw new UserError('Bots can’t join teams.');
    await i.deferReply();
    const id = addPlayerAsStaff(team, i.options.getString('meta_username', true), user?.id);
    await syncTeamRoles(i.client, team.id);
    const told = user ? await dm(i.client, user.id, { embeds: [notice('You’re on a team', `Staff put you on **${team.name}** (${team.region}). You’ll get a DM with your arena when your match is ready.`, Colors.success)] }) : false;
    await logEvent(i.client, 'Player added', `<@${i.user.id}> added ${who(id)} to **${team.name}**.`);
    await i.editReply({ embeds: [notice('Player added', `${who(id)} is on **${team.name}** and will be whitelisted by their Meta username.${user ? (told ? ' They got a DM.' : ' I couldn’t DM them (not in a server with me, or DMs closed) — that’s fine, they’re still whitelisted.') : ''}`, Colors.success), teamEmbed(getTeamById(team.id)!)], allowedMentions: { parse: [] } });
    return;
  }

  if (sub === 'remove_player') {
    const id = removePlayerAsStaff(team, i.options.getString('username', true));
    await dropTeamRoles(i.client, team, [id]);
    await logEvent(i.client, 'Player removed', `<@${i.user.id}> removed ${who(id)} from **${team.name}**.`, Colors.warning);
    await i.reply({ embeds: [notice('Player removed', `${who(id)} is no longer on **${team.name}**.`, Colors.success)], allowedMentions: { parse: [] } });
    return;
  }

  if (sub === 'rename') {
    const oldName = team.name;
    const renamed = renameTeam(team, i.options.getString('name', true));
    await renameTeamRole(i.client, renamed);
    await logEvent(i.client, 'Team renamed', `<@${i.user.id}> renamed **${oldName}** to **${renamed.name}**.`);
    await i.reply({ embeds: [notice('Team renamed', `**${oldName}** is now **${renamed.name}**.`, Colors.success)] });
    return;
  }

  await askConfirm(i, 'Disband team?', `Delete **${team.name}** for good? Everyone gets removed and any tournament entries are cancelled.`, async button => {
    const members = disbandTeam(team);
    await dropTeamRoles(i.client, team, members);
    await deleteTeamRole(i.client, team);
    if (team.logoPath) rmSync(team.logoPath, { force: true });
    await logEvent(i.client, 'Team disbanded', `<@${i.user.id}> disbanded **${team.name}**.`, Colors.danger);
    for (const userId of members) await dm(i.client, userId, { embeds: [notice('Team disbanded', `**${team.name}** was disbanded by staff.`, Colors.warning)] });
    await button.update({ embeds: [notice('Team disbanded', `**${team.name}** was deleted.`, Colors.muted)], components: [] });
  }, 'Disband');
}
