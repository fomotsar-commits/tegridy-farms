import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, configure, within } from '@testing-library/react';
import { PublicKey } from '@solana/web3.js';
import type { ReactNode } from 'react';

/**
 * THE EARN RAIL PRINTS NO RATE THAT NO READ RETURNED.
 *
 * Each liquid-staking card used to read "~7.5% APY · Jito", and three more like it. The
 * four figures were typed into lib/solanaTokenList.ts; nothing on the page reads a
 * staking rate. The rule is the page's own: a number is shown only when a read returned
 * it. So a card names its token and what it is, and the note under the rail says the
 * page reads no rate and where one is published.
 *
 * The harness is SolanaSwapPage.quoteUnavailable.test.tsx's. Nothing here reaches the
 * wallet or asks for a quote.
 */

vi.setConfig({ testTimeout: 30_000 });
configure({ asyncUtilTimeout: 10_000 });

const USER = new PublicKey('5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9');

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));
vi.mock('../lib/analytics', () => ({ trackPageView: vi.fn() }));
vi.mock('../hooks/usePageTitle', () => ({ usePageTitle: vi.fn() }));
vi.mock('../components/ArtImg', () => ({ ArtImg: () => null }));
vi.mock('../components/ClockLine', () => ({ ClockLine: () => null }));
vi.mock('../components/swap/ChainSwitch', () => ({ ChainSwitch: () => null }));
vi.mock('../components/swap/SolanaRouteLine', () => ({ SolanaRouteLine: () => null }));
vi.mock('../components/solana/PairChart', () => ({ PairChart: () => null }));
vi.mock('../components/solana/TokenDetail', () => ({ TokenDetail: () => null }));
vi.mock('../components/solana/SolanaConnectButton', () => ({ SolanaConnectButton: () => null }));
vi.mock('../components/solana/SolanaProviders', () => ({ SolanaProviders: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('../lib/solanaTokenList', async (orig) => ({
  ...(await orig<typeof import('../lib/solanaTokenList')>()),
  fetchTrending: vi.fn(async () => []),
}));
vi.mock('../lib/jupiter', async (orig) => ({
  ...(await orig<typeof import('../lib/jupiter')>()),
  getQuote: vi.fn(async () => { throw new Error('no quote is asked for here'); }),
  getUsdPrices: vi.fn(async () => ({})),
  getShield: vi.fn(async () => ({})),
}));
const connection = {
  getBalance: async () => 5_000_000_000,
  getParsedTokenAccountsByOwner: async () => ({ value: [] }),
  getSignatureStatuses: async () => ({ value: [null] }),
};
const wallet = { publicKey: USER, sendTransaction: vi.fn() };
vi.mock('@solana/wallet-adapter-react', () => ({
  useConnection: () => ({ connection }),
  useWallet: () => wallet,
}));

import SolanaSwapPage from './SolanaSwapPage';
import { LST_TOKENS } from '../lib/solanaTokenList';

beforeEach(() => {
  window.history.replaceState(null, '', '/solana');
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

const rail = () => screen.getByTestId('solana-earn-rail');
const cards = () => within(rail()).getAllByRole('button');

describe('SolanaSwapPage: the Earn rail names each staking token and prints no rate', () => {
  it('has one card for each token on the list, named by symbol and by what it is', () => {
    render(<SolanaSwapPage />);
    expect(cards()).toHaveLength(LST_TOKENS.length);
    for (const t of LST_TOKENS) {
      const card = cards().find((c) => c.textContent?.includes(t.symbol));
      expect(card, t.symbol).toBeTruthy();
      expect(card!, t.symbol).toHaveTextContent(t.name);
    }
  });

  it('no card carries a number: the page reads no staking rate, so it shows none', () => {
    render(<SolanaSwapPage />);
    for (const c of cards()) expect(c.textContent, c.textContent ?? '').not.toMatch(/\d/);
    expect(rail().textContent).not.toMatch(/\bAP[YR]\b/);
  });

  it('says in words that no rate is read here, and where one is published', () => {
    render(<SolanaSwapPage />);
    expect(rail()).toHaveTextContent(/reads no staking rate/i);
    expect(rail()).toHaveTextContent(/each provider publishes its own/i);
  });

  it('says how the venue earns on the buy, and the only percentage in the rail is that fee', () => {
    render(<SolanaSwapPage />);
    const text = rail().textContent ?? '';
    // Fee set or not, the venue's take is stated; a rate is never among the percentages.
    expect(text).toMatch(/The venue takes (?:a \d+(?:\.\d+)?% fee|no fee) on the buy\./);
    const percentages = text.match(/\d+(?:\.\d+)?\s*%/g) ?? [];
    expect(percentages.length).toBeLessThanOrEqual(1);
    if (percentages.length === 1) expect(text).toContain(`The venue takes a ${percentages[0]} fee on the buy.`);
  });

  it('carries no em dash', () => {
    render(<SolanaSwapPage />);
    expect(rail().textContent).not.toContain('—');
  });
});
