// Adding and removing liquidity on /pools (SPEC_S2 C8): which button each card and row
// offers, the panels, the one-panel rule, focus, the pending lock, the gate banner and
// what the URL may NOT set. The write layer is a fake (fakeLpWriteApi.fixture.ts); the
// pools, positions and wallet are fake readers. Nothing here touches a chain.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor, within, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PublicKey } from '@solana/web3.js';
import { LpInner, type LpWritesOverrides } from './SolanaLpSection';
import { solAbout } from './panelKit';
import type { LpReaders } from './readers';
import type { TokenSafety } from '../../../lib/solana/lp/tokenSafety';
import { SOL_QUOTE } from '../../../lib/solana/lp/quotes';
import type { PoolSearchRead, PoolView } from '../../../lib/solana/lp/poolFinder';
import { POOL_STATUS_DISABLE_WITHDRAW, decodeAmmConfig, decodePoolState } from '../../../lib/solana/cpswap/program';
import type { Position } from '../../../lib/solana/lp/positions';
import type { WalletFacts } from '../../../lib/solana/lp/walletFacts';
import { buildPool, key } from '../../../lib/solana/lp/testkit.fixture';
import { LP_PENDING_SCOPE, savePendingTrade } from '../curve/pendingTrade';
import { prepared } from '../curve/fakeWriteApi.fixture';
import type { LpWriteApi, Prepared, TxOutcome, TxSummary } from '../curve/ports';
import { fakeLpApi, lpCfg, lpDepositSummary, lpOpenGate, lpWithdrawSummary, LP_PROGRAM, unusedGateRpc } from './fakeLpWriteApi.fixture';
import { parsePercentBps } from './PercentPicker';
import { recordedTier } from '../../../lib/solana/cpswap/mainnetVenueReplay.fixture';

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
// web3's address derivation cannot run under jsdom (a cross-realm Uint8Array check), so
// the one derivation a panel makes, the token account a withdrawal opens, is a fixed key.
vi.mock('../../../lib/launcher/solana/curve/ix', async (orig) => {
  const { PublicKey: Key } = await import('@solana/web3.js');
  return { ...(await orig<typeof import('../../../lib/launcher/solana/curve/ix')>()), associatedTokenAddress: () => new Key(new Uint8Array(32).fill(77)) };
});
const ATA = new PublicKey(new Uint8Array(32).fill(77));
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

const MINT = key();
const M = MINT.toBase58();
const SIG = '5'.repeat(88);

