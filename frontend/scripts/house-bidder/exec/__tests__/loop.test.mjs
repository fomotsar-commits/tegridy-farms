// @vitest-environment node
//
// The loop (BUILD-SPEC 3.5 step 8), driven tick by tick with fakes of the data layer:
//   - shadow mode replays real sales against its standing price, writes the same ledger with
//     shadow: true, and never contacts a signer;
//   - a live run halts and kills on a mint, and on a fill from an insider;
//   - after a stream gap nothing is posted until the listings are read again;
//   - STOP cancels and exits.
import { describe, it, expect } from 'vitest';
import { createLoop } from '../loop.mjs';
import { createExecutor, createShadowExecutor } from '../executor.mjs';
import { createExposure } from '../../brain/exposure.mjs';
import { createRisk } from '../../brain/risk.mjs';
import { counterpartySets } from '../../brain/monitor.mjs';
import { createLedger, readLedger } from '../ledger.mjs';
import { localOrderHash } from '../verify.mjs';
import { monthlyReport } from '../../brain/report.mjs';
import { VENUE_CONTRACTS, VENUE_FEE_SAFE } from '../../brain/constants.mjs';
import { fakeBuildTape, fakeChain, fakeClock, fakeFairValue, fakeOpenSea, fakeSigner, fakeStream, memFs, milli, snapshotOf, testAccount, testPolicy } from './fakes.mjs';

const paths = { ledger: 'K/ledger.jsonl', trades: 'K/trades.csv', status: 'K/status.json', signerOrders: 'K/signer-orders.jsonl' };
const noTimers = { setTimeout: () => 0, clearTimeout: () => {} };
const STRANGER = '0x3333333333333333333333333333333333333333';
const INSIDER = '0x5555555555555555555555555555555555555555';

/**
 * The loop wired to fakes. A restart is a second world on the same `fs`, `clock` and
 * `chainState`, given the first one's `signerFile` (what the real signer keeps in
 * signer-orders.jsonl).
 */
