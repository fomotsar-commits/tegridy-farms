// THE LP DOOR (island, answer twenty; the owner, 2026-10-15: "providing liquidity for a
// bungalow coin is tucked away"). Pinned here, on the LP section:
//   1. /pools?mint=<token>&task=add&pool=<address> ends, by itself, in Add with one coin
//      on that pool, drawn in the door at the top (island, answer twenty-two: before the finder
//      and the list, with the pool's figures as rows, and nothing scrolls), and the request
//      leaves the address so a reload does not reopen it.
//   2. Without a pool, it ends in the token's SOL pool, never a deeper pool paired with another coin.
//   3. A row in the list of every pool has Add: one press to that pool's Add form.
//   4. The screen the door opens: one sentence on what the share is, a percent row, a share bar
//      that fills as the amount moves, the risk line under the button, and "I have both coins"
//      one press from the pair form.
//   5. THE LANDING: a share that is new on a later read rises into place once; nothing moves on
//      the first read.
//
// The write layer is a fake (fakeLpWriteApi.fixture.ts); pools, wallet and Jupiter are fakes.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import type { PublicKey } from '@solana/web3.js';
import { LpInner, type LpWritesOverrides } from './SolanaLpSection';
import type { LpReaders } from './readers';
import type { TokenSafety } from '../../../lib/solana/lp/tokenSafety';
import { SOL_QUOTE, USDC_QUOTE, type QuoteCoin } from '../../../lib/solana/lp/quotes';
import type { PoolListRead } from '../../../lib/solana/lp/poolList';
import type { PoolSearchRead, PoolView } from '../../../lib/solana/lp/poolFinder';
import { decodeAmmConfig, decodePoolState } from '../../../lib/solana/cpswap/program';
import type { WalletFacts } from '../../../lib/solana/lp/walletFacts';
import type { Position } from '../../../lib/solana/lp/positions';
import { buildPool, key } from '../../../lib/solana/lp/testkit.fixture';
import type { JupiterQuote } from '../../../lib/jupiter';
import { fakeLpApi, LP_PROGRAM, unusedGateRpc } from './fakeLpWriteApi.fixture';
import { RISK_SHORT } from './LpDisclosures';

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
const jup = vi.hoisted(() => ({ getQuote: undefined as unknown as (p: { amount: string; inputMint: string; outputMint: string }) => Promise<JupiterQuote> }));
vi.mock('../../../lib/jupiter', async (orig) => ({ ...(await orig<typeof import('../../../lib/jupiter')>()), getQuote: (p: never) => jup.getQuote(p) }));
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
    pending: { notes: [], checking: false, message: null, recheck: () => {}, dismiss: () => {}, record: () => {}, sent: () => {}, hold: () => {}, release: () => {}, holdsNow: () => false },
  }),
}));

const MINT = key();
const M = MINT.toBase58();
const SOL = 10n ** 9n;
const UNIT = 10n ** 6n;

