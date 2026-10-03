// What keeps a person from opening a SECOND pool by accident, or adding twice, with a
// panel that is already open (B review: funds-1, person-1, parity-1 and funds-2).
//
// - An open "Open a pool" panel obeys the card: Review is off whenever the card does not
//   say `offer` (pools unread, a held opening…), and while the search is being read
//   again. After its own confirmed opening its boxes are emptied.
// - A pool that already exists is NOT one of those stops (owner ruling 2026-10-03: a
//   token may have as many pools as people open). The panel says so next to Review, in
//   words, and a second opening takes typing the amounts again and a new Review.
// - The liquidity notes hold in THIS tab at once (sent, unknown), not only after a reload,
//   on every token, and the "may still be landing" card shows them.
//
// The write layer is a fake; nothing touches a chain.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor, within, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PublicKey } from '@solana/web3.js';
import { LpInner } from './SolanaLpSection';
import type { LpReaders } from './readers';
import type { TokenSafety } from '../../../lib/solana/lp/tokenSafety';
import { SOL_QUOTE } from '../../../lib/solana/lp/quotes';
import type { PoolSearchRead, PoolView } from '../../../lib/solana/lp/poolFinder';
import { decodeAmmConfig, decodePoolState } from '../../../lib/solana/cpswap/program';
import type { WalletFacts } from '../../../lib/solana/lp/walletFacts';
import { buildPool, key } from '../../../lib/solana/lp/testkit.fixture';
import { LP_PENDING_SCOPE, readPendingTrades } from '../curve/pendingTrade';
import { prepared } from '../curve/fakeWriteApi.fixture';
import type { LpWriteApi, Prepared, SubmitDeps, TxOutcome } from '../curve/ports';
import { TIER1_ADDRESS, fakeLpApi, lpCreateSummary, lpDepositSummary, LP_PROGRAM, readyFacts, unusedGateRpc } from './fakeLpWriteApi.fixture';

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
const MINT_B = key();
const MB = MINT_B.toBase58();
const SIG = '6'.repeat(88);
const STANDARD = key();

