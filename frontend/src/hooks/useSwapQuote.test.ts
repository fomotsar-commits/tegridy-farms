/**
 * useSwapQuote — price-impact outage-as-zero regression suite.
 *
 * WHAT THIS FILE PINS
 * -------------------
 * `priceImpact` is the single number a trader reads before signing a swap, and
 * the whole warning ladder keys off it (>3% red, >5% "High price impact!"
 * banner, the urgent nudge). Before the fix it was typed `number` and every
 * failure path in the memo `return 0`-ed: no reserves, no token0, a reserve
 * side reading 0, execOut 0, and the catch. A single failed `getReserves`
 * therefore rendered "0.00%" — the most reassuring value in the range — about a
 * pool nobody had successfully read, and disarmed all three warnings at once
 * while the quote beside them looked complete.
 *
 * The fix makes it `number | null` (null = "we could not price it") and adds a
 * sibling `priceImpactUnread: boolean`, gated so that states which are NOT an
 * outage — nothing typed yet, wrong network, a mid-flight quote, a token whose
 * only pool is the native one — do not raise the flag.
 *
 * BOTH HALVES ARE PINNED HERE:
 *   - UNREAD: a failed read must be null and must ARM `priceImpactUnread`.
 *   - GENUINE ZERO: a successfully-read, actually-measured 0 must stay exactly
 *     0 (never null) and must NOT arm the flag. A fix that turned real zeros
 *     into "unavailable" would be a new bug; only this half catches it.
 *
 * Each `it` names the OLD value in a comment so the discriminating power of the
 * assertion is auditable without reverting the source.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { parseEther } from 'viem';
import { wagmiMock } from '../test-utils/wagmi-mocks';

import { useSwapQuote } from './useSwapQuote';
import {
  UNISWAP_V2_FACTORY,
  UNISWAP_V2_ROUTER,
  TEGRIDY_FACTORY_ADDRESS,
  TEGRIDY_ROUTER_ADDRESS,
  WETH_ADDRESS,
  CHAIN_ID,
} from '../lib/constants';
import { NATIVE_ETH_ADDRESS, type TokenInfo } from '../lib/tokenList';

const ZERO_ADDR = '0x0000000000000000000000000000000000000000' as const;
const PAIR = '0x9999999999999999999999999999999999999999' as const;

const ETH: TokenInfo = {
  address: NATIVE_ETH_ADDRESS,
  symbol: 'ETH',
  name: 'Ether',
  decimals: 18,
  logoURI: '',
  isNative: true,
};
const TKN: TokenInfo = {
  address: '0x1111111111111111111111111111111111111111',
  symbol: 'TKN',
  name: 'Token',
  decimals: 18,
  logoURI: '',
};
const TKB: TokenInfo = {
  address: '0x2222222222222222222222222222222222222222',
  symbol: 'TKB',
  name: 'Token B',
  decimals: 18,
  logoURI: '',
};

// ── Pool shape used by every direct-pair case ────────────────────────────────
// token0 == WETH, so reserves[0] is the ETH side (reserveIn for an ETH->TKN
// swap) and reserves[1] the TKN side. 1,000,000 ETH against 2,000,000,000 TKN
// puts the pool mid-price at exactly 2000 TKN/ETH.
const DEEP_RESERVES = [parseEther('1000000'), parseEther('2000000000'), 0] as const;
const MID_PRICE_TKN_PER_ETH = 2000n;
// A dust trade against that pool: 0.001 ETH in.
const DUST_IN = parseEther('0.001');
// What the pool mid-price alone would hand back for DUST_IN: 2 TKN.
const AT_MID_OUT = DUST_IN * MID_PRICE_TKN_PER_ETH; // 2e18

/** Uniswap factory reports a live direct pair for the selected tokens. */
function stubDirectPair(addr: string = PAIR) {
  wagmiMock.setReadResult({ functionName: 'getPair', address: UNISWAP_V2_FACTORY, result: addr });
}

/** A signable Uniswap quote is already in hand (the state the fix cares about). */
function stubUniQuote(amountIn: bigint, amountOut: bigint) {
  wagmiMock.setReadResult({
    functionName: 'getAmountsOut',
    address: UNISWAP_V2_ROUTER,
    result: [amountIn, amountOut],
  });
}

/** The pair's own reads land successfully. */
function stubPairReads(reserves: readonly unknown[] = DEEP_RESERVES, token0: unknown = WETH_ADDRESS) {
  wagmiMock.setReadResult({ functionName: 'getReserves', address: PAIR, result: reserves });
  wagmiMock.setReadResult({ functionName: 'token0', address: PAIR, result: token0 });
}

function render(from: TokenInfo | null, to: TokenInfo | null, amount: bigint) {
  // address === undefined keeps the meta-aggregator effect short-circuited, so
  // these are pure on-chain-leg assertions with no network and no timers.
  return renderHook(() => useSwapQuote(from, to, amount, 0.5, undefined));
}

