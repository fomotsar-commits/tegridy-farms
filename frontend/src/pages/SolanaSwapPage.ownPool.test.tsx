import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, configure } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PublicKey } from '@solana/web3.js';
import type { ReactNode } from 'react';
import type { JupiterQuote } from '../lib/jupiter';
import type { PreparedTx, SubmitDeps, VenueSwapArgs } from '../components/solana/curve/ports';
import { SOL_QUOTE } from '../lib/solana/lp/quotes';

/**
 * THE ROUTE, EXECUTED. When our pool pays at least as much as Jupiter, Buy opens the
 * review of a swap in OUR pool and Jupiter's transaction is never built; one raw unit
 * short and the trade is Jupiter's; the route is held again on fresh quotes at the
 * click, both ways. (`readPoolForPair`, `quoteOwnPool` and `deriveAmmConfig` are mocked
 * only so the page as it was before this rule can see the same pool: the red run.)
 */

const USER = new PublicKey('5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9');
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const BAYLA_MINT = '7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump';
const PROGRAM = 'EKS4C6xvV9A5DMWaWtVnFvi7ru78EhqRAoddEMpQ2BtT';
const LAUNCH = '64WBTeNcrSHfmBpiqymyifW6FUNNLvJcuiqF9rXmz4q2';
/** The venue's BAYLA and SOL pool, fee tier 1. */
const POOL = 'ErvzV1NMZmcfAqZtGH4AQhYAjn77nJEworKK1mYPz5w4';
const TIER1 = 'CapqvAA9HvERTwzmE26xrtFhMaNcaXXoQUADpBWqWjKy';
const SIG = '5'.repeat(88);
// A real serialized v0 transaction (payer USER, one instruction): the page only deserializes it.
const JUPITER_TX =
  'AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAQABAkjAG1BZAFRV2dywxrzs3LT7Wy6rwamoK1c5K6qkDwTmBHnVW/IxwG7udMVuzmgVB/2xst6j9I5RArHNola8E48AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEBAAEBAA==';

function jupiterQuote(outAmount: string): JupiterQuote {
  return {
    inputMint: SOL_MINT, outputMint: BAYLA_MINT, inAmount: '100000000', outAmount, otherAmountThreshold: outAmount,
    swapMode: 'ExactIn', slippageBps: 50, priceImpactPct: '0', routePlan: [], platformFee: null,
  };
}

const TIER1_CONFIG = {
  address: TIER1, index: 1, disableCreatePool: false, tradeFeeRate: 10_000n, protocolFeeRate: 160_000n, fundFeeRate: 0n,
  createPoolFee: 150_000_000n, creatorFeeRate: 0n, protocolOwner: 'Own1', fundOwner: 'Own2',
};
const ownQuote = (out: bigint) => ({
  poolAddress: POOL, outAmount: out, reserveIn: 24_000_000_000n, reserveOut: 5_000_000_000_000n, priceImpact: 0.004, creatorFeeOnInput: true,
  result: { outputAmount: out, tradeFee: 1_000_000n, protocolFee: 160_000n, fundFee: 0n, creatorFee: 0n, newInputVaultAmount: 0n, newOutputVaultAmount: 0n },
});
const ownCandidate = (out: bigint) => ({
  venue: 'own-pool', outAmount: out, label: 'venue pool', poolAddress: POOL, priceImpact: 0.004,
  view: { address: POOL, config: TIER1_CONFIG, snapshot: { pool: { enableCreatorFee: false } } }, quote: ownQuote(out),
});
// Two real serialized v0 transactions that differ in one data byte: Jupiter's fee build
// and its no-fee rebuild (see SolanaSwapPage.feeRetry.test.tsx).
const TX_HEAD =
  'AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAQABAkjAG1BZAFRV2dywxrzs3LT7Wy6rwamoK1c5K6qkDwTmBHnVW/IxwG7udMVuzmgVB/2xst6j9I5RArHNola8E48AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEBAAE';
