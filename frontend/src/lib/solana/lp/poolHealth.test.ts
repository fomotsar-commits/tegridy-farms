// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { assessPool, comparePrice, poolPricePerToken, PRICE_TOLERANCE, FAR_FUTURE_SECS, tokenReasons } from './poolHealth';
import { decodeObservationState } from './ownPrice';
import { POOL_STATUS_DISABLE_DEPOSIT, POOL_STATUS_DISABLE_SWAP, POOL_STATUS_DISABLE_WITHDRAW } from '../cpswap/program';
import type { PoolView } from './poolFinder';
import type { SafetyReason, TokenSafety } from './tokenSafety';
import { buildPool, key, observationBytes, viewOf } from './testkit.fixture';

const mint = key();
const OK_TOKEN: TokenSafety = { kind: 'read', mint: mint.toBase58(), verdict: 'ok', blocks: [], warnings: [], facts: null, name: null, symbol: null, metadataSource: 'none' };
const SOL = 10n * 10n ** 9n;
const TOK = 1_000n * 10n ** 6n;

/** 10 SOL against 1,000 tokens (6 decimals): 0.01 SOL per token. */
function view(o: { openTime?: bigint; status?: number; sol?: bigint; tok?: bigint; origin?: PoolView['origin']; frozen?: boolean; history?: PoolView['history']; config?: PoolView['config'] | 'decoded' } = {}): PoolView {
  const b = buildPool({ mint, quoteReserve: o.sol ?? SOL, tokenReserve: o.tok ?? TOK, openTime: o.openTime ?? 100n, status: o.status ?? 0 });
  return viewOf(b, { sol: o.sol ?? SOL, tok: o.tok ?? TOK, origin: o.origin, frozen: o.frozen, history: o.history, config: o.config });
}

const base = { tokenDecimals: 6, chainNow: 1_000n, safety: OK_TOKEN };
const outside = (p: number) => ({ kind: 'ok' as const, solPerToken: p, source: 'Jupiter' as const });
const noOutside = { kind: 'no-route' as const, detail: 'Jupiter has no route for this token' };

