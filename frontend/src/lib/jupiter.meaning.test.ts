// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { COMPARABLE_PLATFORM_FEE_BPS, jupiterNet, type JupiterQuote, type QuoteRead } from './jupiter';

/**
 * jupiterNet: Jupiter's `outAmount` counts as "what the trader receives after
 * our fee" only when the quote proves it (SPEC_S3 D4, T-JUP-04..11).
 *
 * The fixtures are SYNTHETIC copies of the shapes mainnet returned on
 * 2026-10-03: the leg counts, percents and amounts are the live ones, the
 * addresses are made up here.
 */

const key = () => PublicKey.unique().toBase58();
const SOL = key();
const OUT = key();
const MID_A = key();
const MID_B = key();

type Leg = { from: string; to: string; out: string; percent: number };
const leg = (l: Leg) => ({
  swapInfo: { ammKey: key(), label: 'Synthetic', inputMint: l.from, outputMint: l.to, inAmount: '1', outAmount: l.out },
  percent: l.percent,
  bps: null,
});

/** A fee-bearing quote whose own numbers add up: fee = floor(S x 50 / 10000), outAmount = S - fee. */
function quoteOf(o: { amount: string; legs: Leg[]; input?: string; output?: string }): { read: Extract<QuoteRead, { kind: 'quote' }>; asked: { inputMint: string; outputMint: string; amount: string }; net: bigint } {
  const input = o.input ?? SOL;
  const output = o.output ?? OUT;
  const sum = o.legs.filter((l) => l.to === output).reduce((s, l) => s + BigInt(l.out), 0n);
  const fee = (sum * 50n) / 10_000n;
  const net = sum - fee;
  const quote: JupiterQuote = {
    inputMint: input,
    outputMint: output,
    inAmount: o.amount,
    outAmount: net.toString(),
    otherAmountThreshold: (net - (net * 50n) / 10_000n).toString(),
    swapMode: 'ExactIn',
    slippageBps: 50,
    priceImpactPct: '0',
    platformFee: { amount: fee.toString(), feeBps: 50 },
    routePlan: o.legs.map(leg),
  };
  return { read: { kind: 'quote', quote, feeBpsSent: 50 }, asked: { inputMint: input, outputMint: output, amount: o.amount }, net };
}

// The four live shapes.
const SINGLE = () => quoteOf({ amount: '100000000', legs: [{ from: SOL, to: OUT, out: '21871542131', percent: 100 }] });
const THREE_HOPS = () =>
  quoteOf({
    amount: '100000000',
    legs: [
      { from: SOL, to: MID_A, out: '2136315541', percent: 100 },
      { from: MID_A, to: MID_B, out: '11907822', percent: 100 },
      { from: MID_B, to: OUT, out: '326590000000', percent: 100 },
    ],
  });
const SPLIT_THREE_FINAL = () =>
  quoteOf({
    amount: '300000000000',
    legs: [
      { from: SOL, to: OUT, out: '146490440000000', percent: 15 },
      { from: SOL, to: MID_A, out: '30360691831', percent: 85 },
      { from: MID_A, to: OUT, out: '448461727736704', percent: 54 },
      { from: MID_A, to: OUT, out: '380077780000000', percent: 46 },
    ],
  });
const SPLIT_PLUS_HOP = () =>
  quoteOf({
    amount: '1000000000000',
    legs: [
      { from: SOL, to: OUT, out: '69046166839', percent: 58 },
      { from: SOL, to: OUT, out: '30950550693', percent: 26 },
      { from: SOL, to: MID_A, out: '19049383705', percent: 16 },
      { from: MID_A, to: OUT, out: '19046297704', percent: 100 },
    ],
  });

/** One field of the quote replaced. */
function withQuote(base: ReturnType<typeof quoteOf>, over: Partial<JupiterQuote>) {
  return { ...base.read, quote: { ...base.read.quote, ...over } };
}

