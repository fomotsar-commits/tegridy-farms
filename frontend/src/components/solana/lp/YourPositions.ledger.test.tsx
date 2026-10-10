// Your positions, after the ledger landed (DESIGN 2.C2). A position is headed like its pool,
// its addresses are short with a Copy, its value is exact to the unit, the sentence that fees
// are already in the shares is said once a row, and one press works out what the position
// earned from the share account's own transactions. Nothing is read before the press; a
// set-aside share has no such press; an unread answer never prints 0; a figure under the
// rounding bound reads "none yet" with no sign and no digit; Read 20 more joins the pages.
// The readers are fakes; nothing here touches a chain.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { PublicKey } from '@solana/web3.js';
import { shortAddress } from '../../../lib/solana/lp/format';
import type { LedgerEntry, LedgerFigures, LedgerRead } from '../../../lib/solana/lp/ledger';
import { decodeObservationState } from '../../../lib/solana/lp/ownPrice';
import type { PoolView } from '../../../lib/solana/lp/poolFinder';
import type { Position } from '../../../lib/solana/lp/positions';
import { buildPool, key, observationBytes, viewOf } from '../../../lib/solana/lp/testkit.fixture';
import type { TokenSafety } from '../../../lib/solana/lp/tokenSafety';
import { fakeLpApi, LP_PROGRAM, unusedGateRpc } from './fakeLpWriteApi.fixture';
import type { LpReaders } from './readers';
import { LpInner } from './SolanaLpSection';
import { YourPositions } from './YourPositions';

const wallet = vi.hoisted(() => ({ publicKey: null as null | PublicKey, signTransaction: undefined, signMessage: undefined, connecting: false, wallet: null }));
const conn = vi.hoisted(() => ({ connection: { rpcEndpoint: 'fake' } }));
/** The dollar-price hook, spied: with USD_LINES off it is never even called. */
const usdSpy = vi.hoisted(() => vi.fn(() => ({ prices: { SOL: null, USDC: null, BAYLA: null }, readAt: null })));
vi.mock('./useUsdPrices', () => ({ useUsdPrices: usdSpy }));
vi.mock('@solana/wallet-adapter-react', () => ({ useWallet: () => wallet, useConnection: () => conn }));
vi.mock('../SolanaConnectButton', () => ({ SolanaConnectButton: () => <button type="button">Connect Solana Wallet</button> }));
// web3's address derivation cannot run under jsdom (PoolFinder.findable.test.tsx precedent).
vi.mock('../../../lib/solana/cpswap/program', async (orig) => {
  const { PublicKey: Key } = await import('@solana/web3.js');
  return { ...(await orig<typeof import('../../../lib/solana/cpswap/program')>()), publicTierConfig: () => new Key(new Uint8Array(32).fill(41)) };
});

const OWNER = key();
const MINT = key();
const M = MINT.toBase58();
const SHORT = shortAddress(M);
const SOL = 10n ** 9n;
const TOK = 10n ** 6n;
const BUTTON = 'Work out what this position earned';
const FEES = 'Your fees are already in your shares. There is nothing to claim.';
const NO_TRADE_SINCE = 'No trade has reached this pool since you entered, so there is nothing from trades yet.';
/** 2026-10-03 22:30:24 UTC, the owner's own deposit (MAINNET_FACTS row 3). */
const AT_SEC = 1_791_066_624;
const AT_TEXT = '2026-10-03 22:30 UTC';

/**
 * A pool for MINT: 10 SOL and 1,000 tokens (0.01 SOL a token), 100 shares issued, on tier 1.
 * Its price record says no trade has ever reached it, unless a case says otherwise.
 */
function view(o: { history?: PoolView['history'] } = {}): PoolView {
  const b = buildPool({ plain: true, mint: MINT, configIndex: 1, quoteReserve: 10n * SOL, tokenReserve: 1_000n * TOK, lpSupply: 100n * SOL, openTime: 1n });
  const obs = decodeObservationState(observationBytes({ pool: b.address, initialized: false }));
  if (!obs) throw new Error('the price record bytes do not decode');
  return viewOf(b, { sol: 10n * SOL, tok: 1_000n * TOK, history: o.history ?? { kind: 'ok', obs } });
}