describe('assessPool', () => {
  it('prices the pool from its reserves, SOL per whole token', () => {
    expect(poolPricePerToken(view().snapshot, mint.toBase58(), 6)).toBeCloseTo(0.01, 12);
  });

  it('a healthy pool: open, price within 3% of the outside price, token ok → deposits allowed', () => {
    const h = assessPool({ ...base, view: view(), outside: outside(0.0101) });
    expect(h.swaps).toEqual({ state: 'open' });
    expect(h.withdrawals).toBe('open');
    expect(h.price).toMatchObject({ state: 'agrees', against: 'outside' });
    // A clean token at a market price: allowed, and nothing at all is warned of.
    expect(h.deposits).toEqual({ verdict: 'allowed', reasons: [], warnings: [] });
  });

  // Owner ruling 2026-10-04: a price that is off is a warning, and the visitor may go on.
  it('a price more than 3% off, either way, is allowed with a warning that names the gap and what it costs', () => {
    const cases: Array<[number, RegExp]> = [
      [0.01 / (1 + PRICE_TOLERANCE + 0.001), /^Its price is 3\.1% above the outside price\. A deposit here would hand that gap to the first arbitrage trade\.$/],
      [0.01 / (1 - PRICE_TOLERANCE - 0.001), /^Its price is 3\.1% below the outside price\. A deposit here would hand that gap to the first arbitrage trade\.$/],
    ];
    for (const [p, says] of cases) {
      const h = assessPool({ ...base, view: view(), outside: outside(p) });
      expect(h.price.state).toBe('disagrees');
      expect(h.deposits.verdict).toBe('allowed');
      expect(h.deposits.reasons).toEqual([]);
      expect(h.deposits.warnings).toHaveLength(1);
      expect(h.deposits.warnings[0]).toMatch(says);
    }
    // Inside the 3% there is nothing to warn of.
    expect(assessPool({ ...base, view: view(), outside: outside(0.0101) }).deposits.warnings).toEqual([]);
  });

  it('a squatted pool: open time far ahead → swaps blocked, deposits refused, and it says so', () => {
    const h = assessPool({ ...base, view: view({ openTime: 1_000n + FAR_FUTURE_SECS + 1n }), outside: outside(0.01) });
    expect(h.swaps).toMatchObject({ state: 'not-open-yet', farFuture: true });
    expect(h.deposits.verdict).toBe('refused');
    expect(h.deposits.reasons[0]).toMatch(/earns nothing/);
  });

  it('switched-off bits are refused, and swaps switched off is not "open"', () => {
    expect(assessPool({ ...base, view: view({ status: POOL_STATUS_DISABLE_DEPOSIT }), outside: outside(0.01) }).deposits.verdict).toBe('refused');
    const h = assessPool({ ...base, view: view({ status: POOL_STATUS_DISABLE_SWAP }), outside: outside(0.01) });
    expect(h.swaps.state).toBe('switched-off');
    expect(h.deposits.verdict).toBe('refused');
  });

  // F1: the pool program lets a deposit into a pool whose WITHDRAWALS are off (deposit.rs
  // checks only the deposit bit); that money could not come back out.
  it('withdrawals switched off refuses deposits, and a status bit this site does not know does too', () => {
    const h = assessPool({ ...base, view: view({ status: POOL_STATUS_DISABLE_WITHDRAW }), outside: outside(0.01) });
    expect(h.withdrawals).toBe('switched-off');
    expect(h.deposits.verdict).toBe('refused');
    expect(h.deposits.reasons.join(' ')).toMatch(/Withdrawals are switched off/);
    expect(assessPool({ ...base, view: view({ status: 8 }), outside: outside(0.01) }).deposits.verdict).toBe('refused');
  });

  // F7: USDC/USDT pools are in scope and their issuers can freeze a vault.
  it('a frozen vault: withdrawals are blocked, not "open", and deposits are refused', () => {
    const h = assessPool({ ...base, view: view({ frozen: true }), outside: outside(0.01) });
    expect(h.withdrawals).toBe('vault-frozen');
    expect(h.deposits.verdict).toBe('refused');
    expect(h.deposits.reasons.join(' ')).toMatch(/frozen/);
  });

  // F4: unreadable fee settings are never "the checks pass".
  it('fee settings that could not be read leave deposits unchecked', () => {
    const h = assessPool({ ...base, view: view({ config: null }), outside: outside(0.01) });
    expect(h.deposits.verdict).toBe('unchecked');
    expect(h.deposits.reasons.join(' ')).toMatch(/fee settings/);
  });

  it('what was not read is "unchecked", never "allowed" and never a warning: the clock, the outside price, the token', () => {
    const unread = [
      assessPool({ ...base, chainNow: null, view: view(), outside: outside(0.01) }),
      assessPool({ ...base, view: view(), outside: { kind: 'unread', detail: 'down' } }),
      assessPool({ ...base, view: view(), outside: null }),
      assessPool({ ...base, safety: { kind: 'unread', mint: mint.toBase58(), detail: 'x' }, view: view(), outside: outside(0.01) }),
      assessPool({ ...base, safety: null, view: view(), outside: outside(0.01) }),
    ];
    for (const h of unread) {
      expect(h.deposits.verdict).toBe('unchecked');
      expect(h.deposits.reasons.length).toBeGreaterThan(0);
      expect(h.deposits.warnings).toEqual([]);
    }
  });

  // Jupiter failing to answer is NOT "no route": the token may trade elsewhere at another
  // price. It stays unread, for a pool anyone could open as for a launch pool.
  it('Jupiter failing to answer is unread, never "no market": the price state says unread and nothing is warned', () => {
    const h = assessPool({ ...base, view: view(), outside: { kind: 'unread', detail: 'Jupiter did not give a price (HTTP 502)' } });
    expect(h.price).toMatchObject({ state: 'unread' });
    expect(h.deposits).toEqual({
      verdict: 'unchecked',
      reasons: ['We could not check its price against an outside price (Jupiter did not give a price (HTTP 502)).'],
      warnings: [],
    });
  });

  // Owner ruling 2026-10-04. A pool anyone could open has no history worth trusting, so
  // with no route it has no reference at all: allowed, and never without saying so.
  it('Jupiter ANSWERS "no route" for a pool anyone could open: allowed, as "no market", with the warning', () => {
    const h = assessPool({ ...base, view: view(), outside: noOutside });
    expect(h.price).toEqual({ state: 'no-market', pool: expect.closeTo(0.01, 12), detail: 'Jupiter has no route for this token' });
    expect(h.deposits).toEqual({
      verdict: 'allowed',
      reasons: [],
      warnings: [
        'Jupiter has no market price for this token, so this pool’s price was not checked against anything. If it is off, a deposit here hands the difference to whoever trades it back.',
      ],
    });
  });

  // What still refuses a pool is untouched by "no market": the warning is added, nothing is lifted.
  it('"no market" lifts nothing else: a pool with withdrawals off, or not open yet, is still refused', () => {
    expect(assessPool({ ...base, view: view({ status: POOL_STATUS_DISABLE_WITHDRAW }), outside: noOutside }).deposits.verdict).toBe('refused');
    expect(assessPool({ ...base, view: view({ openTime: 1_000n + FAR_FUTURE_SECS + 1n }), outside: noOutside }).deposits.verdict).toBe('refused');
    expect(assessPool({ ...base, view: view({ frozen: true }), outside: noOutside }).deposits.verdict).toBe('refused');
    expect(assessPool({ ...base, view: view({ config: null }), outside: noOutside }).deposits.verdict).toBe('unchecked');
  });

  it('a blocked token refuses deposits even into a perfect pool', () => {
    const blocked: TokenSafety = { ...OK_TOKEN, verdict: 'blocked', blocks: [{ code: 'transfer-fee', text: 'x' }] } as TokenSafety;
    const h = assessPool({ ...base, safety: blocked, view: view(), outside: outside(0.01) });
    expect(h.deposits.verdict).toBe('refused');
    expect(h.deposits.reasons).toEqual(['This token is blocked on this site (see why above).']);
  });

  it('a token that does not exist refuses deposits', () => {
    const h = assessPool({ ...base, safety: { kind: 'absent', mint: mint.toBase58() }, view: view(), outside: outside(0.01) });
    expect(h.deposits).toEqual({ verdict: 'refused', reasons: ['The token does not exist.'], warnings: [] });
  });

  // S1-R09: a price we chose not to compare is not a price we "could not read".
  it('a blocked token’s price is skipped on purpose, not described as unreadable', () => {
    const blocked: TokenSafety = { ...OK_TOKEN, verdict: 'blocked', blocks: [{ code: 'transfer-fee', text: 'x' }] } as TokenSafety;
    const h = assessPool({ ...base, safety: blocked, view: view(), outside: null });
    expect(h.price.state).toBe('skipped');
    expect(h.deposits.reasons.join(' ')).not.toMatch(/could not check its price/);
  });

  it('an empty pool has no price and takes no deposit', () => {
    const h = assessPool({ ...base, view: view({ tok: 0n }), outside: outside(0.01) });
    expect(h.price.state).toBe('empty-pool');
    expect(h.deposits.verdict).toBe('refused');
  });
});

