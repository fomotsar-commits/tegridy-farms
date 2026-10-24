import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PublicKey } from '@solana/web3.js';
import { LpInner } from './SolanaLpSection';
import type { LpReaders } from './readers';
import type { TokenSafety } from '../../../lib/solana/lp/tokenSafety';
import { BAYLA_MINT, USDC_MINT } from '../../../lib/solana/lp/tokenSafety';
import type { PoolListRead } from '../../../lib/solana/lp/poolList';
import type { PoolSearchRead, PoolView } from '../../../lib/solana/lp/poolFinder';
import { buildPool, key, viewOf } from '../../../lib/solana/lp/testkit.fixture';

const wallet = vi.hoisted(() => ({ publicKey: null as null | { toBase58(): string } }));
vi.mock('@solana/wallet-adapter-react', () => ({ useWallet: () => wallet, useConnection: () => ({ connection: { rpcEndpoint: 'fake' } }) }));
vi.mock('../SolanaConnectButton', () => ({ SolanaConnectButton: () => <button type="button">Connect Solana Wallet</button> }));

const CORN = key();
const C = CORN.toBase58();
const BAYLA = new PublicKey(BAYLA_MINT);

function view(mint: PublicKey, sol = 10n * 10n ** 9n, tok = 1_000n * 10n ** 6n): PoolView {
  return viewOf(buildPool({ plain: true, mint, configIndex: 1, quoteReserve: sol, tokenReserve: tok }), { sol, tok });
}

const okToken = (mint: string): TokenSafety => ({
  kind: 'read', mint, verdict: 'ok', blocks: [], warnings: [], name: 'Corn', symbol: 'CORN', metadataSource: 'metaplex',
  facts: { program: 'spl-token', mintAuthority: null, freezeAuthority: null, supply: 1n, decimals: 6, isInitialized: true, extensions: [], metadataPointer: null, tokenMetadata: null },
});

function search(mint: string, views: PoolView[]): PoolSearchRead {
  return {
    kind: 'ok',
    search: {
      mint,
      known: { launchPool: key().toBase58(), standard: [] },
      index: { kind: 'ok', pools: views.map((v) => v.address), truncated: false },
      pools: views.map((v) => ({ kind: 'pool' as const, view: v })),
      otherPairs: 0,
      knownState: {},
      chainNow: 1_000n,
    },
  };
}

const ok = (pools: PoolView[], o: { unread?: number; truncated?: boolean; chainNow?: bigint | null; safety?: TokenSafety[] } = {}): PoolListRead => ({
  kind: 'ok',
  list: { pools, unread: o.unread ?? 0, truncated: o.truncated ?? false, chainNow: o.chainNow ?? null, safety: new Map((o.safety ?? []).map((s) => [s.mint, s])) },
});
/** The check read for `mint`: it calls itself `symbol`. */
const calls = (mint: string, symbol: string): TokenSafety => ({ ...okToken(mint), symbol } as TokenSafety);

function readers(o: Partial<LpReaders> = {}): LpReaders {
  const corn = view(CORN);
  return {
    programId: 'EKS4C6xvV9A5DMWaWtVnFvi7ru78EhqRAoddEMpQ2BtT',
    safety: vi.fn(async (mints: string[]) => new Map(mints.map((m) => [m, okToken(m)]))),
    findPools: vi.fn(async (mint: PublicKey) => search(mint.toBase58(), mint.toBase58() === C ? [corn] : [])),
    listPools: vi.fn(async () => ok([view(BAYLA, 30n * 10n ** 9n), corn])),
    outsidePrice: vi.fn(async () => ({ kind: 'ok' as const, solPerToken: 0.01, source: 'Jupiter' as const })),
    positions: vi.fn(async () => ({ kind: 'ok' as const, positions: [], chainNow: 1n, totalShares: 0 })),
    feeTiers: vi.fn(async () => ({ kind: 'ok' as const, openingDeposits: null, tiers: [] })),
    wallet: vi.fn(async () => { throw new Error('not stubbed'); }),
    placeShareOnChain: vi.fn(async () => { throw new Error('not stubbed'); }),
    ...o,
  };
}

function mount(r: LpReaders) {
  return render(<MemoryRouter initialEntries={['/solana-lp']}><LpInner readers={r} writes={{ mode: 'off' }} /></MemoryRouter>);
}

beforeEach(() => { wallet.publicKey = null; });

