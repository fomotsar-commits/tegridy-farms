import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, configure } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PublicKey } from '@solana/web3.js';
import type { ReactNode } from 'react';
import type { JupiterQuote } from '../lib/jupiter';
import type { PreparedTx, SubmitDeps, VenueSwapArgs } from '../components/solana/curve/ports';
import { SOL_QUOTE } from '../lib/solana/lp/quotes';

/**
 * RANGE POOLS IN THE ROUTE. While the range program's id is the placeholder nothing about
 * range pools is read and every swap is as it was. Shown, a range pool is one more of our
 * pools: it takes the trade when it pays the most, its swap is built by the range builder,
 * and the review and the toast say what it pays. The rest of this header is the own-pool
 * suite's, whose setup this file shares:
 *
 * THE ROUTE, EXECUTED, IN ONE PRESS. When our pool pays at least as much as Jupiter, Buy
 * hands a swap in OUR pool to the wallet and Jupiter's transaction is never built; one
 * raw unit short and the trade is Jupiter's; the route is held again on fresh quotes at
 * the click, both ways. A swap that needs a second look still stops on its review, and
 * an ending with nothing to read returns to the form by itself.
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
/** A range pool of the same pair. */
const RANGE_POOL = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';
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

const RANGE_TIER = { address: TIER1, index: 0, tradeFeeRate: 10_000, protocolFeeRate: 160_000, fundFeeRate: 0, tickSpacing: 120 };
const rangeCandidate = (out: bigint) => ({
  venue: 'own-pool', outAmount: out, label: 'venue range pool', poolAddress: RANGE_POOL, priceImpact: 0.002,
  range: { pool: { address: RANGE_POOL, tokenMint0: BAYLA_MINT, feeOn: h.rangeFeeOn.value }, config: RANGE_TIER }, quote: { outAmount: out, priceImpact: 0.002, bands: [0] },
});
/** The prepared range swap the (fake) range builder hands back, for the real review. */
function preparedRangeSwap(a: VenueSwapArgs, out: bigint): PreparedTx {
  return {
    ...preparedSwap(a, out),
    kind: 'range-swap',
    summary: {
      kind: 'range-swap',
      poolLine: {
        pool: a.pool, feeCeiling: null, tokenMint: a.outputMint, tokenDecimals: 6, quote: SOL_QUOTE, tokenIsToken0: true, tradeFeeRate: 10_000, venueShareRate: 160_000,
        protocolFeeRate: 104_000, fundFeeRate: 56_000, owner: 'GRMtSxgseKdesExU1BQ22abEspTXV55UPcLaHCd18osd', fundOwner: h.fundOwner.value,
      },
      paysCoin: true, amountIn: a.amountIn, minimumAmountOut: (out * 9_950n) / 10_000n, quotedOut: out, bandsCrossed: 1, feeOnInput: h.feeOnInput.value, aggregator: a.aggregator,
      unwrapsWsol: true, wsolHeldBefore: 0n, notices: [],
    },
  };
}

/** The prepared swap the (fake) builder hands back: enough for the real review to render every row. */
function preparedSwap(a: VenueSwapArgs, out: bigint): PreparedTx {
  return {
    kind: 'venue-swap',
    tx: {} as PreparedTx['tx'],
    extraSigners: [],
    blockhash: 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N',
    lastValidBlockHeight: 1_000,
    sizeBytes: 600,
    simulation: { unitsConsumed: 60_000, logs: [], slot: 1, at: 0, wsolLamportsDelta: null },
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
  /** Whether range pools show, what the range pool pays (null: it does not quote), and its builder. */
  rangeOn: { value: false },
  rangeOut: { value: null as bigint | null },
  /** The range pool's fee side for this trade (its fee_on): out of what is paid in, or out of what comes out. */
  feeOnInput: { value: true },
  /** The range tier's fund_owner: the island's Workshop by the agreed split. */
  fundOwner: { value: 'G2EHPseTXetHbBvvRDs27XQyXfQikXXyxP9uMbsKrbu' },
  /** The range pool's fee_on: 0 in the coin each swap pays in; 1 in token 0 only. */
  rangeFeeOn: { value: 0 },
  readRangeRoutePools: vi.fn(),
  prepareRangeSwap: vi.fn(),
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
  searchTokens: vi.fn(),
  resolveMint: vi.fn(),
  getShield: vi.fn(),
  readVenue: vi.fn(),
  recheckOutcome: vi.fn(),
  loadFails: { value: false },
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
  /** What our pool pays for the trade on screen; a test moves it to move the pool. */
  ownOut: { value: 0n as bigint | null },
  /** Whether a Jupiter swap of this pair carries the site fee, and whether own-pool swaps are switched on. */
  carriesFee: { value: false },
  on: { value: true },
  loads: { value: 0 },
  /** Base units of the token the wallet pays with, when it is not SOL; null = it holds none. */
  tokenHeld: { value: null as string | null },
  /** What the price service answers, and the chain's block height (a review goes stale past it). */
  prices: { value: {} as Record<string, number> },
  height: { value: 10 },
  /** The 24h average read; unset, it answers "could not be read". */
  pairAverage: vi.fn(),
}));

