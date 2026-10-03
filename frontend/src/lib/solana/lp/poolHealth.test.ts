// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { assessPool, comparePrice, poolSolPerToken, PRICE_TOLERANCE, FAR_FUTURE_SECS, tokenReasons } from './poolHealth';
import { decodeObservationState } from './ownPrice';
import { POOL_STATUS_DISABLE_DEPOSIT, POOL_STATUS_DISABLE_SWAP, POOL_STATUS_DISABLE_WITHDRAW } from '../cpswap/program';
import type { PoolView } from './poolFinder';
import type { TokenSafety } from './tokenSafety';
import { buildPool, key, observationBytes, viewOf } from './testkit.fixture';

const mint = key();
const OK_TOKEN: TokenSafety = { kind: 'read', mint: mint.toBase58(), verdict: 'ok', blocks: [], warnings: [], facts: null, name: null, symbol: null, metadataSource: 'none' };
const SOL = 10n * 10n ** 9n;
const TOK = 1_000n * 10n ** 6n;

/** 10 SOL against 1,000 tokens (6 decimals): 0.01 SOL per token. */
function view(o: { openTime?: bigint; status?: number; sol?: bigint; tok?: bigint; origin?: PoolView['origin']; frozen?: boolean; history?: PoolView['history']; config?: PoolView['config'] | 'decoded' } = {}): PoolView {
  const b = buildPool({ mint, solReserve: o.sol ?? SOL, tokenReserve: o.tok ?? TOK, openTime: o.openTime ?? 100n, status: o.status ?? 0 });
  return viewOf(b, { sol: o.sol ?? SOL, tok: o.tok ?? TOK, origin: o.origin, frozen: o.frozen, history: o.history, config: o.config });
}

const base = { tokenDecimals: 6, chainNow: 1_000n, safety: OK_TOKEN };
const outside = (p: number) => ({ kind: 'ok' as const, solPerToken: p, source: 'Jupiter' as const });
const noOutside = { kind: 'no-route' as const, detail: 'Jupiter has no route for this token' };

