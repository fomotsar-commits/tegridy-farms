// Is there a correction worth making, how big, and what would it make?
//
// THE TRADE. One all-or-nothing transaction that starts and ends in the pool's
// pairing coin (SOL or USDC):
//   A. our pool is CHEAP: coin -> our pool -> BAYLA -> pump.fun -> SOL (-> USDC)
//   B. our pool is DEAR:  coin (-> SOL) -> pump.fun -> BAYLA -> our pool -> coin
// Its LAST leg carries a minimum out of (money in + costs + minimum profit), so a
// trade that would not pay is cancelled by the chain itself. Every MIDDLE leg's
// output is certain only down to its minimum, so the next leg is planned on that
// minimum (CHAIN_SLIPPAGE_BPS less than the quote), never on the full quote. What a
// fill gives above it is left over: at most 0.1% of one correction's BAYLA (or SOL),
// which the live keeper sells on its next correction. It never keeps a position.
//
// HOW THE SIZE IS FOUND. Our leg uses the program's exact maths (pool.js ownSwap).
// The pump.fun leg is a constant-product curve fitted to two real Jupiter quotes in
// the direction the trade needs: a/out is a straight line in a for such a curve
// (a/out = 1/k + a/(k*D)), so two quotes fix it exactly. The best size is searched
// on that curve, for exactly the trade that would be built (minimums included),
// capped, and then CONFIRMED with real quotes at exactly those amounts. The
// confirmed number is the one that counts. A confirmation more than
// MODEL_TOLERANCE_PCT away from the curve means the outside price moved while it
// was being read, and then no correction is counted.
//
// NOTHING HERE SENDS OR SIGNS. Week 1 only says what would have happened.

import { ownMid, ownSwap } from './pool.js';
import { CHAIN_SLIPPAGE_BPS, MODEL_TOLERANCE_PCT } from './config.js';

export const SOL_DECIMALS = 9;
const GOLDEN = (Math.sqrt(5) - 1) / 2;
const KEEP = 1 - Number(CHAIN_SLIPPAGE_BPS) / 10_000;

/** What the next leg may count on from a middle leg's quoted output. */
export const keepBig = (v) => (v * (10_000n - CHAIN_SLIPPAGE_BPS)) / 10_000n;
const keepNum = (v) => Math.floor(v * KEEP);

/**
 * Fit out(a) = k*a / (1 + a/D) to quotes [{ a, out }] (base units, numbers).
 * One quote, or quotes showing no measurable impact: a straight line at the WORSE
 * of the rates seen, so depth is never assumed that a quote did not show.
 */
export function fitLeg(points) {
  const pts = points.filter((p) => p.a > 0 && p.out > 0).sort((x, y) => x.a - y.a);
  if (pts.length === 0) throw new Error('no quote to fit');
  const worst = Math.min(...pts.map((p) => p.out / p.a));
  if (pts.length === 1) return { k: worst, D: Infinity };
  const [p1, p2] = [pts[0], pts[pts.length - 1]];
  const y1 = p1.a / p1.out;
  const y2 = p2.a / p2.out;
  const s = (y2 - y1) / (p2.a - p1.a);
  if (!(s > 0)) return { k: worst, D: Infinity };
  const c = y1 - s * p1.a;
  if (!(c > 0)) throw new Error('the outside quotes do not fit a pool curve');
  return { k: 1 / c, D: c / s };
}

export function legOut(model, a) {
  if (!(a > 0)) return 0;
  return model.D === Infinity ? model.k * a : (model.k * a) / (1 + a / model.D);
}

/**
 * The outside market at probe size: BAYLA's mid price on pump.fun in SOL, and
 * (when asked) SOL's mid price in USDC, each from a buy and a sale back. Their
 * geometric mean cancels the fees; their ratio is the round trip's cost.
 */
export function outsideFacts({ tokenDecimals, pumpBuy, pumpSell, solToUsdc = null, usdcToSol = null, usdcDecimals = 6 }) {
  // pumpBuy: { a: lamports in, out: BAYLA units }; pumpSell: { a: BAYLA units, out: lamports }.
  const buyPx = (pumpBuy.a / 10 ** SOL_DECIMALS) / (pumpBuy.out / 10 ** tokenDecimals);
  const sellPx = (pumpSell.out / 10 ** SOL_DECIMALS) / (pumpSell.a / 10 ** tokenDecimals);
  const facts = {
    pumpMid: Math.sqrt(buyPx * sellPx),
    pumpCost: 1 - Math.sqrt(sellPx / buyPx),
    solUsdcMid: null,
    solUsdcCost: null,
  };
  if (solToUsdc && usdcToSol) {
    const sell = (solToUsdc.out / 10 ** usdcDecimals) / (solToUsdc.a / 10 ** SOL_DECIMALS);
    const buy = (usdcToSol.a / 10 ** usdcDecimals) / (usdcToSol.out / 10 ** SOL_DECIMALS);
    facts.solUsdcMid = Math.sqrt(sell * buy);
    facts.solUsdcCost = 1 - Math.sqrt(sell / buy);
  }
  for (const v of Object.values(facts)) {
    if (v !== null && !Number.isFinite(v)) throw new Error('the outside quotes did not give a usable price');
  }
  if (!(facts.pumpMid > 0) || facts.pumpCost < 0 || facts.pumpCost >= 0.5) throw new Error('the outside quotes did not give a usable price');
  return facts;
}