const okToken: TokenSafety = {
  kind: 'read', mint: M, verdict: 'ok', blocks: [], warnings: [], name: 'Corn', symbol: 'CORN', metadataSource: 'metaplex',
  facts: { program: 'spl-token', mintAuthority: null, freezeAuthority: null, supply: 1n, decimals: 6, isInitialized: true, extensions: [], metadataPointer: null, tokenMetadata: null },
};
const blockedToken: TokenSafety = { ...okToken, verdict: 'blocked', blocks: [{ code: 'extension', text: 'It uses a transfer hook. The pool program does not accept tokens with it.' }] } as TokenSafety;

/** Ten of the pool's hundred shares: worth 1 SOL and 100 tokens, 10% of the pool. */
function position(v: PoolView, over: Partial<Position> = {}): Position {
  const coin = 1n * SOL;
  const token = 100n * TOK;
  return {
    lpMint: v.snapshot.pool.lpMint,
    lpAccount: key().toBase58(),
    lpAmount: 10n * SOL,
    placement: 'found',
    placementDetail: null,
    pool: { kind: 'pool', view: v },
    value: v.quoteIsToken0 ? { token0: coin, token1: token, sharePct: 10 } : { token0: token, token1: coin, sharePct: 10 },
    tooSmall: false,
    ...over,
  };
}

function readers(o: Partial<LpReaders> = {}, positions: Position[] = []): LpReaders {
  return {
    programId: LP_PROGRAM,
    safety: vi.fn(async (mints: string[]) => new Map(mints.map((m) => [m, { ...okToken, mint: m }]))),
    findPools: vi.fn(async () => ({ kind: 'unread' as const, detail: 'not asked here', index: { kind: 'unread' as const, detail: 'not asked here' } })),
    outsidePrice: vi.fn(async () => ({ kind: 'unread' as const, detail: 'not asked here' })),
    positions: vi.fn(async () => ({ kind: 'ok' as const, positions, chainNow: 5n, totalShares: positions.length })),
    feeTiers: vi.fn(async () => ({ kind: 'ok' as const, openingDeposits: null, tiers: [] })),
    wallet: vi.fn(async () => ({ kind: 'unread' as const, detail: 'not asked here' })),
    placeShareOnChain: vi.fn(async () => ({ kind: 'not-found' as const })),
    ...o,
  } as LpReaders;
}

const AT = { slot: 100, blockTime: AT_SEC, final: true };
let n = 0;
const sig = () => `${++n}`.padEnd(88, 'x');
const deposit = (o: { lp: bigint; token: bigint; coin: bigint; lpBefore?: bigint; blockTime?: number; final?: boolean }): LedgerEntry =>
  ({ kind: 'deposit', ...AT, signature: sig(), blockTime: o.blockTime ?? AT_SEC, final: o.final ?? true, lp: o.lp, token: o.token, coin: o.coin, lpBefore: o.lpBefore ?? 0n });
const other = (): LedgerEntry => ({ kind: 'other', ...AT, signature: sig() });

/** The owner's own shape: one deposit, nothing moved since, every difference under the bound. */
function figures(over: Partial<LedgerFigures> = {}): LedgerFigures {
  return {
    putIn: { token: 100n * TOK, coin: 1n * SOL, count: 1 },
    takenOut: null,
    worthNow: { token: 100n * TOK, coin: 1n * SOL },
    holdWorth: 2n * SOL,
    nowAndOutWorth: 2n * SOL,
    versusHolding: { kind: 'none-yet' },
    growth: { kind: 'none-yet' },
    priceEffect: { kind: 'none-yet' },
    locked: null,
    since: AT_SEC,
    provenShares: 10n * SOL,
    otherShares: null,
    ...over,
  };
}
const WINDOW = { count: 1, oldest: AT_SEC, more: false };
const okRead = (over: Partial<LedgerFigures> = {}, c: 'A' | 'B' = 'A', entries: LedgerEntry[] = [deposit({ lp: 10n * SOL, token: 100n * TOK, coin: 1n * SOL })]): LedgerRead =>
  ({ kind: 'ok', figures: figures(over), entries, window: { ...WINDOW, count: entries.length }, case: c });

