// @vitest-environment node
//
// The leave rule, row by row (spec 3.7): what may refuse adding, and the much shorter
// list of what may refuse removing.
import { describe, it, expect } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { POOL_STATUS_DISABLE_DEPOSIT, POOL_STATUS_DISABLE_SWAP, POOL_STATUS_DISABLE_WITHDRAW } from '../../../lib/solana/cpswap/program';
import { assessPool, FAR_FUTURE_SECS } from '../../../lib/solana/lp/poolHealth';
import type { PoolView } from '../../../lib/solana/lp/poolFinder';
import type { Position } from '../../../lib/solana/lp/positions';
import type { TokenSafety } from '../../../lib/solana/lp/tokenSafety';
import { buildPool, key, viewOf } from '../../../lib/solana/lp/testkit.fixture';
import type { PendingTrade } from '../curve/pendingTrade';
import type { CurveWriteConfig, LpGate } from '../curve/ports';
import { depositOffer, lpHeld, withdrawOffer } from './offers';

const mint = key();
const SOL = 10n * 10n ** 9n;
const TOK = 1_000n * 10n ** 6n;
const NOW = 1_000n;
const cfg = { programId: key(), cpSwapProgram: key(), cluster: 'localnet' } as CurveWriteConfig;
const OPEN: LpGate = { kind: 'open', cfg, mode: 'on' };
const OPEN_WITHDRAW_ONLY: LpGate = { kind: 'open', cfg, mode: 'withdraw-only' };
const BLOCKED: LpGate[] = [
  { kind: 'blocked', reason: 'wrong-cluster', detail: 'x' },
  { kind: 'blocked', reason: 'cpswap-program-missing', detail: 'x' },
  { kind: 'blocked', reason: 'unreadable', detail: 'x' },
  { kind: 'off' },
];
const okToken: TokenSafety = { kind: 'read', mint: mint.toBase58(), verdict: 'ok', blocks: [], warnings: [], facts: null, name: null, symbol: null, metadataSource: 'none' };
const blockedToken = { ...okToken, verdict: 'blocked', blocks: [{ code: 'freeze-authority', text: 'x' }] } as TokenSafety;
const warnedToken = { ...okToken, verdict: 'warn', warnings: [{ code: 'mint-authority', text: 'x' }] } as TokenSafety;
const outside = (p: number) => ({ kind: 'ok' as const, solPerToken: p, source: 'Jupiter' as const });

function view(o: { status?: number; openTime?: bigint; frozen?: boolean; sol?: bigint; tok?: bigint; lpSupply?: bigint; config?: null } = {}): PoolView {
  const b = buildPool({ mint, solReserve: o.sol ?? SOL, tokenReserve: o.tok ?? TOK, status: o.status ?? 0, openTime: o.openTime ?? 100n, lpSupply: o.lpSupply });
  return viewOf(b, { sol: o.sol ?? SOL, tok: o.tok ?? TOK, frozen: o.frozen, ...(o.config === null ? { config: null } : {}) });
}

const health = (v: PoolView, o: { safety?: TokenSafety | null; price?: number | 'unread' } = {}) =>
  assessPool({
    view: v,
    tokenDecimals: 6,
    chainNow: NOW,
    outside: o.price === 'unread' ? { kind: 'unread', detail: 'Jupiter did not give a price (HTTP 502)' } : outside(o.price ?? 0.01),
    safety: o.safety === undefined ? okToken : o.safety,
  });

function position(v: PoolView | null, o: { lpAmount?: bigint; pool?: Position['pool'] } = {}): Position {
  return {
    lpMint: v ? v.snapshot.pool.lpMint : key().toBase58(),
    lpAccount: key().toBase58(),
    lpAmount: o.lpAmount ?? 250_000n,
    placement: v || o.pool ? 'found' : 'index-unread',
    placementDetail: null,
    pool: o.pool !== undefined ? o.pool : v ? { kind: 'pool', view: v } : null,
    value: null,
    tooSmall: false,
  };
}

