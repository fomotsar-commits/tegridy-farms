import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitLeg, judgePool, legOut, outsideFacts } from '../src/opportunity.js';
import { ownSwap } from '../src/pool.js';
import { BAYLA_MINT, SOL_MINT, USDC_MINT } from '../src/config.js';

// A stand-in outside market: a constant-product pool with a 1% fee on what goes in,
// the shape pump.fun's AMM has. Exact integer maths, like a real quote.
const cpmm = (x, rin, rout, feeBps = 100n) => {
  const xin = (x * (10_000n - feeBps)) / 10_000n;
  return (rout * xin) / (rin + xin);
};

const SOL_POOL = { name: 'BAYLA/SOL', token: BAYLA_MINT, coin: SOL_MINT, coinSymbol: 'SOL', maxIn: 0.5 };
const USDC_POOL = { name: 'BAYLA/USDC', token: BAYLA_MINT, coin: USDC_MINT, coinSymbol: 'USDC', maxIn: 20 };
const COSTS = { baseFee: 5_000n, tip: 10_000n, minProfit: 50_000n };

/** Our pool much like BAYLA/SOL on 10-16: ~33.4 SOL against ~5.65M BAYLA, 1% fee, 16% of it to the venue. */
function ourSolPool() {
  return {
    address: 'ours', slot: 1, mint0: SOL_MINT, mint1: BAYLA_MINT, decimals0: 9, decimals1: 6,
    reserve0: 33_361_352_659n, reserve1: 5_649_293_357_019n,
    tradeFeeRate: 10_000n, protocolFeeRate: 160_000n, fundFeeRate: 0n, creatorFeeRate: 0n, creatorFeeOn: 0,
  };
}

/** An outside pool ~333 SOL deep whose price is `ratio` times ours. */
function outsideMarket(snap, ratio) {
  const X = 333_000_000_000n;
  const ourPrice = Number(snap.reserve0) / Number(snap.reserve1); // lamports per BAYLA unit
  const Y = BigInt(Math.round(Number(X) / (ourPrice * ratio)));
  return { X, Y };
}

function quoterFor({ X, Y }, { solUsdc = 105, confirmShrink = 0 } = {}) {
  let calls = 0;
  const shrink = (v) => (confirmShrink && ++calls > 1 ? (v * BigInt(Math.round((1 - confirmShrink) * 1e6))) / 1_000_000n : v);
  return {
    pumpBuy: async (l) => shrink(cpmm(l, X, Y)),
    pumpSell: async (b) => shrink(cpmm(b, Y, X)),
    // SOL/USDC deep enough to be a straight line at ~0.002% cost.
    solToUsdc: async (l) => (l * BigInt(Math.round(solUsdc * 1e6 * 0.99998))) / 1_000_000_000n,
    usdcToSol: async (u) => (u * 1_000_000_000n * 99_998n) / (BigInt(Math.round(solUsdc * 1e6)) * 100_000n),
  };
}

async function probeAndFacts(q, { usdc = false } = {}) {
  const b0 = await q.pumpBuy(50_000_000n);
  const s0 = await q.pumpSell(b0);
  const probe = { pumpBuy: { a: 50_000_000, out: Number(b0) }, pumpSell: { a: Number(b0), out: Number(s0) } };
  if (usdc) {
    const u0 = await q.solToUsdc(1_000_000_000n);
    const s1 = await q.usdcToSol(u0);
    probe.solToUsdc = { a: 1_000_000_000, out: Number(u0) };
    probe.usdcToSol = { a: Number(u0), out: Number(s1) };
  }
  return { probe, facts: outsideFacts({ tokenDecimals: 6, usdcDecimals: 6, ...probe }) };
}

/** The best a correction could really make, by brute force over the exact maths. */
async function bruteBestA(snap, market, cap, cost) {
  let best = -Infinity;
  for (let i = 1; i <= 2000; i++) {
    const x = BigInt(Math.floor((cap * i) / 2000));
    const r = ownSwap(snap, SOL_MINT, x);
    const back = cpmm(r.outputAmount, market.Y, market.X);
    best = Math.max(best, Number(back) - Number(x) - cost);
  }
  return best;
}

test('two quotes fix a pool curve exactly', () => {
  const X = 333e9;
  const Y = 57.6e12;
  const f = 0.99;
  const out = (a) => (Y * a * f) / (X + a * f);
  const m = fitLeg([{ a: 5e7, out: out(5e7) }, { a: 4e8, out: out(4e8) }]);
  for (const a of [1e6, 1e8, 1e9]) assert.ok(Math.abs(legOut(m, a) / out(a) - 1) < 1e-9);
});

test('one quote, or quotes with no visible depth, give a straight line at the worse rate', () => {
  assert.deepEqual(fitLeg([{ a: 10, out: 20 }]), { k: 2, D: Infinity });
  const flat = fitLeg([{ a: 10, out: 20 }, { a: 100, out: 201 }]);
  assert.equal(flat.D, Infinity);
  assert.equal(flat.k, 2);
});

