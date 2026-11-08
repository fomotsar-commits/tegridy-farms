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

describe('useSwapQuote on Base: our pools vs Uniswap V2, the better one wins (2026-10-17)', () => {
  const BASE = 8453;
  const BASE_UNI_ROUTER = '0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24';
  const BASE_OUR_FACTORY = '0x12a249A027AA7DdF184E824b4bb63ba031A39fEC';
  const BASE_OUR_ROUTER = '0x4B134C08aAF86B6e2A8E097D1039C4e7638806f3';
  const OUR_PAIR = '0x8888888888888888888888888888888888888888';
  const IN = parseEther('1');

  beforeEach(() => {
    wagmiMock.reset();
    wagmiMock.setChainId(BASE);
    // Mainnet's routers answer too, with a number that must never surface on Base.
    wagmiMock.setReadResult({ functionName: 'getAmountsOut', address: UNISWAP_V2_ROUTER, result: [IN, parseEther('999999')] });
    wagmiMock.setReadResult({ functionName: 'getAmountsOut', address: TEGRIDY_ROUTER_ADDRESS, result: [IN, parseEther('999999')] });
    wagmiMock.setReadResult({ functionName: 'getPair', address: TEGRIDY_FACTORY_ADDRESS, result: PAIR });
    wagmiMock.setReadResult({ functionName: 'getAmountsOut', address: BASE_UNI_ROUTER, result: [IN, parseEther('2000')] });
  });

  const quoteOnBase = () => renderHook(() => useSwapQuote(ETH, TKN, IN, 0.5, undefined, BASE)).result.current;

  it('with no pool of ours, quotes Uniswap V2 on Base, never a mainnet router', () => {
    wagmiMock.setReadResult({ functionName: 'getPair', address: BASE_OUR_FACTORY, result: ZERO_ADDR });
    const q = quoteOnBase();
    expect(q.selectedRoute).toBe('uniswap');
    expect(q.outputAmount).toBe(parseEther('2000'));
    expect(q.hasTegridyPair).toBe(false);
  });

  it('takes our pool when it pays more after the venue fee', () => {
    wagmiMock.setReadResult({ functionName: 'getPair', address: BASE_OUR_FACTORY, result: OUR_PAIR });
    // 2100 before a 0.5% fee is 2089.5 after: more than Uniswap's 2000.
    wagmiMock.setReadResult({ functionName: 'getAmountsOut', address: BASE_OUR_ROUTER, result: [IN, parseEther('2100')] });
    const q = quoteOnBase();
    expect(q.selectedRoute).toBe('tegridy');
    expect(q.outputAmount).toBe((parseEther('2100') * 9950n) / 10000n);
  });

  it('sends the trade to Uniswap when our pool pays less after the venue fee', () => {
    wagmiMock.setReadResult({ functionName: 'getPair', address: BASE_OUR_FACTORY, result: OUR_PAIR });
    // 2005 before the fee is 1994.975 after: less than Uniswap's 2000.
    wagmiMock.setReadResult({ functionName: 'getAmountsOut', address: BASE_OUR_ROUTER, result: [IN, parseEther('2005')] });
    const q = quoteOnBase();
    expect(q.selectedRoute).toBe('uniswap');
    expect(q.outputAmount).toBe(parseEther('2000'));
  });

  it('without a chain argument, a wallet on Base gets no quote at all (the zap plan relies on it)', () => {
    const q = renderHook(() => useSwapQuote(ETH, TKN, IN, 0.5, undefined)).result.current;
    expect(q.outputAmount).toBe(0n);
  });
});

describe('useSwapQuote: ETH into WETH is one coin, not a route', () => {
  // The path is [weth, weth]: no pool swaps a coin for itself, the quote is 0 and the Swap
  // button stays off. Before, the route line still read "Direct swap via Uniswap V2".
  const BASE_WETH: TokenInfo = {
    address: '0x4200000000000000000000000000000000000006', symbol: 'WETH', name: 'Wrapped Ether', decimals: 18, logoURI: '',
  };
  const MAINNET_WETH: TokenInfo = { ...BASE_WETH, address: WETH_ADDRESS };
  const SAME_COIN = 'ETH and WETH are the same coin; wrap or unwrap it in your wallet';

  beforeEach(() => wagmiMock.reset());

  it('says so on Base, both ways round', () => {
    wagmiMock.setChainId(8453);
    for (const [from, to] of [[ETH, BASE_WETH], [BASE_WETH, ETH]] as const) {
      const q = renderHook(() => useSwapQuote(from, to, parseEther('1'), 0.5, undefined, 8453)).result.current;
      expect(q.routeLabel).toBe(SAME_COIN);
      expect(q.outputAmount).toBe(0n);
    }
  });

  it('says so on Ethereum too, where an aggregator quote is never routable in-app', () => {
    wagmiMock.setChainId(CHAIN_ID);
    const q = renderHook(() => useSwapQuote(ETH, MAINNET_WETH, parseEther('1'), 0.5, undefined)).result.current;
    expect(q.routeLabel).toBe(SAME_COIN);
  });

  it('leaves a real pair alone', () => {
    wagmiMock.setChainId(CHAIN_ID);
    stubDirectPair(PAIR);
    stubUniQuote(DUST_IN, AT_MID_OUT);
    stubPairReads();
    const q = renderHook(() => useSwapQuote(ETH, TKN, DUST_IN, 0.5, undefined)).result.current;
    expect(q.routeLabel).toMatch(/^Direct swap via/);
  });
});

