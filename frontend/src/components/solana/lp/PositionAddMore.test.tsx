// The owner, 2026-10-03, the day the venue's first pool opened: "include ability to add
// to existing pool while having a position in already".
//
// A wallet that held pool shares saw its share under Your positions with one button,
// Remove liquidity. To add more to the same pool it had to know to look the token up in
// the finder, pick the right pool card among however many the token has, and press Add
// liquidity there. Nothing on the position said so.
//
// So, pinned here:
//   1. A position whose pool this site read gets Add more liquidity beside Remove
//      liquidity. A set-aside share gets none.
//   2. The press is the finder's own lookup (the token check, every pool, the outside
//      price, each pool's deposit check) and it ends in the Add form on THAT pool's card.
//   3. It goes to that pool or to nowhere: never to another pool's form, never to the
//      open-a-pool form. A pool that will not take a deposit shows its own card.
//   4. A pool the lookup did not return is said in a line, and nothing opens.
//   5. No button while adding is paused or the network check is not open, and it is off
//      while another form's flow is running.
//   6. (review, 2026-10-04) The position's own pool is read with the lookup, whatever the
//      index lists. A form the holder opens while the lookup reads is not replaced when
//      the answer lands. A card shown instead of a form says why, to a screen reader too.
//
// The write layer is a fake (fakeLpWriteApi.fixture.ts); the pools, positions and wallet
// are fake readers. Nothing here touches a chain.

import { useEffect } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useNavigate, type NavigateFunction } from 'react-router-dom';
import { PublicKey } from '@solana/web3.js';
import { LpInner, type LpWritesOverrides } from './SolanaLpSection';
import type { LpReaders } from './readers';
import type { TokenSafety } from '../../../lib/solana/lp/tokenSafety';
import { BAYLA_QUOTE, SOL_QUOTE, USDC_QUOTE, type QuoteCoin } from '../../../lib/solana/lp/quotes';
import type { PoolSearchRead, PoolView } from '../../../lib/solana/lp/poolFinder';
import { decodeAmmConfig, decodePoolState } from '../../../lib/solana/cpswap/program';
import type { Position } from '../../../lib/solana/lp/positions';
import type { WalletFacts } from '../../../lib/solana/lp/walletFacts';
import { buildPool, key } from '../../../lib/solana/lp/testkit.fixture';
import { LP_PENDING_SCOPE, savePendingTrade } from '../curve/pendingTrade';
import type { LpGate, LpWriteApi, Prepared } from '../curve/ports';
import { fakeLpApi, lpOpenGate, LP_PROGRAM, readyFacts, unusedGateRpc } from './fakeLpWriteApi.fixture';

const OWNER = key();
const wallet = vi.hoisted(() => ({
  publicKey: null as null | PublicKey,
  signTransaction: undefined as undefined | ((t: unknown) => Promise<unknown>),
  signMessage: undefined,
  connecting: false,
  wallet: null,
}));
const conn = vi.hoisted(() => ({ connection: { rpcEndpoint: 'fake' } }));
vi.mock('@solana/wallet-adapter-react', () => ({ useWallet: () => wallet, useConnection: () => conn }));
vi.mock('../SolanaConnectButton', () => ({ SolanaConnectButton: () => <button type="button">Connect Solana Wallet</button> }));
// web3's address derivation cannot run under jsdom: the public tier's address is the
// fixture's, as in PoolFinder.findable.test.tsx. With it the Open-a-pool card can offer,
// so a wish that wrongly fell through to it would open its form and be seen.
vi.mock('../../../lib/solana/cpswap/program', async (orig) => {
  const { PublicKey: Key } = await import('@solana/web3.js');
  return { ...(await orig<typeof import('../../../lib/solana/cpswap/program')>()), publicTierConfig: () => new Key(new Uint8Array(32).fill(41)) };
});

const MINT = key();
const M = MINT.toBase58();
const SIG = '5'.repeat(88);
const ADD_MORE = 'Add more liquidity';

/** A pool for MINT: 10 SOL and 1,000 tokens (0.01 SOL a token) unless told otherwise. */
function view(o: { sol?: bigint; tok?: bigint; openTime?: bigint; noConfig?: boolean; quote?: QuoteCoin; mint?: PublicKey } = {}): PoolView {
  const quote = o.quote ?? SOL_QUOTE;
  const s = o.sol ?? 10n * 10n ** 9n;
  const t = o.tok ?? 1_000n * 10n ** 6n;
  const mint = o.mint ?? MINT;
  const b = buildPool({ plain: true, mint, quote, configIndex: 1, quoteReserve: s, tokenReserve: t, openTime: o.openTime ?? 1n });
  const pool = decodePoolState(b.address.toBase58(), b.accounts[b.address.toBase58()]!.data)!;
  const config = decodeAmmConfig(b.config.toBase58(), b.accounts[b.config.toBase58()]!.data);
  const quoteIsToken0 = pool.token0Mint === quote.mint;
  return {
    address: b.address.toBase58(),
    origin: 'other',
    snapshot: { pool, vault0Amount: quoteIsToken0 ? s : t, vault1Amount: quoteIsToken0 ? t : s, reserve0: quoteIsToken0 ? s : t, reserve1: quoteIsToken0 ? t : s },
    config: o.noConfig ? null : config,
    tokenMint: mint.toBase58(),
    quote,
    quoteIsToken0,
    quoteReserve: s,
    tokenReserve: t,
    vaultsFrozen: false,
    history: { kind: 'not-read' },
  };
}
/** The same price as `view()`, ten times as deep: the pool an un-named Add wish would pick. */
const deeper = () => view({ sol: 100n * 10n ** 9n, tok: 10_000n * 10n ** 6n });

const okToken: TokenSafety = {
  kind: 'read', mint: M, verdict: 'ok', blocks: [], warnings: [], name: 'Corn', symbol: 'CORN', metadataSource: 'metaplex',
  facts: { program: 'spl-token', mintAuthority: null, freezeAuthority: null, supply: 1n, decimals: 6, isInitialized: true, extensions: [], metadataPointer: null, tokenMetadata: null },
};