const mount = (r: LpReaders) => render(<YourPositions readers={r} owner={OWNER} />);
const row = () => screen.findByTestId('lp-position');
const block = (r: HTMLElement) => within(r).getByTestId('lp-ledger');
const workOut = (r: HTMLElement) => within(r).getByRole('button', { name: BUTTON });
/** A Row's value: the text beside its label. */
const value = (scope: HTMLElement, label: string) => within(scope).getByText(label, { exact: true }).nextElementSibling?.textContent ?? null;
async function pressed(r: LpReaders): Promise<HTMLElement> {
  mount(r);
  const li = await row();
  fireEvent.click(workOut(li));
  await waitFor(() => expect(within(li).queryByRole('button', { name: BUTTON })).toBeNull());
  return li;
}

beforeEach(() => {
  wallet.publicKey = OWNER;
  usdSpy.mockClear();
});
afterEach(() => cleanup());

describe('the row, top to bottom', () => {
  it('is headed like its pool, says the share as a sentence, shows the pool short, and prints its value to the unit', async () => {
    const v = view();
    const p = position(v);
    mount(readers({}, [p]));
    const li = await row();
    // The registry names the pair, never the token's own metadata: this mint has no room, so its short address heads the row.
    expect(within(li).getByRole('heading', { level: 3 })).toHaveTextContent(`${SHORT} / SOL · 1% tier`);
    expect(within(li).getByText('Your share:', { exact: false })).toHaveTextContent('Your share: 10.0000% of the pool');
    const pool = within(li).getByRole('group', { name: 'Pool' });
    expect(pool).toHaveTextContent(shortAddress(v.address));
    expect(within(pool).queryByText(v.address)).toBeNull();
    expect(within(pool).getByRole('button', { name: 'Copy' })).toBeInTheDocument();
    expect(value(li, 'Worth if withdrawn now')).toBe(`1 SOL and 100 ${SHORT}`);
    expect(within(li).getAllByText(FEES)).toHaveLength(1);
    expect(value(li, 'Pool swaps')).toBe('open');
    expect(value(li, 'Withdrawals')).toBe('open');
    // The rest is behind one fold.
    const fold = within(li).getByText('More about this share').closest('details')!;
    expect(fold).not.toHaveAttribute('open');
    expect(within(fold).getByRole('group', { name: 'Pool share token' })).toHaveTextContent(shortAddress(p.lpMint));
    expect(within(fold).getByRole('group', { name: 'Share account' })).toHaveTextContent(shortAddress(p.lpAccount));
    expect(value(fold, 'You hold')).toBe('10 shares');
    expect(within(fold).getByRole('group', { name: 'Token' })).toHaveTextContent(SHORT);
    expect(value(fold, 'Calls itself')).toBe('Corn (CORN)');
    expect(value(fold, 'Token check')).toBe('no problems found');
    expect(li.textContent).not.toMatch(/—/);
  });

  it('the fees sentence is said once on every placed share, set aside or not', async () => {
    const mine = view();
    const blockedMint = key();
    const b = buildPool({ plain: true, mint: blockedMint, configIndex: 1, quoteReserve: 10n * SOL, tokenReserve: 1_000n * TOK, lpSupply: 100n * SOL, openTime: 1n });
    const ofBlocked = viewOf(b, { sol: 10n * SOL, tok: 1_000n * TOK });
    const unplaced = position(mine, { lpMint: key().toBase58(), placement: 'not-found', pool: null, value: null });
    mount(readers({
      safety: vi.fn(async (mints: string[]) => new Map(mints.map((m) => [m, m === blockedMint.toBase58() ? { ...blockedToken, mint: m } : { ...okToken, mint: m }]))),
    }, [position(mine), position(ofBlocked), unplaced]));
    const rows = await screen.findAllByTestId('lp-position');
    expect(rows).toHaveLength(3);
    expect(screen.getAllByText(FEES)).toHaveLength(2);
    for (const r of rows) expect(within(r).queryAllByText(FEES).length).toBeLessThanOrEqual(1);
    // The unplaced share: no pool, so no sentence, and still its fold with what it holds (in base
    // units: without the pool, the share mint's decimals were not read, as before this change).
    const un = rows.find((r) => r.getAttribute('data-pool-kind') === 'none')!;
    expect(within(un).queryByText(FEES)).toBeNull();
    expect(value(within(un).getByText('More about this share').closest('details')!, 'You hold')).toBe('10000000000 base units');
  });

  it('the stamp sits under the heading with the one Read my positions again, before the rows', async () => {
    const v = view();
    const r = readers({}, [position(v)]);
    mount(r);
    const li = await row();
    const section = screen.getByTestId('lp-positions');
    const stamp = within(section).getByTestId('lp-read-at');
    const again = within(section).getAllByRole('button', { name: 'Read my positions again' });
    expect(again).toHaveLength(1);
    expect(stamp.compareDocumentPosition(li) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(again[0]!.compareDocumentPosition(li) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(again[0]!);
    await waitFor(() => expect(r.positions).toHaveBeenCalledTimes(2));
  });

  it('with USD_LINES off: no dollar anywhere, and the price hook is never even called', async () => {
    mount(readers({}, [position(view())]));
    const li = await row();
    expect(li.textContent).not.toMatch(/\$/);
    expect(usdSpy).not.toHaveBeenCalled();
  });

  it('the addresses link to the explorer once the write code has loaded', async () => {
    const v = view();
    const p = position(v);
    const api = fakeLpApi();
    render(
      <MemoryRouter initialEntries={['/pools']}>
        <LpInner readers={readers({}, [p])} writes={{ mode: 'on', load: vi.fn(async () => api), gateRpc: unusedGateRpc }} />
      </MemoryRouter>,
    );
    const li = await row();
    await waitFor(() => expect(within(li).getAllByRole('link', { name: 'Explorer' }).length).toBeGreaterThanOrEqual(4));
    const hrefs = within(li).getAllByRole('link', { name: 'Explorer' }).map((a) => a.getAttribute('href'));
    for (const addr of [v.address, p.lpMint, p.lpAccount, v.tokenMint]) expect(hrefs).toContain(`https://explorer.test/address/${addr}`);
  });
});

describe('the ledger block', () => {
  it('with readers.ledger absent: no button and no block', async () => {
    mount(readers({}, [position(view())]));
    const li = await row();
    expect(within(li).queryByRole('button', { name: BUTTON })).toBeNull();
    expect(within(li).queryByTestId('lp-ledger')).toBeNull();
  });

  it('reads nothing before the press; the press reads this share, with what it holds, against its pool', async () => {
    const v = view();
    const p = position(v);
    const ledger = vi.fn(async () => okRead());
    mount(readers({ ledger }, [p]));
    const li = await row();
    const button = workOut(li);
    expect(button).toHaveClass('min-h-[44px]');
    expect(ledger).not.toHaveBeenCalled();
    expect(within(li).queryByText('Put in')).toBeNull();
    fireEvent.click(button);
    await within(li).findByText('Put in');
    expect(ledger).toHaveBeenCalledTimes(1);
    expect(ledger).toHaveBeenCalledWith({ lpAccount: p.lpAccount, lpMint: p.lpMint, owner: OWNER, lpAmount: p.lpAmount }, v);
  });

  it('never on a set-aside share, even with a reader that could', async () => {
    const v = view();
    const ledger = vi.fn(async () => okRead());
    mount(readers({ ledger, safety: vi.fn(async (mints: string[]) => new Map(mints.map((m) => [m, { ...blockedToken, mint: m }]))) }, [position(v)]));
    const li = await row();
    expect(li).toHaveTextContent('Set aside: its token is blocked on this site.');
    expect(within(li).queryByRole('button', { name: BUTTON })).toBeNull();
    expect(within(li).queryByTestId('lp-ledger')).toBeNull();
    expect(ledger).not.toHaveBeenCalled();
  });

  it('ok, Case A: the rows in order, exact to the unit; every "none yet" line has no digit and no sign; the stamp with Read again', async () => {
    const v = view();
    const ledger = vi.fn(async () => okRead());
    const li = await pressed(readers({ ledger }, [position(v)]));
    const b = block(li);
    const labels = ['Since', 'Put in', 'Versus holding', 'Growth per share', 'Price effect'];
    const seen = labels.map((l) => within(b).getByText(l, { exact: true }));
    for (let i = 1; i < seen.length; i++) expect(seen[i - 1]!.compareDocumentPosition(seen[i]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(value(b, 'Since')).toBe(AT_TEXT);
    expect(value(b, 'Put in')).toBe(`1 SOL and 100 ${SHORT}, in 1 deposit, since ${AT_TEXT}`);
    expect(within(b).queryByText('Taken out')).toBeNull();
    expect(within(b).queryByText('Locked at opening')).toBeNull();
    for (const l of ['Versus holding', 'Growth per share', 'Price effect']) {
      const t = value(b, l);
      expect(t).toBe('none yet');
      expect(t).not.toMatch(/\d/);
      expect(t).not.toMatch(/[+\-−]/);
    }
    // The pool's own record says no trade has ever reached it: the growth line says why there is nothing.
    expect(within(b).getByText(NO_TRADE_SINCE)).toBeInTheDocument();
    expect(b).not.toHaveTextContent('arrived another way');
    expect(within(b).getByText(/^From 1 transaction of your share account, back to 2026-10-03 22:30 UTC, read \d+ s ago\. Exact to a few of the smallest units, which rounding cannot tell from zero\.$/)).toBeInTheDocument();
    expect(within(b).queryByRole('button', { name: 'Read 20 more' })).toBeNull();
    expect(within(b).getByTestId('lp-read-at')).toBeInTheDocument();
    // Read again reads the same share again; the big button does not come back.
    fireEvent.click(within(b).getByRole('button', { name: 'Read again' }));
    await waitFor(() => expect(ledger).toHaveBeenCalledTimes(2));
    expect(within(li).queryByRole('button', { name: BUTTON })).toBeNull();
    expect(b.textContent).not.toMatch(/—/);
  });

  it('a figure above the bound prints signed, with its sentence; a deposit not final yet says so', async () => {
    const v = view();
    const read = okRead(
      { growth: { kind: 'amount', coin: 2_000_000n }, priceEffect: { kind: 'amount', coin: -5_000_000n }, versusHolding: { kind: 'amount', coin: -3_000_000n }, holdWorth: 2n * SOL, nowAndOutWorth: 2n * SOL - 3_000_000n },
      'A',
      [deposit({ lp: 10n * SOL, token: 100n * TOK, coin: 1n * SOL, final: false })],
    );
    const li = await pressed(readers({ ledger: vi.fn(async () => read) }, [position(v)]));
    const b = block(li);
    expect(value(b, 'Growth per share')).toBe('+0.002 SOL: how much more your shares are worth than a fee-free pool would have made them, from trades and anything else sent to this pool. Fees stay in the pool; there is nothing to claim.');
    expect(value(b, 'Price effect')).toBe('-0.005 SOL: what the price moving since you put in did to a pool position compared with holding (what people call impermanent loss).');
    expect(value(b, 'Versus holding')).toBe('-0.003 SOL at this pool’s price now. Holding what you put in would be worth 2 SOL; what you hold now plus what you took out is worth 1.997 SOL.');
    expect(value(b, 'Put in')).toBe(`1 SOL and 100 ${SHORT}, in 1 deposit, since ${AT_TEXT} (not final yet)`);
    // Growth above the bound with no trade ever: it came from outside a trade.
    expect(within(b).getByText('No trade has reached this pool, so this growth came from tokens sent to the pool outside a trade.')).toBeInTheDocument();
  });

  it('ok, Case B: the other-shares line names them and their worth, and Taken out and Locked at opening print when set', async () => {
    const v = view();
    const read = okRead({
      takenOut: { token: 10n * TOK, coin: 100_000_000n, count: 1 },
      locked: 20n,
      otherShares: { lp: 1n, worth: { token: 1n * TOK, coin: 10_000_000n } },
    }, 'B');
    const li = await pressed(readers({ ledger: vi.fn(async () => read) }, [position(v)]));
    const b = block(li);
    expect(within(b).getByText(`0.000000001 shares arrived another way (sent to this account, or older than the transactions read): worth 0.01 SOL and 1 ${SHORT} now, not counted above.`)).toBeInTheDocument();
    expect(value(b, 'Taken out')).toBe(`0.1 SOL and 10 ${SHORT}, in 1 withdrawal`);
    expect(value(b, 'Locked at opening')).toBe('0.00000002 SOL: the 0.0000001 pool shares (100 of the smallest unit) every new pool keeps.');
  });

  it('worth-only prints the reason and no figure', async () => {
    const v = view();
    const read: LedgerRead = { kind: 'worth-only', why: 'shares-left', entries: [other()], window: { count: 1, oldest: AT_SEC, more: false } };
    const li = await pressed(readers({ ledger: vi.fn(async () => read) }, [position(v)]));
    const b = block(li);
    expect(within(b).getByText('Some shares left this account without a withdrawal this pool recorded (sent out, or burned), so what they cost is not known. Earned and versus holding cannot be worked out for this position.')).toBeInTheDocument();
    for (const l of ['Put in', 'Versus holding', 'Growth per share', 'Price effect']) expect(within(b).queryByText(l)).toBeNull();
    expect(within(b).getByText(/^From 1 transaction of your share account/)).toBeInTheDocument();
    // Worth now needs no history: it stays on the row above the block.
    expect(value(li, 'Worth if withdrawn now')).toBe(`1 SOL and 100 ${SHORT}`);
  });

  it('unread prints the detail and never 0', async () => {
    const v = view();
    const read: LedgerRead = { kind: 'unread', detail: 'the node is away' };
    const li = await pressed(readers({ ledger: vi.fn(async () => read) }, [position(v)]));
    const b = block(li);
    expect(within(b).getByText('Your share account’s history could not be read (the node is away).')).toBeInTheDocument();
    expect(b.textContent).not.toMatch(/\b0\b/);
    expect(b.textContent).not.toMatch(/none yet/);
    expect(within(b).getByRole('button', { name: 'Read again' })).toBeInTheDocument();
  });

  it('a reader that throws is unread, with the error as the detail', async () => {
    const v = view();
    const li = await pressed(readers({ ledger: vi.fn(async () => { throw new Error('socket closed'); }) }, [position(v)]));
    expect(within(block(li)).getByText('Your share account’s history could not be read (socket closed).')).toBeInTheDocument();
  });

  it('paused prints the paused sentence', async () => {
    const v = view();
    const li = await pressed(readers({ ledger: vi.fn(async (): Promise<LedgerRead> => ({ kind: 'paused' })) }, [position(v)]));
    expect(within(block(li)).getByText('History reads are paused so this page’s live reads keep working. Try again in about a minute.')).toBeInTheDocument();
  });

  it('Read 20 more joins the pages: the figures are over both, at the live pool, not the older page alone', async () => {
    const v = view();
    const p = position(v);
    // Newest first: the second deposit is on the first page, the first (from nothing) on the next.
    const dep2 = deposit({ lp: 6n * SOL, token: 60n * TOK, coin: 600_000_000n, lpBefore: 4n * SOL, blockTime: AT_SEC });
    const dep1 = deposit({ lp: 4n * SOL, token: 40n * TOK, coin: 400_000_000n, lpBefore: 0n, blockTime: AT_SEC - 600 });
    const first: LedgerRead = { kind: 'worth-only', why: 'run-start-not-read', entries: [dep2], window: { count: 1, oldest: AT_SEC, more: true } };
    // What the reader says of the older page on its own is not what the row prints: the row joins the pages.
    const older: LedgerRead = { kind: 'ok', figures: figures({ putIn: { token: 40n * TOK, coin: 400_000_000n, count: 1 }, provenShares: 4n * SOL }), entries: [dep1], window: { count: 1, oldest: AT_SEC - 600, more: false }, case: 'B' };
    const ledger = vi.fn(async (_s: unknown, _v: unknown, o?: { before?: string }) => (o?.before ? older : first));
    const li = await pressed(readers({ ledger }, [p]));
    const b = block(li);
    expect(within(b).getByText('Your history in this pool goes back further than the 1 transaction this page reads (the oldest read is from 2026-10-03 22:30 UTC), so what you put in could not be fully read.')).toBeInTheDocument();
    const more = within(b).getByRole('button', { name: 'Read 20 more' });
    expect(more).toHaveClass('min-h-[44px]');
    fireEvent.click(more);
    await within(b).findByText('Put in');
    expect(ledger).toHaveBeenLastCalledWith({ lpAccount: p.lpAccount, lpMint: p.lpMint, owner: OWNER, lpAmount: p.lpAmount }, v, { before: dep2.signature });
    // Both deposits: 0.4 + 0.6 SOL and 40 + 60 tokens, from the older one; the books balance (10 shares held), so nothing "arrived another way".
    expect(value(b, 'Put in')).toBe(`1 SOL and 100 ${SHORT}, in 2 deposits, since 2026-10-03 22:20 UTC`);
    expect(value(b, 'Since')).toBe('2026-10-03 22:20 UTC');
    expect(b).not.toHaveTextContent('arrived another way');
    expect(within(b).getByText(/^From 2 transactions of your share account, back to 2026-10-03 22:20 UTC/)).toBeInTheDocument();
    expect(within(b).queryByRole('button', { name: 'Read 20 more' })).toBeNull();
  });

  it('after five pages the page says older history is not read, and offers no more', async () => {
    const v = view();
    const ledger = vi.fn(async (): Promise<LedgerRead> => ({ kind: 'worth-only', why: 'run-start-not-read', entries: [other()], window: { count: 1, oldest: AT_SEC, more: true } }));
    const li = await pressed(readers({ ledger }, [position(v)]));
    const b = block(li);
    for (let page = 2; page <= 5; page++) {
      fireEvent.click(within(b).getByRole('button', { name: 'Read 20 more' }));
      await waitFor(() => expect(ledger).toHaveBeenCalledTimes(page));
      await within(b).findByText(new RegExp(`^From ${page} transactions of your share account`));
    }
    expect(within(b).queryByRole('button', { name: 'Read 20 more' })).toBeNull();
    expect(within(b).getByText('Older history is not read by this page.')).toBeInTheDocument();
  });

  it('a share whose amount changed drops its answer: the press is offered again, nothing stale stays', async () => {
    const v = view();
    const p = position(v);
    const positions = vi.fn()
      .mockResolvedValueOnce({ kind: 'ok', positions: [p], chainNow: 5n, totalShares: 1 })
      .mockResolvedValueOnce({ kind: 'ok', positions: [{ ...p, lpAmount: 5n * SOL }], chainNow: 6n, totalShares: 1 });
    const li = await pressed(readers({ ledger: vi.fn(async () => okRead()), positions }, []));
    expect(within(li).getByText('Put in')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Read my positions again' }));
    await waitFor(() => expect(within(li).queryByText('Put in')).toBeNull());
    expect(workOut(li)).toBeInTheDocument();
  });
});

describe('with USD_LINES on (the committed switch is off; flipped here for the line’s words)', () => {
  it('prints about $ at this pool’s own price and Jupiter’s coin price, with its age', async () => {
    vi.resetModules();
    vi.doMock('../../../lib/solana/lp/usd', async (orig) => ({ ...(await orig<typeof import('../../../lib/solana/lp/usd')>()), USD_LINES: 'on' }));
    vi.doMock('./useUsdPrices', () => ({ useUsdPrices: () => ({ prices: { SOL: 150, USDC: null, BAYLA: null }, readAt: Date.now() - 3_000 }) }));
    try {
      const { YourPositions: Fresh } = await import('./YourPositions');
      render(<Fresh readers={readers({}, [position(view())])} owner={OWNER} />);
      const li = await row();
      // 1 SOL plus 100 tokens at the pool's own 0.01 SOL a token is 2 SOL; at Jupiter's $150 that is $300.
      expect(within(li).getByText(/^about \$300\.00, at this pool’s own price, at Jupiter’s SOL price read \d+ s ago$/)).toBeInTheDocument();
    } finally {
      vi.doUnmock('../../../lib/solana/lp/usd');
      vi.doUnmock('./useUsdPrices');
      vi.resetModules();
    }
  });
});