describe('useSwapQuote — priceImpact outage-as-zero', () => {
  beforeEach(() => {
    wagmiMock.reset();
    wagmiMock.setChainId(CHAIN_ID);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // UNREAD — a failed read is not 0%, and it arms the flag
  // ───────────────────────────────────────────────────────────────────────────

  it('UNREAD: pair found and quote in hand, but getReserves/token0 failed -> null, flag armed', () => {
    // The exact shape from the audit: the factory answered, the router answered,
    // only the pair's own reads went quiet.
    stubDirectPair();
    stubUniQuote(DUST_IN, parseEther('1.9'));
    // getReserves + token0 deliberately UNSTUBBED == a failed read (data: undefined).

    const { result } = render(ETH, TKN, DUST_IN);

    // The quote itself is fine — this is an outage in the impact leg only.
    expect(result.current.outputAmount).toBe(parseEther('1.9'));

    // OLD: `if (!reserves || !token0) return 0` -> priceImpact === 0, rendered
    // as a reassuring "0.00%" over reserves nobody read.
    expect(result.current.priceImpact).toBeNull();
    expect(result.current.priceImpact).not.toBe(0);
    // OLD: the field did not exist -> undefined, so nothing could tell the UI
    // to swap the number for an "unavailable" state.
    expect(result.current.priceImpactUnread).toBe(true);
  });

  it('UNREAD: token0 landed but getReserves did not -> still null, flag armed', () => {
    // Half a pair read is not a mid-price. Pins that the fix is not satisfied by
    // one of the two reads arriving.
    stubDirectPair();
    stubUniQuote(DUST_IN, parseEther('1.9'));
    wagmiMock.setReadResult({ functionName: 'token0', address: PAIR, result: WETH_ADDRESS });

    const { result } = render(ETH, TKN, DUST_IN);

    // OLD: 0 (same `!reserves` branch). NEW: null.
    expect(result.current.priceImpact).toBeNull();
    expect(result.current.priceImpactUnread).toBe(true);
  });

  it('UNREAD: a reserve side reading 0 -> null, flag armed (no mid-price to divide by)', () => {
    stubDirectPair();
    stubUniQuote(DUST_IN, parseEther('1.9'));
    stubPairReads([0n, 0n, 0]);

    const { result } = render(ETH, TKN, DUST_IN);

    // OLD: `if (reserveIn <= 0n || reserveOut <= 0n) return 0`.
    expect(result.current.priceImpact).toBeNull();
    expect(result.current.priceImpactUnread).toBe(true);
  });

  it('UNREAD: garbage token0 that throws in the bigint math -> null, flag armed', () => {
    // A non-string token0 (a garbage/decoded-wrong read) makes
    // `token0.toLowerCase()` throw inside the try.
    stubDirectPair();
    stubUniQuote(DUST_IN, parseEther('1.9'));
    stubPairReads(DEEP_RESERVES, 12345n);

    const { result } = render(ETH, TKN, DUST_IN);

    // OLD: the catch `return 0` — a thrown calculation presented as "no impact".
    expect(result.current.priceImpact).toBeNull();
    expect(result.current.priceImpactUnread).toBe(true);
  });

  it('UNREAD: multi-hop with both leg pairs found but leg reserves failed -> null, flag armed', () => {
    // TKN -> TKB routes through WETH, so path.length === 3 and the impact is
    // measured off leg1/leg2 reserves instead of the direct pair.
    stubDirectPair(); // all three UNISWAP_V2_FACTORY getPair reads resolve to PAIR
    wagmiMock.setReadResult({
      functionName: 'getAmountsOut',
      address: UNISWAP_V2_ROUTER,
      result: [DUST_IN, parseEther('0.5'), parseEther('900')],
    });
    // leg1Reserves / leg2Reserves / leg1Token0 / leg2Token0 UNSTUBBED == failed.

    const { result } = render(TKN, TKB, DUST_IN);

    expect(result.current.path).toHaveLength(3);
    expect(result.current.outputAmount).toBe(parseEther('900'));
    // OLD: `if (!leg1Reserves || !leg1Token0 || ...) return 0`.
    expect(result.current.priceImpact).toBeNull();
    expect(result.current.priceImpactUnread).toBe(true);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // GENUINE ZERO — a measured 0 stays 0 and must NOT arm the flag
  // ───────────────────────────────────────────────────────────────────────────

  it('GENUINE ZERO: deep pool + dust input whose impact rounds to 0 -> exactly 0, flag clear', () => {
    // Everything reads successfully. The measured adverse movement is real but
    // ~5e-14%, which floors to 0 bps — the impact genuinely IS 0.00%.
    stubDirectPair();
    stubPairReads();
    stubUniQuote(DUST_IN, AT_MID_OUT - 1000n); // a hair below mid-price

    const { result } = render(ETH, TKN, DUST_IN);

    // This is the half a careless fix breaks: turning real zeros into
    // "unavailable" would be a NEW outage-as-zero bug in the other direction.
    expect(result.current.priceImpact).toBe(0);
    expect(result.current.priceImpact).not.toBeNull();
    expect(typeof result.current.priceImpact).toBe('number');
    // OLD: field absent -> undefined. NEW: a successfully-read 0 is not an outage.
    expect(result.current.priceImpactUnread).toBe(false);
  });

  it('GENUINE ZERO: fill at or better than the pool mid-price clamps to 0, flag clear', () => {
    stubDirectPair();
    stubPairReads();
    stubUniQuote(DUST_IN, parseEther('2.1')); // better than the 2.0 TKN mid-price

    const { result } = render(ETH, TKN, DUST_IN);

    // The favorable-diff clamp. Unchanged by the fix, and asserted so it stays
    // that way: only ADVERSE movement is price impact.
    expect(result.current.priceImpact).toBe(0);
    expect(result.current.priceImpactUnread).toBe(false);
  });

  it('a healthy read producing a real 5% impact still reports the number and clears the flag', () => {
    // 0.001 ETH out at 1.9 TKN against a 2000 TKN/ETH mid = 500 bps adverse.
    // This is the banner-arming figure; it must survive the fix untouched, and
    // a successful read must never arm the outage flag.
    stubDirectPair();
    stubPairReads();
    stubUniQuote(DUST_IN, parseEther('1.9'));

    const { result } = render(ETH, TKN, DUST_IN);

    expect(result.current.priceImpact).toBe(5);
    expect(result.current.priceImpactUnread).toBe(false);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // NOT AN OUTAGE — null for a reason that is not a failed read
  // ───────────────────────────────────────────────────────────────────────────

  it('nothing typed yet: priceImpact is null but priceImpactUnread is FALSE', () => {
    // Pair + reserves read perfectly; the user simply has not entered an amount,
    // so there is no fill to measure. Not an outage, and the UI must not shout.
    stubDirectPair();
    stubPairReads();

    const { result } = render(ETH, TKN, 0n);

    expect(result.current.outputAmount).toBe(0n);
    // OLD: `if (parsedAmount === 0n || outputAmount === 0n ...) return 0` — the
    // empty swap form claimed a measured 0.00% impact.
    expect(result.current.priceImpact).toBeNull();
    // ...but this is not the network going quiet.
    expect(result.current.priceImpactUnread).toBe(false);
  });

  it('no Uniswap pair to price against (native-only pool): null, but flag stays FALSE', () => {
    // The token trades only on the native venue, so the `reserves` read is
    // disabled — we never asked, so we cannot claim a read failed.
    wagmiMock.setReadResult({ functionName: 'getPair', address: UNISWAP_V2_FACTORY, result: ZERO_ADDR });
    wagmiMock.setReadResult({ functionName: 'getPair', address: TEGRIDY_FACTORY_ADDRESS, result: PAIR });
    wagmiMock.setReadResult({
      functionName: 'getAmountsOut',
      address: TEGRIDY_ROUTER_ADDRESS,
      result: [DUST_IN, parseEther('2')],
    });

    const { result } = render(ETH, TKN, DUST_IN);

    expect(result.current.hasTegridyPair).toBe(true);
    expect(result.current.hasDirectPair).toBe(false);
    expect(result.current.outputAmount).toBeGreaterThan(0n);
    // OLD: 0. NEW: null — we have no mid-price for it either way, but now we
    // say so instead of inventing 0.00%.
    expect(result.current.priceImpact).toBeNull();
    // ...and "no pair" is not "the read failed".
    expect(result.current.priceImpactUnread).toBe(false);
  });

  it('wrong network: null, and the flag stays FALSE', () => {
    wagmiMock.setChainId(CHAIN_ID + 136); // an L2, not the configured chain
    stubDirectPair();
    stubUniQuote(DUST_IN, parseEther('1.9'));

    const { result } = render(ETH, TKN, DUST_IN);

    // OLD: 0 on the `!reserves` branch.
    expect(result.current.priceImpact).toBeNull();
    // A wrong-network visitor is a different fact from an outage.
    expect(result.current.priceImpactUnread).toBe(false);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Type-surface guard
  // ───────────────────────────────────────────────────────────────────────────

  it('never reports a concrete 0 on any unread path (no path returns 0 without reserves)', () => {
    // A compact sweep of every formerly-`return 0` unread branch, asserting the
    // property the audit is actually about: `0` is only ever reachable with a
    // successfully-read pair behind it.
    const unreadSetups: Array<[string, () => void]> = [
      ['no reserves, no token0', () => { stubDirectPair(); stubUniQuote(DUST_IN, parseEther('1.9')); }],
      ['zeroed reserves', () => { stubDirectPair(); stubUniQuote(DUST_IN, parseEther('1.9')); stubPairReads([0n, 0n, 0]); }],
      ['throwing token0', () => { stubDirectPair(); stubUniQuote(DUST_IN, parseEther('1.9')); stubPairReads(DEEP_RESERVES, 42); }],
    ];

    for (const [label, setup] of unreadSetups) {
      wagmiMock.reset();
      wagmiMock.setChainId(CHAIN_ID);
      setup();
      const { result, unmount } = render(ETH, TKN, DUST_IN);
      expect(result.current.priceImpact, label).not.toBe(0);
      expect(result.current.priceImpact, label).toBeNull();
      expect(result.current.priceImpactUnread, label).toBe(true);
      unmount();
    }
  });
});
