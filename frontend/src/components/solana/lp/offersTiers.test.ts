// @vitest-environment node
//
// Opening a pool with two public fee tiers (owner, 2026-10-18): the offer stands while
// ANY public tier is ready; a tier whose read failed is never offered and never read as
// "no"; the pool pointed to first may sit on either public tier, never on tier 0; and
// each tier has its own standard address per pair.
import { describe, it, expect } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { deriveAmmConfig, publicTierConfig } from '../../../lib/solana/cpswap/program';
import type { PoolHealth } from '../../../lib/solana/lp/poolHealth';
import type { PoolSearch, PoolSearchRead } from '../../../lib/solana/lp/poolFinder';
import type { TokenSafety } from '../../../lib/solana/lp/tokenSafety';
import { PROGRAM, buildPool, key, viewOf } from '../../../lib/solana/lp/testkit.fixture';
import { SOL_QUOTE, USDC_QUOTE } from '../../../lib/solana/lp/quotes';
import type { CreateFacts, TierState } from '../../../lib/launcher/solana/write/types';
import type { CurveWriteConfig, LpGate } from '../curve/ports';
import { createAdvice, createOffer, offeredTiers, readyTiers, standardState, tierStop } from './offers';

const mint = key();
const SOL = 10n * 10n ** 9n;
const TOK = 1_000n * 10n ** 6n;
const NOW = 1_000n;
const cfg = { programId: key(), cpSwapProgram: PROGRAM, cluster: 'localnet' } as CurveWriteConfig;
const GATE: LpGate = { kind: 'open', cfg, mode: 'on' };
const TIER1 = publicTierConfig(PROGRAM, 1);
const TIER2 = publicTierConfig(PROGRAM, 2);
const okToken: TokenSafety = { kind: 'read', mint: mint.toBase58(), verdict: 'ok', blocks: [], warnings: [], facts: null, name: null, symbol: null, metadataSource: 'none' };
/** USDC as the token: paired with SOL, the one pair tier 2 (0.25%) is offered (owner, 2026-10-24). */
const usdcToken: TokenSafety = { ...okToken, mint: USDC_QUOTE.mint };

const configOf = (index: 1 | 2, address: PublicKey) => ({
  address: address.toBase58(),
  index,
  disableCreatePool: false,
  tradeFeeRate: index === 1 ? 10_000n : 2_500n,
  protocolFeeRate: 160_000n,
  fundFeeRate: 0n,
  createPoolFee: 150_000_000n,
  creatorFeeRate: 0n,
  protocolOwner: key().toBase58(),
  fundOwner: key().toBase58(),
});
const ready = (index: 1 | 2): TierState => ({ kind: 'ready', index, address: index === 1 ? TIER1 : TIER2, config: configOf(index, index === 1 ? TIER1 : TIER2) });
const notOpen = (index: 1 | 2): TierState => ({ kind: 'not-open', index, address: index === 1 ? TIER1 : TIER2 });
const unread = (index: 1 | 2): TierState => ({ kind: 'unread', index, address: index === 1 ? TIER1 : TIER2, detail: 'HTTP 429' });
const off = (index: 1 | 2): TierState => ({ kind: 'switched-off', index, address: index === 1 ? TIER1 : TIER2, config: { ...configOf(index, index === 1 ? TIER1 : TIER2), disableCreatePool: true } });
const facts = (...tiers: TierState[]): CreateFacts => ({ tiers, feeAccount: { kind: 'ready' } });

const allowed: PoolHealth = { swaps: { state: 'open' }, withdrawals: 'open', price: { state: 'empty-pool' }, deposits: { verdict: 'allowed', reasons: [], warnings: [] } };
const USDC_KEY = new PublicKey(USDC_QUOTE.mint);
/**
 * A TOKEN/SOL pool on fee tier `tier`, at that tier's standard address, its tier read at the
 * tier's rate (1: 1%, 2: 0.25%). `token` USDC makes it the SOL/USDC pool tier 2 is offered.
 */
