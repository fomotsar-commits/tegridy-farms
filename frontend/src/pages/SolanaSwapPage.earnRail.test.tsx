import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, configure, within } from '@testing-library/react';
import { PublicKey } from '@solana/web3.js';
import type { ReactNode } from 'react';

/**
 * The Earn rail prints no rate that no read returned. Nothing on the page reads a
 * staking rate, so a card names its token and what it is, and the note under the rail
 * says so and where a rate is published. The harness is the one in
 * SolanaSwapPage.quoteUnavailable.test.tsx; nothing here reaches the wallet or a quote.
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
// Whether the venue takes a platform fee is an env fact read at import; a test sets it here.
const fee = vi.hoisted(() => ({ on: false }));
vi.mock('../lib/solana', async (orig) => ({
  ...(await orig<typeof import('../lib/solana')>()),
  isSolanaFeeConfigured: () => fee.on,
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
import { SOLANA_MAJOR_PAIR_FEE_BPS } from '../lib/solana';

beforeEach(() => {
  window.history.replaceState(null, '', '/solana');
  localStorage.clear();
  fee.on = false;
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

  it('with a fee set up, says it is on Jupiter’s route only, and the only percentage in the rail is that fee', () => {
    fee.on = true;
    render(<SolanaSwapPage />);
    const text = rail().textContent ?? '';
    // A rate is never among the percentages: the one figure is the platform fee. It is
    // printed twice: on the rail's visible line and in its small print (FinePrint).
    const percentages = text.match(/\d+(?:\.\d+)?\s*%/g) ?? [];
    expect(percentages.length).toBeGreaterThan(0);
    // SOL, USDC and staked SOL are majors, so a staked-SOL buy pays the lower major rate.
    expect([...new Set(percentages)]).toEqual([`${SOLANA_MAJOR_PAIR_FEE_BPS / 100}%`]);
    expect(text).toContain(`A ${percentages[0]} fee applies when the buy goes through Jupiter.`);
    // A buy that goes to one of our pools pays no platform fee, so the fee is never said of every buy.
    expect(text).toContain("A buy in one of our pools pays that pool's own fee inside the quote, and no platform fee on top.");
    expect(text).not.toMatch(/fee on the buy/);
  });

  it('with no fee set up, says no platform fee is charged and prints no percentage', () => {
    render(<SolanaSwapPage />);
    const text = rail().textContent ?? '';
    expect(text).toContain('No platform fee is charged on the buy.');
    expect(text).not.toMatch(/\d\s*%/);
  });

  it('carries no em dash', () => {
    render(<SolanaSwapPage />);
    expect(rail().textContent).not.toContain('—');
  });
});
