import { ChannelType, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';

const regionChoices = [
  { name: 'NA', value: 'NA' },
  { name: 'EU', value: 'EU' },
  { name: 'OCE', value: 'OCE' }
];

const profile = new SlashCommandBuilder().setName('profile').setDescription('Your player profile')
  .addSubcommand(s => s.setName('register').setDescription('Register your profile (required before anything else)')
    .addStringOption(o => o.setName('meta_username').setDescription('Your Meta username').setRequired(true).setMaxLength(32))
    .addStringOption(o => o.setName('region').setDescription('Your region').setRequired(true).addChoices(...regionChoices))
    .addStringOption(o => o.setName('timezone').setDescription('Start typing your city, e.g. Chicago').setRequired(true).setAutocomplete(true)))
  .addSubcommand(s => s.setName('edit').setDescription('Change your profile')
    .addStringOption(o => o.setName('meta_username').setDescription('New Meta username').setMaxLength(32))
    .addStringOption(o => o.setName('region').setDescription('New region').addChoices(...regionChoices))
    .addStringOption(o => o.setName('timezone').setDescription('New timezone').setAutocomplete(true)))
  .addSubcommand(s => s.setName('view').setDescription('View a player profile')
    .addUserOption(o => o.setName('user').setDescription('Player to look up (defaults to you)')));

const team = new SlashCommandBuilder().setName('team').setDescription('Create and manage your team')
  .addSubcommand(s => s.setName('create').setDescription('Create a team and become its captain')
    .addStringOption(o => o.setName('name').setDescription('Team name').setRequired(true).setMaxLength(32)))
  .addSubcommand(s => s.setName('invite').setDescription('Captain: invite a player')
    .addUserOption(o => o.setName('player').setDescription('Player to invite').setRequired(true)))
  .addSubcommand(s => s.setName('invites').setDescription('See and answer your team invites'))
  .addSubcommand(s => s.setName('kick').setDescription('Captain: remove a player')
    .addUserOption(o => o.setName('player').setDescription('Player to remove').setRequired(true)))
  .addSubcommand(s => s.setName('transfer').setDescription('Captain: make someone else captain')
    .addUserOption(o => o.setName('player').setDescription('New captain').setRequired(true)))
  .addSubcommand(s => s.setName('rename').setDescription('Captain: rename your team')
    .addStringOption(o => o.setName('name').setDescription('New team name').setRequired(true).setMaxLength(32)))
  .addSubcommand(s => s.setName('leave').setDescription('Leave your team'))
  .addSubcommand(s => s.setName('disband').setDescription('Captain: delete your team'))
  .addSubcommand(s => s.setName('info').setDescription('View a team')
    .addStringOption(o => o.setName('team').setDescription('Team name (defaults to yours)').setAutocomplete(true)));

const tournament = new SlashCommandBuilder().setName('tournament').setDescription('Tournaments')
  .addSubcommand(s => s.setName('list').setDescription('List tournaments'))
  .addSubcommand(s => s.setName('info').setDescription('Tournament details and teams')
    .addStringOption(o => o.setName('tournament').setDescription('Tournament').setRequired(true).setAutocomplete(true)))
  .addSubcommand(s => s.setName('signup').setDescription('Captain: sign your team up')
    .addStringOption(o => o.setName('tournament').setDescription('Tournament').setRequired(true).setAutocomplete(true)))
  .addSubcommand(s => s.setName('withdraw').setDescription('Captain: take your team out before it starts')
    .addStringOption(o => o.setName('tournament').setDescription('Tournament').setRequired(true).setAutocomplete(true)))
  .addSubcommand(s => s.setName('bracket').setDescription('Show the bracket')
    .addStringOption(o => o.setName('tournament').setDescription('Tournament').setRequired(true).setAutocomplete(true)));

const match = new SlashCommandBuilder().setName('match').setDescription('Tournament matches')
  .addSubcommand(s => s.setName('list').setDescription('Your team’s matches that need to be played'))
  .addSubcommand(s => s.setName('info').setDescription('Series score, games, arena and whitelist for a match')
    .addIntegerOption(o => o.setName('match').setDescription('Match number').setRequired(true).setMinValue(1)));

const admin = new SlashCommandBuilder().setName('tournament-admin').setDescription('Staff: run tournaments')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand(s => s.setName('create').setDescription('Create a tournament')
    .addStringOption(o => o.setName('name').setDescription('Tournament name').setRequired(true).setMaxLength(48))
    .addStringOption(o => o.setName('region').setDescription('Which region can enter').setRequired(true).addChoices(...regionChoices, { name: 'Any region', value: 'ANY' }))
    .addStringOption(o => o.setName('format').setDescription('Bracket type').setRequired(true).addChoices(
      { name: 'Single elimination', value: 'SINGLE' }, { name: 'Double elimination', value: 'DOUBLE' }))
    .addIntegerOption(o => o.setName('max_teams').setDescription('Max teams').setRequired(true).setMinValue(2).setMaxValue(128))
    .addIntegerOption(o => o.setName('min_roster').setDescription('Min players per team').setRequired(true).setMinValue(1).setMaxValue(25))
    .addIntegerOption(o => o.setName('max_roster').setDescription('Max players per team').setRequired(true).setMinValue(1).setMaxValue(25))
    .addIntegerOption(o => o.setName('best_of').setDescription('Games per match (default: best of 3, first to 2)').addChoices(
      { name: 'Best of 1', value: 1 }, { name: 'Best of 3', value: 3 }, { name: 'Best of 5', value: 5 }, { name: 'Best of 7', value: 7 }))
    .addBooleanOption(o => o.setName('require_approval').setDescription('Staff must approve each signup (default: no)'))
    .addIntegerOption(o => o.setName('starts_in_minutes').setDescription('Planned start, for reminders (e.g. 90 = in an hour and a half)').setMinValue(5).setMaxValue(43200)))
  .addSubcommand(s => s.setName('approve').setDescription('Approve a pending signup')
    .addStringOption(o => o.setName('tournament').setDescription('Tournament').setRequired(true).setAutocomplete(true))
    .addStringOption(o => o.setName('team').setDescription('Team').setRequired(true).setAutocomplete(true)))
  .addSubcommand(s => s.setName('add').setDescription('Bring a team in (e.g. to replace one that failed the ready check)')
    .addStringOption(o => o.setName('tournament').setDescription('Tournament').setRequired(true).setAutocomplete(true))
    .addStringOption(o => o.setName('team').setDescription('Team').setRequired(true).setAutocomplete(true)))
  .addSubcommand(s => s.setName('disqualify').setDescription('Remove a team from a running tournament; their opponents advance')
    .addStringOption(o => o.setName('tournament').setDescription('Tournament').setRequired(true).setAutocomplete(true))
    .addStringOption(o => o.setName('team').setDescription('Team').setRequired(true).setAutocomplete(true))
    .addStringOption(o => o.setName('reason').setDescription('Why').setRequired(true).setMaxLength(200)))
  .addSubcommand(s => s.setName('undo_game').setDescription('Remove the latest recorded game of a match (reopens it if it had finished)')
    .addIntegerOption(o => o.setName('match').setDescription('Match number').setRequired(true).setMinValue(1)))
  .addSubcommand(s => s.setName('rescore').setDescription('Re-read a live match’s arena results and record any missed games')
    .addIntegerOption(o => o.setName('match').setDescription('Match number').setRequired(true).setMinValue(1)))
  .addSubcommand(s => s.setName('deny').setDescription('Deny or remove a team from a tournament')
    .addStringOption(o => o.setName('tournament').setDescription('Tournament').setRequired(true).setAutocomplete(true))
    .addStringOption(o => o.setName('team').setDescription('Team').setRequired(true).setAutocomplete(true)))
  .addSubcommand(s => s.setName('close').setDescription('Close signups')
    .addStringOption(o => o.setName('tournament').setDescription('Tournament').setRequired(true).setAutocomplete(true)))
  .addSubcommand(s => s.setName('reopen').setDescription('Reopen signups')
    .addStringOption(o => o.setName('tournament').setDescription('Tournament').setRequired(true).setAutocomplete(true)))
  .addSubcommand(s => s.setName('start').setDescription('Lock rosters and build the bracket')
    .addStringOption(o => o.setName('tournament').setDescription('Tournament').setRequired(true).setAutocomplete(true))
    .addStringOption(o => o.setName('seed_by').setDescription('How to seed the bracket (default: signup order)').addChoices(
      { name: 'Signup order', value: 'signup' }, { name: 'Past record', value: 'record' }, { name: 'Random', value: 'random' }))
    .addBooleanOption(o => o.setName('shuffle').setDescription('Same as seed_by Random')))
  .addSubcommand(s => s.setName('game').setDescription('Record one game win (for disputes)')
    .addIntegerOption(o => o.setName('match').setDescription('Match number').setRequired(true).setMinValue(1))
    .addStringOption(o => o.setName('winner').setDescription('Team that won the game').setRequired(true).setAutocomplete(true)))
  .addSubcommand(s => s.setName('resolve').setDescription('End a whole match right now (no-shows, forfeits)')
    .addIntegerOption(o => o.setName('match').setDescription('Match number').setRequired(true).setMinValue(1))
    .addStringOption(o => o.setName('winner').setDescription('Team that wins the match').setRequired(true).setAutocomplete(true))
    .addIntegerOption(o => o.setName('winner_games').setDescription('Games the winner won (default: enough to win)').setMinValue(1))
    .addIntegerOption(o => o.setName('loser_games').setDescription('Games the loser won (default: current count)').setMinValue(0)))
  .addSubcommand(s => s.setName('delete').setDescription('Delete a tournament and its bracket')
    .addStringOption(o => o.setName('tournament').setDescription('Tournament').setRequired(true).setAutocomplete(true)));

const ban = new SlashCommandBuilder().setName('ban').setDescription('Staff: ban a player in Orion Drift')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addStringOption(o => o.setName('username').setDescription('Orion Drift (Meta) username').setRequired(true).setAutocomplete(true))
  .addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(true).setMaxLength(200))
  .addIntegerOption(o => o.setName('hours').setDescription('How long, in hours (24 = 1 day, 168 = 1 week)').setRequired(true).setMinValue(1).setMaxValue(87600));

