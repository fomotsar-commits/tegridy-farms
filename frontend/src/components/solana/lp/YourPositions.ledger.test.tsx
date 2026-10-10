// Your positions, with what each one earned. A position is headed like its pool, its
// addresses are short with the whole one a press away, and it says with no press that fees
// are already in the shares. The earnings block reads by itself on the first two main
// positions and on a press everywhere else; never for a set-aside or unplaced share. A read
// that is running, paused, unread or worth-only says so and never prints a zero; a figure
// under the rounding bound reads "none yet" with no sign and no digit; the only line that
// names a yearly figure is the pace sentence, whole. The readers are fakes: no chain here.

import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PublicKey } from '@solana/web3.js';
import { FORECAST_WORDS, shortAddress } from '../../../lib/solana/lp/format';
import { ledgerFigures, ledgerText, ledgerUnits, type LedgerEntry, type LedgerFigures, type LedgerRead } from '../../../lib/solana/lp/ledger';
import { decodeObservationState } from '../../../lib/solana/lp/ownPrice';
import { PACE_SENTENCE } from '../../../lib/solana/lp/pace';
import type { PoolView } from '../../../lib/solana/lp/poolFinder';
import type { Position } from '../../../lib/solana/lp/positions';
import { buildPool, key, observationBytes, viewOf } from '../../../lib/solana/lp/testkit.fixture';
import { BAYLA_MINT, type TokenSafety } from '../../../lib/solana/lp/tokenSafety';
import { fakeLpApi, LP_PROGRAM, unusedGateRpc } from './fakeLpWriteApi.fixture';
import type { LpReaders } from './readers';
import { LpInner } from './SolanaLpSection';
import { YourPositions } from './YourPositions';

const wallet = vi.hoisted(() => ({ publicKey: null as null | PublicKey, signTransaction: undefined, signMessage: undefined, connecting: false, wallet: null }));
const conn = vi.hoisted(() => ({ connection: { rpcEndpoint: 'fake' } }));
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
const DAY = 86_400;
const BUTTON = 'Work out what this position earned';
const READING = 'Working out what this position earned…';
const FEES = 'Fees you earn are already inside your shares: there is nothing to claim, and you receive them when you remove liquidity.';
const AGAIN = 'Work it out again';
const WORKED_OUT = 'Worked out.';
const FEES_NOTE = 'Your part of this pool’s trading fees. Tokens sent straight into the pool count too.';
const VERSUS = 'Compared with keeping both tokens in your wallet.';
const PRICE_DID_IT = 'So far the price move has cost more than the fees earned.';
const PRICE_EFFECT = 'What the price move alone did.';
const NO_TRADE_YET = 'No trade has reached this pool yet, so there are no fees yet.';
const PAUSED = 'History reads are paused so this page’s live reads keep working. Try again in about a minute.';
/** 2026-10-03 22:30:24 UTC. */
const AT_SEC = 1_791_066_624;
const AT_TEXT = '2026-10-03 22:30 UTC';

type Trades = 'never' | 'traded' | 'not-read';

/**
 * A pool: 10 SOL and 1,000 tokens (0.01 SOL a token), 100 shares issued, on tier 1. Its
 * price record says no trade has ever reached it, unless a case says it has (`traded`) or
 * that the record was not read. `feesShow`: the pool's own counters account for its growth,
 * as a pool that grew by trades does: isqrt(10 SOL x 1,000 tokens) is 3,162,277,660 against
 * 3,162,000,000 shares (277,660 more), and the venue's uncollected 200,000 lamports mean the
 * LPs' part of those trades was 1,050,000 (x 84 / 16), which is 166,024 of that growth.
 */
function view(o: { trades?: Trades; mint?: PublicKey; sol?: bigint; feesShow?: boolean } = {}): PoolView {
  const sol = o.sol ?? 10n * SOL;
  const grown = o.feesShow ? { lpSupply: 3_162_000_000n, protocolFeesSol: 200_000n } : { lpSupply: 100n * SOL };
  const b = buildPool({ plain: true, mint: o.mint ?? MINT, configIndex: 1, quoteReserve: sol, tokenReserve: 1_000n * TOK, ...grown, openTime: 1n });
  if (o.trades === 'not-read') return viewOf(b, { sol, tok: 1_000n * TOK });
  const obs = decodeObservationState(observationBytes(o.trades === 'traded' ? { pool: b.address, lastUpdate: BigInt(AT_SEC + 60) } : { pool: b.address, initialized: false }));
  if (!obs) throw new Error('the price record bytes do not decode');
  return viewOf(b, { sol, tok: 1_000n * TOK, history: { kind: 'ok', obs } });
}

const okToken: TokenSafety = {
  kind: 'read', mint: M, verdict: 'ok', blocks: [], warnings: [], name: 'Corn', symbol: 'CORN', metadataSource: 'metaplex',
  facts: { program: 'spl-token', mintAuthority: null, freezeAuthority: null, supply: 1n, decimals: 6, isInitialized: true, extensions: [], metadataPointer: null, tokenMetadata: null },
};
const refusedToken: TokenSafety = { ...okToken, verdict: 'blocked', blocks: [{ code: 'extension', text: 'It uses a transfer hook. The pool program does not accept tokens with it.' }] } as TokenSafety;
const warnedToken: TokenSafety = { ...okToken, verdict: 'warn', warnings: [{ code: 'freeze-authority', text: 'Its creator can freeze any account that holds it.' }] } as TokenSafety;

