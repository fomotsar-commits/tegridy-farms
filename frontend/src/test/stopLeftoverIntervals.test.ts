// @vitest-environment jsdom
/**
 * The real Phantom adapter's poll for its extension, started in one test, is
 * stopped before the next. Without stopLeftoverIntervals() it looks again a
 * second later, and in a file that ends there it looks after jsdom is gone.
 */
import { afterAll, expect, it } from 'vitest';
import { PhantomWalletAdapter } from '@solana/wallet-adapter-phantom';
import { stopLeftoverIntervals } from './stopLeftoverIntervals';

stopLeftoverIntervals();

// Each look reads window.isPhantomInstalled first.
let looks = 0;
Object.defineProperty(window, 'isPhantomInstalled', {
  configurable: true,
  get: () => {
    looks++;
    return false;
  },
});
afterAll(() => {
  delete (window as { isPhantomInstalled?: unknown }).isPhantomInstalled;
});

it('a Phantom adapter looks for its extension once, now, and starts a poll', () => {
  new PhantomWalletAdapter();
  expect(looks).toBe(1);
});

it('the poll is stopped when that test ends: a second later it has not looked again', async () => {
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  expect(looks).toBe(1);
});