function view(o: { address?: PublicKey; sol?: bigint; tok?: bigint; openTime?: bigint; origin?: PoolView['origin']; status?: number } = {}): PoolView {
  const s = o.sol ?? 10n * 10n ** 9n;
  const t = o.tok ?? 1_000n * 10n ** 6n;
  const b = buildPool({ plain: true, mint: MINT, address: o.address, configIndex: 1, quoteReserve: s, tokenReserve: t, openTime: o.openTime ?? 1n, status: o.status });
  const pool = decodePoolState(b.address.toBase58(), b.accounts[b.address.toBase58()]!.data)!;
  const config = decodeAmmConfig(b.config.toBase58(), b.accounts[b.config.toBase58()]!.data);
  const quoteIsToken0 = pool.token0Mint.startsWith('So111');
  return {
    address: b.address.toBase58(),
    origin: o.origin ?? 'other',
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

function search(views: PoolView[], extra: Partial<Extract<PoolSearchRead, { kind: 'ok' }>['search']> = {}): PoolSearchRead {
  return {
    kind: 'ok',
    search: {
      mint: M,
      known: { launchPool: key().toBase58(), standard: [{ index: 1, config: key().toBase58(), address: key().toBase58(), quote: SOL_QUOTE.mint }] },
      index: { kind: 'ok', pools: views.map((v) => v.address), truncated: false },
      pools: views.map((v) => ({ kind: 'pool' as const, view: v })),
      otherPairs: 0,
      knownState: {},
      chainNow: 1_000n,
      ...extra,
    },
  };
}

const facts = (over: Partial<Extract<WalletFacts, { kind: 'ok' }>> = {}): WalletFacts => ({
  kind: 'ok',
  lamports: 5n * 10n ** 9n,
  token: { address: key().toBase58(), amount: 500n * 10n ** 6n },
  wsol: { exists: false, amount: 0n },
  coin: null,
  lpAccountExists: false,
  rents: { walletFloor: 890_880n, tokenAccount165: 2_039_280n },
  ...over,
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

function readers(o: Partial<LpReaders> = {}): LpReaders {
  return {
    programId: LP_PROGRAM,
    safety: vi.fn(async () => new Map([[M, okToken]])),
    findPools: vi.fn(async () => search([view()])),
    outsidePrice: vi.fn(async () => ({ kind: 'ok' as const, solPerToken: 0.01, source: 'Jupiter' as const })),
    positions: vi.fn(async () => ({ kind: 'ok' as const, positions: [], chainNow: 1n, totalShares: 0 })),
    feeTiers: vi.fn(async () => ({ kind: 'ok' as const, openingDeposits: null, tiers: [] })),
    wallet: vi.fn(async () => facts()),
    placeShareOnChain: vi.fn(async () => ({ kind: 'not-found' as const })),
    ...o,
  };
}

function mount(r: LpReaders, o: { mode?: LpWritesOverrides['mode']; api?: LpWriteApi; path?: string } = {}) {
  const api = o.api ?? fakeLpApi();
  const load = vi.fn(async () => api);
  const writes: LpWritesOverrides = { mode: o.mode ?? 'on', load, gateRpc: unusedGateRpc };
  const utils = render(
    <MemoryRouter initialEntries={[o.path ?? `/pools?mint=${M}`]}>
      <LpInner readers={r} writes={writes} />
    </MemoryRouter>,
  );
  return { ...utils, api, load };
}

const card = async () => screen.findByTestId('lp-pool');

beforeEach(() => {
  sessionStorage.clear();
  wallet.publicKey = OWNER;
  wallet.signTransaction = async (t) => t;
});

describe("mode 'off' (the shipped build)", () => {
  it('is stage 1, plus only the off line and the collapsed way out on a placed row; no write code loads', async () => {
    const v = view();
    const r = readers({ positions: vi.fn(async () => ({ kind: 'ok' as const, chainNow: 5n, totalShares: 1, positions: [position(v)] })) });
    const { load } = mount(r, { mode: 'off' });
    const c = await card();
    expect(c).toHaveAttribute('data-add', 'off');
    expect(c).toHaveAttribute('data-deposits', 'allowed');
    expect(within(c).getByText(/Adding liquidity from this page is not switched on yet/)).toBeInTheDocument();
    expect(within(c).queryByRole('button', { name: 'Add liquidity' })).toBeNull();
    expect(screen.getByTestId('lp-disclosure')).toHaveTextContent(/only reads/);
    const row = await screen.findByTestId('lp-position');
    expect(row).toHaveAttribute('data-remove', 'off');
    expect(row).toHaveTextContent('Removing liquidity from this site is switched off right now.');
    const leave = within(row).getByTestId('lp-leave-without-site');
    expect(leave.tagName).toBe('DETAILS');
    expect(leave).not.toHaveAttribute('open');
    expect(leave).toHaveTextContent(LP_PROGRAM);
    expect(leave).toHaveTextContent(v.address);
    expect(within(row).queryByRole('button', { name: 'Remove liquidity' })).toBeNull();
    expect(screen.queryByTestId('lp-gate-banner')).toBeNull();
    expect(load).not.toHaveBeenCalled();
    expect(r.wallet).not.toHaveBeenCalled();
  });
});

describe('Add liquidity', () => {
  it("is offered on a pool whose checks say 'allowed', and the disclosure says what the page now does", async () => {
    mount(readers());
    const c = await card();
    expect(await within(c).findByRole('button', { name: 'Add liquidity' })).toBeInTheDocument();
    expect(c).toHaveAttribute('data-add', 'offer');
    expect(within(c).getByText('These checks run again, on fresh reads, when you press Review.')).toBeInTheDocument();
    expect(screen.getByTestId('lp-disclosure')).toHaveTextContent(/Opening a pool, adding and removing liquidity here send real transactions/);
    expect(screen.getByTestId('lp-disclosure')).not.toHaveTextContent(/only reads/);
  });

  // The owner on a phone (2026-10-03): "there is still no way to" add. The button was a
  // screen and a half below the lookup. Chosen from the first card, the lookup ends in it.
  it('with the token already on the page, Add liquidity on the first card opens the Add form of the pool that offers it, with nothing read again', async () => {
    const v = view();
    const r = readers({ findPools: vi.fn(async () => search([v])) });
    mount(r);
    await within(await card()).findByRole('button', { name: 'Add liquidity' });
    expect(screen.queryByTestId('lp-add-panel')).toBeNull();
    const finder = screen.getByTestId('lp-finder');
    fireEvent.click(within(within(finder).getByTestId('lp-tasks')).getByRole('button', { name: 'Add liquidity' }));
    const panel = await screen.findByTestId('lp-add-panel');
    expect(r.findPools).toHaveBeenCalledTimes(1);
    expect(await card()).toContainElement(panel);
    // No pool was opened instead: the token has one that takes deposits.
    expect(screen.queryByTestId('lp-create-panel')).toBeNull();
    // The amount boxes come before the long notes, which are still on the page.
    const sol = within(panel).getByLabelText('SOL to add');
    const notes = within(panel).getByTestId('lp-before-you-add');
    expect(sol.compareDocumentPosition(notes) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(panel).toHaveTextContent('Read the notes under this form before you review.');
  });

  it('chosen on the first card, then a typed address: the lookup ends in the Add form, and no pool form opens beside it', async () => {
    const v = view();
    mount(readers({ findPools: vi.fn(async () => search([v])) }), { path: '/pools' });
    const finder = await screen.findByTestId('lp-finder');
    expect(screen.queryByTestId('lp-pool')).toBeNull();
    fireEvent.click(within(within(finder).getByTestId('lp-tasks')).getByRole('button', { name: 'Add liquidity' }));
    fireEvent.change(within(finder).getByLabelText('Token mint address'), { target: { value: M } });
    expect(screen.queryByTestId('lp-add-panel')).toBeNull();
    fireEvent.click(within(finder).getByRole('button', { name: 'Find pools' }));
    const panel = await screen.findByTestId('lp-add-panel');
    expect(await card()).toContainElement(panel);
    expect(screen.queryByTestId('lp-create-panel')).toBeNull();
  });

  it('with two pools, Add goes to the first one that takes deposits, not to one a pending deposit holds', async () => {
    const a = view();
    const b = view();
    savePendingTrade(LP_PENDING_SCOPE, { kind: 'lp-deposit', signature: SIG, lastValidBlockHeight: 50, pool: a.address });
    const api = fakeLpApi({ recheckOutcome: vi.fn(async () => ({ status: 'unknown' as const, signature: SIG, message: 'Not found yet.' })) });
    mount(readers({ findPools: vi.fn(async () => search([a, b])) }), { api });
    await waitFor(() => expect(screen.getAllByTestId('lp-pool')).toHaveLength(2));
    await waitFor(() => expect(screen.getAllByTestId('lp-pool')[0]).toHaveAttribute('data-add', 'held'));
    fireEvent.click(within(screen.getByTestId('lp-tasks')).getByRole('button', { name: 'Add liquidity' }));
    const panel = await screen.findByTestId('lp-add-panel');
    const cards = screen.getAllByTestId('lp-pool');
    expect(cards[1]).toHaveAttribute('data-pool', b.address);
    expect(cards[1]).toContainElement(panel);
    expect(cards[0]).not.toContainElement(panel);
  });

  it("is never offered on 'unchecked' (no outside price), and says why in the amended words", async () => {
    mount(readers({ outsidePrice: vi.fn(async () => ({ kind: 'unread' as const, detail: 'Jupiter did not give a price (HTTP 502)' })) }));
    const c = await card();
    await waitFor(() => expect(c).toHaveAttribute('data-add', 'checks'));
    expect(c).toHaveAttribute('data-deposits', 'unchecked');
    expect(within(c).queryByRole('button', { name: 'Add liquidity' })).toBeNull();
    expect(c).toHaveTextContent(
      "We offer adding liquidity only after checking the pool's price against a price from outside it, and we could not get one.",
    );
    expect(c).not.toHaveTextContent(/Often that means/);
  });

  it('is never offered on a token that copies a well-known name', async () => {
    const copy: TokenSafety = { ...okToken, verdict: 'warn', warnings: [{ code: 'copies-known-name', text: 'It calls itself USDC.' }] } as TokenSafety;
    mount(readers({ safety: vi.fn(async () => new Map([[M, copy]])) }));
    const c = await card();
    await waitFor(() => expect(c).toHaveAttribute('data-add', 'checks'));
    expect(c).toHaveAttribute('data-deposits', 'refused');
    expect(within(c).queryByRole('button', { name: 'Add liquidity' })).toBeNull();
  });

  it("'withdraw-only': adding is paused on every card, removing is still offered", async () => {
    const v = view();
    mount(readers({ positions: vi.fn(async () => ({ kind: 'ok' as const, chainNow: 5n, totalShares: 1, positions: [position(v)] })) }), { mode: 'withdraw-only', api: fakeLpApi({ gate: lpOpenGate({ mode: 'withdraw-only' }) }) });
    const c = await card();
    await waitFor(() => expect(c).toHaveAttribute('data-add', 'paused-here'));
    expect(c).toHaveTextContent('Adding liquidity from this site is paused. Removing it still works.');
    const row = await screen.findByTestId('lp-position');
    await waitFor(() => expect(row).toHaveAttribute('data-remove', 'offer'));
    expect(within(row).getByRole('button', { name: 'Remove liquidity' })).toBeInTheDocument();
    expect(screen.getByTestId('lp-disclosure')).toHaveTextContent(/Adding liquidity from this site is paused right now/);
  });

  it('opens in place: focus on its heading, back to the opener on Close; the disclosures are always visible', async () => {
    mount(readers());
    const add = await within(await card()).findByRole('button', { name: 'Add liquidity' });
    fireEvent.click(add);
    const panel = await screen.findByTestId('lp-add-panel');
    const heading = within(panel).getByRole('heading', { name: 'Add liquidity to this pool' });
    expect(heading).toHaveFocus();
    expect(panel).toHaveAccessibleName('Add liquidity to this pool');
    const before = within(panel).getByTestId('lp-before-you-add');
    expect(before).toHaveTextContent(/Our pool program is Raydium's, with only its admin keys changed\. Those changes have not had their own independent review yet\./);
    expect(before).toHaveTextContent(/change its fee rates at once/);
    expect(before).toHaveTextContent(/Jupiter does not send trades to these pools yet/);
    expect(before).toHaveTextContent(/liquidity providers keep 0\.\d{3}%, read from this pool's fee tier just now/);
    expect(before).not.toHaveTextContent(/burned the launch's own pool shares/); // not a launch pool
    expect(panel).not.toHaveTextContent(/\bAPR\b|\bAPY\b|yield of/i);
    fireEvent.click(within(panel).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByTestId('lp-add-panel')).toBeNull());
    expect(add).toHaveFocus();
  });

  it('a launch pool says its original shares were burned', async () => {
    mount(readers({ findPools: vi.fn(async () => search([view({ origin: 'launch-pool' })])) }));
    fireEvent.click(await within(await card()).findByRole('button', { name: 'Add liquidity' }));
    expect(await screen.findByTestId('lp-before-you-add')).toHaveTextContent(/burned the launch's own pool shares/);
  });

  it('typing SOL works out the token side from the pool, and Review sends the typed number as that side\'s limit', async () => {
    const v = view();
    const api = fakeLpApi({ prepareLpDeposit: vi.fn(async () => ({ ok: false as const, outcome: { status: 'not-sent' as const, stage: 'build' as const, message: 'moved' } })) });
    const r = readers({ findPools: vi.fn(async () => search([v])) });
    mount(r, { api });
    fireEvent.click(await within(await card()).findByRole('button', { name: 'Add liquidity' }));
    const panel = await screen.findByTestId('lp-add-panel');
    await waitFor(() => expect(within(panel).getByRole('button', { name: 'Max SOL' })).toBeInTheDocument());
    fireEvent.change(within(panel).getByLabelText('SOL to add'), { target: { value: '1' } });
    // 1 SOL into 10 SOL / 1,000 tokens / 1,000,000 shares at 1%: 99,009 shares, 99.009 tokens.
    expect(within(panel).getByLabelText('Tokens to add')).toHaveValue('99.009');
    expect(within(panel).getByLabelText('SOL to add')).toHaveAttribute('data-driving', 'true');
    expect(within(panel).getByText('0.000099009 pool shares, exactly')).toBeInTheDocument();
    const review = within(panel).getByRole('button', { name: 'Review: add liquidity' });
    expect(review).toBeEnabled();
    await act(async () => {
      fireEvent.click(review);
    });
    expect(api.prepareLpDeposit).toHaveBeenCalledWith(
      conn.connection,
      expect.objectContaining({ kind: 'open' }),
      r,
      expect.objectContaining({
        owner: OWNER,
        pool: new PublicKey(v.address),
        tokenMint: MINT,
        quoteMint: new PublicKey(SOL_QUOTE.mint),
        driving: 'quote',
        maxIn: 1_000_000_000n,
        slippageBps: 100n,
        // The token side's maximum the preview showed: ceil(99,009,000 × 1.01).
        shownOtherMax: 99_999_090n,
      }),
    );
    expect(await within(panel).findByTestId('tx-outcome')).toHaveAttribute('data-status', 'not-sent');
  });

  it('Max tokens drives from the token side; an unread balance shows no Max and is never 0', async () => {
    const r = readers();
    mount(r);
    fireEvent.click(await within(await card()).findByRole('button', { name: 'Add liquidity' }));
    const panel = await screen.findByTestId('lp-add-panel');
    fireEvent.click(await within(panel).findByRole('button', { name: 'Max tokens' }));
    expect(within(panel).getByLabelText('Tokens to add')).toHaveValue('500');
    expect(within(panel).getByLabelText('Tokens to add')).toHaveAttribute('data-driving', 'true');
    expect(r.wallet).toHaveBeenCalledWith(OWNER, M, 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', expect.any(String));
  });

  // The Add form's side of the owner's report of 2026-10-03: a wallet that cannot add
  // anything was shown a greyed-out Review and two small hints. It is now told so.
  it('a wallet with no SOL to spare and none of the token is told it cannot add yet, with what adding needs and what it has', async () => {
    mount(readers({ wallet: vi.fn(async () => facts({ lamports: 3_000_000n, token: null })) }));
    fireEvent.click(await within(await card()).findByRole('button', { name: 'Add liquidity' }));
    const panel = await screen.findByTestId('lp-add-panel');
    const cannot = await within(panel).findByTestId('lp-add-cannot');
    // The swap opens on this token by its address, never by a name to search for; the wallet's address is one press to copy.
    expect(within(cannot).getByRole('link', { name: 'this site’s Solana swap' })).toHaveAttribute('href', `/solana?out=${M}`);
    expect(within(cannot).getByRole('button', { name: /Copy this wallet’s address/ })).toBeInTheDocument();
    expect(cannot).toHaveTextContent('This wallet cannot add to this pool yet.');
    // (5,000 + 1,000,000) for one signature and the reserve, 2,039,280 for the share
    // account, and max(2,039,280, 890,880) kept in the wallet.
    expect(cannot).toHaveTextContent(`needs about ${solAbout(5_083_560n)}`);
    expect(cannot).toHaveTextContent('this wallet has 0.003 SOL');
    expect(cannot).toHaveTextContent('holds none of this token');
    expect(within(panel).getByRole('button', { name: 'Review: add liquidity' })).toBeDisabled();
  });

  it('a wallet that can add is told nothing of the sort', async () => {
    mount(readers());
    fireEvent.click(await within(await card()).findByRole('button', { name: 'Add liquidity' }));
    const panel = await screen.findByTestId('lp-add-panel');
    await within(panel).findByRole('button', { name: 'Max SOL' });
    expect(within(panel).queryByTestId('lp-add-cannot')).toBeNull();
  });

  it('an unread wallet balance offers no Max and says it could not read', async () => {
    mount(readers({ wallet: vi.fn(async () => ({ kind: 'unread' as const, detail: 'HTTP 502' })) }));
    fireEvent.click(await within(await card()).findByRole('button', { name: 'Add liquidity' }));
    const panel = await screen.findByTestId('lp-add-panel');
    await waitFor(() => expect(within(panel).getAllByText('You have: could not read (HTTP 502)')).toHaveLength(2));
    expect(within(panel).queryByRole('button', { name: 'Max SOL' })).toBeNull();
    expect(within(panel).queryByRole('button', { name: 'Max tokens' })).toBeNull();
  });

  it('more tokens than the wallet holds: says so, offers the most both balances allow, and Review stays off', async () => {
    mount(readers({ wallet: vi.fn(async () => facts({ token: { address: key().toBase58(), amount: 10n * 10n ** 6n } })) }));
    fireEvent.click(await within(await card()).findByRole('button', { name: 'Add liquidity' }));
    const panel = await screen.findByTestId('lp-add-panel');
    await within(panel).findByRole('button', { name: 'Max SOL' });
    fireEvent.change(within(panel).getByLabelText('SOL to add'), { target: { value: '1' } });
    // The problems line is read out once typing settles (B review person-4).
    await waitFor(() => expect(panel).toHaveTextContent(/This needs up to 99\.\d+ tokens and your wallet has 10 tokens\./));
    expect(within(panel).getByRole('button', { name: 'Review: add liquidity' })).toBeDisabled();
    fireEvent.click(within(panel).getByRole('button', { name: 'Use the most both balances allow' }));
    // 10 tokens at 100 tokens per SOL: 0.1 SOL drives, and the plan fits.
    expect(within(panel).getByLabelText('SOL to add')).toHaveValue('0.1');
    expect(within(panel).getByRole('button', { name: 'Review: add liquidity' })).toBeEnabled();
  });

  it('the price-tolerance hint says what a refused deposit costs', async () => {
    mount(readers());
    fireEvent.click(await within(await card()).findByRole('button', { name: 'Add liquidity' }));
    const panel = await screen.findByTestId('lp-add-panel');
    expect(panel).toHaveTextContent('If the pool’s price moves more than this before your deposit runs, it is refused and only the network fees are spent.');
    expect(within(panel).getByRole('button', { name: '1%' })).toHaveAttribute('aria-pressed', 'true');
  });
});

describe('the URL selects a token and nothing else', () => {
  it('/pools?mint=X&amount=5&slippage=500&side=token: no panel open; once opened, empty boxes and 1%', async () => {
    mount(readers(), { path: `/pools?mint=${M}&amount=5&slippage=500&side=token&panel=add` });
    const add = await within(await card()).findByRole('button', { name: 'Add liquidity' });
    expect(screen.queryByTestId('lp-add-panel')).toBeNull();
    fireEvent.click(add);
    const panel = await screen.findByTestId('lp-add-panel');
    expect(within(panel).getByLabelText('SOL to add')).toHaveValue('');
    expect(within(panel).getByLabelText('Tokens to add')).toHaveValue('');
    expect(within(panel).getByRole('button', { name: '1%' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(panel).getByRole('button', { name: 'Review: add liquidity' })).toBeDisabled();
  });
});

describe('Remove liquidity', () => {
  it('is offered while deposits are refused (far-future open, price off) and on a set-aside row', async () => {
    const far = view({ openTime: 10n ** 10n });
    const blocked: TokenSafety = { ...okToken, verdict: 'blocked', blocks: [{ code: 'freeze-authority', text: 'Its creator can still freeze token accounts.' }] } as TokenSafety;
    const otherMint = key().toBase58();
    const aside = view();
    const asideView: PoolView = { ...aside, tokenMint: otherMint };
    const r = readers({
      findPools: vi.fn(async () => search([far])),
      outsidePrice: vi.fn(async () => ({ kind: 'ok' as const, solPerToken: 0.5, source: 'Jupiter' as const })),
      safety: vi.fn(async (mints: string[]) => new Map(mints.map((m) => [m, m === otherMint ? { ...blocked, mint: otherMint } : okToken]))),
      positions: vi.fn(async () => ({ kind: 'ok' as const, chainNow: 5n, totalShares: 2, positions: [position(far), position(asideView)] })),
    });
    mount(r);
    const c = await card();
    await waitFor(() => expect(c).toHaveAttribute('data-deposits', 'refused'));
    await waitFor(() => expect(c).toHaveAttribute('data-add', 'checks'));
    const rows = await screen.findAllByTestId('lp-position');
    await waitFor(() => expect(rows.map((x) => x.getAttribute('data-remove'))).toEqual(['offer', 'offer']));
    const setAside = screen.getByTestId('lp-positions-set-aside');
    expect(within(setAside).getByRole('button', { name: 'Remove liquidity' })).toBeInTheDocument();
  });

  it('by percent: nothing chosen at first; 50% sends 5000 bps from the exact account the list found', async () => {
    const v = view();
    const p = position(v);
    const api = fakeLpApi({ prepareLpWithdraw: vi.fn(async () => ({ ok: false as const, outcome: { status: 'not-sent' as const, stage: 'build' as const, message: 'x' } })) });
    mount(readers({ positions: vi.fn(async () => ({ kind: 'ok' as const, chainNow: 5n, totalShares: 1, positions: [p] })) }), { api });
    const row = await screen.findByTestId('lp-position');
    fireEvent.click(await within(row).findByRole('button', { name: 'Remove liquidity' }));
    const panel = await screen.findByTestId('lp-remove-panel');
    expect(within(panel).getByRole('heading', { name: 'Remove liquidity from this pool' })).toHaveFocus();
    const review = within(panel).getByRole('button', { name: 'Review: remove liquidity' });
    expect(review).toBeDisabled();
    const group = within(panel).getByRole('group', { name: 'How much to take out' });
    for (const label of ['25%', '50%', '75%', 'All']) expect(within(group).getByRole('button', { name: label })).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(within(group).getByRole('button', { name: '50%' }));
    expect(within(group).getByRole('button', { name: '50%' })).toHaveAttribute('aria-pressed', 'true');
    expect(panel).toHaveTextContent('If the pool’s price moves more than this before your withdrawal runs, it is refused and only the network fees are spent.');
    expect(within(panel).getByText('You keep').nextElementSibling).toHaveTextContent('0.000125 pool shares');
    await act(async () => {
      fireEvent.click(within(panel).getByRole('button', { name: 'Review: remove liquidity' }));
    });
    expect(api.prepareLpWithdraw).toHaveBeenCalledWith(
      conn.connection,
      expect.objectContaining({ kind: 'open' }),
      expect.objectContaining({ owner: OWNER, pool: new PublicKey(v.address), tokenMint: MINT, lpAccount: new PublicKey(p.lpAccount), pctBps: 5_000n, slippageBps: 100n }),
    );
  });

  it('a remainder too small to ever take out is refused, with "Take out all of it"', async () => {
    // 1,000,000 shares over 10 SOL / 1,000 tokens: the program needs 1 share per side, so
    // a pool of 1,000,000 shares against 1,000 token units needs 1,000 shares.
    const v = view({ tok: 1_000n });
    const p = position(v, { lpAmount: 10_000n });
    mount(readers({ findPools: vi.fn(async () => search([v])), positions: vi.fn(async () => ({ kind: 'ok' as const, chainNow: 5n, totalShares: 1, positions: [p] })) }));
    const row = await screen.findByTestId('lp-position');
    fireEvent.click(await within(row).findByRole('button', { name: 'Remove liquidity' }));
    const panel = await screen.findByTestId('lp-remove-panel');
    fireEvent.change(within(panel).getByLabelText('Other percent'), { target: { value: '95' } });
    // The problems line is read out once typing settles (B review person-4).
    await waitFor(() => expect(panel).toHaveTextContent(/too few to ever take out at this pool’s size/));
    expect(within(panel).getByRole('button', { name: 'Review: remove liquidity' })).toBeDisabled();
    fireEvent.click(within(panel).getByRole('button', { name: 'Take out all of it' }));
    expect(within(panel).getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(panel).getByLabelText('Other percent')).toHaveValue('');
    expect(within(panel).getByRole('button', { name: 'Review: remove liquidity' })).toBeEnabled();
  });

  it('a share our index could not place can be found on the chain, then reads as placed', async () => {
    const v = view();
    const unplaced = position(v, { placement: 'index-unread', placementDetail: 'HTTP 502', pool: null, value: null });
    const placed = position(v, { lpAccount: unplaced.lpAccount, placement: 'chain' });
    const positions = vi.fn().mockResolvedValueOnce({ kind: 'ok' as const, chainNow: 5n, totalShares: 1, positions: [unplaced] }).mockResolvedValue({ kind: 'ok' as const, chainNow: 5n, totalShares: 1, positions: [placed] });
    const placeShareOnChain = vi.fn(async () => ({ kind: 'placed' as const, entry: { kind: 'pool' as const, view: v } }));
    mount(readers({ positions, placeShareOnChain }), { path: '/pools' });
    const row = await screen.findByTestId('lp-position');
    await waitFor(() => expect(row).toHaveAttribute('data-remove', 'unplaced'));
    fireEvent.click(within(row).getByRole('button', { name: "Find this share's pool on the chain" }));
    await waitFor(() => expect(screen.getByTestId('lp-position')).toHaveAttribute('data-placement', 'chain'));
    expect(placeShareOnChain).toHaveBeenCalledWith({ lpMint: unplaced.lpMint, lpAccount: unplaced.lpAccount });
    await waitFor(() => expect(screen.getByTestId('lp-position')).toHaveAttribute('data-remove', 'offer'));
  });

  it('a search that finds nothing says the shares are safe; a failed one says it could not read', async () => {
    const v = view();
    const unplaced = position(v, { placement: 'not-found', pool: null, value: null });
    const placeShareOnChain = vi.fn().mockResolvedValueOnce({ kind: 'not-found' }).mockResolvedValueOnce({ kind: 'unread', detail: 'HTTP 429' });
    mount(readers({ positions: vi.fn(async () => ({ kind: 'ok' as const, chainNow: 5n, totalShares: 1, positions: [unplaced] })), placeShareOnChain }), { path: '/pools' });
    const row = await screen.findByTestId('lp-position');
    const find = await within(row).findByRole('button', { name: "Find this share's pool on the chain" });
    fireEvent.click(find);
    expect(await within(row).findByText(/could not find this share’s pool from its recent history\. Your shares are safe/)).toBeInTheDocument();
    fireEvent.click(find);
    expect(await within(row).findByText(/could not read the chain just now \(HTTP 429\)\. Your shares are safe/)).toBeInTheDocument();
  });
});

describe('one panel at a time', () => {
  it('opening another closes the open one; while one is busy, every other entry button is off and says why', async () => {
    const v = view();
    let release!: () => void;
    const api = fakeLpApi({
      prepareLpDeposit: vi.fn(
        () =>
          new Promise<Prepared>((r) => {
            release = () => r({ ok: false as const, outcome: { status: 'not-sent' as const, stage: 'build' as const, message: 'x' } });
          }),
      ),
    });
    mount(readers({ positions: vi.fn(async () => ({ kind: 'ok' as const, chainNow: 5n, totalShares: 1, positions: [position(v)] })) }), { api });
    const c = await card();
    fireEvent.click(await within(c).findByRole('button', { name: 'Add liquidity' }));
    expect(await screen.findByTestId('lp-add-panel')).toBeInTheDocument();
    const row = await screen.findByTestId('lp-position');
    fireEvent.click(await within(row).findByRole('button', { name: 'Remove liquidity' }));
    expect(await screen.findByTestId('lp-remove-panel')).toBeInTheDocument();
    expect(screen.queryByTestId('lp-add-panel')).toBeNull();

    // Back to Add, and make it busy.
    fireEvent.click(within(c).getByRole('button', { name: 'Add liquidity' }));
    const panel = await screen.findByTestId('lp-add-panel');
    await within(panel).findByRole('button', { name: 'Max SOL' });
    fireEvent.change(within(panel).getByLabelText('SOL to add'), { target: { value: '0.5' } });
    await act(async () => {
      fireEvent.click(within(panel).getByRole('button', { name: 'Review: add liquidity' }));
    });
    const remove = within(row).getByRole('button', { name: 'Remove liquidity' });
    expect(remove).toBeDisabled();
    expect(row).toHaveTextContent('Finish or close the open liquidity panel first.');
    fireEvent.click(remove);
    expect(screen.queryByTestId('lp-remove-panel')).toBeNull();
    await act(async () => release());
    await waitFor(() => expect(within(row).getByRole('button', { name: 'Remove liquidity' })).toBeEnabled());
  });

  it('a re-read of the same token keeps an open panel and its outcome on screen', async () => {
    const api = fakeLpApi({ prepareLpDeposit: vi.fn(async () => ({ ok: false as const, outcome: { status: 'not-sent' as const, stage: 'build' as const, message: 'the pool moved' } })) });
    const v = view();
    const r = readers({ findPools: vi.fn(async () => search([v])) });
    mount(r, { api });
    fireEvent.click(await within(await card()).findByRole('button', { name: 'Add liquidity' }));
    const panel = await screen.findByTestId('lp-add-panel');
    await within(panel).findByRole('button', { name: 'Max SOL' });
    fireEvent.change(within(panel).getByLabelText('SOL to add'), { target: { value: '0.5' } });
    await act(async () => {
      fireEvent.click(within(panel).getByRole('button', { name: 'Review: add liquidity' }));
    });
    const outcome = await within(panel).findByTestId('tx-outcome');
    let release!: (v: PoolSearchRead) => void;
    (r.findPools as ReturnType<typeof vi.fn>).mockImplementationOnce(() => new Promise<PoolSearchRead>((res) => (release = res)));
    fireEvent.click(screen.getByRole('button', { name: 'Read again' }));
    // While the new answer is on its way, the card, the panel and the outcome stay put.
    expect(await screen.findByText('Reading the token and its pools again…')).toBeInTheDocument();
    expect(outcome.isConnected).toBe(true);
    await act(async () => release(search([v])));
    expect(screen.getByTestId('lp-add-panel')).toBe(panel);
    expect(outcome.isConnected).toBe(true);
  });

  it('an open panel keeps its outcome even when a re-read turns the pool away from offering Add', async () => {
    const api = fakeLpApi({ prepareLpDeposit: vi.fn(async () => ({ ok: false as const, outcome: { status: 'not-sent' as const, stage: 'build' as const, message: 'the price moved' } })) });
    const v = view();
    const r = readers({ findPools: vi.fn(async () => search([v])) });
    mount(r, { api });
    const c = await card();
    fireEvent.click(await within(c).findByRole('button', { name: 'Add liquidity' }));
    const panel = await screen.findByTestId('lp-add-panel');
    await within(panel).findByRole('button', { name: 'Max SOL' });
    fireEvent.change(within(panel).getByLabelText('SOL to add'), { target: { value: '0.5' } });
    await act(async () => {
      fireEvent.click(within(panel).getByRole('button', { name: 'Review: add liquidity' }));
    });
    const outcome = await within(panel).findByTestId('tx-outcome');
    // The next read cannot price the token: the card no longer offers Add.
    (r.outsidePrice as ReturnType<typeof vi.fn>).mockResolvedValue({ kind: 'unread', detail: 'Jupiter did not give a price (HTTP 502)' });
    fireEvent.click(screen.getByRole('button', { name: 'Read again' }));
    await waitFor(() => expect(screen.getByTestId('lp-pool')).toHaveAttribute('data-add', 'checks'));
    expect(within(screen.getByTestId('lp-pool')).queryByRole('button', { name: 'Add liquidity' })).toBeNull();
    expect(screen.getByTestId('lp-add-panel')).toBe(panel);
    expect(outcome.isConnected).toBe(true);
  });

  it('a re-read of the same wallet keeps an open Remove panel and its outcome on screen', async () => {
    const v = view();
    const p = position(v);
    const api = fakeLpApi({ prepareLpWithdraw: vi.fn(async () => ({ ok: false as const, outcome: { status: 'not-sent' as const, stage: 'build' as const, message: 'x' } })) });
    const positions = vi.fn(async (): Promise<Awaited<ReturnType<LpReaders['positions']>>> => ({ kind: 'ok', chainNow: 5n, totalShares: 1, positions: [p] }));
    mount(readers({ positions }), { api, path: '/pools' });
    const row = await screen.findByTestId('lp-position');
    fireEvent.click(await within(row).findByRole('button', { name: 'Remove liquidity' }));
    const panel = await screen.findByTestId('lp-remove-panel');
    fireEvent.click(within(panel).getByRole('button', { name: 'All' }));
    await act(async () => {
      fireEvent.click(within(panel).getByRole('button', { name: 'Review: remove liquidity' }));
    });
    const outcome = await within(panel).findByTestId('tx-outcome');
    let release!: (x: Awaited<ReturnType<LpReaders['positions']>>) => void;
    positions.mockImplementationOnce(() => new Promise((res) => (release = res)));
    const again = within(screen.getByTestId('lp-positions')).getAllByRole('button', { name: 'Read my positions again' });
    fireEvent.click(again[again.length - 1]!);
    await waitFor(() => expect(positions).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId('lp-remove-panel')).toBe(panel);
    // The new read finds withdrawals switched off on this pool: the row no longer offers
    // Remove, but the panel that already has an outcome on screen stays.
    const off = view({ address: new PublicKey(v.address), status: POOL_STATUS_DISABLE_WITHDRAW });
    await act(async () => release({ kind: 'ok', chainNow: 6n, totalShares: 1, positions: [position(off, { lpAccount: p.lpAccount })] }));
    await waitFor(() => expect(screen.getByTestId('lp-position')).toHaveAttribute('data-remove', 'switched-off'));
    expect(screen.getByTestId('lp-remove-panel')).toBe(panel);
    expect(outcome.isConnected).toBe(true);
  });
});

describe('where the tokens of a withdrawal arrive', () => {
  const missingToken = () => readers({ wallet: vi.fn(async () => facts({ token: null })) });

  it('a missing classic account: opened for you, and its deposit is the live 165-byte rent', async () => {
    const v = view();
    mount({ ...missingToken(), positions: vi.fn(async () => ({ kind: 'ok' as const, chainNow: 5n, totalShares: 1, positions: [position(v)] })) }, { path: '/pools' });
    fireEvent.click(await within(await screen.findByTestId('lp-position')).findByRole('button', { name: 'Remove liquidity' }));
    const panel = await screen.findByTestId('lp-remove-panel');
    fireEvent.click(within(panel).getByRole('button', { name: '50%' }));
    expect(await within(panel).findByText('Opened for you; its deposit of 0.00203928 SOL stays in that account.')).toBeInTheDocument();
    expect(within(panel).getByText('The tokens arrive in').nextElementSibling).toHaveTextContent(ATA.toBase58());
  });

  it('a missing Token-2022 account is never priced at the classic 165 bytes (D20): the review says the amount', async () => {
    const base = view();
    const pool = base.quoteIsToken0 ? { ...base.snapshot.pool, token1Program: TOKEN_2022 } : { ...base.snapshot.pool, token0Program: TOKEN_2022 };
    const v: PoolView = { ...base, snapshot: { ...base.snapshot, pool } };
    mount({ ...missingToken(), positions: vi.fn(async () => ({ kind: 'ok' as const, chainNow: 5n, totalShares: 1, positions: [position(v)] })) }, { path: '/pools' });
    fireEvent.click(await within(await screen.findByTestId('lp-position')).findByRole('button', { name: 'Remove liquidity' }));
    const panel = await screen.findByTestId('lp-remove-panel');
    fireEvent.click(within(panel).getByRole('button', { name: '50%' }));
    expect(await within(panel).findByText('Opened for you; its deposit stays in that account (the review shows the amount).')).toBeInTheDocument();
    expect(panel).not.toHaveTextContent('0.00203928');
  });
});

describe('the pending lock', () => {
  it('a pending deposit holds Add on that pool only, and never Remove; the card at the top names it', async () => {
    const a = view();
    const b = view({ address: key(), sol: 9n * 10n ** 9n, tok: 900n * 10n ** 6n });
    savePendingTrade(LP_PENDING_SCOPE, { kind: 'lp-deposit', signature: SIG, lastValidBlockHeight: 50, pool: a.address });
    const api = fakeLpApi({ recheckOutcome: vi.fn(async () => ({ status: 'unknown' as const, signature: SIG, message: 'Not found yet.' })) });
    mount(readers({ findPools: vi.fn(async () => search([a, b])), positions: vi.fn(async () => ({ kind: 'ok' as const, chainNow: 5n, totalShares: 1, positions: [position(a)] })) }), { api });
    const cards = await screen.findAllByTestId('lp-pool');
    await waitFor(() => expect(cards.map((c) => c.getAttribute('data-add'))).toEqual(['held', 'offer']));
    expect(cards[0]).toHaveTextContent('A deposit you sent to this pool is not confirmed yet (see the top of this section).');
    const row = await screen.findByTestId('lp-position');
    await waitFor(() => expect(row).toHaveAttribute('data-remove', 'offer'));
    const pending = await screen.findByTestId('lp-pending');
    expect(pending).toHaveTextContent('Your last liquidity change may still be landing');
    expect(pending).toHaveTextContent(a.address);
    expect(pending).toHaveTextContent('adding liquidity');
    expect(within(pending).getByRole('link', { name: 'View on the explorer' })).toHaveAttribute('href', `https://explorer.test/tx/${SIG}`);
    // The note is checked with its kind, so a refusal is said in that kind's words.
    await waitFor(() => expect(api.recheckOutcome).toHaveBeenCalledWith(conn.connection, SIG, expect.objectContaining({ kind: 'lp-deposit', lastValidBlockHeight: 50 })));
  });

  it('a pending withdrawal holds Remove on that pool, and never Add', async () => {
    const a = view();
    savePendingTrade(LP_PENDING_SCOPE, { kind: 'lp-withdraw', signature: SIG, lastValidBlockHeight: 50, pool: a.address });
    const api = fakeLpApi({ recheckOutcome: vi.fn(async () => ({ status: 'unknown' as const, signature: SIG, message: 'Not found yet.' })) });
    mount(readers({ findPools: vi.fn(async () => search([a])), positions: vi.fn(async () => ({ kind: 'ok' as const, chainNow: 5n, totalShares: 1, positions: [position(a)] })) }), { api });
    const row = await screen.findByTestId('lp-position');
    await waitFor(() => expect(row).toHaveAttribute('data-remove', 'held'));
    expect(row).toHaveTextContent('A withdrawal you sent from this pool is not confirmed yet');
    await waitFor(() => expect(screen.getByTestId('lp-pool')).toHaveAttribute('data-add', 'offer'));
  });
});

describe('the gate banner', () => {
  const blocked = (reason: 'wrong-cluster' | 'cpswap-program-missing' | 'unreadable') => fakeLpApi({ gate: { kind: 'blocked', reason, detail: 'read detail' } });

  it.each([
    ['wrong-cluster', 'Your connection is on a different Solana network from this site, so nothing can be sent from here.'],
    ['cpswap-program-missing', 'The pool program could not be found on the network, so nothing can be sent from here.'],
    ['unreadable', 'We could not check the network just now, so adding and removing are off until we can. This does not change anything about your shares.'],
  ] as const)('%s', async (reason, text) => {
    const v = view();
    const api = blocked(reason);
    mount(readers({ positions: vi.fn(async () => ({ kind: 'ok' as const, chainNow: 5n, totalShares: 1, positions: [position(v)] })) }), { api });
    const banner = await screen.findByTestId('lp-gate-banner');
    expect(banner).toHaveTextContent(text);
    const c = await card();
    await waitFor(() => expect(c).toHaveAttribute('data-add', 'gate'));
    const row = await screen.findByTestId('lp-position');
    await waitFor(() => expect(row).toHaveAttribute('data-remove', 'gate'));
    expect(row).toHaveTextContent('Removing liquidity needs this page to reach the pool program, and it cannot right now');
    expect(within(row).getByTestId('lp-leave-without-site')).toBeInTheDocument();
    const again = within(banner).queryByRole('button', { name: 'Read again' });
    if (reason === 'unreadable') {
      expect(again).not.toBeNull();
      fireEvent.click(again!);
      await waitFor(() => expect(api.readLpGate).toHaveBeenCalledTimes(2));
    } else expect(again).toBeNull();
  });

  it('the write code did not load: says so, and the section still reads', async () => {
    const load = vi.fn(async () => {
      throw new Error('chunk 404');
    });
    render(
      <MemoryRouter initialEntries={[`/pools?mint=${M}`]}>
        <LpInner readers={readers()} writes={{ mode: 'on', load, gateRpc: unusedGateRpc }} />
      </MemoryRouter>,
    );
    expect(await screen.findByTestId('lp-gate-banner')).toHaveTextContent(
      'The add and remove forms did not load (chunk 404). This section still reads; reload the page to try again.',
    );
    expect(await card()).toHaveAttribute('data-deposits', 'allowed');
    expect(screen.getByTestId('lp-pool')).toHaveAttribute('data-add', 'gate');
  });

  it('a gate open on another pool program than the one the page reads is blocked', async () => {
    mount(readers(), { api: fakeLpApi({ gate: lpOpenGate({ cfg: lpCfg(key().toBase58()) }) }) });
    expect(await screen.findByTestId('lp-gate-banner')).toHaveTextContent(
      'This page reads pools from a different program than the one it would send to, so nothing can be sent from here.',
    );
    await waitFor(() => expect(screen.getByTestId('lp-pool')).toHaveAttribute('data-add', 'gate'));
  });
});

describe('the review', () => {
  it('a prepared deposit shows the review with the fork and vault lines above its rows', async () => {
    const v = view();
    const summary = lpDepositSummary(new PublicKey(v.address), MINT);
    const api = fakeLpApi({ prepareLpDeposit: vi.fn(async () => ({ ok: true as const, prepared: prepared(summary) })) });
    mount(readers({ findPools: vi.fn(async () => search([v])) }), { api });
    fireEvent.click(await within(await card()).findByRole('button', { name: 'Add liquidity' }));
    const panel = await screen.findByTestId('lp-add-panel');
    await within(panel).findByRole('button', { name: 'Max SOL' });
    fireEvent.change(within(panel).getByLabelText('SOL to add'), { target: { value: '0.1' } });
    await act(async () => {
      fireEvent.click(within(panel).getByRole('button', { name: 'Review: add liquidity' }));
    });
    expect(await within(panel).findByRole('heading', { name: 'Review: add liquidity' })).toBeInTheDocument();
    const disclosure = within(panel).getByTestId('lp-review-disclosure');
    expect(disclosure).toHaveTextContent(/have not had their own independent review yet/);
    expect(disclosure).toHaveTextContent(/change its fee rates at once/);
  });
});

// A review read slowly on a phone outlives its blockhash. Adding and removing only read
// the chain to prepare, so Sign prepares again and signs the fresh one (useTxFlow). Here
// the block height says the first one's window is nearly over (the fixture's ends at 1234).
describe('a review too old to sign when Sign in wallet is pressed', () => {
  const rpc = conn.connection as { getBlockHeight?: () => Promise<number> };
  beforeEach(() => {
    rpc.getBlockHeight = async () => 1234 - 5;
  });
  afterEach(() => {
    delete rpc.getBlockHeight;
  });
  const twice = (summary: TxSummary) => {
    const fresh = prepared(summary, { lastValidBlockHeight: 5_000 });
    const prepare = vi.fn<() => Promise<Prepared>>().mockResolvedValueOnce({ ok: true, prepared: prepared(summary) }).mockResolvedValueOnce({ ok: true, prepared: fresh });
    const submitPrepared = vi.fn(async (): Promise<TxOutcome> => ({ status: 'confirmed', signature: SIG, slot: 1 }));
    return { fresh, prepare, submitPrepared };
  };

  it('adding: it is prepared again and the wallet gets the fresh transaction', async () => {
    const v = view();
    const { fresh, prepare, submitPrepared } = twice(lpDepositSummary(new PublicKey(v.address), MINT));
    mount(readers({ findPools: vi.fn(async () => search([v])) }), { api: fakeLpApi({ prepareLpDeposit: prepare, submitPrepared }) });
    fireEvent.click(await within(await card()).findByRole('button', { name: 'Add liquidity' }));
    const panel = await screen.findByTestId('lp-add-panel');
    await within(panel).findByRole('button', { name: 'Max SOL' });
    fireEvent.change(within(panel).getByLabelText('SOL to add'), { target: { value: '0.1' } });
    await act(async () => {
      fireEvent.click(within(panel).getByRole('button', { name: 'Review: add liquidity' }));
    });
    await act(async () => {
      fireEvent.click(await within(panel).findByRole('button', { name: 'Sign in wallet' }));
    });
    expect(await within(panel).findByTestId('tx-outcome')).toHaveAttribute('data-status', 'confirmed');
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(submitPrepared.mock.calls.map((c: unknown[]) => c[2])).toEqual([fresh]);
  });

  it('removing: it is prepared again and the wallet gets the fresh transaction', async () => {
    const v = view();
    const p = position(v);
    const { fresh, prepare, submitPrepared } = twice(lpWithdrawSummary(new PublicKey(v.address), MINT, new PublicKey(p.lpAccount)));
    mount(readers({ positions: vi.fn(async () => ({ kind: 'ok' as const, chainNow: 5n, totalShares: 1, positions: [p] })) }), {
      api: fakeLpApi({ prepareLpWithdraw: prepare, submitPrepared }),
    });
    fireEvent.click(await within(await screen.findByTestId('lp-position')).findByRole('button', { name: 'Remove liquidity' }));
    const panel = await screen.findByTestId('lp-remove-panel');
    fireEvent.click(within(within(panel).getByRole('group', { name: 'How much to take out' })).getByRole('button', { name: '50%' }));
    await act(async () => {
      fireEvent.click(within(panel).getByRole('button', { name: 'Review: remove liquidity' }));
    });
    await act(async () => {
      fireEvent.click(await within(panel).findByRole('button', { name: 'Sign in wallet' }));
    });
    expect(await within(panel).findByTestId('tx-outcome')).toHaveAttribute('data-status', 'confirmed');
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(submitPrepared.mock.calls.map((c: unknown[]) => c[2])).toEqual([fresh]);
  });
});

// A launch pool on tier 0 exactly as mainnet holds it (scripts/record-pools-venue-fixture.mjs):
// the launch program opens it with its creator fee switched on, so a trade costs the 0.25%
// trade fee plus the tier's 0.05% creator fee. What LPs keep is unchanged; the creator's part
// is on top and is not theirs, and the panel and its review must say both.
describe('adding to a launch pool that charges the creator fee', () => {
  const launchPool = (): PoolView => {
    const v = view({ origin: 'launch-pool' });
    return { ...v, config: recordedTier(0), snapshot: { ...v.snapshot, pool: { ...v.snapshot.pool, enableCreatorFee: true, creatorFeeOn: v.quoteIsToken0 ? 1 : 2 } } };
  };

  it("the panel says what LPs keep, and that traders also pay the pool's creator on top", async () => {
    mount(readers({ findPools: vi.fn(async () => search([launchPool()])) }));
    fireEvent.click(await within(await card()).findByRole('button', { name: 'Add liquidity' }));
    const before = await screen.findByTestId('lp-before-you-add');
    expect(before).toHaveTextContent(
      "Of each trade, liquidity providers keep 0.200%, read from this pool's fee tier just now. Traders also pay this pool's creator 0.05% of each trade on top; that part is not yours.",
    );
  });

  it('a pool that charges no creator fee says nothing about one', async () => {
    const v = launchPool();
    const off: PoolView = { ...v, origin: 'other', snapshot: { ...v.snapshot, pool: { ...v.snapshot.pool, enableCreatorFee: false } } };
    mount(readers({ findPools: vi.fn(async () => search([off])) }));
    fireEvent.click(await within(await card()).findByRole('button', { name: 'Add liquidity' }));
    const before = await screen.findByTestId('lp-before-you-add');
    expect(before).toHaveTextContent("Of each trade, liquidity providers keep 0.200%, read from this pool's fee tier just now. The vault can change");
    // ("creator" alone also names the token's creator, in the freeze-account risk line.)
    expect(before).not.toHaveTextContent(/pool's creator|creator fee/i);
  });

  it('the review says traders pay 0.3% a trade, the creator fee within it', async () => {
    const v = launchPool();
    const summary = lpDepositSummary(new PublicKey(v.address), MINT, { origin: 'launch-pool', config: recordedTier(0), enableCreatorFee: true });
    const api = fakeLpApi({ prepareLpDeposit: vi.fn(async () => ({ ok: true as const, prepared: prepared(summary) })) });
    mount(readers({ findPools: vi.fn(async () => search([v])) }), { api });
    fireEvent.click(await within(await card()).findByRole('button', { name: 'Add liquidity' }));
    const panel = await screen.findByTestId('lp-add-panel');
    await within(panel).findByRole('button', { name: 'Max SOL' });
    fireEvent.change(within(panel).getByLabelText('SOL to add'), { target: { value: '0.1' } });
    await act(async () => {
      fireEvent.click(within(panel).getByRole('button', { name: 'Review: add liquidity' }));
    });
    await within(panel).findByRole('heading', { name: 'Review: add liquidity' });
    expect(within(panel).getByText('Fee tier', { exact: true }).nextElementSibling?.textContent).toBe(
      '0: traders pay 0.3% a trade (0.25% trade fee, 0.05% creator fee); LPs keep 0.200% of each trade',
    );
  });
});

describe('PercentPicker', () => {
  it('reads 0.01 to 100 with at most two decimals, as basis points', () => {
    expect(parsePercentBps('0.01')).toBe(1n);
    expect(parsePercentBps('50')).toBe(5_000n);
    expect(parsePercentBps('100')).toBe(10_000n);
    expect(parsePercentBps('12.5')).toBe(1_250n);
    for (const bad of ['0', '0.001', '100.01', '101', '-5', 'abc', '', '1e2']) expect(parsePercentBps(bad), bad).toBeNull();
  });
});
