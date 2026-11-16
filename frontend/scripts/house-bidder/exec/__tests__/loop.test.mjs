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
import { createLedger } from '../ledger.mjs';
import { localOrderHash } from '../verify.mjs';
import { fakeBuildTape, fakeChain, fakeClock, fakeFairValue, fakeOpenSea, fakeSigner, fakeStream, memFs, milli, snapshotOf, testAccount, testPolicy } from './fakes.mjs';

const paths = { ledger: 'K/ledger.jsonl', trades: 'K/trades.csv', status: 'K/status.json', signerOrders: 'K/signer-orders.jsonl' };
const noTimers = { setTimeout: () => 0, clearTimeout: () => {} };
const STRANGER = '0x3333333333333333333333333333333333333333';
const INSIDER = '0x5555555555555555555555555555555555555555';

function world({ mode = 'shadow', withHouse = true } = {}) {
  const clock = fakeClock();
  const calls = [];
  const house = testAccount(1).address.toLowerCase();
  const policy = testPolicy(withHouse ? house : null);
  const sales = { junglebay: [], gnssart: [] };
  const opensea = fakeOpenSea({ calls, sales, listings: { junglebay: [{ orderHash: `0x${'0f'.repeat(32)}`, tokenId: '1', priceWei: milli(50), maker: STRANGER, startTime: 0, endTime: 2e9, protocol: '', orderType: 0, zone: '', taker: null }], gnssart: [] } });
  // The chain as the house's own actions leave it: approvals set the allowance, fills spend it.
  const chainState = { block: 26_500_000, weth: milli(200), allowance: 0n, counter: 7n };
  const chain = fakeChain({ calls, snapshot: () => snapshotOf(chainState) });
  const stream = fakeStream({ lastMessageAt: clock.now });
  const fairValue = fakeFairValue(() => ({ S: milli(40), L: milli(50), F: milli(40), cheapestFillable: milli(50), floorProxy: milli(50), n: 20, sellers: 9 }));
  const fs = memFs();
  const ledger = createLedger({ paths, fs, now: clock.now, shadow: mode === 'shadow' });
  const exposure = createExposure();
  const risk = createRisk({ now: clock.now });
  const state = { stop: false };
  const insiders = { wallets: [{ address: INSIDER, who: 'team' }], contracts: [] };
  const sets = counterpartySets({ insiders, house, fundingWallet: policy.fundingWallet });
  const signer = mode === 'live' ? fakeSigner({ calls, policy }) : null;
  if (signer) {
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
  const common = { house: withHouse ? house : null, policy, opensea, exposure, risk, ledger, stopRequested: () => state.stop, now: clock.now };
  const executor = mode === 'live'
    ? createExecutor({ ...common, signer, getOrderHash: async (c) => localOrderHash(c) })
    : createShadowExecutor(common);
  const config = { policy, house: withHouse ? house : null, houseWallets: [house], policySha256: 'x' };
  const exits = [];
  const loop = createLoop({ mode, config, data: { opensea, stream, chain, buildTape: fakeBuildTape, fairValue }, executor, exposure, risk, ledger, sets, stopRequested: () => state.stop, now: clock.now, timers: noTimers, onExit: (r) => exits.push(r) });
  return { clock, calls, house, policy, sales, opensea, chain, chainState, fillOf, stream, ledger, exposure, risk, state, loop, exits, names: () => calls.map((c) => c[0]) };
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
    // room left under the cap (3 - 1 held)
    const cancel = w.ledger.read().find((e) => e.kind === 'cancel');
    expect(cancel.reason).toBe('fair-value-moved');
    const posts = w.ledger.read().filter((e) => e.kind === 'post');
    expect(posts.map((p) => [p.unitPriceWei, p.qty])).toEqual([
      [milli(35.2).toString(), 2],
      [milli(33.2).toString(), 2],
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
    await w.loop.tick(); // held 1: re-priced to 0.0332 for the 2 units of room left
    w.clock.advance(60_000);
    await w.loop.tick(); // the new bid holds 2 units of a room of 2: it stands
    const cancels = w.ledger.read().filter((e) => e.kind === 'cancel').map((e) => e.reason);
    expect(cancels).toEqual(['fair-value-moved']);
    expect(w.exposure.active('junglebay', w.clock.sec())).toHaveLength(1);
    expect(w.loop.status().collections.junglebay.standing).toMatchObject({ unitPriceWei: milli(33.2), qty: 2 });
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

  it('halts and kills on a fill from an insider', async () => {
    const w = world({ mode: 'live' });
    await w.loop.start();
    const post = w.ledger.read().find((e) => e.kind === 'post');
    w.chain.handlers.onFill(w.fillOf(post.orderHash, 42, BigInt(post.unitPriceWei), INSIDER));
    await w.loop.tick();
    expect(w.risk.halted().reason).toBe('insider-fill');
    expect(w.names()).toContain('signer.kill');
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
