import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, configure, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PublicKey } from '@solana/web3.js';
import type { ReactNode } from 'react';
import { NoRouteError, type JupiterQuote } from '../lib/jupiter';
import type { PreparedTx, SubmitDeps, VenueSwapArgs } from '../components/solana/curve/ports';
import { SOL_QUOTE } from '../lib/solana/lp/quotes';

/**
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
  searchTokens: vi.fn(),
  resolveMint: vi.fn(),
  getShield: vi.fn(),
  readVenue: vi.fn(),
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
  searchTokens: (...a: unknown[]) => h.searchTokens(...a),
  resolveMint: (...a: unknown[]) => h.resolveMint(...a),
}));
vi.mock('../lib/jupiter', async (orig) => ({
  ...(await orig<typeof import('../lib/jupiter')>()),
  getQuote: h.getQuote,
  buildSwapTransaction: h.buildSwapTransaction,
  simulateSwap: h.simulateSwap,
  swapCarriesPlatformFee: () => h.carriesFee.value,
  getUsdPrices: vi.fn(async () => ({})),
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
vi.mock('../lib/solana/swap/ownPoolSwapFlag', () => ({ ownPoolSwapsOn: () => h.on.value }));
vi.mock('../components/swap/venueSwapApi', () => ({
  loadVenueSwapApi: async () => (h.loads.value++, h.loadFails.value ? Promise.reject(new TypeError('Failed to fetch dynamically imported module: /assets/venueSwap.js')) : {
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
  getParsedTokenAccountsByOwner: async () => ({ value: h.tokenHeld.value === null ? [] : [{ account: { data: { parsed: { info: { tokenAmount: { amount: h.tokenHeld.value } } } } } }] }),
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
import { SWAP_PENDING_SCOPE, savePendingTrade } from '../components/solana/curve/pendingTrade';

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
  h.tokenHeld.value = null;
  h.loadFails.value = false;
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
/** The line under the quote that says where the trade goes, found by its label (the quote details have a "Route" row too). */
const routeLine = () => screen.getAllByText('Route').map((el) => el.closest('p')).find(Boolean)?.textContent ?? '';
const amountBox = () => screen.getByLabelText('Amount of SOL to pay') as HTMLInputElement;
/** The form is on screen again, and no card or review stands in its place. */
const backOnTheForm = () => {
  expect(screen.queryByTestId('tx-outcome')).toBeNull();
  expect(screen.queryByText('Review your swap')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Start over' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();
  expect(amountBox()).toBeInTheDocument();
};

describe('our own pool pays more: the trade goes there', () => {
  it('ONE press: Buy hands the swap in our pool to the wallet, with no review screen and no second button', async () => {
    const buy = await readyToBuy();
    // The page already shows the route and its figure: our pool's 1.01, not Jupiter's 1.
    await waitFor(() => expect(routeLine()).toMatch(/Our pool pays 1% more than Jupiter\./));
    expect(receive()).toBe('1.01');
    expect(screen.getByTestId('own-pool-fee').textContent).toMatch(/1% a trade/);

    fireEvent.click(buy);
    // The wallet is asked without another press, and the review never took the form's place.
    await waitFor(() => expect(h.submitPrepared).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('Review your swap')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Sign in wallet' })).toBeNull();
    expect((h.submitPrepared.mock.calls[0]![2] as PreparedTx).kind).toBe('venue-swap');
    expect(h.buildSwapTransaction).not.toHaveBeenCalled();
    expect(h.sendTransaction).not.toHaveBeenCalled();

    // Built against that pool, for the pair and amount on screen, and held to Jupiter's FRESH quote.
    expect(h.prepareVenueSwap).toHaveBeenCalledTimes(1);
    const args = h.prepareVenueSwap.mock.calls[0]![2] as VenueSwapArgs;
    expect(args.pool.toBase58()).toBe(POOL);
    expect([args.inputMint.toBase58(), args.outputMint.toBase58()]).toEqual([SOL_MINT, BAYLA_MINT]);
    expect(args).toMatchObject({ amountIn: 100_000_000n, slippageBps: 50n, aggregator: { kind: 'quoted', out: 1_000_000n, when: 'now' } });
    expect(args.owner.equals(USER)).toBe(true);

    // The one cost the form does not show, said as the wallet opens: this buy opens a token account.
    expect(h.toast.info).toHaveBeenCalledWith('One-time deposit: 0.002074 SOL', { description: 'It opens your account for what you receive, and it stays in that account.' });

    // When it lands: one line says so, and the form is ready again with nothing to close.
    await waitFor(() => expect(h.toast.success).toHaveBeenCalledWith('Bought BAYLA', expect.objectContaining({ description: expect.stringContaining('1.01 BAYLA') })));
    await waitFor(backOnTheForm);
    expect(amountBox().value).toBe('');
    // And it is kept where a Jupiter swap is kept.
    expect(getActivity(USER.toBase58())[0]).toMatchObject({ sig: SIG, kind: 'swap', summary: 'Bought ≈1.01 BAYLA with 0.1 SOL, in our own pool' });
  });

  it('while the wallet has it, the form stays and the button says whose turn it is', async () => {
    let land: (o: unknown) => void = () => {};
    h.submitPrepared.mockImplementation(() => new Promise((r) => { land = r; }));
    const buy = await readyToBuy();
    fireEvent.click(buy);
    expect(await screen.findByRole('button', { name: 'Confirm in your wallet…' })).toBeDisabled();
    expect(amountBox()).toBeInTheDocument();
    expect(screen.queryByText('Review your swap')).toBeNull();
    // One line says what the wallet is being asked, from the transaction itself, in place of the route line.
    expect(screen.getByTestId('own-swap-status').textContent).toBe('At your wallet: 0.1 SOL for 1.01 BAYLA, at least 1.00495.');
    expect(screen.queryByText(/Our pool pays|Jupiter pays/)).toBeNull();
    // And the trade cannot be changed under it: the wallet is asked for what was pressed.
    expect(amountBox()).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Flip pay and receive tokens' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Limit order' })).toBeDisabled();
    land({ status: 'confirmed', signature: SIG, slot: 7 });
    await waitFor(() => expect(h.toast.success).toHaveBeenCalled());
  });

  it('a wallet that already has the account is told of no deposit', async () => {
    h.prepareVenueSwap.mockImplementation(async (_rpc: unknown, _gate: unknown, a: VenueSwapArgs) => {
      const p = preparedSwap(a, 1_010_000n);
      return { ok: true, prepared: { ...p, fees: { ...p.fees, newAccountRentLamports: 0n } } };
    });
    const buy = await readyToBuy();
    fireEvent.click(buy);
    await waitFor(() => expect(h.submitPrepared).toHaveBeenCalledTimes(1));
    expect(h.toast.info).not.toHaveBeenCalled();
  });

  it('a tie stays in our pool', async () => {
    h.ownOut.value = 1_000_000n;
    const buy = await readyToBuy();
    await waitFor(() => expect(routeLine()).toMatch(/Our pool matches Jupiter, so the trade stays here/));
    fireEvent.click(buy);
    await waitFor(() => expect(h.submitPrepared).toHaveBeenCalledTimes(1));
    expect((h.prepareVenueSwap.mock.calls[0]![2] as VenueSwapArgs).aggregator).toEqual({ kind: 'quoted', out: 1_000_000n, when: 'now' });
    expect(h.buildSwapTransaction).not.toHaveBeenCalled();
  });

  it('a pool that is the only venue to quote fills the trade Jupiter has no route for', async () => {
    const { NoRouteError } = await import('../lib/jupiter');
    h.getQuote.mockImplementation(async () => { throw new NoRouteError(); });
    const buy = await readyToBuy();
    await waitFor(() => expect(routeLine()).toMatch(/Only our pool quoted this pair\./));
    expect(screen.queryByText(/No route for this pair/)).toBeNull();
    fireEvent.click(buy);
    await waitFor(() => expect(h.submitPrepared).toHaveBeenCalledTimes(1));
    expect((h.prepareVenueSwap.mock.calls[0]![2] as VenueSwapArgs).aggregator).toEqual({ kind: 'no-route' });
  });
});