const poolOn = (tier: number, token: PublicKey = mint) => ({
  kind: 'pool' as const,
  view: viewOf(buildPool({ mint: token, quoteReserve: SOL, tokenReserve: TOK, configIndex: tier }), {
    sol: SOL,
    tok: TOK,
    ...(tier === 1 || tier === 2 ? { config: configOf(tier, publicTierConfig(PROGRAM, tier)) } : {}),
  }),
});
const searchOf = (pools: PoolSearch['pools']): PoolSearchRead => ({
  kind: 'ok',
  search: { mint: mint.toBase58(), known: { launchPool: key().toBase58(), standard: [] }, index: { kind: 'ok', pools: [], truncated: false }, pools, otherPairs: 0, knownState: {}, chainNow: NOW },
});
const input = (f: CreateFacts, pools: PoolSearch['pools'] = [], safety: TokenSafety = okToken) => ({
  mode: 'on' as const,
  gate: GATE,
  facts: f,
  notes: [],
  safety,
  outside: { kind: 'ok' as const, solPerToken: 0.01, source: 'Jupiter' as const },
  search: searchOf(pools),
  healths: new Map(pools.flatMap((e) => (e.kind === 'pool' ? [[e.view.address, allowed] as const] : []))),
});

describe('createOffer with a list of tiers', () => {
  it('offers while any public tier the token is offered is ready: both, tier 1 alone (mainnet today), tier 2 alone for USDC', () => {
    expect(createOffer(input(facts(ready(1), ready(2))))).toBe('offer');
    expect(createOffer(input(facts(ready(1), notOpen(2))))).toBe('offer');
    expect(createOffer(input(facts(notOpen(1), ready(2)), [], usdcToken))).toBe('offer');
    expect(createOffer(input(facts(off(1), ready(2)), [], usdcToken))).toBe('offer');
  });

  it('a meme coin is offered tier 1 only: tier 2 ready alone offers it nothing, and the card names tier 1’s state (owner, 2026-10-24)', () => {
    expect(createOffer(input(facts(notOpen(1), ready(2))))).toBe('tier-not-open');
    expect(createOffer(input(facts(off(1), ready(2))))).toBe('tier-off');
    expect(readyTiers(facts(ready(1), ready(2)), mint.toBase58()).map((t) => t.index)).toEqual([1]);
    expect(readyTiers(facts(ready(1), ready(2)), USDC_QUOTE.mint).map((t) => t.index)).toEqual([1, 2]);
    // With a coin named, the pair decides: a meme coin with USDC is not SOL against USDC either.
    expect(readyTiers(facts(ready(1), ready(2)), mint.toBase58(), USDC_QUOTE.mint).map((t) => t.index)).toEqual([1]);
    // A tier whose rate was not read is not ruled out: it is said as unread, as before.
    expect(offeredTiers(facts(ready(1), unread(2)).tiers, mint.toBase58()).map((t) => t.kind)).toEqual(['ready', 'unread']);
  });

  it('a tier whose read failed beside a ready one: still offered (on the ready one), and the failed one is named as unread', () => {
    const f = facts(ready(1), unread(2));
    expect(createOffer(input(f))).toBe('offer');
    expect(f.tiers.filter((t) => t.kind === 'ready').map((t) => t.index)).toEqual([1]);
  });

  it('no tier ready: an unread tier wins (Refresh can fix it), then a tier that exists but is off, then not created', () => {
    expect(createOffer(input(facts(unread(1), notOpen(2))))).toBe('tier-unread');
    expect(createOffer(input(facts(notOpen(1), unread(2))))).toBe('tier-unread');
    expect(tierStop(facts(notOpen(1), unread(2)).tiers)).toMatchObject({ kind: 'unread', index: 2 });
    expect(createOffer(input(facts(notOpen(1), off(2)), [], usdcToken))).toBe('tier-off');
    // For a meme coin tier 2 being off decides nothing: tier 1 is not created.
    expect(createOffer(input(facts(notOpen(1), off(2))))).toBe('tier-not-open');
    expect(tierStop(facts(notOpen(1), off(2)).tiers)).toMatchObject({ kind: 'switched-off', index: 2 });
    expect(createOffer(input(facts(notOpen(1), notOpen(2))))).toBe('tier-not-open');
    expect(createOffer(input(facts(off(1), off(2))))).toBe('tier-off');
  });
});

