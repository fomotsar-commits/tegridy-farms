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
import { isCreatedPool, rememberCreatedPool, type PoolSearchRead, type PoolView } from '../../../lib/solana/lp/poolFinder';
import { decodeAmmConfig, decodePoolState } from '../../../lib/solana/cpswap/program';
import type { WalletFacts } from '../../../lib/solana/lp/walletFacts';
import { buildPool, key } from '../../../lib/solana/lp/testkit.fixture';
import { LP_PENDING_SCOPE, readPendingTrades, savePendingTrade } from '../curve/pendingTrade';
import type { CreateFacts, LpWriteApi } from '../curve/ports';
import { TIER1_ADDRESS, fakeLpApi, lpOpenGate, LP_PROGRAM, notOpenFacts, readyFacts, tier1Config, unusedGateRpc } from './fakeLpWriteApi.fixture';

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

/** A TOKEN/SOL pool for MINT. `tier1` puts it on the public tier; otherwise its tier is a stranger key (index 0). */
function view(o: { tier1?: boolean; openTime?: bigint; address?: PublicKey } = {}): PoolView {
  const b = buildPool({ plain: true, mint: MINT, address: o.address, configIndex: 1, quoteReserve: 10n * 10n ** 9n, tokenReserve: 1_000n * 10n ** 6n, openTime: o.openTime ?? 1n });
  const raw = decodePoolState(b.address.toBase58(), b.accounts[b.address.toBase58()]!.data)!;
  const pool = { ...raw, ammConfig: o.tier1 ? TIER1_ADDRESS.toBase58() : raw.ammConfig };
  const decoded = decodeAmmConfig(b.config.toBase58(), b.accounts[b.config.toBase58()]!.data)!;
  const config = { ...decoded, index: o.tier1 ? 1 : 0 };
  const quoteIsToken0 = pool.token0Mint.startsWith('So111');
  const s = 10n * 10n ** 9n;
  const t = 1_000n * 10n ** 6n;
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

function mount(r: LpReaders, o: { mode?: LpWritesOverrides['mode']; api?: LpWriteApi; createFacts?: CreateFacts } = {}) {
  const api = o.api ?? fakeLpApi({ readCreateFacts: vi.fn(async () => o.createFacts ?? readyFacts()) });
  const load = vi.fn(async () => api);
  render(
    <MemoryRouter initialEntries={[`/pools?mint=${M}`]}>
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
    expect(c).not.toHaveTextContent(/\bAPR\b|\bAPY\b|yield of|earn fees on every trade/i);
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
    mount(readers({ findPools: vi.fn(async () => search([theirs])), outsidePrice: vi.fn(async () => ({ kind: 'no-route' as const, detail: 'no route' })) }));
    const c = await settled('no-route');
    expect(c).toHaveAttribute('data-advice', 'none');
    expect(within(c).queryByTestId('lp-create-refer')).toBeNull();
    expect(within(c).queryByRole('button', { name: 'Open a pool' })).toBeNull();
  });

  it('pools-unread: an index outage; Read again searches again', async () => {
    const r = readers({ findPools: vi.fn(async () => search([], { index: { kind: 'unread', detail: 'HTTP 502' } })) });
    mount(r);
    const c = await settled('pools-unread');
    expect(c).toHaveTextContent('We could not read every pool for this token (our pool index could not be read: HTTP 502), so we cannot tell whether one you could add to already exists. Opening a pool is off until we can.');
    fireEvent.click(within(c).getByRole('button', { name: 'Read again' }));
    await waitFor(() => expect(r.findPools).toHaveBeenCalledTimes(2));
  });

  it('no-route', async () => {
    mount(readers({ outsidePrice: vi.fn(async () => ({ kind: 'no-route' as const, detail: 'Jupiter has no route for this token' })) }));
    expect(await settled('no-route')).toHaveTextContent('Jupiter has no market price for this token. This site opens pools only for tokens that already trade somewhere it can price');
  });

  it('price-unread says the detail and reads again', async () => {
    const r = readers({ outsidePrice: vi.fn(async () => ({ kind: 'unread' as const, detail: 'Jupiter did not give a price (HTTP 502)' })) });
    mount(r);
    const c = await settled('price-unread');
    expect(c).toHaveTextContent("We could not get this token's market price from Jupiter just now (Jupiter did not give a price (HTTP 502)), so we cannot check an opening price.");
    fireEvent.click(within(c).getByRole('button', { name: 'Read again' }));
    await waitFor(() => expect(r.outsidePrice).toHaveBeenCalledTimes(2));
  });

  it('token-refused names the first reason', async () => {
    const copy: TokenSafety = { ...okToken, verdict: 'warn', warnings: [{ code: 'copies-known-name', text: 'It calls itself BOBO.' }] } as TokenSafety;
    mount(readers({ safety: vi.fn(async () => new Map([[M, copy]])) }));
    expect(await settled('token-refused')).toHaveTextContent(
      'This site does not open pools for this token: It calls itself by a well-known token’s name but has a different mint. This site does not open pools for copies.',
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