type Entry = Extract<PoolSearchRead, { kind: 'ok' }>['search']['pools'][number];
/** The lookup's answer, in the order given (the real one lists the deepest first). */
function search(entries: (PoolView | Entry)[]): PoolSearchRead {
  const pools = entries.map((e): Entry => ('kind' in e ? e : { kind: 'pool', view: e }));
  return {
    kind: 'ok',
    search: {
      mint: M,
      known: { launchPool: key().toBase58(), standard: [{ index: 1, config: key().toBase58(), address: key().toBase58(), quote: SOL_QUOTE.mint }] },
      index: { kind: 'ok', pools: pools.map((p) => (p.kind === 'pool' ? p.view.address : p.address)), truncated: false },
      pools,
      otherPairs: 0,
      knownState: {},
      chainNow: 1_000n,
    },
  };
}

const facts = (): WalletFacts => ({
  kind: 'ok',
  lamports: 5n * 10n ** 9n,
  token: { address: key().toBase58(), amount: 500n * 10n ** 6n },
  wsol: { exists: false, amount: 0n },
  coin: null,
  lpAccountExists: false,
  rents: { walletFloor: 890_880n, tokenAccount165: 2_039_280n },
});

function position(v: PoolView, over: Partial<Position> = {}): Position {
  return {
    lpMint: v.snapshot.pool.lpMint,
    lpAccount: key().toBase58(),
    lpAmount: 250_000n,
    placement: 'found',
    placementDetail: null,
    pool: { kind: 'pool', view: v },
    value: { token0: 1n, token1: 2n, sharePct: 25 },
    tooSmall: false,
    ...over,
  };
}
const held = (...positions: Position[]) => vi.fn(async () => ({ kind: 'ok' as const, chainNow: 5n, totalShares: positions.length, positions }));

function readers(o: Partial<LpReaders> = {}): LpReaders {
  return {
    programId: LP_PROGRAM,
    safety: vi.fn(async (mints: string[]) => new Map(mints.map((m) => [m, { ...okToken, mint: m }]))),
    findPools: vi.fn(async () => search([view()])),
    outsidePrice: vi.fn(async () => ({ kind: 'ok' as const, solPerToken: 0.01, source: 'Jupiter' as const })),
    positions: vi.fn(async () => ({ kind: 'ok' as const, positions: [], chainNow: 1n, totalShares: 0 })),
    feeTiers: vi.fn(async () => ({ kind: 'ok' as const, openingDeposits: null, tiers: [] })),
    wallet: vi.fn(async () => facts()),
    placeShareOnChain: vi.fn(async () => ({ kind: 'not-found' as const })),
    ...o,
  };
}

/** The Open-a-pool card can offer in these tests (the public tier is ready), so a wrong fall-through shows. */
const openApi = (over: Parameters<typeof fakeLpApi>[0] = {}) => fakeLpApi({ readCreateFacts: vi.fn(async () => readyFacts()), ...over });

/** The page's own history, for Back and Forward. */
let go: NavigateFunction = () => {};
function History() {
  const navigate = useNavigate();
  useEffect(() => {
    go = navigate;
  }, [navigate]);
  return null;
}

function mount(r: LpReaders, o: { mode?: LpWritesOverrides['mode']; api?: LpWriteApi; path?: string } = {}) {
  const api = o.api ?? openApi();
  const writes: LpWritesOverrides = { mode: o.mode ?? 'on', load: vi.fn(async () => api), gateRpc: unusedGateRpc };
  render(
    <MemoryRouter initialEntries={[o.path ?? '/pools']}>
      <History />
      <LpInner readers={r} writes={writes} />
    </MemoryRouter>,
  );
  return { api };
}

const scrolled = vi.fn();
/** What was scrolled to, in order. */
const scrolledTo = () => scrolled.mock.contexts as Element[];
const row = (pool: string) => screen.findAllByTestId('lp-position').then((rows) => rows.find((r) => r.getAttribute('data-pool') === pool)!);
const card = (pool: string) => screen.getAllByTestId('lp-pool').find((c) => c.getAttribute('data-pool') === pool)!;
const addMore = async (pool: string) => within(await row(pool)).findByRole('button', { name: ADD_MORE });
const lookups = (r: LpReaders) => (r.findPools as ReturnType<typeof vi.fn>).mock.calls;
/** No Add form and no Open-a-pool form, anywhere on the page. */
const noFormOpen = () => {
  expect(screen.queryByTestId('lp-add-panel')).toBeNull();
  expect(screen.queryByTestId('lp-create-panel')).toBeNull();
};
/** The Open-a-pool card was never what the page went to. */
const neverWentToOpenCard = () => {
  const open = screen.getByTestId('lp-create');
  expect(scrolledTo().filter((el) => open.contains(el))).toEqual([]);
};

beforeEach(() => {
  sessionStorage.clear();
  wallet.publicKey = OWNER;
  wallet.signTransaction = async (t) => t;
  scrolled.mockClear();
  Element.prototype.scrollIntoView = scrolled;
});