describe('jupiterNet returns outAmount when the quote proves it is after our fee', () => {
  it('the rate it compares at is the site’s 0.5%, committed', () => {
    expect(COMPARABLE_PLATFORM_FEE_BPS).toBe(50);
  });

  it('a single leg (live: 21,871,542,131 out, fee 109,357,710)', () => {
    const q = SINGLE();
    expect(q.read.quote.platformFee).toEqual({ amount: '109357710', feeBps: 50 });
    expect(jupiterNet(q.read, q.asked)).toBe(21_762_184_421n);
  });

  it('three hops: only the last leg pays out in the output mint (live fee 1,632,950,000)', () => {
    const q = THREE_HOPS();
    expect(q.read.quote.platformFee).toEqual({ amount: '1632950000', feeBps: 50 });
    expect(jupiterNet(q.read, q.asked)).toBe(326_590_000_000n - 1_632_950_000n);
  });

  it('a four-leg split with three final legs: the three are summed (live fee 4,875,149,738,683)', () => {
    const q = SPLIT_THREE_FINAL();
    expect(q.read.quote.platformFee).toEqual({ amount: '4875149738683', feeBps: 50 });
    expect(jupiterNet(q.read, q.asked)).toBe(975_029_947_736_704n - 4_875_149_738_683n);
  });

  it('split plus hop: the hop’s middle leg is not counted (live fee 595,215,076)', () => {
    const q = SPLIT_PLUS_HOP();
    expect(q.read.quote.platformFee).toEqual({ amount: '595215076', feeBps: 50 });
    expect(jupiterNet(q.read, q.asked)).toBe(119_043_015_236n - 595_215_076n);
  });

  it('a sell (the output is SOL) reads the same way (live: 8,960,015 out, fee 44,800)', () => {
    const q = quoteOf({ amount: '5000000000', input: OUT, output: SOL, legs: [{ from: OUT, to: SOL, out: '8960015', percent: 100 }] });
    expect(q.read.quote.platformFee).toEqual({ amount: '44800', feeBps: 50 });
    expect(jupiterNet(q.read, q.asked)).toBe(8_915_215n);
  });
});

