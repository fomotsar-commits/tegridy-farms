import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, configure } from '@testing-library/react';
import { PublicKey } from '@solana/web3.js';
import type { ReactNode } from 'react';
import type { SolToken } from '../lib/solanaTokenList';

/**
 * $BAYLA FIRST (the owner, 2026-10-03; the island's venue review, item 8).
 *
 * /solana used to open SOL to USDC. It opens SOL to $BAYLA now, and in a Solana room,
 * SOL to that room's coin. A link's own ?out= still wins. $BAYLA asks for no tick box
 * (the owner, 2026-10-08: none for the venue's own coins); a room's coin that is not
 * the venue's still gets one. lib/solanaOpeningPair.test.ts pins the choice; this file
 * pins that the page makes it.
 */

vi.setConfig({ testTimeout: 30_000 });
configure({ asyncUtilTimeout: 10_000 });

const USER = new PublicKey('5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9');
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const BAYLA_MINT = '7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump';
const BOBO_MINT = '4nV5gNwwP68zUDat26ySChREqVaQaLudfJBkSgEzpump';

const h = vi.hoisted(() => ({ resolveMint: vi.fn() }));

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
  resolveMint: h.resolveMint,
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

/** The coin on the buy side, read from the button that names it. */
const buying = () =>
  screen.queryByRole('button', { name: /^About .+: age, holders, authorities$/ })?.getAttribute('aria-label')?.replace(/^About (.+): .*$/, '$1') ?? null;
const paying = () => screen.queryByLabelText(/^Amount of .+ to pay$/)?.getAttribute('aria-label')?.replace(/^Amount of (.+) to pay$/, '$1') ?? null;
const tickBox = () => document.querySelector<HTMLInputElement>('label input[type="checkbox"]');

function open(url: string, storedRoom?: string) {
  window.history.replaceState(null, '', url);
  if (storedRoom) localStorage.setItem('tegridy-bungalow', storedRoom);
  return render(<SolanaSwapPage />);
}

beforeEach(() => {
  localStorage.clear();
  h.resolveMint.mockReset();
  h.resolveMint.mockResolvedValue(null);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  window.history.replaceState(null, '', '/');
});

describe('/solana opens SOL to $BAYLA', () => {
  it('pays SOL and buys BAYLA when the link names no coin', async () => {
    open('/solana');
    await waitFor(() => expect(buying()).toBe('BAYLA'));
    expect(paying()).toBe('SOL');
  });

  it('asks for no tick box on the pair it opens on, and asks no lookup for it', async () => {
    open('/solana');
    await waitFor(() => expect(buying()).toBe('BAYLA'));
    expect(tickBox(), 'the venue’s own coins ask for no tick').toBeNull();
    expect(document.body.textContent).not.toContain('an unverified token');
    expect(h.resolveMint).not.toHaveBeenCalled();
  });

  it('still opens on the coin a link names', async () => {
    open(`/solana?out=${USDC_MINT}`);
    await waitFor(() => expect(buying()).toBe('USDC'));
    expect(tickBox(), 'two verified coins need no tick').toBeNull();
  });

  it('buys USDC, never BAYLA with BAYLA, on a link that pays with it', async () => {
    open(`/solana?in=${BAYLA_MINT}`);
    await waitFor(() => expect(paying()).toBe('BAYLA'));
    expect(buying()).toBe('USDC');
  });
});

describe('/solana in a room', () => {
  const BOBO: SolToken = { mint: BOBO_MINT, symbol: 'BOBO', name: 'BOBO', decimals: 6 };

  it('opens on the room’s coin in a Solana room, looked up like any ?out= link', async () => {
    h.resolveMint.mockResolvedValue(BOBO);
    open('/solana', 'bobo');
    await waitFor(() => expect(buying()).toBe('BOBO'));
    expect(h.resolveMint.mock.calls.map((c) => c[0])).toEqual([BOBO_MINT]);
    expect(paying()).toBe('SOL');
  });

  it('keeps the tick box, unticked, for a room’s coin that is not the venue’s own', async () => {
    h.resolveMint.mockResolvedValue(BOBO);
    open('/solana', 'bobo');
    await waitFor(() => expect(buying()).toBe('BOBO'));
    const box = tickBox();
    expect(box, 'the risk tick box is on the form').not.toBeNull();
    expect(box!.checked).toBe(false);
    expect(box!.closest('label')?.textContent).toContain('an unverified token');
  });

  it('stays on $BAYLA when the room’s coin could not be looked up', async () => {
    h.resolveMint.mockRejectedValue(new Error('offline'));
    open('/solana', 'bobo');
    await waitFor(() => expect(h.resolveMint).toHaveBeenCalled());
    expect(buying()).toBe('BAYLA');
  });

  it('opens on $BAYLA in the BAYLA room and in a room on another chain', async () => {
    open('/solana', 'bayla');
    await waitFor(() => expect(buying()).toBe('BAYLA'));
    cleanup();
    open('/solana', 'pepe');
    await waitFor(() => expect(buying()).toBe('BAYLA'));
    expect(h.resolveMint).not.toHaveBeenCalled();
  });

  it('lets a link’s ?out= win over the room', async () => {
    open(`/solana?out=${USDC_MINT}`, 'bobo');
    await waitFor(() => expect(buying()).toBe('USDC'));
    expect(h.resolveMint).not.toHaveBeenCalled();
  });
});
