import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { PublicKey, type VersionedTransaction } from '@solana/web3.js';
import type { ReactNode } from 'react';
import { NoRouteError, type JupiterQuote, type SwapSimulation } from '../lib/jupiter';
import type { OwnCandidate, OwnQuotes } from '../lib/solana/swap/ownPools';
import type { OwnSend, OwnSide } from '../lib/solana/swap/venueChoice';
import type { LpWriteApi, Prepared, PreparedTx, TxOutcome } from '../components/solana/curve/ports';

/**
 * THE SWAP PAGE SENDS A TRADE TO OUR POOL WHEN OUR POOL PAYS AT LEAST AS MUCH.
 *
 * Owner, 2026-10-07: "wire up so our pool gets hit when its more efficient". Before this
 * the page compared one of our pools with Jupiter and then sent Jupiter's transaction
 * whatever the comparison said: every case below that expects our pool's builder fails
 * on that code, because the page had no way to build a trade in our pool.
 *
 * Our pools' reads and the write layer's gate are stubbed here (their own tests are
 * useOwnPoolRoute.test.ts, ownPools.test.ts, useOwnPoolWrites.test.tsx); the decision,
 * the settle at the press, the review flow and Jupiter's path are the page's real code.
 */

const USER = new PublicKey('5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9');
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const POOL = new PublicKey(new Uint8Array(32).fill(30));
const SIG = '5'.repeat(88);

// The fee build and the no-fee rebuild, as in SolanaSwapPage.feeRetry.test.tsx.
const TX_HEAD =
  'AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAQABAkjAG1BZAFRV2dywxrzs3LT7Wy6rwamoK1c5K6qkDwTmBHnVW/IxwG7udMVuzmgVB/2xst6j9I5RArHNola8E48AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEBAAE';
const TX_FEE = `${TX_HEAD}BAA==`;
const TX_NO_FEE = `${TX_HEAD}CAA==`;

function quote(over: Partial<JupiterQuote> = {}): JupiterQuote {
  return {
    inputMint: SOL_MINT, outputMint: USDC_MINT, inAmount: '100000000', outAmount: '14925000', otherAmountThreshold: '14850375',
    swapMode: 'ExactIn', slippageBps: 50, priceImpactPct: '0', routePlan: [], platformFee: { amount: '75000', feeBps: 50 },
    ...over,
  };
}
// 14.925 USDC with the site fee priced in; 15 without it.
const FEE_QUOTE = quote();
const NO_FEE_QUOTE = quote({ outAmount: '15000000', otherAmountThreshold: '14925000', platformFee: null });
const OK: SwapSimulation = { ok: true, reason: null, jupiterIncorrectTokenProgram: false };
const JUP_6014: SwapSimulation = { ok: false, reason: 'custom program error: 0x177e', jupiterIncorrectTokenProgram: true };

const h = vi.hoisted(() => ({
  getQuote: vi.fn(),
  buildSwapTransaction: vi.fn(),
  simulateSwap: vi.fn(),
  sendTransaction: vi.fn(),
  getBlockHeight: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
  own: { kind: 'pending' } as unknown,
  quoteNow: vi.fn(),
  routeArgs: [] as unknown[],
  wanted: [] as boolean[],
  send: { kind: 'yes' } as unknown,
  api: null as unknown,
  check: vi.fn(),
}));

