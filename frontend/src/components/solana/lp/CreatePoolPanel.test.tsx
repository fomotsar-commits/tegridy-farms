// The "Open a pool" panel (SPEC_S2_CREATE K4, 4.3): two boxes that never move each other,
// Match the market price, the live opening price against Jupiter's, the problems line,
// Max from one wallet read, the disclosures, the review and what a confirmed opening
// leaves behind. The write layer is a fake; nothing touches a chain.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor, within, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PublicKey } from '@solana/web3.js';
import { LpInner } from './SolanaLpSection';
import { solAbout } from './panelKit';
import type { LpReaders } from './readers';
import type { TokenSafety } from '../../../lib/solana/lp/tokenSafety';
import { isCreatedPool, type PoolSearchRead, type PoolView } from '../../../lib/solana/lp/poolFinder';
import { decodeAmmConfig, decodePoolState } from '../../../lib/solana/cpswap/program';
import type { WalletFacts } from '../../../lib/solana/lp/walletFacts';
import { buildPool, key } from '../../../lib/solana/lp/testkit.fixture';
import { LP_PENDING_SCOPE, readPendingTrades } from '../curve/pendingTrade';
import { prepared } from '../curve/fakeWriteApi.fixture';
import type { LpWriteApi, Prepared, SubmitDeps, TxOutcome } from '../curve/ports';
import { TIER1_ADDRESS, fakeLpApi, lpCreateSummary, LP_PROGRAM, readyFacts, unusedGateRpc } from './fakeLpWriteApi.fixture';
import { recordedTier } from '../../../lib/solana/cpswap/mainnetVenueReplay.fixture';

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
const SIG = '6'.repeat(88);
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