// F5: a launch pool usually has no outside price, and anyone can trade it after
// graduation, so its price now is checked against its own half-hour average.
describe('assessPool: a launch pool is checked against its own recent average', () => {
  const b = buildPool({ mint, quoteReserve: SOL, tokenReserve: TOK, openTime: 100n });
  const tokenIs0 = viewOf(b, { sol: SOL, tok: TOK }).quoteIsToken0 === false;
  const Q32 = 1n << 32n;
  /** A record: one slot at t=1000, the latest at t=4600, the price before that `solPerBase` (SOL base units per token base unit). */
  function history(solPerBaseX32: bigint, o: { firstAt?: bigint; initialized?: boolean } = {}): PoolView['history'] {
    const first = o.firstAt ?? 1_000n;
    const span = 4_600n - first;
    const own = solPerBaseX32 * span;
    const other = ((Q32 * Q32) / solPerBaseX32) * span;
    const [c0, c1] = tokenIs0 ? [own, other] : [other, own];
    const data = observationBytes({ pool: b.address, initialized: o.initialized, index: 1, lastUpdate: 4_600n, obs: [[0, first, 0n, 0n], [1, 4_600n, c0, c1]] });
    return { kind: 'ok', obs: decodeObservationState(data)! };
  }
  const launch = (h: PoolView['history']) => viewOf(b, { sol: SOL, tok: TOK, origin: 'launch-pool', history: h });
  const now = { ...base, chainNow: 4_610n };
  // 10 SOL / 1,000 tokens = 10 SOL base units per token base unit.

  it('no outside price and no price record read: unchecked, never allowed and never a warning', () => {
    const h = assessPool({ ...now, view: launch({ kind: 'not-read' }), outside: noOutside });
    expect(h.price.state).toBe('unread');
    expect(h.deposits.verdict).toBe('unchecked');
    expect(h.deposits.warnings).toEqual([]);
  });

  it('a price that matches its own average passes, with nothing to warn of', () => {
    const h = assessPool({ ...now, view: launch(history(10n * Q32)), outside: noOutside });
    expect(h.price).toMatchObject({ state: 'agrees', against: 'own-average' });
    expect(h.deposits).toEqual({ verdict: 'allowed', reasons: [], warnings: [] });
  });

  // A launch pool with no route KEEPS its own-average check. A disagreement with it is a
  // warning now, like a disagreement with the market.
  it('a price pushed moments ago (double its half-hour average) is allowed with a warning that says it may have been pushed', () => {
    const h = assessPool({ ...now, view: launch(history(5n * Q32)), outside: noOutside });
    expect(h.price).toMatchObject({ state: 'disagrees', against: 'own-average' });
    expect(h.deposits).toEqual({
      verdict: 'allowed',
      reasons: [],
      // 99.4%, not 100%: the last ten seconds of the average are already at the pushed price.
      warnings: ['Its price is 99.4% above its own average over the last half hour. Someone may have just pushed it; a deposit now would pay for that.'],
    });
  });

  it('a launch pool with no route is never "no market": it has its own average, so that state and its warning are not used', () => {
    for (const h of [
      assessPool({ ...now, view: launch(history(10n * Q32)), outside: noOutside }),
      assessPool({ ...now, view: launch(history(5n * Q32)), outside: noOutside }),
      assessPool({ ...now, view: launch(history(10n * Q32, { initialized: false })), outside: noOutside }),
      assessPool({ ...now, view: launch({ kind: 'not-read' }), outside: noOutside }),
    ]) {
      expect(h.price.state).not.toBe('no-market');
      expect(h.deposits.warnings.join(' ')).not.toMatch(/no market price/);
    }
  });

  it('never traded: the price is the one the launch program set', () => {
    const h = assessPool({ ...now, view: launch(history(10n * Q32, { initialized: false })), outside: noOutside });
    expect(h.price.state).toBe('no-trades-yet');
    expect(h.deposits.verdict).toBe('allowed');
  });

  it('too little history since the first trade proves nothing: unchecked', () => {
    const h = assessPool({ ...now, view: launch(history(10n * Q32, { firstAt: 4_500n })), outside: noOutside });
    expect(h.deposits.verdict).toBe('unchecked');
  });

  // A failed Jupiter read is not "no outside market": the token may trade elsewhere at
  // another price. Only Jupiter's own no-route answer opens the own-history path.
  it('Jupiter down (not "no route"): never traded is unchecked, never allowed', () => {
    const down = { kind: 'unread' as const, detail: 'Jupiter did not give a price (HTTP 502)' };
    const h = assessPool({ ...now, view: launch(history(10n * Q32, { initialized: false })), outside: down });
    expect(h.price.state).toBe('unread');
    expect(h.deposits.verdict).toBe('unchecked');
    expect(h.deposits.reasons.join(' ')).toMatch(/HTTP 502/);
  });

  it('Jupiter down (not "no route"): agreeing with its own average is still unchecked', () => {
    const down = { kind: 'unread' as const, detail: 'Jupiter did not give a price (HTTP 502)' };
    const h = assessPool({ ...now, view: launch(history(10n * Q32)), outside: down });
    expect(h.deposits.verdict).toBe('unchecked');
  });

  // Its opener wrote that history, so it is no reference. With no route it has none at
  // all: allowed, and said as "no market" (owner ruling 2026-10-04).
  it('a pool anyone could open is never checked against its own history: with no route it is "no market", whatever its record says', () => {
    for (const h of [history(10n * Q32), history(5n * Q32)]) {
      const r = assessPool({ ...now, view: viewOf(b, { sol: SOL, tok: TOK, origin: 'standard', history: h }), outside: noOutside });
      expect(r.price.state).toBe('no-market');
      expect(r.deposits.verdict).toBe('allowed');
      expect(r.deposits.warnings).toHaveLength(1);
      expect(r.deposits.warnings[0]).toMatch(/^Jupiter has no market price for this token, so this pool’s price was not checked against anything\./);
    }
  });
});

