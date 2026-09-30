import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PublicKey } from '@solana/web3.js';
import { LpInner } from './SolanaLpSection';
import type { LpReaders } from './readers';
import type { TokenSafety } from '../../../lib/solana/lp/tokenSafety';
import type { PoolSearchRead, PoolView } from '../../../lib/solana/lp/poolFinder';
import { decodeAmmConfig, decodePoolState } from '../../../lib/solana/cpswap/program';
import { buildPool, key } from '../../../lib/solana/lp/testkit.fixture';

const wallet = vi.hoisted(() => ({ publicKey: null as null | { toBase58(): string } }));
vi.mock('@solana/wallet-adapter-react', () => ({ useWallet: () => wallet }));
vi.mock('../SolanaConnectButton', () => ({ SolanaConnectButton: () => <button type="button">Connect Solana Wallet</button> }));

const MINT = key();
const M = MINT.toBase58();

function view(o: { address?: PublicKey; configIndex?: number; sol?: bigint; tok?: bigint; openTime?: bigint; origin?: PoolView['origin'] } = {}): PoolView {
  const b = buildPool({ plain: true, mint: MINT, address: o.address, configIndex: o.configIndex ?? 1, solReserve: o.sol ?? 10n * 10n ** 9n, tokenReserve: o.tok ?? 1_000n * 10n ** 6n, openTime: o.openTime ?? 1n });
  const pool = decodePoolState(b.address.toBase58(), b.accounts[b.address.toBase58()]!.data)!;
  const config = decodeAmmConfig(b.config.toBase58(), b.accounts[b.config.toBase58()]!.data);
  const solIsToken0 = pool.token0Mint.startsWith('So111');
  const s = o.sol ?? 10n * 10n ** 9n;
  const t = o.tok ?? 1_000n * 10n ** 6n;
  return {
    address: b.address.toBase58(),
    origin: o.origin ?? 'other',
    snapshot: { pool, vault0Amount: solIsToken0 ? s : t, vault1Amount: solIsToken0 ? t : s, reserve0: solIsToken0 ? s : t, reserve1: solIsToken0 ? t : s },
    config,
    tokenMint: M,
    solIsToken0,
    solReserve: s,
    tokenReserve: t,
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
    positions: vi.fn(async () => ({ kind: 'ok' as const, positions: [], chainNow: 1n })),
    feeTiers: vi.fn(async () => ({ kind: 'ok' as const, tiers: [{ index: 0, address: 'a', config: null, state: 'absent' as const }, { index: 1, address: 'b', config: null, state: 'absent' as const }] })),
    ...o,
  };
}

function mount(r: LpReaders, path = `/pools?mint=${M}`) {
  return render(<MemoryRouter initialEntries={[path]}><LpInner readers={r} /></MemoryRouter>);
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
        positions: [{ lpMint: v.snapshot.pool.lpMint, lpAccount: key().toBase58(), lpAmount: 250_000n, placement: 'found' as const, pool: { kind: 'pool' as const, view: v }, value: { token0: 1n, token1: 2n, sharePct: 25 } }],
      })),
    });
    mount(r, '/pools');
    const row = await screen.findByTestId('lp-position');
    expect(row).toHaveAttribute('data-pool', v.address);
    expect(within(row).getByText('25.0000%')).toBeInTheDocument();
    expect(within(row).getByText('no problems found')).toBeInTheDocument();
    expect(r.positions).toHaveBeenCalledWith(owner);
  });

  it('a wallet that could not be read is not a wallet with no positions', async () => {
    wallet.publicKey = key();
    mount(readers({ positions: vi.fn(async () => ({ kind: 'unread' as const, detail: 'HTTP 502' })) }), '/pools');
    expect(await screen.findByText(/That does not mean it holds none/)).toBeInTheDocument();
    expect(screen.queryByTestId('lp-no-positions')).not.toBeInTheDocument();
  });
});
