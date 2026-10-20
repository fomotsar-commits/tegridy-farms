import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PublicKey } from '@solana/web3.js';
import { LpInner } from './SolanaLpSection';
import type { LpReaders } from './readers';
import type { TokenSafety } from '../../../lib/solana/lp/tokenSafety';
import { FORECAST_WORDS } from '../../../lib/solana/lp/format';
import { SOL_QUOTE } from '../../../lib/solana/lp/quotes';
import type { PoolSearchRead, PoolView } from '../../../lib/solana/lp/poolFinder';
import { POOL_STATUS_DISABLE_WITHDRAW, decodeAmmConfig, decodePoolState } from '../../../lib/solana/cpswap/program';
import type { Position } from '../../../lib/solana/lp/positions';
import { ExplorerLink, Row } from '../curve/ui';
import { buildPool, key } from '../../../lib/solana/lp/testkit.fixture';
import { fakeLpApi, unusedGateRpc } from './fakeLpWriteApi.fixture';
import { recordedFeeTiers, recordedTier } from '../../../lib/solana/cpswap/mainnetVenueReplay.fixture';
import { CP_SWAP_PROGRAM_ID, PLATFORM_TREASURY_MULTISIG, PLATFORM_TREASURY_VAULT } from '../../../lib/launcher/solana/curve/program';

const wallet = vi.hoisted(() => ({ publicKey: null as null | { toBase58(): string } }));
// useConnection is only reached with LP's mode 'on' (the last describe below).
vi.mock('@solana/wallet-adapter-react', () => ({ useWallet: () => wallet, useConnection: () => ({ connection: { rpcEndpoint: 'fake' } }) }));
vi.mock('../SolanaConnectButton', () => ({ SolanaConnectButton: () => <button type="button">Connect Solana Wallet</button> }));

const MINT = key();
const M = MINT.toBase58();

function view(o: { address?: PublicKey; configIndex?: number; sol?: bigint; tok?: bigint; openTime?: bigint; origin?: PoolView['origin']; status?: number; frozen?: boolean; noConfig?: boolean } = {}): PoolView {
  const b = buildPool({ plain: true, mint: MINT, address: o.address, configIndex: o.configIndex ?? 1, quoteReserve: o.sol ?? 10n * 10n ** 9n, tokenReserve: o.tok ?? 1_000n * 10n ** 6n, openTime: o.openTime ?? 1n, status: o.status });
  const pool = decodePoolState(b.address.toBase58(), b.accounts[b.address.toBase58()]!.data)!;
  const config = decodeAmmConfig(b.config.toBase58(), b.accounts[b.config.toBase58()]!.data);
  const quoteIsToken0 = pool.token0Mint.startsWith('So111');
  const s = o.sol ?? 10n * 10n ** 9n;
  const t = o.tok ?? 1_000n * 10n ** 6n;
  return {
    address: b.address.toBase58(),
    origin: o.origin ?? 'other',
    snapshot: { pool, vault0Amount: quoteIsToken0 ? s : t, vault1Amount: quoteIsToken0 ? t : s, reserve0: quoteIsToken0 ? s : t, reserve1: quoteIsToken0 ? t : s },
    config: o.noConfig ? null : config,
    tokenMint: M,
    quote: SOL_QUOTE,
    quoteIsToken0,
    quoteReserve: s,
    tokenReserve: t,
    vaultsFrozen: o.frozen ?? false,
    history: { kind: 'not-read' },
  };
}

const okToken: TokenSafety = {
  kind: 'read', mint: M, verdict: 'ok', blocks: [], warnings: [], name: 'Corn', symbol: 'CORN', metadataSource: 'metaplex',
  facts: { program: 'spl-token', mintAuthority: null, freezeAuthority: null, supply: 1n, decimals: 6, isInitialized: true, extensions: [], metadataPointer: null, tokenMetadata: null },
};

function search(views: PoolView[], extra: Partial<Extract<PoolSearchRead, { kind: 'ok' }>['search']> = {}): PoolSearchRead {
  return {
    kind: 'ok',
    search: {
      mint: M,
      known: { launchPool: key().toBase58(), standard: [{ index: 1, config: key().toBase58(), address: key().toBase58(), quote: SOL_QUOTE.mint }, { index: 0, config: key().toBase58(), address: key().toBase58(), quote: SOL_QUOTE.mint }] },
      index: { kind: 'ok', pools: views.map((v) => v.address), truncated: false },
      pools: views.map((v) => ({ kind: 'pool' as const, view: v })),
      otherPairs: 0,
      knownState: {},
      chainNow: 1_000n,
      ...extra,
    },
  };
}

function readers(o: Partial<LpReaders> = {}): LpReaders {
  return {
    programId: 'EKS4C6xvV9A5DMWaWtVnFvi7ru78EhqRAoddEMpQ2BtT',
    safety: vi.fn(async () => new Map([[M, okToken]])),
    findPools: vi.fn(async () => search([view()])),
    outsidePrice: vi.fn(async () => ({ kind: 'ok' as const, solPerToken: 0.01, source: 'Jupiter' as const })),
    positions: vi.fn(async () => ({ kind: 'ok' as const, positions: [], chainNow: 1n, totalShares: 0 })),
    feeTiers: vi.fn(async () => ({ kind: 'ok' as const, openingDeposits: null, tiers: [{ index: 0, address: 'a', config: null, state: 'absent' as const }, { index: 1, address: 'b', config: null, state: 'absent' as const }] })),
    // Not read by these tests: a test that reaches either one fails loudly, as it did
    // when they were simply missing, but the helper now satisfies LpReaders.
    wallet: vi.fn(async () => { throw new Error('readers().wallet is not stubbed in this test'); }),
    placeShareOnChain: vi.fn(async () => { throw new Error('readers().placeShareOnChain is not stubbed in this test'); }),
    ...o,
  };
}

// The reads-only section: LP's mode 'off', set here rather than taken from the committed
// switch (now 'on'), so these tests keep proving what 'off' shows whatever ships.
function mount(r: LpReaders, path = `/pools?mint=${M}`) {
  return render(<MemoryRouter initialEntries={[path]}><LpInner readers={r} writes={{ mode: 'off' }} /></MemoryRouter>);
}

beforeEach(() => { wallet.publicKey = null; });