describe('Add more liquidity is on a position', () => {
  it('beside Remove liquidity on a share whose pool this site read; a set-aside share gets none', async () => {
    const mine = view();
    const blockedMint = key();
    const ofBlocked = view({ mint: blockedMint });
    const blocked: TokenSafety = { ...okToken, mint: blockedMint.toBase58(), verdict: 'blocked', blocks: [{ code: 'freeze-authority', text: 'Its creator can still freeze token accounts.' }] } as TokenSafety;
    const r = readers({
      safety: vi.fn(async (mints: string[]) => new Map(mints.map((m) => [m, m === blockedMint.toBase58() ? blocked : okToken]))),
      positions: held(
        position(mine),
        position(ofBlocked),
        position(mine, { lpMint: key().toBase58(), pool: { kind: 'other-pair', address: key().toBase58(), token0Mint: key().toBase58(), token1Mint: key().toBase58() }, value: null }),
        position(mine, { lpMint: key().toBase58(), pool: { kind: 'absent', address: key().toBase58() }, value: null }),
      ),
    });
    mount(r);
    const placed = await row(mine.address);
    const add = await within(placed).findByRole('button', { name: ADD_MORE });
    const remove = within(placed).getByRole('button', { name: 'Remove liquidity' });
    // One row of two buttons: stacked and full width on a phone, side by side from `sm:` up, each a 44px target.
    expect(add.parentElement).toBe(remove.parentElement);
    expect(add.parentElement!.className).toMatch(/\bflex-col\b/);
    expect(add.parentElement!.className).toMatch(/\bsm:flex-row\b/);
    for (const b of [add, remove]) {
      expect(b.className).toContain('min-h-[44px]');
      expect(b.className).toMatch(/\bw-full\b/);
      expect(b).toBeEnabled();
    }
    // The set-aside rows: a blocked token keeps its way out, and none of them is added to.
    const aside = screen.getByTestId('lp-positions-set-aside');
    expect(within(aside).getAllByTestId('lp-position')).toHaveLength(3);
    expect(within(aside).getByRole('button', { name: 'Remove liquidity' })).toBeInTheDocument();
    expect(within(aside).queryByRole('button', { name: ADD_MORE })).toBeNull();
    // Reading the positions looked nothing up in the finder.
    expect(lookups(r)).toHaveLength(0);
  });

  it('a share too small to take out can still be added to: that is how it grows', async () => {
    const mine = view({ tok: 1_000n });
    mount(readers({ positions: held(position(mine, { lpAmount: 7n, value: null, tooSmall: true })) }));
    const r = await row(mine.address);
    await waitFor(() => expect(r).toHaveAttribute('data-remove', 'dust'));
    expect(within(r).queryByRole('button', { name: 'Remove liquidity' })).toBeNull();
    expect(await within(r).findByRole('button', { name: ADD_MORE })).toBeEnabled();
  });

  it('a share whose pool does not name that share is not offered it', async () => {
    const mine = view();
    mount(readers({ positions: held(position(mine), position(deeper(), { lpMint: key().toBase58(), value: null })) }));
    await addMore(mine.address);
    const rows = screen.getAllByTestId('lp-position');
    expect(rows).toHaveLength(2);
    expect(rows.map((x) => within(x).queryAllByRole('button', { name: ADD_MORE }).length)).toEqual([1, 0]);
  });

  it.each([USDC_QUOTE, BAYLA_QUOTE])('is the same button on a pool paired with $symbol, and ends in that pool’s Add form', async (quote) => {
    // 2,000 coins and 1,000 tokens: 2 coins a token, which is 0.01 SOL at 0.005 SOL a coin.
    const mine = view({ quote, sol: 2_000n * 10n ** 6n });
    const r = readers({
      findPools: vi.fn(async () => search([mine])),
      outsidePrice: vi.fn(async (mint: string) => ({ kind: 'ok' as const, solPerToken: mint === quote.mint ? 0.005 : 0.01, source: 'Jupiter' as const })),
      positions: held(position(mine)),
    });
    mount(r);
    fireEvent.click(await addMore(mine.address));
    const panel = await screen.findByTestId('lp-add-panel');
    expect(card(mine.address)).toHaveAttribute('data-quote', quote.symbol);
    expect(card(mine.address)).toContainElement(panel);
  });
});