/**
 * The gap, in percent of OUR price, at which a correction starts to pay, for each
 * side. Buying here pays when outside/ours > 1/((1-f)(1-c)kA); buying outside pays
 * when outside/ours < (1-f)(1-c)kB. kA and kB are the middle-leg minimums each
 * route plans on (one per middle leg).
 */
export function breakEvens({ ourFee, outCost, coinIsSol }) {
  const middleA = coinIsSol ? 0 : 1; // A on USDC: SOL from pump.fun into the SOL->USDC step
  const middleB = coinIsSol ? 1 : 2; // B: (SOL from USDC->SOL into pump.fun, then) BAYLA into our pool
  const base = (1 - ourFee) * (1 - outCost);
  return {
    buyHere: (1 / (base * KEEP ** middleA) - 1) * 100,
    buyOutside: (1 - base * KEEP ** middleB) * 100,
  };
}

/** Maximise a concave f on [lo, hi]. Returns the best x seen. */
function goldenMax(f, lo, hi, iters = 80) {
  let a = lo;
  let b = hi;
  let c = b - GOLDEN * (b - a);
  let d = a + GOLDEN * (b - a);
  let fc = f(c);
  let fd = f(d);
  for (let i = 0; i < iters && b - a > 1; i++) {
    if (fc < fd) {
      a = c;
      c = d;
      fc = fd;
      d = a + GOLDEN * (b - a);
      fd = f(d);
    } else {
      b = d;
      d = c;
      fd = fc;
      c = b - GOLDEN * (b - a);
      fc = f(c);
    }
  }
  const cands = [lo, hi, c, d, (a + b) / 2].map((x) => Math.round(x)).filter((x) => x >= lo && x <= hi);
  let best = cands[0];
  for (const x of cands) if (f(x) > f(best)) best = x;
  return best;
}

/**
 * Judge one pool. `quote` is the outside price source:
 *   quote.pumpBuy(lamports) -> BAYLA units, quote.pumpSell(baylaUnits) -> lamports,
 *   quote.solToUsdc(lamports) -> USDC units, quote.usdcToSol(usdcUnits) -> lamports,
 * each a real Jupiter quote returning a BigInt. `probe` carries the probe quotes
 * already taken this cycle, so a quiet pool costs no extra quote.
 *
 * Returns a plain record for the log. `wouldTrade` is true only on a CONFIRMED profit.
 */
