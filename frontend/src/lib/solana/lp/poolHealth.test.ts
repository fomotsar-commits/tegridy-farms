// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  assessPool,
  comparePrice,
  poolSolPerToken,
  PRICE_TOLERANCE,
  FAR_FUTURE_SECS,
  tokenReasons,
  reservesMatchShares,
  DEPOSIT_RESERVES_MOVED,
  DEPOSIT_TOO_QUIET,
  LAUNCH_MAX_SILENCE_DIVISOR,
  UNTRADED_RESERVES_TOLERANCE_BPS,
} from './poolHealth';
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
  // The pool program opens a pool with lp_supply = floor(sqrt(side0 x side1)): 3,162,277,660 here.
  const SHARES = 3_162_277_660n;
  const b = buildPool({ mint, solReserve: SOL, tokenReserve: TOK, openTime: 100n, lpSupply: SHARES });
  const tokenIs0 = viewOf(b, { sol: SOL, tok: TOK }).solIsToken0 === false;
  const Q32 = 1n << 32n;
  /**
   * A price record from `firstAt` (1,000) to 4,600 at one price `solPerBase` (SOL base
   * units per token base unit), a slot every `stepSecs`. The default (a trade a minute)
   * is a steadily traded pool; 3,600 is two slots an hour apart: one swap, an hour of
   * nothing, one swap.
   */
  function history(solPerBaseX32: bigint, o: { firstAt?: bigint; initialized?: boolean; stepSecs?: bigint } = {}): PoolView['history'] {
    const first = o.firstAt ?? 1_000n;
    const step = o.stepSecs ?? 60n;
    const times: bigint[] = [];
    for (let t = first; t < 4_600n; t += step) times.push(t);
    times.push(4_600n);
    const obs = times.map((t, i): [number, bigint, bigint, bigint] => {
      const own = solPerBaseX32 * (t - first);
      const other = ((Q32 * Q32) / solPerBaseX32) * (t - first);
      return tokenIs0 ? [i, t, own, other] : [i, t, other, own];
    });
    const data = observationBytes({ pool: b.address, initialized: o.initialized, index: obs.length - 1, lastUpdate: 4_600n, obs });
    return { kind: 'ok', obs: decodeObservationState(data)! };
  }
  const launch = (h: PoolView['history'], r: { sol?: bigint; tok?: bigint } = {}) =>
    viewOf(b, { sol: r.sol ?? SOL, tok: r.tok ?? TOK, origin: 'launch-pool', history: h });
  const now = { ...base, chainNow: 4_610n };
  const never = history(10n * Q32, { initialized: false });
  // 10 SOL / 1,000 tokens = 10 SOL base units per token base unit.

  it('no outside price and no price record read: unchecked, never allowed', () => {
    const h = assessPool({ ...now, view: launch({ kind: 'not-read' }), outside: noOutside });
    expect(h.price.state).toBe('unread');
    expect(h.deposits.verdict).toBe('unchecked');
  });

  it('it traded steadily through the window and its price matches that average: passes', () => {
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

  it('never traded and still holding exactly what its shares account for: the price is the one the launch program set', () => {
    const h = assessPool({ ...now, view: launch(never), outside: noOutside });
    expect(h.price.state).toBe('no-trades-yet');
    expect(h.deposits.verdict).toBe('allowed');
  });

  // funds-1, on the LIVE deposit check. A pool's reserves are its vaults' live balances
  // and its price record is written only by swaps, so tokens or SOL sent STRAIGHT into a
  // vault move the price with no mark; one dust swap then writes the moved price across
  // the whole quiet stretch of the record. Each case below was 'allowed' before.
  describe('a price moved without a trade is refused for deposits, and removing is untouched', () => {
    const refusedWith = (h: ReturnType<typeof assessPool>, state: string, sentence: string) => {
      expect(h.deposits.verdict).toBe('refused');
      expect(h.price.state).toBe(state);
      expect(h.deposits.reasons).toEqual([sentence]);
      // The leave rule: none of this is read by a withdrawal.
      expect(h.withdrawals).toBe('open');
    };

    it('never traded, but topped up by a plain transfer into the token vault: refused, in its own words', () => {
      // Half as many tokens again in the vault; the shares did not move.
      refusedWith(assessPool({ ...now, view: launch(never, { tok: (TOK * 3n) / 2n }), outside: noOutside }), 'reserves-moved', DEPOSIT_RESERVES_MOVED);
    });

    it('never traded, wrapped SOL sent into the SOL vault: refused the same way', () => {
      refusedWith(assessPool({ ...now, view: launch(never, { sol: SOL * 2n }), outside: noOutside }), 'reserves-moved', DEPOSIT_RESERVES_MOVED);
    });

    it('a deposit or a withdrawal before the first trade moves both sides and the shares together, and still passes', () => {
      const doubled = viewOf(buildPool({ mint, solReserve: SOL * 2n, tokenReserve: TOK * 2n, lpSupply: SHARES * 2n }), { sol: SOL * 2n, tok: TOK * 2n, origin: 'launch-pool', history: never });
      expect(assessPool({ ...now, view: doubled, outside: noOutside }).deposits.verdict).toBe('allowed');
      // Rounding dust in the pool's favour passes; the tolerance is 10 bps of the product.
      expect(UNTRADED_RESERVES_TOLERANCE_BPS).toBe(10n);
      expect(reservesMatchShares(launch(never, { tok: TOK + 1n }))).toBe(true);
      expect(reservesMatchShares(launch(never, { tok: TOK + TOK / 500n }))).toBe(false);
    });

    it('a transfer, then one dust swap: that swap writes the moved price over the whole quiet hour, so the average "agrees": refused', () => {
      // Two slots an hour apart, the whole hour credited at 5 (the moved price), and the pool at 5.
      const pushed = launch(history(5n * Q32, { stepSecs: 3_600n }), { tok: TOK * 2n });
      const h = assessPool({ ...now, view: pushed, outside: noOutside });
      refusedWith(h, 'too-quiet', DEPOSIT_TOO_QUIET);
      // It really is within 3% of that average: only the silence gives it away.
      expect(Math.abs((h.price as { diff: number }).diff)).toBeLessThan(PRICE_TOLERANCE);
    });

    it('a quiet record: traded steadily, then nothing for an hour. "Its average" is the price now compared with itself: refused', () => {
      const later = { ...base, chainNow: 8_200n };
      // The honest pool, and the same pool with tokens sent in during the quiet hour: silence is not evidence either way.
      refusedWith(assessPool({ ...later, view: launch(history(10n * Q32)), outside: noOutside }), 'too-quiet', DEPOSIT_TOO_QUIET);
      refusedWith(assessPool({ ...later, view: launch(history(10n * Q32), { tok: TOK * 2n }), outside: noOutside }), 'too-quiet', DEPOSIT_TOO_QUIET);
    });

    it('the longest stretch with no recorded swap may be a sixth of the window, and not a second more', () => {
      expect(LAUNCH_MAX_SILENCE_DIVISOR).toBe(6n);
      // Last swap at 4,600. At 4,900 the window is 1,800 s, of which 300 are silent.
      expect(assessPool({ ...base, chainNow: 4_900n, view: launch(history(10n * Q32)), outside: noOutside }).deposits.verdict).toBe('allowed');
      expect(assessPool({ ...base, chainNow: 4_901n, view: launch(history(10n * Q32)), outside: noOutside }).price.state).toBe('too-quiet');
      // A silent stretch in the MIDDLE of the window counts the same as one at its end.
      expect(assessPool({ ...now, view: launch(history(10n * Q32, { stepSecs: 400n })), outside: noOutside }).price.state).toBe('too-quiet');
    });

    it('a real outside price still decides on its own: none of this applies when Jupiter prices the token', () => {
      const quietAndToppedUp = launch(history(10n * Q32, { stepSecs: 3_600n }), { tok: (TOK * 101n) / 100n });
      const h = assessPool({ ...now, view: quietAndToppedUp, outside: outside(0.0099) });
      expect(h.price).toMatchObject({ state: 'agrees', against: 'outside' });
      expect(h.deposits.verdict).toBe('allowed');
    });
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

  // SPEC_S3 D8: routing a swap judges the token with the same function.
  it('a copied name is refused for swaps too, in its own words', () => {
    expect(tokenReasons(copy, 'swaps').refused).toEqual([
      'It calls itself by a well-known token’s name but has a different mint. This site does not send trades to pools of copies.',
    ]);
  });

  it.each(fixtures)('%s: the swaps version differs only in the copied-name sentence', (_name, safety) => {
    const deposits = tokenReasons(safety, 'deposits');
    const swaps = tokenReasons(safety, 'swaps');
    const swap = (s: string) => s.replace('This site does not take deposits into copies.', 'This site does not send trades to pools of copies.');
    expect(swaps).toEqual({ refused: deposits.refused.map(swap), unchecked: deposits.unchecked });
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