describe('the form is held while a swap is being prepared', () => {
  it('nothing on it can be changed between the press and the wallet', async () => {
    h.prepareVenueSwap.mockImplementation(() => new Promise(() => {}));
    const buy = await readyToBuy();
    fireEvent.click(buy);
    expect(await screen.findByRole('button', { name: 'Preparing…' })).toBeDisabled();
    expect(screen.getByTestId('own-swap-status').textContent).toBe('Checking both prices once more…');
    expect(amountBox()).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Flip pay and receive tokens' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'DCA' })).toBeDisabled();
  });
});

describe('a swap that needs a second look still stops on the review', () => {
  const stopsOnReview = async () => {
    const buy = await readyToBuy();
    fireEvent.click(buy);
    expect(await screen.findByText('Review your swap', {}, { timeout: 20_000 })).toBeInTheDocument();
    // Nothing reached the wallet: that takes the press on the review.
    await new Promise((r) => setTimeout(r, 300));
    expect(h.submitPrepared).not.toHaveBeenCalled();
  };

  it('when Jupiter could not be asked at all: the page and the review say it was not compared', async () => {
    h.getQuote.mockImplementation(async () => { throw new Error('Quote failed (502)'); });
    render(<MemoryRouter><SolanaSwapPage /></MemoryRouter>);
    fireEvent.change(amountBox(), { target: { value: '0.1' } });
    const buy = await screen.findByRole('button', { name: 'Buy BAYLA' }, { timeout: 20_000 });
    await waitFor(() => expect(buy).toBeEnabled());
    // The line says what happened, not more: only our pool QUOTED. It does not say no other route exists.
    expect(routeLine()).toMatch(/Only our pool quoted this pair\./);
    expect(routeLine()).not.toMatch(/only route/);
    // The notice stays: what is missing is the comparison, and Try again asks for it.
    expect(screen.getByTestId('solana-quote-unavailable').textContent).toMatch(/Jupiter could not be asked for a quote just now, so our pool was not compared with it\./);
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    fireEvent.click(buy);
    expect(await screen.findByText('Review your swap', {}, { timeout: 20_000 })).toBeInTheDocument();
    expect((h.prepareVenueSwap.mock.calls[0]![2] as VenueSwapArgs).aggregator).toEqual({ kind: 'unreachable' });
    expect(screen.getByText('Jupiter could not be asked just now, so this trade was not compared with it')).toBeInTheDocument();
    expect(screen.queryByText(/no route|only route/)).toBeNull();
    expect(h.submitPrepared).not.toHaveBeenCalled();
    // The press on the review sends it, and a landed swap returns to the form like any other.
    fireEvent.click(screen.getByRole('button', { name: 'Sign in wallet' }));
    await waitFor(() => expect(h.submitPrepared).toHaveBeenCalledTimes(1));
    await waitFor(backOnTheForm);
  });

  it('when the price moved under what the form showed: the new figures are read before anything is signed', async () => {
    const buy = await readyToBuy();
    await waitFor(() => expect(receive()).toBe('1.01'));
    // Both venues fall between the quote on screen and the press. Our pool still wins, at 0.909.
    h.ownOut.value = 909_000n;
    h.getQuote.mockImplementation(async () => jupiterQuote('900000'));
    fireEvent.click(buy);
    expect(await screen.findByText('Review your swap', {}, { timeout: 20_000 })).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 300));
    expect(h.submitPrepared).not.toHaveBeenCalled();
  });

  it('a price that moved the trader’s way, or stayed inside their slippage, still goes straight', async () => {
    const buy = await readyToBuy();
    await waitFor(() => expect(receive()).toBe('1.01'));
    // 1.005: under the 1.01 shown, and above the 1.00495 minimum the form showed.
    h.ownOut.value = 1_005_000n;
    fireEvent.click(buy);
    await waitFor(() => expect(h.submitPrepared).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('Review your swap')).toBeNull();
  });

  it('when a sale for SOL would be paid as wrapped SOL into an account the wallet already had', async () => {
    h.prepareVenueSwap.mockImplementation(async (_rpc: unknown, _gate: unknown, a: VenueSwapArgs) => {
      const p = preparedSwap(a, 1_010_000n);
      const s = p.summary as Extract<PreparedTx['summary'], { kind: 'venue-swap' }>;
      return { ok: true, prepared: { ...p, summary: { ...s, paysCoin: false, unwrapsWsol: false, wsolHeldBefore: 200_000_000n } } };
    });
    await stopsOnReview();
  });

  it('when the builder left a notice for the trader', async () => {
    h.prepareVenueSwap.mockImplementation(async (_rpc: unknown, _gate: unknown, a: VenueSwapArgs) => {
      const p = preparedSwap(a, 1_010_000n);
      return { ok: true, prepared: { ...p, summary: { ...p.summary, notices: ['Someone else can close your token account once it is empty.'] } } };
    });
    await stopsOnReview();
    expect(screen.getByText('Someone else can close your token account once it is empty.')).toBeInTheDocument();
  });

  it('when the trade moves the price by 5% or more', async () => {
    h.prepareVenueSwap.mockImplementation(async (_rpc: unknown, _gate: unknown, a: VenueSwapArgs) => {
      const p = preparedSwap(a, 1_010_000n);
      const s = p.summary as Extract<PreparedTx['summary'], { kind: 'venue-swap' }>;
      return { ok: true, prepared: { ...p, summary: { ...s, quoted: { ...s.quoted, priceImpact: 0.06 } } } };
    });
    await stopsOnReview();
  });

  it('when the priority fee could not be read', async () => {
    h.prepareVenueSwap.mockImplementation(async (_rpc: unknown, _gate: unknown, a: VenueSwapArgs) => {
      const p = preparedSwap(a, 1_010_000n);
      return { ok: true, prepared: { ...p, fees: { ...p.fees, priorityFeeRead: false } } };
    });
    await stopsOnReview();
  });
});

