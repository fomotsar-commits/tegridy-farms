// @vitest-environment node
//
// The leave rule, row by row (spec 3.7): what may refuse adding, and the much shorter
// list of what may refuse removing.
import { describe, it, expect, expectTypeOf } from 'vitest';
import { Keypair, type PublicKey } from '@solana/web3.js';
import { POOL_STATUS_DISABLE_DEPOSIT, POOL_STATUS_DISABLE_SWAP, POOL_STATUS_DISABLE_WITHDRAW, publicTierConfig } from '../../../lib/solana/cpswap/program';
import { assessPool, FAR_FUTURE_SECS, tokenReasons, type PoolHealth } from '../../../lib/solana/lp/poolHealth';
import type { PoolSearch, PoolSearchRead, PoolView } from '../../../lib/solana/lp/poolFinder';
import type { Position } from '../../../lib/solana/lp/positions';
import type { SafetyReason, TokenSafety } from '../../../lib/solana/lp/tokenSafety';
import { TOKEN_2022_NATIVE_MINT } from '../../../lib/solana/lp/opening';
import { PROGRAM, buildPool, key, viewOf } from '../../../lib/solana/lp/testkit.fixture';
import type { CreateFacts } from '../../../lib/launcher/solana/write/types';
import type { PendingTrade } from '../curve/pendingTrade';
import type { CurveWriteConfig, LpGate } from '../curve/ports';
import { BAYLA_QUOTE, SOL_QUOTE, USDC_QUOTE, type QuoteCoin } from '../../../lib/solana/lp/quotes';
import { POOL_RISK_CODES, createAdvice, createHeld, createOffer, depositOffer, depositWarned, lpHeld, openingCautions, pairFacts, poolListCut, priceWarned, standardState, withdrawOffer, type CreateOffer } from './offers';

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
// A transfer fee is a block that stays: this site cannot build an exact withdrawal for it.
const blockedToken = { ...okToken, verdict: 'blocked', blocks: [{ code: 'transfer-fee', text: 'x' }] } as TokenSafety;
const warnedToken = { ...okToken, verdict: 'warn', warnings: [{ code: 'mint-authority', text: 'x' }] } as TokenSafety;
/** A token that carries one warning, with its own sentence. */
const warnedWith = (code: SafetyReason['code'], text = `the ${code} sentence`): TokenSafety => ({ ...okToken, verdict: 'warn', warnings: [{ code, text }] });
const outside = (p: number) => ({ kind: 'ok' as const, solPerToken: p, source: 'Jupiter' as const });
/** Jupiter ANSWERED that it has no market for the token. A failed read is 'unread', never this. */
const NO_ROUTE = { kind: 'no-route' as const, detail: 'Jupiter has no route for this token' };

function view(o: { status?: number; openTime?: bigint; frozen?: boolean; sol?: bigint; tok?: bigint; lpSupply?: bigint; config?: null } = {}): PoolView {
  const b = buildPool({ mint, quoteReserve: o.sol ?? SOL, tokenReserve: o.tok ?? TOK, status: o.status ?? 0, openTime: o.openTime ?? 100n, lpSupply: o.lpSupply });
  return viewOf(b, { sol: o.sol ?? SOL, tok: o.tok ?? TOK, frozen: o.frozen, ...(o.config === null ? { config: null } : {}) });
}