vi.mock('sonner', () => ({ toast: h.toast }));
vi.mock('../lib/solana/swap/pairAverage', async (orig) => ({
  ...(await orig<typeof import('../lib/solana/swap/pairAverage')>()),
  fetchPairAverage: async (...args: unknown[]) => (await h.pairAverage(...args)) ?? { kind: 'unread' },
}));
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
  searchTokens: (...a: unknown[]) => h.searchTokens(...a),
  resolveMint: (...a: unknown[]) => h.resolveMint(...a),
}));
vi.mock('../lib/jupiter', async (orig) => ({
  ...(await orig<typeof import('../lib/jupiter')>()),
  getQuote: h.getQuote,
  buildSwapTransaction: h.buildSwapTransaction,
  simulateSwap: h.simulateSwap,
  swapCarriesPlatformFee: () => h.carriesFee.value,
  getUsdPrices: vi.fn(async () => h.prices.value),
  getShield: (...a: unknown[]) => h.getShield(...a),
}));
vi.mock('../lib/launcher/solana/curve/rpc', () => ({ browserCurveRpc: () => ({}), browserRpc: () => async () => null }));
// The venue is live, and it has one pool for the pair. `readVenue` is what the fixed
// page reads; the other two are the pre-fix route line's (see the header).
vi.mock('../lib/solana/cpswap/read', () => ({
  readVenue: (...a: unknown[]) => h.readVenue(...a),
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
vi.mock('../lib/solana/clmm/programId', async (orig) => ({
  ...(await orig<typeof import('../lib/solana/clmm/programId')>()),
  rangePoolsVisible: () => h.rangeOn.value,
}));
vi.mock('../lib/solana/swap/rangePools', async (orig) => ({
  ...(await orig<typeof import('../lib/solana/swap/rangePools')>()),
  readRangeRoutePools: (...a: unknown[]) => h.readRangeRoutePools(...a),
  quoteRangePools: () => (h.rangeOut.value === null ? { state: 'unquotable', candidates: [] } : { state: 'quoted', candidates: [rangeCandidate(h.rangeOut.value)] }),
}));
vi.mock('../lib/solana/swap/ownPoolSwapFlag', () => ({ ownPoolSwapsOn: () => h.on.value }));
vi.mock('../components/swap/venueSwapApi', () => ({
  loadVenueSwapApi: async () => (h.loads.value++, h.loadFails.value ? Promise.reject(new TypeError('Failed to fetch dynamically imported module: /assets/venueSwap.js')) : {
    swapWriteConfig: () => ({ programId: new PublicKey(LAUNCH), cpSwapProgram: new PublicKey(PROGRAM), cluster: 'mainnet' }),
    readSwapGate: (...a: unknown[]) => h.readSwapGate(...a),
    prepareVenueSwap: (...a: unknown[]) => h.prepareVenueSwap(...a),
    prepareRangeSwap: (...a: unknown[]) => h.prepareRangeSwap(...a),
    submitPrepared: (...a: unknown[]) => h.submitPrepared(...a),
    recheckOutcome: (...a: unknown[]) => h.recheckOutcome(...a),
    explorerTxUrl: (sig: string) => `https://solscan.io/tx/${sig}`,
    meta: { displaySafe: (s: string) => s },
  }),
}));
// One stable wallet and connection: the page's effects key on their identity.
const connection = {
  getBalance: async () => 5_000_000_000,
  getParsedTokenAccountsByOwner: async () => ({ value: h.tokenHeld.value === null ? [] : [{ account: { data: { parsed: { info: { tokenAmount: { amount: h.tokenHeld.value } } } } } }] }),
  getSignatureStatuses: (sigs: string[]) => h.getSignatureStatuses(sigs) as Promise<unknown>,
  getBlockHeight: async () => h.height.value,
};
const wallet = { publicKey: USER, sendTransaction: h.sendTransaction, signTransaction: h.signTransaction, connecting: false, wallet: null };
/** The connected wallet, for a test to switch or disconnect; put back after each test. */
const live = wallet as unknown as { publicKey: PublicKey | null };
vi.mock('@solana/wallet-adapter-react', () => ({
  useConnection: () => ({ connection }),
  useWallet: () => wallet,
}));

import SolanaSwapPage from './SolanaSwapPage';
import { getActivity } from '../lib/solanaActivity';

// The first test here pays for the page's first render (see SolanaSwapPage.feeRetry.test.tsx).
// In a whole run on a busy machine the page took over 3 s to offer Buy: every wait is
// bounded for that, and none of them is what a test asserts.
vi.setConfig({ testTimeout: 90_000 });
configure({ asyncUtilTimeout: 20_000 });

const OPEN_GATE = { kind: 'open', cfg: { programId: new PublicKey(LAUNCH), cpSwapProgram: new PublicKey(PROGRAM), cluster: 'mainnet' } };

beforeEach(() => {
  h.feeOnInput.value = true;
  h.fundOwner.value = 'G2EHPseTXetHbBvvRDs27XQyXfQikXXyxP9uMbsKrbu';
  h.rangeFeeOn.value = 0;
  window.history.replaceState(null, '', `/solana?out=${BAYLA_MINT}`);
  localStorage.clear();
  sessionStorage.clear();
  h.ownOut.value = 1_010_000n;
  h.rangeOn.value = false;
  h.rangeOut.value = null;
  h.readRangeRoutePools.mockImplementation(async () => ({ kind: 'ok', tokenMint: BAYLA_MINT, quote: SOL_QUOTE, pools: [{ range: { pool: { address: RANGE_POOL } }, ext: null, bands: new Map() }], unread: 0, chainNow: 1n }));
  h.prepareRangeSwap.mockImplementation(async (_rpc: unknown, _gate: unknown, a: VenueSwapArgs) => ({ ok: true, prepared: preparedRangeSwap(a, h.rangeOut.value ?? 0n) }));
  h.carriesFee.value = false;
  h.on.value = true;
  h.loads.value = 0;
  h.tokenHeld.value = null;
  h.loadFails.value = false;
  h.prices.value = {};
  h.height.value = 10;
  h.recheckOutcome.mockImplementation(async (_rpc: unknown, signature: string) => ({ status: 'unknown', signature, message: 'not asked' }));
  h.readVenue.mockImplementation(async () => ({ kind: 'live', programId: PROGRAM, config: TIER1_CONFIG }));
  h.getQuote.mockImplementation(async () => jupiterQuote('1000000'));
  h.buildSwapTransaction.mockImplementation(async () => JUPITER_TX);
  h.simulateSwap.mockResolvedValue({ ok: true, reason: null, jupiterIncorrectTokenProgram: false });
  h.sendTransaction.mockImplementation(async () => SIG);
  h.getSignatureStatuses.mockImplementation(async () => ({ value: [{ err: null, confirmationStatus: 'confirmed' }] }));
  h.readVenuePools.mockImplementation(async () => ({ kind: 'ok' }));
  h.quoteVenuePools.mockImplementation(() => (h.ownOut.value === null ? { state: 'error', candidates: [] } : { state: 'quoted', candidates: [ownCandidate(h.ownOut.value)] }));
  h.readSwapGate.mockImplementation(async () => OPEN_GATE);
  h.searchTokens.mockImplementation(async () => []);
  h.resolveMint.mockImplementation(async () => null);
  h.getShield.mockImplementation(async () => ({}));
  h.prepareVenueSwap.mockImplementation(async (_rpc: unknown, _gate: unknown, a: VenueSwapArgs) => ({ ok: true, prepared: preparedSwap(a, h.ownOut.value ?? 0n) }));
  h.submitPrepared.mockImplementation(async (_rpc: unknown, _signer: unknown, p: PreparedTx, deps?: SubmitDeps) => {
    deps?.onSent?.(SIG, p.lastValidBlockHeight);
    return { status: 'confirmed', signature: SIG, slot: 7 };
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  live.publicKey = USER;
});

/**
 * Type 0.1 SOL for BAYLA and return the Buy button. No tick-box stands in the way: both
 * are the venue's own coins. Buy is live on Jupiter's quote first and goes off once more
 * while the swap code for our pool and its gate load, so this waits for the pools to have
 * been read and, when one quotes, for the gate to have answered. `poolsAnswer: false`
 * is for a test whose pool read never comes back.
 */
async function readyToBuy(o: { poolsAnswer?: boolean } = {}) {
  render(<MemoryRouter><SolanaSwapPage /></MemoryRouter>);
  fireEvent.change(screen.getByLabelText('Amount of SOL to pay'), { target: { value: '0.1' } });
  const buy = await screen.findByRole('button', { name: 'Buy BAYLA' }, { timeout: 20_000 });
  if (o.poolsAnswer !== false) {
    await waitFor(() => expect(h.quoteVenuePools).toHaveBeenCalled());
    if (h.on.value && h.ownOut.value !== null) await waitFor(() => expect(h.readSwapGate).toHaveBeenCalled());
  }
  await waitFor(() => expect(buy).toBeEnabled());
  expect(screen.queryByRole('checkbox')).toBeNull();
  return buy;
}
const receive = () => document.querySelector('[aria-live="polite"][aria-atomic="true"]')?.textContent ?? null;
/** Every swap in our pool stops on its review (owner, 2026-10-13): its "Sign in wallet" is the press that asks the wallet. */
const signOnReview = async () => {
  fireEvent.click(await screen.findByRole('button', { name: 'Sign in wallet' }, { timeout: 20_000 }));
};

describe('range pools in the route', () => {
  it('hidden while the program id is the placeholder: nothing about range pools is read, and the trade is our other pool’s', async () => {
    const buy = await readyToBuy();
    fireEvent.click(buy);
    expect(await screen.findByText('Review your swap', {}, { timeout: 20_000 })).toBeInTheDocument();
    expect(h.prepareVenueSwap).toHaveBeenCalledTimes(1);
    expect(h.prepareRangeSwap).not.toHaveBeenCalled();
    expect(h.readRangeRoutePools).not.toHaveBeenCalled();
  });

  it('shown, a range pool that pays the most takes the trade: built by the range builder, reviewed and toasted with what it pays', async () => {
    h.rangeOn.value = true;
    h.rangeOut.value = 1_020_000n;
    const buy = await readyToBuy();
    await waitFor(() => expect(receive()).toBe('1.02'));
    // A rate with its basis, as the review says it.
    expect(screen.getByTestId('own-pool-fee').textContent).toMatch(/1% of what you pay/);
    fireEvent.click(buy);
    expect(await screen.findByText('Review your swap', {}, { timeout: 20_000 })).toBeInTheDocument();
    expect(h.prepareRangeSwap).toHaveBeenCalledTimes(1);
    expect(h.prepareVenueSwap).not.toHaveBeenCalled();
    const args = h.prepareRangeSwap.mock.calls[0]![2] as VenueSwapArgs;
    expect(args.pool.toBase58()).toBe(RANGE_POOL);
    expect(args).toMatchObject({ amountIn: 100_000_000n, aggregator: { kind: 'quoted', out: 1_000_000n, when: 'now' } });
    // The review is the range pool's own, with its fee and the venue's share from the tier.
    expect(screen.getByText('Range pool')).toBeInTheDocument();
    expect(screen.getByText(/it keeps 16% of each swap’s fee \(0\.16% of the swap\)/)).toBeInTheDocument();
    expect(screen.getByText(/The venue’s cut is split: 10\.4% of each fee \(0\.104% of the swap\) to the team’s shared wallet/)).toBeInTheDocument();
    expect(screen.getByText('Pool fee (inside what you pay)')).toBeInTheDocument();
    expect(screen.getByText(/^1% of what you pay\./)).toBeInTheDocument();
    await signOnReview();
    await waitFor(() => expect(h.submitPrepared).toHaveBeenCalledTimes(1));
    expect((h.submitPrepared.mock.calls[0]![2] as PreparedTx).kind).toBe('range-swap');
    await waitFor(() => expect(h.toast.success).toHaveBeenCalledWith('Bought BAYLA', expect.objectContaining({ description: expect.stringContaining('1.02 BAYLA') })));
    expect(getActivity(USER.toBase58())[0]).toMatchObject({ sig: SIG, summary: 'Bought ≈1.02 BAYLA with 0.1 SOL, in our own pool' });
  });

  it('a pool whose fee comes out of what the trade pays out says so on the form and the review, not "of what you pay"', async () => {
    h.rangeOn.value = true;
    h.rangeOut.value = 1_020_000n;
    h.feeOnInput.value = false;
    // Fees in token 0 (BAYLA) only, and SOL paid in: the fee comes out of the BAYLA paid out.
    h.rangeFeeOn.value = 1;
    const buy = await readyToBuy();
    await waitFor(() => expect(receive()).toBe('1.02'));
    expect(screen.getByTestId('own-pool-fee').textContent).toMatch(/1% of what the pool pays out/);
    fireEvent.click(buy);
    expect(await screen.findByText('Review your swap', {}, { timeout: 20_000 })).toBeInTheDocument();
    // The rate's basis: the pool's payout before the fee, not what reaches the trader.
    expect(screen.getByText('Pool fee (taken before it reaches you)')).toBeInTheDocument();
    expect(screen.getByText(/^1% of what the pool pays out, taken before it reaches you\./)).toBeInTheDocument();
    expect(screen.queryByText(/of what you pay|of what you receive/)).toBeNull();
  });

  it('a range tier whose fund owner is the vault takes the island’s share: the swap review says so in bold, first', async () => {
    h.rangeOn.value = true;
    h.rangeOut.value = 1_020_000n;
    h.fundOwner.value = 'GRMtSxgseKdesExU1BQ22abEspTXV55UPcLaHCd18osd';
    const buy = await readyToBuy();
    await waitFor(() => expect(receive()).toBe('1.02'));
    fireEvent.click(buy);
    expect(await screen.findByText('Review your swap', {}, { timeout: 20_000 })).toBeInTheDocument();
    const first = screen.getByTestId('tx-review-venue-elsewhere');
    expect(first.querySelector('strong')?.textContent).toMatch(/does not follow the agreed split .* 16% of each fee \(0\.16% of the swap\) to the team’s shared wallet, 0% of each fee \(0% of the swap\) to the island’s Workshop\./);
    // First: above every row of the review, said once.
    const before = (a: Element, b: Element) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    expect(before(first, screen.getByText('Range pool'))).toBe(true);
    expect(before(first, screen.getByText('You pay'))).toBe(true);
    expect(document.querySelectorAll('[data-testid="tx-review"] strong')).toHaveLength(1);
    expect(screen.queryByText(/The venue’s cut is split:/)).toBeNull();
  });

  it('shown, a range pool that pays less leaves the trade with our other pool', async () => {
    h.rangeOn.value = true;
    h.rangeOut.value = 1_005_000n;
    const buy = await readyToBuy();
    await waitFor(() => expect(receive()).toBe('1.01'));
    fireEvent.click(buy);
    expect(await screen.findByText('Review your swap', {}, { timeout: 20_000 })).toBeInTheDocument();
    expect(h.prepareVenueSwap).toHaveBeenCalledTimes(1);
    expect(h.prepareRangeSwap).not.toHaveBeenCalled();
  });

  it('shown, with no other pool of ours for the pair, a range pool still takes the trade it pays most for', async () => {
    h.rangeOn.value = true;
    h.rangeOut.value = 1_020_000n;
    h.quoteVenuePools.mockImplementation(() => ({ state: 'absent', candidates: [] }));
    const buy = await readyToBuy();
    await waitFor(() => expect(receive()).toBe('1.02'));
    fireEvent.click(buy);
    expect(await screen.findByText('Review your swap', {}, { timeout: 20_000 })).toBeInTheDocument();
    expect(h.prepareRangeSwap).toHaveBeenCalledTimes(1);
  });
});
