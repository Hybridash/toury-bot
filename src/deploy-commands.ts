import { REST, Routes } from 'discord.js';
import { config } from './config.js';
import { commands } from './commands.js';

const toGuild = process.argv.includes('--guild');
if (toGuild && !config.guildId) throw new Error('Set DISCORD_GUILD_ID in .env to deploy commands to one server.');

const rest = new REST({ version: '10' }).setToken(config.token);
const route = toGuild ? Routes.applicationGuildCommands(config.clientId, config.guildId!) : Routes.applicationCommands(config.clientId);

await rest.put(route, { body: commands });
console.log(`Registered ${commands.length} ${toGuild ? 'server' : 'global'} slash commands.`);
