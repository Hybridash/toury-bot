import dotenv from 'dotenv';
import { existsSync, readdirSync } from 'node:fs';

// Settings come from `.env`. `bot.env` also works, for hosts whose file manager can't create files starting with a dot.
for (const file of ['.env', 'bot.env']) if (existsSync(file)) dotenv.config({ path: file });

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    const here = readdirSync('.').filter(f => /env/i.test(f));
    throw new Error(`Missing required environment variable: ${name}. I looked for ".env" or "bot.env" in ${process.cwd()}. `
      + `Files there with "env" in the name: ${here.length ? here.map(f => `"${f}"`).join(', ') : 'none'}. `
      + 'The file must be in the same folder as package.json, named exactly .env (or bot.env), with lines like DISCORD_TOKEN=your-token (no spaces around "=").');
  }
  return value;
}

export const config = {
  token: required('DISCORD_TOKEN'),
  clientId: required('DISCORD_CLIENT_ID'),
  guildId: process.env.DISCORD_GUILD_ID || undefined,
  staffRoleId: process.env.STAFF_ROLE_ID || undefined,
  logChannelId: process.env.LOG_CHANNEL_ID || undefined
};