describe('endings that need nothing read return to the form by themselves', () => {
  it('a decline in the wallet: one line, the amount still typed, Buy live again', async () => {
    h.submitPrepared.mockImplementation(async () => ({ status: 'not-sent', stage: 'sign', message: 'You cancelled in your wallet. Nothing was sent.' }));
    const buy = await readyToBuy();
    fireEvent.click(buy);
    await waitFor(() => expect(h.toast.info).toHaveBeenCalledWith('Not sent', { description: 'You cancelled in your wallet. Nothing was sent.' }));
    await waitFor(backOnTheForm);
    expect(amountBox().value).toBe('0.1');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Buy BAYLA' })).toBeEnabled());
    expect(getActivity(USER.toBase58())).toEqual([]);
  });

  it('a wallet that changed the transaction is NOT a decline: its card stays, with the reason', async () => {
    const reason = 'Blocked after your wallet changed it: an instruction was added. Nothing was sent.';
    h.submitPrepared.mockImplementation(async () => ({ status: 'not-sent', stage: 'sign', message: reason }));
    const buy = await readyToBuy();
    fireEvent.click(buy);
    const card = await screen.findByTestId('tx-outcome', {}, { timeout: 20_000 });
    expect(card.getAttribute('data-status')).toBe('not-sent');
    expect(card.textContent).toContain(reason);
    expect(h.toast.info).not.toHaveBeenCalledWith('Not sent', expect.anything());
  });

  it('a swap the network refused keeps its card: that one has a reason to read', async () => {
    h.submitPrepared.mockImplementation(async (_rpc: unknown, _signer: unknown, p: PreparedTx, deps?: SubmitDeps) => {
      deps?.onSent?.(SIG, p.lastValidBlockHeight);
      return { status: 'reverted', signature: SIG, reason: 'The price moved past your limit.' };
    });
    const buy = await readyToBuy();
    fireEvent.click(buy);
    const card = await screen.findByTestId('tx-outcome', {}, { timeout: 20_000 });
    expect(card.getAttribute('data-status')).toBe('reverted');
    expect(h.toast.success).not.toHaveBeenCalled();
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
    await waitFor(() => expect(routeLine()).toMatch(/Our pool pays/));
    fireEvent.click(buy);
    // One line says the route changed, and the form is back with the new route on it: no card to dismiss.
    await waitFor(() => expect(h.toast.error).toHaveBeenCalledWith('Route changed', { description: OWN_ROUTE_COPY.routeMoved }), { timeout: 20_000 });
    expect(h.prepareVenueSwap).not.toHaveBeenCalled();
    expect(h.sendTransaction).not.toHaveBeenCalled();
    await waitFor(backOnTheForm);

    // The no-fee quote is on screen now, the line names Jupiter, and it stays so.
    await waitFor(() => expect(routeLine()).toMatch(/Jupiter pays/), { timeout: 20_000 });
    expect(receive()).toBe('1.012');
    expect(screen.getByTestId('site-fee-value').textContent).toBe('None on this route');
    await new Promise((r) => setTimeout(r, 700));
    expect(routeLine()).toMatch(/Jupiter pays/);

    // Buy again: Jupiter's no-fee transaction is the one the wallet is asked for.
    h.toast.error.mockClear();
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
    await waitFor(() => expect(h.submitPrepared).toHaveBeenCalledTimes(1), { timeout: 20_000 });
    expect((h.prepareVenueSwap.mock.calls[0]![2] as VenueSwapArgs).aggregator).toEqual({ kind: 'quoted', out: 1_005_000n, when: 'now' });
    expect(h.sendTransaction).not.toHaveBeenCalled();
  });

  it('Jupiter was shown: our pool is compared with the transaction about to be signed, the no-fee one included', async () => {
    h.simulateSwap.mockImplementation(async (b64: string) => (b64 === TX_FEE ? JUP_6014 : OK));
    // 1.008: above the fee-bearing quote now on screen? No: the page shows 1.005 and our pool 1.004.
    h.ownOut.value = 1_004_000n;
    const buy = await readyToBuy();
    await waitFor(() => expect(routeLine()).toMatch(/Jupiter pays/));
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
    await waitFor(() => expect(routeLine()).toMatch(/Jupiter pays under 0\.001% more than our pool\./));
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
  it('our pool was shown, and Jupiter now pays more: nothing is built, one line says why, and the form shows the new route', async () => {
    const buy = await readyToBuy();
    await waitFor(() => expect(routeLine()).toMatch(/Our pool pays/));
    // Jupiter's price moves past our pool's between the quote on screen and the click.
    h.getQuote.mockImplementation(async () => jupiterQuote('1010001'));
    fireEvent.click(buy);
    await waitFor(() => expect(h.toast.error).toHaveBeenCalledWith('Route changed', { description: OWN_ROUTE_COPY.routeMoved }), { timeout: 20_000 });
    expect(h.prepareVenueSwap).not.toHaveBeenCalled();
    expect(h.buildSwapTransaction).not.toHaveBeenCalled();
    expect(h.sendTransaction).not.toHaveBeenCalled();
    await waitFor(backOnTheForm);
    expect(amountBox().value).toBe('0.1');
    await waitFor(() => expect(routeLine()).toMatch(/Jupiter pays/), { timeout: 20_000 });
    // The words tell the trader what to do on the form they are now looking at.
    expect(OWN_ROUTE_COPY.routeMoved).not.toMatch(/Start over/);
    expect(OWN_ROUTE_COPY.poolGone).not.toMatch(/Start over/);
    // The button may read Sell: no sentence here names it Buy.
    for (const line of Object.values(OWN_ROUTE_COPY)) expect(line).not.toMatch(/\bBuy\b/);
  });

  it('Jupiter was shown, and our pool now pays at least as much: nothing is sent, and the page shows the new route', async () => {
    h.ownOut.value = 990_000n;
    const buy = await readyToBuy();
    await waitFor(() => expect(routeLine()).toMatch(/Jupiter pays/));
    // The pool is read again at the click, and it has moved to a tie.
    h.ownOut.value = 1_000_000n;
    fireEvent.click(buy);
    await waitFor(() => expect(h.toast.error).toHaveBeenCalledWith('Route changed', { description: OWN_ROUTE_COPY.ownNowWins }));
    expect(h.buildSwapTransaction).not.toHaveBeenCalled();
    expect(h.sendTransaction).not.toHaveBeenCalled();
    await waitFor(() => expect(routeLine()).toMatch(/Our pool matches Jupiter, so the trade stays here/));
  });

  it('Buy pressed while our pool was still being read: it is read before anything is sent, and takes the trade it wins', async () => {
    // The first read of our pools never answers; Jupiter's quote lands and Buy is live.
    h.readVenuePools.mockImplementationOnce(() => new Promise(() => {}));
    const buy = await readyToBuy({ poolsAnswer: false });
    expect(routeLine()).toMatch(/Checking our pools/);
    fireEvent.click(buy);
    await waitFor(() => expect(h.toast.error).toHaveBeenCalledWith('Route changed', { description: OWN_ROUTE_COPY.ownNowWins }));
    expect(h.buildSwapTransaction).not.toHaveBeenCalled();
    expect(h.sendTransaction).not.toHaveBeenCalled();
    await waitFor(() => expect(routeLine()).toMatch(/Our pool pays/));
  });

  it('a read of our pool that hangs at the click does not hold the trade: Jupiter’s goes ahead as shown', async () => {
    h.ownOut.value = 990_000n;
    const buy = await readyToBuy();
    await waitFor(() => expect(routeLine()).toMatch(/Jupiter pays/));
    h.readVenuePools.mockImplementation(() => new Promise(() => {}));
    fireEvent.click(buy);
    await waitFor(() => expect(h.sendTransaction).toHaveBeenCalledTimes(1), { timeout: 30_000 });
    expect(h.prepareVenueSwap).not.toHaveBeenCalled();
  });

  it('Jupiter was shown and still pays more at the click: its transaction is sent', async () => {
    h.ownOut.value = 990_000n;
    const buy = await readyToBuy();
    await waitFor(() => expect(routeLine()).toMatch(/Jupiter pays/));
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
  it('holds the screen with its card, is kept in the activity list, clears the form, and holds the next buy after a reload', async () => {
    h.submitPrepared.mockImplementation(async (_rpc: unknown, _signer: unknown, p: PreparedTx, deps?: SubmitDeps) => {
      deps?.onSent?.(SIG, p.lastValidBlockHeight);
      return { status: 'unknown', signature: SIG, message: 'The network has no record of it yet. It may still be landing.' };
    });
    const buy = await readyToBuy();
    fireEvent.click(buy);
    // This ending is never passed over: the swap may still land, so the card stays until it is read.
    expect(await screen.findByText('Sent, not confirmed yet. Do not retry until you check.', {}, { timeout: 20_000 })).toBeInTheDocument();
    expect(h.toast.success).not.toHaveBeenCalled();
    expect(getActivity(USER.toBase58())[0]).toMatchObject({ sig: SIG, summary: 'Sent, not confirmed: ≈1.01 BAYLA with 0.1 SOL, in our own pool' });

    // A reload: the note is found, said, and Buy is held until it is checked.
    cleanup();
    render(<MemoryRouter><SolanaSwapPage /></MemoryRouter>);
    expect(await screen.findByTestId('venue-swap-pending')).toBeInTheDocument();
    expect(screen.getByText(SIG)).toBeInTheDocument();
    expect(amountBox().value).toBe('');
    fireEvent.change(amountBox(), { target: { value: '0.1' } });
    const again = await screen.findByRole('button', { name: 'Buy BAYLA' }, { timeout: 20_000 });
    await waitFor(() => expect(receive()).toBe('1.01'));
    expect(again).toBeDisabled();
  });
});

describe('a swap in our pool that the chain answers after the wallet changed', () => {
  const OTHER = new PublicKey(new Uint8Array(32).fill(9));
  const live = wallet as unknown as { publicKey: PublicKey | null };
  afterEach(() => { live.publicKey = USER; });

  /** Press Buy, let the swap be sent, and hold the chain's answer until `finish`. */
  async function sentAndHeld() {
    let finish: (o: { status: 'confirmed'; signature: string; slot: number }) => void = () => {};
    h.submitPrepared.mockImplementation(async (_rpc: unknown, _signer: unknown, p: PreparedTx, deps?: SubmitDeps) => {
      deps?.onSent?.(SIG, p.lastValidBlockHeight);
      return new Promise((res) => { finish = res; });
    });
    const r = render(<MemoryRouter><SolanaSwapPage /></MemoryRouter>);
    fireEvent.change(amountBox(), { target: { value: '0.1' } });
    const buy = await screen.findByRole('button', { name: 'Buy BAYLA' });
    await waitFor(() => expect(h.readSwapGate).toHaveBeenCalled());
    await waitFor(() => expect(buy).toBeEnabled());
    fireEvent.click(buy);
    await waitFor(() => expect(h.submitPrepared).toHaveBeenCalledTimes(1));
    return { r, finish: () => finish({ status: 'confirmed', signature: SIG, slot: 7 }) };
  }

  it('is recorded for the wallet that signed it, not the one connected when it lands', async () => {
    const { r, finish } = await sentAndHeld();
    live.publicKey = OTHER;
    r.rerender(<MemoryRouter><SolanaSwapPage /></MemoryRouter>);
    finish();
    await waitFor(() => expect(getActivity(USER.toBase58())[0]).toMatchObject({ sig: SIG, summary: 'Bought ≈1.01 BAYLA with 0.1 SOL, in our own pool' }));
    expect(getActivity(OTHER.toBase58())).toEqual([]);
  });

  it('with the wallet gone, it is still recorded and the form is still cleared', async () => {
    const { r, finish } = await sentAndHeld();
    live.publicKey = null;
    r.rerender(<MemoryRouter><SolanaSwapPage /></MemoryRouter>);
    finish();
    await waitFor(() => expect(getActivity(USER.toBase58())[0]).toMatchObject({ sig: SIG }));
    await waitFor(() => expect(amountBox().value).toBe(''));
  });

  it('the balance it was paid from is read again once it lands', async () => {
    const reads = vi.spyOn(connection, 'getBalance');
    const { finish } = await sentAndHeld();
    const before = reads.mock.calls.length;
    finish();
    await waitFor(() => expect(getActivity(USER.toBase58())[0]).toMatchObject({ sig: SIG }));
    await waitFor(() => expect(reads.mock.calls.length).toBeGreaterThan(before));
    reads.mockRestore();
  });
});

describe('a venue read that failed, or has not answered yet, is not the page’s answer', () => {
  // The venue read is cached in module scope (useSolanaRoute.ts): an earlier test's live
  // answer would stand in for this visit's. Each case loads the page as a new visit does.
  async function freshPageWithAmount() {
    vi.resetModules();
    const { default: Page } = await import('./SolanaSwapPage');
    render(<MemoryRouter><Page /></MemoryRouter>);
    fireEvent.change(screen.getByLabelText('Amount of SOL to pay'), { target: { value: '0.1' } });
    const buy = await screen.findByRole('button', { name: 'Buy BAYLA' }, { timeout: 20_000 });
    await waitFor(() => expect(buy).toBeEnabled());
    return buy;
  }
  const LIVE = { kind: 'live', programId: PROGRAM, config: TIER1_CONFIG };
  /** Settled once the press has done its one thing: changed the route, or sent Jupiter's transaction. */
  const pressAnswered = () => expect(h.toast.error.mock.calls.length + h.sendTransaction.mock.calls.length).toBeGreaterThan(0);

  it('one failed read at load: Buy reads the venue again, our pool takes the trade it wins, and Jupiter’s is never sent', async () => {
    const down = { value: true };
    h.readVenue.mockImplementation(async () => (down.value ? { kind: 'unreadable', detail: 'getAccountInfo: HTTP 429' } : LIVE));
    const buy = await freshPageWithAmount();
    await waitFor(() => expect(routeLine()).toMatch(/Our pool could not be quoted/));
    expect(receive()).toBe('1');
    // The proxy answers again; the trader presses Buy on the page as it stands.
    down.value = false;
    fireEvent.click(buy);
    await waitFor(pressAnswered);
    expect(h.sendTransaction.mock.calls.length, 'Jupiter transactions sent').toBe(0);
    expect(h.toast.error).toHaveBeenCalledWith('Route changed', { description: OWN_ROUTE_COPY.ownNowWins });
    // The venue found live at the press is the page's venue from then on: the line, the
    // figure and the next press are our pool's, not one more round of "Route changed".
    await waitFor(() => expect(routeLine()).toMatch(/Our pool pays 1% more than Jupiter/));
    expect(receive()).toBe('1.01');
    await waitFor(() => expect(h.readSwapGate).toHaveBeenCalled());
    const again = screen.getByRole('button', { name: 'Buy BAYLA' });
    await waitFor(() => expect(again).toBeEnabled());
    fireEvent.click(again);
    await waitFor(() => expect(h.submitPrepared).toHaveBeenCalledTimes(1));
    expect(h.sendTransaction.mock.calls.length, 'Jupiter transactions sent').toBe(0);
  });

  it('one failed read at load: the next amount asks the venue again, and the line and the figure are our pool’s', async () => {
    const down = { value: true };
    h.readVenue.mockImplementation(async () => (down.value ? { kind: 'unreadable', detail: 'getAccountInfo: HTTP 502' } : LIVE));
    await freshPageWithAmount();
    await waitFor(() => expect(routeLine()).toMatch(/Our pool could not be quoted/));
    down.value = false;
    fireEvent.change(amountBox(), { target: { value: '0.2' } });
    await waitFor(() => expect(routeLine()).toMatch(/Our pool pays 1% more than Jupiter/));
    expect(receive()).toBe('1.01');
  });

  it('Buy pressed before the venue has answered: the venue and our pools are read before anything is sent', async () => {
    let answer: (v: unknown) => void = () => {};
    h.readVenue.mockImplementation(() => new Promise((r) => { answer = r; }));
    const buy = await freshPageWithAmount();
    // The page says "whichever pays more" meanwhile: the line under the quote does not go blank.
    expect.soft(screen.queryByTestId('solana-route-line'), 'route line while the venue is being read').not.toBeNull();
    fireEvent.click(buy);
    // The venue answers while the press is held, well inside its 4 s bound.
    await new Promise((r) => setTimeout(r, 300));
    answer(LIVE);
    await waitFor(pressAnswered);
    expect(h.sendTransaction.mock.calls.length, 'Jupiter transactions sent').toBe(0);
    expect(h.toast.error).toHaveBeenCalledWith('Route changed', { description: OWN_ROUTE_COPY.ownNowWins });
    await waitFor(() => expect(routeLine()).toMatch(/Our pool pays 1% more than Jupiter/));
  });
});

describe('a note found on arrival, with the swap code not loaded', () => {
  it('“Check again” answers: the status line says what became of the check, and the note stays', async () => {
    savePendingTrade(SWAP_PENDING_SCOPE, { kind: 'venue-swap', signature: SIG, lastValidBlockHeight: 1_000 }, Date.now() - 5_000);
    h.loadFails.value = true;
    render(<MemoryRouter><SolanaSwapPage /></MemoryRouter>);
    const card = await screen.findByTestId('venue-swap-pending');
    await waitFor(() => expect(h.loads.value).toBeGreaterThan(0));
    fireEvent.click(within(card).getByRole('button', { name: 'Check again' }));
    // Well before the 15 s retry of the load: the press itself answers.
    await waitFor(() => expect(within(card).getByRole('status').textContent).not.toBe(''), { timeout: 3_000 });
    expect(screen.getByTestId('venue-swap-pending')).toBeInTheDocument();
    expect(screen.getByText(SIG)).toBeInTheDocument();
  });
});

describe('while Jupiter’s transaction is at the wallet, the page describes Jupiter’s trade', () => {
  /** What the page says while the wallet holds a transaction: the figure, the fee row, the footer, any word of our pool. */
  const atWallet = () => ({
    receive: receive(),
    ownFeeRow: screen.queryByTestId('own-pool-fee') !== null,
    footer: screen.getByTestId('swap-footer').textContent,
    saysOurPool: screen.queryAllByText(/Our pool pays|Our pool matches|via our pool/).length > 0,
  });
  const jupiters = (s: ReturnType<typeof atWallet>, figure: string) => {
    expect(s).toMatchObject({ receive: figure, ownFeeRow: false, saysOurPool: false });
    expect(s.footer).not.toBe('No platform fee on a swap in our own pool.');
  };

  it.each([
    ['a pair that carries the site fee', true],
    ['a pair with no site fee', false],
  ])('%s: Jupiter’s re-quote at the press is not set against an older read of our pool', async (_name, fee) => {
    h.carriesFee.value = fee;
    h.ownOut.value = 997_000n;
    const buy = await readyToBuy();
    await waitFor(() => expect(routeLine()).toMatch(/Jupiter pays/));
    expect(receive()).toBe('1');
    // At the press Jupiter re-quotes 0.996 (inside the 0.5% slippage), and our pool's read hangs.
    h.getQuote.mockImplementation(async () => jupiterQuote('996000'));
    h.readVenuePools.mockImplementation(() => new Promise(() => {}));
    h.buildSwapTransaction.mockImplementation(() => new Promise((r) => setTimeout(() => r(JUPITER_TX), 150)));
    const seen: ReturnType<typeof atWallet>[] = [];
    h.sendTransaction.mockImplementation(() => { seen.push(atWallet()); return new Promise(() => {}); });
    fireEvent.click(buy);
    await waitFor(() => expect(h.sendTransaction).toHaveBeenCalledTimes(1), { timeout: 30_000 });
    expect(h.prepareVenueSwap).not.toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 300));
    seen.push(atWallet());
    for (const s of seen) jupiters(s, '0.996');
  });

  it('a read of our pool that lands after the press went ahead does not change what the page says', async () => {
    h.ownOut.value = 990_000n;
    const buy = await readyToBuy();
    await waitFor(() => expect(routeLine()).toMatch(/Jupiter pays/));
    let land!: (v: unknown) => void;
    h.readVenuePools.mockImplementation(() => new Promise((r) => { land = r; }));
    h.sendTransaction.mockImplementation(() => new Promise(() => {}));
    fireEvent.click(buy);
    await waitFor(() => expect(h.sendTransaction).toHaveBeenCalledTimes(1), { timeout: 30_000 });
    // The read the press gave up on lands now, with our pool ahead, while the wallet holds Jupiter's transaction.
    const quotes = h.quoteVenuePools.mock.calls.length;
    h.ownOut.value = 1_010_000n;
    land({ kind: 'ok' });
    await waitFor(() => expect(h.quoteVenuePools.mock.calls.length).toBeGreaterThan(quotes));
    await new Promise((r) => setTimeout(r, 300));
    jupiters(atWallet(), '1');
    expect(h.prepareVenueSwap).not.toHaveBeenCalled();
  });
});

describe('Buy pressed while our pools are still being read, on a slow network', () => {
  it('a read that has not answered is not a comparison our pool lost: Jupiter’s transaction is not sent', async () => {
    // Every read of our pools takes 5 s; our pool pays 1.01 against Jupiter's 1. The wallet does not answer.
    h.readVenuePools.mockImplementation(() => new Promise((r) => setTimeout(() => r({ kind: 'ok' }), 5_000)));
    h.sendTransaction.mockImplementation(() => new Promise(() => {}));
    render(<MemoryRouter><SolanaSwapPage /></MemoryRouter>);
    fireEvent.change(screen.getByLabelText('Amount of SOL to pay'), { target: { value: '0.1' } });
    await waitFor(() => expect(routeLine()).toMatch(/Checking our pools/), { timeout: 20_000 });
    // The swap's action button, whatever it says and whether or not it is held.
    fireEvent.click(document.querySelector('button.btn-primary') as HTMLButtonElement);
    // The first read lands with our pool ahead; then the press's own read has had its 5 s.
    await waitFor(() => expect(routeLine()).toMatch(/Our pool pays/), { timeout: 20_000 });
    await new Promise((r) => setTimeout(r, 1_500));
    expect(h.sendTransaction).not.toHaveBeenCalled();
    expect(h.buildSwapTransaction).not.toHaveBeenCalled();
  });
});

describe('a press reads the pool it shows straight from the chain', () => {
  it('the press’s read of our pools names the pool on screen, so a pool index that does not answer cannot hide it', async () => {
    const buy = await readyToBuy();
    await waitFor(() => expect(routeLine()).toMatch(/Our pool pays/));
    const before = h.readVenuePools.mock.calls.length;
    fireEvent.click(buy);
    await waitFor(() => expect(h.readVenuePools.mock.calls.length).toBeGreaterThan(before));
    const opts = h.readVenuePools.mock.calls.at(-1)![3] as { also?: readonly string[] };
    expect(opts.also).toContain(POOL);
  });
});

describe('"No route" only after our pools were found to have nothing', () => {
  async function typed() {
    render(<MemoryRouter><SolanaSwapPage /></MemoryRouter>);
    fireEvent.change(amountBox(), { target: { value: '0.1' } });
    await waitFor(() => expect(h.getQuote).toHaveBeenCalled());
    await waitFor(() => expect(h.quoteVenuePools).toHaveBeenCalled());
  }
  const cta = () => (document.querySelector('button.btn-primary') as HTMLButtonElement).textContent;

  it('Jupiter has no route and our pools could not be read: not "No route", the line says which, and Try again reads our pools again', async () => {
    h.getQuote.mockImplementation(async () => { throw new NoRouteError(); });
    h.ownOut.value = null;
    await typed();
    await waitFor(() => expect(routeLine()).toMatch(/Our pool could not be quoted this time, and Jupiter has no route for this pair and amount\./));
    expect(screen.queryByText('No route for this pair / amount.')).toBeNull();
    expect(cta()).not.toBe('No route');
    const reads = h.readVenuePools.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(h.readVenuePools.mock.calls.length).toBeGreaterThan(reads));
  });

  it('Jupiter has no route and our pool quoted but cannot be sent here: not "No route"', async () => {
    h.getQuote.mockImplementation(async () => { throw new NoRouteError(); });
    h.readSwapGate.mockImplementation(async () => ({ kind: 'blocked', reason: 'unreadable', detail: 'HTTP 502' }));
    await typed();
    await waitFor(() => expect(routeLine()).toMatch(/cannot be prepared here right now/));
    expect(screen.queryByText('No route for this pair / amount.')).toBeNull();
    expect(cta()).not.toBe('No route');
  });

  it('Jupiter has no route and we have no pool for the pair: "No route" is the finding', async () => {
    h.getQuote.mockImplementation(async () => { throw new NoRouteError(); });
    h.quoteVenuePools.mockImplementation(() => ({ state: 'absent', candidates: [] }));
    await typed();
    await waitFor(() => expect(screen.getByText('No route for this pair / amount.')).toBeInTheDocument());
    expect(cta()).toBe('No route');
    expect(routeLine()).toMatch(/We have no pool for this pair, and Jupiter has no route for this pair and amount\./);
  });

  it('Jupiter could not be asked and our pool quoted but cannot be sent here: not "it cannot fill"', async () => {
    h.getQuote.mockImplementation(async () => { throw new Error('Quote unavailable (502)'); });
    h.readSwapGate.mockImplementation(async () => ({ kind: 'blocked', reason: 'unreadable', detail: 'HTTP 502' }));
    await typed();
    await waitFor(() => expect(routeLine()).toMatch(/Jupiter could not be asked for a quote just now, so nothing can be sent until one of them answers\./));
    expect(routeLine()).not.toMatch(/cannot fill/);
  });
});

describe('the risk tick-box: never for the venue’s own coins, once per token for the rest', () => {
  const OTHER = 'Dog1111111111111111111111111111111111111111';
  const other = { mint: OTHER, symbol: 'DOGGO', name: 'Doggo', decimals: 6, verified: false };
  const openOn = async (mint: string) => {
    window.history.replaceState(null, '', `/solana?out=${mint}`);
    render(<MemoryRouter><SolanaSwapPage /></MemoryRouter>);
    fireEvent.change(amountBox(), { target: { value: '0.1' } });
    return screen.findByRole('button', { name: 'Buy DOGGO' }, { timeout: 20_000 });
  };
  beforeEach(() => {
    // Jupiter is the route for this token: no pool of ours quotes it.
    h.ownOut.value = null;
    h.quoteVenuePools.mockImplementation(() => ({ state: 'absent', candidates: [] }));
    h.resolveMint.mockImplementation(async (mint: string) => (mint === OTHER ? other : null));
  });

  it('a token Jupiter has not verified asks once, and is not asked again on this device', async () => {
    const buy = await openOn(OTHER);
    const box = await screen.findByRole('checkbox');
    await waitFor(() => expect(receive()).toBe('1'));
    expect(buy).toBeDisabled();
    fireEvent.click(box);
    await waitFor(() => expect(buy).toBeEnabled());
    expect(JSON.parse(localStorage.getItem('sol.acks') ?? '[]')).toEqual([OTHER]);

    // The next visit: no box, and Buy is live once the quote is in.
    cleanup();
    const again = await openOn(OTHER);
    await waitFor(() => expect(again).toBeEnabled());
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('a remembered tick does not stand in for a Shield answer that never came: the box asks, as it always did', async () => {
    localStorage.setItem('sol.acks', JSON.stringify([OTHER]));
    h.getShield.mockImplementation(async () => { throw new Error('Shield 502'); });
    const buy = await openOn(OTHER);
    await waitFor(() => expect(receive()).toBe('1'));
    expect(await screen.findByRole('checkbox')).not.toBeChecked();
    expect(buy).toBeDisabled();
  });

  it('in the same visit a ticked token is not asked again after the pair is flipped', async () => {
    const buy = await openOn(OTHER);
    fireEvent.click(await screen.findByRole('checkbox'));
    await waitFor(() => expect(buy).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Flip pay and receive tokens' }));
    await waitFor(() => expect(screen.getByLabelText('Amount of DOGGO to pay')).toBeInTheDocument());
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('taking the tick back forgets it', async () => {
    const buy = await openOn(OTHER);
    const box = await screen.findByRole('checkbox');
    fireEvent.click(box);
    await waitFor(() => expect(buy).toBeEnabled());
    fireEvent.click(box);
    await waitFor(() => expect(buy).toBeDisabled());
    expect(JSON.parse(localStorage.getItem('sol.acks') ?? '[]')).toEqual([]);
  });

  it('a line Jupiter Shield marks as dangerous asks every time, remembered tick or not', async () => {
    localStorage.setItem('sol.acks', JSON.stringify([OTHER]));
    h.getShield.mockImplementation(async () => ({ [OTHER]: [{ type: 'HAS_TRANSFER_FEE', message: 'This token takes a fee on every transfer', severity: 'warning' }] }));
    const buy = await openOn(OTHER);
    expect(await screen.findByRole('checkbox')).not.toBeChecked();
    expect(screen.getByText('This token takes a fee on every transfer')).toBeInTheDocument();
    await waitFor(() => expect(receive()).toBe('1'));
    expect(buy).toBeDisabled();
  });

  it('the venue’s own BAYLA gets no box and no warning lines, whatever Jupiter Shield says of it', async () => {
    h.getShield.mockImplementation(async () => ({
      [BAYLA_MINT]: [
        { type: 'NOT_VERIFIED', message: 'This token is not verified, make sure the mint address is correct before trading', severity: 'warning' },
        { type: 'LOW_ORGANIC_ACTIVITY', message: 'This token has low organic activity', severity: 'info' },
      ],
    }));
    window.history.replaceState(null, '', `/solana?out=${BAYLA_MINT}`);
    h.ownOut.value = 1_010_000n;
    h.quoteVenuePools.mockImplementation(() => ({ state: 'quoted', candidates: [ownCandidate(1_010_000n)] }));
    await readyToBuy();
    await waitFor(() => expect(h.getShield).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText(/This token is not verified/)).toBeNull();
    expect(screen.queryByText(/low organic activity/)).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('a verified coin’s ordinary notes are not drawn on the form: only a line that is a real warning', async () => {
    const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    h.getShield.mockImplementation(async () => ({
      [USDC_MINT]: [
        { type: 'HAS_FREEZE_AUTHORITY', message: 'The authority’s owner has the ability to freeze your token account', severity: 'warning' },
        { type: 'HAS_MINT_AUTHORITY', message: 'The authority’s owner has the ability to mint more tokens', severity: 'info' },
      ],
    }));
    window.history.replaceState(null, '', '/solana');
    render(<MemoryRouter><SolanaSwapPage /></MemoryRouter>);
    await screen.findByRole('button', { name: 'Enter an amount' });
    await waitFor(() => expect(h.getShield).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText(/freeze your token account/)).toBeNull();
    expect(screen.queryByText(/mint more tokens/)).toBeNull();
  });

  it('for a verified token that is not the venue’s, an ordinary note stays off the form and a real warning is drawn', async () => {
    const JUP = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';
    h.getShield.mockImplementation(async () => ({
      [JUP]: [
        { type: 'HAS_MINT_AUTHORITY', message: 'An ordinary note about this token', severity: 'info' },
        { type: 'HAS_TRANSFER_FEE', message: 'This token takes a fee on every transfer', severity: 'warning' },
      ],
    }));
    window.history.replaceState(null, '', `/solana?out=${JUP}`);
    render(<MemoryRouter><SolanaSwapPage /></MemoryRouter>);
    expect(await screen.findByText('This token takes a fee on every transfer')).toBeInTheDocument();
    expect(screen.queryByText('An ordinary note about this token')).toBeNull();
    // The warning asks for the tick, though the token is verified.
    expect(screen.getByRole('checkbox')).not.toBeChecked();
  });
});

describe('less to read before the button', () => {
  it('slippage and speed are one line until opened, and say what they are set to', async () => {
    await readyToBuy();
    const line = screen.getByText(/^Slippage 0\.5%/);
    expect(line.textContent).toBe('Slippage 0.5% · Speed Fast');
    const fold = line.closest('details')!;
    expect(line.closest('summary')).not.toBeNull();
    expect(fold.open).toBe(false);
    // The controls are inside it, and the line follows them.
    fireEvent.click(screen.getByRole('button', { name: '1%' }));
    expect(line.textContent).toBe('Slippage 1% · Speed Fast');
    fireEvent.click(screen.getByRole('button', { name: 'Turbo' }));
    expect(line.textContent).toBe('Slippage 1% · Speed Turbo');
  });

  it('price impact, minimum received and the route are under one Details line; the fee stays in view', async () => {
    await readyToBuy();
    const fold = screen.getByText('Minimum received').closest('details')!;
    expect(fold.open).toBe(false);
    expect(fold.querySelector('summary span')!.textContent).toBe('Details');
    expect(fold.contains(screen.getByText('Price impact (pool fee included)'))).toBe(true);
    expect(fold.contains(screen.getByText(/via our pool/))).toBe(true);
    expect(fold.contains(screen.getByTestId('own-pool-fee'))).toBe(false);
  });

  it('the footer says the one thing the rows above do not: the fee', async () => {
    await readyToBuy();
    expect(screen.getByTestId('swap-footer').textContent).toBe('No platform fee on a swap in our own pool.');
  });

  it('paying a token for SOL is a sale, and the button says so', async () => {
    window.history.replaceState(null, '', `/solana?in=${BAYLA_MINT}&out=${SOL_MINT}`);
    h.tokenHeld.value = '9000000000';
    render(<MemoryRouter><SolanaSwapPage /></MemoryRouter>);
    fireEvent.change(screen.getByLabelText('Amount of BAYLA to pay'), { target: { value: '5000' } });
    expect(await screen.findByRole('button', { name: 'Sell BAYLA' }, { timeout: 20_000 })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Buy SOL' })).toBeNull();
  });
});

describe('a large price impact is said in view, fold or no fold', () => {
  it('on a Jupiter route: the warning is on the form while Details is closed', async () => {
    h.ownOut.value = null;
    h.quoteVenuePools.mockImplementation(() => ({ state: 'absent', candidates: [] }));
    h.getQuote.mockImplementation(async () => ({ ...jupiterQuote('1000000'), priceImpactPct: '0.35' }));
    render(<MemoryRouter><SolanaSwapPage /></MemoryRouter>);
    fireEvent.change(amountBox(), { target: { value: '0.1' } });
    const warning = await screen.findByTestId('solana-impact-warning', {}, { timeout: 20_000 });
    expect(warning.textContent).toMatch(/This trade moves the price by 35.00%/);
    expect(warning.closest('details')).toBeNull();
    expect(screen.getByText('Minimum received').closest('details')!.open).toBe(false);
  });

  it('a small one says nothing', async () => {
    await readyToBuy();
    expect(screen.queryByTestId('solana-impact-warning')).toBeNull();
  });
});

describe('the token picker tells the venue’s BAYLA from its copies', () => {
  const copy = (n: number) => ({ mint: `Copy${String(n).repeat(39)}`.slice(0, 40) + 'pump', symbol: 'BAYLA', name: 'BAYLA', decimals: 6, verified: false, tokenProgram: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb' });
  const openPicker = async () => {
    window.history.replaceState(null, '', '/solana');
    render(<MemoryRouter><SolanaSwapPage /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: /^USDC/ }));
    return screen.findByRole('dialog', { name: 'Buy' });
  };
  const rows = (dialog: HTMLElement) => [...dialog.querySelectorAll<HTMLElement>('[data-token-row]')];

  it('with nothing typed, the venue’s BAYLA is the first coin offered, and marked', async () => {
    const dialog = await openPicker();
    const first = rows(dialog)[0]!;
    expect(first.getAttribute('data-token-row')).toBe(BAYLA_MINT);
    expect(first.textContent).toContain('This venue’s BAYLA');
    expect(first.textContent).not.toContain('Unverified');
  });

  it('a search full of copies still shows ours first, and every row shows part of its address', async () => {
    h.searchTokens.mockImplementation(async () => [copy(1), copy(2), copy(3)]);
    const dialog = await openPicker();
    fireEvent.change(screen.getByLabelText('Search tokens'), { target: { value: 'BAYLA' } });
    await waitFor(() => expect(rows(dialog)).toHaveLength(4));
    const [first, second] = rows(dialog);
    expect(first!.getAttribute('data-token-row')).toBe(BAYLA_MINT);
    expect(first!.textContent).toContain('This venue’s BAYLA');
    expect(first!.textContent).toContain('7hmVkP…pump');
    // A copy says what it is: not verified, and its own address.
    expect(second!.textContent).toContain('Unverified');
    expect(second!.textContent).toContain('Copy11…pump');
    expect(second!.textContent).not.toContain('This venue’s BAYLA');
  });

  it('with the search down, the venue’s coin is still there to pick', async () => {
    h.searchTokens.mockImplementation(async () => { throw new Error('Token search failed (502)'); });
    const dialog = await openPicker();
    fireEvent.change(screen.getByLabelText('Search tokens'), { target: { value: 'bayla' } });
    await waitFor(() => expect(rows(dialog).map((r) => r.getAttribute('data-token-row'))).toEqual([BAYLA_MINT]));
    expect(dialog.textContent).toMatch(/Search is unavailable just now/);
  });
});