describe('jupiterNet is null (unread, not zero) whenever the proof is missing', () => {
  it('the request carried no platform fee, or another rate', () => {
    const q = SINGLE();
    expect(jupiterNet({ ...q.read, feeBpsSent: null }, q.asked)).toBeNull();
    expect(jupiterNet({ ...q.read, feeBpsSent: 100 }, q.asked)).toBeNull();
    expect(jupiterNet({ ...q.read, feeBpsSent: 49 }, q.asked)).toBeNull();
  });

  it('platformFee is missing, null or not an object', () => {
    const q = SINGLE();
    expect(jupiterNet(withQuote(q, { platformFee: undefined }), q.asked)).toBeNull();
    expect(jupiterNet(withQuote(q, { platformFee: null }), q.asked)).toBeNull();
    expect(jupiterNet(withQuote(q, { platformFee: 'yes' as unknown as JupiterQuote['platformFee'] }), q.asked)).toBeNull();
  });

  it('the quote records another rate than the one asked (49, 51, 0, a string)', () => {
    const q = SINGLE();
    for (const feeBps of [49, 51, 0, '50' as unknown as number, undefined]) {
      expect(jupiterNet(withQuote(q, { platformFee: { amount: '109357710', feeBps } }), q.asked)).toBeNull();
    }
  });

  it('the fee amount is not floor(S x 50 / 10000): one unit over, one unit under, or unreadable', () => {
    const q = SINGLE();
    // The out amount is moved with it, so the SUM still holds and only the floor rule can refuse.
    const off = (fee: bigint) =>
      withQuote(q, { platformFee: { amount: fee.toString(), feeBps: 50 }, outAmount: (21_871_542_131n - fee).toString() });
    expect(jupiterNet(off(109_357_710n), q.asked)).toBe(21_762_184_421n);
    expect(jupiterNet(off(109_357_711n), q.asked)).toBeNull();
    expect(jupiterNet(off(109_357_709n), q.asked)).toBeNull();
    expect(jupiterNet(withQuote(q, { platformFee: { amount: '109357710.0', feeBps: 50 } }), q.asked)).toBeNull();
    expect(jupiterNet(withQuote(q, { platformFee: { feeBps: 50 } }), q.asked)).toBeNull();
  });

  it('outAmount plus the fee is not the legs’ sum: off by +1 and by -1', () => {
    const q = SINGLE();
    expect(jupiterNet(withQuote(q, { outAmount: (q.net + 1n).toString() }), q.asked)).toBeNull();
    expect(jupiterNet(withQuote(q, { outAmount: (q.net - 1n).toString() }), q.asked)).toBeNull();
  });

  it('outAmount is the GROSS number (the fee not taken off): the case this check exists for', () => {
    const q = SINGLE();
    expect(jupiterNet(withQuote(q, { outAmount: '21871542131' }), q.asked)).toBeNull();
  });

  it('inAmount is not the amount asked for', () => {
    const q = SINGLE();
    expect(jupiterNet(q.read, { ...q.asked, amount: '100000001' })).toBeNull();
    expect(jupiterNet(withQuote(q, { inAmount: '99999999' }), q.asked)).toBeNull();
  });

  it('the mints are swapped, or either is another mint', () => {
    const q = SINGLE();
    expect(jupiterNet(q.read, { ...q.asked, inputMint: q.asked.outputMint, outputMint: q.asked.inputMint })).toBeNull();
    expect(jupiterNet(q.read, { ...q.asked, inputMint: key() })).toBeNull();
    expect(jupiterNet(q.read, { ...q.asked, outputMint: key() })).toBeNull();
  });

  it('swapMode is ExactOut', () => {
    const q = SINGLE();
    expect(jupiterNet(withQuote(q, { swapMode: 'ExactOut' }), q.asked)).toBeNull();
  });

  it('a leg without an outAmount, even a middle one, or without its output mint', () => {
    const q = THREE_HOPS();
    const plan = q.read.quote.routePlan as { swapInfo: Record<string, unknown> }[];
    const without = (i: number, field: string) =>
      withQuote(q, { routePlan: plan.map((l, n) => (n === i ? { ...l, swapInfo: { ...l.swapInfo, [field]: undefined } } : l)) });
    expect(jupiterNet(without(2, 'outAmount'), q.asked)).toBeNull();
    expect(jupiterNet(without(0, 'outAmount'), q.asked)).toBeNull();
    expect(jupiterNet(without(1, 'outputMint'), q.asked)).toBeNull();
    expect(jupiterNet(withQuote(q, { routePlan: [...plan, null] }), q.asked)).toBeNull();
    expect(jupiterNet(withQuote(q, { routePlan: [...plan, {}] }), q.asked)).toBeNull();
  });

  it('no route plan, an empty one, or one with no leg paying the output mint', () => {
    const q = SINGLE();
    expect(jupiterNet(withQuote(q, { routePlan: [] }), q.asked)).toBeNull();
    expect(jupiterNet(withQuote(q, { routePlan: 'none' as unknown as unknown[] }), q.asked)).toBeNull();
    const elsewhere = quoteOf({ amount: '100000000', legs: [{ from: SOL, to: MID_A, out: '5', percent: 100 }] });
    expect(jupiterNet(withQuote(elsewhere, { platformFee: { amount: '0', feeBps: 50 }, outAmount: '0' }), elsewhere.asked)).toBeNull();
  });

  it('a quote whose proven net is zero is not a price', () => {
    // One unit out: the fee floors to 0 and the sum holds, but 0 or dust is not a route to rank against.
    const dust = quoteOf({ amount: '1', legs: [{ from: SOL, to: OUT, out: '0', percent: 100 }] });
    expect(jupiterNet(dust.read, dust.asked)).toBeNull();
  });
});