test('the outside mid price cancels the fee: it lands on the pool’s own price', async () => {
  const snap = ourSolPool();
  const m = outsideMarket(snap, 1.0);
  const { facts } = await probeAndFacts(quoterFor(m));
  const spot = (Number(m.X) / 1e9) / (Number(m.Y) / 1e6);
  assert.ok(Math.abs(facts.pumpMid / spot - 1) < 2e-4, `mid ${facts.pumpMid} vs spot ${spot}`);
  assert.ok(Math.abs(facts.pumpCost - 0.01) < 5e-4, 'one-way cost is the 1% fee');
});

test('a gap inside the two fees is left alone', async () => {
  const snap = ourSolPool();
  const q = quoterFor(outsideMarket(snap, 1.015));
  const { probe, facts } = await probeAndFacts(q);
  const r = await judgePool({ pool: SOL_POOL, snap, facts, probe, quote: q, costs: COSTS });
  assert.ok(r.gapPct > 1.2 && r.gapPct < 1.8);
  assert.ok(r.breakEvenPct > 2.0 && r.breakEvenPct < 2.1, `break-even ${r.breakEvenPct}`);
  assert.equal(r.wouldTrade, false);
  assert.equal(r.direction, null);
});

test('our pool cheap: buy here, sell on pump.fun, at close to the best size there is', async () => {
  const snap = ourSolPool();
  const market = outsideMarket(snap, 1.04);
  const q = quoterFor(market);
  const { probe, facts } = await probeAndFacts(q);
  const r = await judgePool({ pool: SOL_POOL, snap, facts, probe, quote: q, costs: COSTS });
  assert.equal(r.direction, 'buy-here-sell-outside');
  assert.equal(r.wouldTrade, true);
  assert.ok(r.sizeIn > 0 && r.sizeIn <= 0.5);
  const brute = (await bruteBestA(snap, market, 0.5e9, 15_000)) / 1e9;
  assert.ok(r.confirmedProfit >= brute * 0.98, `found ${r.confirmedProfit}, best possible ${brute}`);
  assert.deepEqual(r.legs.map((l) => l.where), ['our pool', 'pump.fun']);
  // The last leg's floor: what went in, the costs (5,000 + 10,000) and the minimum profit (50,000).
  assert.ok(Math.abs(r.lastLegMinOut - (r.sizeIn + 65_000 / 1e9)) < 1e-9);
});

test('our pool dear: buy on pump.fun, sell here, selling only the guaranteed amount', async () => {
  const snap = ourSolPool();
  const q = quoterFor(outsideMarket(snap, 0.95));
  const { probe, facts } = await probeAndFacts(q);
  const r = await judgePool({ pool: SOL_POOL, snap, facts, probe, quote: q, costs: COSTS });
  assert.equal(r.direction, 'buy-outside-sell-here');
  assert.equal(r.wouldTrade, true);
  assert.deepEqual(r.legs.map((l) => l.where), ['pump.fun', 'our pool']);
  const [pump, ours] = r.legs;
  assert.equal(ours.in, Math.floor((pump.out * 9990) / 10000), 'sells what the pump.fun leg’s 0.1% minimum guarantees');
  assert.equal(r.leftover.token, pump.out - ours.in);
});

/** The best a buy-outside correction could really make, by brute force, for the trade as built (0.1% minimum). */
async function bruteBestB(snap, market, cap, cost) {
  let best = -Infinity;
  for (let i = 1; i <= 2000; i++) {
    const x = BigInt(Math.floor((cap * i) / 2000));
    const b = cpmm(x, market.X, market.Y);
    const r = ownSwap(snap, BAYLA_MINT, (b * 9990n) / 10000n);
    if (r) best = Math.max(best, Number(r.outputAmount) - Number(x) - cost);
  }
  return best;
}

test('buying outside: the size is searched for exactly the trade that is confirmed', async () => {
  const snap = ourSolPool();
  for (const ratio of [0.97, 0.965, 0.95]) {
    const market = outsideMarket(snap, ratio);
    const q = quoterFor(market);
    const { probe, facts } = await probeAndFacts(q);
    const r = await judgePool({ pool: SOL_POOL, snap, facts, probe, quote: q, costs: COSTS });
    const brute = (await bruteBestB(snap, market, 0.5e9, 15_000)) / 1e9;
    if (brute >= 50_000 / 1e9) {
      assert.equal(r.wouldTrade, true, `ratio ${ratio}: brute force finds ${brute}`);
      assert.ok(r.confirmedProfit >= brute * 0.98, `ratio ${ratio}: found ${r.confirmedProfit}, best possible ${brute}`);
    }
    assert.ok(Math.abs(r.modelErrorPct ?? 0) < 0.05, `the curve describes the confirmed trade (off by ${r.modelErrorPct}%)`);
  }
});

