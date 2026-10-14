// "Add with one coin" on a pool card (owner, 2026-10-13; AddOneCoinPanel.tsx). Pinned here:
//   1. It is offered beside Add liquidity, with one line under it and the how-it-works in a
//      closed drop-down.
//   2. The swap share comes from the route's own fresh quote, not a fixed half, and the
//      review is reached with the wallet asked 0 times.
//   3. A step 2 owed by this wallet on this pool opens as step 2: step 1 is not offered.
//   4. A swap this wallet sent that the chain has not answered for holds step 1, and a lost
//      wallet answer says its own limit: 2 minutes at most (D1).
//
// Our own pool's swap code is a stub here that is not ready, so the route is Jupiter's,
// whose quotes are a fake. Nothing here touches a chain.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { PublicKey } from '@solana/web3.js';
import { LpInner, type LpWritesOverrides } from './SolanaLpSection';
import type { LpReaders } from './readers';
import type { TokenSafety } from '../../../lib/solana/lp/tokenSafety';
import { SOL_QUOTE } from '../../../lib/solana/lp/quotes';
import type { PoolSearchRead, PoolView } from '../../../lib/solana/lp/poolFinder';
import { decodeAmmConfig, decodePoolState } from '../../../lib/solana/cpswap/program';
import type { WalletFacts } from '../../../lib/solana/lp/walletFacts';
import { buildPool, key } from '../../../lib/solana/lp/testkit.fixture';
import type { JupiterQuote } from '../../../lib/jupiter';
import type { PendingTrade } from '../curve/pendingTrade';
import { fakeLpApi, LP_PROGRAM, unusedGateRpc } from './fakeLpWriteApi.fixture';
import { saveStepTwo } from './oneCoinSwap';
import { ONE_COIN_LINE } from './AddOneCoinPanel';

const OWNER = key();
const wallet = vi.hoisted(() => ({
  publicKey: null as null | PublicKey,
  signTransaction: undefined as undefined | ((t: unknown) => Promise<unknown>),
  sendTransaction: undefined as undefined | ((t: unknown) => Promise<unknown>),
  signMessage: undefined,
  connecting: false,
  wallet: null,
}));
const conn = vi.hoisted(() => ({ connection: { rpcEndpoint: 'fake' } }));
vi.mock('@solana/wallet-adapter-react', () => ({ useWallet: () => wallet, useConnection: () => conn }));
vi.mock('../SolanaConnectButton', () => ({ SolanaConnectButton: () => <button type="button">Connect Solana Wallet</button> }));

// Jupiter's quotes, set in beforeEach.
const jup = vi.hoisted(() => ({ getQuote: undefined as unknown as (p: { amount: string; inputMint: string; outputMint: string }) => Promise<JupiterQuote> }));
vi.mock('../../../lib/jupiter', async (orig) => ({ ...(await orig<typeof import('../../../lib/jupiter')>()), getQuote: (p: never) => jup.getQuote(p) }));

// Our own pool's swap: not ready, with the notes the test puts in.
const venue = vi.hoisted(() => ({ notes: [] as PendingTrade[] }));
vi.mock('../../swap/useVenueSwap', () => ({
  useVenueSwap: () => ({
    loading: false,
    unavailable: 'swaps in our own pools are switched off for now',
    ready: null,
    api: null,
    cfg: null,
    rpc: conn.connection,
    signerState: { kind: 'no-wallet' },
    flow: { state: { step: 'idle' }, locked: false, prepare: async () => {}, confirm: async () => {}, recheck: async () => {}, reset: () => {} },
    pending: {
      notes: venue.notes,
      checking: false,
      message: null,
      recheck: () => {},
      dismiss: () => {},
      record: () => {},
      sent: () => {},
      hold: () => {},
      release: () => {},
      holdsNow: () => venue.notes.length > 0,
    },
  }),
}));

const MINT = key();
const M = MINT.toBase58();
const SOL = 10n ** 9n;
const UNIT = 10n ** 6n;

