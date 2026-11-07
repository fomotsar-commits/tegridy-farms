import { afterEach, beforeEach } from 'vitest';

/**
 * Call once at the top of a file that mounts the real Solana providers. Each wallet
 * adapter polls once a second for its extension until it appears, and unmounting does
 * not stop it; in jsdom none appears. A poll left running fires after the file's
 * jsdom is gone, and Phantom's throws "window is not defined", failing the whole run.
 * This stops, after each test, every setInterval that test started.
 */
export function stopLeftoverIntervals(): void {
  const realSetInterval = globalThis.setInterval;
  const started: ReturnType<typeof setInterval>[] = [];
  beforeEach(() => {
    globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
      const id = realSetInterval(...args);
      started.push(id);
      return id;
    }) as typeof setInterval;
  });
  afterEach(() => {
    globalThis.setInterval = realSetInterval;
    for (const id of started.splice(0)) clearInterval(id);
  });
}