test('the break-even depends on the side: buying outside costs the middle leg’s minimum too', async () => {
  const snap = ourSolPool();
  const q = quoterFor(outsideMarket(snap, 0.979)); // ours 2.1% dear: past the buy-here line, short of the buy-outside one
  const { probe, facts } = await probeAndFacts(q);
  const r = await judgePool({ pool: SOL_POOL, snap, facts, probe, quote: q, costs: COSTS });
  assert.ok(r.gapPct < -2.05 && r.gapPct > -2.13, `gap ${r.gapPct}`);
  assert.ok(r.breakEvenPct > 2.1, `the buy-outside line ${r.breakEvenPct}`);
  assert.equal(r.direction, null);
  assert.equal(r.reason, 'gap is inside the two fees');
});

test('USDC routes pass on only the middle leg’s minimum, and say what is left over', async () => {
  const sol = ourSolPool();
  const snap = {
    address: 'ours-usdc', slot: 1, mint0: BAYLA_MINT, mint1: USDC_MINT, decimals0: 6, decimals1: 6,
    reserve0: 1_053_650_407_437n, reserve1: 634_499_289n,
    tradeFeeRate: 10_000n, protocolFeeRate: 160_000n, fundFeeRate: 0n, creatorFeeRate: 0n, creatorFeeOn: 0,
  };
  const q = quoterFor(outsideMarket(sol, 1.0));
  const { probe, facts } = await probeAndFacts(q, { usdc: true });
  const r = await judgePool({ pool: USDC_POOL, snap, facts, probe, quote: q, costs: COSTS });
  const [, pump, hop] = r.legs;
  assert.equal(hop.in, Math.floor((pump.out * 9990) / 10000));
  assert.equal(r.leftover.sol, pump.out - hop.in);
});

test('a confirming quote far off the curve means the outside price moved: nothing is counted', async () => {
  const snap = ourSolPool();
  const market = outsideMarket(snap, 1.06);
  const { probe, facts } = await probeAndFacts(quoterFor(market));
  const r = await judgePool({ pool: SOL_POOL, snap, facts, probe, quote: quoterFor(market, { confirmShrink: 0.03 }), costs: COSTS });
  assert.equal(r.unsteady, true);
  assert.equal(r.wouldTrade, false);
  assert.match(r.reason, /moved while it was read/);
});

test('a big gap is closed only up to the size cap', async () => {
  const snap = ourSolPool();
  const q = quoterFor(outsideMarket(snap, 1.25));
  const { probe, facts } = await probeAndFacts(q);
  const r = await judgePool({ pool: SOL_POOL, snap, facts, probe, quote: q, costs: COSTS });
  assert.equal(r.capped, true);
  assert.equal(r.sizeIn, 0.5);
});

test('costs count: a fix that cannot clear the minimum profit is not made', async () => {
  const snap = ourSolPool();
  const q = quoterFor(outsideMarket(snap, 1.03));
  const { probe, facts } = await probeAndFacts(q);
  const r = await judgePool({ pool: SOL_POOL, snap, facts, probe, quote: q, costs: { ...COSTS, minProfit: 50_000_000n } });
  assert.equal(r.wouldTrade, false);
  assert.match(r.reason, /too small to pay after costs/);
});

test('the real quote at the planned size decides, not the fitted curve', async () => {
  const snap = ourSolPool();
  const market = outsideMarket(snap, 1.03);
  const steady = quoterFor(market);
  const { probe, facts } = await probeAndFacts(steady);
  // The outside price slips 1% between the probe and the confirming quote: inside the
  // tolerance, but more than this thin correction's margin.
  const slipping = quoterFor(market, { confirmShrink: 0.01 });
  const r = await judgePool({ pool: SOL_POOL, snap, facts, probe, quote: slipping, costs: COSTS });
  assert.equal(r.wouldTrade, false);
  assert.equal(r.unsteady, false);
  assert.match(r.reason, /real quote/);
  assert.ok(r.modelErrorPct > 0.8, `curve vs real: ${r.modelErrorPct}%`);
});

test('the USDC pool is judged in USDC, through pump.fun and then SOL to USDC', async () => {
  const sol = ourSolPool();
  // BAYLA/USDC at ~$0.000602 a BAYLA: 634.5 USDC against 1.0537M BAYLA.
  const snap = {
    address: 'ours-usdc', slot: 1, mint0: BAYLA_MINT, mint1: USDC_MINT, decimals0: 6, decimals1: 6,
    reserve0: 1_053_650_407_437n, reserve1: 634_499_289n,
    tradeFeeRate: 10_000n, protocolFeeRate: 160_000n, fundFeeRate: 0n, creatorFeeRate: 0n, creatorFeeOn: 0,
  };
  const q = quoterFor(outsideMarket(sol, 1.0)); // pump.fun at BAYLA/SOL's price, ~6.3e-4 USDC: ours is cheap
  const { probe, facts } = await probeAndFacts(q, { usdc: true });
  const r = await judgePool({ pool: USDC_POOL, snap, facts, probe, quote: q, costs: COSTS });
  assert.ok(r.gapPct > 2.5, `gap ${r.gapPct}`);
  assert.equal(r.direction, 'buy-here-sell-outside');
  assert.equal(r.wouldTrade, true);
  assert.deepEqual(r.legs.map((l) => l.where), ['our pool', 'pump.fun', 'SOL to USDC (no Raydium)']);
  assert.ok(r.sizeIn <= 20);
});