describe('useSwapQuote: a dust pool reads as the impact it is (2026-11-01)', () => {
  beforeEach(() => wagmiMock.reset());

  it("Base's live BNKR/WETH V2 pool: 1.75M in drains it, and the impact says ~100%", () => {
    // Read on Base 2026-11-01, pair 0x7760…7b96: token0 = BNKR, reserves 7.19 BNKR /
    // 0.0000011 ETH, and the router's getAmountsOut for 1.75M BNKR.
    const IN = 1_750_000n * 10n ** 18n;
    stubDirectPair();
    stubPairReads([7_189_201_342_686_852_655n, 1_072_070_123_355n, 0], TKN.address);
    stubUniQuote(IN, 1_072_065_705_933n);

    const { result } = render(TKN, ETH, IN);

    expect(result.current.priceImpact).not.toBeNull();
    expect(result.current.priceImpact!).toBeGreaterThan(99);
  });

  it('multi-hop with a leg reading zero reserves -> null, never a made-up 0.5%', () => {
    stubDirectPair();
    wagmiMock.setReadResult({
      functionName: 'getAmountsOut',
      address: UNISWAP_V2_ROUTER,
      result: [DUST_IN, parseEther('0.5'), parseEther('900')],
    });
    stubPairReads([0n, 0n, 0], WETH_ADDRESS);

    const { result } = render(TKN, TKB, DUST_IN);

    expect(result.current.path).toHaveLength(3);
    // OLD: `return 0.5` - a small, signable figure under useSwap's 15% block.
    expect(result.current.priceImpact).toBeNull();
  });
});