describe('the press is the finder’s own lookup, and it ends in that pool’s Add form', () => {
  it('looks the position’s token up by its address, brings the answer onto the screen and opens the form inside that pool’s card', async () => {
    const mine = view();
    const r = readers({ findPools: vi.fn(async () => search([mine])), positions: held(position(mine)) });
    mount(r);
    const add = await addMore(mine.address);
    // Nothing is on the page for this token yet.
    expect(screen.queryByTestId('lp-pool')).toBeNull();
    expect(lookups(r)).toHaveLength(0);
    fireEvent.click(add);
    const panel = await screen.findByTestId('lp-add-panel');
    expect(card(mine.address)).toContainElement(panel);
    // The whole lookup ran: the token's check, its pools and the outside price.
    expect(lookups(r)).toHaveLength(1);
    expect(lookups(r)[0]![0].toBase58()).toBe(M);
    expect(r.safety).toHaveBeenCalledWith([M]);
    expect(r.outsidePrice).toHaveBeenCalledWith(M, 6);
    expect(screen.getByTestId('token-safety')).toHaveTextContent(M);
    // The token is in the finder's box, as after any lookup.
    const finder = screen.getByTestId('lp-finder');
    expect(within(finder).getByLabelText('Token mint address')).toHaveValue(M);
    // First the answer, then the form: its heading is what the page ends on, with focus.
    // (The form's own effect runs a moment after it is on the page, so this waits for it.)
    expect(scrolledTo()[0]).toBe(screen.getByTestId('lp-answer'));
    const heading = within(panel).getByRole('heading', { name: 'Add liquidity to this pool' });
    await waitFor(() => expect(scrolledTo()[scrolledTo().length - 1]).toBe(heading));
    expect(heading).toHaveFocus();
    // Nobody opened a pool.
    expect(screen.queryByTestId('lp-create-panel')).toBeNull();
  });

  it('with the token already on the page it is read again first: the form opens on the fresh answer', async () => {
    const mine = view();
    const r = readers({ findPools: vi.fn(async () => search([mine])), positions: held(position(mine)) });
    mount(r, { path: `/pools?mint=${M}` });
    await within(await screen.findByTestId('lp-pool')).findByRole('button', { name: 'Add liquidity' });
    const add = await addMore(mine.address);
    expect(lookups(r)).toHaveLength(1);
    // Something else was typed into the box and refused, and never looked up.
    const box = within(screen.getByTestId('lp-finder')).getByLabelText('Token mint address');
    fireEvent.change(box, { target: { value: 'not an address' } });
    fireEvent.click(within(screen.getByTestId('lp-finder')).getByRole('button', { name: 'Find pools' }));
    expect(await screen.findByText('That does not look like a Solana address.')).toBeInTheDocument();
    expect(scrolled).not.toHaveBeenCalled();
    let release!: (v: PoolSearchRead) => void;
    (r.findPools as ReturnType<typeof vi.fn>).mockImplementationOnce(() => new Promise<PoolSearchRead>((res) => (release = res)));
    fireEvent.click(add);
    expect(await screen.findByText('Reading the token and its pools again…')).toBeInTheDocument();
    expect(lookups(r)).toHaveLength(2);
    // The box says which token is being read, and the answer is brought onto the screen.
    expect(box).toHaveValue(M);
    expect(screen.queryByText('That does not look like a Solana address.')).toBeNull();
    expect(scrolledTo()).toEqual([screen.getByTestId('lp-answer')]);
    // Not on the old answer.
    expect(screen.queryByTestId('lp-add-panel')).toBeNull();
    await act(async () => release(search([mine])));
    expect(card(mine.address)).toContainElement(await screen.findByTestId('lp-add-panel'));
  });

  it('with two pools that both take deposits, the form opens on the position’s pool, not on the deeper one', async () => {
    const deep = deeper();
    const mine = view();
    const r = readers({ findPools: vi.fn(async () => search([deep, mine])), positions: held(position(mine)) });
    mount(r);
    fireEvent.click(await addMore(mine.address));
    const panel = await screen.findByTestId('lp-add-panel');
    expect(screen.getAllByTestId('lp-pool').map((c) => [c.getAttribute('data-pool'), c.getAttribute('data-add')])).toEqual([
      [deep.address, 'offer'],
      [mine.address, 'offer'],
    ]);
    expect(card(mine.address)).toContainElement(panel);
    expect(card(deep.address)).not.toContainElement(panel);
    expect(screen.getAllByTestId('lp-add-panel')).toHaveLength(1);
    expect(screen.queryByTestId('lp-create-panel')).toBeNull();
  });

  it('acts once: a form the holder closed is not opened again by a later read', async () => {
    const mine = view();
    const r = readers({ findPools: vi.fn(async () => search([mine])), positions: held(position(mine)) });
    mount(r);
    fireEvent.click(await addMore(mine.address));
    const panel = await screen.findByTestId('lp-add-panel');
    fireEvent.click(within(panel).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByTestId('lp-add-panel')).toBeNull());
    fireEvent.click(within(screen.getByTestId('lp-finder')).getByRole('button', { name: 'Read again' }));
    await waitFor(() => expect(lookups(r)).toHaveLength(2));
    await waitFor(() => expect(screen.queryByText('Reading the token and its pools again…')).toBeNull());
    expect(screen.queryByTestId('lp-add-panel')).toBeNull();
    // Asked again, it opens again.
    fireEvent.click(await addMore(mine.address));
    expect(await screen.findByTestId('lp-add-panel')).toBeInTheDocument();
  });
});