export async function judgePool({ pool, snap, facts, probe, quote, costs }) {
  const coinIsSol = pool.coinSymbol === 'SOL';
  const token = pool.token;
  const coin = pool.coin;
  const tokenIs0 = token === snap.mint0;
  const coinDecimals = tokenIs0 ? snap.decimals1 : snap.decimals0;
  const coinReserve = Number(tokenIs0 ? snap.reserve1 : snap.reserve0);

  const ours = ownMid(snap, token);
  const outside = coinIsSol ? facts.pumpMid : facts.pumpMid * facts.solUsdcMid;
  const gapPct = (outside / ours - 1) * 100;
  const ourFee = Number(snap.tradeFeeRate + snap.creatorFeeRate) / 1e6;
  const outCost = coinIsSol ? facts.pumpCost : 1 - (1 - facts.pumpCost) * (1 - facts.solUsdcCost);
  const be = breakEvens({ ourFee, outCost, coinIsSol });
  const dirA = gapPct >= 0; // outside dearer: buy here, sell outside
  const breakEvenPct = dirA ? be.buyHere : be.buyOutside;

  // Costs and the minimum profit, said in the pool's coin (lamports, or USDC units).
  const lamportsToCoin = (l) => (coinIsSol ? Number(l) : (Number(l) / 10 ** SOL_DECIMALS) * facts.solUsdcMid * 10 ** coinDecimals);
  const costCoin = lamportsToCoin(costs.baseFee + costs.tip);
  const minProfitCoin = lamportsToCoin(costs.minProfit);
  const cap = Math.floor(pool.maxIn * 10 ** coinDecimals);

  const record = {
    pool: pool.name,
    slot: snap.slot,
    ourPrice: ours,
    outsidePrice: outside,
    gapPct,
    breakEvenPct,
    direction: null,
    wouldTrade: false,
    reason: null,
  };
  if (Math.abs(gapPct) <= breakEvenPct) {
    record.reason = 'gap is inside the two fees';
    return record;
  }

  record.direction = dirA ? 'buy-here-sell-outside' : 'buy-outside-sell-here';
  // A first guess at the size that closes the gap, used only to place the second quote.
  const guess = Math.max(1, Math.min(cap, Math.floor(coinReserve * (Math.sqrt(1 + Math.abs(gapPct) / 100) - 1))));

  // Second quote, in the direction the trade needs, at the guessed size.
  const solUsdcModel = coinIsSol ? null : { sell: fitLeg([probe.solToUsdc]), buy: fitLeg([probe.usdcToSol]) };
  let pumpModel;
  if (dirA) {
    const b = ownSwap(snap, coin, BigInt(guess));
    if (!b) {
      record.reason = 'our pool would refuse the guessed size';
      return record;
    }
    const big = { a: Number(b.outputAmount), out: Number(await quote.pumpSell(b.outputAmount)) };
    pumpModel = fitLeg([probe.pumpSell, big]);
  } else {
    const solIn = coinIsSol ? guess : keepNum(legOut(solUsdcModel.buy, guess));
    const big = { a: solIn, out: Number(await quote.pumpBuy(BigInt(solIn))) };
    pumpModel = fitLeg([probe.pumpBuy, big]);
  }

  // The trade exactly as it would be built: middle legs pass on only their minimum.
  const pathOut = (x) => {
    if (dirA) {
      const r = ownSwap(snap, coin, BigInt(Math.round(x)));
      if (!r) return -Infinity;
      const sol = legOut(pumpModel, Number(r.outputAmount));
      return coinIsSol ? sol : legOut(solUsdcModel.sell, keepNum(sol));
    }
    const sol = coinIsSol ? x : keepNum(legOut(solUsdcModel.buy, x));
    const b = keepNum(legOut(pumpModel, sol));
    if (b <= 0) return -Infinity;
    const r = ownSwap(snap, token, BigInt(b));
    return r ? Number(r.outputAmount) : -Infinity;
  };
  const profit = (x) => pathOut(x) - x - costCoin;
  const best = goldenMax(profit, 1, cap);
  record.sizeIn = best / 10 ** coinDecimals;
  record.capped = best >= cap;
  record.modelProfit = profit(best) / 10 ** coinDecimals;
  if (profit(best) < minProfitCoin) {
    record.reason = 'the gap is above the fees but too small to pay after costs';
    return record;
  }

  // Confirm with real quotes at exactly the planned amounts.
  let realOut;
  let legs;
  const leftover = { token: 0, sol: 0 };
  const x = BigInt(best);
  if (dirA) {
    const r = ownSwap(snap, coin, x);
    const solBack = await quote.pumpSell(r.outputAmount);
    let solOn = solBack;
    if (!coinIsSol) {
      solOn = keepBig(solBack);
      leftover.sol = Number(solBack - solOn);
      realOut = await quote.solToUsdc(solOn);
    } else {
      realOut = solBack;
    }
    legs = [
      { where: 'our pool', in: best, out: Number(r.outputAmount), note: 'live: exact-out for this many BAYLA, so none is left over' },
      { where: 'pump.fun', in: Number(r.outputAmount), out: Number(solBack) },
      ...(coinIsSol ? [] : [{ where: 'SOL to USDC (no Raydium)', in: Number(solOn), out: Number(realOut) }]),
    ];
  } else {
    let solIn = x;
    let solOn = x;
    if (!coinIsSol) {
      solIn = await quote.usdcToSol(x);
      solOn = keepBig(solIn);
      leftover.sol = Number(solIn - solOn);
    }
    const b = await quote.pumpBuy(solOn);
    const bOn = keepBig(b);
    leftover.token = Number(b - bOn);
    const r = ownSwap(snap, token, bOn);
    if (!r) {
      record.reason = 'our pool would refuse the confirmed size';
      return record;
    }
    realOut = r.outputAmount;
    legs = [
      ...(coinIsSol ? [] : [{ where: 'USDC to SOL (no Raydium)', in: best, out: Number(solIn) }]),
      { where: 'pump.fun', in: Number(solOn), out: Number(b) },
      { where: 'our pool', in: Number(bOn), out: Number(r.outputAmount) },
    ];
  }
  const confirmed = Number(realOut) - best - costCoin;
  const model = pathOut(best);
  record.legs = legs;
  record.leftover = leftover;
  record.confirmedProfit = confirmed / 10 ** coinDecimals;
  record.modelErrorPct = model > 0 ? ((model - Number(realOut)) / Number(realOut)) * 100 : null;
  // The chain-enforced floor on the last leg: what went in, every cost, and the minimum profit.
  record.lastLegMinOut = (best + costCoin + minProfitCoin) / 10 ** coinDecimals;
  record.unsteady = record.modelErrorPct === null || Math.abs(record.modelErrorPct) > MODEL_TOLERANCE_PCT;
  if (record.unsteady) {
    record.reason = `the outside price moved while it was read (the real quote is ${record.modelErrorPct?.toFixed(2)}% off the curve)`;
    return record;
  }
  record.wouldTrade = confirmed >= minProfitCoin;
  record.reason = record.wouldTrade ? 'a correction would pay' : 'a real quote at the planned size says it would not pay';
  return record;
}