describe("useSwapQuote on Base: an island coin's own V3 pool, net of the venue fee (2026-11-01)", () => {
  const BASE = 8453;
  const BNKR: TokenInfo = { address: '0x22aF33FE49fD1Fa80c7149773dDe5890D3c76F3b', symbol: 'BNKR', name: 'BNKR', decimals: 18, logoURI: '' };
  const BASE_UNI_ROUTER = '0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24';
  const BASE_UNI_FACTORY = '0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6';
  const BASE_OUR_FACTORY = '0x12a249A027AA7DdF184E824b4bb63ba031A39fEC';
  const BASE_OUR_ROUTER = '0x4B134C08aAF86B6e2A8E097D1039C4e7638806f3';
  const BASE_SFR = '0xa24C7287eC56A7DEFDc70033803451240e267a52';
  const QUOTER = '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a';
  const POOL = '0xAEC085E5A5CE8d96A7bDd3eB3A62445d4f6CE703';
  const SAFE = '0xfc5D5018E557941A3BB7Ff057d1B0c2eCC09fbf1';
  // Read on Base at block 53,364,275: the V2 pair's dust quote, the V3 pool's quote and its price.
  const IN = 1_750_000n * 10n ** 18n;
  const V2_OUT = 1_072_065_705_933n;
  const V3_OUT = 221_929_058_837_612_529n;
  const SQRT_PRICE = 28_362_346_456_993_016_360_770_419n;

  beforeEach(() => {
    wagmiMock.reset();
    wagmiMock.setChainId(BASE);
    wagmiMock.setReadResult({ functionName: 'getPair', address: BASE_OUR_FACTORY, result: ZERO_ADDR });
    wagmiMock.setReadResult({ functionName: 'getPair', address: BASE_UNI_FACTORY, result: PAIR });
    wagmiMock.setReadResult({ functionName: 'getReserves', address: PAIR, result: [7_189_201_342_686_852_655n, 1_072_070_123_355n, 0] });
    wagmiMock.setReadResult({ functionName: 'token0', address: PAIR, result: BNKR.address });
    wagmiMock.setReadResult({ functionName: 'getAmountsOut', address: BASE_UNI_ROUTER, result: [IN, V2_OUT] });
    wagmiMock.setReadResult({ functionName: 'feeBps', address: BASE_SFR, result: 50n });
    wagmiMock.setReadResult({ functionName: 'revenueDistributor', address: BASE_SFR, result: SAFE });
    wagmiMock.setReadResult({ functionName: 'quoteExactInputSingle', address: QUOTER, result: [V3_OUT, 0n, 0, 0n] });
    wagmiMock.setReadResult({ functionName: 'slot0', address: POOL, result: [SQRT_PRICE, 0, 0, 0, 0, 0, true] });
  });

  const sell = () => renderHook(() => useSwapQuote(BNKR, ETH, IN, 1, undefined, BASE)).result.current;

  it('sells 1.75M BNKR through its V3 pool: 0.2219 ETH less the 0.5% venue fee, not the V2 dust', () => {
    const q = sell();
    expect(q.selectedRoute).toBe('uniswap-v3');
    expect(q.outputAmount).toBe(V3_OUT - (V3_OUT * 50n) / 10000n);
    expect(q.v3).toEqual({
      leg: expect.objectContaining({ side: 'sell', coin: BNKR.address, pool: POOL, poolFee: 10000, router: '0x6fF5693b99212Da76ad316178A184AB56D299b43' }),
      feeBips: 50n,
      feeRecipient: SAFE,
    });
    expect(q.routeLabel).toBe('Direct swap via Uniswap V3 (incl. 0.5% fee)');
    expect(q.minimumReceived).toBe(q.outputAmount - (q.outputAmount * 100n) / 10000n);
  });

  it("measures the impact against the pool's own price: ~1%, the pool's fee, not the V2 pair's 99.99%", () => {
    const q = sell();
    expect(q.priceImpact).not.toBeNull();
    expect(q.priceImpact!).toBeGreaterThan(1);
    expect(q.priceImpact!).toBeLessThan(1.2);
    expect(q.priceImpactUnread).toBe(false);
  });

  it("an unread pool price is an unread impact, not a 0%", () => {
    wagmiMock.setReadResult({ functionName: 'slot0', address: POOL, result: undefined, status: 'failure' });
    const q = sell();
    expect(q.selectedRoute).toBe('uniswap-v3');
    expect(q.priceImpact).toBeNull();
    expect(q.priceImpactUnread).toBe(true);
  });

  it('no V3 route when the fee Safe cannot be read: a fee is never sent to an address nobody read', () => {
    wagmiMock.setReadResult({ functionName: 'revenueDistributor', address: BASE_SFR, result: undefined, status: 'failure' });
    const q = sell();
    expect(q.selectedRoute).toBe('uniswap');
    expect(q.v3).toBeNull();
    expect(q.outputAmount).toBe(V2_OUT);
  });

  it('our own pool keeps the trade on a tie with the V3 route, both net of the venue fee', () => {
    wagmiMock.setReadResult({ functionName: 'getPair', address: BASE_OUR_FACTORY, result: '0x8888888888888888888888888888888888888888' });
    // The smallest output whose fee-netted figure equals the V3 route's to the wei.
    const v3Net = V3_OUT - (V3_OUT * 50n) / 10000n;
    const ours = (v3Net * 10000n + 9949n) / 9950n;
    wagmiMock.setReadResult({ functionName: 'getAmountsOut', address: BASE_OUR_ROUTER, result: [IN, ours] });
    const q = sell();
    expect(q.outputAmount).toBe(v3Net);
    expect(q.selectedRoute).toBe('tegridy');
    expect(q.v3).toBeNull();
  });

  it('a coin the island does not list gets no V3 route, whatever the quoter says', () => {
    const q = renderHook(() => useSwapQuote(TKN, ETH, IN, 1, undefined, BASE)).result.current;
    expect(q.v3).toBeNull();
    expect(q.selectedRoute).not.toBe('uniswap-v3');
  });

  it('a buy is quoted on the ETH left after the fee, and its output is not cut again', () => {
    // Only a quote for 0.1 ETH less 0.5% answers 769,165 BNKR (the fork's figure); any other amount gets V3_OUT.
    const BUY_OUT = 769_165_381_987_158_972_545_628n;
    wagmiMock.addReadPredicate({
      match: (s) => s.functionName === 'quoteExactInputSingle'
        && (s.args?.[0] as { amountIn?: bigint } | undefined)?.amountIn === parseEther('0.1') - parseEther('0.0005'),
      result: [BUY_OUT, 0n, 0, 0n],
    });
    const q = renderHook(() => useSwapQuote(ETH, BNKR, parseEther('0.1'), 1, undefined, BASE)).result.current;
    expect(q.selectedRoute).toBe('uniswap-v3');
    expect(q.v3?.leg.side).toBe('buy');
    expect(q.outputAmount).toBe(BUY_OUT);
  });

  it('on Ethereum there is no V3 route at all (no Universal Router wired there)', () => {
    wagmiMock.setChainId(1);
    const q = renderHook(() => useSwapQuote(BNKR, ETH, IN, 1, undefined, 1)).result.current;
    expect(q.v3).toBeNull();
  });
});