describe('it goes to that pool or to nowhere', () => {
  // Each of these has a deeper pool that takes deposits right beside it, and an
  // Open-a-pool card that can offer: both are what the press must NOT end in.
  const cases: { name: string; mine: () => PoolView; hold?: boolean; offer: string; says: RegExp; why: RegExp }[] = [
    { name: 'refuses deposits (it cannot trade yet)', mine: () => view({ openTime: 10n ** 10n }), offer: 'checks', says: /Deposits: refused here/, why: /this pool does not pass the checks a deposit needs\. \S/ },
    { name: 'could not be checked (its fee settings were not read)', mine: () => view({ noConfig: true }), offer: 'checks', says: /Deposits: not checked/, why: /the checks a deposit needs could not be run on this pool\. \S/ },
    { name: 'has a deposit still pending', mine: () => view(), hold: true, offer: 'held', says: /A deposit you sent to this pool is not confirmed yet/, why: /a deposit you sent to this pool is not confirmed yet\./ },
  ];
  it.each(cases)('the position’s pool $name: its card comes onto the screen with its own reason, and no form opens anywhere', async (c) => {
    const deep = deeper();
    const mine = c.mine();
    if (c.hold) savePendingTrade(LP_PENDING_SCOPE, { kind: 'lp-deposit', signature: SIG, lastValidBlockHeight: 50, pool: mine.address });
    const api = openApi({ recheckOutcome: vi.fn(async () => ({ status: 'unknown' as const, signature: SIG, message: 'Not found yet.' })) });
    const r = readers({ findPools: vi.fn(async () => search([deep, mine])), positions: held(position(mine)) });
    mount(r, { api });
    fireEvent.click(await addMore(mine.address));
    await waitFor(() => expect(scrolledTo()).toContain(card(mine.address)));
    const its = card(mine.address);
    expect(its).toHaveAttribute('data-add', c.offer);
    expect(its).toHaveTextContent(c.says);
    // A keyboard and a screen reader land on the card too, and are told why: the heading
    // alone is only the pool's kind, and the card beside it carries the same one.
    const heading = within(its).getByRole('heading', { level: 3 });
    expect(heading).toHaveFocus();
    expect(heading.textContent).toBe(within(card(deep.address)).getByRole('heading', { level: 3 }).textContent);
    const why = within(its).getByTestId('lp-wish-why');
    expect(why).toHaveTextContent('This is your position’s pool. Its Add form was not opened:');
    expect(why).toHaveTextContent(c.why);
    expect(heading).toHaveAttribute('aria-describedby', why.id);
    expect(screen.getAllByTestId('lp-wish-why')).toHaveLength(1);
    // The pool beside it would have taken the deposit. It was not asked, and not shown.
    expect(card(deep.address)).toHaveAttribute('data-add', 'offer');
    await act(async () => {});
    noFormOpen();
    neverWentToOpenCard();
    expect(scrolledTo()).not.toContain(card(deep.address));
    expect(scrolledTo()[scrolledTo().length - 1]).toBe(its);
    expect(screen.queryByTestId('lp-wish-unfound')).toBeNull();
  });

  it('a card that was only shown does not open its form by itself when a later read finds it takes deposits', async () => {
    const closed = view({ openTime: 10n ** 10n });
    // The same pool, at the same address, once it can trade.
    const opened: PoolView = { ...closed, snapshot: { ...closed.snapshot, pool: { ...closed.snapshot.pool, openTime: 1n } } };
    let now = closed;
    const r = readers({ findPools: vi.fn(async () => search([now])), positions: held(position(closed)) });
    mount(r);
    fireEvent.click(await addMore(closed.address));
    await waitFor(() => expect(scrolledTo()).toContain(card(closed.address)));
    expect(within(card(closed.address)).getByTestId('lp-wish-why')).toBeInTheDocument();
    now = opened;
    fireEvent.click(within(screen.getByTestId('lp-finder')).getByRole('button', { name: 'Read again' }));
    await waitFor(() => expect(card(closed.address)).toHaveAttribute('data-add', 'offer'));
    await act(async () => {});
    noFormOpen();
    // The reason is gone with the refusal: the card now has its own Add liquidity button.
    expect(screen.queryByTestId('lp-wish-why')).toBeNull();
    expect(within(card(closed.address)).getByRole('heading', { level: 3 })).not.toHaveAttribute('aria-describedby');
  });

  it('a pool that is listed but could not be read: its card comes onto the screen, and nothing opens', async () => {
    const deep = deeper();
    const mine = view();
    const r = readers({
      findPools: vi.fn(async () => search([deep, { kind: 'unread', address: mine.address, detail: 'HTTP 502' }])),
      positions: held(position(mine)),
    });
    mount(r);
    fireEvent.click(await addMore(mine.address));
    await waitFor(() => expect(scrolledTo()).toContain(card(mine.address)));
    expect(card(mine.address)).toHaveTextContent('We could not read this pool (HTTP 502). Nothing about it is checked.');
    const heading = within(card(mine.address)).getByRole('heading', { level: 3 });
    expect(heading).toHaveFocus();
    const why = within(card(mine.address)).getByTestId('lp-wish-why');
    expect(why).toHaveTextContent('This is your position’s pool. Its Add form was not opened: this pool could not be read just now.');
    expect(heading).toHaveAttribute('aria-describedby', why.id);
    await act(async () => {});
    noFormOpen();
    neverWentToOpenCard();
    expect(screen.queryByTestId('lp-wish-unfound')).toBeNull();
  });

  it('a pool the lookup did not return: the page says so in a line, opens nothing, and does not go to another pool', async () => {
    const deep = deeper();
    const mine = view();
    let listed = [deep];
    const r = readers({ findPools: vi.fn(async () => search(listed)), positions: held(position(mine)) });
    mount(r);
    fireEvent.click(await addMore(mine.address));
    const line = await screen.findByTestId('lp-wish-unfound');
    expect(line).toHaveTextContent(`Your position’s pool (${mine.address}) did not read as a pool for this token just now`);
    expect(line).toHaveTextContent('its Add form was not opened, and no other pool’s was opened in its place');
    // The wish is spent, so Read again alone opens nothing: the line names the press that does.
    expect(line).toHaveTextContent('Press Add more liquidity on your position again in a minute.');
    expect(line).not.toHaveTextContent('Read again');
    // Said to a screen reader too, from the finder's one live region.
    expect(screen.getByTestId('lp-status')).toHaveTextContent('Your position’s pool');
    // The deeper pool takes deposits, and the Open-a-pool card offers: neither was used.
    await waitFor(() => expect(card(deep.address)).toHaveAttribute('data-add', 'offer'));
    await waitFor(() => expect(screen.getByTestId('lp-create')).toHaveAttribute('data-create', 'offer'));
    await act(async () => {});
    noFormOpen();
    neverWentToOpenCard();
    // A later read that lists the pool takes the line away, and still opens nothing by itself.
    listed = [deep, mine];
    fireEvent.click(within(screen.getByTestId('lp-finder')).getByRole('button', { name: 'Read again' }));
    await waitFor(() => expect(screen.getAllByTestId('lp-pool')).toHaveLength(2));
    await waitFor(() => expect(screen.queryByTestId('lp-wish-unfound')).toBeNull());
    await act(async () => {});
    noFormOpen();
  });

  it('pools that could not be read at all: the line says that, never that the pool is missing, and nothing opens', async () => {
    const mine = view();
    const r = readers({
      findPools: vi.fn(async () => ({ kind: 'unread' as const, detail: 'HTTP 502', index: { kind: 'unread' as const, detail: 'HTTP 502' } })),
      positions: held(position(mine)),
    });
    mount(r);
    fireEvent.click(await addMore(mine.address));
    const line = await screen.findByTestId('lp-wish-unfound');
    expect(line).toHaveTextContent('This token’s pools could not be read just now');
    expect(line).toHaveTextContent(mine.address);
    expect(line).not.toHaveTextContent('did not read as a pool');
    expect(line).toHaveTextContent('Press Add more liquidity on your position again.');
    expect(line).not.toHaveTextContent('Read again');
    await waitFor(() => expect(screen.getByTestId('lp-create')).toHaveAttribute('data-create', 'pools-unread'));
    await act(async () => {});
    noFormOpen();
    neverWentToOpenCard();
  });

  // The line is about the last thing asked for, on the token it was asked about.
  it('the line does not come back with the token: Back, then Forward, shows the answer without it', async () => {
    const mine = view();
    mount(readers({ findPools: vi.fn(async () => search([])), positions: held(position(mine)) }));
    fireEvent.click(await addMore(mine.address));
    await screen.findByTestId('lp-wish-unfound');
    await act(async () => go(-1));
    await waitFor(() => expect(screen.queryByTestId('token-safety')).toBeNull());
    await act(async () => go(1));
    expect(await screen.findByTestId('token-safety')).toHaveTextContent(M);
    await act(async () => {});
    expect(screen.queryByTestId('lp-wish-unfound')).toBeNull();
  });

  it('the line gives way to the next ask: Add more liquidity on another share of the same token', async () => {
    const gone = view();
    const here = view();
    const r = readers({ findPools: vi.fn(async () => search([here])), positions: held(position(gone), position(here)) });
    mount(r);
    fireEvent.click(await addMore(gone.address));
    expect(await screen.findByTestId('lp-wish-unfound')).toHaveTextContent(gone.address);
    fireEvent.click(await addMore(here.address));
    expect(card(here.address)).toContainElement(await screen.findByTestId('lp-add-panel'));
    expect(screen.queryByTestId('lp-wish-unfound')).toBeNull();
    expect(screen.getByTestId('lp-status')).not.toHaveTextContent('Your position’s pool');
  });

  it('the line gives way to the next ask: Add liquidity on the first card', async () => {
    const mine = view();
    const deep = deeper();
    mount(readers({ findPools: vi.fn(async () => search([deep])), positions: held(position(mine)) }));
    fireEvent.click(await addMore(mine.address));
    await screen.findByTestId('lp-wish-unfound');
    fireEvent.click(within(screen.getByTestId('lp-tasks')).getByRole('button', { name: 'Add liquidity' }));
    // Asked with no pool named, adding goes to the deepest pool that takes it, as it always has.
    expect(card(deep.address)).toContainElement(await screen.findByTestId('lp-add-panel'));
    expect(screen.queryByTestId('lp-wish-unfound')).toBeNull();
  });
});