type Price = number | 'unread' | 'no-route';
const health = (v: PoolView, o: { safety?: TokenSafety | null; price?: Price } = {}) =>
  assessPool({
    view: v,
    tokenDecimals: 6,
    chainNow: NOW,
    outside: o.price === 'unread' ? { kind: 'unread', detail: 'Jupiter did not give a price (HTTP 502)' } : o.price === 'no-route' ? NO_ROUTE : outside(o.price ?? 0.01),
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

const add = (v: PoolView, o: { mode?: 'off' | 'on' | 'withdraw-only'; gate?: LpGate | null; held?: boolean; safety?: TokenSafety | null; price?: Price } = {}) =>
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

  // Owner ruling 2026-10-04: a price off the market is a warning, not a refusal.
  it('a price off by more than 3%: add is offered, and the pool carries the warning; remove offered', () => {
    for (const price of [0.02, 0.005]) {
      expect(add(view(), { price })).toBe('offer');
      const { deposits } = health(view(), { price });
      expect(deposits.verdict).toBe('allowed');
      expect(deposits.warnings).toEqual([expect.stringMatching(/^Its price is \d+\.\d% (above|below) the outside price\./)]);
      expect(remove(position(view()))).toBe('offer');
    }
  });

  it('a price that could not be read: no add, and it is not a warning; remove offered', () => {
    expect(add(view(), { price: 'unread' })).toBe('checks');
    expect(health(view(), { price: 'unread' }).deposits).toMatchObject({ verdict: 'unchecked', warnings: [] });
    expect(remove(position(view()))).toBe('offer');
  });

  it('no market price at all (Jupiter answered that it has no route): add is offered, with the warning', () => {
    expect(add(view(), { price: 'no-route' })).toBe('offer');
    const h = health(view(), { price: 'no-route' });
    expect(h.price.state).toBe('no-market');
    expect(h.deposits.warnings).toEqual([expect.stringMatching(/^Jupiter has no market price for this token/)]);
  });

  it('a token blocked, warned or unread: add no / yes / no; remove offered in every case', () => {
    expect(add(view(), { safety: blockedToken })).toBe('checks');
    expect(add(view(), { safety: warnedToken })).toBe('offer');
    expect(add(view(), { safety: null })).toBe('checks');
    expect(add(view(), { safety: { kind: 'unread', mint: mint.toBase58(), detail: 'x' } })).toBe('checks');
    expect(remove(position(view()))).toBe('offer');
  });

  it('a copy of a well-known name, and a token its creator can freeze: add is offered, with the warning', () => {
    for (const code of ['copies-known-name', 'freeze-authority'] as const) {
      expect(add(view(), { safety: warnedWith(code) }), code).toBe('offer');
      expect(health(view(), { safety: warnedWith(code) }).deposits.warnings, code).toHaveLength(1);
    }
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
    swaps: { state: 'open' }, withdrawals: 'open', price: { state: 'empty-pool' }, deposits: { verdict, reasons: [], warnings: [] },
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

    // Review 2026-10-04 (C1). A pool more than 3% off its reference is 'allowed' now, with
    // a warning. One big pool at a wrong price must not take the place of a smaller pool at
    // the market: the card would then name a pool it does not suggest, and never the one
    // worth adding to. Each pool here is judged by the real check, with Jupiter at 0.01 SOL.
    describe('a pool whose price is off is pointed to only when no other passes', () => {
      const WHOLE_SOL = 10n ** 9n;
      const WHOLE_TOKEN = 10n ** 6n;
      /** A tier-1 pool at its own address holding `sol` SOL and `tokens` tokens. */
      const poolOf = (sol: bigint, tokens: bigint) => {
        const s = sol * WHOLE_SOL;
        const t = tokens * WHOLE_TOKEN;
        return { kind: 'pool' as const, view: viewOf(buildPool({ mint, quoteReserve: s, tokenReserve: t, configIndex: 1, address: key() }), { sol: s, tok: t }) };
      };
      /** 40 SOL and 1,000 tokens: 0.04 SOL a token, 300% above the market. */
      const bigOff = () => poolOf(40n, 1_000n);
      /** 10 SOL and 1,000 tokens: 0.01 SOL a token, the market price. */
      const atMarket = () => poolOf(10n, 1_000n);
      /** The pools, each with the real check's answer for it. */
      const checked = (pools: ReturnType<typeof poolOf>[], price: Price = 0.01): In => {
        let a = base();
        for (const e of pools) a = withPool(a, e);
        return { ...a, healths: new Map(pools.map((e) => [e.view.address, health(e.view, { price })])) };
      };

      it('the fixture: the 40 SOL pool is allowed with its price 300% off, the 10 SOL pool agrees', () => {
        const off = health(bigOff().view);
        expect(off.deposits.verdict).toBe('allowed');
        expect(off.price.state).toBe('disagrees');
        expect(off.deposits.warnings).toEqual(['Its price is 300.0% above the outside price. A deposit here would hand that gap to the first arbitrage trade.']);
        const fair = health(atMarket().view);
        expect(fair.deposits).toEqual({ verdict: 'allowed', reasons: [], warnings: [] });
        expect(fair.price.state).toBe('agrees');
      });

      it('a 40 SOL pool 300% off beside a 10 SOL pool at the market: the 10 SOL pool is pointed to, wherever it sits in the list', () => {
        const off = bigOff();
        const fair = atMarket();
        for (const order of [[off, fair], [fair, off]]) {
          const a = checked(order);
          expect(createOffer(a)).toBe('offer');
          expect(adviceOf(a)).toEqual({ kind: 'exists', pool: fair.view });
        }
      });

      it('the 40 SOL pool alone is pointed to: an off-price pool is named when it is all there is', () => {
        const off = bigOff();
        expect(adviceOf(checked([off]))).toEqual({ kind: 'exists', pool: off.view });
      });

      it('two off-price pools and no other: the bigger of them', () => {
        const off = bigOff();
        // 4 SOL and 100 tokens: 0.04 SOL a token as well.
        const smallOff = poolOf(4n, 100n);
        for (const order of [[smallOff, off], [off, smallOff]]) expect(adviceOf(checked(order))).toEqual({ kind: 'exists', pool: off.view });
      });

      it('among the pools whose price is NOT off, it is still the biggest', () => {
        const off = bigOff();
        const fair = atMarket();
        // 5 SOL and 500 tokens: at the market too, and half the size.
        const smallFair = poolOf(5n, 500n);
        for (const order of [[off, smallFair, fair], [fair, smallFair, off]]) expect(adviceOf(checked(order))).toEqual({ kind: 'exists', pool: fair.view });
      });

      it('a pool at the market that is REFUSED is no pool to add to: the off-price pool that passes is the one named', () => {
        const off = bigOff();
        const fair = atMarket();
        const a = checked([fair, off]);
        const healths = new Map(a.healths).set(fair.view.address, healthOf('refused'));
        expect(adviceOf({ ...a, healths })).toEqual({ kind: 'exists', pool: off.view });
      });

      // No market price is not "off": nothing was compared, so there is no pool to prefer over it.
      it('with no market price at all, the biggest pool is pointed to as before', () => {
        const big = bigOff();
        const small = atMarket();
        const a = checked([small, big], 'no-route');
        expect(a.healths.get(big.view.address)?.price.state).toBe('no-market');
        expect(adviceOf(a)).toEqual({ kind: 'exists', pool: big.view });
      });
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

  // Pairing coins (owner ruling 2026-10-03): a new pool is paired with SOL, USDC or BAYLA,
  // and the pool to add to instead is one paired with the SAME coin. The owner's own case:
  // BAYLA has a SOL pool, and he opens the first BAYLA/USDC pool.
  describe('the advice is per pairing coin', () => {
    /** A pool for `mint` paired with `quote` on fee tier `tier`; `reserve` is in that coin's own base units. */
    const pairedOn = (quote: QuoteCoin, reserve: bigint, tier = 1, address: PublicKey = key()) => ({
      kind: 'pool' as const,
      view: viewOf(buildPool({ mint, quote, quoteReserve: reserve, tokenReserve: TOK, configIndex: tier, address }), { sol: reserve, tok: TOK }),
    });
    const adviceFor = (a: In, quote: QuoteCoin, openedHere: (pool: string) => boolean = () => false) =>
      createAdvice({ gate: a.gate, search: a.search, healths: a.healths, openedHere, quote });
    const USDC_UNIT = 10n ** 6n;

    it('the fixture: each pool reads as paired with its own coin', () => {
      expect(pairedOn(USDC_QUOTE, USDC_UNIT).view.quote).toBe(USDC_QUOTE);
      expect(pairedOn(BAYLA_QUOTE, USDC_UNIT).view.quote).toBe(BAYLA_QUOTE);
      expect(poolOn(1).view.quote).toBe(SOL_QUOTE);
    });

    it('a SOL pool is the pool to add to for SOL only: someone opening the first USDC or BAYLA pool is pointed nowhere', () => {
      const sol = poolOn(1);
      const a = withPool(base(), sol, 'allowed');
      expect(adviceFor(a, SOL_QUOTE)).toEqual({ kind: 'exists', pool: sol.view });
      expect(adviceFor(a, USDC_QUOTE)).toEqual({ kind: 'none' });
      expect(adviceFor(a, BAYLA_QUOTE)).toEqual({ kind: 'none' });
    });

    it('a USDC pool is the pool to add to for USDC only', () => {
      const usdc = pairedOn(USDC_QUOTE, 500n * USDC_UNIT);
      const a = withPool(base(), usdc, 'allowed');
      expect(adviceFor(a, USDC_QUOTE)).toEqual({ kind: 'exists', pool: usdc.view });
      expect(adviceFor(a, SOL_QUOTE)).toEqual({ kind: 'none' });
      expect(adviceFor(a, BAYLA_QUOTE)).toEqual({ kind: 'none' });
    });

    it('left out, the coin is SOL: the answer a SOL-only page has always had', () => {
      const sol = poolOn(1);
      const usdc = pairedOn(USDC_QUOTE, 10n ** 12n);
      const a = withPool(withPool(base(), usdc, 'allowed'), sol, 'allowed');
      expect(adviceOf(a)).toEqual({ kind: 'exists', pool: sol.view });
      expect(adviceOf(withPool(base(), usdc, 'allowed'))).toEqual({ kind: 'none' });
    });

    // The same count of base units is 10 SOL in one pool and 10,000 USDC in the next, so
    // "the biggest" is only ever asked among pools of one coin.
    it('reserves of different coins are never compared: each coin has its own biggest pool', () => {
      // In base units: 10^9 (1 SOL) > 10^7 (10 USDC) > 5·10^6 (5 USDC), and 10^11 (100,000 USDC) > 10^10 (10 SOL).
      const oneSol = poolOn(1, key(), 10n ** 9n);
      const tenUsdc = pairedOn(USDC_QUOTE, 10n * USDC_UNIT);
      const fiveUsdc = pairedOn(USDC_QUOTE, 5n * USDC_UNIT);
      let a = base();
      for (const e of [fiveUsdc, oneSol, tenUsdc]) a = withPool(a, e, 'allowed');
      expect(adviceFor(a, USDC_QUOTE)).toEqual({ kind: 'exists', pool: tenUsdc.view });
      expect(adviceFor(a, SOL_QUOTE)).toEqual({ kind: 'exists', pool: oneSol.view });

      const tenSol = poolOn(1, key(), 10n * 10n ** 9n);
      const bigUsdc = pairedOn(USDC_QUOTE, 100_000n * USDC_UNIT);
      let b = base();
      for (const e of [bigUsdc, tenSol]) b = withPool(b, e, 'allowed');
      expect(adviceFor(b, SOL_QUOTE)).toEqual({ kind: 'exists', pool: tenSol.view });
      expect(adviceFor(b, USDC_QUOTE)).toEqual({ kind: 'exists', pool: bigUsdc.view });
    });

    it('a pool this tab opened is pointed to first for ITS coin, and says nothing for another', () => {
      const mine = pairedOn(USDC_QUOTE, 5n * USDC_UNIT);
      const theirsUsdc = pairedOn(USDC_QUOTE, 900n * USDC_UNIT);
      const theirsSol = poolOn(1);
      let a = base();
      for (const e of [theirsUsdc, theirsSol]) a = withPool(a, e, 'allowed');
      a = withPool(a, mine, 'refused');
      const opened = (p: string) => p === mine.view.address;
      expect(adviceFor(a, USDC_QUOTE, opened)).toEqual({ kind: 'opened-here', pool: mine.view });
      expect(adviceFor(a, SOL_QUOTE, opened)).toEqual({ kind: 'exists', pool: theirsSol.view });
      expect(adviceFor(a, BAYLA_QUOTE, opened)).toEqual({ kind: 'none' });
    });

    it('per coin too: only a passing pool on the public tier is pointed to', () => {
      for (const a of [withPool(base(), pairedOn(USDC_QUOTE, USDC_UNIT, 0), 'allowed'), withPool(base(), pairedOn(USDC_QUOTE, USDC_UNIT), 'refused')]) {
        expect(createOffer(a)).toBe('offer');
        expect(adviceFor(a, USDC_QUOTE)).toEqual({ kind: 'none' });
      }
    });

    describe('pairFacts: one answer for each coin the token can be paired with', () => {
      const facts = (a: In, o: { tokenMint?: string; advise?: boolean; openedHere?: (p: string) => boolean } = {}) =>
        pairFacts({ tokenMint: o.tokenMint ?? mint.toBase58(), gate: a.gate, search: a.search, healths: a.healths, openedHere: o.openedHere ?? (() => false), advise: o.advise ?? true });

      it('an ordinary token: SOL, USDC and BAYLA, in that order; BAYLA: SOL and USDC; USDC: SOL only; SOL: none', () => {
        expect(facts(base()).map((x) => x.coin)).toEqual([SOL_QUOTE, USDC_QUOTE, BAYLA_QUOTE]);
        expect(facts(base(), { tokenMint: BAYLA_QUOTE.mint }).map((x) => x.coin)).toEqual([SOL_QUOTE, USDC_QUOTE]);
        expect(facts(base(), { tokenMint: USDC_QUOTE.mint }).map((x) => x.coin)).toEqual([SOL_QUOTE]);
        expect(facts(base(), { tokenMint: SOL_QUOTE.mint })).toEqual([]);
      });

      it('each coin gets its own pool to add to, and whether it has any pool at all', () => {
        const sol = poolOn(1);
        const failingUsdc = pairedOn(USDC_QUOTE, USDC_UNIT);
        const a = withPool(withPool(base(), sol, 'allowed'), failingUsdc, 'refused');
        expect(facts(a).map((x) => [x.coin.symbol, x.advice, x.hasPool])).toEqual([
          ['SOL', { kind: 'exists', pool: sol.view }, true],
          // A pool that does not pass is still a pool: USDC is not "no pool yet".
          ['USDC', { kind: 'none' }, true],
          ['BAYLA', { kind: 'none' }, false],
        ]);
      });

      it('a card that offers no opening names no pool for any coin', () => {
        const a = withPool(base(), poolOn(1), 'allowed');
        expect(facts(a, { advise: false }).map((x) => x.advice)).toEqual([{ kind: 'none' }, { kind: 'none' }, { kind: 'none' }]);
        // What was read is still said: SOL has a pool.
        expect(facts(a, { advise: false }).map((x) => x.hasPool)).toEqual([true, false, false]);
      });

      // Review 2026-10-04 (C2, then W3). The card and the form say "passes the checks" only
      // of a pool that carries no warning at all. `warned` is how they know: the pool
      // pointed to has a price that is off, or one that was compared with nothing, or a
      // token that copies a name, can be frozen, or shows a changing amount.
      it('warned: the pool pointed to carries any warning, about its price or about its token', () => {
        const sol = poolOn(1);
        const warnedFor = (price: Price, safety: TokenSafety = okToken) => {
          const a = withPool(base(), sol);
          return facts({ ...a, healths: new Map([[sol.view.address, health(sol.view, { price, safety })]]) }).map((x) => [x.coin.symbol, x.advice.kind, x.warned]);
        };
        // The pool is at 0.01 SOL a token.
        expect(warnedFor(0.01)).toEqual([['SOL', 'exists', false], ['USDC', 'none', false], ['BAYLA', 'none', false]]);
        expect(warnedFor(0.02)).toEqual([['SOL', 'exists', true], ['USDC', 'none', false], ['BAYLA', 'none', false]]);
        expect(warnedFor('no-route')).toEqual([['SOL', 'exists', true], ['USDC', 'none', false], ['BAYLA', 'none', false]]);
        // At the market, and the token itself is what the pool's card warns of.
        for (const code of POOL_RISK_CODES) {
          expect(warnedFor(0.01, warnedWith(code)), code).toEqual([['SOL', 'exists', true], ['USDC', 'none', false], ['BAYLA', 'none', false]]);
        }
        // A token warning that changes nothing about a pool (a live mint authority) is not
        // on the pool's card, so the pool still passes clean.
        expect(warnedFor(0.01, warnedToken)).toEqual([['SOL', 'exists', false], ['USDC', 'none', false], ['BAYLA', 'none', false]]);
        // The one test behind it, and the price-only one beside it: they differ exactly on a token warning.
        const freezable = health(sol.view, { price: 0.01, safety: warnedWith('freeze-authority') });
        expect([depositWarned(freezable), priceWarned(freezable)]).toEqual([true, false]);
        expect([depositWarned(health(sol.view, { price: 0.02 })), priceWarned(health(sol.view, { price: 0.02 }))]).toEqual([true, true]);
        expect([depositWarned(health(sol.view)), depositWarned(undefined)]).toEqual([false, false]);
        // No pool pointed to, no warning about one: a card that offers nothing names nothing.
        const off = withPool(base(), sol);
        const stopped = facts({ ...off, healths: new Map([[sol.view.address, health(sol.view, { price: 0.02 })]]) }, { advise: false });
        expect(stopped.map((x) => x.warned)).toEqual([false, false, false]);
      });

      // Every pair has its own standard address. A SOL pool at the SOL pair's address says
      // nothing about where a USDC pool would go.
      it("the standard address is each pair's own: tier 1 only, and anything found there takes it", () => {
        const [solStd, solStd0, usdcStd, baylaStd] = [key(), key(), key(), key()].map((k) => k.toBase58());
        const known = {
          launchPool: key().toBase58(),
          standard: [
            { index: 1, config: TIER1.toBase58(), address: solStd!, quote: SOL_QUOTE.mint },
            { index: 0, config: key().toBase58(), address: solStd0!, quote: SOL_QUOTE.mint },
            { index: 1, config: TIER1.toBase58(), address: usdcStd!, quote: USDC_QUOTE.mint },
            { index: 1, config: TIER1.toBase58(), address: baylaStd!, quote: BAYLA_QUOTE.mint },
          ],
        };
        const withState = (knownState: PoolSearch['knownState']): PoolSearchRead => ({
          kind: 'ok',
          search: { mint: mint.toBase58(), known, index: { kind: 'ok', pools: [], truncated: false }, pools: [], otherPairs: 0, knownState, chainNow: NOW },
        });
        const states = (s: PoolSearchRead) => [SOL_QUOTE, USDC_QUOTE, BAYLA_QUOTE].map((q) => standardState(s, q));

        expect(states(withState({ [solStd!]: 'pool', [usdcStd!]: 'absent', [baylaStd!]: 'absent' }))).toEqual(['taken', 'empty', 'empty']);
        expect(states(withState({ [solStd!]: 'absent', [usdcStd!]: 'pool', [baylaStd!]: 'absent' }))).toEqual(['empty', 'taken', 'empty']);
        expect(states(withState({ [solStd!]: 'absent', [usdcStd!]: 'absent', [baylaStd!]: 'not-a-pool' }))).toEqual(['empty', 'empty', 'taken']);
        // The tier-0 address is another tier's: a pool there does not take tier 1's.
        expect(states(withState({ [solStd0!]: 'pool', [solStd!]: 'absent' }))).toEqual(['empty', 'empty', 'empty']);
        // An unread address may hold something: the opening goes to an address of its own, and Prepare reads again.
        expect(states(withState({ [usdcStd!]: 'unread' }))).toEqual(['empty', 'taken', 'empty']);
        // An unread search, and a coin the search has no address for.
        expect(standardState({ kind: 'unread', detail: 'x', index: { kind: 'unread', detail: 'x' } }, USDC_QUOTE)).toBe('empty');
        expect(standardState(searchOf([]), USDC_QUOTE)).toBe('empty');
        expect(pairFacts({ tokenMint: mint.toBase58(), gate: GATE, search: withState({ [usdcStd!]: 'pool' }), healths: new Map(), openedHere: () => false, advise: true }).map((x) => x.standard)).toEqual(['empty', 'taken', 'empty']);
      });
    });
  });

  it('SOL under the newer token program is refused', () => {
    expect(createOffer({ ...base(), safety: { ...okToken, mint: TOKEN_2022_NATIVE_MINT } })).toBe('token-refused');
  });

  // Owner ruling 2026-10-04: any token may have a pool. Four refusals became warnings.
  describe('any token may have a pool: what used to be refused is offered', () => {
    it('no market price (Jupiter answered that it has no route): offer', () => {
      expect(createOffer({ ...base(), outside: NO_ROUTE })).toBe('offer');
    });

    it('…but a price that was not read is not "no market price": it still stops', () => {
      expect(createOffer({ ...base(), outside: { kind: 'unread', detail: 'HTTP 502' } })).toBe('price-unread');
      expect(createOffer({ ...base(), outside: null })).toBe('price-unread');
    });

    it('a copy of a well-known name, a freezable token, a changing amount: offer', () => {
      for (const code of ['copies-known-name', 'freeze-authority', 'interest-bearing', 'scaled-amount'] as const) {
        expect(createOffer({ ...base(), safety: warnedWith(code) }), code).toBe('offer');
      }
    });

    it('all of them at once on one token: still offer', () => {
      const all = { ...okToken, verdict: 'warn', warnings: [{ code: 'freeze-authority', text: 'f' }, { code: 'copies-known-name', text: 'c' }] } as TokenSafety;
      expect(createOffer({ ...base(), safety: all, outside: NO_ROUTE })).toBe('offer');
    });

    it('what stays refused: a blocked token and a token that does not exist, whatever the price says', () => {
      for (const o of [outside(0.01), NO_ROUTE, null]) {
        expect(createOffer({ ...base(), safety: blockedToken, outside: o })).toBe('token-refused');
        expect(createOffer({ ...base(), safety: { kind: 'absent', mint: mint.toBase58() }, outside: o })).toBe('token-refused');
      }
      // A blocked token that also copies a name is refused for the block: the warning lifts nothing.
      const both = { ...blockedToken, warnings: [{ code: 'copies-known-name', text: 'c' }] } as TokenSafety;
      expect(createOffer({ ...base(), safety: both })).toBe('token-refused');
    });

    it('by type: "no route" is not an answer the card can give any more', () => {
      expectTypeOf<'no-route'>().not.toMatchTypeOf<CreateOffer>();
    });
  });

  describe('openingCautions: what the card says before its button', () => {
    it('a clean token at a market price: nothing', () => {
      expect(openingCautions(okToken, outside(0.01))).toEqual([]);
    });

    it('each warning that changes what a pool risks, in the token’s own words and in its order', () => {
      const t = {
        ...okToken,
        verdict: 'warn',
        warnings: [
          { code: 'freeze-authority', text: 'freeze sentence' },
          { code: 'mint-authority', text: 'mint sentence' },
          { code: 'copies-known-name', text: 'copy sentence, naming the real mint' },
          { code: 'metadata-mutable', text: 'name can change' },
        ],
      } as TokenSafety;
      // The others stay on the token card and in the form's own list: they were never a refusal.
      expect(openingCautions(t, outside(0.01))).toEqual(['freeze sentence', 'copy sentence, naming the real mint']);
    });

    it('no market price: said last, and only when Jupiter ANSWERED that there is none', () => {
      const noMarket = 'Jupiter has no market price for this token, so there is nothing to compare an opening price with. If you open a pool, you set its first price yourself.';
      expect(openingCautions(okToken, NO_ROUTE)).toEqual([noMarket]);
      expect(openingCautions(warnedWith('freeze-authority', 'freeze sentence'), NO_ROUTE)).toEqual(['freeze sentence', noMarket]);
      // Not read is never a warning.
      expect(openingCautions(okToken, { kind: 'unread', detail: 'HTTP 502' })).toEqual([]);
      expect(openingCautions(okToken, null)).toEqual([]);
    });

    it('a token that was not read, or does not exist, has no warnings to give', () => {
      expect(openingCautions({ kind: 'unread', mint: mint.toBase58(), detail: 'x' }, outside(0.01))).toEqual([]);
      expect(openingCautions({ kind: 'absent', mint: mint.toBase58() }, outside(0.01))).toEqual([]);
    });

    // The form leaves these codes out of the list above its amount boxes because the
    // opening check says each of them above Review. If the check ever stopped saying one,
    // it would be said nowhere in the form: this pins that it cannot.
    it('every code the form leaves out of its top list has a line from the opening check', () => {
      expect([...POOL_RISK_CODES].sort()).toEqual(['copies-known-name', 'freeze-authority', 'interest-bearing', 'scaled-amount']);
      for (const code of POOL_RISK_CODES) {
        expect(tokenReasons(warnedWith(code), 'pools').warned, code).toHaveLength(1);
      }
      // And a warning the check does not repeat is not left out.
      for (const code of ['mint-authority', 'metadata-mutable', 'lookalike-letters', 'no-metadata'] as const) {
        expect(POOL_RISK_CODES.has(code), code).toBe(false);
        expect(tokenReasons(warnedWith(code), 'pools').warned, code).toEqual([]);
      }
    });
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