vi.mock('sonner', () => ({ toast: h.toast }));
vi.mock('../lib/analytics', () => ({ trackPageView: vi.fn() }));
vi.mock('../hooks/usePageTitle', () => ({ usePageTitle: vi.fn() }));
vi.mock('../components/ArtImg', () => ({ ArtImg: () => null }));
vi.mock('../components/ClockLine', () => ({ ClockLine: () => null }));
vi.mock('../components/swap/ChainSwitch', () => ({ ChainSwitch: () => null }));
vi.mock('../components/solana/PairChart', () => ({ PairChart: () => null }));
vi.mock('../components/solana/TokenDetail', () => ({ TokenDetail: () => null }));
vi.mock('../components/solana/SolanaConnectButton', () => ({ SolanaConnectButton: () => null }));
vi.mock('../components/solana/SolanaProviders', () => ({ SolanaProviders: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('../lib/solanaTokenList', async (orig) => ({
  ...(await orig<typeof import('../lib/solanaTokenList')>()),
  fetchTrending: vi.fn(async () => []),
}));
vi.mock('../lib/solana', async (orig) => ({
  ...(await orig<typeof import('../lib/solana')>()),
  isSolanaFeeConfigured: () => true,
}));
vi.mock('../lib/jupiter', async (orig) => ({
  ...(await orig<typeof import('../lib/jupiter')>()),
  getQuote: h.getQuote,
  buildSwapTransaction: h.buildSwapTransaction,
  simulateSwap: h.simulateSwap,
  swapCarriesPlatformFee: () => true,
  getUsdPrices: vi.fn(async () => ({})),
  getShield: vi.fn(async () => ({})),
}));
vi.mock('../lib/solana/confirm', async (orig) => {
  const real = await orig<typeof import('../lib/solana/confirm')>();
  return {
    ...real,
    pollConfirm: (conn: Parameters<typeof real.pollConfirm>[0], sig: string, timeoutMs?: number) => {
      let t = 0;
      return real.pollConfirm(conn, sig, timeoutMs, async (ms: number) => { t += ms; }, () => t);
    },
  };
});
vi.mock('../components/swap/useOwnPoolRoute', () => ({
  useOwnPoolRoute: (a: unknown) => {
    h.routeArgs.push(a);
    return { own: h.own, quoteNow: h.quoteNow };
  },
}));
// The real pending notes, over a stubbed gate: the notes are what hold Buy.
vi.mock('../components/swap/useOwnPoolWrites', async () => {
  const { usePendingTrades } = await import('../components/solana/curve/usePendingTrades');
  const { SWAP_PENDING_SCOPE } = await import('../components/solana/curve/pendingTrade');
  const { lpOpenGate } = await import('../components/solana/lp/fakeLpWriteApi.fixture');
  const gate = lpOpenGate();
  // Read at render time: this factory runs before the file's own constants exist.
  let signer: { publicKey: PublicKey; signTransaction: <T>(t: T) => Promise<T> } | null = null;
  return {
    useOwnPoolWrites: (o: { wanted: boolean; onResolved: () => void }) => {
      h.wanted.push(o.wanted);
      const pending = usePendingTrades(SWAP_PENDING_SCOPE, h.check, o.onResolved, { live: true });
      signer ??= { publicKey: USER, signTransaction: async <T,>(t: T) => t };
      return { send: h.send, api: h.api, gate, cfg: gate.cfg, signer, signerState: { kind: 'ready', signer, address: USER.toBase58(), signMessage: null }, rpc: connection, pending, refreshGate: () => {} };
    },
  };
});
const connection = {
  getBalance: async () => 5_000_000_000,
  getParsedTokenAccountsByOwner: async () => ({ value: [] }),
  getSignatureStatuses: async () => ({ value: [{ err: null, confirmationStatus: 'confirmed' }] }),
  getBlockHeight: (...a: unknown[]) => h.getBlockHeight(...a) as Promise<number>,
};
const wallet = { publicKey: USER, sendTransaction: h.sendTransaction };
vi.mock('@solana/wallet-adapter-react', () => ({
  useConnection: () => ({ connection }),
  useWallet: () => wallet,
}));

import SolanaSwapPage from './SolanaSwapPage';
import { getActivity } from '../lib/solanaActivity';
import { fakeLpApi, tier1Config, venueSwapSummary } from '../components/solana/lp/fakeLpWriteApi.fixture';
import { prepared } from '../components/solana/curve/fakeWriteApi.fixture';
import { SWAP_PENDING_SCOPE, savePendingTrade } from '../components/solana/curve/pendingTrade';

vi.setConfig({ testTimeout: 30_000 });

function candidate(out: bigint): OwnCandidate {
  return {
    view: { address: POOL.toBase58(), origin: 'standard', config: tier1Config(), snapshot: { pool: { enableCreatorFee: false } }, quoteReserve: 1n },
    quote: { poolAddress: POOL.toBase58(), outAmount: out, priceImpact: 0.001, reserveIn: 1n, reserveOut: 1n, creatorFeeOnInput: true, result: {} },
  } as unknown as OwnCandidate;
}
const quotes = (out: bigint): OwnQuotes => ({ found: 1, gaps: [], best: candidate(out), excluded: [] });
const ownAt = (out: bigint) => ({ kind: 'ok', quotes: quotes(out) }) as OwnSide;

/** A swap of 0.1 SOL for USDC in our pool, as the builder would return it. */
function built(out: bigint): Prepared {
  const summary = venueSwapSummary(POOL, new PublicKey(USDC_MINT), {
    output: { mint: new PublicKey(USDC_MINT), symbol: 'USDC', decimals: 6 },
    amountIn: 100_000_000n,
    minimumAmountOut: (out * 9_950n) / 10_000n,
    quote: { ...venueSwapSummary(POOL, new PublicKey(USDC_MINT)).quote, outAmount: out },
    outputAccountRent: 0n,
  });
  return { ok: true, prepared: prepared(summary) };
}

let api: LpWriteApi;
function useApi(over: Partial<LpWriteApi> = {}) {
  api = fakeLpApi({
    prepareVenueSwap: vi.fn(async () => built(15_100_000n)),
    submitPrepared: vi.fn(async (_rpc, _signer, _p: PreparedTx, opts?: { onSent?: (s: string) => void }): Promise<TxOutcome> => {
      opts?.onSent?.(SIG);
      return { status: 'confirmed', signature: SIG, slot: 1 };
    }),
    ...over,
  });
  h.api = api;
}

beforeEach(() => {
  window.history.replaceState(null, '', '/solana');
  localStorage.clear();
  sessionStorage.clear();
  h.own = ownAt(15_100_000n);
  h.routeArgs = [];
  h.wanted = [];
  h.quoteNow.mockImplementation(async () => ({ kind: 'ok', quotes: (h.own as { quotes: OwnQuotes }).quotes }));
  h.send = { kind: 'yes' } as OwnSend;
  h.getQuote.mockImplementation(async (p: { noPlatformFee?: boolean }) => (p.noPlatformFee ? NO_FEE_QUOTE : FEE_QUOTE));
  h.buildSwapTransaction.mockImplementation(async (p: { noPlatformFee?: boolean }) => (p.noPlatformFee ? TX_NO_FEE : TX_FEE));
  h.simulateSwap.mockResolvedValue(OK);
  h.sendTransaction.mockResolvedValue(SIG);
  h.getBlockHeight.mockResolvedValue(0);
  h.check.mockImplementation(async (sig: string) => ({ status: 'unknown', signature: sig, message: 'slow' }));
  useApi();
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const routeLine = () => screen.getByTestId('solana-route-line').textContent;

async function typeAmount() {
  render(<SolanaSwapPage />);
  fireEvent.change(screen.getByLabelText('Amount of SOL to pay'), { target: { value: '0.1' } });
  await waitFor(() => expect(h.getQuote).toHaveBeenCalled(), { timeout: 3000 });
}
async function buy() {
  const b = await screen.findByRole('button', { name: 'Buy USDC' }, { timeout: 3000 });
  await waitFor(() => expect(b).toBeEnabled());
  fireEvent.click(b);
}
const fromJupiter = () => h.getQuote.mock.calls.length;

describe('our pool quoting more', () => {
  it('Buy builds the trade in our pool, the wallet signs it there, and Jupiter builds nothing', async () => {
    await typeAmount();
    await waitFor(() => expect(routeLine()).toBe('RouteOur pool quotes 1.173% more than Jupiter, so Buy sends it to our pool.'));
    // Our pools are read for the trade on screen, and the write path is wanted once one quotes it.
    expect(h.routeArgs.at(-1)).toEqual({ inputMint: SOL_MINT, outputMint: USDC_MINT, amountIn: 100_000_000n, nonce: 0 });
    expect(h.wanted.at(-1)).toBe(true);
    // Its quote is the one on screen, with its own fee words.
    expect(document.querySelector('[aria-live="polite"][aria-atomic="true"]')?.textContent).toBe('15.1');
    expect(screen.getByTestId('own-pool-fee')).toHaveTextContent('None on top. Inside the quote: this pool’s 1% trade fee, 0.16% to the venue and 0.84% to its liquidity providers.');
    expect(screen.getByText(/via our pool/)).toHaveTextContent(`via our pool ${POOL.toBase58().slice(0, 4)}…${POOL.toBase58().slice(-4)}, fee tier 1`);
    await buy();
    await waitFor(() => expect(api.prepareVenueSwap).toHaveBeenCalledTimes(1));
    expect(api.prepareVenueSwap).toHaveBeenCalledWith(connection, expect.objectContaining({ kind: 'open' }), {
      owner: USER, pool: POOL, inputMint: new PublicKey(SOL_MINT), outputMint: new PublicKey(USDC_MINT), amountIn: 100_000_000n, slippageBps: 50n,
    });
    // Our pool beat even Jupiter's no-fee quote: no Jupiter transaction was built to find out.
    expect(h.getQuote.mock.calls.map((c) => !!(c[0] as { noPlatformFee?: boolean }).noPlatformFee)).toEqual([false, false, true]);
    expect(h.buildSwapTransaction).not.toHaveBeenCalled();
    expect(await screen.findByRole('heading', { name: 'Review your swap in our pool' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Sign in wallet' }));
    await waitFor(() => expect(api.submitPrepared).toHaveBeenCalledTimes(1));
    expect(h.sendTransaction).not.toHaveBeenCalled();
    await screen.findByText('Done. The network confirmed it.');
    // The activity row is the summary's, not the screen's.
    expect(getActivity(USER.toBase58())[0]).toMatchObject({ sig: SIG, kind: 'swap', summary: 'Bought ≈15.1 USDC with 0.1 SOL in our pool' });
  });

  it('a tie with a quote that carries no site fee goes to our pool, with nothing of Jupiter built', async () => {
    const flat = quote({ platformFee: null });
    h.getQuote.mockImplementation(async () => flat);
    h.own = ownAt(14_925_000n);
    await typeAmount();
    await waitFor(() => expect(routeLine()).toBe('RouteOur pool and Jupiter quote the same for this trade, so Buy sends it to our pool.'));
    await buy();
    await waitFor(() => expect(api.prepareVenueSwap).toHaveBeenCalledTimes(1));
    expect(h.buildSwapTransaction).not.toHaveBeenCalled();
  });

  it('Jupiter with no route: Buy is on, and the trade goes to our pool', async () => {
    h.getQuote.mockImplementation(async () => { throw new NoRouteError(); });
    await typeAmount();
    await waitFor(() => expect(routeLine()).toBe('RouteJupiter has no route for this trade, and our pool quotes it, so Buy sends it to our pool.'));
    expect(screen.queryByText('No route for this pair / amount.')).not.toBeInTheDocument();
    await buy();
    await waitFor(() => expect(api.prepareVenueSwap).toHaveBeenCalledTimes(1));
  });

  it('Jupiter could not be asked: Buy stays off, because nothing was compared', async () => {
    h.getQuote.mockImplementation(async () => { throw new Error('Quote unavailable (502)'); });
    await typeAmount();
    await waitFor(() => expect(routeLine()).toMatch(/^RouteJupiter could not be asked for a quote just now/));
    expect(screen.getByRole('button', { name: 'Quote unavailable' })).toBeDisabled();
  });
});

describe('Jupiter paying more', () => {
  it('by one raw unit on screen: the press asks both again, and the Jupiter transaction it compared is the one sent', async () => {
    h.own = ownAt(14_924_999n);
    await typeAmount();
    await waitFor(() => expect(routeLine()).toBe('RouteJupiter quotes a little more than our pool, so Buy sends this trade to Jupiter.'));
    await buy();
    await waitFor(() => expect(h.sendTransaction).toHaveBeenCalledTimes(1));
    expect(h.quoteNow).toHaveBeenCalledTimes(1);
    expect(api.prepareVenueSwap).not.toHaveBeenCalled();
    // Built and simulated once, at the press, and that build is what the wallet signs.
    expect(h.buildSwapTransaction).toHaveBeenCalledTimes(1);
  });

  it('the screen said Jupiter, but our pool pays more at the press: the trade is built in our pool, behind its review', async () => {
    h.own = ownAt(14_924_999n);
    await typeAmount();
    await waitFor(() => expect(routeLine()).toMatch(/so Buy sends this trade to Jupiter\.$/));
    h.quoteNow.mockImplementation(async () => ({ kind: 'ok', quotes: quotes(15_100_000n) }));
    await buy();
    expect(await screen.findByRole('heading', { name: 'Review your swap in our pool' })).toBeInTheDocument();
    expect(api.prepareVenueSwap).toHaveBeenCalledTimes(1);
    expect(h.sendTransaction).not.toHaveBeenCalled();
  });

  it('the screen said our pool, Jupiter pays more at the press: nothing is sent, Jupiter’s new quote is shown, and the next press sends it', async () => {
    await typeAmount();
    await waitFor(() => expect(routeLine()).toMatch(/so Buy sends it to our pool\.$/));
    // As the real hook does, the press's fresh read becomes what the form shows.
    h.quoteNow.mockImplementation(async () => {
      h.own = ownAt(14_924_999n);
      return { kind: 'ok', quotes: quotes(14_924_999n) };
    });
    await buy();
    await waitFor(() => expect(h.toast.error).toHaveBeenCalledWith('Not sent', {
      description: 'Jupiter pays more for this trade now. Its new quote is on screen; nothing was sent. Press Buy again to swap through Jupiter.',
    }));
    expect(h.sendTransaction).not.toHaveBeenCalled();
    expect(api.prepareVenueSwap).not.toHaveBeenCalled();
    await waitFor(() => expect(routeLine()).toBe('RouteJupiter quotes a little more than our pool, so Buy sends this trade to Jupiter.'));
    await buy();
    await waitFor(() => expect(h.sendTransaction).toHaveBeenCalledTimes(1));
  });

  it('a close call that Jupiter’s no-fee retry wins: the first press shows that route, the second signs it', async () => {
    h.own = ownAt(14_950_000n);
    h.simulateSwap.mockImplementation(async (b64: string) => (b64 === TX_FEE ? JUP_6014 : OK));
    await typeAmount();
    await waitFor(() => expect(routeLine()).toBe("RouteOur pool quotes 0.168% more than Jupiter's quote, which includes this site's fee. Buy asks Jupiter again and sends whichever pays you more."));
    await buy();
    await waitFor(() => expect(h.toast.error).toHaveBeenCalledWith('Not sent', expect.anything()));
    expect(h.sendTransaction).not.toHaveBeenCalled();
    // The no-fee route is what is on screen now, said as such.
    await waitFor(() => expect(screen.getByTestId('site-fee-value')).toHaveTextContent('None on this route'));
    expect(document.querySelector('[aria-live="polite"][aria-atomic="true"]')?.textContent).toBe('15');
    await buy();
    await waitFor(() => expect(h.sendTransaction).toHaveBeenCalledTimes(1));
    const signed = h.sendTransaction.mock.calls[0]![0] as VersionedTransaction;
    expect(signed.message.compiledInstructions[0]!.data[0]).toBe(2);
    expect(api.prepareVenueSwap).not.toHaveBeenCalled();
  });

  it('a close call with the fee build simulating clean stays in our pool', async () => {
    h.own = ownAt(14_950_000n);
    await typeAmount();
    await waitFor(() => expect(routeLine()).toMatch(/Buy asks Jupiter again/));
    await buy();
    await waitFor(() => expect(api.prepareVenueSwap).toHaveBeenCalledTimes(1));
    expect(h.sendTransaction).not.toHaveBeenCalled();
  });
});

describe('the press checks again before anything is built', () => {
  it('a Jupiter quote that cannot be had at the press sends nothing anywhere, and says so', async () => {
    await typeAmount();
    await waitFor(() => expect(routeLine()).toMatch(/so Buy sends it to our pool\.$/));
    h.getQuote.mockImplementation(async () => { throw new Error('Quote unavailable (502)'); });
    await buy();
    await waitFor(() => expect(h.toast.error).toHaveBeenCalledWith('Not sent', {
      description: 'Jupiter could not be asked for a quote just now, so this trade could not be checked against it. Nothing was sent. Try again in a moment.',
    }));
    expect(api.prepareVenueSwap).not.toHaveBeenCalled();
    expect(h.sendTransaction).not.toHaveBeenCalled();
  });

  it('the builder’s read below the no-fee quote it met is settled again: Jupiter’s path would deliver less, so the review is shown', async () => {
    useApi({ prepareVenueSwap: vi.fn(async () => built(14_999_999n)) });
    await typeAmount();
    await buy();
    expect(await screen.findByRole('heading', { name: 'Review your swap in our pool' })).toBeInTheDocument();
  });

  it('the builder’s read below what Jupiter would deliver: nothing is signed', async () => {
    useApi({ prepareVenueSwap: vi.fn(async () => built(14_900_000n)) });
    await typeAmount();
    await buy();
    expect(await screen.findByText('Jupiter now pays more for this trade, so nothing was signed. Press Buy again and it goes to Jupiter.')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Review your swap in our pool' })).not.toBeInTheDocument();
    expect(api.submitPrepared).not.toHaveBeenCalled();
  });

  it('the builder’s read exactly at the number it met is a tie, and a tie is ours: reviewed with nothing asked again', async () => {
    useApi({ prepareVenueSwap: vi.fn(async () => built(15_000_000n)) });
    await typeAmount();
    const before = fromJupiter();
    await buy();
    expect(await screen.findByRole('heading', { name: 'Review your swap in our pool' })).toBeInTheDocument();
    // The press's fee-bearing quote and no-fee quote, and nothing after them.
    expect(fromJupiter() - before).toBe(2);
  });

  it('our pools could not be read at the press: nothing is sent, and it is said as that', async () => {
    await typeAmount();
    await waitFor(() => expect(routeLine()).toMatch(/so Buy sends it to our pool\.$/));
    h.quoteNow.mockImplementation(async () => ({ kind: 'unread', detail: 'HTTP 502' }));
    await buy();
    await waitFor(() => expect(h.toast.error).toHaveBeenCalledWith('Not sent', {
      description: 'Our pools could not be read just now, so this trade was not checked against them. Nothing was sent. Try again in a moment.',
    }));
    expect(api.prepareVenueSwap).not.toHaveBeenCalled();
    expect(h.sendTransaction).not.toHaveBeenCalled();
  });

  it('while the press checks, the form it was pressed on cannot change', async () => {
    let release: (v: unknown) => void = () => {};
    h.quoteNow.mockImplementation(() => new Promise((r) => { release = r; }));
    await typeAmount();
    await buy();
    await waitFor(() => expect(screen.getByLabelText('Amount of SOL to pay')).toBeDisabled());
    expect(screen.getByRole('button', { name: 'Flip pay and receive tokens' })).toBeDisabled();
    // A pick from the rails below the card is held too.
    fireEvent.click(screen.getByRole('button', { name: /JitoSOL/ }));
    release({ kind: 'ok', quotes: quotes(15_100_000n) });
    expect(await screen.findByRole('heading', { name: 'Review your swap in our pool' })).toBeInTheDocument();
    expect(api.prepareVenueSwap).toHaveBeenCalledWith(connection, expect.anything(), expect.objectContaining({ outputMint: new PublicKey(USDC_MINT) }));
    expect(h.routeArgs.at(-1)).toMatchObject({ outputMint: USDC_MINT });
  });
});

describe('a review in our pool built again', () => {
  it('still ours on fresh reads: the wallet signs the rebuilt one', async () => {
    await typeAmount();
    await buy();
    await screen.findByRole('heading', { name: 'Review your swap in our pool' });
    h.getBlockHeight.mockResolvedValue(1234);
    // The rebuilt one is signed only once its own window is clear.
    (api.prepareVenueSwap as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      h.getBlockHeight.mockResolvedValue(0);
      return built(15_100_000n);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in wallet' }));
    await waitFor(() => expect(api.submitPrepared).toHaveBeenCalledTimes(1));
    expect(api.prepareVenueSwap).toHaveBeenCalledTimes(2);
  });

  it('settled on the rebuilt read, not the press’s: our pool down to 14.9 against Jupiter’s 14.925 signs nothing', async () => {
    await typeAmount();
    await buy();
    await screen.findByRole('heading', { name: 'Review your swap in our pool' });
    h.getBlockHeight.mockResolvedValue(1234);
    (api.prepareVenueSwap as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => built(14_900_000n));
    fireEvent.click(screen.getByRole('button', { name: 'Sign in wallet' }));
    expect(await screen.findByText('Jupiter now pays more for this trade, so nothing was signed. Press Buy again and it goes to Jupiter.')).toBeInTheDocument();
    expect(api.submitPrepared).not.toHaveBeenCalled();
  });

  it('settles the venue again in full, and a Jupiter win there signs nothing', async () => {
    await typeAmount();
    await buy();
    await screen.findByRole('heading', { name: 'Review your swap in our pool' });
    // The block window is nearly over, so Sign builds it again; Jupiter now pays more.
    h.getBlockHeight.mockResolvedValue(1234);
    h.getQuote.mockImplementation(async () => quote({ outAmount: '16000000' }));
    fireEvent.click(screen.getByRole('button', { name: 'Sign in wallet' }));
    expect(await screen.findByText('Not sent. This trade in our pool was stopped before your wallet was asked, and nothing was signed.')).toBeInTheDocument();
    expect(screen.getByText('Jupiter now pays more for this trade, so nothing was signed. Press Buy again and it goes to Jupiter.')).toBeInTheDocument();
    expect(api.prepareVenueSwap).toHaveBeenCalledTimes(2);
    expect(api.submitPrepared).not.toHaveBeenCalled();
    expect(h.sendTransaction).not.toHaveBeenCalled();
  });
});

describe('what holds Buy', () => {
  it('a note of a trade sent to our pool and not answered holds Buy for both venues', async () => {
    savePendingTrade(SWAP_PENDING_SCOPE, { kind: 'venue-swap', signature: SIG, lastValidBlockHeight: 9 });
    h.own = ownAt(1n); // Jupiter's to take, if anything were let through.
    await typeAmount();
    expect(await screen.findByTestId('solana-swap-pending')).toBeInTheDocument();
    const b = await screen.findByRole('button', { name: 'Your last trade is still being checked' });
    expect(b).toBeDisabled();
  });

  it('a note this page cannot check, because the write code did not load, says how to clear it', async () => {
    savePendingTrade(SWAP_PENDING_SCOPE, { kind: 'venue-swap', signature: SIG, lastValidBlockHeight: 9 });
    h.api = null;
    await typeAmount();
    expect(await screen.findByTestId('solana-swap-pending')).toHaveTextContent(
      "This page could not load what checks it, so look it up in your wallet's activity, then press I checked my wallet.",
    );
  });

  it('a send that cannot be confirmed writes the note, and Buy stays held after the review closes', async () => {
    useApi({
      submitPrepared: vi.fn(async (_r, _s, _p: PreparedTx, opts?: { onSent?: (s: string) => void }): Promise<TxOutcome> => {
        opts?.onSent?.(SIG);
        return { status: 'unknown', signature: SIG, message: 'Not confirmed yet.' };
      }),
    });
    await typeAmount();
    await buy();
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in wallet' }));
    await waitFor(() => expect(sessionStorage.getItem(SWAP_PENDING_SCOPE)).toContain(SIG));
    expect(getActivity(USER.toBase58())[0]).toMatchObject({ summary: 'Sent, not confirmed: ≈15.1 USDC with 0.1 SOL in our pool' });
    // As on Jupiter's path: the same buy is not one click away while this one may land.
    expect(screen.getByLabelText('Amount of SOL to pay')).toHaveValue('');
    // Leaving the outcome does not leave the note: the card takes its place, and Buy stays off.
    fireEvent.click(await screen.findByRole('button', { name: 'I checked my wallet: start over' }));
    expect(await screen.findByTestId('solana-swap-pending')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Your last trade is still being checked' })).toBeDisabled();
  });

  it('a read that could not run while building is no refusal: the next press tries our pool again', async () => {
    useApi({
      prepareVenueSwap: vi.fn()
        .mockResolvedValueOnce({ ok: false, outcome: { status: 'not-sent', stage: 'build', message: 'We could not read the pool just now, so nothing was built. Try again in a moment.', retry: true } })
        .mockResolvedValue(built(15_100_000n)),
    });
    await typeAmount();
    await buy();
    await screen.findByText('We could not read the pool just now, so nothing was built. Try again in a moment.');
    fireEvent.click(screen.getByRole('button', { name: 'Start over' }));
    await waitFor(() => expect(routeLine()).toBe('RouteOur pool quotes 1.173% more than Jupiter, so Buy sends it to our pool.'));
    await buy();
    expect(await screen.findByRole('heading', { name: 'Review your swap in our pool' })).toBeInTheDocument();
    expect(api.prepareVenueSwap).toHaveBeenCalledTimes(2);
  });

  it('a refusal holds only the request pressed: another amount tries our pool again', async () => {
    useApi({ prepareVenueSwap: vi.fn(async (): Promise<Prepared> => ({ ok: false, outcome: { status: 'not-sent', stage: 'build', message: 'You hold too little SOL.' } })) });
    await typeAmount();
    await buy();
    await screen.findByText('You hold too little SOL.');
    fireEvent.click(screen.getByRole('button', { name: 'Start over' }));
    await waitFor(() => expect(routeLine()).toMatch(/was refused for this wallet/));
    fireEvent.change(screen.getByLabelText('Amount of SOL to pay'), { target: { value: '0.05' } });
    await waitFor(() => expect(routeLine()).toBe('RouteOur pool quotes 1.173% more than Jupiter, so Buy sends it to our pool.'));
  });

  it('Jupiter with no route and a trade in our pool that cannot be sent from here: no "No route", said as not available here', async () => {
    h.getQuote.mockImplementation(async () => { throw new NoRouteError(); });
    h.send = { kind: 'no', reason: 'trades in our pools are paused right now' };
    await typeAmount();
    await waitFor(() => expect(routeLine()).toMatch(/^RouteJupiter has no route for this trade, and our pool quotes it, but trades in our pools are paused right now/));
    expect(screen.queryByText('No route for this pair / amount.')).not.toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Not available here right now' })).toBeDisabled();
  });

  it('a trade our pool refused to build sends this pair to Jupiter for this wallet, and says why', async () => {
    useApi({ prepareVenueSwap: vi.fn(async (): Promise<Prepared> => ({ ok: false, outcome: { status: 'not-sent', stage: 'build', message: 'You hold too little SOL.' } })) });
    await typeAmount();
    await buy();
    await screen.findByText('You hold too little SOL.');
    fireEvent.click(screen.getByRole('button', { name: 'Start over' }));
    await waitFor(() => expect(routeLine()).toBe('RouteOur pool quotes 1.173% more than Jupiter, but the last try in our pool was refused for this wallet, so Buy sends this trade to Jupiter.'));
    await buy();
    await waitFor(() => expect(h.sendTransaction).toHaveBeenCalledTimes(1));
    expect(api.prepareVenueSwap).toHaveBeenCalledTimes(1);
  });

  it('a trade in our pool that cannot be sent from here says why, and Buy goes to Jupiter', async () => {
    h.send = { kind: 'no', reason: 'trades in our pools are paused right now' };
    await typeAmount();
    await waitFor(() => expect(routeLine()).toBe('RouteOur pool quotes 1.173% more than Jupiter, but trades in our pools are paused right now, so Buy sends this trade to Jupiter.'));
    await buy();
    await waitFor(() => expect(h.sendTransaction).toHaveBeenCalledTimes(1));
    expect(api.prepareVenueSwap).not.toHaveBeenCalled();
  });
});