describe('assessPool', () => {
  it('prices the pool from its reserves, SOL per whole token', () => {
    expect(poolSolPerToken(view().snapshot, mint.toBase58(), 6)).toBeCloseTo(0.01, 12);
  });

  it('a healthy pool: open, price within 3% of the outside price, token ok → deposits allowed', () => {
    const h = assessPool({ ...base, view: view(), outside: outside(0.0101) });
    expect(h.swaps).toEqual({ state: 'open' });
    expect(h.withdrawals).toBe('open');
    expect(h.price).toMatchObject({ state: 'agrees', against: 'outside' });
    expect(h.deposits).toEqual({ verdict: 'allowed', reasons: [] });
  });

  it('refuses deposits when the price is more than 3% off, either way', () => {
    for (const p of [0.01 / (1 + PRICE_TOLERANCE + 0.001), 0.01 / (1 - PRICE_TOLERANCE - 0.001)]) {
      const h = assessPool({ ...base, view: view(), outside: outside(p) });
      expect(h.price.state).toBe('disagrees');
      expect(h.deposits.verdict).toBe('refused');
    }
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

  it('what was not read is "unchecked", never "allowed": the clock, the outside price, the token', () => {
    expect(assessPool({ ...base, chainNow: null, view: view(), outside: outside(0.01) }).deposits.verdict).toBe('unchecked');
    expect(assessPool({ ...base, view: view(), outside: { kind: 'unread', detail: 'down' } }).deposits.verdict).toBe('unchecked');
    expect(assessPool({ ...base, safety: { kind: 'unread', mint: mint.toBase58(), detail: 'x' }, view: view(), outside: outside(0.01) }).deposits.verdict).toBe('unchecked');
  });

  it('a blocked token refuses deposits even into a perfect pool', () => {
    const blocked: TokenSafety = { ...OK_TOKEN, verdict: 'blocked', blocks: [{ code: 'freeze-authority', text: 'x' }] } as TokenSafety;
    expect(assessPool({ ...base, safety: blocked, view: view(), outside: outside(0.01) }).deposits.verdict).toBe('refused');
  });

  // S1-R09: a price we chose not to compare is not a price we "could not read".
  it('a blocked token’s price is skipped on purpose, not described as unreadable', () => {
    const blocked: TokenSafety = { ...OK_TOKEN, verdict: 'blocked', blocks: [{ code: 'freeze-authority', text: 'x' }] } as TokenSafety;
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
  const b = buildPool({ mint, solReserve: SOL, tokenReserve: TOK, openTime: 100n });
  const tokenIs0 = viewOf(b, { sol: SOL, tok: TOK }).solIsToken0 === false;
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

  it('no outside price and no price record read: unchecked, never allowed', () => {
    const h = assessPool({ ...now, view: launch({ kind: 'not-read' }), outside: noOutside });
    expect(h.price.state).toBe('unread');
    expect(h.deposits.verdict).toBe('unchecked');
  });

  it('a price that matches its own average passes', () => {
    const h = assessPool({ ...now, view: launch(history(10n * Q32)), outside: noOutside });
    expect(h.price).toMatchObject({ state: 'agrees', against: 'own-average' });
    expect(h.deposits.verdict).toBe('allowed');
  });

  it('a price pushed moments ago (double its half-hour average) is refused', () => {
    const h = assessPool({ ...now, view: launch(history(5n * Q32)), outside: noOutside });
    expect(h.price).toMatchObject({ state: 'disagrees', against: 'own-average' });
    expect(h.deposits.verdict).toBe('refused');
    expect(h.deposits.reasons.join(' ')).toMatch(/own average/);
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

  it('a pool anyone could open is never checked against its own history', () => {
    const h = assessPool({ ...now, view: viewOf(b, { sol: SOL, tok: TOK, origin: 'standard', history: history(10n * Q32) }), outside: noOutside });
    expect(h.deposits.verdict).toBe('unchecked');
  });
});

// D15: a token that poses as SOL, USDC, USDT, BAYLA or TOWELI from a different mint is
// a warning on the token itself, and never takes a deposit here.
describe('assessPool: a copied well-known name', () => {
  it('refuses deposits into a perfect pool when the token copies a well-known name', () => {
    const copy: TokenSafety = {
      ...OK_TOKEN,
      verdict: 'warn',
      warnings: [{ code: 'copies-known-name', text: 'It calls itself USDC, but it is NOT the real USDC.' }],
    } as TokenSafety;
    const h = assessPool({ ...base, safety: copy, view: view(), outside: outside(0.01) });
    expect(h.deposits.verdict).toBe('refused');
    expect(h.deposits.reasons).toContain('It calls itself by a well-known token’s name but has a different mint. This site does not take deposits into copies.');
  });

  it('any other warning alone still allows deposits (a live mint authority stays a warning)', () => {
    const warned: TokenSafety = { ...OK_TOKEN, verdict: 'warn', warnings: [{ code: 'mint-authority', text: 'x' }] } as TokenSafety;
    expect(assessPool({ ...base, safety: warned, view: view(), outside: outside(0.01) }).deposits.verdict).toBe('allowed');
  });
});

// One judgement of the token, shared by deposits and by opening a pool (SPEC_S2_CREATE
// N7, N16): assessPool's token reasons ARE tokenReasons(…, 'deposits'), and the pools
// version differs only in the copied-name sentence.
describe('tokenReasons', () => {
  const copy: TokenSafety = {
    ...OK_TOKEN,
    verdict: 'warn',
    warnings: [{ code: 'copies-known-name', text: 'It calls itself USDC, but it is NOT the real USDC.' }],
  } as TokenSafety;
  const blockedCopy: TokenSafety = {
    ...copy,
    verdict: 'blocked',
    blocks: [{ code: 'freeze-authority', text: 'x' }],
  } as TokenSafety;
  const fixtures: Array<[string, TokenSafety | null]> = [
    ['ok', OK_TOKEN],
    ['warned', { ...OK_TOKEN, verdict: 'warn', warnings: [{ code: 'mint-authority', text: 'x' }] } as TokenSafety],
    ['blocked', { ...OK_TOKEN, verdict: 'blocked', blocks: [{ code: 'freeze-authority', text: 'x' }] } as TokenSafety],
    ['a copied name', copy],
    ['a blocked copy', blockedCopy],
    ['absent', { kind: 'absent', mint: mint.toBase58() }],
    ['unread', { kind: 'unread', mint: mint.toBase58(), detail: 'HTTP 502' }],
    ['not read at all', null],
  ];

  it.each(fixtures)('%s: the deposit reasons are exactly the token part of assessPool', (_name, safety) => {
    // A pool that passes everything else, so every reason left is the token's.
    const h = assessPool({ ...base, safety, view: view(), outside: outside(0.01) });
    const t = tokenReasons(safety, 'deposits');
    expect(h.deposits.reasons).toEqual([...t.refused, ...t.unchecked]);
  });

  it.each(fixtures)('%s: the pools version differs only in the copied-name sentence', (_name, safety) => {
    const deposits = tokenReasons(safety, 'deposits');
    const pools = tokenReasons(safety, 'pools');
    const swap = (s: string) => s.replace('This site does not take deposits into copies.', 'This site does not open pools for copies.');
    expect(pools).toEqual({ refused: deposits.refused.map(swap), unchecked: deposits.unchecked });
  });

  it('a copied name is refused for both, each in its own words', () => {
    expect(tokenReasons(copy, 'deposits').refused).toEqual([
      'It calls itself by a well-known token’s name but has a different mint. This site does not take deposits into copies.',
    ]);
    expect(tokenReasons(copy, 'pools').refused).toEqual([
      'It calls itself by a well-known token’s name but has a different mint. This site does not open pools for copies.',
    ]);
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
