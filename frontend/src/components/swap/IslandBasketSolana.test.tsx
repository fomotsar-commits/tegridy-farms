import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithProviders } from '../../test-utils/render';
import { SOL_BASKET, shortAmount } from '../../lib/islandBasket';
import { SOLANA_PLATFORM_FEE_BPS, isSolanaFeeConfigured } from '../../lib/solana';

const SOL = 'So11111111111111111111111111111111111111112';
const h = vi.hoisted(() => ({
  send: vi.fn(),
  prepare: vi.fn(),
  build: vi.fn(),
  confirm: vi.fn(),
  balance: 10_000_000_000,
  failQuoteFor: null as string | null,
  own: [] as unknown[],
  /** This coin's Jupiter quote, or every read of our pools, waits until `release()`. */
  holdQuoteFor: null as string | null,
  holdOwn: false,
  /** Every Jupiter quote waits until `release()`. */
  holdAllQuotes: false,
  gate: Promise.resolve(),
  release: () => {},
  /** What the price read answers, and every call it got. */
  prices: {} as Record<string, number>,
  priceCalls: [] as unknown[][],
  /** The price read fails this many more times. */
  failPrices: 0,
  /** The wallet's "sign several at once", or none (a wallet asked once per coin). */
  signAll: null as null | ((txs: unknown[]) => Promise<unknown[]>),
  signOne: vi.fn(async (t: unknown) => t),
  sendSigned: vi.fn(),
  submitOwn: vi.fn(),
  prepareOwn: vi.fn(),
}));
const hold = () => { h.gate = new Promise<void>((r) => { h.release = r; }); };

const buyer = vi.hoisted(() => ({ toBase58: () => 'Buyer111111111111111111111111111111111111111' }));
vi.mock('@solana/wallet-adapter-react', () => ({
  useConnection: () => ({ connection: { getBalance: async () => h.balance, getBlockHeight: async () => 100, getLatestBlockhash: async () => ({ blockhash: 'FreshHash1111111111111111111111111111111111', lastValidBlockHeight: 250 }) } }),
  useWallet: () => ({ publicKey: buyer, sendTransaction: h.send, signTransaction: h.signOne, ...(h.signAll ? { signAllTransactions: h.signAll } : {}) }),
}));
vi.mock('@solana/web3.js', async (orig) => {
  const real = await orig<typeof import('@solana/web3.js')>();
  // A Jupiter coin's transaction: paid for by the buyer.
  return { ...real, VersionedTransaction: { deserialize: () => ({ version: 0, message: { recentBlockhash: 'OldHash', staticAccountKeys: [{ equals: () => true }] }, serialize: () => new Uint8Array([1]) }) } };
});
vi.mock('../../lib/jupiter', async (orig) => ({
  ...(await orig<typeof import('../../lib/jupiter')>()),
  getUsdPrices: async (...a: unknown[]) => { h.priceCalls.push(a); if (h.failPrices > 0) { h.failPrices--; throw new Error('Price fetch failed (502)'); } return h.prices; },
  buildSwapTransaction: (...a: unknown[]) => h.build(...a),
  // Every coin quoted through the pool the list names; `failQuoteFor` refuses one coin's quote every time.
  getQuote: async (p: { outputMint: string }) => {
    if (p.outputMint === h.failQuoteFor) throw new Error('Quote unavailable (429)');
    if (h.holdAllQuotes || p.outputMint === h.holdQuoteFor) await h.gate;
    return {
    inputMint: SOL, outputMint: p.outputMint, inAmount: '1', outAmount: '5000000', otherAmountThreshold: '1', swapMode: 'ExactIn', slippageBps: 50, priceImpactPct: '0',
    routePlan: [{ percent: 100, swapInfo: { ammKey: SOL_BASKET.find((c) => c.mint === p.outputMint)!.pool.address } }],
    };
  },
}));
const sigs = vi.hoisted(() => ({ n: 0 }));
vi.mock('../../lib/solana/swap/islandBasketSol', async (orig) => ({
  ...(await orig<typeof import('../../lib/solana/swap/islandBasketSol')>()),
  prepareSolLeg: h.prepare,
  sendSigned: h.sendSigned,
  signatureOf: () => `signed${++sigs.n}`,
}));
vi.mock('./useSolanaRoute', () => ({ readOwnPoolsFor: async () => { if (h.holdOwn) await h.gate; return h.own; } }));
vi.mock('../../lib/solana/confirm', () => ({ pollConfirm: h.confirm }));
vi.mock('../../lib/solana/blockhashWindow', () => ({ blockhashSeen: async () => null, recentBlockhashOf: () => null }));
vi.mock('../../lib/solanaActivity', () => ({ recordActivity: vi.fn() }));
vi.mock('../../lib/heat/lastBuy', () => ({ setLastBuy: vi.fn() }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() } }));