/** A pool for MINT: 10 SOL (or 10 of `quote`) and 1,000 tokens, unless told otherwise. */
function view(o: { quote?: QuoteCoin; q?: bigint; t?: bigint } = {}): PoolView {
  const quote = o.quote ?? SOL_QUOTE;
  const q = o.q ?? 10n * 10n ** BigInt(quote.decimals);
  const t = o.t ?? 1_000n * UNIT;
  const b = buildPool({ plain: true, mint: MINT, quote, configIndex: 1, quoteReserve: q, tokenReserve: t, openTime: 1n });
  const pool = decodePoolState(b.address.toBase58(), b.accounts[b.address.toBase58()]!.data)!;
  const config = decodeAmmConfig(b.config.toBase58(), b.accounts[b.config.toBase58()]!.data);
  const quoteIsToken0 = pool.token0Mint === quote.mint;
  return {
    address: b.address.toBase58(),
    origin: 'other',
    snapshot: { pool, vault0Amount: quoteIsToken0 ? q : t, vault1Amount: quoteIsToken0 ? t : q, reserve0: quoteIsToken0 ? q : t, reserve1: quoteIsToken0 ? t : q },
    config,
    tokenMint: M,
    quote,
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

function search(views: PoolView[]): PoolSearchRead {
  return {
    kind: 'ok',
    search: {
      mint: M,
      known: { launchPool: key().toBase58(), standard: [{ index: 1, config: key().toBase58(), address: key().toBase58(), quote: SOL_QUOTE.mint }] },
      index: { kind: 'ok', pools: views.map((v) => v.address), truncated: false },
      pools: views.map((v) => ({ kind: 'pool' as const, view: v })),
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

function readers(views: PoolView[], list?: PoolListRead): LpReaders {
  return {
    programId: LP_PROGRAM,
    safety: vi.fn(async () => new Map([[M, okToken]])),
    findPools: vi.fn(async () => search(views)),
    ...(list ? { listPools: vi.fn(async () => list) } : {}),
    outsidePrice: vi.fn(async (mint: string) => ({ kind: 'ok' as const, solPerToken: mint === M ? 0.01 : 1, source: 'Jupiter' as const })),
    positions: vi.fn(async () => ({ kind: 'ok' as const, positions: [], chainNow: 1n, totalShares: 0 })),
    feeTiers: vi.fn(async () => ({ kind: 'ok' as const, openingDeposits: null, tiers: [] })),
    wallet: vi.fn(async () => facts),
    placeShareOnChain: vi.fn(async () => ({ kind: 'not-found' as const })),
  };
}

let where = '';
function Where() {
  const loc = useLocation();
  where = loc.search;
  return null;
}

function mount(r: LpReaders, path: string) {
  const writes: LpWritesOverrides = { mode: 'on', load: vi.fn(async () => fakeLpApi()), gateRpc: unusedGateRpc };
  render(
    <MemoryRouter initialEntries={[path]}>
      <Where />
      <LpInner readers={r} writes={writes} />
    </MemoryRouter>,
  );
}

const cardOf = (pool: string) => screen.getAllByTestId('lp-pool').find((c) => c.getAttribute('data-pool') === pool)!;

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  where = '';
  wallet.publicKey = OWNER;
  wallet.signTransaction = vi.fn(async (t) => t);
  wallet.sendTransaction = vi.fn(async () => '5'.repeat(88));
  Element.prototype.scrollIntoView = vi.fn();
  jup.getQuote = vi.fn(async (p) => ({
    inputMint: p.inputMint, outputMint: p.outputMint, inAmount: p.amount, outAmount: '1', otherAmountThreshold: '1',
    swapMode: 'ExactIn', slippageBps: 100, priceImpactPct: '0', routePlan: [{ swapInfo: { label: 'Pump.fun Amm' } }], platformFee: null,
  }));
});

// THE HOME CARD (owner, 2026-10-16: "stake with the module and provide lp with the module so
// people can right away do these things"). The same section on '/', on one pool, short: its
// Add buttons ready, no form opened by itself (an open form takes focus and the screen, and
// the home's first screen is the heat reader's), and the home's address is not the Pools tab's.
describe('the home card', () => {
  function mountHome(r: LpReaders, path: string, pool: string) {
    const writes: LpWritesOverrides = { mode: 'on', load: vi.fn(async () => fakeLpApi()), gateRpc: unusedGateRpc };
    render(
      <MemoryRouter initialEntries={[path]}>
        <Where />
        <LpInner readers={r} writes={writes} home={{ mint: M, pool }} />
      </MemoryRouter>,
    );
  }

  it('shows its pool alone, short, with both Add buttons, and opens nothing or moves nothing by itself', async () => {
    const sol = view();
    const usdc = view({ quote: USDC_QUOTE, q: 100_000n * 10n ** 6n });
    const r = readers([usdc, sol]);
    mountHome(r, '/', sol.address);
    const card = await waitFor(() => cardOf(sol.address));
    await within(card).findByRole('button', { name: 'Add with one coin' });
    expect(screen.getAllByTestId('lp-pool')).toHaveLength(1);
    // A screen reader hears of the one pool shown, not "2 pools found".
    expect(screen.getByTestId('lp-status')).toHaveTextContent(/^The pool was read\.$/);
    expect(within(card).getByRole('button', { name: 'Add liquidity' })).toBeInTheDocument();
    // Its pool is read with the lookup, whatever the index lists.
    expect(r.findPools).toHaveBeenCalledWith(expect.anything(), [sol.address]);
    // How LPs earn, what the venue takes and the pool's price, in view; the rest a press away.
    expect(within(card).getByTestId('lp-pool-split')).toHaveTextContent(/^LPs keep [\d.]+% of each trade, the venue [\d.]+%\.$/);
    expect(within(card).getByTestId('lp-pool-more')).not.toHaveAttribute('open');
    expect(within(card).getByText('Price here', { exact: true })).toBeVisible();
    expect(within(within(card).getByTestId('lp-pool-more')).queryByText('Price', { exact: true })).toBeNull();
    // Nothing to search with, nothing else to open, no clean token card.
    expect(screen.queryByTestId('lp-tasks')).toBeNull();
    expect(screen.queryByRole('textbox', { name: /Token mint address/ })).toBeNull();
    expect(screen.queryByTestId('lp-create')).toBeNull();
    expect(screen.queryByTestId('token-safety')).toBeNull();
    // Swaps and withdrawals both open: one line, and no reassurance line under the buttons.
    expect(within(card).getByTestId('lp-pool-open')).toHaveTextContent('Swaps and withdrawals open');
    expect(within(card).queryByText('Checks run again on fresh reads when you press Review.')).toBeNull();
    await new Promise((res) => setTimeout(res, 50));
    expect(screen.queryByTestId('lp-one-coin-panel')).toBeNull();
    expect(screen.queryByTestId('lp-add-panel')).toBeNull();
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
    expect(where).toBe('');
  });

  it('one press on Add with one coin opens its form on that pool', async () => {
    const sol = view();
    mountHome(readers([sol]), '/', sol.address);
    const card = await waitFor(() => cardOf(sol.address));
    fireEvent.click(await within(card).findByRole('button', { name: 'Add with one coin' }));
    expect(card).toContainElement(await screen.findByTestId('lp-one-coin-panel'));
  });

  it('reads no token or task from the address', async () => {
    const sol = view();
    const r = readers([sol]);
    const other = key().toBase58();
    mountHome(r, `/?mint=${other}&task=add`, sol.address);
    await waitFor(() => cardOf(sol.address));
    const looked = vi.mocked(r.findPools).mock.calls.map((c) => c[0].toBase58());
    expect(looked.length).toBeGreaterThan(0);
    expect(looked.every((m) => m === M)).toBe(true);
    expect(screen.queryByTestId('lp-one-coin-panel')).toBeNull();
    expect(where).toBe(`?mint=${other}&task=add`);
  });

  it('keeps the actions and leaves every pool, the rates and the routes to the tabs', async () => {
    const sol = view();
    mountHome(readers([sol], { kind: 'ok', list: { pools: [sol], unread: 0, truncated: false, chainNow: null, safety: new Map() } }), '/', sol.address);
    await waitFor(() => cardOf(sol.address));
    // No risk line on the page (owner, 2026-10-17): its sentence leads the closed Risks drop-down.
    expect(screen.queryByTestId('lp-risk-line')).toBeNull();
    // The full notice is one closed drop-down, with no card or Pool program row around it.
    const notice = screen.getByTestId('lp-disclosure');
    expect(within(notice).getByText(RISK_SHORT).closest('details')).not.toHaveAttribute('open');
    expect(within(notice).getByText('Risks')).toBeInTheDocument();
    expect(within(notice).queryByText('Pool program')).toBeNull();
    expect(within(notice).queryByRole('heading')).toBeNull();
    // No Your positions card: each Add form carries its own Connect.
    expect(screen.queryByRole('heading', { name: 'Your positions' })).toBeNull();
    expect(screen.queryByTestId('lp-all-pools')).toBeNull();
    expect(screen.queryByTestId('fee-tiers')).toBeNull();
    expect(screen.queryByTestId('lp-routes')).toBeNull();
  });

  it('a token check that found anything still shows its card', async () => {
    const sol = view();
    const r = readers([sol]);
    r.safety = vi.fn(async () => new Map([[M, { ...okToken, verdict: 'warn' as const }]]));
    mountHome(r, '/', sol.address);
    await waitFor(() => cardOf(sol.address));
    expect(screen.getByTestId('token-safety')).toHaveAttribute('data-verdict', 'warn');
  });

  it('a token that could not be read is one line, and nothing is called checked', async () => {
    const sol = view();
    const r = readers([sol]);
    r.safety = vi.fn(async () => new Map([[M, { kind: 'unread' as const, mint: M, detail: 'HTTP 429' }]]));
    mountHome(r, '/', sol.address);
    const line = await screen.findByTestId('token-safety');
    expect(line).toHaveAttribute('data-verdict', 'unread');
    expect(line).toHaveTextContent('This token could not be read just now, so nothing on this card counts as checked.');
    expect(screen.queryByText('Copy the mint address')).toBeNull();
  });

  // Owner, 2026-10-16: "the add lp doesnt even show how to add". A failed read never strands the card.
  it('a pool read that failed tries again by itself, and offers Read again and the Venue AMM tab meanwhile', async () => {
    const sol = view();
    const r = readers([sol]);
    const ok = search([sol]);
    let calls = 0;
    r.findPools = vi.fn(async () => (++calls === 1 ? { kind: 'unread' as const, detail: 'HTTP 429', index: { kind: 'unread' as const, detail: 'HTTP 429' } } : ok)) as LpReaders['findPools'];
    mountHome(r, '/', sol.address);
    const stuck = await screen.findByTestId('lp-only-unread');
    expect(within(stuck).getByRole('button', { name: 'Read again' })).toBeInTheDocument();
    expect(within(stuck).getByRole('link', { name: 'Add on the Venue AMM tab' })).toHaveAttribute('href', `/pools?mint=${M}&task=add&pool=${sol.address}`);
    // No press: the card reads again on its own and its Add buttons arrive.
    const card = await screen.findByTestId('lp-pool', {}, { timeout: 6_000 });
    expect(await within(card).findByRole('button', { name: 'Add with one coin' })).toBeInTheDocument();
    expect(screen.queryByTestId('lp-only-unread')).toBeNull();
  }, 15_000);

  it('a token and a pool that both did not read offer the way on once', async () => {
    const sol = view();
    const r = readers([sol]);
    r.safety = vi.fn(async () => new Map([[M, { kind: 'unread' as const, mint: M, detail: 'HTTP 429' }]]));
    r.findPools = vi.fn(async () => ({ kind: 'unread' as const, detail: 'HTTP 429', index: { kind: 'unread' as const, detail: 'HTTP 429' } })) as LpReaders['findPools'];
    mountHome(r, '/', sol.address);
    await screen.findByTestId('lp-only-unread');
    expect(screen.getAllByTestId('lp-only-way-on')).toHaveLength(1);
  });

  it('an outside price that could not be read tries again by itself, and offers the way on meanwhile', async () => {
    const sol = view();
    const r = readers([sol]);
    let calls = 0;
    r.outsidePrice = vi.fn(async (mint: string) =>
      mint === M && ++calls === 1
        ? { kind: 'unread' as const, detail: 'Jupiter did not give a price (HTTP 429)' }
        : { kind: 'ok' as const, solPerToken: mint === M ? 0.01 : 1, source: 'Jupiter' as const }) as LpReaders['outsidePrice'];
    mountHome(r, '/', sol.address);
    const row = await screen.findByTestId('lp-only-way-on');
    expect(within(row).getByRole('link', { name: 'Add on the Venue AMM tab' })).toBeInTheDocument();
    const card = await waitFor(() => cardOf(sol.address));
    expect(await within(card).findByRole('button', { name: 'Add with one coin' }, { timeout: 6_000 })).toBeInTheDocument();
    expect(screen.queryByTestId('lp-only-way-on')).toBeNull();
  }, 15_000);

  it('Read again reads again at once', async () => {
    const sol = view();
    const r = readers([sol]);
    r.findPools = vi.fn(async () => ({ kind: 'unread' as const, detail: 'HTTP 429', index: { kind: 'unread' as const, detail: 'HTTP 429' } })) as LpReaders['findPools'];
    mountHome(r, '/', sol.address);
    fireEvent.click(within(await screen.findByTestId('lp-only-unread')).getByRole('button', { name: 'Read again' }));
    await waitFor(() => expect(vi.mocked(r.findPools).mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  it('a pool that did not read says so, and shows no other pool in its place', async () => {
    const usdc = view({ quote: USDC_QUOTE });
    mountHome(readers([usdc]), '/', key().toBase58());
    expect(await screen.findByTestId('lp-only-unread')).toHaveTextContent('The pool could not be read just now.');
    expect(screen.getByTestId('lp-status')).toHaveTextContent(/^The pool could not be read\.$/);
    expect(screen.queryByTestId('lp-pool')).toBeNull();
  });
});

/** The pool card's own Add with one coin button: pressed (expanded) while its form is open, wherever it is drawn. */
const oneCoinButtonOf = (pool: string) => within(cardOf(pool)).getByRole('button', { name: 'Add with one coin' });
const follows = (a: Element, b: Element) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

describe('the door’s link', () => {
  it('?task=add&pool= opens Add with one coin on that pool by itself, then leaves the address', async () => {
    const sol = view();
    mount(readers([sol]), `/pools?mint=${M}&task=add&pool=${sol.address}`);
    const panel = await screen.findByTestId('lp-one-coin-panel');
    expect(oneCoinButtonOf(sol.address)).toHaveAttribute('aria-expanded', 'true');
    expect(screen.queryByTestId('lp-add-panel')).toBeNull();
    await waitFor(() => expect(where).toBe(`?mint=${M}`));
    expect(screen.getByTestId('lp-door')).toContainElement(panel);
  });

  it('with no pool named, ends in the SOL pool, never a deeper pool paired with another coin', async () => {
    const usdc = view({ quote: USDC_QUOTE, q: 100_000n * 10n ** 6n });
    const sol = view();
    // The lookup lists the deeper USDC pool first, as an un-named Add wish would take it.
    mount(readers([usdc, sol]), `/pools?mint=${M}&task=add`);
    const panel = await screen.findByTestId('lp-one-coin-panel');
    expect(oneCoinButtonOf(sol.address)).toHaveAttribute('aria-expanded', 'true');
    expect(oneCoinButtonOf(usdc.address)).toHaveAttribute('aria-expanded', 'false');
    expect(within(panel).getByTestId('lp-one-what')).toHaveTextContent('CORN/SOL pool');
  });

  // Island, answer twenty-two ("where the door lands"): the page used to show the finder first,
  // then jump about 1,650px down to the form inside the pool's card, and move again as cards
  // above it loaded. The form is the first thing now, the rest of the section under it.
  it('draws the form at the top, before the finder and every pool card, and moves nothing', async () => {
    const sol = view();
    mount(readers([sol]), `/pools?mint=${M}&task=add&pool=${sol.address}`);
    const panel = await screen.findByTestId('lp-one-coin-panel');
    const door = screen.getByTestId('lp-door');
    expect(door).toContainElement(panel);
    expect(cardOf(sol.address)).not.toContainElement(panel);
    expect(follows(door, screen.getByTestId('lp-tasks'))).toBe(true);
    expect(follows(door, cardOf(sol.address))).toBe(true);
    await within(panel).findByText(/after both steps/);
    await new Promise((res) => setTimeout(res, 50));
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
  });

  it('says it is reading the pool before the form arrives, in the place the form takes', async () => {
    const sol = view();
    const r = readers([sol]);
    let answer!: () => void;
    r.findPools = vi.fn(() => new Promise<PoolSearchRead>((res) => { answer = () => res(search([sol])); }));
    mount(r, `/pools?mint=${M}&task=add&pool=${sol.address}`);
    const door = await screen.findByTestId('lp-door');
    expect(within(door).getByRole('status')).toHaveTextContent('Reading this pool from the chain…');
    expect(follows(door, screen.getByTestId('lp-tasks'))).toBe(true);
    answer();
    const panel = await screen.findByTestId('lp-one-coin-panel');
    expect(screen.getByTestId('lp-door')).toContainElement(panel);
    expect(within(screen.getByTestId('lp-door')).queryByText('Reading this pool from the chain…')).toBeNull();
  });

  it('reads the pool’s figures inside the form as rows: its price, the outside price, the gap, and how a trade’s fee splits', async () => {
    const sol = view();
    mount(readers([sol]), `/pools?mint=${M}&task=add&pool=${sol.address}`);
    const panel = await screen.findByTestId('lp-one-coin-panel');
    const facts = await within(panel).findByTestId('lp-door-facts');
    expect(within(facts).getByText('Price here', { exact: true })).toBeInTheDocument();
    expect(within(facts).getByText('Outside price (Jupiter)', { exact: true })).toBeInTheDocument();
    expect(within(facts).getByText('Difference', { exact: true })).toBeInTheDocument();
    expect(within(facts).getByText(/^LPs keep [\d.]+% of each trade, the venue [\d.]+%\.$/)).toBeInTheDocument();
    // The share the amount buys stays where it was, under the amount.
    fireEvent.change(within(panel).getByLabelText('SOL to put in'), { target: { value: '1' } });
    expect(within(panel).getByTestId('lp-one-share')).toHaveTextContent('About 4.76% of the pool, at its price now.');
  });

  it('a form opened from a pool’s own card stays on the card, without the figures it already shows', async () => {
    const sol = view();
    mount(readers([sol]), `/pools?mint=${M}`);
    fireEvent.click(await within(await waitFor(() => cardOf(sol.address))).findByRole('button', { name: 'Add with one coin' }));
    const panel = await screen.findByTestId('lp-one-coin-panel');
    expect(cardOf(sol.address)).toContainElement(panel);
    expect(screen.queryByTestId('lp-door')).toBeNull();
    expect(within(panel).queryByTestId('lp-door-facts')).toBeNull();
  });

  it('Close takes the door away', async () => {
    const sol = view();
    mount(readers([sol]), `/pools?mint=${M}&task=add&pool=${sol.address}`);
    const panel = await screen.findByTestId('lp-one-coin-panel');
    await waitFor(() => expect(where).toBe(`?mint=${M}`));
    fireEvent.click(within(panel).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByTestId('lp-one-coin-panel')).toBeNull());
    expect(screen.queryByTestId('lp-door')).toBeNull();
  });

  it('a link with no task opens no form', async () => {
    const sol = view();
    mount(readers([sol]), `/pools?mint=${M}`);
    await screen.findByTestId('lp-pool');
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId('lp-one-coin-panel')).toBeNull();
    expect(screen.queryByTestId('lp-add-panel')).toBeNull();
  });
});

describe('the list of every pool', () => {
  it('each row has Add: one press to that pool’s Add with one coin', async () => {
    const sol = view();
    mount(readers([sol], { kind: 'ok', list: { pools: [sol], unread: 0, truncated: false, chainNow: null, safety: new Map() } }), '/pools');
    const [row] = await screen.findAllByTestId('lp-all-pools-row');
    fireEvent.click(within(row!).getByRole('button', { name: /^Add to / }));
    const panel = await screen.findByTestId('lp-one-coin-panel');
    expect(cardOf(sol.address)).toContainElement(panel);
  });
});

describe('the screen the door opens', () => {
  async function door() {
    const sol = view();
    mount(readers([sol]), `/pools?mint=${M}&task=add&pool=${sol.address}`);
    const panel = await screen.findByTestId('lp-one-coin-panel');
    await within(panel).findByText(/after both steps/);
    return panel;
  }

  it('says what the share is in one sentence, and the vault risk is one closed Risks under the button', async () => {
    const panel = await door();
    expect(within(panel).getByTestId('lp-one-what')).toHaveTextContent("A share of the CORN/SOL pool and its fee on every trade. No lock, but the team's vault can pause removing.");
    const review = within(panel).getByRole('button', { name: 'Review: add with one coin' });
    // Off the page (owner, 2026-10-17: "remove this warning from everywhere"), one press away.
    const risk = within(panel).getByTestId('lp-one-risk');
    expect(risk.tagName).toBe('DETAILS');
    expect(risk).not.toHaveAttribute('open');
    expect(risk).toHaveTextContent(RISK_SHORT);
    expect(review.compareDocumentPosition(risk) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The two signatures are named before the first press.
    expect(within(panel).getByTestId('lp-one-line')).toHaveTextContent('Two signatures: the swap, then the add.');
  });

  // The team's vault can switch removing off on any of our pools (update_pool_status, admin only),
  // so the panel may not promise a removal "any time", as the pools page may not (PoolsPage.test.tsx).
  it('never promises withdrawing any time, and says the vault can pause removing', async () => {
    const panel = await door();
    expect(panel.textContent).not.toMatch(/\bany ?time\b/i);
    expect(within(panel).getByTestId('lp-one-what')).toHaveTextContent(/vault can pause removing/);
  });

  it('a percent fills the amount from the wallet: 50% is half of Max', async () => {
    const panel = await door();
    const box = within(panel).getByLabelText('SOL to put in') as HTMLInputElement;
    fireEvent.click(within(panel).getByRole('button', { name: '50%' }));
    const half = Number(box.value);
    fireEvent.click(within(panel).getByRole('button', { name: 'Max SOL' }));
    const max = Number(box.value);
    expect(half).toBeGreaterThan(0);
    expect(Math.abs(half * 2 - max)).toBeLessThan(1e-8);
  });

  it('the share bar fills as the amount moves: 1 SOL into 10 SOL and 1,000 tokens is about 4.76%', async () => {
    const panel = await door();
    expect(within(panel).queryByTestId('lp-one-share')).toBeNull();
    fireEvent.change(within(panel).getByLabelText('SOL to put in'), { target: { value: '1' } });
    expect(within(panel).getByTestId('lp-one-share')).toHaveTextContent('About 4.76% of the pool, at its price now.');
    fireEvent.change(within(panel).getByLabelText('SOL to put in'), { target: { value: '10' } });
    expect(within(panel).getByTestId('lp-one-share')).toHaveTextContent('About 33.33% of the pool');
  });

  // One screen on a phone (island, answer twenty-two): the room's name, one amount, one sentence,
  // one green button. The two-step line and the price tolerance follow the button in the door.
  it('puts the green button right after the amount and the pool’s figures, the line and the price tolerance after it', async () => {
    const panel = await door();
    const review = within(panel).getByRole('button', { name: 'Review: add with one coin' });
    expect(follows(within(panel).getByLabelText('SOL to put in'), review)).toBe(true);
    expect(follows(within(panel).getByTestId('lp-door-facts'), review)).toBe(true);
    expect(follows(review, within(panel).getByTestId('lp-one-line'))).toBe(true);
    expect(follows(review, within(panel).getByText('Price tolerance (slippage)'))).toBe(true);
  });

  it('“I have both coins” opens the pair form in one press', async () => {
    const panel = await door();
    fireEvent.click(within(panel).getByRole('button', { name: 'I have both coins' }));
    const pair = await screen.findByTestId('lp-add-panel');
    expect(screen.queryByTestId('lp-one-coin-panel')).toBeNull();
    // In the door's place, where the visitor already is: nothing scrolls to it.
    expect(screen.getByTestId('lp-door')).toContainElement(pair);
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
  });
});

describe('the landing', () => {
  function position(v: PoolView): Position {
    return {
      lpMint: v.snapshot.pool.lpMint,
      lpAccount: key().toBase58(),
      lpAmount: 250_000n,
      placement: 'found',
      placementDetail: null,
      pool: { kind: 'pool', view: v },
      value: { token0: 1n, token1: 2n, sharePct: 25 },
      tooSmall: false,
    };
  }

  it('a share that arrives on a later read rises into place; one there on the first read does not', async () => {
    const sol = view();
    const mine = position(sol);
    const r = readers([sol]);
    r.positions = vi
      .fn()
      .mockResolvedValueOnce({ kind: 'ok' as const, positions: [], chainNow: 1n, totalShares: 0 })
      .mockResolvedValue({ kind: 'ok' as const, positions: [mine], chainNow: 2n, totalShares: 1 });
    mount(r, '/pools');
    fireEvent.click(await screen.findByRole('button', { name: 'Read my positions again' }));
    const card = await screen.findByTestId('lp-position');
    expect(card).toHaveAttribute('data-landed', 'true');
  });

  it('nothing lands on the first read', async () => {
    const sol = view();
    const r = readers([sol]);
    r.positions = vi.fn(async () => ({ kind: 'ok' as const, positions: [position(sol)], chainNow: 1n, totalShares: 1 }));
    mount(r, '/pools');
    const card = await screen.findByTestId('lp-position');
    expect(card).not.toHaveAttribute('data-landed');
  });
});

// A door visitor may hold nothing (owner, 2026-10-17, walking the BAYLA room): when the door's
// pool cannot open its form, the card says "this pool", never "your position's pool".
describe('the door names no position', () => {
  it('a door whose pool cannot open its form says why without calling it your position', async () => {
    const sol = view();
    const r = readers([sol]);
    r.outsidePrice = vi.fn(async () => ({ kind: 'unread' as const, detail: 'HTTP 429' })) as LpReaders['outsidePrice'];
    mount(r, `/pools?mint=${M}&task=add&pool=${sol.address}`);
    // Waited for: the reason settles once the gate and the pool's checks have both answered.
    await waitFor(() => expect(screen.getByTestId('lp-wish-why')).toHaveTextContent(/^This pool’s Add form was not opened:/), { timeout: 8_000 });
    // And after the card has spent the wish (CI, 2026-10-17: the line flipped back to "your
    // position's pool" once the live wish was gone): the line keeps where it came from.
    await new Promise((res) => setTimeout(res, 600));
    expect(screen.getByTestId('lp-wish-why')).toHaveTextContent(/^This pool’s Add form was not opened:/);
    expect(screen.getByTestId('lp-wish-why')).not.toHaveTextContent(/your position/);
    // Said where the form would have been, at the top: the page does not scroll to the card.
    expect(screen.getByTestId('lp-door')).toContainElement(screen.getByTestId('lp-wish-why'));
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
  });

  it('a door to a pool that did not read says "this pool", not your position', async () => {
    const usdc = view({ quote: USDC_QUOTE });
    const missing = key().toBase58();
    mount(readers([usdc]), `/pools?mint=${M}&task=add&pool=${missing}`);
    const line = await screen.findByTestId('lp-wish-unfound');
    expect(line).toHaveTextContent(`This pool (${missing}) did not read as a pool for this token just now`);
    expect(line).not.toHaveTextContent(/your position/i);
    expect(screen.getByTestId('lp-door')).toContainElement(line);
    expect(screen.queryByTestId('lp-one-coin-panel')).toBeNull();
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
  });
});