describe('the LP section', () => {
  it('always discloses the missing review and what the vault can do', async () => {
    mount(readers(), '/pools');
    const d = screen.getByTestId('lp-disclosure');
    expect(d).toHaveTextContent(/have not had their own independent review yet/);
    expect(d).toHaveTextContent(/switch off adding, removing or trading on any pool/);
    expect(d).toHaveTextContent(/only reads/);
    // Both tabs that mount this section end with "The program", so the pointer is plain text.
    expect(d).toHaveTextContent('(see “The program” below)');
    expect(within(d).queryByRole('link')).toBeNull();
  });

  it('a clean pool: token ok, price agrees, deposits pass, announced for screen readers', async () => {
    const r = readers();
    mount(r);
    const card = await screen.findByTestId('lp-pool');
    expect(card).toHaveAttribute('data-deposits', 'allowed');
    expect(card).toHaveAttribute('data-price', 'agrees');
    expect(within(card).getAllByText('1 token = 0.01 SOL')).toHaveLength(2); // here and outside
    expect(screen.getByTestId('token-safety')).toHaveAttribute('data-verdict', 'ok');
    // The mint is always on screen, in full.
    expect(within(screen.getByTestId('token-safety')).getByText(M)).toBeInTheDocument();
    expect(screen.getByTestId('lp-status')).toHaveTextContent('One pool found for this token.');
    expect(r.outsidePrice).toHaveBeenCalledWith(M, 6);
  });

  it('a blocked token: says why, asks Jupiter nothing, refuses deposits', async () => {
    const blocked: TokenSafety = { ...okToken, verdict: 'blocked', blocks: [{ code: 'freeze-authority', text: 'Its creator can still freeze token accounts.' }] } as TokenSafety;
    const r = readers({ safety: vi.fn(async () => new Map([[M, blocked]])) });
    mount(r);
    const card = await screen.findByTestId('lp-pool');
    expect(card).toHaveAttribute('data-deposits', 'refused');
    expect(screen.getByTestId('token-safety')).toHaveAttribute('data-verdict', 'blocked');
    expect(screen.getByText('Its creator can still freeze token accounts.')).toBeInTheDocument();
    expect(r.outsidePrice).not.toHaveBeenCalled();
    // What a screen reader is read, and what the pool's card gives as its reason: what this
    // site does not do. Never that the token is "blocked" (owner ruling 2026-10-07).
    expect(screen.getByTestId('lp-status')).toHaveTextContent('This site does not open or add to pools for this token.');
    expect(within(card).getByTestId('lp-pool-deposits')).toHaveTextContent('This site does not add to pools for this token (see why above).');
    expect(card).toHaveTextContent('Not compared: because this site does not add to pools for this token');
    expect(document.body).not.toHaveTextContent(/blocked on this site|token is blocked/i);
  });

  it('a squatted standard address: swaps blocked, deposits refused, and never presented as the pool', async () => {
    const squat = view({ openTime: 10n ** 10n, origin: 'standard', sol: 1_000n, tok: 1n });
    const good = view({ address: key() });
    const s = search([good, squat]);
    if (s.kind === 'ok') s.search.knownState[s.search.known.standard[0]!.address] = 'pool';
    mount(readers({ findPools: vi.fn(async () => s) }));
    const cards = await screen.findAllByTestId('lp-pool');
    expect(cards.map((c) => c.getAttribute('data-deposits'))).toEqual(['allowed', 'refused']);
    expect(cards[1]).toHaveAttribute('data-swaps', 'not-open-yet');
    expect(within(cards[1]!).getByText(/cannot trade/)).toBeInTheDocument();
    expect(screen.getByTestId('lp-index-note')).toHaveTextContent(/does not make it the right pool/);
  });

  it('pools that could not be read are never "no pools"', async () => {
    mount(readers({ findPools: vi.fn(async () => ({ kind: 'unread' as const, detail: 'HTTP 502', index: { kind: 'unread' as const, detail: 'x' } })) }));
    expect(await screen.findByText(/does not mean there are none/)).toBeInTheDocument();
    expect(screen.queryByTestId('lp-no-pools')).not.toBeInTheDocument();
  });

  it('an index outage says only the known addresses were checked', async () => {
    const s = search([view()], { index: { kind: 'unread', detail: 'HTTP 502' } });
    mount(readers({ findPools: vi.fn(async () => s) }));
    expect(await screen.findByText(/only the addresses we can work out ourselves were checked/)).toBeInTheDocument();
  });

  it('an unread outside price leaves deposits unchecked and says so', async () => {
    mount(readers({ outsidePrice: vi.fn(async () => ({ kind: 'unread' as const, detail: 'Jupiter did not give a price (HTTP 502)' })) }));
    const card = await screen.findByTestId('lp-pool');
    expect(card).toHaveAttribute('data-deposits', 'unchecked');
    expect(within(card).getAllByText(/Jupiter did not give a price/).length).toBeGreaterThan(0);
  });

  it('refuses a bad address before reading anything', async () => {
    const r = readers();
    mount(r, '/pools');
    fireEvent.change(screen.getByLabelText('Token mint address'), { target: { value: 'not an address' } });
    fireEvent.click(screen.getByRole('button', { name: 'Find pools' }));
    expect(await screen.findByText('That does not look like a Solana address.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Token mint address'), { target: { value: 'So11111111111111111111111111111111111111112' } });
    fireEvent.click(screen.getByRole('button', { name: 'Find pools' }));
    expect(await screen.findByText(/That is SOL itself/)).toBeInTheDocument();
    expect(r.safety).not.toHaveBeenCalled();
    expect(r.findPools).not.toHaveBeenCalled();
  });

  // F1, F4, F7 on the card: never a green "the checks pass" beside a reason it should not.
  it('a pool with withdrawals off, unread fee settings or a frozen vault is never "the checks pass"', async () => {
    const off = view({ status: POOL_STATUS_DISABLE_WITHDRAW });
    const noCfg = view({ address: key(), noConfig: true, sol: 9n * 10n ** 9n, tok: 900n * 10n ** 6n });
    const frozen = view({ address: key(), frozen: true, sol: 8n * 10n ** 9n, tok: 800n * 10n ** 6n });
    mount(readers({ findPools: vi.fn(async () => search([off, noCfg, frozen])) }));
    const cards = await screen.findAllByTestId('lp-pool');
    expect(cards.map((c) => [c.getAttribute('data-deposits'), c.getAttribute('data-withdrawals')])).toEqual([
      ['refused', 'switched-off'],
      ['unchecked', 'open'],
      ['refused', 'vault-frozen'],
    ]);
    expect(within(cards[2]!).getAllByText(/vaults is frozen by the token’s issuer/).length).toBeGreaterThan(0);
    for (const c of cards) expect(within(c).queryByText('Deposits: the checks pass')).not.toBeInTheDocument();
  });

  // F2 / S1-R01: a cut list is never "no pools", and the cut is said, to eyes and ears.
  it('a truncated index with nothing to show never says "no pools", and says the list was cut', async () => {
    const s = search([], { index: { kind: 'ok', pools: [], truncated: true } });
    mount(readers({ findPools: vi.fn(async () => s) }));
    const none = await screen.findByTestId('lp-no-pools');
    // The plain "none found" line (see the next test) must not be what a cut list says.
    expect(none).not.toHaveTextContent(/No pools pairing this token with SOL, USDC or BAYLA found\./);
    expect(none).toHaveTextContent('None of the pools our index returned pairs this token with SOL, USDC or BAYLA. It returned its maximum, so there may be more.');
    expect(screen.getByTestId('lp-index-truncated')).toHaveClass('text-amber-300/90');
    expect(screen.getByTestId('lp-status')).toHaveTextContent(/returned its maximum/);
  });

  // S1-R09: a pool we could not read is not "found".
  it('counts only pools it read as found, and says how many could not be read', async () => {
    const s = search([view()]);
    if (s.kind === 'ok') s.search.pools.push({ kind: 'unread', address: key().toBase58(), detail: 'HTTP 502' });
    mount(readers({ findPools: vi.fn(async () => s) }));
    await screen.findAllByTestId('lp-pool');
    expect(screen.getByTestId('lp-status')).toHaveTextContent('One pool found for this token. One more pool could not be read.');
  });

  // S1-R07: a broken ?mint= link is shown, with the reason, not dropped.
  it('a link with an address that does not parse keeps its text in the field and says why', async () => {
    const r = readers();
    mount(r, '/pools?mint=garbage');
    expect(screen.getByLabelText('Token mint address')).toHaveValue('garbage');
    expect(screen.getByText('That does not look like a Solana address.')).toBeInTheDocument();
    expect(r.findPools).not.toHaveBeenCalled();
  });

  // S1-R04: opening a pool is never "free".
  it('opening a pool shows the fee and the account deposits that are never refunded, never "free"', async () => {
    const cfg0 = view().config!;
    const r = readers({ feeTiers: vi.fn(async () => ({ kind: 'ok' as const, openingDeposits: 41_000_000n, tiers: [{ index: 0, address: 'a', config: { ...cfg0, index: 0, createPoolFee: 0n, disableCreatePool: false }, state: 'live' as const }] })) });
    mount(r, '/pools');
    const tier = await screen.findByTestId('fee-tier-detail');
    expect(tier).toHaveTextContent('No fee, plus about 0.041 SOL of account deposits that are never refunded');
    expect(tier).not.toHaveTextContent(/\bfree\b/);
  });

  it('reads the fee tiers from the chain and says when tier 1 does not exist yet', async () => {
    mount(readers(), '/pools');
    await waitFor(() => expect(screen.getAllByTestId('fee-tier')).toHaveLength(2));
    expect(screen.getAllByTestId('fee-tier').find((r) => r.getAttribute('data-index') === '1')).toHaveAttribute('data-state', 'absent');
    expect(screen.getAllByText('not created yet')).toHaveLength(2);
  });
});