import { IslandBasketSolana } from './IslandBasketSolana';
import { JupiterBusyError } from '../../lib/solana/swap/jupiterBusy';

const ready = { kind: 'ready', quote: { outAmount: '5000000' }, swapTransaction: 'AAAA', siteFeeWaived: false };
const SOY = SOL_BASKET.find((c) => c.symbol === 'SOY')!;
/** Our pool takes SOY: prepareSolLeg's answer, and the swap our pool's builder makes for it. */
const ownSoy = { kind: 'own', pool: SOY.pool.address, aggregator: { kind: 'quoted', out: 5_000_000n, when: 'now' } };
const ownTx = { recentBlockhash: 'OldHash', feePayer: buyer };
const ownPrepared = { kind: 'venue-swap', tx: ownTx, blockhash: 'OldHash', lastValidBlockHeight: 120, summary: { kind: 'venue-swap', quoted: { outAmount: 6_000_000n } } };
const pending = () => ({ hold: vi.fn(), release: vi.fn(), holdsNow: vi.fn(() => false), sent: vi.fn(), record: vi.fn() });
const mount = (o: { pending?: ReturnType<typeof pending>; own?: boolean } = {}) => {
  const p = o.pending ?? pending();
  const ownSwap = o.own === false ? null : ({ api: { prepareVenueSwap: h.prepareOwn, submitPrepared: h.submitOwn }, gate: { kind: 'open' } } as never);
  const wantOwnSwap = vi.fn();
  renderWithProviders(<IslandBasketSolana slippageBps={50} priority="high" pending={p} ownSwap={ownSwap} wantOwnSwap={wantOwnSwap} busy={false} quoteGapMs={0} />);
  return { p, wantOwnSwap };
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
  h.holdQuoteFor = null;
  h.holdOwn = false;
  h.holdAllQuotes = false;
  h.gate = Promise.resolve();
  h.prices = { [SOL]: 100 };
  h.priceCalls = [];
  h.failPrices = 0;
  h.signAll = null;
  sigs.n = 0;
  ownTx.recentBlockhash = 'OldHash';
  h.prepare.mockResolvedValue(ready);
  h.prepareOwn.mockResolvedValue({ ok: true, prepared: ownPrepared });
  h.submitOwn.mockImplementation(async (_c: unknown, signer: { signTransaction: (t: unknown) => Promise<unknown> }, _p: unknown, d: { onSent: (s: string, h: number) => void }) => {
    await signer.signTransaction(ownTx);
    d.onSent('ownSig', 250);
    return { status: 'confirmed', signature: 'ownSig', slot: 1 };
  });
  h.sendSigned.mockResolvedValue({ kind: 'sent', outcome: 'confirmed' });
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

  it('buys a coin our pool wins in our pool, in the same order: nothing is handed to the swap form', async () => {
    h.prepare.mockImplementation(async (_d: unknown, a: { coin: { symbol: string } }) => (a.coin.symbol === 'SOY' ? ownSoy : ready));
    const { p, wantOwnSwap } = mount();
    await openAndPrice();
    // Opening the order asks the page for our pools' swap.
    expect(wantOwnSwap).toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('island-basket-buy'));
    await waitFor(() => expect(screen.getAllByText('Bought')).toHaveLength(5), { timeout: 4000 });
    expect(h.send).toHaveBeenCalledTimes(4);
    // SOY's share, in the pool our pool's check chose, held to Jupiter's figure.
    expect(h.prepareOwn).toHaveBeenCalledTimes(1);
    const args = h.prepareOwn.mock.calls[0]![2];
    expect(args.pool.toBase58()).toBe(SOY.pool.address);
    expect(args.outputMint.toBase58()).toBe(SOY.mint);
    // $10 at $100 a SOL = 0.1 SOL, split five ways.
    expect(args.amountIn).toBe(20_000_000n);
    expect(args.aggregator).toEqual(ownSoy.aggregator);
    // The wallet signs it; its note is the swap's own, written before it is sent and settled after.
    expect(h.signOne).toHaveBeenCalledWith(ownTx);
    expect(p.sent).toHaveBeenCalledWith('ownSig', ownPrepared);
    expect(p.record).toHaveBeenCalledWith(expect.objectContaining({ status: 'confirmed' }), ownPrepared, 'ownSig');
    expect(within(status('soy')).getByText(/· Our pool$/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Review .* in our pool/ })).not.toBeInTheDocument();
  });

  it('a coin our pool wins goes through Jupiter when our pools’ swap cannot be used here', async () => {
    // With our pools' swap unusable, the check sees no pool of ours at all.
    h.prepare.mockImplementation(async (d: { ownPools: () => Promise<unknown[] | null> }, a: { coin: { symbol: string }; shownOwn: unknown[] | null }) =>
      (a.coin.symbol === 'SOY' && (((await d.ownPools()) ?? []).length > 0 || (a.shownOwn ?? []).length > 0) ? ownSoy : ready));
    h.own = [{ venue: 'own-pool', outAmount: 9_000_000n, label: 'venue pool', poolAddress: 'OwnPool111' }];
    mount({ own: false });
    await openAndPrice();
    fireEvent.click(screen.getByTestId('island-basket-buy'));
    await waitFor(() => expect(screen.getAllByText('Bought')).toHaveLength(5), { timeout: 4000 });
    expect(h.send).toHaveBeenCalledTimes(5);
    expect(h.prepareOwn).not.toHaveBeenCalled();
    expect(within(status('soy')).getByText(/· PumpSwap via Jupiter$/)).toBeInTheDocument();
  });

  it('a wallet that signs several at once is asked ONCE for the whole order, every coin on one fresh blockhash', async () => {
    const asked: unknown[][] = [];
    h.signAll = async (txs) => { asked.push(txs); return txs; };
    h.prepare.mockImplementation(async (_d: unknown, a: { coin: { symbol: string } }) => (a.coin.symbol === 'SOY' ? ownSoy : ready));
    const { p } = mount();
    await openAndPrice();
    fireEvent.click(screen.getByTestId('island-basket-buy'));
    await waitFor(() => expect(screen.getAllByText('Bought')).toHaveLength(5), { timeout: 4000 });
    // Every coin is already signed once the wallet answers: there is no coin to stop after.
    expect(screen.queryByText('Stop after this coin')).not.toBeInTheDocument();
    expect(asked).toHaveLength(1);
    expect(asked[0]).toHaveLength(5);
    // Four Jupiter coins and our pool's SOY, in the order's order, all on the blockhash read just before the prompt.
    expect(asked[0]![2]).toBe(ownTx);
    expect(ownTx.recentBlockhash).toBe('FreshHash1111111111111111111111111111111111');
    for (const k of [0, 1, 3, 4]) expect((asked[0]![k] as { message: { recentBlockhash: string } }).message.recentBlockhash).toBe('FreshHash1111111111111111111111111111111111');
    // Nothing is sent by the wallet: our RPC sends each signed coin, its note written first.
    expect(h.send).not.toHaveBeenCalled();
    expect(h.sendSigned).toHaveBeenCalledTimes(4);
    expect([...new Set(p.hold.mock.calls.map((c) => c[0].signature))].sort()).toEqual(['signed1', 'signed2', 'signed3', 'signed4']);
    expect(p.release.mock.calls.map((c) => c[0]).sort()).toEqual(['signed1', 'signed2', 'signed3', 'signed4']);
    // Our pool's coin goes through the write layer's own send, handed what the wallet signed, in the fresh blockhash's window.
    expect(h.submitOwn).toHaveBeenCalledTimes(1);
    expect(h.submitOwn.mock.calls[0]![2]).toMatchObject({ blockhash: 'FreshHash1111111111111111111111111111111111', lastValidBlockHeight: 250 });
    expect(h.signOne).not.toHaveBeenCalled();
  });

  it('a cancel of the one approval sends nothing, and every coin stays buyable', async () => {
    h.signAll = async () => { throw Object.assign(new Error('User rejected the request.'), { name: 'WalletSignTransactionError', code: 4001 }); };
    mount();
    await openAndPrice();
    fireEvent.click(screen.getByTestId('island-basket-buy'));
    await waitFor(() => expect(within(status('bayla')).getByText(/wallet/i)).toBeInTheDocument(), { timeout: 4000 });
    await waitFor(() => expect(screen.getByTestId('island-basket-buy')).toHaveTextContent('Buy all 5'));
    expect(h.sendSigned).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
    expect(screen.queryByText('Bought')).not.toBeInTheDocument();
  });

  it('with one approval, a coin the network turns away at its first send is not bought, and stays buyable; the rest are bought', async () => {
    h.signAll = async (txs) => txs;
    h.sendSigned.mockResolvedValueOnce({ kind: 'sent', outcome: 'confirmed' }).mockResolvedValueOnce({ kind: 'not-sent', why: 'It took too long to approve in your wallet, so it ran out of time. Nothing was sent for it.' });
    const { p } = mount();
    await openAndPrice();
    fireEvent.click(screen.getByTestId('island-basket-buy'));
    await waitFor(() => expect(screen.getAllByText('Bought')).toHaveLength(4), { timeout: 4000 });
    expect(within(status('bobo')).getByText(/took too long to approve/)).toBeInTheDocument();
    // Its note goes: it never reached the chain.
    expect(p.release.mock.calls.map((c) => c[0])).toContain('signed2');
    await waitFor(() => expect(screen.getByTestId('island-basket-buy')).toHaveTextContent('Buy the 1 left'));
  });

  it('with one approval, the wallet is not asked while another swap from it is unconfirmed', async () => {
    const asked = vi.fn(async (txs: unknown[]) => txs);
    h.signAll = asked;
    const p = pending();
    p.holdsNow.mockReturnValue(true);
    mount({ pending: p });
    await openAndPrice();
    fireEvent.click(screen.getByTestId('island-basket-buy'));
    await waitFor(() => expect(screen.getByTestId('island-basket-notice')).toHaveTextContent(/not confirmed yet/), { timeout: 4000 });
    expect(asked).not.toHaveBeenCalled();
    expect(h.sendSigned).not.toHaveBeenCalled();
  });

  it('a SOL price that could not be read is asked again within seconds, and the order is sized as soon as it answers', async () => {
    h.failPrices = 2;
    mount();
    fireEvent.click(screen.getByTestId('island-basket-open'));
    await waitFor(() => expect(screen.getByTestId('island-basket-notice')).toHaveTextContent(/SOL’s price could not be read yet/));
    // Asked again by itself, within seconds; the read after the failures answers.
    await waitFor(() => expect(screen.getByTestId('island-basket-buy')).toHaveTextContent('Buy all 5'), { timeout: 9000 });
    expect(h.priceCalls.length).toBeGreaterThanOrEqual(3);
  }, 20_000);

  it('a build Jupiter refuses once is asked again: every coin is bought', async () => {
    let refused = 0;
    h.build.mockImplementation(async () => {
      if (refused++ === 0) throw new JupiterBusyError('Could not build swap (502)', 502);
      return 'AAAA';
    });
    h.prepare.mockImplementation(async (d: { buildSwapTransaction: (p: unknown) => Promise<string> }) => ({ ...ready, swapTransaction: await d.buildSwapTransaction({}) }));
    mount();
    await openAndPrice();
    fireEvent.click(screen.getByTestId('island-basket-buy'));
    await waitFor(() => expect(screen.getAllByText('Bought')).toHaveLength(5), { timeout: 10_000 });
    expect(h.build).toHaveBeenCalledTimes(6);
  }, 20_000);

  it('a coin that was not sent goes on to the next, and stays buyable', async () => {
    h.prepare.mockImplementation(async (_d: unknown, a: { coin: { symbol: string } }) => (a.coin.symbol === 'BOBO' ? { kind: 'not-sent', why: 'Its price dropped beyond your slippage since the order was shown, so nothing was sent for it.' } : ready));
    mount();
    await openAndPrice();
    fireEvent.click(screen.getByTestId('island-basket-buy'));
    await waitFor(() => expect(screen.getAllByText('Bought')).toHaveLength(4), { timeout: 4000 });
    expect(within(status('bobo')).getByText(/dropped beyond your slippage/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('island-basket-buy')).toHaveTextContent('Buy the 1 left'));
  });

  it('reads SOL’s and every coin’s price once, shared, as soon as the stub is shown: opening reads none again', async () => {
    mount();
    await waitFor(() => expect(h.priceCalls).toHaveLength(1));
    expect(h.priceCalls[0]).toEqual([[SOL, ...SOL_BASKET.map((c) => c.mint)], undefined, { shared: true }]);
    fireEvent.click(screen.getByTestId('island-basket-open'));
    await waitFor(() => expect(screen.getByTestId('island-basket-buy')).toHaveTextContent('Buy all 5'), { timeout: 4000 });
    expect(h.priceCalls).toHaveLength(1);
  });

  it('opens with every coin’s figure at its market price, before any quote lands; each quote replaces it, and Buy waits for them', async () => {
    hold();
    h.holdAllQuotes = true;
    // $10 at $100 a SOL, $2 a coin: at $0.001 a coin, 2,000 of each, less the site fee where one is taken.
    h.prices = { [SOL]: 100, ...Object.fromEntries(SOL_BASKET.map((c) => [c.mint, 0.001])) };
    const each = `≈ ${shortAmount(2000 * (1 - (isSolanaFeeConfigured() ? SOLANA_PLATFORM_FEE_BPS / 10_000 : 0)))}`;
    mount();
    await waitFor(() => expect(h.priceCalls).toHaveLength(1));
    // The read answers while the order is still closed.
    await act(async () => {});
    fireEvent.click(screen.getByTestId('island-basket-open'));
    for (const c of SOL_BASKET) {
      expect(within(status(c.room)).getByText(each)).toBeInTheDocument();
      expect(within(status(c.room)).getByText(/· market price$/)).toBeInTheDocument();
    }
    expect(screen.getByTestId('island-basket-buy')).toHaveTextContent('Getting prices…');
    expect(screen.getByTestId('island-basket-buy')).toBeDisabled();
    h.release();
    // The quote's own figure (5 of a six-decimal coin) and route replace the market price.
    await waitFor(() => expect(within(status('bayla')).getByText('≈ 5')).toBeInTheDocument(), { timeout: 4000 });
    expect(within(status('bayla')).getByText(/· PumpSwap via Jupiter$/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('island-basket-buy')).toHaveTextContent('Buy all 5'), { timeout: 4000 });
    expect(screen.queryByText(/· market price$/)).not.toBeInTheDocument();
  });

  it('shows each coin’s figure as it is read: the first coin is priced while the last coin’s quote is still on its way', async () => {
    hold();
    h.holdQuoteFor = SOL_BASKET[4]!.mint;
    mount();
    fireEvent.click(screen.getByTestId('island-basket-open'));
    await waitFor(() => expect(within(status('bayla')).getByText(/^≈ /)).toBeInTheDocument(), { timeout: 4000 });
    expect(within(status('bayla')).getByText(/· PumpSwap via Jupiter$/)).toBeInTheDocument();
    expect(within(status('brainlet')).getByText(/^≈ /)).toBeInTheDocument();
    expect(within(status('rizz')).queryByText(/^≈ /)).not.toBeInTheDocument();
    // Nothing is bought on four prices.
    expect(screen.getByTestId('island-basket-buy')).toHaveTextContent('Getting prices…');
    expect(screen.getByTestId('island-basket-buy')).toBeDisabled();
    h.release();
    await waitFor(() => expect(within(status('rizz')).getByText(/^≈ /)).toBeInTheDocument());
    await waitFor(() => expect(screen.getByTestId('island-basket-buy')).toHaveTextContent('Buy all 5'));
  });

  it('a read of our pools on its way holds no Jupiter figure: the figures show, and the order waits for the comparison', async () => {
    hold();
    h.holdOwn = true;
    h.own = [{ venue: 'own-pool', outAmount: 9_000_000n, label: 'venue pool', poolAddress: 'OwnPool111' }];
    mount();
    fireEvent.click(screen.getByTestId('island-basket-open'));
    await waitFor(() => expect(within(status('rizz')).getByText(/^≈ /)).toBeInTheDocument(), { timeout: 4000 });
    expect(within(status('bayla')).getByText(/· PumpSwap via Jupiter$/)).toBeInTheDocument();
    expect(within(status('bayla')).getByText('Comparing our pool…')).toBeInTheDocument();
    expect(screen.getByTestId('island-basket-buy')).toHaveTextContent('Getting prices…');
    expect(screen.getByTestId('island-basket-buy')).toBeDisabled();
    h.release();
    // Our pool pays more than Jupiter here (9 to 5): read, it takes the coin.
    await waitFor(() => expect(within(status('bayla')).getByText(/· Our pool$/)).toBeInTheDocument());
    expect(within(status('bayla')).queryByText('Comparing our pool…')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('island-basket-buy')).toHaveTextContent('Buy all 5'));
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