const add = (v: PoolView, o: { mode?: 'off' | 'on' | 'withdraw-only'; gate?: LpGate | null; held?: boolean; safety?: TokenSafety | null; price?: number | 'unread' } = {}) =>
  depositOffer({ mode: o.mode ?? 'on', gate: o.gate === undefined ? OPEN : o.gate, health: health(v, o), held: o.held ?? false });
const remove = (p: Position, o: { mode?: 'off' | 'on' | 'withdraw-only'; gate?: LpGate | null; held?: boolean } = {}) =>
  withdrawOffer({ mode: o.mode ?? 'on', gate: o.gate === undefined ? OPEN : o.gate, position: p, held: o.held ?? false });

describe('the leave rule, row by row (spec 3.7)', () => {
  it('a healthy pool: both offered', () => {
    expect(add(view())).toBe('offer');
    expect(remove(position(view()))).toBe('offer');
  });

  it('LP switched off: neither', () => {
    expect(add(view(), { mode: 'off' })).toBe('off');
    expect(remove(position(view()), { mode: 'off' })).toBe('off');
  });

  it('withdraw-only: adding is paused here, removing is offered', () => {
    expect(add(view(), { mode: 'withdraw-only', gate: OPEN_WITHDRAW_ONLY })).toBe('paused-here');
    expect(remove(position(view()), { mode: 'withdraw-only', gate: OPEN_WITHDRAW_ONLY })).toBe('offer');
  });

  it('wrong cluster, pool program missing, gate unreadable or not read yet: neither', () => {
    for (const gate of [...BLOCKED, null]) {
      expect(add(view(), { gate })).toBe('gate');
      expect(remove(position(view()), { gate })).toBe('gate');
    }
  });

  it('the pool’s deposit switch is off: no add; remove offered', () => {
    const v = view({ status: POOL_STATUS_DISABLE_DEPOSIT });
    expect(add(v)).toBe('checks');
    expect(remove(position(v))).toBe('offer');
  });

  it('swaps switched off, not open yet, or open time far in the future: no add; remove offered', () => {
    for (const v of [view({ status: POOL_STATUS_DISABLE_SWAP }), view({ openTime: NOW + 60n }), view({ openTime: NOW + FAR_FUTURE_SECS + 1n }), view({ openTime: NOW + 10n * 365n * 24n * 3600n })]) {
      expect(add(v)).toBe('checks');
      expect(remove(position(v))).toBe('offer');
    }
  });

  it('the pool’s withdraw switch is off: neither, and remove says why', () => {
    const v = view({ status: POOL_STATUS_DISABLE_WITHDRAW });
    expect(add(v)).toBe('checks');
    expect(remove(position(v))).toBe('switched-off');
  });

  it('a frozen vault: neither, and remove says why', () => {
    const v = view({ frozen: true });
    expect(add(v)).toBe('checks');
    expect(remove(position(v))).toBe('vault-frozen');
  });

  it('a price off by more than 3%, or unread: no add; remove offered', () => {
    for (const price of [0.02, 0.005, 'unread' as const]) {
      expect(add(view(), { price })).toBe('checks');
      expect(remove(position(view()))).toBe('offer');
    }
  });

  it('a token blocked, warned or unread: add no / yes / no; remove offered in every case', () => {
    expect(add(view(), { safety: blockedToken })).toBe('checks');
    expect(add(view(), { safety: warnedToken })).toBe('offer');
    expect(add(view(), { safety: null })).toBe('checks');
    expect(add(view(), { safety: { kind: 'unread', mint: mint.toBase58(), detail: 'x' } })).toBe('checks');
    expect(remove(position(view()))).toBe('offer');
  });

  it('fee settings unread: no add (unchecked); remove offered', () => {
    const v = view({ config: null });
    expect(health(v).deposits.verdict).toBe('unchecked');
    expect(add(v)).toBe('checks');
    expect(remove(position(v))).toBe('offer');
  });

  it('our pool index down: the share is unplaced (the row offers the on-chain search instead)', () => {
    expect(remove(position(null))).toBe('unplaced');
  });

  it('a pending deposit on this pool holds adding, not removing (the lock is per direction)', () => {
    expect(add(view(), { held: true })).toBe('held');
    expect(remove(position(view()), { held: false })).toBe('offer');
    expect(remove(position(view()), { held: true })).toBe('held');
  });

  it('a share below the program’s minimum is dust; one share at the minimum is offered', () => {
    // 1,000 lamports over 10^6 shares: one side needs ceil(10^6 / 1000) = 1,000 shares.
    const v = view({ sol: 1_000n, tok: 10n ** 12n, lpSupply: 1_000_000n });
    expect(remove(position(v, { lpAmount: 999n }))).toBe('dust');
    expect(remove(position(v, { lpAmount: 1_000n }))).toBe('offer');
    // An empty side: no amount can come out.
    expect(remove(position(view({ sol: 0n })))).toBe('dust');
  });

  it('a pool that does not pair the token with SOL, or that could not be read: no remove from here', () => {
    expect(remove(position(null, { pool: { kind: 'other-pair', address: key().toBase58(), token0Mint: key().toBase58(), token1Mint: key().toBase58() } }))).toBe('other-pair');
    for (const pool of [
      { kind: 'unread' as const, address: key().toBase58(), detail: 'x' },
      { kind: 'absent' as const, address: key().toBase58() },
      { kind: 'not-a-pool' as const, address: key().toBase58(), detail: 'x' },
    ]) {
      expect(remove(position(null, { pool }))).toBe('pool-unread');
    }
    // A pool that does not itself name this share's mint is not one this site builds against.
    const v = view();
    expect(remove({ ...position(v), lpMint: key().toBase58() })).toBe('pool-unread');
  });
});