// The two tiers exactly as mainnet returned them (scripts/record-pools-venue-fixture.mjs).
// Tier 0 charges a 0.05% creator fee on top of its 0.25% trade fee, but only in a pool whose
// own switch is on: the launch program opens every launch pool that way, and cp-swap's
// public `initialize` opens every other pool with it off. A surface that prints the trade
// fee alone as what a trade costs understates a launch pool by a fifth.
describe('what a trade costs, on the tiers mainnet holds (recorded)', () => {
  const rowValue = (el: HTMLElement, label: string) => within(el).getByText(label, { exact: true }).nextElementSibling?.textContent;
  /** A pool on recorded tier 0, with the pool's own creator-fee switch as given. */
  const onTier0 = (v: PoolView, enableCreatorFee: boolean): PoolView => ({
    ...v,
    config: recordedTier(0),
    // The launch program charges the creator in SOL: OnlyToken0 when SOL is token 0.
    snapshot: { ...v.snapshot, pool: { ...v.snapshot.pool, enableCreatorFee, creatorFeeOn: v.quoteIsToken0 ? 1 : 2 } },
  });

  it('the fee-tier card: a launch pool on tier 0 costs 0.3% a trade, the creator fee has its own row, tier 1 costs 1%', async () => {
    mount(readers({ feeTiers: vi.fn(async () => recordedFeeTiers()) }), '/pools');
    await waitFor(() => expect(screen.getAllByTestId('fee-tier')).toHaveLength(2));
    // The rows: the public tier first (every pool opened here is on it), its numbers in plain sight.
    const rows = screen.getAllByTestId('fee-tier');
    expect(rows.map((r) => r.getAttribute('data-index'))).toEqual(['1', '0']);
    const cells = (r: HTMLElement) => [...r.querySelectorAll('td')].map((td) => td.textContent);
    expect(cells(rows[0]!)).toEqual(['1%', '0.84%', '0.16%']);
    // A launch pool costs the trade fee AND the creator's part, never the 0.25% trade fee alone.
    expect(cells(rows[1]!)).toEqual(['0.3%incl. 0.05% creator', '0.2%', '0.05%']);
    expect(rows[0]!.closest('details')).toBeNull();
    // The sentences, one press away, in the same order.
    const [t1, t0] = screen.getAllByTestId('fee-tier-detail') as [HTMLElement, HTMLElement];
    expect(rowValue(t0, 'Tier 0 (graduated launches)')).toBe('0.3% a trade in launch pools (0.25% trade fee, 0.05% creator fee); 0.25% in a pool anyone opens');
    expect(rowValue(t0, 'Split')).toBe('LPs 0.200%, venue 0.050% of each trade');
    expect(rowValue(t0, 'Creator fee')).toBe("0.05% a trade on top of the trade fee, in launch pools only; it goes to the token's creator, not to LPs");
    expect(rowValue(t1, 'Tier 1 (public pools)')).toBe('1% a trade');
    expect(rowValue(t1, 'Split')).toBe('LPs 0.840%, venue 0.160% of each trade');
    expect(t1).not.toHaveTextContent(/creator/i);
  });

  it('a launch pool on tier 0: traders pay 0.3%, and the creator fee is its own row, paid to the wallet that opened it', async () => {
    const v = onTier0(view({ origin: 'launch-pool' }), true);
    mount(readers({ findPools: vi.fn(async () => search([v])) }));
    const card = await screen.findByTestId('lp-pool');
    expect(rowValue(card, 'Fee tier 0')).toBe('Traders pay 0.3% a trade (0.25% trade fee, 0.05% creator fee)');
    expect(rowValue(card, 'Of that fee')).toBe("LPs keep 0.200% of each trade, the venue 0.050%, the pool's creator 0.050%");
    expect(rowValue(card, 'Creator fee')).toBe("0.05% a trade on top of the trade fee, paid to the wallet that opened this pool (Opened by, on this card), not to LPs");
    // The wallet the creator fee goes to stays in view on a pool that charges one, short, with the whole address a press away.
    const openedBy = within(card).getByRole('group', { name: 'Opened by' });
    expect(within(card).getByTestId('lp-pool-more')).not.toContainElement(openedBy);
    fireEvent.click(within(openedBy).getByRole('button', { name: /Show full address/ }));
    expect(rowValue(openedBy, 'Opened by')).toBe(v.snapshot.pool.poolCreator);
  });

  it('a pool anyone opened on tier 0 charges no creator fee, and says so; it shows no creator row', async () => {
    const v = onTier0(view(), false);
    mount(readers({ findPools: vi.fn(async () => search([v])) }));
    const card = await screen.findByTestId('lp-pool');
    expect(rowValue(card, 'Fee tier 0')).toBe('Traders pay 0.25% a trade (no creator fee)');
    expect(rowValue(card, 'Of that fee')).toBe('LPs keep 0.200% of each trade, the venue 0.050%');
    expect(within(card).queryByText('Creator fee', { exact: true })).toBeNull();
  });
});

