// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { getDefaultWallets } from '@rainbow-me/rainbowkit';

/**
 * WALLET-05 — pins RainbowKit's default wallet list, because wagmi.ts
 * positions our two vendored wallets BY INDEX inside it.
 *
 * Why by index at all: the only public path to a per-wallet definition is the
 * '@rainbow-me/rainbowkit/wallets' barrel, which cannot be imported here (it
 * fails the production build against wagmi 3.7.6 — see rainbowkitWallets.ts).
 * So wagmi.ts destructures the array getDefaultWallets() returns rather than
 * naming metaMaskWallet et al. directly. That is safe only while the order and
 * membership below hold, and this test is what makes a change to them loud.
 *
 * Order matters for a real user-visible reason: RainbowKit's MOBILE modal
 * renders wallets in a horizontal strip showing ~4 before a swipe, so a wallet
 * pushed down the list is effectively invisible on a phone.
 *
 * If this fails after a RainbowKit upgrade, do NOT just update the expectation
 * — re-check wagmi.ts's destructure, because the positions it relies on have
 * moved.
 */
describe('RainbowKit default wallet list (wagmi.ts positions against it)', () => {
  const ids = () => {
    const { wallets } = getDefaultWallets();
    expect(wallets).toHaveLength(1);
    // Factories need a projectId only to build a connector; calling them with a
    // dummy is enough to read identity, and a non-empty string keeps the
    // WalletConnect-backed ones from throwing "No projectId found".
    return wallets[0]!.wallets.map((w) => w({ projectId: 'test-project-id' } as never).id);
  };

  it('is exactly [safe, rainbow, base, metaMask, walletConnect], in that order', () => {
    expect(ids()).toEqual(['safe', 'rainbow', 'base', 'metaMask', 'walletConnect']);
  });

  it('still puts metaMask and walletConnect where wagmi.ts expects them', () => {
    // The two the destructure actually repositions; spelled out separately so a
    // failure names the specific assumption that broke.
    const list = ids();
    expect(list[3], 'wagmi.ts destructures index 3 as metaMask').toBe('metaMask');
    expect(list[4], 'wagmi.ts destructures index 4 as walletConnect').toBe('walletConnect');
  });
});
