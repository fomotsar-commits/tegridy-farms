// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { assessPool, poolSolPerToken, PRICE_TOLERANCE, FAR_FUTURE_SECS } from './poolHealth';
import { decodePoolState, POOL_STATUS_DISABLE_DEPOSIT, POOL_STATUS_DISABLE_SWAP } from '../cpswap/program';
import type { PoolSnapshot } from '../cpswap/read';
import type { TokenSafety } from './tokenSafety';
import { buildPool, key } from './testkit.fixture';

const mint = key();
const OK_TOKEN: TokenSafety = { kind: 'read', mint: mint.toBase58(), verdict: 'ok', blocks: [], warnings: [], facts: null, name: null, symbol: null, metadataSource: 'none' };

/** 10 SOL against 1,000 tokens (6 decimals): 0.01 SOL per token. */
function snap(o: { openTime?: bigint; status?: number; sol?: bigint; tok?: bigint } = {}): PoolSnapshot {
  const b = buildPool({ mint, solReserve: o.sol ?? 10n * 10n ** 9n, tokenReserve: o.tok ?? 1_000n * 10n ** 6n, openTime: o.openTime ?? 100n, status: o.status ?? 0 });
  const pool = decodePoolState(b.address.toBase58(), b.accounts[b.address.toBase58()]!.data)!;
  const solIs0 = pool.token0Mint.startsWith('So111');
  const s = o.sol ?? 10n * 10n ** 9n;
  const t = o.tok ?? 1_000n * 10n ** 6n;
  return { pool, vault0Amount: solIs0 ? s : t, vault1Amount: solIs0 ? t : s, reserve0: solIs0 ? s : t, reserve1: solIs0 ? t : s };
}

const base = { tokenMint: mint.toBase58(), tokenDecimals: 6, chainNow: 1_000n, safety: OK_TOKEN, isLaunchPool: false };
const outside = (p: number) => ({ kind: 'ok' as const, solPerToken: p, source: 'Jupiter' as const });

describe('assessPool', () => {
  it('prices the pool from its reserves, SOL per whole token', () => {
    expect(poolSolPerToken(snap(), mint.toBase58(), 6)).toBeCloseTo(0.01, 12);
  });

  it('a healthy pool: open, price within 3% of the outside price, token ok → deposits allowed', () => {
    const h = assessPool({ ...base, snapshot: snap(), outside: outside(0.0101) });
    expect(h.swaps).toEqual({ state: 'open' });
    expect(h.price.state).toBe('agrees');
    expect(h.deposits).toEqual({ verdict: 'allowed', reasons: [] });
  });

  it('refuses deposits when the price is more than 3% off, either way', () => {
    for (const p of [0.01 / (1 + PRICE_TOLERANCE + 0.001), 0.01 / (1 - PRICE_TOLERANCE - 0.001)]) {
      const h = assessPool({ ...base, snapshot: snap(), outside: outside(p) });
      expect(h.price.state).toBe('disagrees');
      expect(h.deposits.verdict).toBe('refused');
    }
  });

  it('a squatted pool: open time far ahead → swaps blocked, deposits refused, and it says so', () => {
    const h = assessPool({ ...base, snapshot: snap({ openTime: 1_000n + FAR_FUTURE_SECS + 1n }), outside: outside(0.01) });
    expect(h.swaps).toMatchObject({ state: 'not-open-yet', farFuture: true });
    expect(h.deposits.verdict).toBe('refused');
    expect(h.deposits.reasons[0]).toMatch(/earns nothing/);
  });

  it('switched-off bits are refused, and swaps switched off is not "open"', () => {
    expect(assessPool({ ...base, snapshot: snap({ status: POOL_STATUS_DISABLE_DEPOSIT }), outside: outside(0.01) }).deposits.verdict).toBe('refused');
    const h = assessPool({ ...base, snapshot: snap({ status: POOL_STATUS_DISABLE_SWAP }), outside: outside(0.01) });
    expect(h.swaps.state).toBe('switched-off');
    expect(h.deposits.verdict).toBe('refused');
  });

  it('what was not read is "unchecked", never "allowed": the clock, the outside price, the token', () => {
    expect(assessPool({ ...base, chainNow: null, snapshot: snap(), outside: outside(0.01) }).deposits.verdict).toBe('unchecked');
    expect(assessPool({ ...base, snapshot: snap(), outside: { kind: 'unread', detail: 'down' } }).deposits.verdict).toBe('unchecked');
    expect(assessPool({ ...base, safety: { kind: 'unread', mint: mint.toBase58(), detail: 'x' }, snapshot: snap(), outside: outside(0.01) }).deposits.verdict).toBe('unchecked');
  });

  it('a launch pool with no outside price is not held for price (only the launch program can open it)', () => {
    const h = assessPool({ ...base, isLaunchPool: true, snapshot: snap(), outside: { kind: 'unread', detail: 'no route' } });
    expect(h.price.state).toBe('unread');
    expect(h.deposits.verdict).toBe('allowed');
  });

  it('a blocked token refuses deposits even into a perfect pool', () => {
    const blocked: TokenSafety = { ...OK_TOKEN, verdict: 'blocked', blocks: [{ code: 'freeze-authority', text: 'x' }] } as TokenSafety;
    expect(assessPool({ ...base, safety: blocked, snapshot: snap(), outside: outside(0.01) }).deposits.verdict).toBe('refused');
  });

  it('an empty pool has no price and takes no deposit', () => {
    const h = assessPool({ ...base, snapshot: snap({ tok: 0n }), outside: outside(0.01) });
    expect(h.price.state).toBe('empty-pool');
    expect(h.deposits.verdict).toBe('refused');
  });
});
