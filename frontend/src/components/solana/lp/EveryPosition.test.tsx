import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PublicKey } from '@solana/web3.js';
import { LpInner } from './SolanaLpSection';
import { HOLDERS_SHOWN } from './EveryPosition';
import type { LpReaders } from './readers';
import type { TokenSafety } from '../../../lib/solana/lp/tokenSafety';
import { BAYLA_MINT } from '../../../lib/solana/lp/tokenSafety';
import type { PoolListRead } from '../../../lib/solana/lp/poolList';
import type { PoolView } from '../../../lib/solana/lp/poolFinder';
import type { HoldersRead } from '../../../lib/solana/lp/holders';
import { buildPool, key, viewOf } from '../../../lib/solana/lp/testkit.fixture';

const wallet = vi.hoisted(() => ({ publicKey: null as null | { toBase58(): string } }));
vi.mock('@solana/wallet-adapter-react', () => ({ useWallet: () => wallet, useConnection: () => ({ connection: { rpcEndpoint: 'fake' } }) }));
vi.mock('../SolanaConnectButton', () => ({ SolanaConnectButton: () => <button type="button">Connect Solana Wallet</button> }));

const CORN = key();

// 10 SOL and 1,000 tokens, 1,000,000 shares out.
function view(mint: PublicKey): PoolView {
  const sol = 10n * 10n ** 9n;
  const tok = 1_000n * 10n ** 6n;
  return viewOf(buildPool({ plain: true, mint, configIndex: 1, quoteReserve: sol, tokenReserve: tok, lpSupply: 1_000_000n }), { sol, tok });
}

const okToken = (mint: string): TokenSafety => ({
  kind: 'read', mint, verdict: 'ok', blocks: [], warnings: [], name: 'Corn', symbol: 'CORN', metadataSource: 'metaplex',
  facts: { program: 'spl-token', mintAuthority: null, freezeAuthority: null, supply: 1n, decimals: 6, isInitialized: true, extensions: [], metadataPointer: null, tokenMetadata: null },
});

const listOf = (pools: PoolView[]): PoolListRead => ({ kind: 'ok', list: { pools, unread: 0, truncated: false, chainNow: null, safety: new Map(pools.map((p) => [p.tokenMint, okToken(p.tokenMint)])) } });

function readers(pools: PoolView[], holders: (v: PoolView) => Promise<HoldersRead>, o: Partial<LpReaders> = {}): LpReaders {
  return {
    programId: 'EKS4C6xvV9A5DMWaWtVnFvi7ru78EhqRAoddEMpQ2BtT',
    safety: vi.fn(async (mints: string[]) => new Map(mints.map((m) => [m, okToken(m)]))),
    findPools: vi.fn(async () => ({ kind: 'unread' as const, detail: 'not stubbed' })),
    listPools: vi.fn(async () => listOf(pools)),
    outsidePrice: vi.fn(async () => ({ kind: 'ok' as const, solPerToken: 0.01, source: 'Jupiter' as const })),
    positions: vi.fn(async () => ({ kind: 'ok' as const, positions: [], chainNow: 1n, totalShares: 0 })),
    feeTiers: vi.fn(async () => ({ kind: 'ok' as const, openingDeposits: null, tiers: [] })),
    wallet: vi.fn(async () => { throw new Error('not stubbed'); }),
    placeShareOnChain: vi.fn(async () => { throw new Error('not stubbed'); }),
    holders: vi.fn(holders),
    ...o,
  };
}

const mount = (r: LpReaders) => render(<MemoryRouter initialEntries={['/solana-lp']}><LpInner readers={r} writes={{ mode: 'off' }} /></MemoryRouter>);

const ME = key().toBase58();
const STRANGER = key().toBase58();
const holder = (owner: string, amount: bigint, pct: number) => ({ owner, amount, tooSmall: false, value: { token0: (10n ** 10n * amount) / 1_000_000n, token1: (10n ** 9n * amount) / 1_000_000n, sharePct: pct } });

beforeEach(() => { wallet.publicKey = null; });