describe('the pool pointed to first may be on either public tier', () => {
  const adviceOf = (f: CreateFacts, pools: PoolSearch['pools']) => {
    const a = input(f, pools);
    return createAdvice({ gate: a.gate, search: a.search, healths: a.healths, openedHere: () => false });
  };

  it('a passing SOL/USDC pool on tier 2 is pointed to; one on tier 0 is not', () => {
    const two = poolOn(2, USDC_KEY);
    expect(adviceOf(facts(ready(1), ready(2)), [two])).toEqual({ kind: 'exists', pool: two.view });
    expect(adviceOf(facts(ready(1), ready(2)), [poolOn(0)])).toEqual({ kind: 'none' });
  });

  it('a tier-2 pool is pointed to even while only tier 1 can open pools: it exists, and takes deposits', () => {
    const two = poolOn(2, USDC_KEY);
    expect(adviceOf(facts(ready(1), notOpen(2)), [two])).toEqual({ kind: 'exists', pool: two.view });
  });

  it('of a tier-1 and a tier-2 pool, the one holding more SOL', () => {
    const one = poolOn(1, USDC_KEY);
    const two = { ...poolOn(2, USDC_KEY) };
    two.view = { ...two.view, quoteReserve: SOL * 2n };
    expect(adviceOf(facts(ready(1), ready(2)), [one, two])).toEqual({ kind: 'exists', pool: two.view });
  });
});

describe('a meme coin is pointed to its tier-1 pool only (owner, 2026-10-24)', () => {
  const adviceOf = (pools: PoolSearch['pools']) => {
    const a = input(facts(ready(1), ready(2)), pools);
    return createAdvice({ gate: a.gate, search: a.search, healths: a.healths, openedHere: () => false });
  };

  it('its pool on tier 2 (0.25%) is never pointed to, however much it holds; its tier-1 pool is', () => {
    const one = poolOn(1);
    const two = { ...poolOn(2) };
    two.view = { ...two.view, quoteReserve: SOL * 5n };
    expect(adviceOf([two])).toEqual({ kind: 'none' });
    expect(adviceOf([one, two])).toEqual({ kind: 'exists', pool: one.view });
  });
});

describe('each tier has its own standard address per pair', () => {
  it('standardState asks for a tier: a pool at tier 1’s address leaves tier 2’s empty', () => {
    const [std1, std2, usdc2] = [key(), key(), key()].map((k) => k.toBase58());
    const known = {
      launchPool: key().toBase58(),
      standard: [
        { index: 1, config: TIER1.toBase58(), address: std1!, quote: SOL_QUOTE.mint },
        { index: 2, config: TIER2.toBase58(), address: std2!, quote: SOL_QUOTE.mint },
        { index: 0, config: deriveAmmConfig(PROGRAM, 0).toBase58(), address: key().toBase58(), quote: SOL_QUOTE.mint },
        { index: 2, config: TIER2.toBase58(), address: usdc2!, quote: USDC_QUOTE.mint },
      ],
    };
    const withState = (knownState: PoolSearch['knownState']): PoolSearchRead => ({
      kind: 'ok',
      search: { mint: mint.toBase58(), known, index: { kind: 'ok', pools: [], truncated: false }, pools: [], otherPairs: 0, knownState, chainNow: NOW },
    });
    const s = withState({ [std1!]: 'pool', [std2!]: 'absent', [usdc2!]: 'pool' });
    expect(standardState(s, SOL_QUOTE, 1)).toBe('taken');
    expect(standardState(s, SOL_QUOTE, 2)).toBe('empty');
    expect(standardState(s, USDC_QUOTE, 2)).toBe('taken');
    expect(standardState(s, USDC_QUOTE, 1)).toBe('empty');
  });
});