describe('your positions', () => {
  it('asks for a wallet, and reads nothing without one', async () => {
    const r = readers();
    mount(r, '/pools');
    expect(within(screen.getByTestId('lp-positions')).getByRole('button', { name: 'Connect Solana Wallet' })).toBeInTheDocument();
    expect(r.positions).not.toHaveBeenCalled();
  });

  it('shows the share, what it is worth now and the token check', async () => {
    const owner = key();
    wallet.publicKey = owner;
    const v = view();
    const r = readers({
      positions: vi.fn(async () => ({
        kind: 'ok' as const,
        chainNow: 5n,
        totalShares: 1,
        positions: [{ lpMint: v.snapshot.pool.lpMint, lpAccount: key().toBase58(), lpAmount: 250_000n, placement: 'found' as const, placementDetail: null, pool: { kind: 'pool' as const, view: v }, value: { token0: 1n, token1: 2n, sharePct: 25 }, tooSmall: false }],
      })),
    });
    mount(r, '/pools');
    const row = await screen.findByTestId('lp-position');
    expect(row).toHaveAttribute('data-pool', v.address);
    expect(within(row).getByText('Your share: 25.0000% of the pool')).toBeInTheDocument();
    // To the unit, whichever side of the pool SOL sorts to: one lamport and two token units, or two and one.
    expect(within(row).getByText('Worth now').nextElementSibling?.textContent).toMatch(/^0\.00000000[12] SOL and 0\.00000[12] \S+$/);
    expect(within(row).getByText('no problems found')).toBeInTheDocument();
    expect(r.positions).toHaveBeenCalledWith(owner, 20);
  });

  // F3 / S1-R03: shares beyond the ones placed are counted and reachable, never dropped.
  it('says how many shares are not looked up yet, and looks up more on request', async () => {
    wallet.publicKey = key();
    const unplaced = (): Position => ({ lpMint: key().toBase58(), lpAccount: key().toBase58(), lpAmount: 5n, placement: 'not-found', placementDetail: null, pool: null, value: null, tooSmall: false });
    const positions = vi.fn(async (_o: unknown, limit?: number) => ({ kind: 'ok' as const, chainNow: 1n, totalShares: 25, positions: Array.from({ length: Math.min(limit ?? 20, 25) }, unplaced) }));
    mount(readers({ positions }), '/pools');
    const more = await screen.findByTestId('lp-positions-more');
    expect(more).toHaveTextContent('5 more pool shares that are not looked up yet');
    fireEvent.click(within(more).getByRole('button', { name: 'Look up 5 more' }));
    await waitFor(() => expect(positions).toHaveBeenLastCalledWith(wallet.publicKey, 40));
    await waitFor(() => expect(screen.getAllByTestId('lp-position')).toHaveLength(25));
    expect(screen.queryByTestId('lp-positions-more')).not.toBeInTheDocument();
  });

  // S1-R02 + F3: a share whose pool is not TOKEN/SOL, or not a pool at all, is explained and set aside, nameless.
  it('explains a share in a pool that is not TOKEN/SOL or not confirmed, set apart without names', async () => {
    wallet.publicKey = key();
    const pos = (pool: Position['pool']): Position => ({ lpMint: key().toBase58(), lpAccount: key().toBase58(), lpAmount: 5n, placement: 'found', placementDetail: null, pool, value: null, tooSmall: false });
    const t0 = key().toBase58();
    const t1 = key().toBase58();
    mount(readers({
      positions: vi.fn(async () => ({ kind: 'ok' as const, chainNow: 1n, totalShares: 3, positions: [
        pos({ kind: 'other-pair', address: key().toBase58(), token0Mint: t0, token1Mint: t1 }),
        pos({ kind: 'absent', address: key().toBase58() }),
        pos({ kind: 'not-a-pool', address: key().toBase58(), detail: 'the account is not owned by the pool program' }),
      ] })),
    }), '/pools');
    const aside = await screen.findByTestId('lp-positions-set-aside');
    const rows = within(aside).getAllByTestId('lp-position');
    expect(rows.map((r) => r.getAttribute('data-pool-kind'))).toEqual(['other-pair', 'absent', 'not-a-pool']);
    expect(rows[0]).toHaveTextContent("Neither side of this pool is SOL, USDC or BAYLA. This site does not show those pools, so nothing about it is checked here.");
    expect(rows[0]).toHaveTextContent(t0);
    expect(rows[1]).toHaveTextContent(/could not be confirmed on chain/);
    expect(rows[2]).toHaveTextContent(/not owned by the pool program/);
  });

  // S1-R08: one live region, always mounted; only its text changes.
  it('announces loading and then the result from the same live region', async () => {
    wallet.publicKey = key();
    let release!: (v: Awaited<ReturnType<LpReaders['positions']>>) => void;
    const positions = vi.fn(() => new Promise<Awaited<ReturnType<LpReaders['positions']>>>((r) => { release = r; }));
    mount(readers({ positions }), '/pools');
    const status = await screen.findByTestId('lp-positions-status');
    expect(status).toHaveAttribute('role', 'status');
    await waitFor(() => expect(status).toHaveTextContent('Reading your wallet’s pool shares.'));
    release({ kind: 'ok', positions: [], chainNow: 1n, totalShares: 0 });
    await waitFor(() => expect(status).toHaveTextContent('This wallet holds no pool shares.'));
    expect(status.isConnected).toBe(true);
    expect(within(screen.getByTestId('lp-positions')).getAllByRole('status')).toHaveLength(1);
  });

  it('a wallet that could not be read is not a wallet with no positions', async () => {
    wallet.publicKey = key();
    mount(readers({ positions: vi.fn(async () => ({ kind: 'unread' as const, detail: 'HTTP 502' })) }), '/pools');
    expect(await screen.findByText(/That does not mean it holds none/)).toBeInTheDocument();
    expect(screen.queryByTestId('lp-no-positions')).not.toBeInTheDocument();
  });
});