/** 10 SOL and 1,000 tokens: 0.01 SOL a token. */
function view(): PoolView {
  const b = buildPool({ plain: true, mint: MINT, quote: SOL_QUOTE, configIndex: 1, quoteReserve: 10n * SOL, tokenReserve: 1_000n * UNIT, openTime: 1n });
  const pool = decodePoolState(b.address.toBase58(), b.accounts[b.address.toBase58()]!.data)!;
  const config = decodeAmmConfig(b.config.toBase58(), b.accounts[b.config.toBase58()]!.data);
  const quoteIsToken0 = pool.token0Mint === SOL_QUOTE.mint;
  const [q, t] = [10n * SOL, 1_000n * UNIT];
  return {
    address: b.address.toBase58(),
    origin: 'other',
    snapshot: { pool, vault0Amount: quoteIsToken0 ? q : t, vault1Amount: quoteIsToken0 ? t : q, reserve0: quoteIsToken0 ? q : t, reserve1: quoteIsToken0 ? t : q },
    config,
    tokenMint: M,
    quote: SOL_QUOTE,
    quoteIsToken0,
    quoteReserve: q,
    tokenReserve: t,
    vaultsFrozen: false,
    history: { kind: 'not-read' },
  };
}

const okToken: TokenSafety = {
  kind: 'read', mint: M, verdict: 'ok', blocks: [], warnings: [], name: 'Corn', symbol: 'CORN', metadataSource: 'metaplex',
  facts: { program: 'spl-token', mintAuthority: null, freezeAuthority: null, supply: 1n, decimals: 6, isInitialized: true, extensions: [], metadataPointer: null, tokenMetadata: null },
};

function search(v: PoolView): PoolSearchRead {
  return {
    kind: 'ok',
    search: {
      mint: M,
      known: { launchPool: key().toBase58(), standard: [{ index: 1, config: key().toBase58(), address: key().toBase58(), quote: SOL_QUOTE.mint }] },
      index: { kind: 'ok', pools: [v.address], truncated: false },
      pools: [{ kind: 'pool' as const, view: v }],
      otherPairs: 0,
      knownState: {},
      chainNow: 1_000n,
    },
  };
}

const facts: WalletFacts = {
  kind: 'ok',
  lamports: 5n * SOL,
  token: { address: key().toBase58(), amount: 500n * UNIT },
  wsol: { exists: false, amount: 0n },
  coin: null,
  lpAccountExists: false,
  rents: { walletFloor: 890_880n, tokenAccount165: 2_039_280n },
};

function readers(v: PoolView): LpReaders {
  return {
    programId: LP_PROGRAM,
    safety: vi.fn(async () => new Map([[M, okToken]])),
    findPools: vi.fn(async () => search(v)),
    outsidePrice: vi.fn(async (mint: string) => ({ kind: 'ok' as const, solPerToken: mint === M ? 0.01 : 1, source: 'Jupiter' as const })),
    positions: vi.fn(async () => ({ kind: 'ok' as const, positions: [], chainNow: 1n, totalShares: 0 })),
    feeTiers: vi.fn(async () => ({ kind: 'ok' as const, openingDeposits: null, tiers: [] })),
    wallet: vi.fn(async () => facts),
    placeShareOnChain: vi.fn(async () => ({ kind: 'not-found' as const })),
  };
}

/** The pool's card, its "Add with one coin" pressed. */
async function openOneCoin(v: PoolView = view()) {
  const writes: LpWritesOverrides = { mode: 'on', load: vi.fn(async () => fakeLpApi()), gateRpc: unusedGateRpc };
  render(
    <MemoryRouter initialEntries={[`/pools?mint=${M}`]}>
      <LpInner readers={readers(v)} writes={writes} />
    </MemoryRouter>,
  );
  const card = await screen.findByTestId('lp-pool');
  expect(within(card).getByRole('button', { name: 'Add liquidity' })).toBeInTheDocument();
  fireEvent.click(await within(card).findByRole('button', { name: 'Add with one coin' }));
  return v;
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  venue.notes.length = 0;
  wallet.publicKey = OWNER;
  wallet.signTransaction = vi.fn(async (t) => t);
  wallet.sendTransaction = vi.fn(async () => '5'.repeat(88));
  // Jupiter: 49 tokens for every 0.5 SOL, a little under this pool's 50.
  jup.getQuote = vi.fn(async (p) => {
    const out = (BigInt(p.amount) * 49n * UNIT) / (SOL / 2n);
    return {
      inputMint: p.inputMint, outputMint: p.outputMint, inAmount: p.amount, outAmount: out.toString(), otherAmountThreshold: ((out * 99n) / 100n).toString(),
      swapMode: 'ExactIn', slippageBps: 100, priceImpactPct: '0', routePlan: [{ swapInfo: { label: 'Pump.fun Amm' } }], platformFee: null,
    };
  });
});