const TX_FEE = `${TX_HEAD}BAA==`;
const TX_NO_FEE = `${TX_HEAD}CAA==`;

/** The prepared swap the (fake) builder hands back: enough for the real review to render every row. */
function preparedSwap(a: VenueSwapArgs, out: bigint): PreparedTx {
  return {
    kind: 'venue-swap',
    tx: {} as PreparedTx['tx'],
    extraSigners: [],
    blockhash: 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N',
    lastValidBlockHeight: 1_000,
    sizeBytes: 600,
    simulation: { unitsConsumed: 60_000, logs: [] },
    fees: { baseLamports: 5_000n, priorityLamports: 0n, priorityFeeRead: true, newAccountRentLamports: 2_074_080n },
    steps: [],
    simulated: { signerLamportsDelta: -102_074_080n, tokenDeltas: [{ mint: a.outputMint, account: USER, delta: out, role: 'token', decimals: 6 }] },
    summary: {
      kind: 'venue-swap', pool: a.pool, origin: 'standard', config: TIER1_CONFIG, tokenMint: a.outputMint, tokenDecimals: 6, coin: SOL_QUOTE,
      paysCoin: true, amountIn: a.amountIn, minimumAmountOut: (out * 9_950n) / 10_000n, quoted: ownQuote(out), aggregator: a.aggregator,
      unwrapsWsol: true, wsolHeldBefore: 0n, notices: [],
    },
    check: {} as PreparedTx['check'],
  };
}

