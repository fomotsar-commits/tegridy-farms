// "Open a new pool" (SPEC_S2_CREATE K4, 4.2): the card's one line for each createOffer
// answer, the button only for `offer`, which inputs it reads again, and how a confirmed
// opening is remembered by this tab. The write layer is a fake; nothing touches a chain.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor, within, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PublicKey } from '@solana/web3.js';
import { LpInner, type LpWritesOverrides } from './SolanaLpSection';
import type { LpReaders } from './readers';
import type { TokenSafety } from '../../../lib/solana/lp/tokenSafety';
import { SOL_QUOTE } from '../../../lib/solana/lp/quotes';
import { FORECAST_WORDS } from '../../../lib/solana/lp/format';
import { TOKEN_2022_NATIVE_MINT } from '../../../lib/solana/lp/opening';
import { isCreatedPool, rememberCreatedPool, type PoolSearchRead, type PoolView } from '../../../lib/solana/lp/poolFinder';
import { decodeAmmConfig, decodePoolState } from '../../../lib/solana/cpswap/program';
import type { WalletFacts } from '../../../lib/solana/lp/walletFacts';
import { decodeObservationState } from '../../../lib/solana/lp/ownPrice';
import { buildPool, key, observationBytes } from '../../../lib/solana/lp/testkit.fixture';
import { LP_PENDING_SCOPE, readPendingTrades, savePendingTrade } from '../curve/pendingTrade';
import type { CreateFacts, LpWriteApi } from '../curve/ports';
import { TIER1_ADDRESS, fakeLpApi, lpOpenGate, LP_PROGRAM, notOpenFacts, readyFacts, tier1Config, unusedGateRpc } from './fakeLpWriteApi.fixture';
import { realToken, reasonText } from './anyToken.fixture';

// web3's address derivation cannot run under jsdom (a cross-realm Uint8Array check): the
// public tier's address is the fixture's fixed key, as `readyFacts()` reports it.
vi.mock('../../../lib/solana/cpswap/program', async (orig) => {
  const { PublicKey: Key } = await import('@solana/web3.js');
  return { ...(await orig<typeof import('../../../lib/solana/cpswap/program')>()), publicTierConfig: () => new Key(new Uint8Array(32).fill(41)) };
});

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

const MINT = key();
const M = MINT.toBase58();
const SIG = '4'.repeat(88);

/**
 * A TOKEN/SOL pool for MINT: 10 SOL and 1,000 tokens (0.01 SOL a token) unless `sol` says
 * otherwise. `tier1` puts it on the public tier; otherwise its tier is a stranger key (index 0).
 */
function view(o: { tier1?: boolean; openTime?: bigint; address?: PublicKey; sol?: bigint } = {}): PoolView {
  const s = o.sol ?? 10n * 10n ** 9n;
  const t = 1_000n * 10n ** 6n;
  const b = buildPool({ plain: true, mint: MINT, address: o.address, configIndex: 1, quoteReserve: s, tokenReserve: t, openTime: o.openTime ?? 1n });
  const raw = decodePoolState(b.address.toBase58(), b.accounts[b.address.toBase58()]!.data)!;
  const pool = { ...raw, ammConfig: o.tier1 ? TIER1_ADDRESS.toBase58() : raw.ammConfig };
  const decoded = decodeAmmConfig(b.config.toBase58(), b.accounts[b.config.toBase58()]!.data)!;
  const config = { ...decoded, index: o.tier1 ? 1 : 0 };
  const quoteIsToken0 = pool.token0Mint.startsWith('So111');
  return {
    address: b.address.toBase58(),
    origin: 'other',
    snapshot: { pool, vault0Amount: quoteIsToken0 ? s : t, vault1Amount: quoteIsToken0 ? t : s, reserve0: quoteIsToken0 ? s : t, reserve1: quoteIsToken0 ? t : s },
    config,
    tokenMint: M,
    quote: SOL_QUOTE,
    quoteIsToken0,
    quoteReserve: s,
    tokenReserve: t,
    vaultsFrozen: false,
    history: { kind: 'not-read' },
  };
}

const okToken: TokenSafety = {
  kind: 'read', mint: M, verdict: 'ok', blocks: [], warnings: [], name: 'Corn', symbol: 'CORN', metadataSource: 'metaplex',
  facts: { program: 'spl-token', mintAuthority: null, freezeAuthority: null, supply: 1n, decimals: 6, isInitialized: true, extensions: [], metadataPointer: null, tokenMetadata: null },
};

