import { aroundAll, expect, it } from 'vitest';
import { WalletReadyState } from '@solana/wallet-adapter-base';
import { PhantomWalletAdapter } from '@solana/wallet-adapter-phantom';

/**
 * Phantom's adapter looks for its extension once a second until it finds it, and in jsdom it
 * never does. setup.ts stops every interval a file started when the file ends, before vitest
 * deletes the window under it. The check runs after every afterAll, setup.ts's included: once
 * Phantom appears, a poll still running finds it within a second.
 */
type PhantomWindow = { isPhantomInstalled?: boolean; phantom?: { solana: { isPhantom: boolean } } };
function phantomAppears(present: boolean) {
  const w = window as unknown as PhantomWindow;
  if (present) {
    w.isPhantomInstalled = true;
    w.phantom = { solana: { isPhantom: true } };
  } else {
    delete w.isPhantomInstalled;
    delete w.phantom;
  }
}

let stillLooking: PhantomWalletAdapter;

aroundAll(async (runSuite) => {
  await runSuite();
  phantomAppears(true);
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  phantomAppears(false);
  expect(stillLooking.readyState).toBe(WalletReadyState.NotDetected);
});

it('a new adapter finds Phantom once it is there; this one is still looking when the file ends', () => {
  phantomAppears(true);
  expect(new PhantomWalletAdapter().readyState).toBe(WalletReadyState.Installed);
  phantomAppears(false);
  stillLooking = new PhantomWalletAdapter();
  expect(stillLooking.readyState).toBe(WalletReadyState.NotDetected);
});
