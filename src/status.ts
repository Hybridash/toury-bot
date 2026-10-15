/** When each background task last ran fine. Used by /health and the staff alerts. */
const lastOk = new Map<string, number>();
const MAX_AGE_MS = 5 * 60_000;

export const markOk = (task: string): void => { lastOk.set(task, Date.now()); };

export function health(now = Date.now()) {
  const age = (task: string) => (lastOk.has(task) ? Math.round((now - lastOk.get(task)!) / 1000) : null);
  const tasks = { scoring: age('scoring'), sync: age('sync') };
  return { ok: Object.values(tasks).every(a => a === null || a * 1000 <= MAX_AGE_MS), secondsSinceLastOk: tasks };
}