/** A token that can go in, carrying these warnings on itself. */
const safetyWith = (...codes: SafetyReason['code'][]): TokenSafety =>
  ({ ...OK_TOKEN, verdict: 'warn', warnings: codes.map((code) => ({ code, text: `the token's own ${code} sentence` })) }) as TokenSafety;

const COPY_DEPOSIT =
  'It calls itself by a well-known token’s name but has a different mint, so it is not that token. If the copy turns out to be worth nothing, so is your share of this pool.';
const COPY_POOL =
  'It calls itself by a well-known token’s name but has a different mint, so it is not that token. If the copy turns out to be worth nothing, so is your share of the pool you open.';
const FREEZE_DEPOSIT =
  'Its creator can freeze the vault of this pool, and while it is frozen nobody can take liquidity out, you included. They can also freeze your own account for the token.';
const FREEZE_POOL =
  'Its creator can freeze the vault of the pool you open, and while it is frozen nobody can take liquidity out, you included. They can also freeze your own account for the token.';
const AMOUNTS =
  'The amount a wallet displays for this token changes over time. This site shows and moves raw token units, so check the amounts against your wallet before you sign.';

// Owner ruling 2026-10-04: a copy, a freezable token and one with interest or scaled
// amounts take deposits. Each is said before the deposit, in words about the money.
describe('assessPool: token warnings that a deposit must carry', () => {
  it('a copied well-known name: allowed into a perfect pool, with the copy warning', () => {
    const h = assessPool({ ...base, safety: safetyWith('copies-known-name'), view: view(), outside: outside(0.01) });
    expect(h.deposits).toEqual({ verdict: 'allowed', reasons: [], warnings: [COPY_DEPOSIT] });
  });

  it('a token its creator can freeze: allowed, with what a freeze means for this pool and for the holder', () => {
    const h = assessPool({ ...base, safety: safetyWith('freeze-authority'), view: view(), outside: outside(0.01) });
    expect(h.deposits).toEqual({ verdict: 'allowed', reasons: [], warnings: [FREEZE_DEPOSIT] });
  });

  it('interest-bearing or scaled amounts: allowed, with one line about what a wallet displays', () => {
    for (const code of ['interest-bearing', 'scaled-amount'] as const) {
      const h = assessPool({ ...base, safety: safetyWith(code), view: view(), outside: outside(0.01) });
      expect(h.deposits, code).toEqual({ verdict: 'allowed', reasons: [], warnings: [AMOUNTS] });
    }
    // Both at once is still one line.
    expect(assessPool({ ...base, safety: safetyWith('interest-bearing', 'scaled-amount'), view: view(), outside: outside(0.01) }).deposits.warnings).toEqual([AMOUNTS]);
  });

  it('every warning that applies is carried, the token’s first and the price last', () => {
    const h = assessPool({ ...base, safety: safetyWith('copies-known-name', 'freeze-authority'), view: view(), outside: outside(0.02) });
    expect(h.deposits.verdict).toBe('allowed');
    expect(h.deposits.warnings).toEqual([COPY_DEPOSIT, FREEZE_DEPOSIT, 'Its price is 50.0% below the outside price. A deposit here would hand that gap to the first arbitrage trade.']);
  });

  it('the other token warnings stay on the token: a live mint authority, USDC’s accepted freeze authority and the rest add nothing here', () => {
    for (const code of ['mint-authority', 'freeze-authority-accepted', 'metadata-mutable', 'no-metadata', 'metadata-elsewhere', 'metadata-unreadable', 'lookalike-letters'] as const) {
      expect(assessPool({ ...base, safety: safetyWith(code), view: view(), outside: outside(0.01) }).deposits, code).toEqual({ verdict: 'allowed', reasons: [], warnings: [] });
    }
  });

  it('a warning never lifts a refusal: a copy in a pool with withdrawals off is still refused, and still warned', () => {
    const h = assessPool({ ...base, safety: safetyWith('copies-known-name'), view: view({ status: POOL_STATUS_DISABLE_WITHDRAW }), outside: outside(0.01) });
    expect(h.deposits.verdict).toBe('refused');
    expect(h.deposits.warnings).toEqual([COPY_DEPOSIT]);
  });
});

