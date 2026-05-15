/**
 * Tegridy Farms — Telegram notification bot.
 *
 * P2-8 of the 30-day UX push. Polls the Ponder indexer for events that
 * touch bound wallets, DMs the Telegram chats that bound them.
 *
 * Architecture:
 *   1. On boot — read .env, open storage, start the Telegram bot.
 *   2. Every POLL_INTERVAL_MS — run every watcher in `watchers.ts`.
 *      Watchers are independent; one failing doesn't stop the others.
 *   3. State (bindings, cursors, thresholds) persists to STATE_FILE.
 *
 * No queues, no clustering, no clever retries. Per the brief:
 * "Telegram bots are dumb cron jobs that send strings."
 */

import { config } from './config.js';
import { Storage } from './storage.js';
import { createBot } from './bot.js';
import { watchers } from './watchers.js';

async function tick(ctx: { bot: ReturnType<typeof createBot>; storage: Storage }) {
  // Watchers run serially — they share the same indexer endpoint and
  // running them in parallel would burn the upstream rate limit for no
  // wall-clock win in the common case (each watcher is fast).
  for (const watcher of watchers) {
    await watcher(ctx);
  }
}

async function main() {
  const storage = new Storage(config.stateFile);
  const bot = createBot(storage);
  const ctx = { bot, storage };

  console.log(`[bot] booted. polling indexer every ${config.pollIntervalMs}ms`);
  console.log(`[bot] state file: ${config.stateFile}`);
  console.log(`[bot] indexer: ${config.indexerUrl}`);

  // Run the first tick immediately so a freshly booted process catches
  // anything that fired during downtime.
  void tick(ctx);
  setInterval(() => void tick(ctx), config.pollIntervalMs);
}

main().catch((err) => {
  console.error('[bot] fatal:', err);
  process.exit(1);
});
