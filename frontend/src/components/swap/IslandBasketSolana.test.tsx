import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithProviders } from '../../test-utils/render';
import { SOL_BASKET, type SolBasketCoin } from '../../lib/islandBasket';

const SOL = 'So11111111111111111111111111111111111111112';
const h = vi.hoisted(() => ({
  send: vi.fn(),
  prepare: vi.fn(),
  confirm: vi.fn(),
  balance: 10_000_000_000,
  failQuoteFor: null as string | null,
  own: [] as unknown[],
}));

vi.mock('@solana/wallet-adapter-react', () => ({
  useConnection: () => ({ connection: { getBalance: async () => h.balance, getBlockHeight: async () => 100 } }),
  useWallet: () => ({ publicKey: { toBase58: () => 'Buyer111111111111111111111111111111111111111' }, sendTransaction: h.send }),
}));
vi.mock('@solana/web3.js', async (orig) => {
  const real = await orig<typeof import('@solana/web3.js')>();
  return { ...real, VersionedTransaction: { deserialize: () => ({}) } };
});
vi.mock('../../lib/jupiter', async (orig) => ({
  ...(await orig<typeof import('../../lib/jupiter')>()),
  getUsdPrices: async () => ({ [SOL]: 100 }),
  // Every coin quoted through the pool the list names; `failQuoteFor` refuses one coin's quote every time.
  getQuote: async (p: { outputMint: string }) => {
    if (p.outputMint === h.failQuoteFor) throw new Error('Quote unavailable (429)');
    return {
    inputMint: SOL, outputMint: p.outputMint, inAmount: '1', outAmount: '5000000', otherAmountThreshold: '1', swapMode: 'ExactIn', slippageBps: 50, priceImpactPct: '0',
    routePlan: [{ percent: 100, swapInfo: { ammKey: SOL_BASKET.find((c) => c.mint === p.outputMint)!.pool.address } }],
    };
  },
}));
vi.mock('../../lib/solana/swap/islandBasketSol', async (orig) => ({ ...(await orig<typeof import('../../lib/solana/swap/islandBasketSol')>()), prepareSolLeg: h.prepare }));
vi.mock('./useSolanaRoute', () => ({ readOwnPoolsFor: async () => h.own }));
vi.mock('../../lib/solana/confirm', () => ({ pollConfirm: h.confirm }));
vi.mock('../../lib/solana/blockhashWindow', () => ({ blockhashSeen: async () => null, recentBlockhashOf: () => null }));
vi.mock('../../lib/solanaActivity', () => ({ recordActivity: vi.fn() }));
vi.mock('../../lib/heat/lastBuy', () => ({ setLastBuy: vi.fn() }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() } }));

import { IslandBasketSolana } from './IslandBasketSolana';

const ready = { kind: 'ready', quote: { outAmount: '5000000' }, swapTransaction: 'AAAA', siteFeeWaived: false };
const pending = () => ({ hold: vi.fn(), release: vi.fn(), holdsNow: vi.fn(() => false) });
const mount = (o: { pending?: ReturnType<typeof pending> } = {}) => {
  const p = o.pending ?? pending();
  const onOwnLeg = vi.fn<(coin: SolBasketCoin, lamports: bigint) => void>();
  renderWithProviders(<IslandBasketSolana slippageBps={50} priority="high" pending={p} onOwnLeg={onOwnLeg} busy={false} quoteGapMs={0} />);
  return { p, onOwnLeg };
};
const openAndPrice = async () => {
  fireEvent.click(screen.getByTestId('island-basket-open'));
  await waitFor(() => expect(screen.getByTestId('island-basket-buy')).toHaveTextContent('Buy all 5'), { timeout: 4000 });
};
const status = (room: string) => screen.getByTestId(`island-basket-row-${room}`);

beforeEach(() => {
  vi.clearAllMocks();
  h.balance = 10_000_000_000;
  h.failQuoteFor = null;
  h.own = [];
  h.prepare.mockResolvedValue(ready);
  let n = 0;
  h.send.mockImplementation(async () => `sig${++n}`);
  h.confirm.mockResolvedValue({ outcome: 'confirmed', slot: 1 });
});