// The lookup reads what the index and the worked-out addresses name. A pool at its own
// address is in the index or nowhere, and the index is cut at its maximum and can be down:
// the holder of such a pool pressed the button and was told their pool was not there. The
// position holds the address, so the lookup is given it.
describe('the position’s own pool is read with the lookup', () => {
  it('a pool the index did not name is asked for by its address, and its Add form opens on the fresh answer, not on the old one', async () => {
    const deep = deeper();
    const mine = view();
    // The index names only the deeper pool. The position's pool is read when asked for.
    const r = readers({
      findPools: vi.fn(async (_mint: PublicKey, also?: readonly string[]) => search(also?.includes(mine.address) ? [deep, mine] : [deep])),
      positions: held(position(mine)),
    });
    mount(r, { path: `/pools?mint=${M}` });
    // The link's own lookup: no pool is asked for by address, and one card is on the page.
    await waitFor(() => expect(screen.getAllByTestId('lp-pool')).toHaveLength(1));
    expect(lookups(r)).toHaveLength(1);
    expect(lookups(r)[0]).toHaveLength(1);
    fireEvent.click(await addMore(mine.address));
    // Judged against the OLD answer (which does not list it) the press would end in the
    // "not found" line at once. It waits for the fresh one.
    const panel = await screen.findByTestId('lp-add-panel');
    expect(card(mine.address)).toContainElement(panel);
    expect(screen.queryByTestId('lp-wish-unfound')).toBeNull();
    expect(lookups(r)).toHaveLength(2);
    expect(lookups(r)[1]![0].toBase58()).toBe(M);
    expect(lookups(r)[1]![1]).toEqual([mine.address]);
    // And it stays asked for while the page is on this token: a later read does not take
    // the card away from under the open form.
    fireEvent.click(within(screen.getByTestId('lp-finder')).getByRole('button', { name: 'Read again' }));
    await waitFor(() => expect(lookups(r)).toHaveLength(3));
    expect(lookups(r)[2]![1]).toEqual([mine.address]);
    await waitFor(() => expect(screen.queryByText('Reading the token and its pools again…')).toBeNull());
    expect(card(mine.address)).toContainElement(screen.getByTestId('lp-add-panel'));
  });

  it('moving to another token stops asking for it', async () => {
    const mine = view();
    const other = key().toBase58();
    const r = readers({ findPools: vi.fn(async () => search([mine])), positions: held(position(mine)) });
    mount(r);
    fireEvent.click(await addMore(mine.address));
    await screen.findByTestId('lp-add-panel');
    expect(lookups(r)[0]![1]).toEqual([mine.address]);
    const finder = screen.getByTestId('lp-finder');
    fireEvent.change(within(finder).getByLabelText('Token mint address'), { target: { value: other } });
    fireEvent.click(within(finder).getByRole('button', { name: 'Find pools' }));
    await waitFor(() => expect(lookups(r)).toHaveLength(2));
    expect(lookups(r)[1]![0].toBase58()).toBe(other);
    expect(lookups(r)[1]).toHaveLength(1);
  });
});

