import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PublicKey } from '@solana/web3.js';
import { LpInner } from './SolanaLpSection';
import type { LpReaders } from './readers';
import type { TokenSafety } from '../../../lib/solana/lp/tokenSafety';
import type { PoolSearchRead, PoolView } from '../../../lib/solana/lp/poolFinder';
import { POOL_STATUS_DISABLE_WITHDRAW, decodeAmmConfig, decodePoolState } from '../../../lib/solana/cpswap/program';
import type { Position } from '../../../lib/solana/lp/positions';
import { Row } from '../curve/ui';
import { buildPool, key } from '../../../lib/solana/lp/testkit.fixture';
import { fakeLpApi, unusedGateRpc } from './fakeLpWriteApi.fixture';

const wallet = vi.hoisted(() => ({ publicKey: null as null | { toBase58(): string } }));
// useConnection is only reached with LP's mode 'on' (the last describe below).
vi.mock('@solana/wallet-adapter-react', () => ({ useWallet: () => wallet, useConnection: () => ({ connection: { rpcEndpoint: 'fake' } }) }));
vi.mock('../SolanaConnectButton', () => ({ SolanaConnectButton: () => <button type="button">Connect Solana Wallet</button> }));

const MINT = key();
const M = MINT.toBase58();

function view(o: { address?: PublicKey; configIndex?: number; sol?: bigint; tok?: bigint; openTime?: bigint; origin?: PoolView['origin']; status?: number; frozen?: boolean; noConfig?: boolean } = {}): PoolView {
  const b = buildPool({ plain: true, mint: MINT, address: o.address, configIndex: o.configIndex ?? 1, solReserve: o.sol ?? 10n * 10n ** 9n, tokenReserve: o.tok ?? 1_000n * 10n ** 6n, openTime: o.openTime ?? 1n, status: o.status });
  const pool = decodePoolState(b.address.toBase58(), b.accounts[b.address.toBase58()]!.data)!;
  const config = decodeAmmConfig(b.config.toBase58(), b.accounts[b.config.toBase58()]!.data);
  const solIsToken0 = pool.token0Mint.startsWith('So111');
  const s = o.sol ?? 10n * 10n ** 9n;
  const t = o.tok ?? 1_000n * 10n ** 6n;
  return {
    address: b.address.toBase58(),
    origin: o.origin ?? 'other',
    snapshot: { pool, vault0Amount: solIsToken0 ? s : t, vault1Amount: solIsToken0 ? t : s, reserve0: solIsToken0 ? s : t, reserve1: solIsToken0 ? t : s },
    config: o.noConfig ? null : config,
    tokenMint: M,
    solIsToken0,
    solReserve: s,
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
      known: { launchPool: key().toBase58(), standard: [{ index: 1, config: key().toBase58(), address: key().toBase58() }, { index: 0, config: key().toBase58(), address: key().toBase58() }] },
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
    expect(d).toHaveTextContent(/switch off deposits, withdrawals or swaps on any pool/);
    expect(d).toHaveTextContent(/only reads/);
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
    expect(screen.getByTestId('lp-status')).toHaveTextContent(/blocked on this site/);
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
    expect(none).not.toHaveTextContent('No TOKEN/SOL pools found for this token.');
    expect(none).toHaveTextContent(/may be more/);
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
    const tier = await screen.findByTestId('fee-tier');
    expect(tier).toHaveTextContent('No fee, plus about 0.041 SOL of account deposits that are never refunded');
    expect(tier).not.toHaveTextContent(/\bfree\b/);
  });

  it('reads the fee tiers from the chain and says when tier 1 does not exist yet', async () => {
    mount(readers(), '/pools');
    await waitFor(() => expect(screen.getAllByTestId('fee-tier')).toHaveLength(2));
    expect(screen.getAllByTestId('fee-tier')[1]).toHaveAttribute('data-state', 'absent');
    expect(screen.getAllByText('not created yet')).toHaveLength(2);
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
    expect(within(row).getByText('25.0000%')).toBeInTheDocument();
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
    expect(rows[0]).toHaveTextContent(/Neither side of this pool is SOL/);
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
    expect(row).not.toHaveTextContent(/Worth if withdrawn now/);
    expect(row).not.toHaveTextContent(/could not be worked out/);
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
