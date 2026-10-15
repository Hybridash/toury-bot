import { createHmac } from 'node:crypto';

/**
 * Optional push to the website: set WEBHOOK_URL (and WEBHOOK_SECRET). Each event is POSTed as JSON
 * {event, at, data}, with the header `x-signature: sha256=<hex HMAC of the body>` when a secret is set.
 * Events: game.finished, match.finished, tournament.started, tournament.finished.
 * One retry after 2s; failures are logged and never block the bot.
 */
export type WebhookEvent = 'game.finished' | 'match.finished' | 'tournament.started' | 'tournament.finished';

export function sign(body: string, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

export async function emit(event: WebhookEvent, data: Record<string, unknown>): Promise<void> {
  const url = process.env.WEBHOOK_URL;
  if (!url) return;
  const body = JSON.stringify({ event, at: new Date().toISOString(), data });
  const secret = process.env.WEBHOOK_SECRET;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(secret ? { 'x-signature': sign(body, secret) } : {}) },
        body,
        signal: AbortSignal.timeout(5000)
      });
      if (response.ok) return;
      console.warn(`[webhook] ${event} -> HTTP ${response.status}`);
    } catch (error) {
      console.warn(`[webhook] ${event} failed: ${error instanceof Error ? error.message : error}`);
    }
    if (attempt === 1) await new Promise(r => setTimeout(r, 2000));
  }
}
