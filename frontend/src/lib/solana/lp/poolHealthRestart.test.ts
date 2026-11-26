// @vitest-environment node
//
// When the pool's own check offers a restart at the market price (poolHealth.ts `restart`,
// restart.ts): only when the ONE thing refusing a deposit is that the pool is almost empty,
// and only at an outside price that was read. The pool is the venue's dead SOL / TBB pool
// as mainnet held it on 2026-11-26: 18 lamports, 567 units, the locked 100 shares.
import { describe, expect, it } from 'vitest';
import { POOL_STATUS_DISABLE_DEPOSIT } from '../cpswap/program';
import { NEARLY_EMPTY, assessPool } from './poolHealth';
import { offersRestart } from './poolList';
import type { PoolView } from './poolFinder';
import { USDC_QUOTE } from './quotes';
import { buildPool, key, viewOf } from './testkit.fixture';
import type { TokenSafety } from './tokenSafety';

const mint = key();
const OK_TOKEN: TokenSafety = { kind: 'read', mint: mint.toBase58(), verdict: 'ok', blocks: [], warnings: [], facts: null, name: null, symbol: null, metadataSource: 'none' };
const FREEZABLE: TokenSafety = { ...OK_TOKEN, verdict: 'warn', warnings: [{ code: 'freeze-authority', text: 'Its creator can freeze it.' }] } as TokenSafety;

function dead(o: { lpSupply?: bigint; status?: number; quote?: typeof USDC_QUOTE } = {}): PoolView {
  const b = buildPool({ mint, quoteReserve: 18n, tokenReserve: 567n, lpSupply: o.lpSupply ?? 100n, openTime: 100n, status: o.status ?? 0, quote: o.quote });
  return viewOf(b, { sol: 18n, tok: 567n });
}
const base = { tokenDecimals: 6, chainNow: 1_000n, safety: OK_TOKEN };
// Jupiter: 39.83 units of TBB a lamport, 0.0000251 SOL a token. The pool's own price is 21% off it.
const MARKET = 1e6 / 39.83 / 1e9;
const outside = (p = MARKET) => ({ kind: 'ok' as const, solPerToken: p, source: 'Jupiter' as const });

describe('assessPool: a restart offered', () => {
  it('for an almost empty pool at a read price, at that price, and an ordinary deposit is still refused', () => {
    const h = assessPool({ ...base, view: dead(), outside: outside() });
    expect(h.deposits).toMatchObject({ verdict: 'refused', reasons: [NEARLY_EMPTY] });
    expect(h.restart).toEqual({ perToken: MARKET, warnings: [] });
  });

  it('carries the token’s own warnings, never the gap to the pool’s old price', () => {
    const h = assessPool({ ...base, safety: FREEZABLE, view: dead(), outside: outside() });
    expect(h.price.state).toBe('disagrees');
    expect(h.restart?.warnings).toHaveLength(1);
    expect(h.restart?.warnings[0]).toMatch(/freeze the vault of this pool/);
  });

  it('in the pool’s own coin, for a pool paired with USDC', () => {
    const view = dead({ quote: USDC_QUOTE });
    // 1 USDC = 0.005 SOL, so 0.0000251 SOL a token is 0.00502 USDC a token.
    const h = assessPool({ ...base, view, outside: outside(), coinOutside: outside(0.005) });
    expect(h.restart?.perToken).toBeCloseTo(MARKET / 0.005, 12);
  });

  it('not without an outside price that was read: unread, no route, or a pairing coin unread', () => {
    expect(assessPool({ ...base, view: dead(), outside: { kind: 'unread', detail: 'down' } }).restart).toBeNull();
    expect(assessPool({ ...base, view: dead(), outside: { kind: 'no-route', detail: 'no route' } }).restart).toBeNull();
    expect(assessPool({ ...base, view: dead(), outside: null }).restart).toBeNull();
    expect(assessPool({ ...base, view: dead({ quote: USDC_QUOTE }), outside: outside(), coinOutside: null }).restart).toBeNull();
  });

  it('not beside any other refusal or anything unread', () => {
    expect(assessPool({ ...base, view: dead({ status: POOL_STATUS_DISABLE_DEPOSIT }), outside: outside() }).restart).toBeNull();
    expect(assessPool({ ...base, chainNow: null, view: dead(), outside: outside() }).restart).toBeNull();
    expect(assessPool({ ...base, safety: { kind: 'unread', mint: mint.toBase58(), detail: 'down' }, view: dead(), outside: outside() }).restart).toBeNull();
    expect(assessPool({ ...base, safety: { ...OK_TOKEN, verdict: 'blocked', blocks: [{ code: 'freeze-authority', text: 'no' }] } as TokenSafety, view: dead(), outside: outside() }).restart).toBeNull();
  });

  it('not while anyone holds a share, almost empty as it is: the top-up would be theirs', () => {
    const h = assessPool({ ...base, view: dead({ lpSupply: 1_100n }), outside: outside() });
    expect(h.deposits).toMatchObject({ verdict: 'refused', reasons: [NEARLY_EMPTY] });
    expect(h.restart).toBeNull();
    expect(assessPool({ ...base, view: dead({ lpSupply: 101n }), outside: outside() }).restart).toBeNull();
  });

  it('not for a pool that is not almost empty', () => {
    expect(assessPool({ ...base, view: dead({ lpSupply: 100_000n }), outside: outside() }).restart).toBeNull();
  });
});

// The All pools row says Restart from the list's own Jupiter prices; the card asks again on its own.
describe('offersRestart: the row of All pools', () => {
  const usd = (v: PoolView) => new Map([[v.tokenMint, 0.0000251 * 150], [v.quote.mint, 150]]);
  it('for a pool everyone has left, with both its coins priced', () => {
    const v = dead();
    expect(offersRestart(v, 1_000n, OK_TOKEN, usd(v))).toBe(true);
  });
  it('not while anyone holds a share, nor without both prices', () => {
    const held = dead({ lpSupply: 1_100n });
    expect(offersRestart(held, 1_000n, OK_TOKEN, usd(held))).toBe(false);
    const v = dead();
    expect(offersRestart(v, 1_000n, OK_TOKEN, null)).toBe(false);
    expect(offersRestart(v, 1_000n, OK_TOKEN, new Map([[v.tokenMint, 1]]))).toBe(false);
  });
});