function world({ mode = 'shadow', withHouse = true, signerOrders = [], houseFills = [], timers = noTimers, fs = memFs(), clock = fakeClock(), chainState: cs = null, fv = null, buildTape = fakeBuildTape, insiders = null, receipts = {}, diskFree } = {}) {
  const calls = [];
  const house = testAccount(1).address.toLowerCase();
  const policy = testPolicy(withHouse ? house : null);
  const sales = { junglebay: [], gnssart: [] };
  const opensea = fakeOpenSea({ calls, sales, listings: { junglebay: [{ orderHash: `0x${'0f'.repeat(32)}`, tokenId: '1', priceWei: milli(50), maker: STRANGER, startTime: 0, endTime: 2e9, protocol: '', orderType: 0, zone: '', taker: null }], gnssart: [] } });
  // The chain as the house's own actions leave it: approvals set the allowance, fills spend it.
  const chainState = cs ?? { block: 26_500_000, weth: milli(200), allowance: 0n, counter: 7n };
  const chain = fakeChain({ calls, snapshot: () => snapshotOf(chainState), fills: houseFills, receipts });
  const stream = fakeStream({ lastMessageAt: clock.now });
  const fairValue = fakeFairValue(fv ?? (() => ({ S: milli(40), L: milli(50), F: milli(40), cheapestFillable: milli(50), floorProxy: milli(50), n: 20, sellers: 9 })));
  const ledger = createLedger({ paths, fs, now: clock.now, shadow: mode === 'shadow' });
  const exposure = createExposure();
  const risk = createRisk({ now: clock.now });
  const state = { stop: false };
  const sets = counterpartySets({ insiders: insiders ?? { wallets: [{ address: INSIDER, who: 'team' }], contracts: [] }, house, fundingWallet: policy.fundingWallet });
  const logs = [];
  const log = (l) => logs.push(l);
  const signer = mode === 'live' ? fakeSigner({ calls, policy }) : null;
  const signerFile = [];
  if (signer) {
    const sign = signer.signBid;
    signer.signBid = async (req) => {
      const a = await sign(req);
      if (a.ok) signerFile.push({ orderHash: a.orderHash, slug: req.slug, qty: req.qty, unitPriceWei: String(req.unitPriceWei), startTime: req.startTime, endTime: req.endTime, counter: a.counter, parameters: a.parameters });
      return a;
    };
    const send = signer.sendTx;
    signer.sendTx = async (kind, params) => {
      const r = await send(kind, params);
      chainState.block += 1;
      if (kind === 'approveWeth') chainState.allowance = BigInt(params.amountWei);
      if (kind === 'revokeWeth') chainState.allowance = 0n;
      return { ...r, blockNumber: chainState.block };
    };
    const kill = signer.kill;
    signer.kill = async () => {
      const r = await kill();
      chainState.allowance = 0n;
      chainState.counter += 1n;
      chainState.block += 2;
      return { ...r, txs: [{ kind: 'revokeWeth', txHash: `0x${'01'.repeat(32)}`, status: 'mined', blockNumber: chainState.block - 1 }, { kind: 'incrementCounter', txHash: `0x${'02'.repeat(32)}`, status: 'mined', blockNumber: chainState.block }] };
    };
  }
  /** A house fill as the chain watcher reports it, with the chain moved to match. */
  const fillOf = (orderHash, tokenId, unitPriceWei, seller = STRANGER) => {
    chainState.block += 1;
    chainState.allowance -= unitPriceWei;
    chainState.weth -= unitPriceWei;
    return { txHash: `0x${String(tokenId).padStart(64, 'b')}`, block: chainState.block, time: clock.sec(), orderHash, slug: 'junglebay', tokenId: String(tokenId), unitPriceWei, seller, fulfiller: seller };
  };
  const common = { house: withHouse ? house : null, policy, opensea, exposure, risk, ledger, stopRequested: () => state.stop, now: clock.now, log, diskFree };
  const executor = mode === 'live'
    ? createExecutor({ ...common, signer, getOrderHash: async (c) => localOrderHash(c) })
    : createShadowExecutor(common);
  const config = { policy, house: withHouse ? house : null, houseWallets: [house], policySha256: 'x' };
  const exits = [];
  const loop = createLoop({ mode, config, data: { opensea, stream, chain, buildTape, fairValue }, executor, exposure, risk, ledger, sets, stopRequested: () => state.stop, readSignerOrders: () => signerOrders, now: clock.now, timers, log, diskFree, onExit: (r) => exits.push(r) });
  return { clock, calls, house, policy, sales, opensea, chain, chainState, fillOf, stream, ledger, exposure, risk, state, loop, exits, logs, signer, signerFile, executor, fs, receipts, names: () => calls.map((c) => c[0]) };
}
const count = (w, name) => w.names().filter((n) => n === name).length;
const approvals = (w) => w.calls.filter((c) => c[0] === 'signer.sendTx' && c[1] === 'approveWeth').length;
const lines = (w, kind) => w.ledger.read().filter((e) => e.kind === kind);
/** An appendFileSync that throws ENOSPC once `full.on` is set: a full disk. */
function diskThatFills() {
  const fs = memFs();
  const full = { on: false };
  const append = fs.appendFileSync.bind(fs);
  fs.appendFileSync = (p, text) => {
    if (full.on) throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
    return append(p, text);
  };
  return { fs, full };
}
/** A qty-1 order the house signed an hour ago and that was filled with token 77, both before this start. */
function filledBeforeStart(clock, { qty = 1, tokenId = '77', hoursAgo = 1 } = {}) {
  const t = clock.sec() - hoursAgo * 3600;
  const A = `0x${'0a'.repeat(32)}`;
  const signerOrders = [{ orderHash: A, slug: 'junglebay', qty, unitPriceWei: milli(30).toString(), startTime: t - 60, endTime: t + 1740, counter: '7' }];
  const fill = { txHash: `0x${'1b'.repeat(32)}`, block: 26_499_000, time: t, orderHash: A, slug: 'junglebay', tokenId, unitPriceWei: milli(30), seller: STRANGER, fulfiller: STRANGER };
  return { A, t, signerOrders, fill };
}
const sale = (clock, tokenId, price, seller = STRANGER, dt = 30) => ({ txHash: `0x${String(tokenId).padStart(64, '0')}`, time: clock.sec() + dt, tokenId: String(tokenId), priceWei: price, paymentToken: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', seller, buyer: '0x7777777777777777777777777777777777777777', orderHash: null });

describe('shadow mode', () => {
  it('plans and records a bid, never contacting a signer', async () => {
    const w = world();
    await w.loop.start();
    const post = w.ledger.read().find((e) => e.kind === 'post');
    expect(post).toMatchObject({ shadow: true, slug: 'junglebay', unitPriceWei: milli(35.2).toString(), qty: 2 });
    expect(w.names().some((n) => n.startsWith('signer.'))).toBe(false);
    expect(w.ledger.read().every((e) => e.shadow === true)).toBe(true);
  });

  it('replays sales at or below its standing price as fills, and none above it or from the house', async () => {
    const w = world();
    await w.loop.start();
    w.sales.junglebay.push(sale(w.clock, 11, milli(30)), sale(w.clock, 12, milli(50)), sale(w.clock, 13, milli(20), w.house));
    w.stream.emit('sold', { slug: 'junglebay' });
    w.clock.advance(60_000);
    await w.loop.tick();
    const fills = w.ledger.read().filter((e) => e.kind === 'fill');
    expect(fills.map((f) => [f.tokenId, f.unitPriceWei, f.simulated])).toEqual([['11', milli(35.2).toString(), true]]);
    expect(w.loop.status().collections.junglebay.held).toBe(1);
    // holding one more adds 5 points of edge: the bid is re-priced to 0.040 x 0.83, for the
    // room left under the cap: 3, less 1 held, less the cancelled bid's unfilled unit, which the
    // signer counts until that bid ends (shadow mode plans as the live bot must)
    const cancel = w.ledger.read().find((e) => e.kind === 'cancel');
    expect(cancel.reason).toBe('fair-value-moved');
    const posts = w.ledger.read().filter((e) => e.kind === 'post');
    expect(posts.map((p) => [p.unitPriceWei, p.qty])).toEqual([
      [milli(35.2).toString(), 2],
      [milli(33.2).toString(), 1],
    ]);
  });

  it('runs before the house key exists (no build call without a house)', async () => {
    const w = world({ withHouse: false });
    await w.loop.start();
    expect(w.ledger.read().some((e) => e.kind === 'post')).toBe(true);
    expect(w.names()).not.toContain('opensea.build');
  });

  it('halts in shadow too when an insider sells into the standing price', async () => {
    const w = world();
    await w.loop.start();
    w.sales.junglebay.push(sale(w.clock, 21, milli(30), INSIDER));
    w.stream.emit('sold', { slug: 'junglebay' });
    w.clock.advance(60_000);
    await w.loop.tick();
    expect(w.risk.halted().reason).toBe('insider-fill');
    expect(w.loop.status().gate.canPost).toBe(false);
  });
});

describe('waking the loop', () => {
  /** Timers that record what was asked of them and never fire. */
  function recordingTimers() {
    let id = 0;
    const live = new Map();
    return {
      live,
      setTimeout: (_fn, ms) => (live.set(++id, ms), id),
      clearTimeout: (t) => live.delete(t),
      pending: () => [...live.values()],
    };
  }

  it('wakes within 2 s for a fill, and a market event never pushes that back', async () => {
    const timers = recordingTimers();
    const w = world({ mode: 'live', timers });
    await w.loop.start();
    expect(timers.pending()).toEqual([60_000]); // the regular tick
    w.clock.advance(5_000);
    w.chain.handlers.onFill(w.fillOf(`0x${'cc'.repeat(32)}`, 9, milli(1)));
    expect(timers.pending()).toEqual([0]); // 5 s since the last tick: at once
    w.stream.emit('listed', { slug: 'junglebay' }); // would wait until 15 s: the earlier wake stands
    expect(timers.pending()).toEqual([0]);
  });

  it('waits at least 15 s between ticks for market events, and never wakes for a stream gap', async () => {
    const timers = recordingTimers();
    const w = world({ mode: 'live', timers });
    await w.loop.start();
    w.stream.emit('gap', {});
    expect(timers.pending()).toEqual([60_000]);
    w.clock.advance(1_000);
    w.stream.emit('listed', { slug: 'junglebay' });
    expect(timers.pending()).toEqual([14_000]);
  });
});

describe('live loop', () => {
  it('posts through the signer once the listings have been read', async () => {
    const w = world({ mode: 'live' });
    await w.loop.start();
    expect(w.names()).toContain('signer.signBid');
    expect(w.names()).toContain('opensea.post');
    expect(w.ledger.read().find((e) => e.kind === 'post').shadow).toBeUndefined();
  });

  it('does not cancel a standing bid for taking up its own room', async () => {
    const w = world({ mode: 'live' });
    await w.loop.start();
    const first = w.ledger.read().find((e) => e.kind === 'post');
    w.chain.handlers.onFill(w.fillOf(first.orderHash, 42, BigInt(first.unitPriceWei)));
    w.clock.advance(60_000);
    // held 1: re-priced to 0.0332, for 1 unit (3, less 1 held, less the old bid's unfilled unit,
    // which the signer counts against the cap until that bid ends)
    await w.loop.tick();
    w.clock.advance(60_000);
    await w.loop.tick(); // the new bid holds the 1 unit of room it is judged for: it stands
    const cancels = w.ledger.read().filter((e) => e.kind === 'cancel').map((e) => e.reason);
    expect(cancels).toEqual(['fair-value-moved']);
    expect(w.exposure.active('junglebay', w.clock.sec())).toHaveLength(1);
    expect(w.loop.status().collections.junglebay.standing).toMatchObject({ unitPriceWei: milli(33.2), qty: 1 });
  });

  it('counts a chain fill the ledger lost toward the day’s caps and holdings', async () => {
    const clock = fakeClock();
    const orderHash = `0x${'0a'.repeat(32)}`;
    const t = clock.sec() - 3600;
    const signerOrders = [{ orderHash, slug: 'junglebay', qty: 2, unitPriceWei: milli(35).toString(), startTime: t - 60, endTime: t + 1740, counter: '7' }];
    const houseFills = [{ txHash: `0x${'1b'.repeat(32)}`, block: 26_499_000, time: t, orderHash, slug: 'junglebay', tokenId: '77', unitPriceWei: milli(35), seller: STRANGER, fulfiller: STRANGER }];
    const w = world({ mode: 'live', signerOrders, houseFills });
    await w.loop.start();
    expect(w.risk.halted()).toBe(null);
    expect(w.ledger.read().filter((e) => e.kind === 'fill').map((e) => [e.tokenId, e.reseeded])).toEqual([['77', true]]);
    expect(w.loop.status().today.units).toBe(1);
    expect(w.loop.status().collections.junglebay.held).toBe(1);
    expect(w.ledger.read().find((e) => e.kind === 'fill-check')).toMatchObject({ tokenId: '77', verdict: 'ok' });
  });

  it('checks holdings on the chain: an NFT that left the house halts it, one returned to the funding wallet does not', async () => {
    const clock = fakeClock();
    const orderHash = `0x${'0a'.repeat(32)}`;
    const t = clock.sec() - 3600;
    const signerOrders = [{ orderHash, slug: 'junglebay', qty: 2, unitPriceWei: milli(35).toString(), startTime: t - 60, endTime: t + 1740, counter: '7' }];
    const houseFills = [
      { txHash: `0x${'1b'.repeat(32)}`, block: 26_499_000, time: t, orderHash, slug: 'junglebay', tokenId: '77', unitPriceWei: milli(35), seller: STRANGER, fulfiller: STRANGER },
      { txHash: `0x${'1c'.repeat(32)}`, block: 26_499_001, time: t, orderHash, slug: 'junglebay', tokenId: '78', unitPriceWei: milli(35), seller: STRANGER, fulfiller: STRANGER },
    ];
    const w = world({ mode: 'live', signerOrders, houseFills });
    const house = w.house;
    const away = (tokenId, to) => [
      { from: STRANGER, to: house, txHash: `0x${'1b'.repeat(32)}`, time: t },
      { from: house, to, txHash: `0x${String(tokenId).padStart(64, '9')}`, time: t + 60 },
    ];
    w.chain.tokenProvenance = async (_slug, tokenId) => (tokenId === '77' ? away(77, w.policy.fundingWallet) : [{ from: STRANGER, to: house, txHash: '0x', time: t }]);
    await w.loop.start();
    expect(w.risk.halted()).toBe(null);
    expect(w.loop.status().collections.junglebay.held).toBe(1); // 77 went home to the funding wallet
    expect(w.ledger.read().some((e) => e.kind === 'nft-returned' && e.tokenId === '77')).toBe(true);
    // an hour later, 78 has gone somewhere else
    w.chain.tokenProvenance = async (_slug, tokenId) => (tokenId === '78' ? away(78, STRANGER) : []);
    w.clock.advance(61 * 60_000);
    await w.loop.tick();
    expect(w.risk.halted().reason).toBe('ledger-mismatch');
    expect(w.loop.status().collections.junglebay.held).toBe(1); // still counted: less room, never more
  });

  it('screens a fill made while the bot was down: an insider seller halts it before anything is posted', async () => {
    const clock = fakeClock();
    const orderHash = `0x${'0a'.repeat(32)}`;
    const t = clock.sec() - 3600;
    const signerOrders = [{ orderHash, slug: 'junglebay', qty: 1, unitPriceWei: milli(35).toString(), startTime: t - 60, endTime: t + 1740, counter: '7' }];
    const houseFills = [{ txHash: `0x${'1b'.repeat(32)}`, block: 26_499_000, time: t, orderHash, slug: 'junglebay', tokenId: '78', unitPriceWei: milli(35), seller: INSIDER, fulfiller: INSIDER }];
    const w = world({ mode: 'live', signerOrders, houseFills });
    await w.loop.start();
    expect(w.risk.halted().reason).toBe('insider-fill');
    expect(w.names()).not.toContain('signer.signBid');
  });

  it('closes the gate at once on a mint and kills on chain', async () => {
    const w = world({ mode: 'live' });
    await w.loop.start();
    w.chain.handlers.onMint({ slug: 'junglebay', tokenId: '5556', to: STRANGER, txHash: `0x${'aa'.repeat(32)}` });
    expect(w.risk.gate().canPost).toBe(false); // before any tick
    await w.loop.tick();
    expect(w.risk.halted().reason).toBe('mint');
    expect(w.names()).toContain('signer.kill');
    expect(w.ledger.read().some((e) => e.kind === 'breaker' && e.reason === 'mint')).toBe(true);
  });

  it('halts on an admin change seen between two chain snapshots (JBAC maxSupply raised)', async () => {
    const w = world({ mode: 'live' });
    await w.loop.start();
    expect(w.risk.halted()).toBe(null);
    w.chainState.jbac = { maxSupply: 6000n };
    w.chainState.block += 1;
    w.clock.advance(60_000);
    await w.loop.tick();
    expect(w.risk.halted().reason).toBe('jbac-max-supply');
    expect(w.names()).toContain('signer.kill');
  });

  it('halts on an admin change that happened while the bot was stopped', async () => {
    const first = world({ mode: 'live' });
    await first.loop.start();
    // the record the first run left, read by a second run after GNSS's owner changed
    const lines = first.ledger.read();
    const w = world({ mode: 'live' });
    for (const e of lines.filter((x) => x.kind === 'chain')) w.ledger.append('chain', { block: e.block, jbac: e.jbac, gnss: e.gnss });
    w.chainState.gnss = { owner: '0x4444444444444444444444444444444444444444' };
    await w.loop.start();
    expect(w.risk.halted().reason).toBe('gnss-owner');
  });

  it('halts and kills on a fill from an insider', async () => {
    const w = world({ mode: 'live' });
    await w.loop.start();
    const post = w.ledger.read().find((e) => e.kind === 'post');
    w.chain.handlers.onFill(w.fillOf(post.orderHash, 42, BigInt(post.unitPriceWei), INSIDER));
    await w.loop.tick();
    expect(w.risk.halted().reason).toBe('insider-fill');
    expect(w.names()).toContain('signer.kill');
  });

  it('records a burn reported by the chain watcher without halting, and halts on a supply that grew', async () => {
    const w = world({ mode: 'live' });
    await w.loop.start();
    w.chain.handlers.onAdmin({ field: 'jbac.totalSupply', before: 5555n, after: 5554n, block: 1 });
    expect(w.risk.halted()).toBe(null);
    expect(w.ledger.read().some((e) => e.kind === 'chain-note')).toBe(true);
    w.chain.handlers.onAdmin({ field: 'jbac.totalSupply', before: 5554n, after: 5555n, block: 2 });
    expect(w.risk.halted().reason).toBe('mint');
  });

  it('halts on a fill the chain watcher could not read as one known NFT for WETH', async () => {
    const w = world({ mode: 'live' });
    await w.loop.start();
    const post = w.ledger.read().find((e) => e.kind === 'post');
    w.chain.handlers.onFill({ ...w.fillOf(post.orderHash, 50, BigInt(post.unitPriceWei)), anomaly: 'not-one-known-nft' });
    await w.loop.tick();
    expect(w.risk.halted().reason).toBe('ledger-mismatch');
    expect(w.risk.halted().detail).toMatch(/not-one-known-nft/);
  });

  it('counts a fill whose price could not be decoded at the bid price, for the caps', async () => {
    const w = world({ mode: 'live' });
    await w.loop.start();
    const post = w.ledger.read().find((e) => e.kind === 'post');
    w.chain.handlers.onFill({ ...w.fillOf(post.orderHash, 51, BigInt(post.unitPriceWei)), unitPriceWei: null });
    await w.loop.tick();
    expect(w.loop.status().today).toMatchObject({ units: 1, wethSpent: BigInt(post.unitPriceWei) });
    expect(w.ledger.read().some((e) => e.kind === 'review' && /could not be decoded/.test(e.why))).toBe(true);
  });

  it('halts on a fill of an order the house never signed', async () => {
    const w = world({ mode: 'live' });
    await w.loop.start();
    w.chain.handlers.onFill(w.fillOf(`0x${'ee'.repeat(32)}`, 42, milli(35)));
    await w.loop.tick();
    expect(w.risk.halted().reason).toBe('ledger-mismatch');
  });

  it('halts when WETH leaves the house by a path the bot does not know, after re-reading the fills', async () => {
    const w = world({ mode: 'live' });
    await w.loop.start();
    w.clock.advance(60_000);
    await w.loop.tick();
    expect(w.risk.halted()).toBe(null);
    w.chainState.block += 1;
    w.chainState.weth -= milli(100); // not a fill, not the house's own transaction
    w.clock.advance(60_000);
    await w.loop.tick();
    expect(w.names()).toContain('chain.houseFills'); // looked again before halting
    expect(w.risk.halted().reason).toBe('ledger-mismatch');
    expect(w.risk.halted().detail).toMatch(/weth/);
  });

  it('halts on a counter bump the bot did not send, and not on its own kill', async () => {
    const own = world({ mode: 'live' });
    await own.loop.start();
    own.chain.handlers.onMint({ slug: 'junglebay', tokenId: '1', to: STRANGER, txHash: `0x${'aa'.repeat(32)}` });
    await own.loop.tick(); // the mint halts and kills: the counter moves by the bot's own hand
    own.clock.advance(60_000);
    await own.loop.tick();
    expect(own.ledger.read().filter((e) => e.kind === 'breaker' || e.kind === 'breaker-extra').map((e) => e.reason)).toEqual(['mint']);

    const other = world({ mode: 'live' });
    await other.loop.start();
    other.chainState.counter += 1n; // someone else with the key
    other.chainState.block += 1;
    other.clock.advance(60_000);
    await other.loop.tick();
    expect(other.risk.halted().reason).toBe('ledger-mismatch');
    expect(other.risk.halted().detail).toMatch(/counter/);
  });

  it('posts nothing after a stream gap until the listings are read again', async () => {
    const w = world({ mode: 'live' });
    w.opensea.bestListings = async () => {
      throw new Error('rest down');
    };
    await w.loop.start(); // the start-up gap is never lifted: no REST read succeeds
    expect(w.names()).not.toContain('signer.signBid');
    expect(w.loop.status().dataGap).toBe(true);
  });

  it('posts nothing when the listings were read but whether they can be filled was not', async () => {
    const w = world({ mode: 'live' });
    w.chain.listingFillable = async () => {
      throw new Error('multicall failed');
    };
    await w.loop.start();
    expect(w.names()).not.toContain('signer.signBid');
    expect(w.loop.status().dataGap).toBe(true);
  });

  it('does not re-post on the last good numbers when this tick’s market read failed', async () => {
    const w = world({ mode: 'live' });
    await w.loop.start(); // a good read: one bid posted
    expect(w.names().filter((n) => n === 'signer.signBid')).toHaveLength(1);
    w.clock.advance(31 * 60_000); // that bid has ended
    w.opensea.bestListings = async () => {
      throw new Error('429');
    };
    await w.loop.tick();
    expect(w.names().filter((n) => n === 'signer.signBid')).toHaveLength(1);
    expect(w.loop.status().collections.junglebay.F).toBe(null);
  });

  it('on STOP cancels, exits, and does not post again', async () => {
    const w = world({ mode: 'live' });
    await w.loop.start();
    w.state.stop = true;
    await w.loop.tick();
    expect(w.exits).toHaveLength(1);
    expect(w.names()).toContain('signer.signCancel');
    expect(w.ledger.read().some((e) => e.kind === 'cancel' && e.reason === 'stop')).toBe(true);
  });
});

describe('a restart counts each fill once', () => {
  it('a fill counted before the restart is not counted again when the books re-read the chain', async () => {
    const clock = fakeClock();
    const { signerOrders, fill } = filledBeforeStart(clock);
    const houseFills = [fill];
    const w = world({ mode: 'live', signerOrders, houseFills, clock });
    await w.loop.start();
    const post = lines(w, 'post')[0];
    // A fill of the new bid lands in a block the next snapshot reads before the chain watcher
    // reports it: the books do not match, so they re-read every house fill of the last 30 days.
    w.clock.advance(30_000);
    houseFills.push(w.fillOf(post.orderHash, 88, BigInt(post.unitPriceWei)));
    w.clock.advance(30_000);
    await w.loop.tick();
    expect(lines(w, 'fill').map((e) => e.tokenId).sort()).toEqual(['77', '88']);
    expect(w.risk.halted()).toBe(null);
    expect(w.names()).not.toContain('signer.kill');
    expect(w.loop.status().collections.junglebay.held).toBe(2);
    expect(String(w.fs.store.get('K/trades.csv')).split('\n').filter((r) => r.includes(',77,'))).toHaveLength(1);
  });

  it('a fill the chain watcher hands over again after a restart is not counted twice', async () => {
    const clock = fakeClock();
    const { signerOrders, fill } = filledBeforeStart(clock);
    const w = world({ mode: 'live', signerOrders, houseFills: [fill], clock });
    await w.loop.start();
    // the watcher's first pass covers the block the fill was in
    w.chain.handlers.onFill(fill);
    w.clock.advance(60_000);
    await w.loop.tick();
    expect(lines(w, 'fill').filter((e) => e.tokenId === '77')).toHaveLength(1);
    expect(w.risk.halted()).toBe(null);
  });
});

describe('a full disk', () => {
  it('cannot stop a halt: the cancel and the kill still reach the signer', async () => {
    const { fs, full } = diskThatFills();
    const w = world({ mode: 'live', fs });
    await w.loop.start();
    const B = lines(w, 'post')[0];
    full.on = true;
    w.chain.handlers.onMint({ slug: 'junglebay', tokenId: '5556', to: STRANGER, txHash: `0x${'aa'.repeat(32)}` });
    await w.loop.tick();
    expect(count(w, 'signer.signCancel')).toBe(1);
    expect(count(w, 'signer.kill')).toBe(1);
    expect(w.exposure.isLive(w.exposure.get(B.orderHash), w.clock.sec())).toBe(false);
    // what could not be written goes to the console instead
    expect(w.logs.some((l) => /not written/.test(l) && /ENOSPC/.test(l))).toBe(true);
  });

  it('cannot make a tick throw: what could not be written is said on the console, and STOP still works after', async () => {
    const { fs, full } = diskThatFills();
    const w = world({ mode: 'live', fs });
    await w.loop.start();
    const B = lines(w, 'post')[0];
    full.on = true;
    // a fill arrives: its own ledger line cannot be written, which ends this tick early
    w.chain.handlers.onFill(w.fillOf(B.orderHash, 42, BigInt(B.unitPriceWei)));
    await expect(w.loop.tick()).resolves.toBeUndefined();
    expect(w.logs.some((l) => /ledger line "error" not written/.test(l))).toBe(true);
    w.state.stop = true;
    await w.loop.tick();
    expect(w.exits).toHaveLength(1);
    expect(count(w, 'signer.signCancel')).toBe(1);
  });

  it('cannot stop a market breaker’s cancels', async () => {
    const { fs, full } = diskThatFills();
    let floor = milli(50);
    const w = world({ mode: 'live', fs, fv: () => ({ S: milli(40), L: milli(50), F: milli(40), cheapestFillable: milli(50), floorProxy: floor, n: 20, sellers: 9 }) });
    await w.loop.start();
    const B = lines(w, 'post')[0];
    full.on = true;
    floor = milli(35); // 30% down within the hour
    w.clock.advance(10 * 60_000);
    await w.loop.tick();
    expect(w.risk.paused()?.reason).toBe('floor-drop-1h');
    expect(count(w, 'signer.signCancel')).toBe(1);
    expect(w.exposure.isLive(w.exposure.get(B.orderHash), w.clock.sec())).toBe(false);
  });

  it('cannot stop STOP: every bid is cancelled and the bot exits', async () => {
    const { fs, full } = diskThatFills();
    const w = world({ mode: 'live', fs });
    await w.loop.start();
    const B = lines(w, 'post')[0];
    full.on = true;
    w.state.stop = true;
    await w.loop.tick();
    expect(count(w, 'signer.signCancel')).toBe(1);
    expect(w.exposure.isLive(w.exposure.get(B.orderHash), w.clock.sec())).toBe(false);
    expect(w.exits).toHaveLength(1);
  });

  it('is refused at start, and stops new bids, under 1 GB free on the keys folder’s drive', async () => {
    let free = 0.5e9;
    const low = world({ mode: 'live', diskFree: () => free });
    await expect(low.loop.start()).rejects.toThrow(/1 GB/);
    expect(low.names()).not.toContain('signer.signBid');
    free = 5e9;
    const w = world({ mode: 'live', diskFree: () => free });
    await w.loop.start();
    expect(count(w, 'signer.signBid')).toBe(1);
    free = 0.9e9;
    w.clock.advance(31 * 60_000); // the first bid has ended
    await w.loop.tick();
    expect(count(w, 'signer.signBid')).toBe(1);
    expect(lines(w, 'decision').some((e) => e.why === 'disk-low' && /GB/.test(e.detail))).toBe(true);
  });
});

describe('a chain snapshot that cannot be read', () => {
  it('decides and approves nothing on it, pauses after 3 minutes, and resumes on a good read', async () => {
    let F = milli(40);
    const w = world({ mode: 'live', fv: () => ({ S: F, L: milli(50), F, cheapestFillable: milli(50), floorProxy: milli(50), n: 20, sellers: 9 }) });
    await w.loop.start();
    const B = lines(w, 'post')[0];
    const a0 = approvals(w);
    const good = w.chain.snapshot;
    w.chain.snapshot = async () => {
      throw Object.assign(new Error('chain snapshot failed: header not found'), { kind: 'rpc' });
    };
    F = milli(45); // a move a good tick would re-price for
    for (let i = 0; i < 4; i++) {
      w.clock.advance(60_000);
      await w.loop.tick();
    }
    // nothing decided on the stale snapshot: no re-price, nothing approved, nothing new signed
    expect(lines(w, 'cancel').filter((e) => e.reason === 'fair-value-moved')).toHaveLength(0);
    expect(approvals(w)).toBe(a0);
    expect(count(w, 'signer.signBid')).toBe(1);
    expect(w.risk.gate()).toMatchObject({ canPost: false, reason: expect.stringMatching(/chain-stale/) });
    expect(lines(w, 'breaker').some((e) => e.breaker === 'market' && e.reason === 'chain-stale')).toBe(true);
    // the market breaker cancels: the standing bid goes
    expect(w.exposure.isLive(w.exposure.get(B.orderHash), w.clock.sec())).toBe(false);
    w.chain.snapshot = good;
    w.clock.advance(60_000);
    await w.loop.tick();
    expect(lines(w, 'resume').some((e) => e.reason === 'chain-stale')).toBe(true);
    expect(count(w, 'signer.signBid')).toBe(2);
  });
});

describe('cancels that fail', () => {
  it('are asked again every tick, and no second bid goes up beside one above the arbitrage line', async () => {
    let cheapest = milli(50);
    const w = world({ mode: 'live', fv: () => ({ S: milli(40), L: milli(50), F: milli(40), cheapestFillable: cheapest, floorProxy: milli(50), n: 20, sellers: 9 }) });
    await w.loop.start();
    const B = lines(w, 'post')[0];
    // a cheap fillable listing appears: B (0.0352) is above the line 0.030 x 0.99 - 0.001 = 0.0287
    cheapest = milli(30);
    let down = true;
    const signCancel = w.signer.signCancel;
    w.signer.signCancel = async (h) => {
      w.calls.push(['signer.signCancel.asked', h]);
      if (down) throw Object.assign(new Error('the connection to the signer closed'), { code: 'closed' });
      return signCancel(h);
    };
    w.clock.advance(60_000);
    await w.loop.tick();
    expect(lines(w, 'post')).toHaveLength(1);
    down = false; // the pipe is back
    w.clock.advance(60_000);
    await w.loop.tick();
    expect(w.calls.filter((c) => c[0] === 'signer.signCancel.asked' && c[1] === B.orderHash)).toHaveLength(2);
    expect(w.exposure.isLive(w.exposure.get(B.orderHash), w.clock.sec())).toBe(false);
    const posts = lines(w, 'post');
    expect(posts).toHaveLength(2);
    expect(BigInt(posts[1].unitPriceWei) <= milli(28.7)).toBe(true);
  });
});

describe('STOP when the kill cannot be sent', () => {
  it('says the kill was NOT sent, names the bid still live, and exits as failed', async () => {
    const w = world({ mode: 'live' });
    await w.loop.start();
    const B = lines(w, 'post')[0];
    const down = async () => {
      throw Object.assign(new Error('the connection to the signer closed'), { code: 'closed' });
    };
    w.signer.signCancel = down;
    w.signer.kill = down;
    w.state.stop = true;
    await w.loop.tick();
    expect(w.logs.some((l) => /every bid cancelled/.test(l))).toBe(false);
    expect(w.logs.some((l) => /KILL WAS NOT SENT/.test(l) && l.includes(B.orderHash))).toBe(true);
    expect(w.exits).toHaveLength(1);
    expect(w.exits[0]).toMatchObject({ clean: false, live: [B.orderHash] });
  });

  /** A live world whose halt's cancel leaves a 4-minute tail, and whose kill writes STOP first, as the signer's does. */
  function killWritesStop({ mined = null } = {}) {
    const w = world({ mode: 'live' });
    w.opensea.cancelOffer = async ({ orderHash }) => (w.calls.push(['opensea.cancel', orderHash]), { ok: true, lastSignatureValidUntil: w.clock.sec() + 240 });
    const kill = w.signer.kill;
    w.signer.kill = async () => {
      w.state.stop = true; // STOP goes into the keys folder before anything is sent
      if (mined) await mined; // ...and the kill then waits for its transactions to be mined
      return kill();
    };
    return w;
  }
  const mint = (w) => w.chain.handlers.onMint({ slug: 'junglebay', tokenId: '5556', to: STRANGER, txHash: `0x${'aa'.repeat(32)}` });

  it('does not kill a second time on the STOP its own kill wrote', async () => {
    const w = killWritesStop();
    await w.loop.start();
    mint(w);
    await w.loop.state.pendingHalts[0]; // the halt finishes between two ticks
    expect(count(w, 'signer.kill')).toBe(1);
    w.clock.advance(2_000);
    await w.loop.tick(); // sees that STOP; the books still show the cancelled bid's open tail
    expect(count(w, 'signer.kill')).toBe(1);
    expect(w.exits).toHaveLength(1);
    expect(w.exits[0].clean).toBe(true);
  });

  it('does not start a second kill while its own is still being mined', async () => {
    let mine;
    const w = killWritesStop({ mined: new Promise((ok) => (mine = ok)) });
    await w.loop.start();
    mint(w);
    w.clock.advance(2_000);
    const next = w.loop.tick(); // the next tick comes while the kill waits for its blocks
    await new Promise((ok) => setTimeout(ok, 10));
    mine();
    await next;
    expect(count(w, 'signer.kill')).toBe(1);
    expect(w.exits).toHaveLength(1);
    expect(w.exits[0].clean).toBe(true);
  });
});

describe('NFTs returned to the funding wallet', () => {
  const BUYER = '0x8888888888888888888888888888888888888888';

  it('a restart does not count one the house sent back, even after the owner sold it on', async () => {
    const clock = fakeClock();
    const { signerOrders, fill, t } = filledBeforeStart(clock, { hoursAgo: 6 });
    const w = world({ mode: 'live', signerOrders, houseFills: [fill], clock });
    const funding = w.policy.fundingWallet;
    // the last run's record: it saw the fill, and an hour later the return
    w.ledger.append('fill', { ...fill });
    w.ledger.append('nft-returned', { slug: 'junglebay', tokenId: '77', to: funding, txHash: `0x${'2c'.repeat(32)}` });
    w.chain.tokenProvenance = async (_slug, tokenId) =>
      tokenId === '77'
        ? [
            { from: STRANGER, to: w.house, txHash: fill.txHash, time: t },
            { from: w.house, to: funding, txHash: `0x${'2c'.repeat(32)}`, time: t + 3600 },
            { from: funding, to: BUYER, txHash: `0x${'3d'.repeat(32)}`, time: t + 7200 },
          ]
        : [];
    await w.loop.start();
    expect(w.risk.halted()).toBe(null);
    expect(w.loop.status().collections.junglebay.held).toBe(0);
    expect(w.names()).not.toContain('signer.kill');
    // it was never counted as held again, so no second record of the same return
    expect(lines(w, 'nft-returned')).toHaveLength(1);
  });

  it('one sent back and sold on before the hourly check is an exit, not a halt', async () => {
    const clock = fakeClock();
    const { signerOrders, fill, t } = filledBeforeStart(clock);
    const w = world({ mode: 'live', signerOrders, houseFills: [fill], clock });
    const funding = w.policy.fundingWallet;
    const bought = { from: STRANGER, to: w.house, txHash: fill.txHash, time: t };
    w.chain.tokenProvenance = async (_slug, tokenId) => (tokenId === '77' ? [bought] : []);
    await w.loop.start();
    expect(w.loop.status().collections.junglebay.held).toBe(1);
    w.chain.tokenProvenance = async (_slug, tokenId) =>
      tokenId === '77'
        ? [bought, { from: w.house, to: funding, txHash: `0x${'2c'.repeat(32)}`, time: t + 1800 }, { from: funding, to: BUYER, txHash: `0x${'3d'.repeat(32)}`, time: t + 3000 }]
        : [];
    w.clock.advance(61 * 60_000);
    await w.loop.tick();
    expect(w.risk.halted()).toBe(null);
    expect(w.loop.status().collections.junglebay.held).toBe(0);
    expect(lines(w, 'nft-returned')).toMatchObject([{ tokenId: '77', txHash: `0x${'2c'.repeat(32)}` }]);
  });
});

describe('an approval mined late', () => {
  it('is accepted from its receipt instead of halting the bot', async () => {
    const w = world({ mode: 'live' });
    const send = w.signer.sendTx;
    const stuck = `0x${'5e'.repeat(32)}`;
    let landed = null;
    w.signer.sendTx = async (kind, params) => {
      if (kind === 'approveWeth' && landed === null) {
        // broadcast, but not mined inside the signer's 3-minute window
        w.calls.push(['signer.sendTx', kind, params]);
        landed = BigInt(params.amountWei);
        return { ok: true, id: '1', txHash: stuck, status: 'pending', nonce: 0 };
      }
      return send(kind, params);
    };
    await w.loop.start();
    expect(lines(w, 'decision').some((e) => e.why === 'approval-pending')).toBe(true);
    // it is mined a few blocks later
    w.chainState.block += 3;
    w.chainState.allowance = landed;
    w.receipts[stuck] = { blockNumber: w.chainState.block, success: true };
    w.clock.advance(60_000);
    await w.loop.tick();
    expect(w.risk.halted()).toBe(null);
    expect(w.names()).not.toContain('signer.kill');
    expect(w.executor.books.lastApproval).toEqual({ amountWei: landed, block: w.chainState.block });
  });
});

describe('fair value across a restart', () => {
  it('keeps the 5%-an-hour rise cap: the first fair value after a restart is given the last F the ledger marked', async () => {
    const seen = [];
    let Fraw = milli(30);
    const fv = (args) => {
      seen.push(args.prev ?? null);
      return { S: Fraw, L: milli(60), F: Fraw, cheapestFillable: milli(60), floorProxy: milli(60), n: 20, sellers: 9, state: { version: 1, F: Fraw.toString(), atSec: Math.floor(args.now / 1000) } };
    };
    const fs = memFs();
    const clock = fakeClock();
    const first = world({ mode: 'live', fs, clock, fv });
    await first.loop.start();
    first.loop.stop();
    const mark = lines(first, 'mark').at(-1);
    seen.length = 0;
    Fraw = milli(40);
    clock.advance(60_000);
    const w = world({ mode: 'live', fs, clock, fv, chainState: first.chainState, signerOrders: first.signerFile });
    await w.loop.start();
    expect(seen[0]).toEqual({ version: 1, F: milli(30).toString(), atSec: Math.floor(mark.at / 1000) });
  });
});

describe('the sales tape', () => {
  it('leaves out trades by the venue’s contracts and by insiders.json’s contracts, not only by its people', async () => {
    const SAFE = '0x9999999999999999999999999999999999999999';
    const given = [];
    const buildTape = (sales, opts) => (given.push(opts.insiderWallets), { kept: sales, dropped: [] });
    const w = world({ mode: 'live', buildTape, insiders: { wallets: [{ address: INSIDER, who: 'team' }], contracts: [SAFE] } });
    await w.loop.start();
    expect(given[0]).toEqual(expect.arrayContaining([INSIDER, SAFE, VENUE_FEE_SAFE, ...VENUE_CONTRACTS]));
  });
});

describe('fill checks that cannot be finished', () => {
  const failChecks = (w) => {
    w.chain.tokenProvenance = async () => {
      throw new Error('eth_getLogs: query returned more than 10000 results');
    };
    w.opensea.item = async () => {
      throw Object.assign(new Error('OpenSea answered 500'), { kind: 'http', status: 500 });
    };
  };

  it('keep new bids closed until a person acknowledges with --ack-halt', async () => {
    const fs = memFs();
    const clock = fakeClock();
    const w = world({ mode: 'live', fs, clock });
    await w.loop.start();
    const B = lines(w, 'post')[0];
    failChecks(w);
    w.chain.handlers.onFill(w.fillOf(B.orderHash, 42, BigInt(B.unitPriceWei)));
    for (let i = 0; i < 40; i++) {
      w.clock.advance(60_000);
      await w.loop.tick();
    }
    expect(count(w, 'signer.signBid')).toBe(1);
    expect(w.risk.gate().reason).toMatch(/checks-pending/);
    expect(lines(w, 'review').some((e) => /checks not completed/.test(e.why))).toBe(true);
    w.loop.stop();
    // a restart alone does not open the gate...
    const again = world({ mode: 'live', fs, clock, chainState: w.chainState, signerOrders: w.signerFile });
    failChecks(again);
    await again.loop.start();
    expect(count(again, 'signer.signBid')).toBe(0);
    again.loop.stop();
    // ...a person who looked does
    const acked = world({ mode: 'live', fs, clock, chainState: w.chainState, signerOrders: w.signerFile });
    failChecks(acked);
    await acked.loop.start({ ackHalt: true });
    expect(count(acked, 'signer.signBid')).toBe(1);
    expect(lines(acked, 'ack-checks')).toHaveLength(1);
  });

  it('keep being tried after a person is told, and open the gate again once they pass', async () => {
    const w = world({ mode: 'live' });
    await w.loop.start();
    const B = lines(w, 'post')[0];
    const provenance = w.chain.tokenProvenance;
    failChecks(w);
    w.chain.handlers.onFill(w.fillOf(B.orderHash, 42, BigInt(B.unitPriceWei)));
    for (let i = 0; i < 6; i++) {
      w.clock.advance(60_000);
      await w.loop.tick();
    }
    expect(lines(w, 'review')).toHaveLength(1);
    expect(w.risk.gate().reason).toMatch(/checks-pending/);
    w.chain.tokenProvenance = provenance;
    w.opensea.item = async () => ({ isDisabled: false, isSuspicious: false, owner: null });
    w.clock.advance(10 * 60_000); // the slower retry, every 10 minutes once a person has been told
    await w.loop.tick();
    expect(w.risk.gate().canPost).toBe(true);
  });
});

describe('expiries and re-prices', () => {
  it('writes an expiry line only for a bid that ran out uncancelled, and never again after a restart', async () => {
    let F = milli(40);
    const fv = () => ({ S: F, L: milli(50), F, cheapestFillable: milli(50), floorProxy: milli(50), n: 20, sellers: 9 });
    const fs = memFs();
    const clock = fakeClock();
    const first = world({ mode: 'live', fs, clock, fv });
    await first.loop.start(); // B
    F = milli(45); // fair value up more than 3%: B is cancelled early and C posted
    clock.advance(60_000);
    await first.loop.tick();
    clock.advance(40 * 60_000); // both have ended
    await first.loop.tick();
    first.loop.stop();
    const [, C] = lines(first, 'post');
    expect(lines(first, 'cancel').map((e) => e.reason)).toEqual(['fair-value-moved']);
    const expiries = () => readLedger(fs, paths.ledger).filter((e) => e.kind === 'expiry').map((e) => e.orderHash);
    expect(expiries()).toEqual([C.orderHash]);
    for (let i = 0; i < 2; i++) {
      clock.advance(5 * 60_000);
      const again = world({ mode: 'live', fs, clock, fv, chainState: first.chainState, signerOrders: first.signerFile });
      await again.loop.start();
      again.loop.stop();
    }
    expect(expiries()).toEqual([C.orderHash]);
    expect(monthlyReport(readLedger(fs, paths.ledger), { month: '2026-11', nowMs: clock.now() }).expired).toBe(1);
  });

  it('re-prices at most once an hour even when every cancel leaves a 5-minute fill-signature tail', async () => {
    let F = milli(40);
    const w = world({ mode: 'live', fv: () => ({ S: F, L: milli(60), F, cheapestFillable: milli(60), floorProxy: milli(60), n: 20, sellers: 9 }) });
    w.opensea.cancelOffer = async ({ orderHash }) => (w.calls.push(['opensea.cancel', orderHash]), { ok: true, lastSignatureValidUntil: w.clock.now() + 5 * 60_000 });
    w.loop.state.held.junglebay.add('500'); // holding one: a 2-unit bid in its tail leaves no room for a replacement
    await w.loop.start();
    for (let i = 0; i < 50; i++) {
      F = i % 14 < 7 ? milli(40) : milli(44); // 10% up and down every 7 minutes
      w.clock.advance(60_000);
      await w.loop.tick();
    }
    expect(lines(w, 'cancel').filter((e) => e.reason === 'fair-value-moved')).toHaveLength(1);
  });

  it('sends one approval for a post: the end-of-tick check sees the approval the post just made', async () => {
    const w = world({ mode: 'live' });
    await w.loop.start();
    expect(approvals(w)).toBe(1);
  });

  it('writes a fill made while the bot was down into trades.csv, as well as the ledger', async () => {
    const clock = fakeClock();
    const { signerOrders, fill } = filledBeforeStart(clock);
    const w = world({ mode: 'live', signerOrders, houseFills: [fill], clock });
    await w.loop.start();
    expect(lines(w, 'fill').filter((e) => e.tokenId === '77')).toHaveLength(1);
    expect(String(w.fs.store.get('K/trades.csv') ?? '').split('\n').filter((r) => r.includes(',77,'))).toHaveLength(1);
  });
});

describe('a market pause across a restart', () => {
  it('keeps which collection it was about, so the same floor drop does not trip again', async () => {
    let floor = milli(50);
    const fv = () => ({ S: milli(40), L: milli(50), F: milli(40), cheapestFillable: milli(50), floorProxy: floor, n: 20, sellers: 9 });
    const fs = memFs();
    const clock = fakeClock();
    const first = world({ mode: 'live', fs, clock, fv });
    await first.loop.start();
    floor = milli(35); // 30% down within the hour
    clock.advance(10 * 60_000);
    await first.loop.tick();
    const trip = lines(first, 'breaker').find((e) => e.reason === 'floor-drop-1h');
    expect(trip.slug).toBe('junglebay');
    const until = first.risk.paused().until;
    first.loop.stop();
    clock.advance(10 * 60_000);
    const w = world({ mode: 'live', fs, clock, fv, chainState: first.chainState, signerOrders: first.signerFile });
    await w.loop.start();
    expect(w.risk.paused().until).toBe(until);
  });
});

describe('the signer’s inventory cap', () => {
  it('counts a gaslessly cancelled bid until it ends, as the signer does, so a re-price is never refused', async () => {
    const w = world({ mode: 'live' });
    // The real signer's P8.cap: NFTs held, plus the unfilled units of every bid it signed that has
    // not ended (endTime + 60 s) and is not cancelled on chain (a gasless cancel it cannot see).
    const filled = new Map();
    const sign = w.signer.signBid;
    w.signer.signBid = async (req) => {
      const t = w.clock.sec();
      const held = [...filled.values()].reduce((a, b) => a + b, 0);
      const open = w.signerFile.filter((o) => o.endTime + 60 > t).reduce((n, o) => n + o.qty - (filled.get(o.orderHash) ?? 0), 0);
      if (held + open + req.qty > 3) return { ok: false, id: '1', field: 'P8.cap', reason: `held ${held}, open ${open}` };
      return sign(req);
    };
    await w.loop.start();
    const B = lines(w, 'post')[0];
    filled.set(B.orderHash, 1);
    w.chain.handlers.onFill(w.fillOf(B.orderHash, 42, BigInt(B.unitPriceWei)));
    w.clock.advance(60_000);
    await w.loop.tick(); // holding 1: re-priced to 0.0332, B gaslessly cancelled
    expect(w.risk.halted()).toBe(null);
    expect(lines(w, 'refusal')).toHaveLength(0);
    const [, C] = lines(w, 'post');
    // room 3, less 1 held, less B's unfilled unit, which counts until B ends
    expect(C).toMatchObject({ unitPriceWei: milli(33.2).toString(), qty: 1 });
  });
});