const h = vi.hoisted(() => ({
  getQuote: vi.fn(),
  buildSwapTransaction: vi.fn(),
  simulateSwap: vi.fn(),
  sendTransaction: vi.fn(),
  signTransaction: vi.fn(),
  getSignatureStatuses: vi.fn(),
  readVenuePools: vi.fn(),
  quoteVenuePools: vi.fn(),
  readSwapGate: vi.fn(),
  prepareVenueSwap: vi.fn(),
  submitPrepared: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
  /** What our pool pays for the trade on screen; a test moves it to move the pool. */
  ownOut: { value: 0n as bigint | null },
  /** Whether a Jupiter swap of this pair carries the site fee, and whether own-pool swaps are switched on. */
  carriesFee: { value: false },
  on: { value: true },
  loads: { value: 0 },
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
vi.mock('../lib/jupiter', async (orig) => ({
  ...(await orig<typeof import('../lib/jupiter')>()),
  getQuote: h.getQuote,
  buildSwapTransaction: h.buildSwapTransaction,
  simulateSwap: h.simulateSwap,
  swapCarriesPlatformFee: () => h.carriesFee.value,
  getUsdPrices: vi.fn(async () => ({})),
  getShield: vi.fn(async () => ({})),
}));
vi.mock('../lib/launcher/solana/curve/rpc', () => ({ browserCurveRpc: () => ({}), browserRpc: () => async () => null }));
// The venue is live, and it has one pool for the pair. `readVenue` is what the fixed
// page reads; the other two are the pre-fix route line's (see the header).
vi.mock('../lib/solana/cpswap/read', () => ({
  readVenue: async () => ({ kind: 'live', programId: PROGRAM, config: TIER1_CONFIG }),
  readPoolForPair: async () => ({ kind: 'ok', value: { pool: { address: POOL } } }),
  quoteOwnPool: () => (h.ownOut.value === null ? null : { outAmount: h.ownOut.value, poolAddress: POOL, priceImpact: 0.004 }),
}));
vi.mock('../lib/solana/cpswap/program', async (orig) => ({
  ...(await orig<typeof import('../lib/solana/cpswap/program')>()),
  deriveAmmConfig: () => ({ toBase58: () => TIER1 }),
}));
vi.mock('../lib/solana/swap/venuePools', () => ({
  readVenuePools: (...a: unknown[]) => h.readVenuePools(...a),
  quoteVenuePools: (...a: unknown[]) => h.quoteVenuePools(...a),
  rememberingFetch: () => fetch,
}));
vi.mock('../lib/solana/swap/ownPoolSwapFlag', () => ({ ownPoolSwapsOn: () => h.on.value }));
vi.mock('../components/swap/venueSwapApi', () => ({
  loadVenueSwapApi: async () => (h.loads.value++, {
    swapWriteConfig: () => ({ programId: new PublicKey(LAUNCH), cpSwapProgram: new PublicKey(PROGRAM), cluster: 'mainnet' }),
    readSwapGate: (...a: unknown[]) => h.readSwapGate(...a),
    prepareVenueSwap: (...a: unknown[]) => h.prepareVenueSwap(...a),
    submitPrepared: (...a: unknown[]) => h.submitPrepared(...a),
    recheckOutcome: async (_rpc: unknown, signature: string) => ({ status: 'unknown', signature, message: 'not asked' }),
    explorerTxUrl: (sig: string) => `https://solscan.io/tx/${sig}`,
    meta: { displaySafe: (s: string) => s },
  }),
}));
// One stable wallet and connection: the page's effects key on their identity.
const connection = {
  getBalance: async () => 5_000_000_000,
  getParsedTokenAccountsByOwner: async () => ({ value: [] }),
  getSignatureStatuses: (sigs: string[]) => h.getSignatureStatuses(sigs) as Promise<unknown>,
  getBlockHeight: async () => 10,
};
const wallet = { publicKey: USER, sendTransaction: h.sendTransaction, signTransaction: h.signTransaction, connecting: false, wallet: null };
vi.mock('@solana/wallet-adapter-react', () => ({
  useConnection: () => ({ connection }),
  useWallet: () => wallet,
}));

import SolanaSwapPage from './SolanaSwapPage';
import { getActivity } from '../lib/solanaActivity';
import { OWN_ROUTE_COPY } from '../lib/solana/swap/ownPoolRoute';

// The first test here pays for the page's first render (see SolanaSwapPage.feeRetry.test.tsx).
// In a whole run on a busy machine the page took over 3 s to offer Buy: every wait is
// bounded for that, and none of them is what a test asserts.
vi.setConfig({ testTimeout: 90_000 });
configure({ asyncUtilTimeout: 20_000 });

const OPEN_GATE = { kind: 'open', cfg: { programId: new PublicKey(LAUNCH), cpSwapProgram: new PublicKey(PROGRAM), cluster: 'mainnet' } };

beforeEach(() => {
  window.history.replaceState(null, '', `/solana?out=${BAYLA_MINT}`);
  localStorage.clear();
  sessionStorage.clear();
  h.ownOut.value = 1_010_000n;
  h.carriesFee.value = false;
  h.on.value = true;
  h.loads.value = 0;
  h.getQuote.mockImplementation(async () => jupiterQuote('1000000'));
  h.buildSwapTransaction.mockImplementation(async () => JUPITER_TX);
  h.simulateSwap.mockResolvedValue({ ok: true, reason: null, jupiterIncorrectTokenProgram: false });
  h.sendTransaction.mockImplementation(async () => SIG);
  h.getSignatureStatuses.mockImplementation(async () => ({ value: [{ err: null, confirmationStatus: 'confirmed' }] }));
  h.readVenuePools.mockImplementation(async () => ({ kind: 'ok' }));
  h.quoteVenuePools.mockImplementation(() => (h.ownOut.value === null ? { state: 'error', candidates: [] } : { state: 'quoted', candidates: [ownCandidate(h.ownOut.value)] }));
  h.readSwapGate.mockImplementation(async () => OPEN_GATE);
  h.prepareVenueSwap.mockImplementation(async (_rpc: unknown, _gate: unknown, a: VenueSwapArgs) => ({ ok: true, prepared: preparedSwap(a, h.ownOut.value ?? 0n) }));
  h.submitPrepared.mockImplementation(async (_rpc: unknown, _signer: unknown, p: PreparedTx, deps?: SubmitDeps) => {
    deps?.onSent?.(SIG, p.lastValidBlockHeight);
    return { status: 'confirmed', signature: SIG, slot: 7 };
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/** Type 0.1 SOL for BAYLA, accept the unverified-token warning, and return the enabled Buy button. */
async function readyToBuy() {
  render(<MemoryRouter><SolanaSwapPage /></MemoryRouter>);
  fireEvent.change(screen.getByLabelText('Amount of SOL to pay'), { target: { value: '0.1' } });
  const buy = await screen.findByRole('button', { name: 'Buy BAYLA' }, { timeout: 20_000 });
  fireEvent.click(screen.getByRole('checkbox'));
  await waitFor(() => expect(buy).toBeEnabled());
  return buy;
}
const receive = () => document.querySelector('[aria-live="polite"][aria-atomic="true"]')?.textContent ?? null;
/** The line under the quote that says where the trade goes, found by its label (the quote details have a "Route" row too). */
const routeLine = () => screen.getAllByText('Route').map((el) => el.closest('p')).find(Boolean)?.textContent ?? '';

describe('our own pool pays more: the trade goes there', () => {
  it('Buy opens the review of a swap in OUR pool; Jupiter’s transaction is never built or sent', async () => {
    const buy = await readyToBuy();
    // The page already shows the route and its figure: our pool's 1.01, not Jupiter's 1.
    await waitFor(() => expect(routeLine()).toMatch(/Routed to the venue pool: 1% more output than Jupiter\./));
    expect(receive()).toBe('1.01');
    expect(screen.getByTestId('own-pool-fee').textContent).toMatch(/1% a trade/);
    expect(screen.getByText('Price impact (pool fee included)')).toBeInTheDocument();
    expect(screen.getByTestId('swap-footer').textContent).toMatch(/goes through our own pool/);

    fireEvent.click(buy);
    expect(await screen.findByText('Review your swap', {}, { timeout: 20_000 })).toBeInTheDocument();
    expect(h.buildSwapTransaction).not.toHaveBeenCalled();
    expect(h.sendTransaction).not.toHaveBeenCalled();

    // Built against that pool, for the pair and amount on screen, and held to Jupiter's FRESH quote.
    expect(h.prepareVenueSwap).toHaveBeenCalledTimes(1);
    const args = h.prepareVenueSwap.mock.calls[0]![2] as VenueSwapArgs;
    expect(args.pool.toBase58()).toBe(POOL);
    expect([args.inputMint.toBase58(), args.outputMint.toBase58()]).toEqual([SOL_MINT, BAYLA_MINT]);
    expect(args).toMatchObject({ amountIn: 100_000_000n, slippageBps: 50n, aggregator: { kind: 'quoted', out: 1_000_000n, when: 'now' } });
    expect(args.owner.equals(USER)).toBe(true);

    // The review names the pool and how it compares; nothing was asked of the wallet yet.
    expect(screen.getByText(POOL)).toBeInTheDocument();
    expect(screen.getByText('Standard address for fee tier 1')).toBeInTheDocument();
    expect(screen.getByText('1% more than Jupiter quoted just now')).toBeInTheDocument();
    expect(h.submitPrepared).not.toHaveBeenCalled();

    // Sign in wallet sends the transaction that was reviewed, through our own send path.
    fireEvent.click(screen.getByRole('button', { name: 'Sign in wallet' }));
    expect(await screen.findByText('Done. The network confirmed it.')).toBeInTheDocument();
    expect(h.submitPrepared).toHaveBeenCalledTimes(1);
    expect((h.submitPrepared.mock.calls[0]![2] as PreparedTx).kind).toBe('venue-swap');
    expect(h.sendTransaction).not.toHaveBeenCalled();
    // And it is kept where a Jupiter swap is kept.
    expect(getActivity(USER.toBase58())[0]).toMatchObject({ sig: SIG, kind: 'swap', summary: 'Bought ≈1.01 BAYLA with 0.1 SOL, in our own pool' });
  });

  it('a tie stays in our pool', async () => {
    h.ownOut.value = 1_000_000n;
    const buy = await readyToBuy();
    await waitFor(() => expect(routeLine()).toMatch(/same output, so the trade stays here/));
    fireEvent.click(buy);
    expect(await screen.findByText('Review your swap', {}, { timeout: 20_000 })).toBeInTheDocument();
    expect(screen.getByText('the same as Jupiter quoted just now, so the trade stays here')).toBeInTheDocument();
    expect(h.buildSwapTransaction).not.toHaveBeenCalled();
  });

  it('a pool that is the only venue to quote fills the trade Jupiter has no route for', async () => {
    const { NoRouteError } = await import('../lib/jupiter');
    h.getQuote.mockImplementation(async () => { throw new NoRouteError(); });
    const buy = await readyToBuy();
    await waitFor(() => expect(routeLine()).toMatch(/It was the only venue that quoted this pair\./));
    expect(screen.queryByText(/No route for this pair/)).toBeNull();
    fireEvent.click(buy);
    expect(await screen.findByText('Review your swap', {}, { timeout: 20_000 })).toBeInTheDocument();
    expect((h.prepareVenueSwap.mock.calls[0]![2] as VenueSwapArgs).aggregator).toEqual({ kind: 'no-route' });
    expect(screen.getByText('Jupiter has no route for this trade, so this pool is the only route')).toBeInTheDocument();
  });

  it('when Jupiter cannot be asked at all, the trade can still go to our pool, and the page and the review say it was not compared', async () => {
    h.getQuote.mockImplementation(async () => { throw new Error('Quote failed (502)'); });
    const buy = await readyToBuy();
    // The notice stays: what is missing is the comparison, and Try again asks for it.
    expect(screen.getByTestId('solana-quote-unavailable').textContent).toMatch(/Jupiter could not be asked for a quote just now, so our pool was not compared with it\./);
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    fireEvent.click(buy);
    expect(await screen.findByText('Review your swap', {}, { timeout: 20_000 })).toBeInTheDocument();
    expect((h.prepareVenueSwap.mock.calls[0]![2] as VenueSwapArgs).aggregator).toEqual({ kind: 'unreachable' });
    expect(screen.getByText('Jupiter could not be asked just now, so this trade was not compared with it')).toBeInTheDocument();
    expect(screen.queryByText(/no route|only route/)).toBeNull();
  });
});

describe('what Jupiter would PAY, not only what it quotes: the site fee it cannot take on some routes', () => {
  // On BAYLA's Jupiter route the site fee cannot be taken (Jupiter's own 6014), so the
  // site sends Jupiter's no-fee transaction, which pays about 0.5% more than the
  // fee-bearing quote on screen. Our pool is held to THAT figure.
  const JUP_6014 = { ok: false, reason: 'custom program error: 0x177e', jupiterIncorrectTokenProgram: true };
  const OK = { ok: true, reason: null, jupiterIncorrectTokenProgram: false };
  const feeQuote = () => ({ ...jupiterQuote('1005000'), platformFee: { amount: '5000', feeBps: 50 } });
  const noFeeQuote = () => jupiterQuote('1012000');
  beforeEach(() => {
    h.carriesFee.value = true;
    h.getQuote.mockImplementation(async (p: { noPlatformFee?: boolean }) => (p.noPlatformFee ? noFeeQuote() : feeQuote()));
    h.buildSwapTransaction.mockImplementation(async (p: { noPlatformFee?: boolean }) => (p.noPlatformFee ? TX_NO_FEE : TX_FEE));
  });

  it('our pool beats the fee-bearing quote but not the no-fee route Jupiter would really send: nothing is built, and the next Buy sends Jupiter’s', async () => {
    h.simulateSwap.mockImplementation(async (b64: string) => (b64 === TX_FEE ? JUP_6014 : OK));
    const buy = await readyToBuy();
    // On screen our pool (1.01) is ahead of the quote that carries the fee (1.005).
    await waitFor(() => expect(routeLine()).toMatch(/Routed to the venue pool/));
    fireEvent.click(buy);
    expect(await screen.findByText(OWN_ROUTE_COPY.routeMoved, {}, { timeout: 20_000 })).toBeInTheDocument();
    expect(h.prepareVenueSwap).not.toHaveBeenCalled();
    expect(h.sendTransaction).not.toHaveBeenCalled();

    // Start over: the no-fee quote is on screen now, the line names Jupiter, and it stays so.
    fireEvent.click(screen.getByRole('button', { name: 'Start over' }));
    await waitFor(() => expect(routeLine()).toMatch(/Routed to Jupiter/), { timeout: 20_000 });
    expect(receive()).toBe('1.012');
    expect(screen.getByTestId('site-fee-value').textContent).toBe('None on this route');
    await new Promise((r) => setTimeout(r, 700));
    expect(routeLine()).toMatch(/Routed to Jupiter/);

    // Buy again: Jupiter's no-fee transaction is the one the wallet is asked for.
    fireEvent.click(await screen.findByRole('button', { name: 'Buy BAYLA' }));
    await waitFor(() => expect(h.sendTransaction).toHaveBeenCalledTimes(1), { timeout: 20_000 });
    const signed = h.sendTransaction.mock.calls[0]![0] as { message: { compiledInstructions: { data: Uint8Array }[] } };
    expect(signed.message.compiledInstructions[0]!.data[0]).toBe(2);
    expect(h.prepareVenueSwap).not.toHaveBeenCalled();
    expect(h.toast.error).not.toHaveBeenCalledWith('Route changed', expect.anything());
  });

  it('where Jupiter’s fee-bearing transaction would run, our pool is held to that quote, and Jupiter’s is never sent', async () => {
    h.simulateSwap.mockResolvedValue(OK);
    const buy = await readyToBuy();
    fireEvent.click(buy);
    expect(await screen.findByText('Review your swap', {}, { timeout: 20_000 })).toBeInTheDocument();
    expect((h.prepareVenueSwap.mock.calls[0]![2] as VenueSwapArgs).aggregator).toEqual({ kind: 'quoted', out: 1_005_000n, when: 'now' });
    expect(h.sendTransaction).not.toHaveBeenCalled();
  });

  it('Jupiter was shown: our pool is compared with the transaction about to be signed, the no-fee one included', async () => {
    h.simulateSwap.mockImplementation(async (b64: string) => (b64 === TX_FEE ? JUP_6014 : OK));
    // 1.008: above the fee-bearing quote now on screen? No: the page shows 1.005 and our pool 1.004.
    h.ownOut.value = 1_004_000n;
    const buy = await readyToBuy();
    await waitFor(() => expect(routeLine()).toMatch(/Routed to Jupiter/));
    // By the click our pool pays 1.008: more than the fee-bearing quote, less than the no-fee route (1.012).
    h.ownOut.value = 1_008_000n;
    fireEvent.click(buy);
    await waitFor(() => expect(h.sendTransaction).toHaveBeenCalledTimes(1), { timeout: 20_000 });
    expect(h.toast.error).not.toHaveBeenCalledWith('Route changed', expect.anything());
  });
});

describe('swaps in our own pools switched off', () => {
  it('the line says our pool quoted more and that the swap goes through Jupiter; the swap code is never fetched', async () => {
    h.on.value = false;
    const buy = await readyToBuy();
    await waitFor(() =>
      expect(routeLine()).toMatch(/Our own pool quotes 1% more output than Jupiter, but a swap in it cannot be prepared here right now \(swaps in our own pools are switched off for now\), so this swap executes via Jupiter\./),
    );
    expect(receive()).toBe('1');
    fireEvent.click(buy);
    await waitFor(() => expect(h.sendTransaction).toHaveBeenCalledTimes(1));
    expect(h.prepareVenueSwap).not.toHaveBeenCalled();
    expect(h.loads.value).toBe(0);
  });
});

describe('our own pool pays one raw unit less: the trade is Jupiter’s', () => {
  it('Buy sends Jupiter’s transaction, and no swap in our pool is prepared', async () => {
    h.ownOut.value = 999_999n;
    const buy = await readyToBuy();
    await waitFor(() => expect(routeLine()).toMatch(/Routed to Jupiter: under 0\.001% better than our own pool, so the trade went there\./));
    expect(receive()).toBe('1');
    expect(screen.queryByTestId('own-pool-fee')).toBeNull();
    fireEvent.click(buy);
    await waitFor(() => expect(h.sendTransaction).toHaveBeenCalledTimes(1));
    expect(h.buildSwapTransaction).toHaveBeenCalledTimes(1);
    expect(h.prepareVenueSwap).not.toHaveBeenCalled();
    expect(screen.queryByText('Review your swap')).toBeNull();
  });
});

describe('the route is held again when Buy is pressed', () => {
  it('our pool was shown, and Jupiter now pays more: nothing is built, and the page says why', async () => {
    const buy = await readyToBuy();
    await waitFor(() => expect(routeLine()).toMatch(/Routed to the venue pool/));
    // Jupiter's price moves past our pool's between the quote on screen and the click.
    h.getQuote.mockImplementation(async () => jupiterQuote('1010001'));
    fireEvent.click(buy);
    expect(await screen.findByText(OWN_ROUTE_COPY.routeMoved, {}, { timeout: 20_000 })).toBeInTheDocument();
    expect(h.prepareVenueSwap).not.toHaveBeenCalled();
    expect(h.buildSwapTransaction).not.toHaveBeenCalled();
    expect(h.sendTransaction).not.toHaveBeenCalled();
    // Start over lands on the route as it is now.
    fireEvent.click(screen.getByRole('button', { name: 'Start over' }));
    await waitFor(() => expect(routeLine()).toMatch(/Routed to Jupiter/), { timeout: 20_000 });
  });

  it('Jupiter was shown, and our pool now pays at least as much: nothing is sent, and the page shows the new route', async () => {
    h.ownOut.value = 990_000n;
    const buy = await readyToBuy();
    await waitFor(() => expect(routeLine()).toMatch(/Routed to Jupiter/));
    // The pool is read again at the click, and it has moved to a tie.
    h.ownOut.value = 1_000_000n;
    fireEvent.click(buy);
    await waitFor(() => expect(h.toast.error).toHaveBeenCalledWith('Route changed', { description: OWN_ROUTE_COPY.ownNowWins }));
    expect(h.buildSwapTransaction).not.toHaveBeenCalled();
    expect(h.sendTransaction).not.toHaveBeenCalled();
    await waitFor(() => expect(routeLine()).toMatch(/same output, so the trade stays here/));
  });

  it('Buy pressed while our pool was still being read: it is read before anything is sent, and takes the trade it wins', async () => {
    // The first read of our pools never answers; Jupiter's quote lands and Buy is live.
    h.readVenuePools.mockImplementationOnce(() => new Promise(() => {}));
    const buy = await readyToBuy();
    expect(routeLine()).toMatch(/Checking our own pools/);
    fireEvent.click(buy);
    await waitFor(() => expect(h.toast.error).toHaveBeenCalledWith('Route changed', { description: OWN_ROUTE_COPY.ownNowWins }));
    expect(h.buildSwapTransaction).not.toHaveBeenCalled();
    expect(h.sendTransaction).not.toHaveBeenCalled();
    await waitFor(() => expect(routeLine()).toMatch(/Routed to the venue pool/));
  });

  it('a read of our pool that hangs at the click does not hold the trade: Jupiter’s goes ahead as shown', async () => {
    h.ownOut.value = 990_000n;
    const buy = await readyToBuy();
    await waitFor(() => expect(routeLine()).toMatch(/Routed to Jupiter/));
    h.readVenuePools.mockImplementation(() => new Promise(() => {}));
    fireEvent.click(buy);
    await waitFor(() => expect(h.sendTransaction).toHaveBeenCalledTimes(1), { timeout: 30_000 });
    expect(h.prepareVenueSwap).not.toHaveBeenCalled();
  });

  it('Jupiter was shown and still pays more at the click: its transaction is sent', async () => {
    h.ownOut.value = 990_000n;
    const buy = await readyToBuy();
    await waitFor(() => expect(routeLine()).toMatch(/Routed to Jupiter/));
    const reads = h.readVenuePools.mock.calls.length;
    fireEvent.click(buy);
    await waitFor(() => expect(h.sendTransaction).toHaveBeenCalledTimes(1));
    // Our pool WAS read again before that: the route was checked, not assumed.
    expect(h.readVenuePools.mock.calls.length).toBe(reads + 1);
    expect(h.prepareVenueSwap).not.toHaveBeenCalled();
  });
});

describe('when a swap in our pool cannot be prepared here', () => {
  it('the trade goes through Jupiter, and the line says the pool quoted more', async () => {
    h.readSwapGate.mockImplementation(async () => ({ kind: 'blocked', reason: 'unreadable', detail: 'Could not read the pool program: HTTP 502' }));
    const buy = await readyToBuy();
    await waitFor(() =>
      expect(routeLine()).toMatch(
        /Our own pool quotes 1% more output than Jupiter, but a swap in it cannot be prepared here right now \(the pool program could not be checked\), so this swap executes via Jupiter\./,
      ),
    );
    // The figure on the page is the one the trader will get: Jupiter's.
    expect(receive()).toBe('1');
    fireEvent.click(buy);
    await waitFor(() => expect(h.sendTransaction).toHaveBeenCalledTimes(1));
    expect(h.prepareVenueSwap).not.toHaveBeenCalled();
  });
});

describe('a swap in our pool that was sent and not confirmed', () => {
  it('is kept in the activity list, clears the form, and holds the next buy after a reload', async () => {
    h.submitPrepared.mockImplementation(async (_rpc: unknown, _signer: unknown, p: PreparedTx, deps?: SubmitDeps) => {
      deps?.onSent?.(SIG, p.lastValidBlockHeight);
      return { status: 'unknown', signature: SIG, message: 'The network has no record of it yet. It may still be landing.' };
    });
    const buy = await readyToBuy();
    fireEvent.click(buy);
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in wallet' }, { timeout: 20_000 }));
    expect(await screen.findByText('Sent, not confirmed yet. Do not retry until you check.')).toBeInTheDocument();
    expect(getActivity(USER.toBase58())[0]).toMatchObject({ sig: SIG, summary: 'Sent, not confirmed: ≈1.01 BAYLA with 0.1 SOL, in our own pool' });

    // A reload: the note is found, said, and Buy is held until it is checked.
    cleanup();
    render(<MemoryRouter><SolanaSwapPage /></MemoryRouter>);
    expect(await screen.findByTestId('venue-swap-pending')).toBeInTheDocument();
    expect(screen.getByText(SIG)).toBeInTheDocument();
    expect((screen.getByLabelText('Amount of SOL to pay') as HTMLInputElement).value).toBe('');
    fireEvent.change(screen.getByLabelText('Amount of SOL to pay'), { target: { value: '0.1' } });
    const again = await screen.findByRole('button', { name: 'Buy BAYLA' }, { timeout: 20_000 });
    fireEvent.click(screen.getByRole('checkbox'));
    await waitFor(() => expect(receive()).toBe('1.01'));
    expect(again).toBeDisabled();
  });
});