/** Ten of the pool's hundred shares: worth 1 SOL and 100 tokens, 10% of the pool. */
function position(v: PoolView, over: Partial<Position> = {}): Position {
  const coin = v.quoteReserve / 10n;
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

/** `chainNow`: the chain's clock at the positions read; 5 by default, long before any deposit here, so no pace is worked out. */
function readers(o: Partial<LpReaders> = {}, positions: Position[] = [], chainNow = 5n): LpReaders {
  return {
    programId: LP_PROGRAM,
    safety: vi.fn(async (mints: string[]) => new Map(mints.map((m) => [m, { ...okToken, mint: m }]))),
    findPools: vi.fn(async () => ({ kind: 'unread' as const, detail: 'not asked here', index: { kind: 'unread' as const, detail: 'not asked here' } })),
    outsidePrice: vi.fn(async () => ({ kind: 'unread' as const, detail: 'not asked here' })),
    positions: vi.fn(async () => ({ kind: 'ok' as const, positions, chainNow, totalShares: positions.length })),
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
const amount = (coin: bigint) => ({ kind: 'amount' as const, coin });

/** One deposit, nothing moved since, every difference under the bound. */
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
const okRead = (over: Partial<LedgerFigures> = {}, c: 'A' | 'B' = 'A', entries: LedgerEntry[] = [deposit({ lp: 10n * SOL, token: 100n * TOK, coin: 1n * SOL })]): LedgerRead =>
  ({ kind: 'ok', figures: figures(over), entries, window: { count: entries.length, oldest: AT_SEC, more: false }, case: c });

const mount = (r: LpReaders) => render(<YourPositions readers={r} owner={OWNER} />);
/** A position's row, by its share account (two shares of one pool have one share token). */
const rowOf = async (p: Position) => (await screen.findAllByTestId('lp-position')).find((li) => li.textContent?.includes(shortAddress(p.lpAccount)))!;
const block = (r: HTMLElement) => within(r).getByTestId('lp-ledger');
const state = (r: HTMLElement) => block(r).getAttribute('data-ledger');
/** A Row's value: the text beside its label. */
const value = (scope: HTMLElement, label: string) => within(scope).getByText(label, { exact: true }).nextElementSibling?.textContent ?? null;
/** The sentence under an earnings line. */
const note = (scope: HTMLElement, label: string) => within(scope).getByText(label, { exact: true }).parentElement?.nextElementSibling?.textContent ?? null;
/** The block's one status line: always on the page, so a screen reader hears each answer when it arrives. */
const status = (scope: HTMLElement) => within(scope).getByRole('status');
/** The paragraphs of a scope, whole (a date inside a sentence is its own element, so it is never split across lines). */
const sentences = (scope: HTMLElement) => Array.from(scope.querySelectorAll('p')).map((el) => el.textContent ?? '');
/** Mount one position: it is the first main share, so its earnings are worked out with no press. */
async function shown(r: LpReaders, p: Position): Promise<HTMLElement> {
  mount(r);
  const li = await rowOf(p);
  await waitFor(() => expect(state(li)).not.toBe('reading'));
  return li;
}

beforeEach(() => {
  wallet.publicKey = OWNER;
});
afterEach(() => cleanup());

describe('the row, top to bottom', () => {
  it('is headed like its pool, says the share as a sentence, shows the pool short, and prints its worth to the unit', async () => {
    const v = view();
    const p = position(v);
    mount(readers({}, [p]));
    const li = await rowOf(p);
    // The registry names the pair, never the token's own metadata: this mint has no room, so its short address heads the row.
    expect(within(li).getByRole('heading', { level: 3 })).toHaveTextContent(`${SHORT} / SOL · 1% tier`);
    expect(within(li).getByText('Your share: 10.0000% of the pool')).toBeInTheDocument();
    const pool = within(li).getByRole('group', { name: 'Pool' });
    expect(pool).toHaveTextContent(shortAddress(v.address));
    expect(within(pool).queryByText(v.address)).toBeNull();
    expect(within(pool).getByRole('button', { name: 'Copy' })).toHaveClass('min-h-[44px]');
    // The whole address is one press away.
    fireEvent.click(within(pool).getByRole('button', { name: /Show whole/ }));
    expect(within(pool).getByText(v.address)).toBeInTheDocument();
    expect(value(li, 'Worth now')).toBe(`1 SOL and 100 ${SHORT}`);
    expect(value(li, 'Pool swaps')).toBe('open');
    expect(value(li, 'Withdrawals')).toBe('open');
    // The rest is behind one fold, closed, with a 44px summary.
    const fold = within(li).getByText('More about this share').closest('details')!;
    expect(fold).not.toHaveAttribute('open');
    expect(within(fold).getByText('More about this share')).toHaveClass('min-h-[44px]');
    expect(within(fold).getByRole('group', { name: 'Pool share token' })).toHaveTextContent(shortAddress(p.lpMint));
    expect(within(fold).getByRole('group', { name: 'Share account' })).toHaveTextContent(shortAddress(p.lpAccount));
    expect(value(fold, 'You hold')).toBe('10 shares');
    expect(within(fold).getByRole('group', { name: 'Token' })).toHaveTextContent(SHORT);
    expect(value(fold, 'Calls itself')).toBe('Corn (CORN)');
    expect(value(fold, 'Token check')).toBe('no problems found');
    expect(within(li).getAllByText('Token check')).toHaveLength(1);
    expect(li.textContent).not.toMatch(/—/);
  });

  it('says with no press that there is nothing to claim: once on every share whose pool was read, set aside or not, and with no reader for history at all', async () => {
    const mine = view();
    const refusedMint = key();
    const ofRefused = view({ mint: refusedMint });
    const placed = position(mine);
    const aside = position(ofRefused);
    const unplaced = position(mine, { lpMint: key().toBase58(), placement: 'not-found', pool: null, value: null });
    mount(readers({
      safety: vi.fn(async (mints: string[]) => new Map(mints.map((m) => [m, m === refusedMint.toBase58() ? { ...refusedToken, mint: m } : { ...okToken, mint: m }]))),
    }, [placed, aside, unplaced]));
    const rows = await screen.findAllByTestId('lp-position');
    expect(rows).toHaveLength(3);
    // No history reader here, so nothing to press and nothing read: the sentence waits on neither.
    expect(screen.queryByRole('button', { name: BUTTON })).toBeNull();
    expect(screen.queryByTestId('lp-ledger')).toBeNull();
    expect(within(await rowOf(placed)).getAllByText(FEES)).toHaveLength(1);
    expect(within(await rowOf(aside)).getAllByText(FEES)).toHaveLength(1);
    expect(await rowOf(placed)).toHaveAttribute('data-lp-mint', placed.lpMint);
    // A share with no pool: nothing is claimed about a pool this page could not name. It keeps its share token, short, and what it holds.
    const un = await rowOf(unplaced);
    expect(within(un).queryByText(FEES)).toBeNull();
    expect(within(un).queryByRole('heading', { level: 3 })).toBeNull();
    const shareToken = within(un).getByRole('group', { name: 'Pool share token' });
    expect(shareToken).toHaveTextContent(shortAddress(unplaced.lpMint));
    expect(shareToken.closest('details')).toBeNull();
    expect(value(un, 'You hold')).toBe('10000000000 base units');
  });

  it('a token with a warning, or one this site does not add to, says its check on the row; only a clean check sits in the fold', async () => {
    const v = view();
    const p = position(v);
    mount(readers({ safety: vi.fn(async (mints: string[]) => new Map(mints.map((m) => [m, { ...warnedToken, mint: m }]))) }, [p]));
    const li = await rowOf(p);
    const check = within(li).getByText('Token check');
    expect(check.nextElementSibling).toHaveTextContent('allowed, with warnings');
    expect(check.closest('details')).toBeNull();
    expect(within(li).getAllByText('Token check')).toHaveLength(1);
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
    const li = await rowOf(p);
    await waitFor(() => expect(within(li).getAllByRole('link', { name: 'Explorer' }).length).toBeGreaterThanOrEqual(4));
    const hrefs = within(li).getAllByRole('link', { name: 'Explorer' }).map((a) => a.getAttribute('href'));
    for (const addr of [v.address, p.lpMint, p.lpAccount, v.tokenMint]) expect(hrefs).toContain(`https://explorer.test/address/${addr}`);
  });
});

describe('which shares work out their earnings by themselves', () => {
  it('the first two main positions read with no press; the third reads nothing until its button is pressed', async () => {
    const v = view();
    const [a, b, c] = [position(v), position(v), position(v)];
    const ledger = vi.fn(async () => okRead());
    mount(readers({ ledger }, [a, b, c]));
    const [ra, rb, rc] = [await rowOf(a), await rowOf(b), await rowOf(c)];
    await waitFor(() => expect([state(ra), state(rb)]).toEqual(['ok', 'ok']));
    expect(ledger).toHaveBeenCalledTimes(2);
    expect(ledger).toHaveBeenCalledWith({ lpAccount: a.lpAccount, lpMint: a.lpMint, owner: OWNER, lpAmount: a.lpAmount }, v);
    expect(ledger).toHaveBeenCalledWith({ lpAccount: b.lpAccount, lpMint: b.lpMint, owner: OWNER, lpAmount: b.lpAmount }, v);
    for (const r of [ra, rb]) {
      expect(within(r).getByText('Put in')).toBeInTheDocument();
      expect(within(r).queryByRole('button', { name: BUTTON })).toBeNull();
    }
    // The third: the press, 44px tall, and nothing read or printed before it. The nothing-to-claim sentence needs no press.
    expect(state(rc)).toBe('idle');
    expect(within(rc).getByText(FEES)).toBeInTheDocument();
    expect(within(rc).queryByText('Put in')).toBeNull();
    expect(value(rc, 'Worth now')).toBe(`1 SOL and 100 ${SHORT}`);
    const press = within(rc).getByRole('button', { name: BUTTON });
    expect(press).toHaveClass('min-h-[44px]');
    fireEvent.click(press);
    await within(rc).findByText('Put in');
    expect(ledger).toHaveBeenCalledTimes(3);
    expect(ledger).toHaveBeenLastCalledWith({ lpAccount: c.lpAccount, lpMint: c.lpMint, owner: OWNER, lpAmount: c.lpAmount }, v);
  });

  it('never a set-aside share: no read, no block and no press, even with a reader that could and no other share to read', async () => {
    const v = view();
    const p = position(v);
    const ledger = vi.fn(async () => okRead());
    mount(readers({ ledger, safety: vi.fn(async (mints: string[]) => new Map(mints.map((m) => [m, { ...refusedToken, mint: m }]))) }, [p]));
    const li = await rowOf(p);
    expect(li).toHaveTextContent('Set aside: this site does not open or add to pools for its token.');
    expect(li.closest('details')).toHaveAttribute('data-testid', 'lp-positions-set-aside');
    expect(within(li).queryByRole('button', { name: BUTTON })).toBeNull();
    expect(within(li).queryByTestId('lp-ledger')).toBeNull();
    expect(value(li, 'Worth now')).toBe(`1 SOL and 100 ${SHORT}`);
    // Long enough for an effect to have run.
    await new Promise((r) => setTimeout(r, 30));
    expect(ledger).not.toHaveBeenCalled();
  });

  it('a share with no pool, or whose pool could not be read, never reads and does not use up one of the two', async () => {
    const v = view();
    const unplaced = position(v, { lpMint: key().toBase58(), placement: 'not-found', pool: null, value: null });
    const unreadPool = position(v, { lpMint: key().toBase58(), pool: { kind: 'unread', address: key().toBase58(), detail: 'HTTP 502' }, value: null });
    const [a, b, c] = [position(v), position(v), position(v)];
    const ledger = vi.fn(async () => okRead());
    mount(readers({ ledger }, [unplaced, unreadPool, a, b, c]));
    const [ra, rb, rc] = [await rowOf(a), await rowOf(b), await rowOf(c)];
    await waitFor(() => expect([state(ra), state(rb)]).toEqual(['ok', 'ok']));
    expect(ledger).toHaveBeenCalledTimes(2);
    expect(ledger.mock.calls.map((call) => (call as unknown as [{ lpAccount: string }])[0].lpAccount).sort()).toEqual([a.lpAccount, b.lpAccount].sort());
    expect(state(rc)).toBe('idle');
    for (const p of [unplaced, unreadPool]) expect(within(await rowOf(p)).queryByTestId('lp-ledger')).toBeNull();
  });

  it('while the read runs the row says so: its worth, its button switched off, no figure and no zero; then the figures', async () => {
    const v = view();
    const p = position(v);
    let answer: (r: LedgerRead) => void = () => {};
    const ledger = vi.fn(() => new Promise<LedgerRead>((resolve) => { answer = resolve; }));
    mount(readers({ ledger }, [p]));
    const li = await rowOf(p);
    await waitFor(() => expect(ledger).toHaveBeenCalledTimes(1));
    expect(state(li)).toBe('reading');
    expect(within(li).getByText(FEES)).toBeInTheDocument();
    const b = block(li);
    expect(status(b)).toHaveTextContent(READING);
    expect(value(b, 'Worth now')).toBe(`1 SOL and 100 ${SHORT}`);
    // The button is on the page, switched off: a press while the read runs starts no second read.
    const press = within(b).getByRole('button', { name: BUTTON });
    expect(press).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(press);
    expect(ledger).toHaveBeenCalledTimes(1);
    for (const l of ['Put in', 'Fees earned', 'Versus just holding', 'Price effect']) expect(within(b).queryByText(l)).toBeNull();
    expect(b.textContent).not.toMatch(/\b0\b|none yet/);
    answer(okRead());
    await within(li).findByText('Put in');
    expect(within(li).queryByText(READING)).toBeNull();
  });

  it('a re-read of the same wallet asks for no history again, and values the transactions it holds at the pool as just read', async () => {
    const v1 = view({ trades: 'traded' });
    // The same pool half a SOL richer on its coin side, as trading fees leave it.
    const s = v1.snapshot;
    const richer = 10n * SOL + SOL / 2n;
    const v2: PoolView = { ...v1, quoteReserve: richer, snapshot: v1.quoteIsToken0 ? { ...s, vault0Amount: richer, reserve0: richer } : { ...s, vault1Amount: richer, reserve1: richer } };
    const p1 = position(v1);
    const p2: Position = { ...p1, pool: { kind: 'pool', view: v2 }, value: v2.quoteIsToken0 ? { token0: richer / 10n, token1: 100n * TOK, sharePct: 10 } : { token0: 100n * TOK, token1: richer / 10n, sharePct: 10 } };
    const entries = [deposit({ lp: 10n * SOL, token: 100n * TOK, coin: 1n * SOL })];
    // A reader that would answer for whichever pool it is handed: the second answer is right too, so only the count shows a second read.
    const ledger = vi.fn(async (_share: unknown, v: PoolView) => ledgerFigures(entries, v, p1.lpAmount));
    const positions = vi.fn()
      .mockResolvedValueOnce({ kind: 'ok', positions: [p1], chainNow: 5n, totalShares: 1 })
      .mockResolvedValue({ kind: 'ok', positions: [p2], chainNow: 6n, totalShares: 1 });
    const li = await shown(readers({ ledger, positions }, []), p1);
    expect(value(li, 'Fees earned')).toBe('none yet');
    expect(value(li, 'Worth now')).toBe(`1 SOL and 100 ${SHORT}`);
    fireEvent.click(screen.getByRole('button', { name: 'Read my positions again' }));
    await waitFor(() => expect(value(li, 'Worth now')).toBe(`1.05 SOL and 100 ${SHORT}`));
    // By hand: the position is now worth 1.05 + 1.05 = 2.1 SOL; a fee-free pool would have made it
    // 2 x sqrt(1 SOL x 100 tokens) at the new price, 2.0494 SOL. The difference, 0.0506 SOL, is the growth.
    const fees = value(li, 'Fees earned');
    expect(fees).toMatch(/^\+0\.0506\d+ SOL$/);
    const again = ledgerFigures(entries, v2, p1.lpAmount);
    if (again.kind !== 'ok') throw new Error('the figures did not work out');
    expect(fees).toBe(ledgerText.growth(again.figures, ledgerUnits(v2), { kind: 'at', time: 1n }).figure);
    expect(positions).toHaveBeenCalledTimes(2);
    expect(ledger).toHaveBeenCalledTimes(1);
  });

  it('a share whose amount changed is worked out again: by itself on a first row, on a new press elsewhere; nothing stale stays', async () => {
    const v = view();
    const [a, b, c] = [position(v), position(v), position(v)];
    const half = 5n * SOL;
    const ledger = vi.fn(async (share: { lpAmount: bigint }) => (share.lpAmount === half ? okRead({ putIn: { token: 50n * TOK, coin: SOL / 2n, count: 1 } }) : okRead()));
    const positions = vi.fn()
      .mockResolvedValueOnce({ kind: 'ok', positions: [a, b, c], chainNow: 5n, totalShares: 3 })
      .mockResolvedValue({ kind: 'ok', positions: [{ ...a, lpAmount: half }, b, { ...c, lpAmount: half }], chainNow: 6n, totalShares: 3 });
    mount(readers({ ledger, positions }, []));
    const [ra, rb, rc] = [await rowOf(a), await rowOf(b), await rowOf(c)];
    fireEvent.click(within(rc).getByRole('button', { name: BUTTON }));
    await waitFor(() => expect([state(ra), state(rb), state(rc)]).toEqual(['ok', 'ok', 'ok']));
    expect(ledger).toHaveBeenCalledTimes(3);
    fireEvent.click(screen.getByRole('button', { name: 'Read my positions again' }));
    // The first row reads again by itself for the shares it holds now; the second, unchanged, does not; the third offers its press again.
    await waitFor(() => expect(value(ra, 'Put in')).toBe(`0.5 SOL and 50 ${SHORT}`));
    expect(ledger).toHaveBeenCalledTimes(4);
    expect(ledger).toHaveBeenLastCalledWith({ lpAccount: a.lpAccount, lpMint: a.lpMint, owner: OWNER, lpAmount: half }, v);
    expect(state(rb)).toBe('ok');
    expect(state(rc)).toBe('idle');
    expect(within(rc).queryByText('Put in')).toBeNull();
    expect(within(rc).getByRole('button', { name: BUTTON })).toBeInTheDocument();
  });

  it('with no history reader at all: no button, no block, and the worth still printed', async () => {
    const p = position(view());
    mount(readers({}, [p]));
    const li = await rowOf(p);
    expect(within(li).queryByRole('button', { name: BUTTON })).toBeNull();
    expect(within(li).queryByTestId('lp-ledger')).toBeNull();
    expect(value(li, 'Worth now')).toBe(`1 SOL and 100 ${SHORT}`);
  });
});

describe('the earnings block, answered', () => {
  it('the owner’s own position in the BAYLA/SOL pool, as mainnet had it at slot 455093758', async () => {
    // The pool and the figures of lib/solana/lp/mainnetSwaps.test.ts, where the real ledger code produces them from the recorded history.
    // With the venue's uncollected cut, 801,600 lamports: it is what shows trades paid for the pool's growth.
    const b = buildPool({ plain: true, mint: new PublicKey(BAYLA_MINT), configIndex: 1, quoteReserve: 25_647_606_321n, tokenReserve: 5_414_845_326_496n, lpSupply: 372_631_821_673n, protocolFeesSol: 801_600n, openTime: 1_791_055_084n });
    const obs = decodeObservationState(observationBytes({ pool: b.address, index: 2, lastUpdate: 1_791_514_249n }))!;
    const v = viewOf(b, { sol: 25_647_606_321n, tok: 5_414_845_326_496n, history: { kind: 'ok', obs } });
    const [coin, token] = [5_717_756_621n, 1_207_160_127_729n];
    const p = position(v, { lpAmount: 83_072_784_230n, value: v.quoteIsToken0 ? { token0: coin, token1: token, sharePct: 22.2935 } : { token0: token, token1: coin, sharePct: 22.2935 } });
    const entries: LedgerEntry[] = [deposit({ lp: 1n, token: 1n, coin: 1n }), deposit({ lp: 1n, token: 1n, coin: 1n }), deposit({ lp: 1n, token: 1n, coin: 1n }), { kind: 'opening', ...AT, signature: sig(), lp: 1n, token: 1n, coin: 1n, lpBefore: 0n }];
    const read: LedgerRead = {
      kind: 'ok', case: 'A', entries, window: { count: 4, oldest: 1_791_055_083, more: false },
      figures: {
        putIn: { token: 1_231_466_144_058n, coin: 5_603_960_397n, count: 3 }, takenOut: null, worthNow: { token, coin },
        holdWorth: 11_436_843_324n, nowAndOutWorth: 11_435_513_242n,
        versusHolding: amount(-1_330_082n), growth: amount(961_245n), priceEffect: amount(-2_291_314n),
        locked: 13n, since: 1_791_055_083, provenShares: 83_072_784_230n, otherShares: null,
      },
    };
    // The chain's clock at the read: 2026-10-10 02:31:00 UTC.
    const li = await shown(readers({ ledger: vi.fn(async () => read) }, [p], 1_791_599_460n), p);
    expect(within(li).getByRole('heading', { level: 3 })).toHaveTextContent('BAYLA / SOL · 1% tier');
    expect(within(li).getByText('Your share: 22.2935% of the pool')).toBeInTheDocument();
    expect(within(li).getByText(FEES)).toBeInTheDocument();
    const blk = block(li);
    // In reading order.
    const labels = ['Put in', 'Worth now', 'Fees earned', 'Versus just holding', 'Price effect'];
    const seen = labels.map((l) => within(blk).getByText(l, { exact: true }));
    for (let i = 1; i < seen.length; i++) expect(seen[i - 1]!.compareDocumentPosition(seen[i]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The figure alone beside its label; how and since when is the sentence under it, like every other line.
    expect(value(blk, 'Put in')).toBe('5.603960397 SOL and 1,231,466.144058 BAYLA');
    expect(note(blk, 'Put in')).toBe('In 1 opening and 3 deposits, since 2026-10-03 19:18 UTC.');
    expect(value(blk, 'Worth now')).toBe('5.717756621 SOL and 1,207,160.127729 BAYLA');
    expect(value(blk, 'Fees earned')).toBe('+0.000961245 SOL');
    expect(note(blk, 'Fees earned')).toBe(FEES_NOTE);
    // 961,245 over 11,435,513,242 is 0.0084%; 544,377 seconds is 6.3 days; x 31,536,000 / 544,377 is 0.48% (pace.test.ts).
    const pace = within(blk).getByTestId('lp-pace');
    expect(pace).toHaveTextContent(/^0\.0084% of this position in 6\.3 days\. At that pace, about 0\.48% a year\. Past trades, not a forecast\.$/);
    expect(within(blk).getByText('Fees earned').parentElement!.parentElement).toContainElement(pace);
    expect(value(blk, 'Versus just holding')).toBe('-0.001330082 SOL');
    expect(note(blk, 'Versus just holding')).toBe(`${VERSUS} ${PRICE_DID_IT}`);
    expect(value(blk, 'Price effect')).toBe('-0.002291314 SOL');
    expect(note(blk, 'Price effect')).toBe(`${PRICE_EFFECT} Often called impermanent loss.`);
    // The 13 lamports every new pool keeps are behind the fold, not a line of the block.
    expect(within(blk).queryByText('Locked at opening')).toBeNull();
    const fold = within(li).getByText('More about this share').closest('details')!;
    expect(value(fold, 'Locked at opening')).toBe('0.000000013 SOL: the 0.0000001 pool shares (100 of the smallest unit) every new pool keeps.');
    expect(sentences(blk)).toContain('From the 4 transactions on your shares in this pool since 2026-10-03 19:18 UTC.');
    // Short: the owner asked for "no need to be too wordy". The block was 201 words; it stays under 120.
    expect((blk.textContent ?? '').split(/\s+/).filter(Boolean).length).toBeLessThan(120);
    expect(blk.textContent).not.toMatch(/share account|smallest unit/);
    // A date is never split across two lines: each one is its own no-wrap element.
    for (const el of Array.from(blk.querySelectorAll('span.whitespace-nowrap'))) expect(el.textContent).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC$/);
    expect(blk.querySelectorAll('span.whitespace-nowrap').length).toBeGreaterThanOrEqual(2);
    // The forecast-word rule, with its one door: the pace sentence, whole, is the only place the row names a yearly figure.
    const text = li.textContent ?? '';
    expect(text).toMatch(/a year/);
    expect(text.replace(PACE_SENTENCE, '')).not.toMatch(FORECAST_WORDS);
    expect(text).not.toMatch(/\bAPR\b|\bAPY\b|guarantee/i);
    expect(text).not.toMatch(/—/);
  });

  it('nothing moved yet: every "none yet" line has no digit and no sign, the no-trade sentence, no pace, and Work it out again reads the share again', async () => {
    const v = view();
    const p = position(v);
    const ledger = vi.fn(async () => okRead());
    // A week after the deposit by the chain's clock: a pace could be worked out, if there were a fee.
    const li = await shown(readers({ ledger }, [p], BigInt(AT_SEC + 7 * DAY)), p);
    const b = block(li);
    expect(value(b, 'Put in')).toBe(`1 SOL and 100 ${SHORT}`);
    expect(note(b, 'Put in')).toBe(`In 1 deposit, since ${AT_TEXT}.`);
    expect(within(b).queryByText('Taken out')).toBeNull();
    expect(within(b).queryByText('Locked at opening')).toBeNull();
    for (const l of ['Fees earned', 'Versus just holding', 'Price effect']) {
      const t = value(b, l);
      expect(t).toBe('none yet');
      expect(t).not.toMatch(/\d/);
      expect(t).not.toMatch(/[+\-−]/);
    }
    // The pool's own record says no trade has ever reached it: the fees line says why there is nothing.
    expect(note(b, 'Fees earned')).toBe(NO_TRADE_YET);
    expect(within(b).queryByTestId('lp-pace')).toBeNull();
    expect(li.textContent).not.toMatch(FORECAST_WORDS);
    expect(b).not.toHaveTextContent('arrived another way');
    expect(sentences(b)).toContain('From the 1 transaction on your shares in this pool since 2026-10-03 22:30 UTC.');
    expect(within(b).queryByRole('button', { name: 'Read 20 more' })).toBeNull();
    // Named for what it does: the finder and the pool history have their own "read again".
    expect(within(b).queryByRole('button', { name: 'Read again' })).toBeNull();
    const again = within(b).getByRole('button', { name: AGAIN });
    expect(again).toHaveClass('min-h-[44px]');
    fireEvent.click(again);
    await waitFor(() => expect(ledger).toHaveBeenCalledTimes(2));
    expect(within(li).queryByRole('button', { name: BUTTON })).toBeNull();
  });

  it('a figure above the bound prints signed with its sentence under it; a deposit not final yet says so; the pace only where the pool has traded', async () => {
    const over = { growth: amount(2_000_000n), priceEffect: amount(-5_000_000n), versusHolding: amount(-3_000_000n), holdWorth: 2n * SOL, nowAndOutWorth: 2n * SOL - 3_000_000n };
    const entries = () => [deposit({ lp: 10n * SOL, token: 100n * TOK, coin: 1n * SOL, final: false })];
    const week = BigInt(AT_SEC + 7 * DAY);
    // A pool that has traded, and whose own fee counters account for its growth.
    const traded = position(view({ trades: 'traded', feesShow: true }));
    const li = await shown(readers({ ledger: vi.fn(async () => okRead(over, 'A', entries())) }, [traded], week), traded);
    const b = block(li);
    expect(value(b, 'Fees earned')).toBe('+0.002 SOL');
    expect(note(b, 'Fees earned')).toBe(FEES_NOTE);
    // 2,000,000 over 1,997,000,000 is 0.10015%, cut to 0.1%. Seven days: x 365 / 7 = 5.22%, cut to 5.2%.
    expect(within(b).getByTestId('lp-pace')).toHaveTextContent(/^0\.1% of this position in 7 days\. At that pace, about 5\.2% a year\. Past trades, not a forecast\.$/);
    expect(value(b, 'Versus just holding')).toBe('-0.003 SOL');
    expect(note(b, 'Versus just holding')).toBe(`${VERSUS} ${PRICE_DID_IT}`);
    expect(value(b, 'Price effect')).toBe('-0.005 SOL');
    expect(value(b, 'Put in')).toBe(`1 SOL and 100 ${SHORT}`);
    expect(note(b, 'Put in')).toBe(`In 1 deposit, since ${AT_TEXT}. (not final yet)`);
    cleanup();
    // The same figures on a pool no trade has ever reached: the growth is not called fees, and no pace is drawn from it.
    const never = position(view());
    const li2 = await shown(readers({ ledger: vi.fn(async () => okRead(over, 'A', entries())) }, [never], week), never);
    expect(value(block(li2), 'Fees earned')).toBe('+0.002 SOL');
    expect(note(block(li2), 'Fees earned')).toBe('Not from fees: no trade has reached this pool, so this came from tokens sent straight into it.');
    expect(within(li2).queryByTestId('lp-pace')).toBeNull();
    expect(li2.textContent).not.toMatch(FORECAST_WORDS);
    cleanup();
    // A pool that HAS traded, but whose fee counters cannot account for its growth (tokens sent straight in, or
    // nothing to measure it by): the figure and its sentence stand, and no pace is drawn. "Past trades" would not be true.
    const unexplained = position(view({ trades: 'traded' }));
    const li3 = await shown(readers({ ledger: vi.fn(async () => okRead(over, 'A', entries())) }, [unexplained], week), unexplained);
    expect(value(block(li3), 'Fees earned')).toBe('+0.002 SOL');
    expect(note(block(li3), 'Fees earned')).toBe(FEES_NOTE);
    expect(within(li3).queryByTestId('lp-pace')).toBeNull();
    expect(li3.textContent).not.toMatch(FORECAST_WORDS);
  });

  it('shares that arrived another way are named with their worth; Taken out prints when set, and Locked at opening in the fold', async () => {
    const p = position(view());
    const read = okRead({
      takenOut: { token: 10n * TOK, coin: 100_000_000n, count: 1 },
      locked: 20n,
      otherShares: { lp: 1n, worth: { token: 1n * TOK, coin: 10_000_000n } },
    }, 'B');
    const li = await shown(readers({ ledger: vi.fn(async () => read) }, [p]), p);
    const b = block(li);
    expect(within(b).getByText(`0.000000001 shares arrived another way (sent to this account, or older than the transactions read): worth 0.01 SOL and 1 ${SHORT} now. They are part of Worth now and of no other figure here.`)).toBeInTheDocument();
    expect(value(b, 'Taken out')).toBe(`0.1 SOL and 10 ${SHORT}`);
    expect(note(b, 'Taken out')).toBe('In 1 withdrawal.');
    expect(within(b).queryByText('Locked at opening')).toBeNull();
    expect(value(within(li).getByText('More about this share').closest('details')!, 'Locked at opening')).toBe('0.00000002 SOL: the 0.0000001 pool shares (100 of the smallest unit) every new pool keeps.');
  });

  it('worth-only says why and prints no earnings figure; the worth stays', async () => {
    const p = position(view());
    const read: LedgerRead = { kind: 'worth-only', why: 'shares-left', entries: [other()], window: { count: 1, oldest: AT_SEC, more: false } };
    const li = await shown(readers({ ledger: vi.fn(async () => read) }, [p]), p);
    const b = block(li);
    expect(state(li)).toBe('worth-only');
    const why = 'Some shares left this account without a withdrawal this pool recorded (sent out, or burned), so what they cost is not known. Earned and versus holding cannot be worked out for this position.';
    // Said on the row, and read out by the status line when it arrives.
    expect(within(b).getAllByText(why)).toHaveLength(2);
    expect(status(b)).toHaveTextContent(why);
    for (const l of ['Put in', 'Fees earned', 'Versus just holding', 'Price effect']) expect(within(b).queryByText(l)).toBeNull();
    expect(b.textContent).not.toMatch(/none yet/);
    expect(sentences(b)).toContain('From the 1 transaction on your shares in this pool since 2026-10-03 22:30 UTC.');
    expect(value(b, 'Worth now')).toBe(`1 SOL and 100 ${SHORT}`);
    expect(within(b).getByRole('button', { name: AGAIN })).toBeInTheDocument();
  });

  it('unread says so with the reason, and never prints 0 or "none yet"', async () => {
    const p = position(view());
    const read: LedgerRead = { kind: 'unread', detail: 'the node is away' };
    const li = await shown(readers({ ledger: vi.fn(async () => read) }, [p]), p);
    const b = block(li);
    expect(state(li)).toBe('unread');
    expect(within(b).getAllByText('Your history in this pool could not be read (the node is away).')).toHaveLength(2);
    expect(status(b)).toHaveTextContent('Your history in this pool could not be read (the node is away).');
    for (const l of ['Put in', 'Fees earned', 'Versus just holding', 'Price effect']) expect(within(b).queryByText(l)).toBeNull();
    expect(b.textContent).not.toMatch(/\b0\b/);
    expect(b.textContent).not.toMatch(/none yet/);
    // A row that read by itself and failed is not left without a button.
    expect(within(b).getByRole('button', { name: AGAIN })).not.toHaveAttribute('aria-disabled', 'true');
  });

  it('a reader that throws is unread, with the error as the reason', async () => {
    const p = position(view());
    const li = await shown(readers({ ledger: vi.fn(async () => { throw new Error('socket closed'); }) }, [p]), p);
    expect(status(block(li))).toHaveTextContent('Your history in this pool could not be read (socket closed).');
  });

  it('paused by the call budget says so, prints no figure, and Work it out again tries once more', async () => {
    const p = position(view());
    const ledger = vi.fn<() => Promise<LedgerRead>>().mockResolvedValueOnce({ kind: 'paused' }).mockResolvedValue(okRead());
    const li = await shown(readers({ ledger }, [p]), p);
    const b = block(li);
    expect(state(li)).toBe('paused');
    expect(within(b).getAllByText(PAUSED)).toHaveLength(2);
    for (const l of ['Put in', 'Fees earned', 'Versus just holding', 'Price effect']) expect(within(b).queryByText(l)).toBeNull();
    expect(b.textContent).not.toMatch(/\b0\b|none yet/);
    fireEvent.click(within(b).getByRole('button', { name: AGAIN }));
    await within(li).findByText('Put in');
    expect(within(li).queryByText(PAUSED)).toBeNull();
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
    const li = await shown(readers({ ledger }, [p]), p);
    const b = block(li);
    expect(within(b).getAllByText('Your history in this pool goes back further than the 1 transaction this page reads (the oldest read is from 2026-10-03 22:30 UTC), so what you put in could not be fully read.')).toHaveLength(2);
    const more = within(b).getByRole('button', { name: 'Read 20 more' });
    expect(more).toHaveClass('min-h-[44px]');
    fireEvent.click(more);
    await within(b).findByText('Put in');
    expect(ledger).toHaveBeenLastCalledWith({ lpAccount: p.lpAccount, lpMint: p.lpMint, owner: OWNER, lpAmount: p.lpAmount }, v, { before: dep2.signature });
    // Both deposits: 0.4 + 0.6 SOL and 40 + 60 tokens, from the older one; the books balance (10 shares held), so nothing "arrived another way".
    expect(value(b, 'Put in')).toBe(`1 SOL and 100 ${SHORT}`);
    expect(note(b, 'Put in')).toBe('In 2 deposits, since 2026-10-03 22:20 UTC.');
    expect(b).not.toHaveTextContent('arrived another way');
    expect(sentences(b)).toContain('From the 2 transactions on your shares in this pool since 2026-10-03 22:20 UTC.');
    expect(within(b).queryByRole('button', { name: 'Read 20 more' })).toBeNull();
  });

  it('an older page that is paused or unread says so and keeps what was read', async () => {
    const p = position(view());
    const first: LedgerRead = { kind: 'worth-only', why: 'run-start-not-read', entries: [other()], window: { count: 1, oldest: AT_SEC, more: true } };
    const ledger = vi.fn(async (_s: unknown, _v: unknown, o?: { before?: string }): Promise<LedgerRead> => (o?.before ? { kind: 'paused' } : first));
    const li = await shown(readers({ ledger }, [p]), p);
    const b = block(li);
    fireEvent.click(within(b).getByRole('button', { name: 'Read 20 more' }));
    await waitFor(() => expect(within(b).getAllByText(PAUSED)).toHaveLength(2));
    expect(sentences(b)).toContain('From the last 1 transaction on your shares in this pool, back to 2026-10-03 22:30 UTC. Older ones were not read.');
    expect(within(b).getByRole('button', { name: 'Read 20 more' })).toBeInTheDocument();
  });

  it('after five pages the page says older history is not read, and offers no more', async () => {
    const p = position(view());
    const ledger = vi.fn(async (): Promise<LedgerRead> => ({ kind: 'worth-only', why: 'run-start-not-read', entries: [other()], window: { count: 1, oldest: AT_SEC, more: true } }));
    const li = await shown(readers({ ledger }, [p]), p);
    const b = block(li);
    for (let page = 2; page <= 5; page++) {
      fireEvent.click(within(b).getByRole('button', { name: 'Read 20 more' }));
      await waitFor(() => expect(ledger).toHaveBeenCalledTimes(page));
      await waitFor(() => expect(sentences(b).some((t) => t.startsWith(`From the last ${page} transactions on your shares in this pool, back to `))).toBe(true));
    }
    expect(within(b).queryByRole('button', { name: 'Read 20 more' })).toBeNull();
    expect(within(b).getByText('Older history is not read by this page.')).toBeInTheDocument();
  });
});

// The press and the answer, for a keyboard and a screen reader. The button used to leave the
// page the moment it was pressed, so focus fell to the document body; and the reading line was
// put on the page already holding its text and taken off again, so nothing read the answer out.
describe('pressing a button never loses the keyboard, and each answer is read out', () => {
  it('the press keeps focus on the button it was made on, while the read runs and after the answer', async () => {
    const v = view();
    const [a, b, c] = [position(v), position(v), position(v)];
    let answer: (r: LedgerRead) => void = () => {};
    const ledger = vi.fn((share: { lpAccount: string }) => (share.lpAccount === c.lpAccount ? new Promise<LedgerRead>((resolve) => { answer = resolve; }) : Promise.resolve(okRead())));
    mount(readers({ ledger }, [a, b, c]));
    const rc = await rowOf(c);
    const blk = block(rc);
    const press = within(blk).getByRole('button', { name: BUTTON });
    // Before any press: the status line is already on the page, and silent.
    expect(status(blk)).toBeEmptyDOMElement();
    press.focus();
    fireEvent.click(press);
    await waitFor(() => expect(status(blk)).toHaveTextContent(READING));
    expect(document.activeElement).toBe(press);
    expect(press).toBeInTheDocument();
    expect(press).toHaveAttribute('aria-disabled', 'true');
    await act(async () => {
      answer(okRead());
    });
    await within(blk).findByText('Put in');
    // The same button, now named for the next press; focus never went to the page body.
    expect(document.activeElement).toBe(press);
    expect(press).toHaveAccessibleName(AGAIN);
    expect(press).not.toHaveAttribute('aria-disabled', 'true');
    expect(document.activeElement).not.toBe(document.body);
    // One status line, the same element throughout, now saying it is done.
    expect(within(blk).getAllByRole('status')).toHaveLength(1);
    expect(status(blk)).toHaveTextContent(WORKED_OUT);
  });

  it('Read 20 more that reads the last page hands focus to the button that stays', async () => {
    const p = position(view());
    const dep2 = deposit({ lp: 6n * SOL, token: 60n * TOK, coin: 600_000_000n, lpBefore: 4n * SOL });
    const dep1 = deposit({ lp: 4n * SOL, token: 40n * TOK, coin: 400_000_000n, lpBefore: 0n, blockTime: AT_SEC - 600 });
    const first: LedgerRead = { kind: 'worth-only', why: 'run-start-not-read', entries: [dep2], window: { count: 1, oldest: AT_SEC, more: true } };
    const older: LedgerRead = { kind: 'ok', figures: figures(), entries: [dep1], window: { count: 1, oldest: AT_SEC - 600, more: false }, case: 'A' };
    const ledger = vi.fn(async (_s: unknown, _v: unknown, o?: { before?: string }) => (o?.before ? older : first));
    const li = await shown(readers({ ledger }, [p]), p);
    const b = block(li);
    const more = within(b).getByRole('button', { name: 'Read 20 more' });
    more.focus();
    fireEvent.click(more);
    await within(b).findByText('Put in');
    // Nothing older is offered, so the button is gone; the keyboard is on the block's other button, not on the page body.
    expect(within(b).queryByRole('button', { name: 'Read 20 more' })).toBeNull();
    expect(document.activeElement).toBe(within(b).getByRole('button', { name: AGAIN }));
    expect(status(b)).toHaveTextContent(WORKED_OUT);
  });

  it('Read 20 more that is still offered keeps its own focus, and a failed one is read out', async () => {
    const p = position(view());
    const first: LedgerRead = { kind: 'worth-only', why: 'run-start-not-read', entries: [other()], window: { count: 1, oldest: AT_SEC, more: true } };
    const ledger = vi.fn(async (_s: unknown, _v: unknown, o?: { before?: string }): Promise<LedgerRead> => (o?.before ? { kind: 'paused' } : first));
    const li = await shown(readers({ ledger }, [p]), p);
    const b = block(li);
    const more = within(b).getByRole('button', { name: 'Read 20 more' });
    more.focus();
    fireEvent.click(more);
    await waitFor(() => expect(status(b)).toHaveTextContent(PAUSED));
    expect(document.activeElement).toBe(more);
  });
});

describe('the automatic read fires once, and an answer is shown only for its own question', () => {
  it('under React StrictMode, which runs every effect twice, three positions still make exactly two reads', async () => {
    const v = view();
    const [a, b, c] = [position(v), position(v), position(v)];
    const ledger = vi.fn(async () => okRead());
    render(
      <StrictMode>
        <YourPositions readers={readers({ ledger }, [a, b, c])} owner={OWNER} />
      </StrictMode>,
    );
    const [ra, rb, rc] = [await rowOf(a), await rowOf(b), await rowOf(c)];
    await waitFor(() => expect([state(ra), state(rb), state(rc)]).toEqual(['ok', 'ok', 'idle']));
    // Long enough for a second effect to have run.
    await new Promise((r) => setTimeout(r, 30));
    expect(ledger).toHaveBeenCalledTimes(2);
  });

  it('a row read on a press and then moved into the first two does not read again', async () => {
    const v = view();
    const [a, b, c] = [position(v), position(v), position(v)];
    const ledger = vi.fn(async () => okRead());
    const positions = vi.fn()
      .mockResolvedValueOnce({ kind: 'ok', positions: [a, b, c], chainNow: 5n, totalShares: 3 })
      .mockResolvedValue({ kind: 'ok', positions: [c, a, b], chainNow: 6n, totalShares: 3 });
    mount(readers({ ledger, positions }, []));
    const [ra, rc] = [await rowOf(a), await rowOf(c)];
    await waitFor(() => expect(state(ra)).toBe('ok'));
    fireEvent.click(within(rc).getByRole('button', { name: BUTTON }));
    await waitFor(() => expect(state(rc)).toBe('ok'));
    expect(ledger).toHaveBeenCalledTimes(3);
    fireEvent.click(screen.getByRole('button', { name: 'Read my positions again' }));
    await waitFor(() => expect(positions).toHaveBeenCalledTimes(2));
    await waitFor(async () => expect((await screen.findAllByTestId('lp-position'))[0]).toBe(rc));
    await new Promise((r) => setTimeout(r, 30));
    // The third row is first now and holds its answer; the row pushed out of the first two keeps its own.
    expect(ledger).toHaveBeenCalledTimes(3);
    expect(state(rc)).toBe('ok');
  });

  it('an answer that arrives late, for shares that have since changed, never replaces the answer for the shares held now', async () => {
    const v = view();
    const a = position(v);
    const half = 5n * SOL;
    const late: ((r: LedgerRead) => void)[] = [];
    // The first question (10 shares) is left unanswered; the second (5 shares) answers at once.
    const ledger = vi.fn((share: { lpAmount: bigint }) =>
      share.lpAmount === half ? Promise.resolve(okRead({ putIn: { token: 50n * TOK, coin: SOL / 2n, count: 1 } })) : new Promise<LedgerRead>((resolve) => { late.push(resolve); }));
    const positions = vi.fn()
      .mockResolvedValueOnce({ kind: 'ok', positions: [a], chainNow: 5n, totalShares: 1 })
      .mockResolvedValue({ kind: 'ok', positions: [{ ...a, lpAmount: half }], chainNow: 6n, totalShares: 1 });
    mount(readers({ ledger, positions }, []));
    const li = await rowOf(a);
    await waitFor(() => expect(ledger).toHaveBeenCalledTimes(1));
    expect(state(li)).toBe('reading');
    fireEvent.click(screen.getByRole('button', { name: 'Read my positions again' }));
    await waitFor(() => expect(value(li, 'Put in')).toBe(`0.5 SOL and 50 ${SHORT}`));
    expect(ledger).toHaveBeenCalledTimes(2);
    // Now the first question's answer lands, with the old shares' figures.
    await act(async () => {
      late[0]!(okRead());
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(state(li)).toBe('ok');
    expect(value(li, 'Put in')).toBe(`0.5 SOL and 50 ${SHORT}`);
    expect(within(li).queryByText(READING)).toBeNull();
  });
});