const unban = new SlashCommandBuilder().setName('unban').setDescription('Staff: unban a player in Orion Drift')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addStringOption(o => o.setName('username').setDescription('Orion Drift (Meta) username').setRequired(true).setAutocomplete(true));

const banlist = new SlashCommandBuilder().setName('banlist').setDescription('Staff: show active Orion Drift bans')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

const arena = new SlashCommandBuilder().setName('arena').setDescription('Staff: arenas players get whitelisted into for matches')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand(s => s.setName('seed').setDescription('Add Alpha/Beta/Gamma 1–3 on the tournament station'))
  .addSubcommand(s => s.setName('add').setDescription('Add one arena (a gamemode slot on the station)')
    .addStringOption(o => o.setName('name').setDescription('Name players will see, e.g. Alpha 1').setRequired(true).setMaxLength(32))
    .addStringOption(o => o.setName('slot').setDescription('Slot name in Orion Drift, e.g. Alpha 01').setRequired(true))
    .addStringOption(o => o.setName('station_id').setDescription('Station ID (default: ORION_STATION_ID)')))
  .addSubcommand(s => s.setName('whitelist').setDescription('Manually let a player into a live match’s arena')
    .addStringOption(o => o.setName('username').setDescription('Orion Drift (Meta) username').setRequired(true).setAutocomplete(true))
    .addIntegerOption(o => o.setName('match').setDescription('Match number').setRequired(true).setMinValue(1))
    .addIntegerOption(o => o.setName('team').setDescription('Which team they play for').setRequired(true).addChoices({ name: 'Team 1 (first listed)', value: 1 }, { name: 'Team 2 (second listed)', value: 2 })))
  .addSubcommand(s => s.setName('unwhitelist').setDescription('Take back a player you added by hand')
    .addStringOption(o => o.setName('username').setDescription('Orion Drift (Meta) username').setRequired(true).setAutocomplete(true))
    .addIntegerOption(o => o.setName('match').setDescription('Match number').setRequired(true).setMinValue(1))
    .addIntegerOption(o => o.setName('team').setDescription('Which team they play for').setRequired(true).addChoices({ name: 'Team 1 (first listed)', value: 1 }, { name: 'Team 2 (second listed)', value: 2 })))
  .addSubcommand(s => s.setName('list').setDescription('List arenas and which match is in each'))
  .addSubcommand(s => s.setName('disable').setDescription('Stop giving new matches to an arena')
    .addStringOption(o => o.setName('name').setDescription('Arena').setRequired(true).setAutocomplete(true)))
  .addSubcommand(s => s.setName('enable').setDescription('Start giving matches to an arena again')
    .addStringOption(o => o.setName('name').setDescription('Arena').setRequired(true).setAutocomplete(true)))
  .addSubcommand(s => s.setName('remove').setDescription('Delete an arena')
    .addStringOption(o => o.setName('name').setDescription('Arena').setRequired(true).setAutocomplete(true)));

const settings = new SlashCommandBuilder().setName('settings').setDescription('Admin: staff role and channels')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand(s => s.setName('view').setDescription('Show the current settings'))
  .addSubcommand(s => s.setName('check').setDescription('Check that everything is set up (Orion Drift, arenas, channels)'))
  .addSubcommand(s => s.setName('staff_role').setDescription('Set the staff role (leave empty to clear)')
    .addRoleOption(o => o.setName('role').setDescription('Role whose members count as tournament staff')))
  .addSubcommand(s => s.setName('log_channel').setDescription('Set where staff alerts and logs go (leave empty to clear)')
    .addChannelOption(o => o.setName('channel').setDescription('Staff log channel').addChannelTypes(ChannelType.GuildText)))
  .addSubcommand(s => s.setName('thread_channel').setDescription('Set the channel match threads are created in (leave empty to clear)')
    .addChannelOption(o => o.setName('channel').setDescription('Channel for match threads').addChannelTypes(ChannelType.GuildText)));

const help = new SlashCommandBuilder().setName('help').setDescription('How to use the tournament bot');

export const commands = [profile, team, tournament, match, admin, ban, unban, banlist, arena, settings, help].map(command => command.toJSON());