// S1-R05: a sentence must not break mid-word on a phone; only an address may.
describe('Row', () => {
  it('lets only a mono value break between any two letters', () => {
    const { container } = render(<><Row label="a" value="Blocked until later" mono={false} /><Row label="b" value={M} /></>);
    const [prose, mono] = [...container.querySelectorAll('span.text-right')];
    expect(prose!.className).not.toMatch(/break-all/);
    expect(prose!.className).toMatch(/overflow-wrap:anywhere/);
    expect(mono!.className).toMatch(/break-all/);
  });

  // An address followed by a sentence with an amount in it: `break-all` split the amount
  // in the middle of a number on a phone. `words` keeps the mono font and breaks between
  // words first, and inside one (the address) only when it cannot fit.
  it('a mono value marked `words` breaks between words first, and is still mono', () => {
    const { container } = render(<Row words label="c" value={`${M} (opened for you; its deposit of 0.00203928 SOL stays in that account)`} />);
    const span = container.querySelector('span.text-right')!;
    expect(span.className).toMatch(/font-mono/);
    expect(span.className).toMatch(/overflow-wrap:anywhere/);
    expect(span.className).not.toMatch(/break-all/);
  });
});

// "View on the explorer" is one small line with a finger-sized press area around it. A
// ring round that area had its bottom edge hidden behind the button under the link and
// its top edge through the row above (a real browser, 2026-10-06), so the ring goes
// round the words: `ring-on-words` on the link, one `ring-words` inside it (index.css).
describe('ExplorerLink', () => {
  it('opens the transaction in a new tab, and the keyboard’s ring goes round its words', () => {
    render(<ExplorerLink href="https://explorer.test/tx/abc" />);
    const link = screen.getByRole('link', { name: 'View on the explorer' });
    expect(link).toHaveAttribute('href', 'https://explorer.test/tx/abc');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer nofollow');
    expect(link.classList.contains('ring-on-words')).toBe(true);
    const ringed = link.querySelectorAll('.ring-words');
    expect(ringed).toHaveLength(1);
    expect(ringed[0]!.textContent).toBe('View on the explorer');
  });
});

// 6006: a share the pool program would refuse to burn is said to be too small, never
// shown as a payout with a zero side.
describe('your positions: a share too small to take out', () => {
  it('says so in place of what it is worth', async () => {
    wallet.publicKey = key();
    const v = view();
    mount(readers({
      positions: vi.fn(async () => ({
        kind: 'ok' as const, chainNow: 5n, totalShares: 1,
        positions: [{ lpMint: v.snapshot.pool.lpMint, lpAccount: key().toBase58(), lpAmount: 7n, placement: 'found' as const, placementDetail: null, pool: { kind: 'pool' as const, view: v }, value: null, tooSmall: true }],
      })),
    }), '/pools');
    const row = await screen.findByTestId('lp-position');
    expect(row).toHaveTextContent("Too small to take out at the pool's current size: one side would round to zero.");
    expect(row).not.toHaveTextContent(/Worth now/);
    expect(row).not.toHaveTextContent(/could not be worked out/);
  });
});