describe('removing never depends on what decides adding', () => {
  it('offered while every "never an input" fact holds at once', () => {
    // Deposits off, swaps off, opening in 10 years, price unread, token blocked, fee
    // settings unread: adding is refused, removing is not.
    const v = view({ status: POOL_STATUS_DISABLE_DEPOSIT | POOL_STATUS_DISABLE_SWAP, openTime: NOW + 10n * 365n * 24n * 3600n, config: null });
    expect(add(v, { safety: blockedToken, price: 'unread' })).toBe('checks');
    expect(remove(position(v))).toBe('offer');
  });
});

describe('lpHeld', () => {
  const sig = '5'.repeat(88);
  const note = (kind: PendingTrade['kind'], pool: string | null): PendingTrade => ({ kind, signature: sig, lastValidBlockHeight: 1, sentAt: 0, pool });
  const A = Keypair.generate().publicKey.toBase58();
  const B = Keypair.generate().publicKey.toBase58();

  it('holds by pool and by direction', () => {
    const notes = [note('lp-deposit', A)];
    expect(lpHeld(notes, A, 'add')).toBe(true);
    expect(lpHeld(notes, A, 'remove')).toBe(false);
    expect(lpHeld(notes, B, 'add')).toBe(false);
    expect(lpHeld([note('lp-withdraw', B)], B, 'remove')).toBe(true);
    expect(lpHeld([note('lp-withdraw', B)], B, 'add')).toBe(false);
  });

  it('a note whose pool could not be read back holds every pool, in its direction', () => {
    expect(lpHeld([note('lp-deposit', null)], A, 'add')).toBe(true);
    expect(lpHeld([note('lp-deposit', null)], B, 'add')).toBe(true);
    expect(lpHeld([note('lp-deposit', null)], A, 'remove')).toBe(false);
  });

  it('a note of another kind never holds a liquidity form', () => {
    expect(lpHeld([note('pool-buy', null), note('buy', null)], A, 'add')).toBe(false);
    expect(lpHeld([], A, 'remove')).toBe(false);
  });
});