describe('Every position: every holder of every pool, whoever holds it', () => {
  it("lists each pool's holders with their whole address and share, and marks the connected wallet's own", async () => {
    wallet.publicKey = new PublicKey(ME);
    const bayla = view(new PublicKey(BAYLA_MINT));
    const corn = view(CORN);
    mount(
      readers([bayla, corn], async (v) =>
        v.address === bayla.address
          ? { kind: 'ok', holders: [holder(STRANGER, 600_000n, 60), holder(ME, 400_000n, 40)], capped: false }
          : { kind: 'ok', holders: [holder(STRANGER, 1_000_000n, 100)], capped: false },
      ),
    );
    const card = await screen.findByTestId('lp-every-position');
    const pools = await within(card).findAllByTestId('lp-every-position-pool');
    expect(pools).toHaveLength(2);
    const rows = await within(pools[0]!).findAllByTestId('lp-every-position-holder');
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining(STRANGER),
      expect.stringContaining(ME),
    ]);
    expect(rows[0]!.textContent).toContain('60.00% of the pool');
    // Only the connected wallet's row says You.
    expect(rows[1]!.hasAttribute('data-mine')).toBe(true);
    expect(within(rows[1]!).getByText('You')).toBeTruthy();
    expect(rows[0]!.hasAttribute('data-mine')).toBe(false);
    // The other pool is listed too, though the connected wallet holds none of it.
    expect(await within(pools[1]!).findAllByTestId('lp-every-position-holder')).toHaveLength(1);
  });

  it('a pool whose holders could not be read says so, never "nobody"; an empty pool says nobody', async () => {
    const a = view(new PublicKey(BAYLA_MINT));
    const b = view(CORN);
    mount(readers([a, b], async (v) => (v.address === a.address ? { kind: 'unread', detail: '429' } : { kind: 'ok', holders: [], capped: false })));
    const pools = await screen.findAllByTestId('lp-every-position-pool');
    expect(await within(pools[0]!).findByText(/could not be read just now/)).toBeTruthy();
    expect(within(pools[0]!).queryByText(/Nobody holds a share/)).toBeNull();
    expect(await within(pools[1]!).findByText('Nobody holds a share yet.')).toBeTruthy();
  });

  it('says when only the largest holders are listed', async () => {
    const a = view(new PublicKey(BAYLA_MINT));
    mount(readers([a], async () => ({ kind: 'ok', holders: [holder(STRANGER, 10n, 0.001)], capped: true })));
    expect(await screen.findByText('The 20 largest holders. Smaller ones are not listed.')).toBeTruthy();
    expect(await screen.findByText(/Under 0\.01% of the pool/)).toBeTruthy();
  });

  it('shows the largest few per pool and your own row wherever it ranks, with Show all for the rest', async () => {
    wallet.publicKey = new PublicKey(ME);
    const others = Array.from({ length: HOLDERS_SHOWN + 1 }, (_, i) => holder(key().toBase58(), 100_000n - BigInt(i), 10));
    mount(readers([view(new PublicKey(BAYLA_MINT))], async () => ({ kind: 'ok', holders: [...others, holder(ME, 1_000n, 0.1)], capped: true })));
    const pool = await screen.findByTestId('lp-every-position-pool');
    let rows = await within(pool).findAllByTestId('lp-every-position-holder');
    // The five largest, then the connected wallet's own row, ranked last.
    expect(rows).toHaveLength(HOLDERS_SHOWN + 1);
    expect(rows[HOLDERS_SHOWN]!.hasAttribute('data-mine')).toBe(true);
    expect(within(pool).queryByText(/Smaller ones are not listed/)).toBeNull();
    fireEvent.click(within(pool).getByRole('button', { name: `Show all ${others.length + 1} holders` }));
    rows = within(pool).getAllByTestId('lp-every-position-holder');
    expect(rows).toHaveLength(others.length + 1);
    expect(within(pool).getByText('The 20 largest holders. Smaller ones are not listed.')).toBeTruthy();
    fireEvent.click(within(pool).getByRole('button', { name: 'Show fewer' }));
    expect(within(pool).getAllByTestId('lp-every-position-holder')).toHaveLength(HOLDERS_SHOWN + 1);
  });

  it('a list of pools that could not be read says so, and reads no holders', async () => {
    const r = readers([], async () => ({ kind: 'ok', holders: [], capped: false }), { listPools: vi.fn(async () => ({ kind: 'unread' as const, detail: 'index down' })) });
    mount(r);
    expect(await within(await screen.findByTestId('lp-every-position')).findByText(/could not be read just now, so neither could their holders/)).toBeTruthy();
    expect(r.holders).not.toHaveBeenCalled();
  });

  it('a reader without holders draws no card', async () => {
    const r = readers([view(CORN)], async () => ({ kind: 'ok', holders: [], capped: false }));
    delete r.holders;
    mount(r);
    await screen.findAllByTestId('lp-all-pools-row');
    expect(screen.queryByTestId('lp-every-position')).toBeNull();
  });
});
