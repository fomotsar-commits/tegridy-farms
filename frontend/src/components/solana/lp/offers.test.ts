// @vitest-environment node
//
// The leave rule, row by row (spec 3.7): what may refuse adding, and the much shorter
// list of what may refuse removing.
import { describe, it, expect, expectTypeOf } from 'vitest';
import { Keypair, type PublicKey } from '@solana/web3.js';
import { POOL_STATUS_DISABLE_DEPOSIT, POOL_STATUS_DISABLE_SWAP, POOL_STATUS_DISABLE_WITHDRAW, publicTierConfig } from '../../../lib/solana/cpswap/program';
import { assessPool, FAR_FUTURE_SECS, type PoolHealth } from '../../../lib/solana/lp/poolHealth';
import type { PoolSearch, PoolSearchRead, PoolView } from '../../../lib/solana/lp/poolFinder';
import type { Position } from '../../../lib/solana/lp/positions';
import type { TokenSafety } from '../../../lib/solana/lp/tokenSafety';
import { TOKEN_2022_NATIVE_MINT } from '../../../lib/solana/lp/opening';
import { PROGRAM, buildPool, key, viewOf } from '../../../lib/solana/lp/testkit.fixture';
import type { CreateFacts } from '../../../lib/launcher/solana/write/types';
import type { PendingTrade } from '../curve/pendingTrade';
import type { CurveWriteConfig, LpGate } from '../curve/ports';
import { createAdvice, createHeld, createOffer, depositOffer, lpHeld, poolListCut, withdrawOffer, type CreateOffer } from './offers';

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
  const b = buildPool({ mint, quoteReserve: o.sol ?? SOL, tokenReserve: o.tok ?? TOK, status: o.status ?? 0, openTime: o.openTime ?? 100n, lpSupply: o.lpSupply });
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

// ── opening a pool (SPEC_S2_CREATE 2.5, N14, N15) ─────────────────────────────

const SIG = '5'.repeat(88);
const noteOf = (kind: PendingTrade['kind'], pool: string | null): PendingTrade => ({ kind, signature: SIG, lastValidBlockHeight: 1, sentAt: 0, pool });

describe('createHeld', () => {
  it('any pending opening holds Create, even one whose pool could not be read back', () => {
    expect(createHeld([noteOf('lp-create', key().toBase58())])).toBe(true);
    expect(createHeld([noteOf('lp-create', null)])).toBe(true);
    expect(createHeld([noteOf('pool-buy', null), noteOf('lp-create', key().toBase58())])).toBe(true);
  });

  it('a pending deposit or withdrawal does not', () => {
    expect(createHeld([noteOf('lp-deposit', null), noteOf('lp-withdraw', key().toBase58())])).toBe(false);
    expect(createHeld([])).toBe(false);
  });

  it('a pending opening never holds Add or Remove, on its pool or any other', () => {
    const P = key().toBase58();
    for (const pool of [P, null]) {
      expect(lpHeld([noteOf('lp-create', pool)], P, 'add')).toBe(false);
      expect(lpHeld([noteOf('lp-create', pool)], P, 'remove')).toBe(false);
    }
  });
});