describe('IslandBasketSolana', () => {
  it('lists the five Solana coins, each through its own pool', async () => {
    mount();
    expect(screen.getByTestId('island-basket-open')).toHaveTextContent('5');
    await openAndPrice();
    const list = screen.getByRole('list', { name: 'Coins in this order' });
    expect(within(list).getAllByText(/· PumpSwap via Jupiter$/)).toHaveLength(4);
    expect(within(list).getByText(/· Raydium via Jupiter$/)).toBeInTheDocument();
  });

  it('buys each coin in its own transaction, holding the wallet with a note until each confirms', async () => {
    const { p } = mount();
    await openAndPrice();
    fireEvent.click(screen.getByTestId('island-basket-buy'));
    await waitFor(() => expect(screen.getAllByText('Bought')).toHaveLength(5), { timeout: 4000 });
    expect(h.send).toHaveBeenCalledTimes(5);
    // One note per coin (each written again once its last valid block is read, as the swap does).
    expect([...new Set(p.hold.mock.calls.map((c) => c[0].signature))]).toEqual(['sig1', 'sig2', 'sig3', 'sig4', 'sig5']);
    expect(p.hold.mock.calls[0]![0]).toMatchObject({ kind: 'jupiter-swap', signature: 'sig1' });
    expect(p.release.mock.calls.map((c) => c[0])).toEqual(['sig1', 'sig2', 'sig3', 'sig4', 'sig5']);
    // Each coin's share went to its own build, in order.
    expect(h.prepare.mock.calls.map((c) => c[1].coin.symbol)).toEqual(SOL_BASKET.map((c) => c.symbol));
  });

  it('stops at a coin sent but not confirmed: the rest wait, so nothing is bought twice', async () => {
    h.confirm.mockResolvedValueOnce({ outcome: 'confirmed', slot: 1 }).mockResolvedValueOnce({ outcome: 'unknown', slot: null });
    const { p } = mount();
    await openAndPrice();
    fireEvent.click(screen.getByTestId('island-basket-buy'));
    await waitFor(() => expect(within(status('bobo')).getByText('Sent, not confirmed')).toBeInTheDocument(), { timeout: 4000 });
    expect(h.send).toHaveBeenCalledTimes(2);
    // Its note stands: only the confirmed one is released.
    expect(p.release.mock.calls.map((c) => c[0])).toEqual(['sig1']);
    await waitFor(() => expect(screen.getByTestId('island-basket-buy')).toHaveTextContent('Buy the 3 left'));
  });

  it('stops at a cancel in the wallet', async () => {
    h.send.mockRejectedValueOnce(Object.assign(new Error('User rejected the request.'), { name: 'WalletSignTransactionError', code: 4001 }));
    mount();
    await openAndPrice();
    fireEvent.click(screen.getByTestId('island-basket-buy'));
    await waitFor(() => expect(h.send).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByTestId('island-basket-buy')).toHaveTextContent('Buy all 5'));
    expect(h.prepare).toHaveBeenCalledTimes(1);
  });

  it('sends nothing while another swap from this wallet is unconfirmed: the wallet is not asked', async () => {
    const p = pending();
    p.holdsNow.mockReturnValue(true);
    mount({ pending: p });
    await openAndPrice();
    fireEvent.click(screen.getByTestId('island-basket-buy'));
    await waitFor(() => expect(screen.getByTestId('island-basket-notice')).toHaveTextContent(/not confirmed yet/));
    expect(h.send).not.toHaveBeenCalled();
  });

  it('hands a coin our pool wins to the swap form’s review, with its share', async () => {
    h.prepare.mockImplementation(async (_d: unknown, a: { coin: { symbol: string } }) => (a.coin.symbol === 'SOY' ? { kind: 'own' } : ready));
    const { onOwnLeg } = mount();
    await openAndPrice();
    fireEvent.click(screen.getByTestId('island-basket-buy'));
    await waitFor(() => expect(screen.getAllByText('Bought')).toHaveLength(4), { timeout: 4000 });
    expect(h.send).toHaveBeenCalledTimes(4);
    fireEvent.click(screen.getByRole('button', { name: 'Review SOY in our pool' }));
    expect(onOwnLeg).toHaveBeenCalledTimes(1);
    const [coin, lamports] = onOwnLeg.mock.calls[0]!;
    expect(coin.symbol).toBe('SOY');
    // $10 at $100 a SOL = 0.1 SOL, split five ways.
    expect(lamports).toBe(20_000_000n);
  });

  it('a coin that was not sent goes on to the next, and stays buyable', async () => {
    h.prepare.mockImplementation(async (_d: unknown, a: { coin: { symbol: string } }) => (a.coin.symbol === 'BOBO' ? { kind: 'not-sent', why: 'Its price dropped beyond your slippage since the order was shown, so nothing was sent for it.' } : ready));
    mount();
    await openAndPrice();
    fireEvent.click(screen.getByTestId('island-basket-buy'));
    await waitFor(() => expect(screen.getAllByText('Bought')).toHaveLength(4), { timeout: 4000 });
    expect(within(status('bobo')).getByText(/dropped beyond your slippage/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('island-basket-buy')).toHaveTextContent('Buy the 1 left'));
  });

  it('says when the wallet holds too little SOL', async () => {
    h.balance = 50_000_000;
    mount();
    fireEvent.click(screen.getByTestId('island-basket-open'));
    await waitFor(() => expect(screen.getByTestId('island-basket-buy')).toHaveTextContent('Not enough SOL'));
  });

  it('a Jupiter price that could not be read holds the order, even where our pool quotes: a failed read is never "our pool wins"', async () => {
    h.failQuoteFor = SOL_BASKET[0]!.mint;
    h.own = [{ venue: 'own-pool', outAmount: 1n, label: 'venue pool', poolAddress: 'OwnPool111' }];
    mount();
    fireEvent.click(screen.getByTestId('island-basket-open'));
    await waitFor(() => expect(screen.getByTestId('island-basket-buy')).toHaveTextContent('A price could not be read'), { timeout: 10_000 });
    expect(within(status('bayla')).getByText(/· Price not read$/)).toBeInTheDocument();
    expect(screen.getByTestId('island-basket-buy')).toBeDisabled();
    // Try again asks at once; a price that now answers frees the order.
    h.failQuoteFor = null;
    fireEvent.click(within(screen.getByTestId('island-basket-notice')).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.getByTestId('island-basket-buy')).toHaveTextContent('Buy all 5'), { timeout: 10_000 });
  }, 30_000);
});