/** A passing pool for MINT on fee tier 1, at `address`. */
function tier1View(address: PublicKey): PoolView {
  const s = 10n * 10n ** 9n;
  const t = 1_000n * 10n ** 6n;
  const b = buildPool({ plain: true, mint: MINT, address, configIndex: 1, quoteReserve: s, tokenReserve: t, openTime: 1n });
  const raw = decodePoolState(b.address.toBase58(), b.accounts[b.address.toBase58()]!.data)!;
  const pool = { ...raw, ammConfig: TIER1_ADDRESS.toBase58() };
  const config = { ...decodeAmmConfig(b.config.toBase58(), b.accounts[b.config.toBase58()]!.data)!, index: 1 };
  const quoteIsToken0 = pool.token0Mint.startsWith('So111');
  return {
    address: b.address.toBase58(),
    origin: 'standard',
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

const tokenFor = (m: string): TokenSafety => ({
  kind: 'read', mint: m, verdict: 'ok', blocks: [], warnings: [], name: 'Corn', symbol: 'CORN', metadataSource: 'metaplex',
  facts: { program: 'spl-token', mintAuthority: null, freezeAuthority: null, supply: 1n, decimals: 6, isInitialized: true, extensions: [], metadataPointer: null, tokenMetadata: null },
});

function search(mint: string, views: PoolView[], standardState: 'absent' | 'pool'): PoolSearchRead {
  return {
    kind: 'ok',
    search: {
      mint,
      known: { launchPool: key().toBase58(), standard: [{ index: 1, config: TIER1_ADDRESS.toBase58(), address: STANDARD.toBase58(), quote: SOL_QUOTE.mint }] },
      index: { kind: 'ok', pools: views.map((v) => v.address), truncated: false },
      pools: views.map((v) => ({ kind: 'pool' as const, view: v })),
      otherPairs: 0,
      knownState: { [STANDARD.toBase58()]: standardState },
      chainNow: 1_000n,
    },
  };
}

const facts = (): WalletFacts => ({
  kind: 'ok',
  lamports: 5n * 10n ** 9n,
  token: { address: key().toBase58(), amount: 500n * 10n ** 6n },
  wsol: { exists: false, amount: 0n },
  lpAccountExists: false,
  rents: { walletFloor: 890_880n, tokenAccount165: 2_039_280n, neverRefunded: 40_000_000n },
});

function readers(o: Partial<LpReaders> = {}): LpReaders {
  return {
    programId: LP_PROGRAM,
    safety: vi.fn(async (mints: string[]) => new Map(mints.map((m) => [m, tokenFor(m)]))) as unknown as LpReaders['safety'],
    findPools: vi.fn(async (m: PublicKey) => search(m.toBase58(), [], 'absent')) as unknown as LpReaders['findPools'],
    outsidePrice: vi.fn(async () => ({ kind: 'ok' as const, solPerToken: 0.01, source: 'Jupiter' as const })),
    positions: vi.fn(async () => ({ kind: 'ok' as const, positions: [], chainNow: 1n, totalShares: 0 })),
    feeTiers: vi.fn(async () => ({ kind: 'ok' as const, openingDeposits: null, tiers: [] })),
    wallet: vi.fn(async () => facts()),
    placeShareOnChain: vi.fn(async () => ({ kind: 'not-found' as const })),
    ...o,
  };
}

function mount(r: LpReaders, over: Partial<LpWriteApi> = {}) {
  const api = fakeLpApi({ readCreateFacts: vi.fn(async () => readyFacts()), ...over });
  render(
    <MemoryRouter initialEntries={[`/pools?mint=${M}`]}>
      <LpInner readers={r} writes={{ mode: 'on', load: vi.fn(async () => api), gateRpc: unusedGateRpc }} />
    </MemoryRouter>,
  );
  return api;
}

async function openPanel() {
  const card = await screen.findByTestId('lp-create');
  await waitFor(() => expect(card).toHaveAttribute('data-create', 'offer'));
  fireEvent.click(await within(card).findByRole('button', { name: 'Open a pool' }));
  const panel = await screen.findByTestId('lp-create-panel');
  await within(panel).findByRole('button', { name: 'Max SOL' });
  return panel;
}
const sol = (p: HTMLElement) => within(p).getByLabelText('SOL to put in');
const tokens = (p: HTMLElement) => within(p).getByLabelText('Tokens to put in');
const reviewButton = (p: HTMLElement) => within(p).getByRole('button', { name: 'Review: open the pool' });
const matchButton = (p: HTMLElement) => within(p).getByTestId('lp-create-match');
const createCard = () => screen.getByTestId('lp-create');

/** Type 1 SOL, match the market, review and sign; returns once the outcome is on screen. */
async function signOpening(panel: HTMLElement): Promise<HTMLElement> {
  fireEvent.change(sol(panel), { target: { value: '1' } });
  fireEvent.click(matchButton(panel));
  await act(async () => fireEvent.click(reviewButton(panel)));
  await act(async () => fireEvent.click(await within(panel).findByRole('button', { name: 'Sign in wallet' })));
  return within(panel).findByTestId('tx-outcome');
}

const sends = (o: () => Promise<TxOutcome> | TxOutcome) =>
  vi.fn(async (_r: unknown, _s: unknown, _p: unknown, deps?: SubmitDeps): Promise<TxOutcome> => {
    deps?.onSent?.(SIG, 1234);
    return o();
  });

beforeEach(() => {
  sessionStorage.clear();
  wallet.publicKey = OWNER;
  wallet.signTransaction = async (t) => t;
});

describe('an open panel obeys the card', () => {
  it("after its own confirmed opening and the outcome's Close: the boxes are empty, the panel says a second pool is separate, and nothing opens without typing again", async () => {
    const prepareLpCreate = vi.fn(async (): Promise<Prepared> => ({ ok: true, prepared: prepared(lpCreateSummary(STANDARD, MINT)) }));
    const r = readers();
    mount(r, { prepareLpCreate, submitPrepared: sends(() => ({ status: 'confirmed', signature: SIG, slot: 7 })) });
    const panel = await openPanel();
    expect(await signOpening(panel)).toHaveAttribute('data-status', 'confirmed');
    // The chain now lists the new pool at the standard address.
    (r.findPools as ReturnType<typeof vi.fn>).mockImplementation(async (m: PublicKey) => search(m.toBase58(), [tier1View(STANDARD)], 'pool'));
    await act(async () => fireEvent.click(within(within(panel).getByTestId('tx-outcome')).getByRole('button', { name: 'Close' })));
    await waitFor(() => expect(createCard()).toHaveAttribute('data-advice', 'opened-here'));
    expect(createCard()).toHaveAttribute('data-create', 'offer');
    const still = screen.getByTestId('lp-create-panel');
    // The accident guard: the amounts are gone, so a stray press of Review opens nothing.
    expect(sol(still)).toHaveValue('');
    expect(tokens(still)).toHaveValue('');
    expect(reviewButton(still)).toBeDisabled();
    fireEvent.click(reviewButton(still));
    expect(prepareLpCreate).toHaveBeenCalledTimes(1);
    expect(within(still).getByTestId('lp-create-advice')).toHaveTextContent(
      'You opened a pool for this token just now. Opening again makes a second, separate pool and pays the fee to open again.',
    );
    expect(still).not.toHaveTextContent('Review is off here');
    // A second pool is the opener's choice: with the amounts typed again, Review builds
    // one at an address of its own (the standard address now holds the first).
    fireEvent.change(sol(still), { target: { value: '1' } });
    fireEvent.click(matchButton(still));
    await waitFor(() => expect(reviewButton(still)).toBeEnabled());
    await act(async () => fireEvent.click(reviewButton(still)));
    expect(prepareLpCreate).toHaveBeenCalledTimes(2);
    expect(prepareLpCreate).toHaveBeenLastCalledWith(
      expect.anything(), expect.anything(), expect.anything(),
      expect.objectContaining({ shown: expect.objectContaining({ standard: 'taken' }) }),
    );
  });

  it('a stranger opens a passing tier-1 pool first: after Start over the panel points to it, and Review stays on', async () => {
    const prepareLpCreate = vi.fn(async (): Promise<Prepared> => ({ ok: true, prepared: prepared(lpCreateSummary(STANDARD, MINT)) }));
    const r = readers();
    mount(r, {
      prepareLpCreate,
      submitPrepared: vi.fn(async (): Promise<TxOutcome> => ({ status: 'not-sent', stage: 'simulate', message: 'Someone opened a pool at this address first.' })),
    });
    const panel = await openPanel();
    expect(await signOpening(panel)).toHaveAttribute('data-status', 'not-sent');
    // The stranger's pool (this tab did not open it), at the market price.
    const theirs = tier1View(key());
    (r.findPools as ReturnType<typeof vi.fn>).mockImplementation(async (m: PublicKey) => search(m.toBase58(), [theirs], 'pool'));
    await act(async () => fireEvent.click(within(within(panel).getByTestId('tx-outcome')).getByRole('button', { name: 'Start over' })));
    await waitFor(() => expect(createCard()).toHaveAttribute('data-advice', 'exists'));
    expect(createCard()).toHaveAttribute('data-create', 'offer');
    expect(within(createCard()).getByTestId('lp-create-refer')).toHaveTextContent(`The biggest is ${theirs.address}, holding 10 SOL.`);
    const still = screen.getByTestId('lp-create-panel');
    // The boxes are kept (nothing was opened). The panel says a pool is already there,
    // next to Review, and Review stays on: opening a separate pool is the opener's choice.
    expect(sol(still)).toHaveValue('1');
    expect(within(still).getByTestId('lp-create-advice')).toHaveTextContent(
      'This token already has a pool that passes the checks (the card above names it). Opening here makes a separate pool: it does not share that pool’s liquidity or fees.',
    );
    expect(still).not.toHaveTextContent('Review is off here');
    await waitFor(() => expect(reviewButton(still)).toBeEnabled());
    expect(prepareLpCreate).toHaveBeenCalledTimes(1);
  });

  it("while the token and its pools are read again, Review waits for the new answer", async () => {
    const r = readers();
    mount(r);
    const panel = await openPanel();
    fireEvent.change(sol(panel), { target: { value: '1' } });
    fireEvent.click(matchButton(panel));
    expect(reviewButton(panel)).toBeEnabled();
    let release!: (s: PoolSearchRead) => void;
    (r.findPools as ReturnType<typeof vi.fn>).mockImplementationOnce(() => new Promise<PoolSearchRead>((res) => (release = res)));
    // The finder's own Read again (the first one in the section).
    fireEvent.click(within(screen.getByTestId('lp-finder')).getAllByRole('button', { name: 'Read again' })[0]!);
    await screen.findByText('Reading the token and its pools again…');
    expect(reviewButton(panel)).toBeDisabled();
    await act(async () => release(search(M, [], 'absent')));
    await waitFor(() => expect(reviewButton(panel)).toBeEnabled());
  });
});

describe('the liquidity notes hold in this tab, not only after a reload', () => {
  it('an unknown opening, then "I checked my wallet: start over" in the panel: still held here and on another token, and the card at the top shows it', async () => {
    const prepareLpCreate = vi.fn(async (): Promise<Prepared> => ({ ok: true, prepared: prepared(lpCreateSummary(key(), MINT, { origin: 'other' })) }));
    const r = readers();
    mount(r, {
      prepareLpCreate,
      submitPrepared: sends(() => ({ status: 'unknown', signature: SIG, message: 'Could not read the status.' })),
      recheckOutcome: vi.fn(async () => ({ status: 'unknown' as const, signature: SIG, message: 'still unread' })),
    });
    const panel = await openPanel();
    expect(await signOpening(panel)).toHaveAttribute('data-status', 'unknown');
    expect(readPendingTrades(LP_PENDING_SCOPE)).toMatchObject([{ kind: 'lp-create', signature: SIG }]);
    expect(await screen.findByTestId('lp-pending')).toHaveTextContent(SIG);
    await act(async () => fireEvent.click(within(panel).getByRole('button', { name: 'I checked my wallet: start over' })));
    await waitFor(() => expect(createCard()).toHaveAttribute('data-create', 'held'));
    expect(screen.getByTestId('lp-pending')).toBeInTheDocument();
    const still = screen.getByTestId('lp-create-panel');
    expect(still).toHaveTextContent('A pool you opened is not confirmed yet');
    expect(reviewButton(still)).toBeDisabled();

    // Another token, same tab: held there too.
    const finder = screen.getByTestId('lp-finder');
    fireEvent.change(within(finder).getByLabelText('Token mint address'), { target: { value: MB } });
    await act(async () => fireEvent.click(within(finder).getByRole('button', { name: 'Find pools' })));
    await waitFor(() => expect(screen.getByTestId('lp-create')).toHaveAttribute('data-create', 'held'));
    expect(within(screen.getByTestId('lp-create')).queryByRole('button', { name: 'Open a pool' })).toBeNull();
    expect(prepareLpCreate).toHaveBeenCalledTimes(1);
  });

  it('an opening still waiting for its answer holds another token searched in the same tab, and the card at the top names it', async () => {
    const r = readers();
    mount(r, {
      prepareLpCreate: vi.fn(async (): Promise<Prepared> => ({ ok: true, prepared: prepared(lpCreateSummary(key(), MINT, { origin: 'other' })) })),
      submitPrepared: sends(() => new Promise<TxOutcome>(() => {})),
    });
    const panel = await openPanel();
    fireEvent.change(sol(panel), { target: { value: '1' } });
    fireEvent.click(matchButton(panel));
    await act(async () => fireEvent.click(reviewButton(panel)));
    await act(async () => fireEvent.click(await within(panel).findByRole('button', { name: 'Sign in wallet' })));
    await waitFor(() => expect(readPendingTrades(LP_PENDING_SCOPE)).toMatchObject([{ kind: 'lp-create', signature: SIG }]));
    const finder = screen.getByTestId('lp-finder');
    fireEvent.change(within(finder).getByLabelText('Token mint address'), { target: { value: MB } });
    await act(async () => fireEvent.click(within(finder).getByRole('button', { name: 'Find pools' })));
    await waitFor(() => expect(screen.getByTestId('lp-create')).toHaveAttribute('data-create', 'held'));
    expect(screen.queryByTestId('lp-create-panel')).toBeNull();
    expect(screen.getByTestId('lp-pending')).toHaveTextContent(SIG);
  });

  it('an unknown deposit, then "I checked my wallet: start over": Add stays held on that pool in this tab', async () => {
    const pool = tier1View(STANDARD);
    const r = readers({ findPools: vi.fn(async () => search(M, [pool], 'pool')) as unknown as LpReaders['findPools'] });
    mount(r, {
      prepareLpDeposit: vi.fn(async (): Promise<Prepared> => ({ ok: true, prepared: prepared(lpDepositSummary(new PublicKey(pool.address), MINT)) })),
      submitPrepared: sends(() => ({ status: 'unknown', signature: SIG, message: 'Could not read the status.' })),
      recheckOutcome: vi.fn(async () => ({ status: 'unknown' as const, signature: SIG, message: 'still unread' })),
    });
    const card = await screen.findByTestId('lp-pool');
    await waitFor(() => expect(card).toHaveAttribute('data-add', 'offer'));
    fireEvent.click(within(card).getByRole('button', { name: 'Add liquidity' }));
    const panel = await screen.findByTestId('lp-add-panel');
    await within(panel).findByRole('button', { name: 'Max SOL' });
    fireEvent.change(within(panel).getByLabelText('SOL to add'), { target: { value: '0.5' } });
    await act(async () => fireEvent.click(within(panel).getByRole('button', { name: 'Review: add liquidity' })));
    await act(async () => fireEvent.click(await within(panel).findByRole('button', { name: 'Sign in wallet' })));
    expect(await within(panel).findByTestId('tx-outcome')).toHaveAttribute('data-status', 'unknown');
    await act(async () => fireEvent.click(within(panel).getByRole('button', { name: 'I checked my wallet: start over' })));
    await waitFor(() => expect(screen.getByTestId('lp-pool')).toHaveAttribute('data-add', 'held'));
    expect(screen.getByTestId('lp-pending')).toHaveTextContent('adding liquidity');
    expect(within(screen.getByTestId('lp-add-panel')).getByRole('button', { name: 'Review: add liquidity' })).toBeDisabled();
  });
});