describe('All pools: every pool on the venue, before a token is picked', () => {
  it('lists every pool on arrival, with no token picked and no search run', async () => {
    const r = readers();
    mount(r);
    const rows = await screen.findAllByTestId('lp-all-pools-row');
    expect(rows).toHaveLength(2);
    // A listed token by its registry name, and its pool's price and holdings in the pool's coin.
    expect(rows[0]).toHaveTextContent('BAYLA / SOL · 1% tier');
    expect(rows[0]).toHaveTextContent('1 BAYLA = 0.03 SOL');
    expect(rows[0]).toHaveTextContent(/Holds 30 SOL and 1,000 BAYLA/);
    expect(rows[1]).toHaveTextContent('1 token = 0.01 SOL');
    expect(r.findPools).not.toHaveBeenCalled();
  });

  it('a token the site does not list is shown by its whole address too, never by a short one alone', async () => {
    mount(readers());
    const rows = await screen.findAllByTestId('lp-all-pools-row');
    expect(within(rows[1]!).getByText(C)).toBeInTheDocument();
    expect(within(rows[0]!).queryByText(BAYLA_MINT)).toBeNull();
  });

  it('a coin that is not ours shows its own ticker in the heading, the holdings and the price, with its whole address', async () => {
    mount(readers({ listPools: vi.fn(async () => ok([view(CORN)], { safety: [calls(C, 'CRYING')] })) }));
    const [row] = await screen.findAllByTestId('lp-all-pools-row');
    expect(row).toHaveTextContent('CRYING / SOL · 1% tier');
    expect(row).toHaveTextContent(/Holds 10 SOL and 1,000 CRYING/);
    expect(row).toHaveTextContent('1 CRYING = 0.01 SOL');
    expect(within(row!).getByText(C)).toBeInTheDocument();
    expect(within(row!).getByRole('button', { name: 'View CRYING / SOL · 1% tier' })).toBeInTheDocument();
  });

  it('a coin copying one of our tickers reads "fake" everywhere on its row, and never heads a row as the real one', async () => {
    const soy = view(new PublicKey('8zsZESzrGoYVi1dVH4QNWXJ2EfW4v287aEGNiDvQpump'), 20n * 10n ** 9n);
    mount(readers({ listPools: vi.fn(async () => ok([soy, view(CORN)], { safety: [calls(C, 'SOY')] })) }));
    const [real, copy] = await screen.findAllByTestId('lp-all-pools-row');
    expect(real).toHaveTextContent('SOY / SOL · 1% tier');
    expect(copy).toHaveTextContent('fake SOY / SOL · 1% tier');
    expect(copy).toHaveTextContent(/Holds 10 SOL and 1,000 fake SOY/);
    expect(copy).toHaveTextContent('1 fake SOY = 0.01 SOL');
    expect(within(copy!).getByText(C)).toBeInTheDocument();
    expect(screen.getByTestId('lp-all-pools')).toHaveTextContent('one that copies the ticker of one of ours, or of SOL, USDC or USDT, reads “fake”');
  });

  it('a coin whose check was not read is headed by its short address and counted in tokens', async () => {
    mount(readers({ listPools: vi.fn(async () => ok([view(CORN)], { safety: [{ kind: 'unread', mint: C, detail: 'HTTP 429' }] })) }));
    const [row] = await screen.findAllByTestId('lp-all-pools-row');
    expect(row).toHaveTextContent(`${C.slice(0, 4)}…${C.slice(-4)} / SOL · 1% tier`);
    expect(row).toHaveTextContent('1 token = 0.01 SOL');
    expect(within(row!).getByText(C)).toBeInTheDocument();
  });

  it('a pairing coin on the token side (USDC in USDC / SOL) is named as the coin, by its address', async () => {
    mount(readers({ listPools: vi.fn(async () => ok([view(new PublicKey(USDC_MINT), 10n ** 9n, 100n * 10n ** 6n)])) }));
    const [row] = await screen.findAllByTestId('lp-all-pools-row');
    expect(row).toHaveTextContent('USDC / SOL · 1% tier');
    expect(row).toHaveTextContent(/Holds 1 SOL and 100 USDC/);
    expect(row).toHaveTextContent('1 USDC = 0.01 SOL');
    expect(within(row!).queryByText(USDC_MINT)).toBeNull();
  });

  it('View looks the pool’s token up in the finder: the token goes in the box and its pools are read and shown', async () => {
    const r = readers();
    mount(r);
    const rows = await screen.findAllByTestId('lp-all-pools-row');
    fireEvent.click(within(rows[1]!).getByRole('button', { name: /^View / }));
    await screen.findByTestId('lp-pool');
    expect(r.findPools).toHaveBeenCalledTimes(1);
    expect((r.findPools as ReturnType<typeof vi.fn>).mock.calls[0]![0].toBase58()).toBe(C);
    expect(within(screen.getByTestId('lp-finder')).getByDisplayValue(C)).toBeInTheDocument();
  });

  it('a list that could not be read says so, and never says there are no pools', async () => {
    mount(readers({ listPools: vi.fn(async () => ({ kind: 'unread' as const, detail: 'the pool index answered HTTP 502' })) }));
    const list = screen.getByTestId('lp-all-pools');
    await waitFor(() => expect(list).toHaveTextContent('The list of pools could not be read just now. That does not mean there are none'));
    // The reason is one press away, under Why: what the read answered, word for word.
    expect(within(list).getByText('the pool index answered HTTP 502')).toBeInTheDocument();
    expect(screen.queryByTestId('lp-all-pools-none')).toBeNull();
    expect(screen.queryByTestId('lp-all-pools-row')).toBeNull();
  });

  it('a thrown read is unread too', async () => {
    mount(readers({ listPools: vi.fn(async () => { throw new Error('boom'); }) }));
    await waitFor(() => expect(screen.getByTestId('lp-all-pools')).toHaveTextContent('could not be read just now.'));
    expect(within(screen.getByTestId('lp-all-pools')).getByText('boom')).toBeInTheDocument();
    expect(screen.queryByTestId('lp-all-pools-none')).toBeNull();
  });

  it('says "No pools yet" only when the index answered with none and nothing went unread', async () => {
    const { unmount } = mount(readers({ listPools: vi.fn(async () => ok([])) }));
    expect(await screen.findByTestId('lp-all-pools-none')).toHaveTextContent('No pools yet.');
    unmount();
    mount(readers({ listPools: vi.fn(async () => ok([], { unread: 2 })) }));
    await waitFor(() => expect(screen.getByTestId('lp-all-pools')).toHaveTextContent('2 more pools could not be read just now.'));
    expect(screen.queryByTestId('lp-all-pools-none')).toBeNull();
  });

  it('when there are more pools than the list holds, it says so and points to the search', async () => {
    mount(readers({ listPools: vi.fn(async () => ok([view(CORN)], { truncated: true })) }));
    expect(await screen.findByTestId('lp-all-pools-truncated')).toHaveTextContent('There are more pools than this list holds. Search a token above to find the rest.');
  });

  it('sits under the finder and above the positions (both tabs draw the section in one order)', async () => {
    mount(readers());
    const list = screen.getByTestId('lp-all-pools');
    expect(screen.getByTestId('lp-finder').compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(list.compareDocumentPosition(screen.getByTestId('lp-positions')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('each row shows its warning tags from what the list read, and a row with nothing to warn about shows none', async () => {
    const off = viewOf(buildPool({ plain: true, mint: key(), configIndex: 1, quoteReserve: 10n ** 8n, tokenReserve: 10n ** 9n, status: 4 | 1 }), { sol: 10n ** 8n, tok: 10n ** 9n });
    const deep = view(CORN);
    mount(readers({ listPools: vi.fn(async () => ok([deep, off], { chainNow: 1_000n })) }));
    const rows = await screen.findAllByTestId('lp-all-pools-row');
    expect(within(rows[0]!).queryAllByTestId('lp-all-pools-tag')).toHaveLength(0);
    const tags = within(rows[1]!).getAllByTestId('lp-all-pools-tag').map((t) => t.textContent);
    expect(tags).toEqual(['Trading off', 'Adding off', 'Little money in pool']);
    expect(within(rows[1]!).getByRole('list', { name: /: warnings$/ })).toBeInTheDocument();
    // What each tag means, and the threshold, are one press away.
    // Said by the price line every row shows: BAYLA / SOL is priced in SOL and can get the tag.
    expect(screen.getByTestId('lp-all-pools')).toHaveTextContent('Little money in pool: it holds under 1 SOL or 100 USDC (a pool priced in BAYLA never gets this tag).');
    expect(screen.getByTestId('lp-all-pools')).toHaveTextContent('a row with no tag is not a pool that passed');
  });

  it('a reader without listPools shows no list', () => {
    const r = readers();
    delete r.listPools;
    mount(r);
    expect(screen.queryByTestId('lp-all-pools')).toBeNull();
  });
});