// A lookup has no time limit, and the button sits one press from Remove liquidity. The
// press stays good only while the holder waits for it: what they do meanwhile outranks it.
describe('a form the holder opens while the lookup reads is not replaced', () => {
  /** A lookup that answers when `release` is called. */
  function slow() {
    let release!: (v: PoolSearchRead) => void;
    const findPools = vi.fn(() => new Promise<PoolSearchRead>((res) => (release = res)));
    return { findPools, answer: (v: PoolSearchRead) => act(async () => release(v)) };
  }

  it('Remove liquidity on the same row: its form stays, no Add form takes its place, and the page is not pulled off it', async () => {
    const mine = view();
    const lookup = slow();
    const r = readers({ findPools: lookup.findPools, positions: held(position(mine)) });
    mount(r);
    fireEvent.click(await addMore(mine.address));
    await screen.findByText('Reading the token and its pools from the chain…');
    const its = await row(mine.address);
    const remove = within(its).getByRole('button', { name: 'Remove liquidity' });
    fireEvent.click(remove);
    const panel = await screen.findByTestId('lp-remove-panel');
    fireEvent.click(within(panel).getByRole('button', { name: 'All' }));
    await act(async () => {});
    scrolled.mockClear();
    await lookup.answer(search([mine]));
    await waitFor(() => expect(card(mine.address)).toHaveAttribute('data-add', 'offer'));
    await act(async () => {});
    expect(screen.getByTestId('lp-remove-panel')).toBe(panel);
    expect(remove).toHaveAttribute('aria-expanded', 'true');
    expect(screen.queryByTestId('lp-add-panel')).toBeNull();
    expect(scrolled).not.toHaveBeenCalled();
    expect(screen.queryByTestId('lp-wish-unfound')).toBeNull();
    // The press is spent, not parked: closing the form and reading again opens nothing.
    fireEvent.click(within(panel).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByTestId('lp-remove-panel')).toBeNull());
    lookup.findPools.mockImplementation(async () => search([mine]));
    fireEvent.click(within(screen.getByTestId('lp-finder')).getByRole('button', { name: 'Read again' }));
    await waitFor(() => expect(lookups(r)).toHaveLength(2));
    await waitFor(() => expect(screen.queryByText('Reading the token and its pools again…')).toBeNull());
    await act(async () => {});
    noFormOpen();
  });

  it('Remove liquidity on the first card: the Add form does not open after all', async () => {
    const mine = view();
    const lookup = slow();
    mount(readers({ findPools: lookup.findPools, positions: held(position(mine)) }));
    fireEvent.click(await addMore(mine.address));
    const tasks = within(screen.getByTestId('lp-tasks'));
    // The first card says what the page is doing: adding.
    expect(tasks.getByRole('button', { name: 'Add liquidity' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(tasks.getByRole('button', { name: 'Remove liquidity' }));
    scrolled.mockClear();
    await lookup.answer(search([mine]));
    await waitFor(() => expect(card(mine.address)).toHaveAttribute('data-add', 'offer'));
    await act(async () => {});
    noFormOpen();
    expect(scrolled).not.toHaveBeenCalled();
  });

  it('with nothing opened meanwhile, the slow answer still ends in the Add form', async () => {
    const mine = view();
    const lookup = slow();
    mount(readers({ findPools: lookup.findPools, positions: held(position(mine)) }));
    fireEvent.click(await addMore(mine.address));
    await screen.findByText('Reading the token and its pools from the chain…');
    await lookup.answer(search([mine]));
    expect(card(mine.address)).toContainElement(await screen.findByTestId('lp-add-panel'));
  });

  it('a form that was already open when the button was pressed gives way: the holder asked after it', async () => {
    const deep = deeper();
    const mine = view();
    const r = readers({ findPools: vi.fn(async () => search([deep, mine])), positions: held(position(mine)) });
    mount(r, { path: `/pools?mint=${M}` });
    fireEvent.click(await within(card((await screen.findAllByTestId('lp-pool'))[0]!.getAttribute('data-pool')!)).findByRole('button', { name: 'Add liquidity' }));
    expect(card(deep.address)).toContainElement(await screen.findByTestId('lp-add-panel'));
    fireEvent.click(await addMore(mine.address));
    await waitFor(() => expect(card(mine.address)).toContainElement(screen.getByTestId('lp-add-panel')));
    expect(screen.getAllByTestId('lp-add-panel')).toHaveLength(1);
  });
});

// Every wish, with a pool named or not, is acted on only once the network check has
// answered: until then no pool can say whether it takes deposits. A position's button
// exists only after that answer, so the rule is shown here with the first card's button.
describe('a wish waits for the network check', () => {
  it('Add liquidity pressed before the check has answered opens nothing and goes nowhere; once it answers, the form it asked for opens', async () => {
    const mine = view();
    let answer!: (g: LpGate) => void;
    const api = openApi({ readLpGate: vi.fn(() => new Promise<LpGate>((res) => (answer = res))) });
    mount(readers({ findPools: vi.fn(async () => search([mine])) }), { api, path: `/pools?mint=${M}` });
    const its = await screen.findByTestId('lp-pool');
    expect(its).toHaveAttribute('data-add', 'gate');
    fireEvent.click(within(screen.getByTestId('lp-tasks')).getByRole('button', { name: 'Add liquidity' }));
    await act(async () => {});
    noFormOpen();
    expect(scrolled).not.toHaveBeenCalled();
    await act(async () => answer(lpOpenGate()));
    expect(its).toContainElement(await screen.findByTestId('lp-add-panel'));
    expect(screen.queryByTestId('lp-create-panel')).toBeNull();
  });
});

describe('when the button is not there, and when it is off', () => {
  const paused: { name: string; mode: LpWritesOverrides['mode']; api: () => LpWriteApi; remove: string }[] = [
    { name: 'adding is paused in this build', mode: 'withdraw-only', api: () => fakeLpApi({ gate: lpOpenGate({ mode: 'withdraw-only' }) }), remove: 'offer' },
    { name: 'adding is paused in this build, whatever the network check says', mode: 'withdraw-only', api: () => fakeLpApi(), remove: 'offer' },
    { name: 'adding is paused by the network check', mode: 'on', api: () => fakeLpApi({ gate: lpOpenGate({ mode: 'withdraw-only' }) }), remove: 'offer' },
    { name: 'the network check is not open', mode: 'on', api: () => fakeLpApi({ gate: { kind: 'blocked', reason: 'unreadable', detail: 'read detail' } }), remove: 'gate' },
    { name: 'liquidity is switched off', mode: 'off', api: () => fakeLpApi(), remove: 'off' },
  ];
  it.each(paused)('$name: no Add more liquidity button, and Remove is as it was', async (c) => {
    const mine = view();
    mount(readers({ findPools: vi.fn(async () => search([mine])), positions: held(position(mine)) }), { mode: c.mode, api: c.api(), path: `/pools?mint=${M}` });
    const r = await row(mine.address);
    // The answer is in: the row has settled on what it offers for taking out.
    await waitFor(() => expect(r).toHaveAttribute('data-remove', c.remove));
    await screen.findByTestId('lp-pool');
    await act(async () => {});
    expect(within(r).queryByRole('button', { name: ADD_MORE })).toBeNull();
    expect(within(r).queryAllByRole('button', { name: 'Remove liquidity' })).toHaveLength(c.remove === 'offer' ? 1 : 0);
  });

  // Nobody is let in who cannot be let out: a pool with withdrawals off or a frozen vault
  // takes no deposit from this site, and the row says so itself. It does not also offer a
  // press that costs a full lookup to learn the same thing.
  const shut: { name: string; mine: () => PoolView; remove: string }[] = [
    { name: 'one of its vaults is frozen', mine: () => ({ ...view(), vaultsFrozen: true }), remove: 'vault-frozen' },
    {
      name: 'its withdrawals are switched off',
      mine: () => {
        const v = view();
        return { ...v, snapshot: { ...v.snapshot, pool: { ...v.snapshot.pool, status: 2 } } };
      },
      remove: 'switched-off',
    },
  ];
  it.each(shut)('a pool nothing can be taken out of ($name): no Add more liquidity button on its row', async (c) => {
    const mine = c.mine();
    const open = view();
    mount(readers({ positions: held(position(mine), position(open)) }));
    // The other row has its button, so the section can add: this is about the pool.
    await addMore(open.address);
    const r = await row(mine.address);
    await waitFor(() => expect(r).toHaveAttribute('data-remove', c.remove));
    expect(within(r).queryByRole('button', { name: ADD_MORE })).toBeNull();
  });

  it('is off while another form’s flow is running, says why, and a press does nothing', async () => {
    const mine = view();
    let release!: () => void;
    const api = openApi({
      prepareLpDeposit: vi.fn(
        () =>
          new Promise<Prepared>((res) => {
            release = () => res({ ok: false as const, outcome: { status: 'not-sent' as const, stage: 'build' as const, message: 'x' } });
          }),
      ),
    });
    const r = readers({ findPools: vi.fn(async () => search([mine])), positions: held(position(mine)) });
    mount(r, { api, path: `/pools?mint=${M}` });
    const add = await addMore(mine.address);
    expect(add).toBeEnabled();
    // The pool's own Add form, mid-flow.
    fireEvent.click(await within(card(mine.address)).findByRole('button', { name: 'Add liquidity' }));
    const panel = await screen.findByTestId('lp-add-panel');
    await within(panel).findByRole('button', { name: 'Max SOL' });
    fireEvent.change(within(panel).getByLabelText('SOL to add'), { target: { value: '0.5' } });
    await act(async () => {
      fireEvent.click(within(panel).getByRole('button', { name: 'Review: add liquidity' }));
    });
    expect(add).toBeDisabled();
    expect(await row(mine.address)).toHaveTextContent('Finish or close the open liquidity panel first.');
    const before = lookups(r).length;
    fireEvent.click(add);
    expect(lookups(r)).toHaveLength(before);
    await act(async () => release());
    await waitFor(() => expect(add).toBeEnabled());
  });

  it('is off while the row’s own Remove flow is running, too', async () => {
    const mine = view();
    let release!: () => void;
    const api = openApi({
      prepareLpWithdraw: vi.fn(
        () =>
          new Promise<Prepared>((res) => {
            release = () => res({ ok: false as const, outcome: { status: 'not-sent' as const, stage: 'build' as const, message: 'x' } });
          }),
      ),
    });
    mount(readers({ positions: held(position(mine)) }), { api });
    const r = await row(mine.address);
    const add = await within(r).findByRole('button', { name: ADD_MORE });
    fireEvent.click(within(r).getByRole('button', { name: 'Remove liquidity' }));
    const panel = await screen.findByTestId('lp-remove-panel');
    // Open and idle: the holder may still change their mind and add instead.
    expect(add).toBeEnabled();
    fireEvent.click(within(panel).getByRole('button', { name: 'All' }));
    await act(async () => {
      fireEvent.click(within(panel).getByRole('button', { name: 'Review: remove liquidity' }));
    });
    expect(add).toBeDisabled();
    // The greyed button says why, here too: Remove itself is not blocked, its own form is the one running.
    expect(within(r).getByRole('button', { name: 'Remove liquidity' })).toBeEnabled();
    expect(r).toHaveTextContent('Finish or close the open liquidity panel first.');
    await act(async () => release());
    await waitFor(() => expect(add).toBeEnabled());
    expect(r).not.toHaveTextContent('Finish or close the open liquidity panel first.');
  });
});

describe('Remove liquidity is as it was', () => {
  it('opens its own form on the row, looks nothing up, and leaves Add more liquidity beside it', async () => {
    const mine = view();
    const r = readers({ positions: held(position(mine)) });
    mount(r);
    const its = await row(mine.address);
    await within(its).findByRole('button', { name: ADD_MORE });
    const remove = within(its).getByRole('button', { name: 'Remove liquidity' });
    fireEvent.click(remove);
    const panel = await screen.findByTestId('lp-remove-panel');
    expect(its).toContainElement(panel);
    expect(within(panel).getByRole('heading', { name: 'Remove liquidity from this pool' })).toHaveFocus();
    expect(remove).toHaveAttribute('aria-expanded', 'true');
    expect(lookups(r)).toHaveLength(0);
    expect(screen.queryByTestId('lp-add-panel')).toBeNull();
    expect(within(its).getByRole('button', { name: ADD_MORE })).toBeEnabled();
    fireEvent.click(within(panel).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByTestId('lp-remove-panel')).toBeNull());
    expect(remove).toHaveFocus();
  });
});
