import { copyFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { db } from './db.js';

const KEEP = 14;

/** Copies the live database to <BACKUP_DIR>/tournament-<timestamp>.sqlite (safe while the bot is running) and keeps the newest 14. */
export async function backupDatabase(dir = process.env.BACKUP_DIR || './data/backups'): Promise<string | null> {
  if ((process.env.DATABASE_PATH || '') === ':memory:') return null;
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `tournament-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`);
  await db.backup(file);
  // Optional second copy somewhere else (another disk, a synced cloud folder) so a dead disk doesn't take the backups too.
  const copyDir = process.env.BACKUP_COPY_DIR;
  if (copyDir) { mkdirSync(copyDir, { recursive: true }); copyFileSync(file, join(copyDir, file.split('/').pop()!)); }
  const old = readdirSync(dir).filter(f => f.startsWith('tournament-') && f.endsWith('.sqlite')).sort().slice(0, -KEEP);
  for (const f of old) rmSync(join(dir, f), { force: true });
  return file;
}

/** One backup now, then one every 6 hours. */
export function startBackups(): void {
  const run = () => backupDatabase().then(f => f && console.log(`[backup] ${f}`)).catch(e => console.error('[backup] failed', e));
  void run();
  setInterval(run, 6 * 60 * 60_000).unref();
}