describe('createOffer', () => {
  // The pools here are built by the LP testkit against its own PROGRAM, so the gate
  // names that program: tier 1 is then the testkit's tier 1.
  const lpCfg = { programId: key(), cpSwapProgram: PROGRAM, cluster: 'localnet' } as CurveWriteConfig;
  const GATE: LpGate = { kind: 'open', cfg: lpCfg, mode: 'on' };
  const TIER1 = publicTierConfig(PROGRAM);
  const tierConfig = {
    address: TIER1.toBase58(), index: 1, disableCreatePool: false, tradeFeeRate: 10_000n, protocolFeeRate: 160_000n,
    fundFeeRate: 0n, createPoolFee: 150_000_000n, creatorFeeRate: 0n, protocolOwner: key().toBase58(), fundOwner: key().toBase58(),
  };
  const READY: CreateFacts = { tier: { kind: 'ready', address: TIER1, config: tierConfig }, feeAccount: { kind: 'ready' } };
  const healthOf = (verdict: PoolHealth['deposits']['verdict']): PoolHealth => ({
    swaps: { state: 'open' }, withdrawals: 'open', price: { state: 'empty-pool' }, deposits: { verdict, reasons: [] },
  });
  /** A TOKEN/SOL pool for `mint` on fee tier `tier` (its standard address), or at a one-off address. */
  const poolOn = (tier: number, address?: PublicKey, sol: bigint = SOL) =>
    ({ kind: 'pool' as const, view: viewOf(buildPool({ mint, quoteReserve: sol, tokenReserve: TOK, configIndex: tier, address }), { sol, tok: TOK }) });
  type Entry = PoolSearch['pools'][number];
  const searchOf = (pools: Entry[], index: PoolSearch['index'] = { kind: 'ok', pools: [], truncated: false }): PoolSearchRead => ({
    kind: 'ok',
    search: { mint: mint.toBase58(), known: { launchPool: key().toBase58(), standard: [] }, index, pools, otherPairs: 0, knownState: {}, chainNow: NOW },
  });
  type In = Parameters<typeof createOffer>[0];
  const base = (): In => ({
    mode: 'on', gate: GATE, facts: READY, notes: [], safety: okToken, outside: outside(0.01),
    search: searchOf([]), healths: new Map(),
  });
  /** The advice for the same reads, with the pools this tab opened (none by default). */
  const adviceOf = (a: In, openedHere: (pool: string) => boolean = () => false) =>
    createAdvice({ gate: a.gate, search: a.search, healths: a.healths, openedHere });
  const withPool = (a: In, e: Entry, verdict?: PoolHealth['deposits']['verdict']): In => {
    if (a.search.kind !== 'ok') return a;
    const healths = new Map(a.healths);
    if (verdict && e.kind === 'pool') healths.set(e.view.address, healthOf(verdict));
    return { ...a, search: searchOf([...a.search.search.pools, e], a.search.search.index), healths };
  };

  it('a readable token with no pool, every fact ready: offer', () => {
    expect(createOffer(base())).toBe('offer');
  });

  // Each state's trigger, in the order createOffer checks them. Applied to the base, each
  // alone gives its own state; applied with the NEXT one, the earlier still wins.
  const triggers: Array<[CreateOffer, (a: In) => In]> = [
    ['off', (a) => ({ ...a, mode: 'off' })],
    ['gate', (a) => ({ ...a, gate: { kind: 'blocked', reason: 'unreadable', detail: 'x' } })],
    ['paused-here', (a) => ({ ...a, mode: 'withdraw-only' })],
    ['held', (a) => ({ ...a, notes: [noteOf('lp-create', null)] })],
    ['checking', (a) => ({ ...a, facts: null })],
    ['tier-unread', (a) => (a.facts ? { ...a, facts: { ...a.facts, tier: { kind: 'unread', address: TIER1, detail: 'HTTP 429' } } } : a)],
    ['tier-not-open', (a) => (a.facts ? { ...a, facts: { ...a.facts, tier: { kind: 'not-open', address: TIER1 } } } : a)],
    ['tier-bad', (a) => (a.facts ? { ...a, facts: { ...a.facts, tier: { kind: 'not-a-tier', address: TIER1, detail: 'x' } } } : a)],
    ['tier-off', (a) => (a.facts ? { ...a, facts: { ...a.facts, tier: { kind: 'switched-off', address: TIER1, config: tierConfig } } } : a)],
    ['tier-fee-too-high', (a) => (a.facts ? { ...a, facts: { ...a.facts, tier: { kind: 'fee-too-high', address: TIER1, config: tierConfig, limit: 1n } } } : a)],
    ['fee-account-unread', (a) => (a.facts ? { ...a, facts: { ...a.facts, feeAccount: { kind: 'unread', detail: 'x' } } } : a)],
    ['fee-account', (a) => (a.facts ? { ...a, facts: { ...a.facts, feeAccount: { kind: 'missing' } } } : a)],
    ['token-unread', (a) => ({ ...a, safety: { kind: 'unread', mint: mint.toBase58(), detail: 'x' } })],
    ['token-refused', (a) => ({ ...a, safety: blockedToken })],
    ['price-unread', (a) => ({ ...a, outside: { kind: 'unread', detail: 'HTTP 502' } })],
    ['no-route', (a) => ({ ...a, outside: { kind: 'no-route', detail: 'no route' } })],
    ['pools-unread', (a) => withPool(a, { kind: 'unread', address: key().toBase58(), detail: 'x' })],
  ];

  it.each(triggers.map(([state], i) => [state, i] as const))('%s, on its own', (state, i) => {
    expect(createOffer(triggers[i]![1](base()))).toBe(state);
  });

  // Owner ruling 2026-10-03: a pool that already exists is advice, never a stop. Every
  // stop above still stops with one there: an existing pool turns none of them into an offer.
  it.each(triggers.map(([state], i) => [state, i] as const))('%s still stops with a passing public-tier pool there', (state, i) => {
    expect(createOffer(triggers[i]![1](withPool(base(), poolOn(1), 'allowed')))).toBe(state);
  });

  it.each(triggers.slice(0, -1).map(([state], i) => [state, triggers[i + 1]![0], i] as const))('%s beats %s', (first, second, i) => {
    // The tier states, the fee-account states, the token states and the price states
    // are one input each, so the later trigger would REPLACE the earlier: apply the
    // later first, so the earlier one is what the input says.
    const a = triggers[i]![1](triggers[i + 1]![1](base()));
    expect(createOffer(a), `${first} with ${second}`).toBe(first);
  });

  it('never offers while any input is unread', () => {
    const unread: Array<[string, In]> = [
      ['gate null', { ...base(), gate: null }],
      ['facts null', { ...base(), facts: null }],
      ['tier unread', { ...base(), facts: { ...READY, tier: { kind: 'unread', address: TIER1, detail: 'x' } } }],
      ['fee account unread', { ...base(), facts: { ...READY, feeAccount: { kind: 'unread', detail: 'x' } } }],
      ['token unread', { ...base(), safety: { kind: 'unread', mint: mint.toBase58(), detail: 'x' } }],
      ['price null', { ...base(), outside: null }],
      ['price unread', { ...base(), outside: { kind: 'unread', detail: 'x' } }],
      ['search unread', { ...base(), search: { kind: 'unread', detail: 'x', index: { kind: 'unread', detail: 'x' } } }],
      ['index unread', { ...base(), search: searchOf([], { kind: 'unread', detail: 'x' }) }],
      ['an unread entry', withPool(base(), { kind: 'unread', address: key().toBase58(), detail: 'x' })],
      ['an unchecked pool', withPool(base(), poolOn(0), 'unchecked')],
      ['a pool with no health', withPool(base(), poolOn(0))],
    ];
    for (const [name, a] of unread) expect(createOffer(a), name).not.toBe('offer');
  });

  // ATK-3 (audit 2026-10-03): a pool costs only rent to open and can never be closed, so
  // anyone can make the index answer "truncated" for a token for good. That is a cut
  // list, not an unread one: the index lists the pools holding the most SOL and the
  // standard addresses are read directly, so Create is decided from the pools read.
  describe('a truncated index is a cut list, not an unread one', () => {
    const cut = (): In => ({ ...base(), search: searchOf([], { kind: 'ok', pools: [], truncated: true }) });

    it('offers when no pool that was read passes on the public tier', () => {
      expect(createOffer(cut())).toBe('offer');
      expect(createOffer(withPool(withPool(cut(), poolOn(0, key()), 'refused'), poolOn(1, key()), 'refused'))).toBe('offer');
      expect(createOffer(withPool(cut(), poolOn(0), 'allowed'))).toBe('offer');
    });

    it('still points to the pools read: a passing pool on the public tier, or one this tab opened', () => {
      const passing = withPool(cut(), poolOn(1), 'allowed');
      expect(createOffer(passing)).toBe('offer');
      expect(adviceOf(passing).kind).toBe('exists');
      const mine = poolOn(1, key());
      const opened = withPool(cut(), mine, 'refused');
      expect(createOffer(opened)).toBe('offer');
      expect(adviceOf(opened, (p) => p === mine.view.address)).toEqual({ kind: 'opened-here', pool: mine.view });
    });

    it('what is truly unread still stops it: a pool not read, not checked, or the index itself', () => {
      expect(createOffer(withPool(cut(), { kind: 'unread', address: key().toBase58(), detail: 'x' }))).toBe('pools-unread');
      expect(createOffer(withPool(cut(), poolOn(0), 'unchecked'))).toBe('pools-unread');
      expect(createOffer(withPool(cut(), poolOn(0)))).toBe('pools-unread');
      expect(createOffer({ ...base(), search: searchOf([], { kind: 'unread', detail: 'x' }) })).toBe('pools-unread');
    });

    it('poolListCut tells the card, so it never calls a new pool "the first"', () => {
      expect(poolListCut(cut().search)).toBe(true);
      expect(poolListCut(base().search)).toBe(false);
      expect(poolListCut(searchOf([], { kind: 'unread', detail: 'x' }))).toBe(false);
      expect(poolListCut({ kind: 'unread', detail: 'x', index: { kind: 'ok', pools: [], truncated: true } })).toBe(false);
    });
  });

  // Owner ruling 2026-10-03: a token may have as many pools as people open. The card
  // points to the pool to add to first; it never takes the opening away.
  describe('a pool that already exists is advice, never a stop', () => {
    it('a passing pool on the public tier: still offer, and it is the pool pointed to', () => {
      const theirs = poolOn(1);
      const a = withPool(base(), theirs, 'allowed');
      expect(createOffer(a)).toBe('offer');
      expect(adviceOf(a)).toEqual({ kind: 'exists', pool: theirs.view });
    });

    it('only a passing pool on the PUBLIC tier is pointed to: not tier 0, not a refused one', () => {
      for (const a of [withPool(base(), poolOn(0), 'allowed'), withPool(base(), poolOn(1), 'refused'), base()]) {
        expect(createOffer(a)).toBe('offer');
        expect(adviceOf(a)).toEqual({ kind: 'none' });
      }
    });

    it('of several passing pools, the one holding the most SOL, wherever it sits in the list', () => {
      const small = poolOn(1, key(), SOL);
      const big = poolOn(1, key(), 3n * SOL);
      const refusedBigger = poolOn(1, key(), 9n * SOL);
      for (const order of [[small, big, refusedBigger], [refusedBigger, big, small]]) {
        let a = base();
        for (const e of order) a = withPool(a, e, e === refusedBigger ? 'refused' : 'allowed');
        expect(adviceOf(a)).toEqual({ kind: 'exists', pool: big.view });
      }
    });

    it('a pool this tab opened is pointed to first, whatever its own health, and still does not stop', () => {
      const mine = poolOn(1, key());
      const theirs = poolOn(1, key(), 5n * SOL);
      for (const verdict of ['allowed', 'refused'] as const) {
        const a = withPool(withPool(base(), theirs, 'allowed'), mine, verdict);
        expect(createOffer(a)).toBe('offer');
        expect(adviceOf(a, (p) => p === mine.view.address)).toEqual({ kind: 'opened-here', pool: mine.view });
      }
    });

    it('names nothing while the gate is not open or the search is unread', () => {
      const a = withPool(base(), poolOn(1), 'allowed');
      expect(createAdvice({ gate: null, search: a.search, healths: a.healths, openedHere: () => true })).toEqual({ kind: 'none' });
      expect(createAdvice({ gate: { kind: 'off' }, search: a.search, healths: a.healths, openedHere: () => true })).toEqual({ kind: 'none' });
      const unread: PoolSearchRead = { kind: 'unread', detail: 'x', index: { kind: 'unread', detail: 'x' } };
      expect(createAdvice({ gate: GATE, search: unread, healths: a.healths, openedHere: () => true })).toEqual({ kind: 'none' });
    });

    it('by type: an existing pool cannot be a stop', () => {
      expectTypeOf<'exists'>().not.toMatchTypeOf<CreateOffer>();
      expectTypeOf<'opened-here'>().not.toMatchTypeOf<CreateOffer>();
      expectTypeOf<Parameters<typeof createOffer>[0]>().not.toHaveProperty('openedHere');
    });
  });

  it('SOL under the newer token program is refused', () => {
    expect(createOffer({ ...base(), safety: { ...okToken, mint: TOKEN_2022_NATIVE_MINT } })).toBe('token-refused');
  });
});

describe('Add and Remove never read the create facts', () => {
  it('by type: neither offer takes them', () => {
    expectTypeOf<Parameters<typeof depositOffer>[0]>().not.toHaveProperty('facts');
    expectTypeOf<Parameters<typeof withdrawOffer>[0]>().not.toHaveProperty('facts');
  });

  it('at run time: with every create fact bad, Remove and Add are still offered', () => {
    const v = view();
    const bad = { facts: { tier: { kind: 'unread' }, feeAccount: { kind: 'missing' } } };
    expect(withdrawOffer({ mode: 'on', gate: OPEN, position: position(v), held: false, ...bad } as Parameters<typeof withdrawOffer>[0])).toBe('offer');
    expect(depositOffer({ mode: 'on', gate: OPEN, health: health(v), held: false, ...bad } as Parameters<typeof depositOffer>[0])).toBe('offer');
  });
});