// One order on both tabs (owner, 2026-10-14: "the actions people need to take spotlighted and
// their positions and the rates and routes getting the attention"): the earn line, the three
// actions, the positions, the rates, the routes, the full notice last. No risk line on the page
// (owner, 2026-10-17: "remove this warning from everywhere"): it leads the notice's Risks.
describe('the order of the section', () => {
  const RISK_LINE =
    "The team's vault can pause removing, change fees or replace the program, 48 hours after both its keys approve. No outside firm has checked our changes. Only add what you can afford to lose.";
  const ORDER = ['lp-earn-line', 'lp-finder', 'lp-positions', 'fee-tiers', 'lp-routes', 'lp-disclosure'];
  const parts = () => [...screen.getByTestId('lp-section').children].map((c) => c.getAttribute('data-testid'));
  // A gate that could not be read: its banner is the top of the section's write half.
  const unreadGate = () => ({
    mode: 'on' as const,
    load: vi.fn(async () => fakeLpApi({ gate: { kind: 'blocked', reason: 'unreadable', detail: 'read detail' } })),
    gateRpc: unusedGateRpc,
  });

  it('on both tabs: the earn line, the actions, the positions, the rates, the routes, the full notice', () => {
    for (const path of ['/pools', '/solana-lp']) {
      const view = mount(readers(), path);
      expect(parts()).toEqual(ORDER);
      view.unmount();
    }
  });

  it('the rates come straight after the positions, and the earn line stands above the actions', () => {
    mount(readers(), '/solana-lp');
    expect(screen.getByTestId('lp-positions').nextElementSibling).toBe(screen.getByTestId('fee-tiers'));
    expect(screen.getByTestId('fee-tiers').nextElementSibling).toBe(screen.getByTestId('lp-routes'));
    const line = screen.getByTestId('lp-earn-line');
    expect(line.textContent).toBe('Fees grow your pool shares. Nothing to claim.');
    // Drawn first, heard first: no CSS order moves it (e2e/tab-target-size.spec.ts holds the first screen).
    expect(screen.queryByTestId('lp-risk-line')).toBeNull();
    expect(screen.getByTestId('lp-section').firstElementChild).toBe(line);
    expect(line.nextElementSibling).toBe(screen.getByTestId('lp-finder'));
    expect(line.className).not.toMatch(/\border-/);
    expect(line.textContent).not.toMatch(FORECAST_WORDS);
    expect(line.textContent).not.toContain('—');
  });

  // The vault's powers: the pool program's admin and its upgrade authority are both vault 0 of
  // a 2-of-2 Squads multisig whose time lock is 172,800 s since Squads #14 (read 2026-10-20).
  it('the vault sentence names what the team’s vault can do, with both keys and the 48-hour wait, and keeps the afford-to-lose clause', () => {
    mount(readers(), '/solana-lp');
    const line = within(screen.getByTestId('lp-disclosure')).getByText(RISK_LINE).textContent ?? '';
    expect(line).toContain('48 hours after both its keys approve');
    expect(line).not.toMatch(/no waiting period|at once/);
    expect(line).toContain('can pause removing');
    expect(line).toContain('change fees');
    expect(line).toContain('replace the program');
    expect(line).toContain('No outside firm has checked our changes.');
    expect(line).toMatch(/Only add what you can afford to lose\.$/);
    // The line it replaced did not say that removing can be paused; it is gone from the page.
    expect(screen.getByTestId('lp-section')).not.toHaveTextContent(/Admin-key changes|independently reviewed/);
    // One line, under the word budget the first screen has room for (e2e/word-budget.spec.ts).
    expect(line.split(/\s+/).length).toBeLessThan(35);
    expect(line).not.toContain('—');
  });

  it('the vault sentence is not on the page: it leads the full notice’s small print, below the positions, with the addresses', () => {
    mount(readers(), '/pools');
    expect(screen.queryByTestId('lp-risk-line')).toBeNull();
    const full = screen.getByTestId('lp-disclosure');
    expect(screen.getByTestId('lp-positions').compareDocumentPosition(full) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Once, and only behind a press: inside the notice's closed Risks drop-down, first.
    const [sentence] = screen.getAllByText(RISK_LINE);
    expect(screen.getAllByText(RISK_LINE)).toHaveLength(1);
    const small = full.querySelector('details');
    expect(small).not.toBeNull();
    expect(small).not.toHaveAttribute('open');
    expect(small).toContainElement(sentence!);
    expect(small!.querySelector('p')).toBe(sentence);
    expect(small).toHaveTextContent(/have not had their own independent review yet/);
    for (const fact of [
      'Read on chain 2026-10-20',
      `one key is both the admin of pool program ${CP_SWAP_PROGRAM_ID.toBase58()} and the only key that can replace it`,
      `That key is the team’s vault ${PLATFORM_TREASURY_VAULT.toBase58()}, vault 0 of the Squads multisig ${PLATFORM_TREASURY_MULTISIG.toBase58()}`,
      'The multisig needs 2 of its 2 keys to approve anything the vault does. Since 2026-10-19 each approved action then waits 48 hours (a time lock of 172,800 seconds) before it can run.',
      'Only those 2 keys, together, can change its rules, and such a change waits 48 hours too.',
      'The vault can switch off adding, removing or trading on any pool.',
      'replace the program',
      'Every pool’s coins sit in accounts that program controls, so a replacement could move them.',
      'you could not take your money out of that pool until it switched removing back on',
    ]) {
      expect(small).toHaveTextContent(fact);
    }
    expect(small).not.toHaveTextContent(/no waiting period|time lock of 0|at once/);
  });

  // Where a pool's fees come from is said as the routes that exist, and no more. Every trade
  // that had paid a fee by 2026-10-10 came through this site's own swap, so the notice no
  // longer says who trades a pool, how often, or that most of them are bots.
  it('the full notice says which routes can reach a pool and that the price moving can cost, and names no trader', () => {
    mount(readers(), '/pools');
    const full = screen.getByTestId('lp-disclosure');
    expect(full).toHaveTextContent(
      'Jupiter does not send trades to these pools yet, so a pool earns fees only from trades sent to it by this site’s own swap, or by someone using the pool program directly.',
    );
    expect(full).toHaveTextContent('When the price moves, liquidity providers can end up with less than if they had just held both tokens.');
    expect(full).not.toHaveTextContent(/\bbots?\b|arbitrage|most trades|mostly/i);
  });

  it('a gate banner stands above the actions', async () => {
    render(<MemoryRouter initialEntries={['/pools']}><LpInner readers={readers()} writes={unreadGate()} /></MemoryRouter>);
    await screen.findByTestId('lp-gate-banner');
    expect(parts()).toEqual(['lp-earn-line', 'lp-gate-banner', 'lp-finder', 'lp-positions', 'fee-tiers', 'lp-routes', 'lp-disclosure']);
  });
});

// Owner, 2026-10-09: "update the front end so people actually know how they are earning and
// explain how we make money too, no need to be too wordy but be transparent". Owner,
// 2026-10-14: "drop the duplicate fee cards". One card: the numbers in a row per kind of pool,
// every sentence the four old cards carried one press away.
describe('the rates: what a trade pays, what stays in the pool, what the venue takes', () => {
  const VAULT = 'GRMtSxgseKdesExU1BQ22abEspTXV55UPcLaHCd18osd';
  const OTHER = 'Fu7mNAv67sRbKynEp7gpPLaaEGHcE2R5Sq89AMTEtTb6';
  const cells = (r: HTMLElement) => [...r.querySelectorAll('td')].map((td) => td.textContent);
  const card = async () => {
    await waitFor(() => expect(screen.getAllByTestId('fee-tier')).toHaveLength(2));
    return screen.getByTestId('fee-tiers');
  };

  it('on the tiers mainnet holds: the numbers in plain sight, every sentence and the wallet one press away', async () => {
    const r = readers({ feeTiers: vi.fn(async () => recordedFeeTiers()) });
    mount(r, '/pools');
    const rates = await card();
    expect(within(rates).getByRole('heading', { level: 2 })).toHaveTextContent('Rates');
    expect(within(rates).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Pool', 'Trade fee', 'To the pool', 'To the venue']);
    const pub = within(rates).getAllByTestId('fee-tier')[0]!;
    expect(within(pub).getByRole('rowheader')).toHaveTextContent('Public pools');
    expect(cells(pub)).toEqual(['1%', '0.84%', '0.16%']);
    expect(pub.closest('details')).toBeNull();
    const open = within(rates).getByTestId('lp-open-cost');
    expect(open.textContent).toMatch(/^Open a pool: 0\.15 SOL \+ [\d.]+ SOL setup, not refunded\.$/);
    expect(open.closest('details')).toBeNull();
    // What How you earn and How the venue earns said, word for word, one press away.
    const sentence = within(rates).getByText('In a public pool, each trade pays 1%: 0.84% stays with LPs, 0.16% goes to the venue.');
    expect(sentence.closest('details')).not.toBeNull();
    expect(rates).toHaveTextContent('Each trade in a public pool pays a 1% fee. 0.84% of the trade stays in the pool, and your part is added to your position automatically.');
    expect(rates).toHaveTextContent('Nothing to claim: you receive it when you remove liquidity.');
    expect(rates).toHaveTextContent('Few trades means small fees.');
    const sources = within(rates).getByTestId('lp-venue-sources');
    expect(within(sources).getAllByRole('listitem').slice(0, 2).map((li) => li.textContent)).toEqual(['0.16% of each trade in a public pool.', '0.15 SOL when a public pool is opened.']);
    expect(within(sources).getAllByRole('listitem')[2]).toHaveTextContent(/a swap sent through Jupiter/);
    expect(rates).toHaveTextContent(/the team’s shared wallet, which needs two signatures and can change the pool rates\./);
    // The cut goes to the shared vault, so its wallet is one press away: short, the whole address a press further.
    expect(within(rates).queryByTestId('lp-venue-elsewhere')).toBeNull();
    const wallet = within(rates).getByRole('group', { name: 'Team’s shared wallet' });
    expect(wallet.closest('details')).not.toBeNull();
    expect(wallet).toHaveTextContent('GRMt…8osd');
    expect(wallet).not.toHaveTextContent(VAULT);
    fireEvent.click(within(wallet).getByRole('button', { name: /Show full address/ }));
    expect(within(rates).getByRole('group', { name: 'Team’s shared wallet' })).toHaveTextContent(VAULT);
    // One read of the tiers feeds every number on the card.
    expect(r.feeTiers).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('lp-no-rate')).toBeNull();
  });

  it('each number is the tier’s as read: another tier 1, other numbers and other sentences', async () => {
    const other = recordedFeeTiers();
    if (other.kind !== 'ok') throw new Error('the recording did not read');
    other.tiers[1] = { ...other.tiers[1]!, config: { ...other.tiers[1]!.config!, tradeFeeRate: 2_500n, protocolFeeRate: 200_000n, createPoolFee: 2_000_000_000n } };
    mount(readers({ feeTiers: vi.fn(async () => other) }), '/pools');
    const rates = await card();
    expect(cells(within(rates).getAllByTestId('fee-tier')[0]!)).toEqual(['0.25%', '0.2%', '0.05%']);
    expect(within(rates).getByTestId('lp-open-cost').textContent).toMatch(/^Open a pool: 2(\.0+)? SOL \+/);
    expect(rates).toHaveTextContent('Each trade in a public pool pays a 0.25% fee. 0.2% of the trade stays in the pool');
    expect(rates).toHaveTextContent('0.05% of each trade in a public pool.');
    expect(rates).toHaveTextContent('2 SOL when a public pool is opened.');
    expect(rates).not.toHaveTextContent(/0\.84%|0\.16%|\b1% fee|0\.15 SOL/);
  });

  // Venue money going anywhere but the shared vault is said in plain sight, in bold (owner, 2026-10-10).
  it('a tier that sends the venue’s cut to another wallet says so in plain sight, in bold, with the wallet', async () => {
    const other = recordedFeeTiers();
    if (other.kind !== 'ok') throw new Error('the recording did not read');
    other.tiers[1] = { ...other.tiers[1]!, config: { ...other.tiers[1]!.config!, protocolOwner: OTHER } };
    mount(readers({ feeTiers: vi.fn(async () => other) }), '/pools');
    const rates = await card();
    const flag = within(rates).getByTestId('lp-venue-elsewhere');
    expect(flag.closest('details')).toBeNull();
    expect(flag.querySelector('strong')).toHaveTextContent(/^The cut of each trade goes to the wallet this fee tier names\./);
    expect(within(flag).getByRole('group', { name: 'Wallet this fee tier names' })).toBeInTheDocument();
  });

  it('still reading, a read that failed, tiers that are not there: each said, and none prints a pool rate or a wallet', async () => {
    const states: [LpReaders['feeTiers'] | null, string | null][] = [
      [vi.fn(() => new Promise<never>(() => {})), 'Reading the rates from the chain…'],
      [vi.fn(async () => ({ kind: 'unread' as const, detail: 'the chain did not answer in 20 seconds' })), 'The rates could not be read (the chain did not answer in 20 seconds), so none is shown.'],
      // The default readers: both tiers answered, and neither exists. The rows say so.
      [null, null],
    ];
    for (const [feeTiers, said] of states) {
      const view = mount(readers(feeTiers ? { feeTiers } : {}), '/pools');
      const rates = screen.getByTestId('fee-tiers');
      if (said) await waitFor(() => expect(screen.getByTestId('lp-no-rate').textContent).toBe(said));
      else await waitFor(() => expect(within(rates).getAllByText('not created yet')).toHaveLength(2));
      expect(rates.textContent).not.toMatch(/\d\s*%|\d\s*SOL\b/);
      expect(rates).toHaveTextContent('Each trade in a pool pays a fee. Part of it stays in the pool, and your part is added to your position automatically.');
      expect(within(within(rates).getByTestId('lp-venue-sources')).getAllByRole('listitem').slice(0, 2).map((li) => li.textContent)).toEqual(['A cut of each trade in its pools.', 'A fee when a public pool is opened.']);
      expect(within(rates).queryByRole('group', { name: /wallet/i })).toBeNull();
      expect(rates).not.toHaveTextContent(/shared wallet/);
      view.unmount();
    }
  });

  it('neither the rates nor the routes forecast a return', async () => {
    mount(readers({ feeTiers: vi.fn(async () => recordedFeeTiers()) }), '/pools');
    const rates = await card();
    for (const c of [rates, screen.getByTestId('lp-routes')]) {
      expect(c.textContent).not.toMatch(FORECAST_WORDS);
      expect(c.textContent).not.toContain('—');
    }
  });
});

// Where a swap goes, on both tabs, as two rules a glance can read. The swap sends each trade
// where it pays the trader more, a tie going to our pool; the sentence is in the small print.
describe('swap routes', () => {
  it('two rules, the swap one press away, the venue fee said, the full sentence in the small print', () => {
    mount(readers(), '/solana-lp');
    const routes = screen.getByTestId('lp-routes');
    expect(within(routes).getByRole('heading', { level: 2 })).toHaveTextContent('Swap routes');
    const rules = within(within(routes).getByTestId('lp-route-rules')).getAllByRole('listitem').map((li) => li.textContent);
    expect(rules).toEqual(['Our poolswhen they pay you at least as much', 'Jupiterwhen it pays you more']);
    expect(within(routes).getByRole('link', { name: 'Swap' })).toHaveAttribute('href', '/solana');
    expect(within(routes).getByTestId('lp-route-fee').textContent).toMatch(/^Venue fee through Jupiter: (none|\d+(\.\d+)?%)$/);
    const sentence = within(routes).getByText(/to\s+our pool when ours pays at least as much as Jupiter, and through Jupiter\s+when it does not\./);
    expect(sentence.closest('details')).not.toBeNull();
    for (const bad of [/takes (whichever|the one)/i, /whichever is better/i, /still goes through\s+Jupiter/i]) expect(routes.textContent).not.toMatch(bad);
  });
});

describe('the section’s one sentence about what it shows', () => {
  it("mode 'on': earnings are measured from the chain and never a forecast; it no longer says nothing has been measured", async () => {
    render(
      <MemoryRouter initialEntries={['/pools']}>
        <LpInner readers={readers()} writes={{ mode: 'on', load: vi.fn(async () => fakeLpApi()), gateRpc: unusedGateRpc }} />
      </MemoryRouter>,
    );
    const d = screen.getByTestId('lp-disclosure');
    expect(d).toHaveTextContent('What this page says a pool or a position earned is measured from the chain, and is never a forecast.');
    expect(d).not.toHaveTextContent(/no yield|none has been measured/i);
  });
});

// SPEC_S2_CREATE N20 (K4): opening a pool checks its price against Jupiter's, so with LP's
// mode 'on' a readable token is priced even when it has no pool yet. In mode 'off' nothing
// changes: no pool, no Jupiter call.
describe('the outside price for a token with no pool', () => {
  it("mode 'on': asked once; mode 'off': not asked", async () => {
    const on = readers({ findPools: vi.fn(async () => search([])) });
    const api = fakeLpApi();
    const view1 = render(
      <MemoryRouter initialEntries={[`/pools?mint=${M}`]}>
        <LpInner readers={on} writes={{ mode: 'on', load: vi.fn(async () => api), gateRpc: unusedGateRpc }} />
      </MemoryRouter>,
    );
    await screen.findByTestId('lp-no-pools');
    await waitFor(() => expect(on.outsidePrice).toHaveBeenCalledTimes(1));
    expect(on.outsidePrice).toHaveBeenCalledWith(M, 6);
    view1.unmount();

    const off = readers({ findPools: vi.fn(async () => search([])) });
    mount(off);
    await screen.findByTestId('lp-no-pools');
    expect(off.outsidePrice).not.toHaveBeenCalled();
  });
});

// Owner, 2026-10-17: the explorer links "aren't showing the right addresses and are not
// labelled properly and are carrying you to the wrong part of it". Each said "Explorer" and
// opened Solscan's account page: a mint by way of a redirect, and the pool on its own record
// account, whose "Total Value" there is its rent (about $0.40), not the coins in it. Now each
// link says what it opens, a mint opens its token page, and the two vaults that hold the
// pool's coins are rows of their own.
describe('the pool card’s explorer links', () => {
  // The same pool with its coins in the other order: the vault called SOL's must follow the mint, not the slot.
  const mirrored = (v: PoolView): PoolView => {
    const p = v.snapshot.pool;
    return { ...v, quoteIsToken0: !v.quoteIsToken0, snapshot: { ...v.snapshot, pool: { ...p, token0Mint: p.token1Mint, token1Mint: p.token0Mint, token0Vault: p.token1Vault, token1Vault: p.token0Vault } } };
  };

  for (const order of ['as built', 'in the other order'] as const) {
    it(`each says what it opens, and opens it (its coins ${order})`, async () => {
      const built = view();
      const v = order === 'as built' ? built : mirrored(built);
      const p = v.snapshot.pool;
      const solVault = p.token0Mint === SOL_QUOTE.mint ? p.token0Vault : p.token1Vault;
      const tokenVault = p.token0Mint === M ? p.token0Vault : p.token1Vault;
      expect(solVault).not.toBe(tokenVault);
      render(
        <MemoryRouter initialEntries={[`/pools?mint=${M}`]}>
          <LpInner readers={readers({ findPools: vi.fn(async () => search([v])) })} writes={{ mode: 'on', load: vi.fn(async () => fakeLpApi()), gateRpc: unusedGateRpc }} />
        </MemoryRouter>,
      );
      const card = await screen.findByTestId('lp-pool');
      const link = (group: string) => within(within(card).getByRole('group', { name: group })).getByRole('link');
      await waitFor(() => expect(link('Pool address')).toBeInTheDocument());
      const expected: Array<[string, string, string]> = [
        ['Pool address', 'Transactions', `account/${v.address}`],
        ['Holds its SOL', 'Balance', `account/${solVault}`],
        ['Holds its tokens', 'Balance', `account/${tokenVault}`],
        ['Token', 'Token', `token/${M}`],
        ['Opened by', 'Wallet', `account/${p.poolCreator}`],
      ];
      for (const [group, shows, path] of expected) {
        // The fake write code is on a local validator, whose explorer is the Solana Explorer.
        expect(link(group), group).toHaveAccessibleName(`${shows} on the Solana Explorer (opens in a new tab)`);
        expect(link(group), group).toHaveTextContent(`${shows} on the Solana Explorer ↗`);
        expect(link(group).getAttribute('href'), group).toBe(`https://explorer.test/${path}`);
      }
      const more = within(card).getByTestId('lp-pool-more');
      for (const [group] of expected) expect(more).toContainElement(within(card).getByRole('group', { name: group }));
      // A vault holds the venue's and any creator's fees until they are collected, so its balance is a little above "In the pool".
      expect(more).toHaveTextContent('Each also holds fees not collected yet.');
      expect(within(card).queryByText('Explorer', { exact: true })).toBeNull();
    });
  }
});