// One judgement of the token, shared by deposits and by opening a pool (SPEC_S2_CREATE
// N7, N16): assessPool's token reasons and warnings ARE tokenReasons(…, 'deposits'), and
// the pools version differs only in which pool its warnings name.
describe('tokenReasons', () => {
  const copy = safetyWith('copies-known-name');
  const blockedCopy: TokenSafety = { ...copy, verdict: 'blocked', blocks: [{ code: 'transfer-fee', text: 'x' }] } as TokenSafety;
  const fixtures: Array<[string, TokenSafety | null]> = [
    ['ok', OK_TOKEN],
    ['warned', safetyWith('mint-authority')],
    ['blocked', { ...OK_TOKEN, verdict: 'blocked', blocks: [{ code: 'transfer-fee', text: 'x' }] } as TokenSafety],
    ['a copied name', copy],
    ['a freezable token', safetyWith('freeze-authority')],
    ['a copy that can be frozen and bears interest', safetyWith('copies-known-name', 'freeze-authority', 'interest-bearing')],
    ['a blocked copy', blockedCopy],
    ['absent', { kind: 'absent', mint: mint.toBase58() }],
    ['unread', { kind: 'unread', mint: mint.toBase58(), detail: 'HTTP 502' }],
    ['not read at all', null],
  ];

  it.each(fixtures)('%s: the deposit reasons and warnings are exactly the token part of assessPool', (_name, safety) => {
    // A pool that passes everything else, so every reason and warning left is the token's.
    const h = assessPool({ ...base, safety, view: view(), outside: outside(0.01) });
    const t = tokenReasons(safety, 'deposits');
    expect(h.deposits.reasons).toEqual([...t.refused, ...t.unchecked]);
    expect(h.deposits.warnings).toEqual(t.warned);
  });

  it.each(fixtures)('%s: the pools version differs only in which pool its warnings name', (_name, safety) => {
    const deposits = tokenReasons(safety, 'deposits');
    const pools = tokenReasons(safety, 'pools');
    const swap = (s: string) => s.replace('this pool', 'the pool you open');
    expect(pools).toEqual({ refused: deposits.refused, unchecked: deposits.unchecked, warned: deposits.warned.map(swap) });
  });

  it('a copied name is warned of for both, each naming its own pool, and refuses neither', () => {
    expect(tokenReasons(copy, 'deposits')).toEqual({ refused: [], unchecked: [], warned: [COPY_DEPOSIT] });
    expect(tokenReasons(copy, 'pools')).toEqual({ refused: [], unchecked: [], warned: [COPY_POOL] });
  });

  it('a freezable token is warned of for both, each naming its own pool', () => {
    expect(tokenReasons(safetyWith('freeze-authority'), 'deposits').warned).toEqual([FREEZE_DEPOSIT]);
    expect(tokenReasons(safetyWith('freeze-authority'), 'pools').warned).toEqual([FREEZE_POOL]);
  });

  it('what stays refused or unchecked is never turned into a warning', () => {
    expect(tokenReasons({ kind: 'absent', mint: mint.toBase58() }, 'deposits')).toEqual({ refused: ['The token does not exist.'], unchecked: [], warned: [] });
    expect(tokenReasons({ kind: 'unread', mint: mint.toBase58(), detail: 'HTTP 502' }, 'pools')).toEqual({
      refused: [],
      unchecked: ['We could not read the token, so we cannot say whether it is safe.'],
      warned: [],
    });
    expect(tokenReasons(null, 'deposits').unchecked).toHaveLength(1);
    expect(tokenReasons(blockedCopy, 'deposits').refused).toEqual(['This token is blocked on this site (see why above).']);
  });

  it('no warning sentence says this site refuses what it now does', () => {
    const all = [COPY_DEPOSIT, COPY_POOL, FREEZE_DEPOSIT, FREEZE_POOL, AMOUNTS].join(' ');
    expect(all).not.toMatch(/does not (take|open|accept)|must start within/);
  });
});

describe('comparePrice', () => {
  it('is the deposit check’s own comparison, exported: 3% apart (as near as a double gets) agrees, more disagrees', () => {
    expect(comparePrice(0.206, 0.2, 'outside')).toMatchObject({ state: 'agrees', against: 'outside' });
    expect(comparePrice(0.2062, 0.2, 'outside')).toMatchObject({ state: 'disagrees' });
    expect(comparePrice(0.1941, 0.2, 'outside').state).toBe('agrees');
    expect(comparePrice(0.1938, 0.2, 'outside').state).toBe('disagrees');
    expect(PRICE_TOLERANCE).toBe(0.03);
  });
});