describe('Add with one coin', () => {
  it('is offered beside Add liquidity: one line under the button, the how-it-works in a closed drop-down', async () => {
    await openOneCoin();
    const panel = await screen.findByTestId('lp-one-coin-panel');
    expect(within(panel).getByTestId('lp-one-line')).toHaveTextContent(ONE_COIN_LINE);
    const how = within(panel).getByText('How it works').closest('details')!;
    expect(how).not.toHaveAttribute('open');
    expect(within(panel).getByRole('button', { name: 'Review: add with one coin' })).toBeDisabled();
  });

  it('swaps the share the route’s own quote gives, not half, and reaches the review with the wallet asked 0 times', async () => {
    await openOneCoin();
    const panel = await screen.findByTestId('lp-one-coin-panel');
    await within(panel).findByText(/after both steps/);
    fireEvent.change(within(panel).getByLabelText('SOL to put in'), { target: { value: '1' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Review: add with one coin' }));
    const review = await within(panel).findByTestId('lp-one-review');
    // Jupiter pays 49 tokens for 0.5 SOL against this pool's 50, so a little more than half is
    // swapped: 1 SOL × 1,000 × 0.5 / (1,000 × 0.5 + 49 × 10) = 0.505050505 SOL.
    expect(jup.getQuote).toHaveBeenNthCalledWith(1, expect.objectContaining({ amount: '500000000' }));
    expect(jup.getQuote).toHaveBeenNthCalledWith(2, expect.objectContaining({ amount: '505050505' }));
    expect(review).toHaveTextContent('Step 1: swap, through Jupiter');
    expect(review).toHaveTextContent('You pay0.505050505 SOL');
    // This pool's figure for the same swap is said even though its swap is not ready here.
    expect(review).toHaveTextContent(/This pool would pay[\d.,]+ CORN/);
    expect(within(review).getByTestId('lp-one-step2-plan')).toHaveTextContent('Left in your wallet, about');
    expect(within(review).getByRole('button', { name: 'Sign in wallet' })).toBeEnabled();
    expect(wallet.sendTransaction).not.toHaveBeenCalled();
    expect(wallet.signTransaction).not.toHaveBeenCalled();
  });

  it('a step 2 this wallet owes on this pool opens as step 2: step 1 is not offered', async () => {
    const v = view();
    saveStepTwo(OWNER.toBase58(), { pool: v.address, paid: 'quote', kept: SOL / 2n, got: 49n * UNIT, gotExact: true, bps: 100n, signature: '4'.repeat(88), at: Date.now() });
    await openOneCoin(v);
    const step2 = await screen.findByTestId('lp-one-step2');
    expect(step2).toHaveTextContent('Step 1 is done');
    expect(screen.getByTestId('lp-add-panel')).toHaveTextContent('Step 2: add both coins');
    expect(screen.queryByRole('button', { name: 'Review: add with one coin' })).toBeNull();
  });

  it('a swap this wallet sent and the chain has not answered for holds step 1; a lost answer says 2 minutes at most', async () => {
    venue.notes.push({ kind: 'jupiter-swap', signature: null, lastValidBlockHeight: null, sentAt: Date.now(), pool: null, blockhash: null });
    await openOneCoin();
    const held = await screen.findByTestId('lp-one-held');
    expect(held).toHaveTextContent('2 minutes at most');
    expect(held).not.toHaveTextContent('10 minutes');
    expect(held).toHaveTextContent('Turn step 1 back on now');
    const panel = screen.getByTestId('lp-one-coin-panel');
    fireEvent.change(within(panel).getByLabelText('SOL to put in'), { target: { value: '1' } });
    expect(within(panel).getByRole('button', { name: 'Review: add with one coin' })).toBeDisabled();
  });
});