/** A passing pool on another tier (so Add is offered on it, and an opening is still offered). */
function view(): PoolView {
  const s = 10n * 10n ** 9n;
  const t = 1_000n * 10n ** 6n;
  const b = buildPool({ plain: true, mint: MINT, configIndex: 1, solReserve: s, tokenReserve: t, openTime: 1n });
  const pool = decodePoolState(b.address.toBase58(), b.accounts[b.address.toBase58()]!.data)!;
  const config = { ...decodeAmmConfig(b.config.toBase58(), b.accounts[b.config.toBase58()]!.data)!, index: 0 };
  const solIsToken0 = pool.token0Mint.startsWith('So111');
  return {
    address: b.address.toBase58(),
    origin: 'other',
    snapshot: { pool, vault0Amount: solIsToken0 ? s : t, vault1Amount: solIsToken0 ? t : s, reserve0: solIsToken0 ? s : t, reserve1: solIsToken0 ? t : s },
    config,
    tokenMint: M,
    solIsToken0,
    solReserve: s,
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
  const standard = key().toBase58();
  return {
    kind: 'ok',
    search: {
      mint: M,
      known: { launchPool: key().toBase58(), standard: [{ index: 1, config: TIER1_ADDRESS.toBase58(), address: standard }] },
      index: { kind: 'ok', pools: views.map((v) => v.address), truncated: false },
      pools: views.map((v) => ({ kind: 'pool' as const, view: v })),
      otherPairs: 0,
      knownState: { [standard]: 'absent' },
      chainNow: 1_000n,
    },
  };
}

const facts = (over: Partial<Extract<WalletFacts, { kind: 'ok' }>> = {}): WalletFacts => ({
  kind: 'ok',
  lamports: 5n * 10n ** 9n,
  token: { address: key().toBase58(), amount: 500n * 10n ** 6n },
  wsol: { exists: false, amount: 0n },
  lpAccountExists: false,
  rents: { walletFloor: 890_880n, tokenAccount165: 2_039_280n, neverRefunded: 40_000_000n },
  ...over,
});

function readers(o: Partial<LpReaders> = {}): LpReaders {
  return {
    programId: LP_PROGRAM,
    safety: vi.fn(async () => new Map([[M, okToken]])),
    findPools: vi.fn(async () => search([])),
    // 1 token = 0.01 SOL.
    outsidePrice: vi.fn(async () => ({ kind: 'ok' as const, solPerToken: 0.01, source: 'Jupiter' as const })),
    positions: vi.fn(async () => ({ kind: 'ok' as const, positions: [], chainNow: 1n, totalShares: 0 })),
    feeTiers: vi.fn(async () => ({ kind: 'ok' as const, openingDeposits: null, tiers: [] })),
    wallet: vi.fn(async () => facts()),
    placeShareOnChain: vi.fn(async () => ({ kind: 'not-found' as const })),
    ...o,
  };
}

function mount(r: LpReaders, o: { api?: Partial<LpWriteApi>; path?: string } = {}) {
  const api = fakeLpApi({ readCreateFacts: vi.fn(async () => readyFacts()), ...o.api });
  render(
    <MemoryRouter initialEntries={[o.path ?? `/pools?mint=${M}`]}>
      <LpInner readers={r} writes={{ mode: 'on', load: vi.fn(async () => api), gateRpc: unusedGateRpc }} />
    </MemoryRouter>,
  );
  return { api };
}

async function openPanel() {
  const card = await screen.findByTestId('lp-create');
  const button = await within(card).findByRole('button', { name: 'Open a pool' });
  fireEvent.click(button);
  const panel = await screen.findByTestId('lp-create-panel');
  return { card, button, panel };
}

const sol = (p: HTMLElement) => within(p).getByLabelText('SOL to put in');
const tokens = (p: HTMLElement) => within(p).getByLabelText('Tokens to put in');
const reviewButton = (p: HTMLElement) => within(p).getByRole('button', { name: 'Review: open the pool' });
const matchButton = (p: HTMLElement) => within(p).getByTestId('lp-create-match');

beforeEach(() => {
  sessionStorage.clear();
  wallet.publicKey = OWNER;
  wallet.signTransaction = async (t) => t;
});

describe('the panel', () => {
  it('opens in place: focus on its heading, back to the opener on Close; the disclosures are always there', async () => {
    mount(readers());
    const { button, panel } = await openPanel();
    expect(within(panel).getByRole('heading', { name: 'Open a pool for this token' })).toHaveFocus();
    expect(panel).toHaveAccessibleName('Open a pool for this token');
    const before = within(panel).getByTestId('lp-before-you-open');
    expect(before).toHaveTextContent(/Our pool program is Raydium's, with only its admin keys changed\. Those changes have not had their own independent review yet\./);
    expect(before).toHaveTextContent(/change the public fee tier's rates and its fee to open a pool at once/);
    expect(before).toHaveTextContent(/this site's swap goes through Jupiter, and Jupiter does not send trades to our pools/);
    expect(before).toHaveTextContent(/Expect little or nothing in fees at first\./);
    expect(before).toHaveTextContent('Opening costs 0.15 SOL, paid to the team\'s vault, and about 0.04 SOL in account deposits that never come back.');
    // Shares are said in 9 decimals everywhere on this page: never "100 pool shares".
    expect(before).toHaveTextContent('0.0000001 pool shares (100 of the smallest unit) stay locked in the pool forever');
    expect(before).toHaveTextContent("Anyone can open other pools for this token, at any price. Yours will not be 'the' pool.");
    expect(panel).not.toHaveTextContent(/\bAPR\b|\bAPY\b|yield of|earn fees on every trade/i);
    expect(within(panel).getByText('Pool address').nextElementSibling).toHaveTextContent('the standard address for fee tier 1');
    expect(within(panel).getByText('Fee tier').nextElementSibling).toHaveTextContent('1: traders pay 1% a trade; LPs keep 0.840% of each trade');
    // The wallet is read with the opening's own deposits.
    fireEvent.click(within(panel).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByTestId('lp-create-panel')).toBeNull());
    expect(button).toHaveFocus();
  });

  it('reads the wallet with the opening deposits', async () => {
    const r = readers();
    mount(r);
    await openPanel();
    await waitFor(() => expect(r.wallet).toHaveBeenCalledWith(OWNER, M, TOKEN_PROGRAM, null, { opening: true }));
  });

  it('the boxes never move each other; Match keeps the last-typed box and sets the other at the market', async () => {
    const r = readers();
    const prepareLpCreate = vi.fn(async (): Promise<Prepared> => ({ ok: false, outcome: { status: 'not-sent', stage: 'build', message: 'x' } }));
    mount(r, { api: { prepareLpCreate } });
    const { panel } = await openPanel();
    expect(matchButton(panel)).toBeDisabled();
    fireEvent.change(sol(panel), { target: { value: '1' } });
    expect(tokens(panel)).toHaveValue('');
    expect(within(panel).getByTestId('lp-create-price')).toHaveAttribute('data-price', 'empty');
    expect(reviewButton(panel)).toBeDisabled();
    fireEvent.click(matchButton(panel));
    expect(sol(panel)).toHaveValue('1');
    expect(tokens(panel)).toHaveValue('100');
    const price = within(panel).getByTestId('lp-create-price');
    expect(price).toHaveAttribute('data-price', 'agrees');
    expect(price).toHaveTextContent('Your opening price: 1 token = 0.01 SOL. Market: 0.01 SOL. Yours is 0.0% above the market. Close enough to the market.');
    // isqrt(1e9 × 1e8) = 316,227,766; the program keeps 100.
    expect(within(panel).getByText('You get').nextElementSibling).toHaveTextContent('0.316227666 pool shares');
    expect(within(panel).getByText('Locked in the pool forever').nextElementSibling).toHaveTextContent('0.0000001 pool shares (100 of the smallest unit), worth about');
    expect(within(panel).getByText('In all, from your wallet').nextElementSibling).toHaveTextContent('about 1.192 SOL, plus the network fee');
    // Typing in the token box afterwards moves nothing else.
    fireEvent.change(tokens(panel), { target: { value: '101' } });
    expect(sol(panel)).toHaveValue('1');
    fireEvent.change(tokens(panel), { target: { value: '100' } });
    expect(reviewButton(panel)).toBeEnabled();
    await act(async () => {
      fireEvent.click(reviewButton(panel));
    });
    expect(prepareLpCreate).toHaveBeenCalledWith(
      conn.connection,
      expect.objectContaining({ kind: 'open' }),
      r,
      {
        owner: OWNER,
        tokenMint: MINT,
        sol: 1_000_000_000n,
        token: 100_000_000n,
        shown: { terms: { createPoolFee: 150_000_000n, tradeFeeRate: 10_000n, protocolFeeRate: 160_000n, fundFeeRate: 0n, creatorFeeRate: 0n }, standard: 'empty' },
      },
    );
    expect(await within(panel).findByTestId('tx-outcome')).toHaveAttribute('data-status', 'not-sent');
  });

  it('Match keeps the token box when it was typed last', async () => {
    mount(readers());
    const { panel } = await openPanel();
    fireEvent.change(tokens(panel), { target: { value: '50' } });
    fireEvent.click(matchButton(panel));
    expect(tokens(panel)).toHaveValue('50');
    expect(sol(panel)).toHaveValue('0.5');
  });

  it('a price far from the market: the problems line with the gap and a loss, Review off; Match fixes it', async () => {
    mount(readers());
    const { panel } = await openPanel();
    fireEvent.change(sol(panel), { target: { value: '1.5' } });
    fireEvent.change(tokens(panel), { target: { value: '100' } });
    expect(within(panel).getByTestId('lp-create-price')).toHaveAttribute('data-price', 'disagrees');
    const alert = within(panel).getByRole('alert');
    // The line is read out once typing settles (B review person-4).
    await waitFor(() => expect(alert).not.toHaveTextContent(''));
    expect(alert).toHaveTextContent(/^Your opening price is 50\.0% above the market price\. Bots would trade against your pool as soon as it opens, taking about 0\.05\d* SOL of what you put in\. Pools opened from this site must start within 3% of the market\.$/);
    expect(reviewButton(panel)).toBeDisabled();
    // The line's own Match keeps the token box (typed last).
    fireEvent.click(within(panel).getAllByRole('button', { name: 'Match the market price' }).find((b) => !b.hasAttribute('data-testid'))!);
    expect(tokens(panel)).toHaveValue('100');
    expect(sol(panel)).toHaveValue('1');
    expect(within(panel).getByTestId('lp-create-price')).toHaveAttribute('data-price', 'agrees');
    expect(within(panel).getByRole('alert')).toHaveTextContent('');
    expect(reviewButton(panel)).toBeEnabled();
  });

  it('too small, and a locked part above 0.1%: said, and Review off', async () => {
    mount(readers());
    const { panel } = await openPanel();
    // 100 lamports and 10 token units, at the market: isqrt(1,000) = 31, at or below 100.
    fireEvent.change(sol(panel), { target: { value: '0.0000001' } });
    fireEvent.change(tokens(panel), { target: { value: '0.00001' } });
    // The locked part is said in 9 decimals, as everywhere on this page (B review person-2).
    await waitFor(() =>
      expect(within(panel).getByRole('alert')).toHaveTextContent(
        'Too small: the pool program keeps 0.0000001 pool shares (100 of the smallest unit) in every new pool forever, and this opening would not cover them. Put in more of either side.',
      ),
    );
    expect(reviewButton(panel)).toBeDisabled();
    // 10,000 lamports and 1,000 units: isqrt(1e7) = 3,162, so the locked 100 are 3.16%.
    fireEvent.change(sol(panel), { target: { value: '0.00001' } });
    fireEvent.change(tokens(panel), { target: { value: '0.001' } });
    await waitFor(() =>
      expect(within(panel).getByRole('alert')).toHaveTextContent(
        'the 0.0000001 pool shares (100 of the smallest unit) the pool program keeps forever would be 3.16% of this pool.',
      ),
    );
    expect(panel).not.toHaveTextContent(/(^|[^.\d])100 pool shares/);
    expect(reviewButton(panel)).toBeDisabled();
  });

  it('Max SOL is what the wallet can put in after the fee to open, every deposit and two signatures', async () => {
    mount(readers());
    const { panel } = await openPanel();
    fireEvent.click(await within(panel).findByRole('button', { name: 'Max SOL' }));
    // 5 SOL − (10,000 + 1,000,000) − 2,039,280 (share account) − (150,000,000 + 40,000,000) − max(2,039,280, 890,880).
    expect(sol(panel)).toHaveValue('4.80491144');
    expect(panel).toHaveTextContent('Up to 4.80491144 SOL can go in after the fee to open, the account deposits and network fees.');
  });

  it('SOL above that: the rent-band line and Use that much', async () => {
    mount(readers());
    const { panel } = await openPanel();
    await within(panel).findByRole('button', { name: 'Max SOL' });
    fireEvent.change(sol(panel), { target: { value: '4.9' } });
    fireEvent.click(matchButton(panel));
    await waitFor(() => expect(within(panel).getByRole('alert')).not.toHaveTextContent(''));
    expect(within(panel).getByRole('alert')).toHaveTextContent(
      'That would leave your wallet with too little SOL to pay the fee to open, the account deposits and stay open on the network. The most you can put in from this wallet is 4.80491144 SOL.',
    );
    expect(reviewButton(panel)).toBeDisabled();
    fireEvent.click(within(panel).getByRole('button', { name: 'Use 4.80491144 SOL' }));
    expect(sol(panel)).toHaveValue('4.80491144');
  });

  it('more tokens than the wallet holds: says so, and the most both balances allow fits', async () => {
    mount(readers({ wallet: vi.fn(async () => facts({ token: { address: key().toBase58(), amount: 10n * 10n ** 6n } })) }));
    const { panel } = await openPanel();
    await within(panel).findByRole('button', { name: 'Max SOL' });
    fireEvent.change(sol(panel), { target: { value: '1' } });
    fireEvent.click(matchButton(panel));
    await waitFor(() => expect(within(panel).getByRole('alert')).toHaveTextContent('You have 10 tokens; this needs 100 tokens.'));
    expect(reviewButton(panel)).toBeDisabled();
    fireEvent.click(within(within(panel).getByRole('alert').parentElement!).getByRole('button', { name: 'Use the most both balances allow' }));
    expect(sol(panel)).toHaveValue('0.1');
    expect(tokens(panel)).toHaveValue('10');
    expect(reviewButton(panel)).toBeEnabled();
  });

  // Owner, 2026-10-03: "i still am not able to create lp on solana". The form was open
  // on a wallet holding 0.006 SOL and none of the token, and all it did was grey out
  // Review: the reason was two small hints under the boxes. A wallet that cannot open
  // any pool is now told so before it types anything.
  describe('a wallet that cannot open any pool is told so up front', () => {
    // What opening takes before any SOL goes in: (10,000 + 1,000,000) for two signatures
    // and the reserve, 2,039,280 for the share account, 150,000,000 + 40,000,000 for the
    // fee and the deposits, and max(2,039,280, 890,880) kept in the wallet.
    const NEEDS = 195_088_560n;

    it('too little SOL and none of the token: says how much opening needs, what the wallet has, and that it holds none', async () => {
      mount(readers({ wallet: vi.fn(async () => facts({ lamports: 5_960_758n, token: null })) }));
      const { panel } = await openPanel();
      const cannot = await within(panel).findByTestId('lp-create-cannot');
      expect(cannot).toHaveTextContent('This wallet cannot open a pool yet.');
      expect(cannot).toHaveTextContent(`needs about ${solAbout(NEEDS)}`);
      expect(cannot).toHaveTextContent('this wallet has 0.005960758 SOL');
      expect(cannot).toHaveTextContent('holds none of this token');
      expect(reviewButton(panel)).toBeDisabled();
    });

    it('too little SOL only: no word about the token', async () => {
      mount(readers({ wallet: vi.fn(async () => facts({ lamports: NEEDS })) }));
      const { panel } = await openPanel();
      const cannot = await within(panel).findByTestId('lp-create-cannot');
      expect(cannot).toHaveTextContent('This wallet cannot open a pool yet.');
      expect(cannot).not.toHaveTextContent('none of this token');
    });

    it('none of the token only: says a pool needs both, and nothing about SOL being short', async () => {
      mount(readers({ wallet: vi.fn(async () => facts({ token: null })) }));
      const { panel } = await openPanel();
      const cannot = await within(panel).findByTestId('lp-create-cannot');
      expect(cannot).toHaveTextContent('This wallet holds none of this token');
      expect(cannot).toHaveTextContent('needs both SOL and the token');
      expect(cannot).not.toHaveTextContent('needs about');
    });

    it('one lamport above what opening needs, with the token: nothing is said', async () => {
      mount(readers({ wallet: vi.fn(async () => facts({ lamports: NEEDS + 1n })) }));
      const { panel } = await openPanel();
      await within(panel).findByRole('button', { name: 'Max SOL' });
      expect(within(panel).queryByTestId('lp-create-cannot')).toBeNull();
    });

    it('an unread wallet is never told it cannot: nothing is claimed from a read that failed', async () => {
      mount(readers({ wallet: vi.fn(async () => ({ kind: 'unread' as const, detail: 'HTTP 502' })) }));
      const { panel } = await openPanel();
      await waitFor(() => expect(panel).toHaveTextContent('could not read (HTTP 502)'));
      expect(within(panel).queryByTestId('lp-create-cannot')).toBeNull();
    });
  });

  it('an unread wallet offers no Max and is never 0', async () => {
    mount(readers({ wallet: vi.fn(async () => ({ kind: 'unread' as const, detail: 'HTTP 502' })) }));
    const { panel } = await openPanel();
    await waitFor(() => expect(within(panel).getAllByText('You have: could not read (HTTP 502)')).toHaveLength(2));
    expect(within(panel).queryByRole('button', { name: 'Max SOL' })).toBeNull();
    expect(within(panel).queryByRole('button', { name: 'Max tokens' })).toBeNull();
    expect(within(panel).queryByRole('button', { name: 'Use the most both balances allow' })).toBeNull();
  });

  // B review person-4: the problems line's numbers change with every digit; a screen
  // reader hears it once typing settles, not on each keystroke.
  it('the problems line is read out once typing settles, not on every digit', async () => {
    mount(readers());
    const { panel } = await openPanel();
    const alert = within(panel).getByRole('alert');
    fireEvent.change(tokens(panel), { target: { value: '100' } });
    fireEvent.change(sol(panel), { target: { value: '1.5' } });
    expect(within(panel).getByTestId('lp-create-price')).toHaveAttribute('data-price', 'disagrees');
    // Not yet: the person is still typing.
    expect(alert).toHaveTextContent('');
    fireEvent.change(sol(panel), { target: { value: '1.52' } });
    expect(alert).toHaveTextContent('');
    await waitFor(() => expect(alert).toHaveTextContent(/^Your opening price is 52\.0% above the market price\./));
    // A fixed problem goes at once.
    fireEvent.change(sol(panel), { target: { value: '1' } });
    expect(alert).toHaveTextContent('');
  });

  // B review person-3: the market price's Read again says it is reading, and what it found.
  it("the market price's Read again says it is reading, then that the answer is the same", async () => {
    const r = readers();
    mount(r);
    const { panel } = await openPanel();
    const market = within(panel).getByTestId('lp-create-market');
    let release!: () => void;
    (r.outsidePrice as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () => new Promise((res) => (release = () => res({ kind: 'ok' as const, solPerToken: 0.01, source: 'Jupiter' as const }))),
    );
    fireEvent.click(within(market).getByRole('button', { name: 'Read again' }));
    await waitFor(() => expect(within(market).getByRole('status')).toHaveTextContent('Reading the market price again…'));
    expect(within(market).getByRole('button', { name: 'Read again' })).toHaveAttribute('aria-disabled', 'true');
    await act(async () => release());
    await waitFor(() => expect(within(market).getByRole('status')).toHaveTextContent('Read again just now: the same answer.'));
  });

  it('the market price row says when Jupiter was read', async () => {
    mount(readers());
    const { panel } = await openPanel();
    expect(within(panel).getByTestId('lp-create-market')).toHaveTextContent(/^Market price \(Jupiter, read \d\d:\d\d:\d\d\): 1 token = 0\.01 SOL\./);
  });
});

describe('the URL selects a token and nothing else', () => {
  it('/pools?mint=X&create=1&sol=5&tokens=9&price=1: no panel open; once opened, both boxes empty', async () => {
    mount(readers(), { path: `/pools?mint=${M}&create=1&sol=5&tokens=9&price=1` });
    const card = await screen.findByTestId('lp-create');
    await within(card).findByRole('button', { name: 'Open a pool' });
    expect(screen.queryByTestId('lp-create-panel')).toBeNull();
    const { panel } = await openPanel();
    expect(sol(panel)).toHaveValue('');
    expect(tokens(panel)).toHaveValue('');
    expect(reviewButton(panel)).toBeDisabled();
  });
});

describe('one panel at a time', () => {
  it('a busy opening switches off Add on every pool, with the line', async () => {
    let release!: () => void;
    const prepareLpCreate = vi.fn(
      () =>
        new Promise<Prepared>((res) => {
          release = () => res({ ok: false, outcome: { status: 'not-sent', stage: 'build', message: 'x' } });
        }),
    );
    mount(readers({ findPools: vi.fn(async () => search([view()])) }), { api: { prepareLpCreate } });
    const pool = await screen.findByTestId('lp-pool');
    const add = await within(pool).findByRole('button', { name: 'Add liquidity' });
    fireEvent.click(add);
    expect(await screen.findByTestId('lp-add-panel')).toBeInTheDocument();
    const { panel } = await openPanel();
    expect(screen.queryByTestId('lp-add-panel')).toBeNull();
    fireEvent.change(sol(panel), { target: { value: '1' } });
    fireEvent.click(matchButton(panel));
    await act(async () => {
      fireEvent.click(reviewButton(panel));
    });
    expect(within(pool).getByRole('button', { name: 'Add liquidity' })).toBeDisabled();
    expect(pool).toHaveTextContent('Finish or close the open liquidity panel first.');
    await act(async () => release());
    await waitFor(() => expect(within(pool).getByRole('button', { name: 'Add liquidity' })).toBeEnabled());
  });
});

// A pool this site opens goes through cp-swap's `initialize`, which switches the pool's
// creator fee off for good, so a trade on it costs the tier's trade fee and nothing more.
// The card, the panel and the review must all say that one figure, whatever creator rate
// the tier carries for the pools the launch program opens.
describe('what a trade on the new pool costs', () => {
  const tierRow = (panel: HTMLElement) => within(panel).getAllByText('Fee tier', { exact: true }).map((el) => el.nextElementSibling?.textContent);

  it('on tier 1 as mainnet holds it (recorded): 1% a trade, the same on the card, the panel and the review', async () => {
    const tier = { ...recordedTier(1), address: TIER1_ADDRESS.toBase58() };
    const summary = lpCreateSummary(key(), MINT, { config: tier });
    mount(readers(), { api: { readCreateFacts: vi.fn(async () => readyFacts(tier)), prepareLpCreate: vi.fn(async () => ({ ok: true as const, prepared: prepared(summary) })) } });
    const { card, panel } = await openPanel();
    expect(card).toHaveTextContent('You can open the first one on the public fee tier: 1% a trade, 0.15 SOL to open (read just now).');
    expect(tierRow(panel)).toEqual(['1: traders pay 1% a trade; LPs keep 0.840% of each trade']);
    fireEvent.change(sol(panel), { target: { value: '1' } });
    fireEvent.click(matchButton(panel));
    await act(async () => {
      fireEvent.click(reviewButton(panel));
    });
    await within(panel).findByRole('heading', { name: 'Review: open a pool' });
    expect(new Set(tierRow(panel))).toEqual(new Set(['1: traders pay 1% a trade; LPs keep 0.840% of each trade']));
  });

  it('on a tier with a creator rate set, still the trade fee alone, and it says the new pool charges no creator fee', async () => {
    const tier = { ...recordedTier(1), address: TIER1_ADDRESS.toBase58(), creatorFeeRate: 500n };
    const summary = lpCreateSummary(key(), MINT, { config: tier });
    mount(readers(), { api: { readCreateFacts: vi.fn(async () => readyFacts(tier)), prepareLpCreate: vi.fn(async () => ({ ok: true as const, prepared: prepared(summary) })) } });
    const { card, panel } = await openPanel();
    expect(card).toHaveTextContent('You can open the first one on the public fee tier: 1% a trade (no creator fee), 0.15 SOL to open (read just now).');
    expect(card).not.toHaveTextContent(/1\.05%/);
    expect(tierRow(panel)).toEqual(['1: traders pay 1% a trade (no creator fee); LPs keep 0.840% of each trade']);
    fireEvent.change(sol(panel), { target: { value: '1' } });
    fireEvent.click(matchButton(panel));
    await act(async () => {
      fireEvent.click(reviewButton(panel));
    });
    await within(panel).findByRole('heading', { name: 'Review: open a pool' });
    expect(new Set(tierRow(panel))).toEqual(new Set(['1: traders pay 1% a trade (no creator fee); LPs keep 0.840% of each trade']));
  });
});

describe('the review and a confirmed opening', () => {
  it('shows the opening review with its disclosure, and once confirmed the tab remembers the pool', async () => {
    const pool = key();
    const summary = lpCreateSummary(pool, MINT);
    const submitPrepared = vi.fn(async (_r: unknown, _s: unknown, _p: unknown, deps?: SubmitDeps): Promise<TxOutcome> => {
      deps?.onSent?.(SIG, 1234);
      return { status: 'confirmed', signature: SIG, slot: 7 };
    });
    const r = readers();
    mount(r, { api: { prepareLpCreate: vi.fn(async () => ({ ok: true as const, prepared: prepared(summary) })), submitPrepared } });
    const { panel } = await openPanel();
    fireEvent.change(sol(panel), { target: { value: '1' } });
    fireEvent.click(matchButton(panel));
    await act(async () => {
      fireEvent.click(reviewButton(panel));
    });
    expect(await within(panel).findByRole('heading', { name: 'Review: open a pool' })).toBeInTheDocument();
    const disclosure = within(panel).getByTestId('lp-review-disclosure');
    expect(disclosure).toHaveAttribute('data-kind', 'create');
    expect(disclosure).toHaveTextContent(/have not had their own independent review yet/);
    expect(disclosure).toHaveTextContent(/change the public fee tier's rates and its fee to open a pool at once/);
    expect(disclosure).toHaveTextContent('Trades on this site go through Jupiter, and Jupiter does not send trades to our pools.');
    expect(isCreatedPool(pool.toBase58())).toBe(false);
    await act(async () => {
      fireEvent.click(within(panel).getByRole('button', { name: 'Sign in wallet' }));
    });
    expect(await within(panel).findByTestId('tx-outcome')).toHaveAttribute('data-status', 'confirmed');
    expect(panel).toHaveTextContent(`Your pool is open at ${pool.toBase58()}. Swaps can start one second after it landed.`);
    expect(isCreatedPool(pool.toBase58())).toBe(true);
    // The note written when it was sent is cleared by the answer.
    expect(readPendingTrades(LP_PENDING_SCOPE)).toEqual([]);

    // A re-read now lists the new pool: the card says "you opened one", and the panel
    // with its outcome stays on screen.
    const outcome = within(panel).getByTestId('tx-outcome');
    const created = view();
    const listed: PoolView = { ...created, address: pool.toBase58() };
    (r.findPools as ReturnType<typeof vi.fn>).mockResolvedValue(search([listed]));
    fireEvent.click(within(screen.getByTestId('lp-finder')).getByRole('button', { name: 'Read again' }));
    await waitFor(() => expect(screen.getByTestId('lp-create')).toHaveAttribute('data-create', 'opened-here'));
    expect(screen.getByTestId('lp-create-panel')).toBe(panel);
    expect(outcome.isConnected).toBe(true);
    expect(within(screen.getByTestId('lp-pool')).getByTestId('lp-opened-here')).toBeInTheDocument();
  });
});