const STANDARD_1 = key().toBase58();
function search(views: PoolView[], extra: Partial<Extract<PoolSearchRead, { kind: 'ok' }>['search']> = {}): PoolSearchRead {
  return {
    kind: 'ok',
    search: {
      mint: M,
      known: { launchPool: key().toBase58(), standard: [{ index: 1, config: TIER1_ADDRESS.toBase58(), address: STANDARD_1, quote: SOL_QUOTE.mint }] },
      index: { kind: 'ok', pools: views.map((v) => v.address), truncated: false },
      pools: views.map((v) => ({ kind: 'pool' as const, view: v })),
      otherPairs: 0,
      knownState: { [STANDARD_1]: 'absent' },
      chainNow: 1_000n,
      ...extra,
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
  rents: { walletFloor: 890_880n, tokenAccount165: 2_039_280n, neverRefunded: 40_000_000n },
});

function readers(o: Partial<LpReaders> = {}): LpReaders {
  return {
    programId: LP_PROGRAM,
    safety: vi.fn(async () => new Map([[M, okToken]])),
    findPools: vi.fn(async () => search([])),
    outsidePrice: vi.fn(async () => ({ kind: 'ok' as const, solPerToken: 0.01, source: 'Jupiter' as const })),
    positions: vi.fn(async () => ({ kind: 'ok' as const, positions: [], chainNow: 1n, totalShares: 0 })),
    feeTiers: vi.fn(async () => ({ kind: 'ok' as const, openingDeposits: null, tiers: [] })),
    wallet: vi.fn(async () => facts()),
    placeShareOnChain: vi.fn(async () => ({ kind: 'not-found' as const })),
    ...o,
  };
}

function mount(r: LpReaders, o: { mode?: LpWritesOverrides['mode']; api?: LpWriteApi; createFacts?: CreateFacts; mint?: string } = {}) {
  const api = o.api ?? fakeLpApi({ readCreateFacts: vi.fn(async () => o.createFacts ?? readyFacts()) });
  const load = vi.fn(async () => api);
  render(
    <MemoryRouter initialEntries={[`/pools?mint=${o.mint ?? M}`]}>
      <LpInner readers={r} writes={{ mode: o.mode ?? 'on', load, gateRpc: unusedGateRpc }} />
    </MemoryRouter>,
  );
  return { api, load };
}

const createCard = () => screen.findByTestId('lp-create');
async function settled(state: string) {
  const c = await createCard();
  await waitFor(() => expect(c).toHaveAttribute('data-create', state));
  return c;
}
/** What an element says, as one line: for a sentence that must be exactly these words and no more. */
const said = (el: HTMLElement) => (el.textContent ?? '').replace(/\s+/g, ' ').trim();
/** One pool's own card, by the pool's address. */
const poolCard = (address: string) => screen.getAllByTestId('lp-pool').find((c) => c.getAttribute('data-pool') === address)!;

beforeEach(() => {
  sessionStorage.clear();
  wallet.publicKey = OWNER;
  wallet.signTransaction = async (t) => t;
});

describe("mode 'off'", () => {
  it('shows no create card and loads no write code', async () => {
    const { load } = mount(readers(), { mode: 'off' });
    expect(await screen.findByTestId('token-safety')).toBeInTheDocument();
    expect(screen.queryByTestId('lp-create')).toBeNull();
    expect(load).not.toHaveBeenCalled();
  });
});

describe('each answer has its own line, and only `offer` has the button', () => {
  it('offer, no pool at all: the live tier terms, the money note and Open a pool', async () => {
    const r = readers();
    mount(r);
    const c = await settled('offer');
    expect(c).toHaveTextContent('No pool for this token yet. You can open the first one on the public fee tier: 1% a trade, 0.15 SOL to open (read just now).');
    expect(c).toHaveTextContent('Trades on this site go through Jupiter, and Jupiter does not send trades to our pools.');
    expect(c).toHaveTextContent(/a new pool earns fees only when bots trade our pool program directly, mostly arbitrage/);
    expect(within(c).getByRole('button', { name: 'Open a pool' })).toBeEnabled();
    expect(c).not.toHaveTextContent(FORECAST_WORDS);
    // N20: Jupiter is asked even with no pool, once, so an opening price can be checked.
    expect(r.outsidePrice).toHaveBeenCalledTimes(1);
  });

  it('offer, only failing pools: a separate pool, and a passing pool on another tier is named but does not block', async () => {
    const failing = view({ tier1: true, openTime: 10n ** 12n });
    const otherTier = view({ address: key() });
    mount(readers({ findPools: vi.fn(async () => search([failing, otherTier])) }));
    const c = await settled('offer');
    expect(c).toHaveTextContent("None of this token's pools on the public fee tier passes the checks above. You can open a new one on the public fee tier (1% a trade, 0.15 SOL to open). It will be a separate pool: it does not fix or join the others.");
    expect(c).toHaveTextContent('This token also has a pool on fee tier 0 that passes the checks. A new pool will not share its liquidity or fees.');
  });

  // ATK-3 (audit 2026-10-03): anyone can open enough junk pools to make the index answer
  // "truncated" for good. A cut list is not an unread one: the button stays, the card
  // says the list was cut, and a new pool is never called "the first".
  it.each<[string, () => PoolView[]]>([
    ['with failing pools read', () => [view({ tier1: true, openTime: 10n ** 12n }), view({ address: key(), openTime: 10n ** 12n })]],
    ['with no pool read at all', () => []],
  ])('offer, a truncated index %s: the cut is said, and never "the first" pool or "no pool yet"', async (_l, pools) => {
    const views = pools();
    mount(readers({ findPools: vi.fn(async () => search(views, { index: { kind: 'ok', pools: views.map((v) => v.address), truncated: true } })) }));
    const c = await settled('offer');
    expect(within(c).getByRole('button', { name: 'Open a pool' })).toBeEnabled();
    expect(c).toHaveTextContent(/This token has more pools than our pool index lists/);
    expect(c).toHaveTextContent(/were not read or checked here/);
    expect(c).toHaveTextContent(/None of the pools read for this token/);
    expect(c).not.toHaveTextContent(/first|No pool for this token|None of this token's pools/i);
  });

  // Owner ruling 2026-10-03: a token may have as many pools as people open. A pool that
  // already exists is pointed to first, and the button stays.
  it('a passing pool on the public tier: the card points to it, and the button stays', async () => {
    const theirs = view({ tier1: true });
    mount(readers({ findPools: vi.fn(async () => search([theirs])) }));
    const c = await settled('offer');
    expect(c).toHaveAttribute('data-advice', 'exists');
    expect(within(c).getByTestId('lp-create-refer')).toHaveTextContent(
      `This token already has a pool on the public fee tier that passes the checks (above). The biggest is ${theirs.address}, holding 10 SOL. We suggest adding to it: liquidity in one place gives traders a better price.`,
    );
    expect(within(c).getByTestId('lp-create-still')).toHaveTextContent(
      "You can still open your own on the public fee tier (1% a trade, 0.15 SOL to open). It will be a separate pool: it does not share the other pool's liquidity or fees.",
    );
    expect(within(c).getByRole('button', { name: 'Open a pool' })).toBeEnabled();
    expect(c).not.toHaveTextContent(/Add to it instead|first one|No pool for this token/);
  });

  it('several passing pools: the one holding the most SOL is the one named', async () => {
    const small = view({ tier1: true });
    const big: PoolView = { ...view({ tier1: true, address: key() }), quoteReserve: 250n * 10n ** 9n };
    // Listed smallest first, so the answer does not lean on the list's order.
    mount(readers({ findPools: vi.fn(async () => search([small, big])) }));
    const c = await settled('offer');
    const refer = within(c).getByTestId('lp-create-refer');
    expect(refer).toHaveTextContent(`The biggest is ${big.address}, holding 250 SOL.`);
    expect(refer).not.toHaveTextContent(small.address);
  });

  it("a pool this tab opened, even while it reads 'not open yet': pointed to, its card says so too, and the button stays", async () => {
    const mine = view({ tier1: true, openTime: 10n ** 12n });
    rememberCreatedPool(mine.address);
    mount(readers({ findPools: vi.fn(async () => search([mine])) }));
    const c = await settled('offer');
    expect(c).toHaveAttribute('data-advice', 'opened-here');
    expect(c).toHaveTextContent(`You opened a pool for this token just now (${mine.address}). Your share is under 'Your positions'. Adding to it keeps your liquidity in one place.`);
    expect(within(c).getByTestId('lp-create-still')).toHaveTextContent(
      'You can still open another on the public fee tier (1% a trade, 0.15 SOL to open). It will be a separate pool, and the fee to open is paid again.',
    );
    expect(within(c).getByRole('button', { name: 'Open a pool' })).toBeEnabled();
    expect(within(screen.getByTestId('lp-pool')).getByTestId('lp-opened-here')).toHaveTextContent("You opened this pool just now. Your share is under 'Your positions'.");
  });

  it('a stopped card names no pool to add to: the stop has its own line', async () => {
    const theirs = view({ tier1: true });
    mount(readers({ findPools: vi.fn(async () => search([theirs])), outsidePrice: vi.fn(async () => ({ kind: 'unread' as const, detail: 'Jupiter did not give a price (HTTP 502)' })) }));
    const c = await settled('price-unread');
    expect(c).toHaveAttribute('data-advice', 'none');
    expect(within(c).queryByTestId('lp-create-refer')).toBeNull();
    expect(within(c).queryByRole('button', { name: 'Open a pool' })).toBeNull();
    // A stop is not a warning: the card has no list of warnings beside it.
    expect(within(c).queryByTestId('lp-create-cautions')).toBeNull();
  });

  // Owner ruling 2026-10-04: a pool whose price is off the market takes deposits, with a
  // warning. The card still names it, but never says "we suggest adding to it" of a pool
  // that a deposit would lose money in, and puts no Add button of its own for it.
  it('a pool whose price is off the market is named, but adding to it is not suggested', async () => {
    const theirs = view({ tier1: true });
    // The pool holds 10 SOL and 1,000 tokens (0.01 SOL a token). Jupiter says 0.02.
    mount(readers({ findPools: vi.fn(async () => search([theirs])), outsidePrice: vi.fn(async () => ({ kind: 'ok' as const, solPerToken: 0.02, source: 'Jupiter' as const })) }));
    const c = await settled('offer');
    expect(c).toHaveAttribute('data-advice', 'exists');
    const refer = within(c).getByTestId('lp-create-refer');
    expect(refer).toHaveTextContent(
      `This token already has a pool on the public fee tier that takes deposits, with a warning (above). The biggest is ${theirs.address}, holding 10 SOL. Its price is 50.0% below the price it is checked against (its card above shows both), so we do not suggest adding to it now: a deposit there would pay for that gap.`,
    );
    expect(refer).not.toHaveTextContent('We suggest adding to it');
    expect(refer).not.toHaveTextContent('passes the checks');
    // The pool's own card still offers adding: the warning takes no button away there.
    await waitFor(() => expect(screen.getByTestId('lp-pool')).toHaveAttribute('data-add', 'offer'));
    // This card puts no pointer of its own beside a pool it does not suggest.
    expect(within(c).queryByRole('button', { name: /^See / })).toBeNull();
    // With nothing suggested beside it, Open a pool is the first choice, and looks it.
    expect(within(c).getByRole('button', { name: 'Open a pool' })).toHaveClass('btn-primary');
  });

  it('a pool this tab opened whose price is off the market: named as yours, and adding to it is not suggested either', async () => {
    const mine = view({ tier1: true });
    rememberCreatedPool(mine.address);
    // 0.01 SOL a token in the pool; Jupiter says 0.005: the pool is 100% above it.
    mount(readers({ findPools: vi.fn(async () => search([mine])), outsidePrice: vi.fn(async () => ({ kind: 'ok' as const, solPerToken: 0.005, source: 'Jupiter' as const })) }));
    const c = await settled('offer');
    expect(c).toHaveAttribute('data-advice', 'opened-here');
    const opened = within(c).getByTestId('lp-create-opened');
    expect(opened).toHaveTextContent(
      `You opened a pool for this token just now (${mine.address}). Your share is under 'Your positions'. Its price is 100.0% above the price it is checked against (its card above shows both), so we do not suggest adding to it now: a deposit there would pay for that gap.`,
    );
    expect(opened).not.toHaveTextContent('Adding to it keeps your liquidity in one place');
    await waitFor(() => expect(screen.getByTestId('lp-pool')).toHaveAttribute('data-add', 'offer'));
    expect(within(c).queryByRole('button', { name: /^See / })).toBeNull();
  });

  it('…and at the market price it is suggested, with its pointer to that pool first', async () => {
    const theirs = view({ tier1: true });
    mount(readers({ findPools: vi.fn(async () => search([theirs])) }));
    const c = await settled('offer');
    expect(within(c).getByTestId('lp-create-refer')).toHaveTextContent('We suggest adding to it: liquidity in one place gives traders a better price.');
    expect(await within(c).findByRole('button', { name: 'See that pool' })).toHaveClass('btn-primary');
    expect(within(c).getByRole('button', { name: 'Open a pool' })).toHaveClass('btn-secondary');
  });

  // B3 (2026-10-06): the card points at the pool; adding is the pool card's own button. A
  // second Add button here opened a form from a card that had just said "see that pool".
  it('the pointer shows that pool’s card, with its heading focused, and opens no form: the Add button is the pool card’s own', async () => {
    const theirs = view({ tier1: true });
    mount(readers({ findPools: vi.fn(async () => search([theirs])) }));
    const c = await settled('offer');
    const pool = screen.getByTestId('lp-pool');
    await waitFor(() => expect(pool).toHaveAttribute('data-add', 'offer'));
    expect(within(c).queryByRole('button', { name: /^Add liquidity/ })).toBeNull();
    fireEvent.click(await within(c).findByRole('button', { name: 'See that pool' }));
    await waitFor(() => expect(within(pool).getByRole('heading', { level: 3 })).toHaveFocus());
    expect(screen.queryByTestId('lp-add-panel')).toBeNull();
    expect(within(pool).getByRole('button', { name: 'Add liquidity' })).toHaveAttribute('aria-expanded', 'false');
  });

  // Review 2026-10-04 (C1). A pool at a wrong price takes deposits now, so it used to be
  // "the biggest passing pool": the card named it, did not suggest it, and never showed the
  // smaller pool at the market or a way into it.
  it('a big pool at a wrong price beside a smaller one at the market: the card suggests the pool at the market, and its pointer shows THAT pool’s card', async () => {
    const atMarket = view({ tier1: true });
    // 40 SOL against the same 1,000 tokens: 0.04 SOL a token, 300% above Jupiter's 0.01.
    const off = view({ tier1: true, address: key(), sol: 40n * 10n ** 9n });
    // Listed biggest first, as the real lookup lists them.
    mount(readers({ findPools: vi.fn(async () => search([off, atMarket])) }));
    const c = await settled('offer');
    await waitFor(() => expect(poolCard(off.address)).toHaveAttribute('data-price', 'disagrees'));
    expect(poolCard(off.address)).toHaveAttribute('data-deposits', 'allowed');
    expect(poolCard(atMarket.address)).toHaveAttribute('data-price', 'agrees');
    expect(said(within(c).getByTestId('lp-create-refer'))).toBe(
      `This token already has a pool on the public fee tier that passes the checks (above). The biggest is ${atMarket.address}, holding 10 SOL. We suggest adding to it: liquidity in one place gives traders a better price.`,
    );
    // The off-price pool is not the one this card sends anyone to.
    expect(c).not.toHaveTextContent(off.address);
    expect(c).not.toHaveTextContent('40 SOL');
    expect(c).not.toHaveTextContent('we do not suggest adding to it');
    // One pointer, the first choice, and it is the at-market pool's.
    const see = await within(c).findByRole('button', { name: 'See that pool' });
    expect(within(c).getAllByRole('button', { name: /^See / })).toHaveLength(1);
    expect(see).toHaveClass('btn-primary');
    fireEvent.click(see);
    await waitFor(() => expect(within(poolCard(atMarket.address)).getByRole('heading', { level: 3 })).toHaveFocus());
    expect(within(poolCard(off.address)).getByRole('heading', { level: 3 })).not.toHaveFocus();
    expect(screen.queryByTestId('lp-add-panel')).toBeNull();
  }, 20_000);

  // Whole-change review 2026-10-04 (L3). The first screen's Add liquidity asks for no pool
  // by name, and went to the first pool in the list that takes deposits. The list is
  // deepest first, and a pool at a wrong price takes deposits now, so the site itself put
  // the visitor in the pool a deposit loses money in, while this card suggested the other.
  const addTask = () => fireEvent.click(within(screen.getByTestId('lp-tasks')).getByRole('button', { name: 'Add liquidity' }));
  const addFormPool = async () => {
    const panel = await screen.findByTestId('lp-add-panel');
    return screen.getAllByTestId('lp-pool').find((card) => card.contains(panel))?.getAttribute('data-pool');
  };

  it('Add liquidity on the first screen, a big pool at a wrong price listed above one at the market: the form opens in the pool at the market, the one this card suggests', async () => {
    const atMarket = view({ tier1: true });
    const off = view({ tier1: true, address: key(), sol: 40n * 10n ** 9n });
    mount(readers({ findPools: vi.fn(async () => search([off, atMarket])) }));
    const c = await settled('offer');
    // Both take deposits; only the deeper one carries a price warning.
    await waitFor(() => expect(poolCard(atMarket.address)).toHaveAttribute('data-add', 'offer'));
    expect(poolCard(off.address)).toHaveAttribute('data-add', 'offer');
    expect(poolCard(off.address)).toHaveAttribute('data-price', 'disagrees');
    addTask();
    expect(await addFormPool()).toBe(atMarket.address);
    // The pool this card suggests, and the pool its own Add button opens, are that same pool.
    expect(within(c).getByTestId('lp-create-refer')).toHaveTextContent(`The biggest is ${atMarket.address}, holding 10 SOL. We suggest adding to it`);
    expect(screen.getAllByTestId('lp-add-panel')).toHaveLength(1);
  }, 20_000);

  it('…two pools at the market: still the deepest, as it always was', async () => {
    const small = view({ tier1: true });
    const big = view({ tier1: true, address: key(), sol: 40n * 10n ** 9n });
    // Jupiter says 0.04 for the big one's sake: then the small one is the pool that is off.
    mount(readers({ findPools: vi.fn(async () => search([big, small])), outsidePrice: vi.fn(async () => ({ kind: 'ok' as const, solPerToken: 0.04, source: 'Jupiter' as const })) }));
    await settled('offer');
    await waitFor(() => expect(poolCard(big.address)).toHaveAttribute('data-add', 'offer'));
    expect(poolCard(big.address)).toHaveAttribute('data-price', 'agrees');
    addTask();
    expect(await addFormPool()).toBe(big.address);
  }, 20_000);

  // A warning never takes the form away: when every pool that takes deposits carries a
  // price warning, the first of them still opens, and its form says the warning.
  it('…and when the only pool is at a wrong price, its form still opens, with the warning in it', async () => {
    const off = view({ tier1: true, sol: 40n * 10n ** 9n });
    mount(readers({ findPools: vi.fn(async () => search([off])) }));
    await settled('offer');
    await waitFor(() => expect(poolCard(off.address)).toHaveAttribute('data-add', 'offer'));
    addTask();
    expect(await addFormPool()).toBe(off.address);
    expect(within(screen.getByTestId('lp-add-panel')).getByTestId('lp-add-warnings')).toHaveTextContent('Its price is 300.0% above the outside price.');
  }, 20_000);

  // The fallback is the FIRST warned pool in list order (the deepest), which is also the
  // one this card names. With a single pool, as above, "first" and "last" are the same
  // pool, so nothing held the rule until this test (review of the fixes, 2026-10-04).
  it('…and with two pools at wrong prices, the form opens in the first one listed, the pool this card names', async () => {
    const deeper = view({ tier1: true, address: key(), sol: 40n * 10n ** 9n });
    const shallower = view({ tier1: true, address: key(), sol: 20n * 10n ** 9n });
    mount(readers({ findPools: vi.fn(async () => search([deeper, shallower])) }));
    const c = await settled('offer');
    await waitFor(() => expect(poolCard(shallower.address)).toHaveAttribute('data-add', 'offer'));
    for (const v of [deeper, shallower]) expect(poolCard(v.address)).toHaveAttribute('data-price', 'disagrees');
    addTask();
    expect(await addFormPool()).toBe(deeper.address);
    expect(within(c).getByTestId('lp-create-refer')).toHaveTextContent(`The biggest is ${deeper.address}, holding 40 SOL.`);
    expect(screen.getAllByTestId('lp-add-panel')).toHaveLength(1);
  }, 20_000);

  // A launch pool that passed its own check is listed below a deeper pool anyone could
  // open. With no market price that pool is checked against the launch pool's price
  // (poolHealth.ts): at four times it, it carries the price warning, and is passed over.
  it('…a token with no market price: a deeper pool anyone could open, off the launch pool’s price, is passed over for the launch pool', async () => {
    const stranger = view({ tier1: true, sol: 40n * 10n ** 9n });
    const neverTraded = { initialized: false, index: 0, poolId: new Uint8Array(32), observations: [], lastUpdate: 0n };
    const launch: PoolView = { ...view({ address: key() }), origin: 'launch-pool', history: { kind: 'ok', obs: neverTraded } };
    mount(readers({ findPools: vi.fn(async () => search([stranger, launch])), outsidePrice: vi.fn(async () => ({ kind: 'no-route' as const, detail: 'Jupiter has no route for this token' })) }));
    await settled('offer');
    await waitFor(() => expect(poolCard(launch.address)).toHaveAttribute('data-add', 'offer'));
    expect(poolCard(stranger.address)).toHaveAttribute('data-add', 'offer');
    expect(poolCard(stranger.address)).toHaveAttribute('data-price', 'disagrees');
    expect(within(poolCard(stranger.address)).getByTestId('lp-pool-warnings')).toHaveTextContent('Its price is 300.0% above the launch pool’s price.');
    expect(poolCard(launch.address)).toHaveAttribute('data-price', 'no-trades-yet');
    addTask();
    expect(await addFormPool()).toBe(launch.address);
  }, 20_000);

  // Review 2026-10-04 (C2). What the card says of the pool it points to, by what the
  // price check found. Only a price that AGREES is "passes the checks" and "we suggest".
  // No market price: nothing was compared, so neither is said, and its Add button stays
  // (for a token with no market the pool that exists may be the right place). Off its
  // reference: neither is said, and this card puts no pointer to it.
  const NO_ROUTE = { kind: 'no-route' as const, detail: 'Jupiter has no route for this token' };
  const jupiter = (solPerToken: number) => ({ kind: 'ok' as const, solPerToken, source: 'Jupiter' as const });
  const PASSES = 'that passes the checks (above)';
  const WARNED = 'that takes deposits, with a warning (above)';
  it.each([
    {
      name: 'its price agrees',
      outside: jupiter(0.01),
      state: 'agrees',
      how: PASSES,
      line: 'We suggest adding to it: liquidity in one place gives traders a better price.',
      pointer: true,
    },
    {
      name: 'the token has no market price',
      outside: NO_ROUTE,
      state: 'no-market',
      how: WARNED,
      line: 'Jupiter has no market price for this token, so that pool’s price was not checked against anything. Adding to it keeps liquidity in one place; a pool of your own starts at the price you set.',
      pointer: true,
    },
    {
      name: 'its price is off',
      outside: jupiter(0.02),
      state: 'disagrees',
      how: WARNED,
      line: 'Its price is 50.0% below the price it is checked against (its card above shows both), so we do not suggest adding to it now: a deposit there would pay for that gap.',
      pointer: false,
    },
  ])('what the card says of the pool it points to, when $name (price check: $state)', async ({ outside, state, how, line, pointer }) => {
    const theirs = view({ tier1: true });
    mount(readers({ findPools: vi.fn(async () => search([theirs])), outsidePrice: vi.fn(async () => outside) }));
    const c = await settled('offer');
    const pool = screen.getByTestId('lp-pool');
    await waitFor(() => expect(pool).toHaveAttribute('data-add', 'offer'));
    expect(pool).toHaveAttribute('data-price', state);
    const refer = within(c).getByTestId('lp-create-refer');
    expect(said(refer)).toBe(`This token already has a pool on the public fee tier ${how}. The biggest is ${theirs.address}, holding 10 SOL. ${line}`);
    // Only a price that agrees is called passing, and only that pool is suggested.
    expect(refer.textContent?.includes('passes the checks')).toBe(state === 'agrees');
    expect(refer.textContent?.includes('We suggest adding to it')).toBe(state === 'agrees');
    const pointers = within(c).queryAllByRole('button', { name: 'See that pool' });
    expect(pointers).toHaveLength(pointer ? 1 : 0);
    if (pointer) expect(pointers[0]).toBeEnabled();
    // Whatever the card says of that pool, opening another stays offered. The form under
    // the card says of that pool what the card says: it never "passes the checks" there
    // when the card, one line above, says it takes deposits with a warning.
    fireEvent.click(within(c).getByRole('button', { name: 'Open a pool' }));
    const form = await screen.findByTestId('lp-create-panel');
    const inForm = how === PASSES ? 'that passes the checks' : 'that takes deposits, with a warning';
    expect(said(within(form).getByTestId('lp-create-advice'))).toBe(
      `This token already has a pool ${inForm} (the card above names it). Opening here makes a separate pool: it does not share that pool’s liquidity or fees.`,
    );
    // The card's pointer, where there is one, shows that pool's card: its heading takes focus, and no form opens.
    if (pointer) {
      fireEvent.click(pointers[0]!);
      await waitFor(() => expect(within(pool).getByRole('heading', { level: 3 })).toHaveFocus());
      expect(screen.queryByTestId('lp-add-panel')).toBeNull();
    }
  }, 20_000);

  // Review 2026-10-04 (leave/L2). A token with a launch pool and no Jupiter route: a pool a
  // stranger opened on the public tier, at any price, read as "no market", and this card's
  // first button pointed to it. The launch pool the same lookup read is its reference.
  describe('a token with a launch pool and no route: a stranger’s pool on the public tier', () => {
    /** The launch pool: 10 SOL and 1,000 tokens (0.01 SOL a token), on the launch tier, never traded. */
    const launchPool = (): PoolView => {
      const v = view({ address: key() });
      return { ...v, origin: 'launch-pool', history: { kind: 'ok', obs: decodeObservationState(observationBytes({ pool: new PublicKey(v.address), initialized: false }))! } };
    };
    const lookUp = (views: PoolView[]) => mount(readers({ findPools: vi.fn(async () => search(views)), outsidePrice: vi.fn(async () => NO_ROUTE) }));
    const row = (c: HTMLElement, label: string) => within(c).getByText(label).nextElementSibling?.textContent;

    it('at ten times the launch price: its card says the gap against the launch pool, and this card puts no pointer to it', async () => {
      const launch = launchPool();
      // 100 SOL against the same 1,000 tokens: 0.1 SOL a token.
      const theirs = view({ tier1: true, address: key(), sol: 100n * 10n ** 9n });
      // Listed biggest first, as the real lookup lists them.
      lookUp([theirs, launch]);
      const c = await settled('offer');
      await waitFor(() => expect(poolCard(theirs.address)).toHaveAttribute('data-add', 'offer'));
      const card = poolCard(theirs.address);
      expect(card).toHaveAttribute('data-price', 'disagrees');
      expect(card).toHaveAttribute('data-deposits', 'allowed');
      expect(within(card).getByText('Deposits: the checks pass, with warnings')).toBeInTheDocument();
      expect(within(card).getByTestId('lp-pool-warnings')).toHaveTextContent(
        'Its price is 900.0% above the launch pool’s price. A deposit here would hand that gap to the first arbitrage trade.',
      );
      expect(row(card, 'Price here')).toBe('1 token = 0.1 SOL');
      expect(row(card, 'The launch pool’s price')).toBe('1 token = 0.01 SOL');
      expect(row(card, 'Difference')).toBe('900.0% above. That is more than 3% apart: see the warning above.');
      // Nothing on it says its price was compared with nothing.
      expect(card).not.toHaveTextContent('Jupiter has no market price');
      // The launch pool keeps its own check.
      expect(poolCard(launch.address)).toHaveAttribute('data-price', 'no-trades-yet');

      expect(c).toHaveAttribute('data-advice', 'exists');
      expect(said(within(c).getByTestId('lp-create-refer'))).toBe(
        `This token already has a pool on the public fee tier that takes deposits, with a warning (above). The biggest is ${theirs.address}, holding 100 SOL. Its price is 900.0% above the price it is checked against (its card above shows both), so we do not suggest adding to it now: a deposit there would pay for that gap.`,
      );
      expect(within(c).queryByRole('button', { name: /^See / })).toBeNull();
      expect(within(c).getByRole('button', { name: 'Open a pool' })).toHaveClass('btn-primary');
    }, 20_000);

    it('at the launch price: it passes the checks against the launch pool, and is the pool this card suggests', async () => {
      const launch = launchPool();
      const theirs = view({ tier1: true, address: key() });
      lookUp([launch, theirs]);
      const c = await settled('offer');
      await waitFor(() => expect(poolCard(theirs.address)).toHaveAttribute('data-add', 'offer'));
      const card = poolCard(theirs.address);
      expect(card).toHaveAttribute('data-price', 'agrees');
      expect(within(card).getByText('Deposits: the checks pass')).toBeInTheDocument();
      expect(row(card, 'The launch pool’s price')).toBe('1 token = 0.01 SOL');
      expect(within(c).getByTestId('lp-create-refer')).toHaveTextContent('We suggest adding to it: liquidity in one place gives traders a better price.');
      fireEvent.click(await within(c).findByRole('button', { name: 'See that pool' }));
      await waitFor(() => expect(within(card).getByRole('heading', { level: 3 })).toHaveFocus());
      expect(screen.queryByTestId('lp-add-panel')).toBeNull();
    }, 20_000);
  });

  // Whole-change review 2026-10-04 (W3). "Passes the checks" was decided by the PRICE
  // alone, and on the other-tier line by nothing at all. So the Open card said it of pools
  // whose own card, on the same screen, was headed "the checks pass, with warnings". It is
  // now said only of a pool with no warning of any kind, by the test that heading uses.
  // Whether adding is SUGGESTED, and whether the card puts an Add button, is still about
  // the price alone: a token warning applies just as much to a pool the visitor opens.
  it('a pool on another fee tier whose price is off: the card does not say it "passes the checks"', async () => {
    const otherTier = view({});
    // 0.01 SOL a token in the pool; Jupiter says 0.0125: the pool is 20% below it.
    mount(readers({ findPools: vi.fn(async () => search([otherTier])), outsidePrice: vi.fn(async () => jupiter(0.0125)) }));
    const c = await settled('offer');
    await waitFor(() => expect(poolCard(otherTier.address)).toHaveAttribute('data-price', 'disagrees'));
    // That pool's own card: allowed, and headed "with warnings".
    expect(poolCard(otherTier.address)).toHaveAttribute('data-deposits', 'allowed');
    expect(within(poolCard(otherTier.address)).getByText('Deposits: the checks pass, with warnings')).toBeInTheDocument();
    expect(c).toHaveTextContent('This token also has a pool on fee tier 0 that takes deposits, with a warning. A new pool will not share its liquidity or fees.');
    expect(c).not.toHaveTextContent('that passes the checks');
  });

  it('…one clean and one warned pool on other tiers: each is said as what it is', async () => {
    const clean = view({});
    // The same tier 0, at a price 300% above the market: only this one carries a warning.
    const warned = view({ address: key(), sol: 40n * 10n ** 9n });
    mount(readers({ findPools: vi.fn(async () => search([warned, clean])) }));
    const c = await settled('offer');
    await waitFor(() => expect(poolCard(warned.address)).toHaveAttribute('data-price', 'disagrees'));
    // A tier that has a pool with no warning is said to have one that passes, and only that.
    expect(c).toHaveTextContent('This token also has a pool on fee tier 0 that passes the checks. A new pool will not share its liquidity or fees.');
    expect(c).not.toHaveTextContent('takes deposits, with a warning');
  });

  // The other-tier line goes by ANY warning, not by the price: a pool at the market whose
  // token can be frozen is headed "with warnings" on its own card, so this line must not
  // say it passes (review of the fixes, 2026-10-04: the two tests above only move the price).
  it('a pool on another fee tier at the market, for a token its creator can freeze: not said to pass the checks', async () => {
    const freezable = realToken(MINT, { freeze: key() });
    const otherTier = view({});
    mount(readers({ findPools: vi.fn(async () => search([otherTier])), safety: vi.fn(async () => new Map([[M, freezable]])) }));
    const c = await settled('offer');
    await waitFor(() => expect(poolCard(otherTier.address)).toHaveAttribute('data-deposits', 'allowed'));
    expect(poolCard(otherTier.address)).toHaveAttribute('data-price', 'agrees');
    expect(within(poolCard(otherTier.address)).getByText('Deposits: the checks pass, with warnings')).toBeInTheDocument();
    expect(c).toHaveTextContent('This token also has a pool on fee tier 0 that takes deposits, with a warning. A new pool will not share its liquidity or fees.');
    expect(c).not.toHaveTextContent('that passes the checks');
  });

  it('a pool at the market for a token its creator can freeze: "takes deposits, with a warning", and adding to it is still suggested, with its pointer', async () => {
    const freezable = realToken(MINT, { freeze: key() });
    const theirs = view({ tier1: true });
    mount(readers({ findPools: vi.fn(async () => search([theirs])), safety: vi.fn(async () => new Map([[M, freezable]])) }));
    const c = await settled('offer');
    const pool = screen.getByTestId('lp-pool');
    await waitFor(() => expect(pool).toHaveAttribute('data-add', 'offer'));
    // At the market, and its card is headed "with warnings": the token can be frozen.
    expect(pool).toHaveAttribute('data-price', 'agrees');
    expect(within(pool).getByText('Deposits: the checks pass, with warnings')).toBeInTheDocument();
    const refer = within(c).getByTestId('lp-create-refer');
    expect(said(refer)).toBe(
      `This token already has a pool on the public fee tier that takes deposits, with a warning (above). The biggest is ${theirs.address}, holding 10 SOL. We suggest adding to it: liquidity in one place gives traders a better price.`,
    );
    expect(c).not.toHaveTextContent('passes the checks (above)');
    // Not suggested against: the price is right, and the pointer to it is the first choice.
    expect(await within(c).findByRole('button', { name: 'See that pool' })).toHaveClass('btn-primary');
    // The form says of that pool what the card says.
    fireEvent.click(within(c).getByRole('button', { name: 'Open a pool' }));
    const form = await screen.findByTestId('lp-create-panel');
    expect(said(within(form).getByTestId('lp-create-advice'))).toBe(
      'This token already has a pool that takes deposits, with a warning (the card above names it). Opening here makes a separate pool: it does not share that pool’s liquidity or fees.',
    );
  }, 20_000);

  it('pools-unread: an index outage; Read again searches again', async () => {
    const r = readers({ findPools: vi.fn(async () => search([], { index: { kind: 'unread', detail: 'HTTP 502' } })) });
    mount(r);
    const c = await settled('pools-unread');
    expect(c).toHaveTextContent('We could not read every pool for this token (our pool index could not be read: HTTP 502), so we cannot tell whether one you could add to already exists. Opening a pool is off until we can.');
    fireEvent.click(within(c).getByRole('button', { name: 'Read again' }));
    await waitFor(() => expect(r.findPools).toHaveBeenCalledTimes(2));
  });

  // Owner ruling 2026-10-04: any token may have a pool. Jupiter ANSWERING that it has no
  // route used to stop the card. It is offered now, and said as a warning before the button.
  it('no market price (Jupiter answered that it has no route): offered, and said before the button', async () => {
    mount(readers({ outsidePrice: vi.fn(async () => ({ kind: 'no-route' as const, detail: 'Jupiter has no route for this token' })) }));
    const c = await settled('offer');
    const cautions = within(c).getByTestId('lp-create-cautions');
    expect(cautions).toHaveTextContent('Read these about this token first:');
    expect(cautions).toHaveTextContent(
      'Jupiter has no market price for this token, so there is nothing to compare an opening price with. If you open a pool, you set its first price yourself.',
    );
    const button = within(c).getByRole('button', { name: 'Open a pool' });
    expect(button).toBeEnabled();
    expect(cautions.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Nothing says this site refuses it any more.
    expect(c).not.toHaveTextContent(/opens pools only for tokens|does not open pools/);
  });

  it('a clean token at a market price has no list of warnings on the card', async () => {
    mount(readers());
    const c = await settled('offer');
    expect(within(c).queryByTestId('lp-create-cautions')).toBeNull();
    expect(c).not.toHaveTextContent('Read these about this token first:');
  });

  it('price-unread says the detail and reads again', async () => {
    const r = readers({ outsidePrice: vi.fn(async () => ({ kind: 'unread' as const, detail: 'Jupiter did not give a price (HTTP 502)' })) });
    mount(r);
    const c = await settled('price-unread');
    expect(c).toHaveTextContent("We could not get this token's market price from Jupiter just now (Jupiter did not give a price (HTTP 502)), so we cannot check an opening price.");
    fireEvent.click(within(c).getByRole('button', { name: 'Read again' }));
    await waitFor(() => expect(r.outsidePrice).toHaveBeenCalledTimes(2));
  });

  // A copy of a well-known name used to be refused here. It is offered now, and the card
  // says the copy warning in full before the button: it names the real token's mint.
  it('a token that copies a well-known name: offered, with the copy warning in full before the button', async () => {
    const copy = realToken(MINT, { name: 'BOBO', symbol: 'BOBO' });
    mount(readers({ safety: vi.fn(async () => new Map([[M, copy]])) }));
    const c = await settled('offer');
    const cautions = within(c).getByTestId('lp-create-cautions');
    const warning = reasonText(copy, 'copies-known-name');
    expect(warning).toContain('NOT the real BOBO (whose mint is 4nV5gNwwP68zUDat26ySChREqVaQaLudfJBkSgEzpump)');
    expect(cautions).toHaveTextContent(warning);
    const button = within(c).getByRole('button', { name: 'Open a pool' });
    expect(button).toBeEnabled();
    expect(cautions.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(c).not.toHaveTextContent(/does not open pools/);
  });

  it('a token its creator can freeze: offered, with the freeze warning before the button', async () => {
    const authority = key();
    const freezable = realToken(MINT, { freeze: authority });
    mount(readers({ safety: vi.fn(async () => new Map([[M, freezable]])) }));
    const c = await settled('offer');
    const warning = reasonText(freezable, 'freeze-authority');
    expect(warning).toContain(`freeze authority ${authority.toBase58()}`);
    expect(warning).toContain('nobody can take liquidity out of that pool');
    expect(within(c).getByTestId('lp-create-cautions')).toHaveTextContent(warning);
    expect(within(c).getByRole('button', { name: 'Open a pool' })).toBeEnabled();
  });

  // What stays refused is refused in the check's own words. A transfer fee: the pool
  // program would take it, the limit is this site's, and the block says so.
  it('token-refused: a token that charges a transfer fee, in the words of the check that blocked it', async () => {
    const feeToken = realToken(MINT, { transferFee: true });
    const block = reasonText(feeToken, 'transfer-fee');
    expect(block).toContain('This site cannot build exact deposits and withdrawals for a token with one, so it does not open or add to pools for it.');
    mount(readers({ safety: vi.fn(async () => new Map([[M, feeToken]])) }));
    const c = await settled('token-refused');
    expect(c).toHaveTextContent(`This site does not open pools for this token: ${block}`);
    expect(within(c).queryByRole('button', { name: 'Open a pool' })).toBeNull();
    expect(within(c).queryByTestId('lp-create-cautions')).toBeNull();
  });

  it('token-refused: a freezable copy that ALSO charges a transfer fee is refused for the fee; the warnings lift nothing', async () => {
    const feeToken = realToken(MINT, { transferFee: true, freeze: key(), name: 'BOBO', symbol: 'BOBO' });
    mount(readers({ safety: vi.fn(async () => new Map([[M, feeToken]])) }));
    const c = await settled('token-refused');
    expect(c).toHaveTextContent(`This site does not open pools for this token: ${reasonText(feeToken, 'transfer-fee')}`);
    expect(within(c).queryByRole('button', { name: 'Open a pool' })).toBeNull();
    // A refusal has no button to warn before: its warnings stay on the token's own card.
    expect(reasonText(feeToken, 'copies-known-name')).toContain('NOT the real BOBO');
    expect(within(c).queryByTestId('lp-create-cautions')).toBeNull();
    expect(c).not.toHaveTextContent('NOT the real BOBO');
  });

  // Two blocks of two kinds: one is this site's limit, the other is the pool program's.
  // Both are said, so nobody fixes one and comes back to be told about the next.
  it('token-refused: a token blocked twice over is told both reasons, each in its own words', async () => {
    const twice = realToken(MINT, { transferFee: true, transferHook: true });
    const fee = reasonText(twice, 'transfer-fee');
    const hook = reasonText(twice, 'extension');
    expect(hook).toContain('a transfer hook');
    expect(hook).toContain('The pool program does not accept tokens with it.');
    mount(readers({ safety: vi.fn(async () => new Map([[M, twice]])) }));
    expect(await settled('token-refused')).toHaveTextContent(`This site does not open pools for this token: ${fee} ${hook}`);
  });

  it('token-refused: an address with no account behind it', async () => {
    mount(readers({ safety: vi.fn(async () => new Map([[M, { kind: 'absent' as const, mint: M }]])) }));
    expect(await settled('token-refused')).toHaveTextContent('This site does not open pools for this token: The token does not exist.');
  });

  // The one refusal that is neither a block nor a missing token: its mint reads as a clean one.
  it('token-refused: SOL under the newer token program, in its own words', async () => {
    const native: TokenSafety = { ...okToken, mint: TOKEN_2022_NATIVE_MINT } as TokenSafety;
    mount(readers({ safety: vi.fn(async () => new Map([[TOKEN_2022_NATIVE_MINT, native]])) }), { mint: TOKEN_2022_NATIVE_MINT });
    expect(await settled('token-refused')).toHaveTextContent(
      'This site does not open pools for this token: This is SOL under the newer token program. Pools here pair a token with SOL, USDC or BAYLA.',
    );
  });

  it('token-unread', async () => {
    mount(readers({ safety: vi.fn(async () => new Map([[M, { kind: 'unread' as const, mint: M, detail: 'HTTP 429' }]])) }));
    const c = await settled('token-unread');
    expect(c).toHaveTextContent('We could not read this token just now, so opening a pool is off until we can.');
    expect(within(c).getByRole('button', { name: 'Read again' })).toBeInTheDocument();
  });

  it.each<[string, CreateFacts, string]>([
    ['tier-not-open', notOpenFacts(), "New pools from this site go on the public fee tier (tier 1), and that tier has not been created on the network yet. When the team's vault creates it, the Open a pool button appears here."],
    ['tier-off', { tier: { kind: 'switched-off', address: TIER1_ADDRESS, config: tier1Config({ disableCreatePool: true }) }, feeAccount: { kind: 'ready' } }, "Opening new pools on the public fee tier is switched off right now by the pool program's admin (the team's vault)."],
    ['tier-fee-too-high', { tier: { kind: 'fee-too-high', address: TIER1_ADDRESS, config: tier1Config({ createPoolFee: 2_000_000_000n }), limit: 1_000_000_000n }, feeAccount: { kind: 'ready' } }, "The fee to open a pool on the public fee tier is set to 2 SOL, above this site's limit of 1 SOL, so this site will not open one."],
    ['tier-bad', { tier: { kind: 'not-a-tier', address: TIER1_ADDRESS, detail: 'it is fee tier 0, not 1' }, feeAccount: { kind: 'ready' } }, "The public fee tier's account is not what this site expects (it is fee tier 0, not 1), so opening a pool is off."],
    ['fee-account', { tier: readyFacts().tier, feeAccount: { kind: 'missing' } }, "The account that receives the fee to open a pool is not set up (there is no account at its address), so opening a pool would fail. Nothing can be opened until the team's vault sets it up."],
  ])('%s', async (state, createFacts, text) => {
    mount(readers({ findPools: vi.fn(async () => search([view()])) }), { createFacts });
    const c = await settled(state);
    expect(c).toHaveTextContent(text);
    expect(within(c).queryByRole('button', { name: 'Open a pool' })).toBeNull();
    // Create facts never touch the gate: the pool's Add is still offered.
    await waitFor(() => expect(screen.getByTestId('lp-pool')).toHaveAttribute('data-add', 'offer'));
  });

  it('tier-unread and fee-account-unread read the create facts again, never the gate', async () => {
    const readCreateFacts = vi
      .fn()
      .mockResolvedValueOnce({ tier: { kind: 'unread', address: TIER1_ADDRESS, detail: 'HTTP 503' }, feeAccount: { kind: 'ready' } })
      .mockResolvedValueOnce({ tier: readyFacts().tier, feeAccount: { kind: 'unread', detail: 'HTTP 504' } })
      .mockResolvedValue(readyFacts());
    const { api } = mount(readers(), { api: fakeLpApi({ readCreateFacts }) });
    const c = await settled('tier-unread');
    expect(c).toHaveTextContent('We could not read the public fee tier just now (HTTP 503), so opening a pool is off until we can.');
    fireEvent.click(within(c).getByRole('button', { name: 'Read again' }));
    await waitFor(() => expect(c).toHaveAttribute('data-create', 'fee-account-unread'));
    expect(c).toHaveTextContent('We could not read the account that receives the fee to open a pool (HTTP 504), so opening a pool is off until we can.');
    fireEvent.click(within(c).getByRole('button', { name: 'Read again' }));
    await waitFor(() => expect(c).toHaveAttribute('data-create', 'offer'));
    expect(readCreateFacts).toHaveBeenCalledTimes(3);
    expect(api.readLpGate).toHaveBeenCalledTimes(1);
  });

  it('checking: while the create facts are on their way', async () => {
    mount(readers(), { api: fakeLpApi({ readCreateFacts: vi.fn(() => new Promise<CreateFacts>(() => {})) }) });
    const c = await settled('checking');
    expect(c).toHaveTextContent('Checking whether new pools can be opened…');
  });

  it("paused-here ('withdraw-only') and gate", async () => {
    const { api } = mount(readers(), { mode: 'withdraw-only', api: fakeLpApi({ gate: lpOpenGate({ mode: 'withdraw-only' }), readCreateFacts: vi.fn(async () => readyFacts()) }) });
    const c = await settled('paused-here');
    expect(c).toHaveTextContent('Opening pools and adding liquidity from this site are paused right now. Removing liquidity still works.');
    // Paused: the create facts are not even read.
    expect(api.readCreateFacts).not.toHaveBeenCalled();
  });

  it('gate: the pool program cannot be reached', async () => {
    mount(readers(), { api: fakeLpApi({ gate: { kind: 'blocked', reason: 'unreadable', detail: 'x' } }) });
    expect(await settled('gate')).toHaveTextContent('Opening a pool needs this page to reach the pool program, and it cannot right now');
  });
});

describe('a pending opening', () => {
  it('holds Create on every token, never Add; the pending card names it', async () => {
    const a = view();
    savePendingTrade(LP_PENDING_SCOPE, { kind: 'lp-create', signature: SIG, lastValidBlockHeight: 50, pool: key().toBase58() });
    const api = fakeLpApi({ readCreateFacts: vi.fn(async () => readyFacts()), recheckOutcome: vi.fn(async () => ({ status: 'unknown' as const, signature: SIG, message: 'Not found yet.' })) });
    mount(readers({ findPools: vi.fn(async () => search([a])) }), { api });
    const c = await settled('held');
    expect(c).toHaveTextContent('A pool you opened is not confirmed yet (see the top of this section). Opening another now could open two pools and pay the fee twice.');
    await waitFor(() => expect(screen.getByTestId('lp-pool')).toHaveAttribute('data-add', 'offer'));
    const pending = await screen.findByTestId('lp-pending');
    expect(pending).toHaveTextContent('opening a pool. Opening another pool stays off until this is checked.');
    await waitFor(() => expect(api.recheckOutcome).toHaveBeenCalledWith(conn.connection, SIG, expect.objectContaining({ kind: 'lp-create' })));
  });

  it("confirmed on its check: the tab remembers the note's pool, so the card points to it as opened here", async () => {
    const mine = view({ tier1: true });
    savePendingTrade(LP_PENDING_SCOPE, { kind: 'lp-create', signature: SIG, lastValidBlockHeight: 50, pool: mine.address });
    const findPools = vi.fn().mockResolvedValueOnce(search([])).mockResolvedValue(search([mine]));
    const api = fakeLpApi({ readCreateFacts: vi.fn(async () => readyFacts()), recheckOutcome: vi.fn(async () => ({ status: 'confirmed' as const, signature: SIG, slot: 7 })) });
    expect(isCreatedPool(mine.address)).toBe(false);
    mount(readers({ findPools }), { api });
    await waitFor(() => expect(isCreatedPool(mine.address)).toBe(true));
    await act(async () => {});
    expect(readPendingTrades(LP_PENDING_SCOPE)).toEqual([]);
    // The answer bumps the section's re-read: the pool is listed, and is this tab's.
    const c = await settled('offer');
    await waitFor(() => expect(c).toHaveAttribute('data-advice', 'opened-here'));
  });
});

// B review person-3: a Read again that comes back with the same answer is not silence.
describe('Read again says it is reading, and what it found', () => {
  it('price-unread: busy while it reads, then "the same answer" when Jupiter fails again', async () => {
    const unread = { kind: 'unread' as const, detail: 'Jupiter did not give a price (HTTP 502)' };
    const r = readers({ outsidePrice: vi.fn(async () => unread) });
    mount(r);
    const c = await settled('price-unread');
    expect(c).toHaveAttribute('aria-busy', 'false');
    let release!: () => void;
    (r.outsidePrice as ReturnType<typeof vi.fn>).mockImplementationOnce(() => new Promise((res) => (release = () => res(unread))));
    fireEvent.click(within(c).getByRole('button', { name: 'Read again' }));
    await waitFor(() => expect(c).toHaveAttribute('aria-busy', 'true'));
    const status = within(c).getByTestId('lp-create-reread');
    expect(status).toHaveAttribute('role', 'status');
    expect(status).toHaveTextContent('Reading again…');
    const button = within(c).getByRole('button', { name: 'Read again' });
    expect(button).toHaveAttribute('aria-disabled', 'true');
    // A second press while it reads asks nothing more.
    fireEvent.click(button);
    await act(async () => release());
    await waitFor(() => expect(status).toHaveTextContent('Read again just now: the same answer.'));
    expect(c).toHaveAttribute('aria-busy', 'false');
    expect(r.outsidePrice).toHaveBeenCalledTimes(2);
  });

  it('tier-unread: a fee-tier read that answers differently says the answer is new', async () => {
    const readCreateFacts = vi
      .fn()
      .mockResolvedValueOnce({ tier: { kind: 'unread', address: TIER1_ADDRESS, detail: 'HTTP 503' }, feeAccount: { kind: 'ready' } })
      .mockResolvedValue(readyFacts());
    mount(readers(), { api: fakeLpApi({ readCreateFacts }) });
    const c = await settled('tier-unread');
    fireEvent.click(within(c).getByRole('button', { name: 'Read again' }));
    await waitFor(() => expect(c).toHaveAttribute('data-create', 'offer'));
    expect(within(c).getByTestId('lp-create-reread')).toHaveTextContent('Read again just now: the answer above is new.');
  });
});
